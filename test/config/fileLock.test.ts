import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withConfigFileLock } from '../../src/config/fileLock.ts';

let root: string;
let file: string;
let lock: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pi-tower-config-lock-'));
  file = join(root, 'tower.json');
  lock = `${file}.lock`;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  if (child.pid === undefined) throw new Error('child process has no pid');
  return child.pid;
}

async function withLiveProcess<T>(fn: (pid: number) => Promise<T>): Promise<T> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    if (child.pid === undefined) throw new Error('child process has no pid');
    return await fn(child.pid);
  } finally {
    child.kill();
  }
}

function holderLine(pid: number, since: Date = new Date(), host = hostname()): string {
  return `pid=${String(pid)} host=${host} since=${since.toISOString()}`;
}

async function age(path: string, ms: number): Promise<void> {
  const past = new Date(Date.now() - ms);
  await utimes(path, past, past);
}

describe('withConfigFileLock', () => {
  it('runs callers for the same file one at a time while holding <file>.lock', async () => {
    const events: string[] = [];
    await Promise.all(
      [0, 1, 2, 3, 4].map((index) =>
        withConfigFileLock(file, async () => {
          events.push(`enter ${String(index)}`);
          expect(await readFile(lock, 'utf8')).toMatch(
            new RegExp(`^pid=${String(process.pid)} host=\\S+ since=\\S+ token=\\S+\\n$`),
          );
          await delay(5);
          events.push(`exit ${String(index)}`);
        }),
      ),
    );
    expect(events).toEqual(
      [0, 1, 2, 3, 4].flatMap((index) => [`enter ${String(index)}`, `exit ${String(index)}`]),
    );
    expect(await readdir(root)).toEqual([]);
  });

  it('removes a lock that has not been touched for longer than the stale timeout', async () => {
    await writeFile(lock, 'pid=1 host=another-host since=2020-01-01T00:00:00.000Z token=old\n', 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    expect(await withConfigFileLock(file, async () => 'ran', { timeoutMs: 1000 })).toBe('ran');
    expect(await readdir(root)).toEqual([]);
  });

  it('removes a fresh lock whose holder process on this host has exited', async () => {
    const pid = await exitedPid();
    await writeFile(lock, `pid=${String(pid)} host=${hostname()} since=${new Date().toISOString()} token=gone\n`, 'utf8');
    expect(await withConfigFileLock(file, async () => 'ran', { timeoutMs: 1000, staleMs: 60_000 })).toBe('ran');
    expect(await readdir(root)).toEqual([]);
  });

  it('waits for a live holder and then fails with a message naming the lock and its holder', async () => {
    const holder = holderLine(process.pid);
    await writeFile(lock, `${holder} token=someone-else\n`, 'utf8');
    await expect(
      withConfigFileLock(file, async () => 'ran', { timeoutMs: 150, retryMs: 10 }),
    ).rejects.toThrow(
      `timed out after 150ms waiting for the tower config lock ${lock} (held by ${holder}) — another pi process is updating this file; retry, or delete the lock file if no pi process is using it`,
    );
    expect(await readFile(lock, 'utf8')).toBe(`${holder} token=someone-else\n`);
  });

  it('does not treat a live holder on another host as dead', async () => {
    await writeFile(lock, 'pid=999999 host=another-host since=x token=remote\n', 'utf8');
    await expect(
      withConfigFileLock(file, async () => 'ran', { timeoutMs: 100, retryMs: 10 }),
    ).rejects.toThrow(/^timed out after 100ms/);
  });

  it('never takes over a live holder on this host, however old its lock is', async () => {
    await withLiveProcess(async (pid) => {
      const holder = holderLine(pid, new Date(Date.now() - 3_600_000));
      await writeFile(lock, `${holder} token=slow\n`, 'utf8');
      await age(lock, 60_000);
      await expect(
        withConfigFileLock(file, async () => 'ran', { timeoutMs: 150, retryMs: 10 }),
      ).rejects.toThrow(`(held by ${holder})`);
      expect(await readFile(lock, 'utf8')).toBe(`${holder} token=slow\n`);
    });
  });

  it('reclaims a lock left by an earlier process that had this same pid', async () => {
    const beforeThisProcess = new Date(Date.now() - process.uptime() * 1000 - 60_000);
    await writeFile(lock, `${holderLine(process.pid, beforeThisProcess)} token=previous-run\n`, 'utf8');
    expect(await withConfigFileLock(file, async () => 'ran', { timeoutMs: 1000 })).toBe('ran');
    expect(await readdir(root)).toEqual([]);
  });

  it('leaves a stale lock alone while another process holds the reaper guard', async () => {
    await withLiveProcess(async (pid) => {
      await writeFile(lock, `${holderLine(await exitedPid())} token=crashed\n`, 'utf8');
      await writeFile(`${lock}.reaper`, `${holderLine(pid)} token=reaping\n`, 'utf8');
      await expect(
        withConfigFileLock(file, async () => 'ran', { timeoutMs: 150, retryMs: 10 }),
      ).rejects.toThrow(/^timed out after 150ms/);
      expect((await readdir(root)).sort()).toEqual(['tower.json.lock', 'tower.json.lock.reaper']);
    });
  });

  it('clears a reaper guard whose holder died, then reclaims the stale lock', async () => {
    await writeFile(lock, `${holderLine(await exitedPid())} token=crashed\n`, 'utf8');
    await writeFile(`${lock}.reaper`, `${holderLine(await exitedPid())} token=crashed-reaper\n`, 'utf8');
    expect(await withConfigFileLock(file, async () => 'ran', { timeoutMs: 1000, retryMs: 5 })).toBe('ran');
    expect(await readdir(root)).toEqual([]);
  });

  it('clears a reaper guard older than a few seconds even when its holder is alive', async () => {
    await withLiveProcess(async (pid) => {
      await writeFile(lock, `${holderLine(await exitedPid())} token=crashed\n`, 'utf8');
      await writeFile(`${lock}.reaper`, `${holderLine(pid)} token=stuck-reaper\n`, 'utf8');
      await age(`${lock}.reaper`, 10_000);
      expect(await withConfigFileLock(file, async () => 'ran', { timeoutMs: 1000, retryMs: 5 })).toBe('ran');
      expect(await readdir(root)).toEqual([]);
    });
  });

  it('proceeds as soon as the holder releases the lock', async () => {
    await writeFile(lock, `pid=${String(process.pid)} host=${hostname()} since=x token=other\n`, 'utf8');
    const released = delay(60).then(() => rm(lock));
    expect(await withConfigFileLock(file, async () => 'ran', { timeoutMs: 5000, retryMs: 5 })).toBe('ran');
    await released;
    expect(await readdir(root)).toEqual([]);
  });

  it('releases the lock when the callback throws', async () => {
    await expect(
      withConfigFileLock(file, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await readdir(root)).toEqual([]);
    expect(await withConfigFileLock(file, async () => 'again')).toBe('again');
  });

  it('leaves a lock in place once another owner has taken it over', async () => {
    const takeover = 'pid=1 host=another-host since=x token=new-owner\n';
    await withConfigFileLock(file, async () => {
      await writeFile(lock, takeover, 'utf8');
    });
    expect(await readFile(lock, 'utf8')).toBe(takeover);
  });
});
