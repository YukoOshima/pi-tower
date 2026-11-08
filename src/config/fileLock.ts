import { randomUUID } from 'node:crypto';
import { open, readFile, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

import { isMissingFileError } from './jsonFile.ts';

export interface ConfigFileLockOptions {
  readonly timeoutMs?: number;
  readonly retryMs?: number;
  readonly staleMs?: number;
}

interface LockSnapshot {
  readonly content: string;
  readonly mtimeMs: number;
}

interface LockHolder {
  readonly pid: number;
  readonly host: string;
  readonly sinceMs: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_MS = 25;
const DEFAULT_STALE_MS = 10_000;
const REAPER_STALE_MS = 5_000;
const PROCESS_START_SLACK_MS = 1_000;

const queues = new Map<string, Promise<void>>();

export async function withConfigFileLock<T>(
  path: string,
  fn: () => Promise<T>,
  options: ConfigFileLockOptions = {},
): Promise<T> {
  return serialized(path, () => withLockFile(`${path}.lock`, fn, options));
}

async function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let release = (): void => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  queues.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (queues.get(key) === tail) queues.delete(key);
  }
}

async function withLockFile<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: ConfigFileLockOptions,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  while (!(await tryCreateLock(lockPath, token))) {
    const reaped = await reapStaleLock(lockPath, staleMs);
    if (Date.now() >= deadline) throw new Error(await lockTimeoutMessage(lockPath, timeoutMs));
    if (!reaped) await delay(retryMs);
  }
  try {
    return await fn();
  } finally {
    await releaseLock(lockPath, token);
  }
}

async function tryCreateLock(lockPath: string, token: string): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(lockPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    await handle.writeFile(
      `pid=${String(process.pid)} host=${hostname()} since=${new Date().toISOString()} token=${token}\n`,
      'utf8',
    );
    return true;
  } catch (error) {
    await rm(lockPath, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  const content = await readFile(lockPath, 'utf8').catch(() => undefined);
  if (content?.includes(`token=${token}`) === true) await rm(lockPath, { force: true });
}

async function reapStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  const seen = await snapshot(lockPath);
  if (seen === undefined || !lockIsStale(seen, staleMs)) return false;
  const reaperPath = `${lockPath}.reaper`;
  const guard = randomUUID();
  if (!(await tryCreateLock(reaperPath, guard))) {
    await removeAbandonedReaper(reaperPath);
    return false;
  }
  try {
    const confirmed = await snapshot(lockPath);
    if (confirmed === undefined || !lockIsStale(confirmed, staleMs)) return false;
    await rm(lockPath, { force: true });
    return true;
  } finally {
    await releaseLock(reaperPath, guard);
  }
}

async function removeAbandonedReaper(reaperPath: string): Promise<void> {
  const seen = await snapshot(reaperPath);
  if (seen === undefined || !reaperIsAbandoned(seen)) return;
  if (!sameSnapshot(await snapshot(reaperPath), seen)) return;
  await rm(reaperPath, { force: true });
}

function sameSnapshot(current: LockSnapshot | undefined, seen: LockSnapshot): boolean {
  return (
    current !== undefined && current.content === seen.content && current.mtimeMs === seen.mtimeMs
  );
}

async function snapshot(lockPath: string): Promise<LockSnapshot | undefined> {
  try {
    const [info, content] = await Promise.all([stat(lockPath), readFile(lockPath, 'utf8')]);
    return { content, mtimeMs: info.mtimeMs };
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

function lockIsStale(lock: LockSnapshot, staleMs: number): boolean {
  const holder = lockHolder(lock.content);
  if (holder !== undefined && holder.host === hostname()) return holderIsGone(holder);
  return Date.now() - lock.mtimeMs > staleMs;
}

function reaperIsAbandoned(reaper: LockSnapshot): boolean {
  const holder = lockHolder(reaper.content);
  if (holder !== undefined && holder.host === hostname() && holderIsGone(holder)) return true;
  return Date.now() - reaper.mtimeMs > REAPER_STALE_MS;
}

function lockHolder(content: string): LockHolder | undefined {
  const pid = Number(/\bpid=(\d+)/.exec(content)?.[1]);
  const host = /\bhost=(\S+)/.exec(content)?.[1];
  if (!Number.isSafeInteger(pid) || pid <= 0 || host === undefined) return undefined;
  return { pid, host, sinceMs: Date.parse(/\bsince=(\S+)/.exec(content)?.[1] ?? '') };
}

function holderIsGone(holder: LockHolder): boolean {
  if (holder.pid !== process.pid) return !isProcessAlive(holder.pid);
  return holder.sinceMs < Date.now() - process.uptime() * 1000 - PROCESS_START_SLACK_MS;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function lockTimeoutMessage(lockPath: string, timeoutMs: number): Promise<string> {
  const content = await readFile(lockPath, 'utf8').catch(() => '');
  const holder = content.replace(/\s*token=\S+/, '').trim();
  return `timed out after ${String(timeoutMs)}ms waiting for the tower config lock ${lockPath}${holder.length > 0 ? ` (held by ${holder})` : ''} — another pi process is updating this file; retry, or delete the lock file if no pi process is using it`;
}
