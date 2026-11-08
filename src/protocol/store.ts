import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  appendFile,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { listBaseDirtyEntries, snapshotBaseWip } from './baseWip.ts';
import {
  mapWithConcurrency,
  TOWER_FILE_IO_CONCURRENCY,
  TOWER_GIT_CONCURRENCY,
} from './concurrency.ts';
import { parseFrontmatter, readFrontmatterPrefix, renderFrontmatter } from './frontmatter.ts';
import {
  branchExists,
  branchTip,
  checkoutNewLocalBranch,
  commitAllowEmpty,
  commitPaths,
  currentBranch,
  diffNameOnly,
  git,
  GitError,
  hasAnyCommit,
  initRepository,
  isAncestor,
  isInsideRepo,
  isRegisteredWorktree,
  isWorktreeDirty,
  mergeNoFf,
  tryGit,
  worktreeAdd,
  worktreeAddNewBranch,
  worktreeRemove,
} from './git.ts';
import { evaluateMissionGate } from './missionGate.ts';
import type { TowerMissionGateResult, TowerMissionGitObservations } from './missionGate.ts';
import {
  ACTIVITY_LOG,
  BROADCAST_NAME,
  FINDINGS_DIR,
  INBOX_DIR,
  LOG_DIR,
  MAIN_AGENT_ID,
  MISSIONS_DIR,
  MISSIONS_INDEX,
  REVIEWS_DIR,
  STATE_FILE,
  TOWER_NAME,
  TOWER_ROOT,
  WORKTREES_DIR,
  isReservedTowerAgentName,
  dateDash,
  findingFileName,
  hasNonAsciiCharacters,
  inboxFileName,
  missionFileName,
  reviewFileName,
  slugify,
  targetSlug,
} from './paths.ts';
import type {
  TowerFindingSeverity,
  TowerFindingType,
  TowerInboxItem,
  TowerMission,
  TowerMissionKind,
  TowerMissionStatus,
  TowerReviewInfo,
  TowerRosterEntry,
  TowerState,
} from './types.ts';

export class TowerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TowerProtocolError';
  }
}

export const MAX_REVIEW_ROUNDS = 5;

export type TowerReanchorRelation = 'no-branch' | 'up-to-date' | 'stale';

export interface TowerReanchorMissionDigest {
  readonly id: string;
  readonly branch: string;
  readonly relation: TowerReanchorRelation;
  readonly branchTip?: string;
}

export interface TowerReanchorDigest {
  readonly from: string;
  readonly to: string;
  readonly baseTip: string;
  readonly missions: readonly TowerReanchorMissionDigest[];
}

export interface TowerInitResult {
  readonly base: string;
  readonly created: boolean;
  readonly retiredAgents: readonly string[];
  readonly checkout: string;
  readonly rebasedFrom?: string;
  readonly rebaseDigest?: TowerReanchorDigest;
  readonly openMissions: readonly string[];
}

export interface TowerPlanInput {
  readonly title: string;
  readonly scope: readonly string[];
  readonly tasks?: readonly string[];
  readonly context?: string;
  readonly deps?: readonly string[];
  readonly kind?: TowerMissionKind;
}

export interface TowerSendInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly scope?: string;
  readonly action?: string;
  readonly consentRef?: string;
}

export interface TowerSendResult {
  readonly item: TowerInboxItem;
  readonly missionId?: string;
  readonly activityLogError?: string;
}

export interface TowerCompleteResult {
  readonly mission?: TowerMission;
  readonly recoveredAt?: string;
  readonly message?: TowerSendResult;
  readonly notificationCreated: boolean;
  readonly notificationError?: string;
  readonly activityLogError?: string;
}

interface TowerCompletionLockedOptions {
  readonly validateOnly?: boolean;
  readonly completionPrepared?: boolean;
  readonly inboxItems?: readonly TowerInboxItem[];
}

export interface TowerFindingInput {
  readonly type: TowerFindingType;
  readonly title: string;
  readonly severity?: TowerFindingSeverity;
  readonly summary: string;
  readonly location?: string;
  readonly details: string;
  readonly suggestedFix: string;
}

export interface TowerReviewInput {
  readonly target: string;
  readonly status: string;
  readonly merge: string;
  readonly findings: string;
  readonly checks?: readonly string[];
  readonly decision: string;
}

export interface TowerReviewResult {
  readonly review: TowerReviewInfo;
  readonly storedMessages: readonly TowerSendResult[];
  readonly notificationError?: string;
  readonly activityLogError?: string;
}

interface TowerReviewLockedOptions {
  readonly validateOnly?: boolean;
  readonly existing: readonly TowerReviewInfo[];
  readonly nextReviewSeq: number;
  readonly reviewedCommit: string;
  readonly inboxItems: readonly TowerInboxItem[];
  readonly activityLogRefs: Map<string, boolean>;
}

export interface TowerMissionPatch {
  readonly status?: TowerMissionStatus;
  readonly note?: string;
  readonly blocker?: string;
  readonly clearBlockers?: boolean;
  readonly taskDone?: string;
  readonly taskDrop?: { readonly text: string; readonly reason?: string };
  readonly owner?: string;
  readonly scope?: readonly string[];
  readonly spawnBase?: string;
}

export interface TowerAddWorktreeResult {
  readonly rel: string;
  readonly spawnBase?: string;
}

export interface TowerStoreOptions {
  readonly stateLockTimeoutMs?: number;
  readonly stateLockPollMs?: number;
}

export interface TowerMissionRuntimeOptions {
  readonly activeAgentIds?: ReadonlySet<string> | (() => ReadonlySet<string>);
}

export interface TowerMergeResult {
  readonly status: 'merged' | 'advanced' | 'noop';
  readonly mergeCommit: string;
  readonly evaluatedBranchTip: string;
  readonly currentBranchTip: string;
  readonly conflictsWith: ReadonlyArray<{
    readonly branch: string;
    readonly files: readonly string[];
  }>;
  readonly noop?: boolean;
}

export interface TowerRebaseMissionResult {
  readonly status: 'up-to-date' | 'rebased' | 'conflict';
  readonly fromCommit?: string;
  readonly toCommit?: string;
  readonly files?: readonly string[];
}

export interface TowerTeardownOptions {
  readonly force?: boolean;
  readonly exclude?: readonly string[];
  readonly dryRun?: boolean;
  readonly liveAgentIds?: ReadonlySet<string>;
}

const FINDING_TYPES: readonly TowerFindingType[] = ['bug', 'improve', 'vuln', 'idea'];
const PREPARED_OPERATION_TIMEOUT_MS = 60_000;
const PREPARED_OPERATION_MAX_BACKOFF_MS = 100;

interface TowerStateSnapshot {
  readonly raw: string;
  readonly state: TowerState;
}

class TowerPreparationConflict extends Error {}

const STATUS_EMOJI: Record<TowerMissionStatus, string> = {
  planned: '🟡',
  active: '🔵',
  completed: '🟢',
  blocked: '🔴',
  paused: '⏸️',
  merged: '✅',
  abandoned: '🚫',
};

export function isOpenMission(mission: Pick<TowerMission, 'status'>): boolean {
  return mission.status !== 'merged' && mission.status !== 'abandoned';
}

function missionNumber(id: string): number {
  const n = Number.parseInt(id.replace(/^M/, ''), 10);
  return Number.isNaN(n) ? 0 : n;
}

function scopeStem(raw: string): string {
  return raw.replace(/\/\*\*?$/, '').replace(/\/+$/, '').replace(/\*+$/, '');
}

export function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  for (const rawA of a) {
    const stemA = scopeStem(rawA);
    if (stemA.length === 0) continue;
    for (const rawB of b) {
      const stemB = scopeStem(rawB);
      if (stemB.length === 0) continue;
      if (stemA === stemB || stemA.startsWith(`${stemB}/`) || stemB.startsWith(`${stemA}/`)) {
        return true;
      }
    }
  }
  return false;
}

function depPathExists(fromId: string, toId: string, byId: ReadonlyMap<string, TowerMission>): boolean {
  const seen = new Set<string>();
  const queue = [fromId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === toId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const mission = byId.get(current);
    if (mission === undefined || !isOpenMission(mission)) continue;
    for (const dep of mission.deps) {
      if (!seen.has(dep)) queue.push(dep);
    }
  }
  return false;
}

function autoDepNote(other: TowerMission): string {
  return `auto dependency on ${other.id}: scope overlaps ${other.id} ("${other.scope.join(', ')}") — merges are serialized so shared files land in dependency order instead of colliding`;
}

function addAutoDeps(
  mission: TowerMission,
  candidates: readonly TowerMission[],
  byId: ReadonlyMap<string, TowerMission>,
): void {
  if (mission.kind === 'survey') return;
  for (const other of candidates) {
    if (other.id === mission.id || other.kind === 'survey') continue;
    if (!scopesOverlap(mission.scope, other.scope)) continue;
    if (depPathExists(mission.id, other.id, byId) || depPathExists(other.id, mission.id, byId)) {
      continue;
    }
    mission.deps.push(other.id);
    mission.notes.push(autoDepNote(other));
  }
}

export function resolveMissionByBranch(
  state: TowerState,
  branch: string,
): TowerMission | undefined {
  let resolved: TowerMission | undefined;
  for (const mission of state.missions) {
    if (mission.branch !== branch || !isOpenMission(mission)) continue;
    if (resolved === undefined || missionNumber(mission.id) > missionNumber(resolved.id)) {
      resolved = mission;
    }
  }
  return resolved;
}

function unownedBranchMessage(branch: string): string {
  return `branch "${branch}" exists in git but is not owned by any tower mission (it appeared after planning) — refusing to build the worker on unrelated history; delete or rename that branch if it is stale, or re-plan the mission under a new title`;
}

export async function assertLocalBaseBranch(repoRoot: string, base: string): Promise<void> {
  if (!(await branchExists(repoRoot, base))) {
    throw new TowerProtocolError(
      `base branch "${base}" does not exist as a local branch — merges land on a local branch, so remote-tracking refs and tags are not accepted; create a local branch first`,
    );
  }
}

export class TowerStore {
  readonly repoRoot: string;
  private readonly stateLockTimeoutMs: number;
  private readonly stateLockPollMs: number;

  constructor(repoRoot: string, options: TowerStoreOptions = {}) {
    this.repoRoot = repoRoot;
    this.stateLockTimeoutMs = options.stateLockTimeoutMs ?? 10_000;
    this.stateLockPollMs = options.stateLockPollMs ?? 10;
  }

  private async runPrepared<TPrepared, TResult>(
    prepare: () => Promise<TPrepared>,
    commit: (prepared: TPrepared) => Promise<TResult>,
  ): Promise<TResult> {
    const deadline = Date.now() + PREPARED_OPERATION_TIMEOUT_MS;
    let backoffMs = this.stateLockPollMs;
    for (;;) {
      const prepared = await prepare();
      try {
        return await commit(prepared);
      } catch (error) {
        if (!(error instanceof TowerPreparationConflict)) throw error;
        if (Date.now() >= deadline) {
          throw new TowerProtocolError(
            `tower protocol inputs kept changing for ${String(PREPARED_OPERATION_TIMEOUT_MS)}ms while preparing the operation; no stale snapshot was written, so retry the tool call`,
          );
        }
        if (backoffMs > 0) {
          await new Promise<void>((resolvePromise) => {
            setTimeout(resolvePromise, backoffMs);
          });
        }
        backoffMs = Math.min(backoffMs * 2, PREPARED_OPERATION_MAX_BACKOFF_MS);
      }
    }
  }

  private async withStateLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.withProtocolLock(`${this.abs(STATE_FILE)}.lock`, 'state', fn);
  }

  private async withInboxPublicationLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.withProtocolLock(`${this.abs(INBOX_DIR)}.lock`, 'inbox publication', fn);
  }

  private async withCompletionLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.withStateLock(() => this.withInboxPublicationLock(fn));
  }

  private async withProtocolLock<T>(
    lockPath: string,
    kind: 'state' | 'inbox publication',
    fn: () => Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + this.stateLockTimeoutMs;
    const token = randomUUID();
    let lastStaleCheckAt = 0;
    while (!(await this.tryAcquireStateLock(lockPath, token))) {
      const now = Date.now();
      if (now - lastStaleCheckAt >= 250) {
        lastStaleCheckAt = now;
        if (await this.reapStaleStateLock(lockPath)) continue;
      }
      if (now >= deadline) {
        let holder = '';
        let sameProcess = false;
        try {
          const content = (await readFile(lockPath, 'utf8')).trim();
          holder = ` — held by ${content}`;
          sameProcess = Number(/^pid=(\d+)\b/.exec(content)?.[1]) === process.pid;
        } catch {
          holder = '';
        }
        const explanation = sameProcess
          ? kind === 'state'
            ? 'another tower tool call in this process is writing state.json; wait for it to finish'
            : 'another tower tool call in this process is publishing an inbox message; wait for it to finish'
          : kind === 'state'
            ? 'another tower process may be writing state.json; a confirmed dead holder is reclaimed automatically, so inspect the holder if this persists'
            : 'another tower process may be publishing an inbox message; a confirmed dead holder is reclaimed automatically, so inspect the holder if this persists';
        throw new TowerProtocolError(
          `timed out after ${String(this.stateLockTimeoutMs)}ms waiting for the tower ${kind} lock "${lockPath}"${holder} — ${explanation}`,
        );
      }
      await new Promise<void>((resolvePromise) => {
        setTimeout(resolvePromise, this.stateLockPollMs);
      });
    }
    try {
      return await fn();
    } finally {
      await this.releaseStateLock(lockPath, token);
    }
  }

  private async reapStaleStateLock(lockPath: string): Promise<boolean> {
    const guard = await this.acquireStateLockReaper(lockPath);
    if (guard === undefined) return false;
    try {
      let content: string;
      try {
        content = await readFile(lockPath, 'utf8');
      } catch {
        return false;
      }
      const pid = Number(/^pid=(\d+)\b/.exec(content)?.[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0 || !(await this.stateLockHolderIsDead(pid))) {
        return false;
      }
      let confirmed: string;
      try {
        confirmed = await readFile(lockPath, 'utf8');
      } catch {
        return false;
      }
      if (confirmed !== content || !(await this.stateLockHolderIsDead(pid))) return false;
      try {
        await rm(lockPath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    } finally {
      await this.releaseStateLockReaper(guard);
    }
  }

  private async stateLockReaperRef(lockPath: string): Promise<string> {
    let canonical: string;
    try {
      canonical = join(await realpath(dirname(lockPath)), basename(lockPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      canonical = resolve(await realpath(this.repoRoot), relative(this.repoRoot, lockPath));
    }
    const suffix = createHash('sha256').update(canonical).digest('hex');
    return `refs/tower/state-lock-reaper-${suffix}`;
  }

  private async readStateLockReaper(ref: string): Promise<string | undefined> {
    try {
      return await git(this.repoRoot, ['rev-parse', '--verify', '--quiet', ref]);
    } catch (error) {
      if (error instanceof GitError && error.exitCode === 1) return undefined;
      throw error;
    }
  }

  private async acquireStateLockReaper(
    lockPath: string,
  ): Promise<{ readonly ref: string; readonly token: string } | undefined> {
    const ref = await this.stateLockReaperRef(lockPath);
    const current = await this.readStateLockReaper(ref);
    if (current !== undefined) {
      const holder = await git(this.repoRoot, ['cat-file', '-p', current]);
      const pid = Number(/^pid=(\d+)\b/.exec(holder)?.[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0 || !(await this.stateLockHolderIsDead(pid))) {
        return undefined;
      }
    }
    const token = await git(this.repoRoot, ['hash-object', '-w', '--stdin'], {
      input: `pid=${String(process.pid)} since=${new Date().toISOString()} token=${randomUUID()}`,
    });
    try {
      await git(this.repoRoot, ['update-ref', ref, token, current ?? '']);
      return { ref, token };
    } catch (error) {
      if (error instanceof GitError) {
        const after = await this.readStateLockReaper(ref);
        if (after === token) return { ref, token };
        if (after !== current || /reference already exists|but expected/.test(error.stderr)) {
          return undefined;
        }
      }
      throw error;
    }
  }

  private async releaseStateLockReaper(guard: {
    readonly ref: string;
    readonly token: string;
  }): Promise<void> {
    try {
      await git(this.repoRoot, ['update-ref', '-d', guard.ref, guard.token]);
    } catch (error) {
      if (error instanceof GitError) {
        const current = await this.readStateLockReaper(guard.ref);
        if (current === undefined || current !== guard.token) return;
      }
      throw error;
    }
  }

  private async stateLockHolderIsDead(pid: number): Promise<boolean> {
    if (pid === process.pid) return false;
    return !isProcessAlive(pid);
  }

  private async releaseStateLock(lockPath: string, token: string): Promise<void> {
    let content: string;
    try {
      content = await readFile(lockPath, 'utf8');
    } catch {
      return;
    }
    if (!content.includes(`token=${token}`)) return;
    await rm(lockPath, { force: true });
  }

  private async tryAcquireStateLock(lockPath: string, token: string): Promise<boolean> {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(
          `pid=${String(process.pid)} since=${new Date().toISOString()} token=${token}`,
          'utf8',
        );
        return true;
      } catch (error) {
        await rm(lockPath, { force: true });
        throw error;
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return false;
      if (code === 'ENOENT') {
        throw await this.stateMissingError();
      }
      throw error;
    }
  }

  async isInitialized(): Promise<boolean> {
    try {
      await readFile(this.abs(STATE_FILE), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  async isStateLost(): Promise<boolean> {
    if (await this.isInitialized()) return false;
    return existsSync(this.abs(TOWER_ROOT));
  }

  private async stateMissingError(): Promise<TowerProtocolError> {
    if (await this.isStateLost()) {
      return new TowerProtocolError(
        'tower state was lost: .tower/comms/state.json is missing but the .tower/ directory still exists — the tower was initialized here and its comms state was deleted (e.g. by git clean), so all recorded mission, roster, and review history is gone. This operation is refused instead of silently running against an empty history; TowerStatus reports the loss, and TowerSend/TowerComplete recover a minimal state (stamped recoveredAt) automatically',
      );
    }
    return new TowerProtocolError('tower is not initialized in this repository — run TowerInit first');
  }

  async ensureRepository(base?: string): Promise<void> {
    if (await isInsideRepo(this.repoRoot)) return;
    await initRepository(this.repoRoot);
    const unborn = (await tryGit(this.repoRoot, ['symbolic-ref', '--short', 'HEAD'])) ?? 'main';
    const resolvedBase = base ?? unborn;
    if (resolvedBase !== unborn) {
      await checkoutNewLocalBranch(this.repoRoot, resolvedBase);
    }
    const dirty = await listBaseDirtyEntries(this.repoRoot);
    if (dirty.length === 0) {
      await commitAllowEmpty(this.repoRoot, 'tower: init');
      return;
    }
    await commitPaths(
      this.repoRoot,
      dirty.map((entry) => entry.path),
      `tower: snapshot of uncommitted base checkout changes (base ${resolvedBase})`,
    );
  }

  async init(sessionId?: string, base?: string): Promise<TowerInitResult> {
    await this.ensureRepository(base);
    if (!(await hasAnyCommit(this.repoRoot))) {
      throw new TowerProtocolError('the repository has no commits yet — create an initial commit first');
    }
    await mkdir(dirname(this.abs(STATE_FILE)), { recursive: true });
    return this.withStateLock(async () => {
      if (await this.isInitialized()) {
        const loaded = await this.load();
        let rebasedFrom: string | undefined;
        let rebaseDigest: TowerReanchorDigest | undefined;
        let state = loaded;
        if (base !== undefined && base !== loaded.base) {
          const reanchor = await this.reanchorLocked(loaded, base);
          rebasedFrom = reanchor.digest.from;
          rebaseDigest = reanchor.digest;
          state = reanchor.state;
        }
        const retiredAgents = await this.adoptForeignRoster(state, sessionId);
        return {
          base: state.base,
          created: false,
          retiredAgents,
          checkout: await this.checkedOutBranch(),
          rebasedFrom,
          rebaseDigest,
          openMissions: state.missions.filter(isOpenMission).map((m) => m.id),
        };
      }

      const checkout = await this.checkedOutBranch();
      let resolvedBase: string;
      if (base !== undefined) {
        await assertLocalBaseBranch(this.repoRoot, base);
        resolvedBase = base;
      } else {
        if (checkout === 'HEAD') {
          throw new TowerProtocolError(
            'cannot determine the base branch from a detached HEAD — pass the base branch explicitly',
          );
        }
        resolvedBase = checkout;
      }

      for (const dir of [INBOX_DIR, FINDINGS_DIR, REVIEWS_DIR, MISSIONS_DIR, LOG_DIR, WORKTREES_DIR]) {
        await mkdir(this.abs(dir), { recursive: true });
      }
      await this.ensureGitExclude();

      const state: TowerState = {
        version: 1,
        base: resolvedBase,
        mode: 'branch',
        createdAt: new Date().toISOString(),
        sessionId,
        ownerPid: sessionId === undefined ? undefined : process.pid,
        roster: { agents: [] },
        missions: [],
      };
      await this.save(state);
      await writeFile(this.abs(ACTIVITY_LOG), '', 'utf8');
      await this.renderMissionsIndex(state);
      await this.appendLog(TOWER_NAME, 'init', { mode: state.mode, base: resolvedBase }, MISSIONS_INDEX);
      return { base: resolvedBase, created: true, retiredAgents: [], checkout, openMissions: [] };
    });
  }

  private async reanchorLocked(
    state: TowerState,
    base: string,
  ): Promise<{ readonly digest: TowerReanchorDigest; readonly state: TowerState }> {
    await assertLocalBaseBranch(this.repoRoot, base);
    const baseTip = await branchTip(this.repoRoot, base);
    const open = state.missions.filter(isOpenMission);
    const missions: TowerReanchorMissionDigest[] = [];
    for (const mission of open) {
      if (!(await branchExists(this.repoRoot, mission.branch))) {
        missions.push({ id: mission.id, branch: mission.branch, relation: 'no-branch' });
        continue;
      }
      const branchTipForMission = await branchTip(this.repoRoot, mission.branch);
      missions.push({
        id: mission.id,
        branch: mission.branch,
        relation: (await isAncestor(this.repoRoot, baseTip, branchTipForMission)) ? 'up-to-date' : 'stale',
        branchTip: branchTipForMission,
      });
    }
    const digest: TowerReanchorDigest = { from: state.base, to: base, baseTip, missions };
    const next = { ...state, base };
    await this.save(next);
    await this.appendLog(TOWER_NAME, 'rebase', {
      from: digest.from,
      to: base,
      open_missions: open.length > 0 ? open.length : undefined,
      relations:
        missions.length > 0
          ? missions.map((mission) => `${mission.id}:${mission.relation}`).join(',')
          : undefined,
    });
    return { digest, state: next };
  }

  async rebase(base: string): Promise<TowerReanchorDigest | undefined> {
    return this.withStateLock(async () => {
      const state = await this.load();
      if (state.base === base) return undefined;
      return (await this.reanchorLocked(state, base)).digest;
    });
  }

  private async checkedOutBranch(): Promise<string> {
    return (await tryGit(this.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])) ?? 'HEAD';
  }

  private async adoptForeignRoster(
    state: TowerState,
    sessionId: string | undefined,
  ): Promise<readonly string[]> {
    if (sessionId === undefined) return [];
    if (state.sessionId === sessionId) {
      if (state.ownerPid !== process.pid) {
        state.ownerPid = process.pid;
        await this.save(state);
      }
      return [];
    }
    const previous = state.sessionId;
    const stale = state.roster.agents.filter((agent) => agent.sessionId !== sessionId);
    state.roster.agents.splice(
      0,
      state.roster.agents.length,
      ...state.roster.agents.filter((agent) => agent.sessionId === sessionId),
    );
    state.sessionId = sessionId;
    state.ownerPid = process.pid;
    await this.save(state);
    await this.appendLog(TOWER_NAME, 'adopt', {
      session: sessionId,
      previous: previous ?? 'unknown',
      retired: stale.length > 0 ? stale.map((agent) => agent.name).join(',') : undefined,
    });
    return stale.map((agent) => agent.name);
  }

  async adopt(sessionId: string): Promise<readonly string[]> {
    try {
      await readFile(this.abs(STATE_FILE), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return this.withStateLock(async () => {
      const state = await this.load();
      return this.adoptForeignRoster(state, sessionId);
    });
  }

  async release(sessionId: string): Promise<void> {
    if (!(await this.isInitialized())) return;
    await this.withStateLock(async () => {
      const state = await this.load();
      if (state.sessionId !== sessionId) return;
      state.sessionId = undefined;
      state.ownerPid = undefined;
      await this.save(state);
      await this.appendLog(TOWER_NAME, 'release', { session: sessionId });
    });
  }

  async owner(): Promise<{ readonly sessionId?: string; readonly pid?: number } | undefined> {
    try {
      const state = await this.load();
      return { sessionId: state.sessionId, pid: state.ownerPid };
    } catch {
      return undefined;
    }
  }

  private async ensureGitExclude(): Promise<void> {
    const commonDir = await tryGit(this.repoRoot, ['rev-parse', '--git-common-dir']);
    const gitDir =
      commonDir !== null ? resolve(this.repoRoot, commonDir.trim()) : join(this.repoRoot, '.git');
    const excludePath = join(gitDir, 'info', 'exclude');
    await mkdir(dirname(excludePath), { recursive: true });
    let existing = '';
    try {
      existing = await readFile(excludePath, 'utf8');
    } catch {
      existing = '';
    }
    if (existing.split(/\r?\n/).some((line) => line.trim() === '.tower/')) return;
    await appendFile(
      excludePath,
      `${existing.endsWith('\n') || existing.length === 0 ? '' : '\n'}.tower/\n`,
      'utf8',
    );
  }

  async load(): Promise<TowerState> {
    return (await this.loadSnapshot()).state;
  }

  private async loadSnapshot(): Promise<TowerStateSnapshot> {
    let raw: string;
    try {
      raw = await readFile(this.abs(STATE_FILE), 'utf8');
    } catch {
      throw await this.stateMissingError();
    }
    const state = JSON.parse(raw) as TowerState;
    for (const mission of state.missions) {
      mission.kind ??= 'build';
    }
    return { raw, state };
  }

  private async assertPreparationCurrent(
    snapshot: TowerStateSnapshot,
    inboxFiles?: readonly string[],
    reviewFiles?: readonly string[],
  ): Promise<TowerState> {
    const current = await this.loadSnapshot();
    if (current.raw !== snapshot.raw) throw new TowerPreparationConflict();
    if (inboxFiles !== undefined) {
      await this.assertDirectoryCurrent(INBOX_DIR, inboxFiles, (file) => file.endsWith('.md'));
    }
    if (reviewFiles !== undefined) {
      await this.assertDirectoryCurrent(
        REVIEWS_DIR,
        reviewFiles,
        (file) => file.startsWith('review-') && file.endsWith('.md'),
      );
    }
    return current.state;
  }

  private async assertDirectoryCurrent(
    dir: string,
    expected: readonly string[],
    include: (file: string) => boolean,
  ): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.abs(dir));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        files = [];
      } else {
        throw error;
      }
    }
    const current = files.filter(include).toSorted();
    if (current.length !== expected.length || current.some((file, index) => file !== expected[index])) {
      throw new TowerPreparationConflict();
    }
  }

  async loadOrRecover(): Promise<TowerState> {
    if (await this.isInitialized()) return this.load();
    if (!(await this.isStateLost())) {
      throw new TowerProtocolError('tower is not initialized in this repository — run TowerInit first');
    }
    return this.recoverMinimalState();
  }

  private async recoverMinimalState(): Promise<TowerState> {
    for (const dir of [INBOX_DIR, FINDINGS_DIR, REVIEWS_DIR, MISSIONS_DIR, LOG_DIR, WORKTREES_DIR]) {
      await mkdir(this.abs(dir), { recursive: true });
    }
    return this.withStateLock(async () => {
      if (await this.isInitialized()) return this.load();
      const checkout = await this.checkedOutBranch();
      if (checkout === 'HEAD') {
        throw new TowerProtocolError(
          'tower state was lost and the checkout is on a detached HEAD — the recovered minimal state takes the current checkout branch as its base, which a detached HEAD cannot provide; check out the previous base branch and retry, or run TowerInit with an explicit base',
        );
      }
      const now = new Date().toISOString();
      const state: TowerState = {
        version: 1,
        base: checkout,
        mode: 'branch',
        createdAt: now,
        recoveredAt: now,
        roster: { agents: [] },
        missions: [],
      };
      await this.save(state);
      await this.renderMissionsIndex(state);
      await this.appendLog(TOWER_NAME, 'state.recovered', { base: checkout, recovered_at: now }, MISSIONS_INDEX);
      return state;
    });
  }

  async resolveMessagingCaller(
    state: TowerState,
    agentId: string,
  ): Promise<{ readonly caller: string; readonly state: TowerState; readonly placeholder?: boolean }> {
    if (agentId === MAIN_AGENT_ID || state.recoveredAt === undefined) {
      return { caller: this.resolveCallerName(state, agentId), state };
    }
    const entry = this.resolveAgent(state, agentId);
    if (entry !== undefined) return { caller: entry.name, state };
    await this.registerAgent({
      name: agentId,
      agentId,
      kind: 'worker',
      spawnedAt: state.recoveredAt,
    });
    await this.appendLog(TOWER_NAME, 'roster.placeholder', {
      agent: agentId,
      recovered_at: state.recoveredAt,
    });
    return { caller: agentId, state: await this.load(), placeholder: true };
  }

  private async save(state: TowerState): Promise<void> {
    const file = this.abs(STATE_FILE);
    const tmp = `${file}.tmp-${String(process.pid)}-${randomUUID()}`;
    try {
      await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  async appendLog(
    actor: string,
    action: string,
    details: Readonly<Record<string, string | number | undefined>> = {},
    ref?: string,
  ): Promise<void> {
    const kv = Object.entries(details)
      .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
      .map(([key, value]) => `${key}=${String(value).replaceAll(/\s+/g, ' ')}`)
      .join(' ');
    const parts = [new Date().toISOString(), actor, action];
    if (kv.length > 0) parts.push(kv);
    if (ref !== undefined) parts.push(`ref=${ref}`);
    await appendFile(this.abs(ACTIVITY_LOG), `${parts.join(' ')}\n`, 'utf8');
  }

  async recentLog(lines: number): Promise<readonly string[]> {
    let content = '';
    try {
      content = await readFile(this.abs(ACTIVITY_LOG), 'utf8');
    } catch {
      return [];
    }
    const all = content.split('\n').filter((line) => line.trim().length > 0);
    return all.slice(-lines);
  }

  resolveAgent(state: TowerState, agentId: string): TowerRosterEntry | undefined {
    let resolved: TowerRosterEntry | undefined;
    for (const agent of state.roster.agents) {
      if (agent.agentId === agentId) resolved = agent;
    }
    return resolved;
  }

  resolveCallerName(state: TowerState, agentId: string): string {
    if (agentId === MAIN_AGENT_ID) return TOWER_NAME;
    const entry = this.resolveAgent(state, agentId);
    if (entry === undefined) {
      throw new TowerProtocolError(
        `agent "${agentId}" is not a tower participant — only spawned workers/reviewers and the tower can use tower tools`,
      );
    }
    return entry.name;
  }

  findAgent(state: TowerState, name: string): TowerRosterEntry | undefined {
    return state.roster.agents.find((agent) => agent.name === name);
  }

  findByName(state: TowerState, name: string): TowerRosterEntry | undefined {
    return this.findAgent(state, name);
  }

  async registerAgent(entry: TowerRosterEntry): Promise<void> {
    await this.withStateLock(async () => {
      const state = await this.load();
      this.registerAgentLocked(entry, state);
      await this.save(state);
    });
  }

  async registerSpawnedAgent(
    entry: TowerRosterEntry,
    mission?: { readonly id: string; readonly owner: string },
  ): Promise<void> {
    await this.withStateLock(async () => {
      const state = await this.load();
      this.registerAgentLocked(entry, state);
      if (mission === undefined) {
        await this.save(state);
        return;
      }
      await this.updateMissionLocked(
        TOWER_NAME,
        mission.id,
        { status: 'active', owner: mission.owner },
        state,
        { silent: true, forceSave: true },
      );
    });
  }

  async updateAgentRuntime(
    agentId: string,
    patch: { readonly agentSessionFile?: string; readonly model?: string },
  ): Promise<void> {
    await this.withStateLock(async () => {
      const state = await this.load();
      const index = state.roster.agents.findLastIndex((agent) => agent.agentId === agentId);
      const existing = state.roster.agents[index];
      if (existing === undefined) return;
      state.roster.agents[index] = {
        ...existing,
        ...(patch.agentSessionFile !== undefined ? { agentSessionFile: patch.agentSessionFile } : {}),
        ...(patch.model !== undefined ? { model: patch.model } : {}),
      };
      await this.save(state);
    });
  }

  private registerAgentLocked(entry: TowerRosterEntry, state: TowerState): void {
    if (entry.name.trim().length === 0 || entry.name.trim() !== entry.name) {
      throw new TowerProtocolError(
        `tower agent name "${entry.name}" must not be blank or carry surrounding whitespace`,
      );
    }
    if (isReservedTowerAgentName(entry.name)) {
      throw new TowerProtocolError(
        `tower agent name "${entry.name}" is reserved by the tower protocol — pick a different name`,
      );
    }
    for (let index = state.roster.agents.length - 1; index >= 0; index -= 1) {
      if (state.roster.agents[index]!.agentId === entry.agentId) {
        state.roster.agents.splice(index, 1);
      }
    }
    if (this.findAgent(state, entry.name) !== undefined) {
      throw new TowerProtocolError(`tower agent name "${entry.name}" is already registered`);
    }
    state.roster.agents.push({
      ...entry,
      lastInboxReadAt: entry.lastInboxReadAt ?? entry.spawnedAt,
    });
  }

  async markAgentDied(
    agentId: string,
    status: string,
    reason?: string,
    sessionId?: string,
  ): Promise<TowerRosterEntry | undefined> {
    return this.withStateLock(async () => {
      const state = await this.load();
      if (sessionId !== undefined && state.sessionId !== undefined && state.sessionId !== sessionId) {
        return undefined;
      }
      const index = state.roster.agents.findLastIndex((agent) => agent.agentId === agentId);
      const existing = state.roster.agents[index];
      if (existing === undefined) return undefined;
      if (existing.diedAt !== undefined) return existing;
      const entry: TowerRosterEntry = {
        ...existing,
        diedAt: new Date().toISOString(),
        deathStatus: status,
        deathReason: reason,
      };
      state.roster.agents[index] = entry;
      await this.save(state);
      const mission = state.missions.find((m) => m.id === entry.missionId);
      await this.appendLog(
        TOWER_NAME,
        'died',
        {
          name: entry.name,
          agent: agentId,
          kind: entry.kind,
          status,
          reason: reason === undefined ? undefined : reason.replaceAll(/\s+/g, ' ').slice(0, 200),
          mission: entry.missionId,
          target: entry.reviewTarget,
          session: sessionId,
          pid: process.pid,
        },
        mission !== undefined ? join(MISSIONS_DIR, missionFileName(mission.id, mission.slug)) : undefined,
      );
      return entry;
    });
  }

  async clearAgentDied(agentId: string, sessionId?: string): Promise<boolean> {
    return this.withStateLock(async () => {
      const state = await this.load();
      if (sessionId !== undefined && state.sessionId !== undefined && state.sessionId !== sessionId) {
        return false;
      }
      const index = state.roster.agents.findLastIndex((agent) => agent.agentId === agentId);
      const existing = state.roster.agents[index];
      if (existing === undefined || existing.diedAt === undefined) return false;
      const entry: TowerRosterEntry = {
        ...existing,
        diedAt: undefined,
        deathStatus: undefined,
        deathReason: undefined,
      };
      state.roster.agents[index] = entry;
      await this.save(state);
      await this.appendLog(TOWER_NAME, 'revived', {
        name: entry.name,
        agent: agentId,
        kind: entry.kind,
        session: sessionId,
        pid: process.pid,
      });
      return true;
    });
  }

  async plan(input: readonly TowerPlanInput[]): Promise<readonly TowerMission[]> {
    if (input.length === 0) {
      throw new TowerProtocolError('TowerPlan needs at least one mission');
    }
    for (const item of input) {
      if (hasNonAsciiCharacters(item.title)) {
        const offending = /[^\u0020-\u007E]/.exec(item.title)![0];
        throw new TowerProtocolError(
          `mission title "${item.title}" contains non-ASCII characters (first: "${offending}") — titles must be printable ASCII English: the title becomes the branch/worktree slug, and non-ASCII text slugs to a generic word like "item" that collides across missions; rewrite the title in English with a unique identifier word (e.g. a business code like B010100) and plan again`,
        );
      }
    }
    return this.withStateLock(async () => {
      const state = await this.load();
      const startIndex = state.missions.length;

      const missions: TowerMission[] = input.map((item, index) => {
        const n = startIndex + index + 1;
        const slug = slugify(item.title, 40);
        return {
          id: `M${n}`,
          title: item.title,
          slug,
          kind: item.kind ?? 'build',
          scope: [...item.scope],
          branch: `feat/${slug}`,
          worktree: `wt-${n}`,
          deps: [...(item.deps ?? [])],
          status: 'planned',
          context:
            item.context !== undefined && item.context.trim().length > 0 ? item.context.trim() : undefined,
          tasks: (item.tasks ?? []).map((text) => ({ text, done: false })),
          notes: [],
          blockers: [],
        };
      });

      const knownIds = new Set([...state.missions.map((m) => m.id), ...missions.map((m) => m.id)]);
      for (const mission of missions) {
        for (const dep of mission.deps) {
          if (!knownIds.has(dep)) {
            throw new TowerProtocolError(`mission ${mission.id} depends on unknown mission "${dep}"`);
          }
        }
      }
      const takenBranches = new Map(state.missions.map((m): [string, TowerMission] => [m.branch, m]));
      for (const mission of missions) {
        const existing = takenBranches.get(mission.branch);
        if (existing !== undefined) {
          throw new TowerProtocolError(
            `mission ${mission.id} branch "${mission.branch}" is already used by ${existing.id} (${existing.status}) "${existing.title}" — change the title so its slug differs; branch-to-mission resolution must stay unambiguous`,
          );
        }
        if (await branchExists(this.repoRoot, mission.branch)) {
          throw new TowerProtocolError(
            `mission ${mission.id} branch "${mission.branch}" already exists in git but is not owned by any tower mission — the worker would start on that branch's unrelated history; change the title so its slug differs, or delete/rename the stale branch if it is a leftover`,
          );
        }
        takenBranches.set(mission.branch, mission);
      }
      const openExisting = state.missions.filter(isOpenMission);
      const byId = new Map<string, TowerMission>();
      for (const existing of [...openExisting, ...missions]) byId.set(existing.id, existing);
      for (const mission of missions) {
        const older = [
          ...openExisting,
          ...missions.filter((m) => missionNumber(m.id) < missionNumber(mission.id)),
        ];
        addAutoDeps(mission, older, byId);
      }
      this.assertScopesDisjoint([...openExisting, ...missions]);

      state.missions.push(...missions);
      await this.save(state);
      await this.renderMissionsIndex(state);
      for (const mission of missions) {
        await this.renderMissionFile(mission);
      }
      await this.appendLog(TOWER_NAME, 'plan', { missions: missions.map((m) => m.id).join(',') }, MISSIONS_INDEX);
      return missions;
    });
  }

  private assertScopesDisjoint(missions: readonly TowerMission[]): void {
    const scopes: Array<{ readonly id: string; readonly raw: string; readonly stem: string }> = [];
    for (const mission of missions) {
      if (mission.kind === 'survey') continue;
      for (const raw of mission.scope) {
        const stem = scopeStem(raw);
        if (stem.length === 0) {
          throw new TowerProtocolError(
            `mission ${mission.id} scope "${raw}" covers the whole repo — narrow it down`,
          );
        }
        scopes.push({ id: mission.id, raw, stem });
      }
    }
    const byId = new Map(missions.map((m) => [m.id, m]));
    for (let i = 0; i < scopes.length; i++) {
      for (let j = i + 1; j < scopes.length; j++) {
        const a = scopes[i]!;
        const b = scopes[j]!;
        if (a.id === b.id) continue;
        if (a.stem === b.stem || a.stem.startsWith(`${b.stem}/`) || b.stem.startsWith(`${a.stem}/`)) {
          if (depPathExists(a.id, b.id, byId) || depPathExists(b.id, a.id, byId)) continue;
          throw new TowerProtocolError(
            `mission scopes overlap: ${a.id} ("${a.raw}") vs ${b.id} ("${b.raw}") without a dependency between them — split the shared files into exactly one mission, or wire a dependency so the merges serialize (TowerPlan and scope widening auto-add one when scopes overlap; if one of them is stale finished work, abandon it first (TowerMission status=abandoned))`,
          );
        }
      }
    }
  }

  async updateMission(
    callerName: string,
    id: string,
    patch: TowerMissionPatch,
    options: { readonly silent?: boolean } = {},
  ): Promise<TowerMission> {
    if (patch.status !== 'completed') {
      return this.withStateLock(async () => {
        const state = await this.load();
        return this.updateMissionLocked(callerName, id, patch, state, options);
      });
    }
    return this.runPrepared(
      async () => {
        const snapshot = await this.loadSnapshot();
        const inbox = await this.listInboxSnapshot();
        await this.updateMissionLocked(callerName, id, patch, structuredClone(snapshot.state), {
          ...options,
          validateOnly: true,
          inboxItems: inbox.items,
        });
        return { snapshot, inboxFiles: inbox.files };
      },
      (prepared) =>
        this.withCompletionLock(async () => {
          const state = await this.assertPreparationCurrent(prepared.snapshot, prepared.inboxFiles);
          return this.updateMissionLocked(callerName, id, patch, state, {
            ...options,
            completionPrepared: true,
          });
        }),
    );
  }

  private async updateMissionLocked(
    callerName: string,
    id: string,
    patch: TowerMissionPatch,
    state: TowerState,
    options: {
      readonly silent?: boolean;
      readonly validateOnly?: boolean;
      readonly completionPrepared?: boolean;
      readonly forceSave?: boolean;
      readonly inboxItems?: readonly TowerInboxItem[];
    } = {},
  ): Promise<TowerMission> {
    const mission = state.missions.find((m) => m.id === id);
    if (mission === undefined) {
      throw new TowerProtocolError(`unknown mission "${id}"`);
    }
    if (callerName !== TOWER_NAME) {
      const caller = this.findAgent(state, callerName);
      if (caller?.kind !== 'worker' || caller.missionId !== id) {
        throw new TowerProtocolError(
          `agent "${callerName}" does not own mission ${id} — workers update only their own mission file`,
        );
      }
    }

    const isNoOp =
      patch.status === mission.status &&
      patch.note === undefined &&
      patch.blocker === undefined &&
      patch.clearBlockers === undefined &&
      patch.taskDone === undefined &&
      patch.taskDrop === undefined &&
      patch.owner === undefined &&
      patch.scope === undefined &&
      patch.spawnBase === undefined;
    if (isNoOp) {
      if (options.forceSave === true) await this.save(state);
      return mission;
    }

    if (patch.status === 'merged') {
      throw new TowerProtocolError(
        `mission ${id} cannot transition to merged through a generic mission patch — only TowerMerge records merged after its merge gate succeeds`,
      );
    }
    if (
      !isOpenMission(mission) &&
      ((patch.status !== undefined && patch.status !== mission.status) || patch.blocker !== undefined)
    ) {
      throw new TowerProtocolError(
        `mission ${id} is ${mission.status} — merged and abandoned are terminal, so a generic mission patch cannot reopen it`,
      );
    }

    if (patch.spawnBase !== undefined) {
      if (callerName !== TOWER_NAME) {
        throw new TowerProtocolError(
          `agent "${callerName}" cannot record a mission spawn base — only the tower does`,
        );
      }
      mission.spawnBase = patch.spawnBase;
    }

    if (patch.owner !== undefined) {
      if (callerName !== TOWER_NAME) {
        throw new TowerProtocolError(
          `agent "${callerName}" cannot assign mission ownership — only the tower sets owner`,
        );
      }
      mission.owner = patch.owner;
    }
    if (patch.scope !== undefined) {
      if (callerName !== TOWER_NAME) {
        throw new TowerProtocolError(
          `agent "${callerName}" cannot change mission scope — only the tower widens a scope, and every change is logged`,
        );
      }
      const patched: TowerMission = { ...mission, scope: [...patch.scope], deps: [...mission.deps], notes: [...mission.notes] };
      const others = state.missions.filter((m) => m.id !== id && isOpenMission(m));
      const byId = new Map(state.missions.map((m) => [m.id, m]));
      byId.set(id, patched);
      addAutoDeps(patched, others, byId);
      this.assertScopesDisjoint([...others, patched]);
      mission.scope = [...patch.scope];
      mission.deps = patched.deps;
      mission.notes = patched.notes;
    }
    if (patch.status !== undefined) {
      if (patch.status === 'abandoned' && callerName !== TOWER_NAME) {
        throw new TowerProtocolError(
          `agent "${callerName}" cannot abandon mission ${id} — abandoning releases the mission scope, so only the tower does it`,
        );
      }
      mission.status = patch.status;
    }
    if (patch.note !== undefined) mission.notes.push(patch.note);
    if (patch.blocker !== undefined) {
      mission.blockers.push(patch.blocker);
      mission.status = 'blocked';
    }
    if (patch.clearBlockers === true) mission.blockers = [];
    if (patch.taskDone !== undefined) {
      const task = mission.tasks.find(
        (t) => !t.done && t.dropped !== true && t.text.includes(patch.taskDone!),
      );
      if (task === undefined) {
        throw new TowerProtocolError(`mission ${id} has no open task matching "${patch.taskDone}"`);
      }
      task.done = true;
    }
    let taskDropLog: string | undefined;
    if (patch.taskDrop !== undefined) {
      const reason = patch.taskDrop.reason?.trim() ?? '';
      if (reason.length === 0) {
        throw new TowerProtocolError(
          `dropping a task from mission ${id} requires a reason — the drop is the escape hatch for legitimately descoped work, and the reason is recorded in the mission notes and the activity log for audit`,
        );
      }
      const task = mission.tasks.find(
        (t) => !t.done && t.dropped !== true && t.text.includes(patch.taskDrop!.text),
      );
      if (task === undefined) {
        throw new TowerProtocolError(`mission ${id} has no open task matching "${patch.taskDrop.text}"`);
      }
      task.dropped = true;
      taskDropLog = `dropped task "${task.text}": ${reason}`;
      mission.notes.push(taskDropLog);
    }
    if (patch.status === 'completed' && patch.blocker === undefined) {
      if (options.completionPrepared !== true) {
        await this.assertCompletable(state, mission);
        if (callerName !== TOWER_NAME) {
          await this.assertInboxRead(state, callerName, mission, options.inboxItems);
        }
      }
    }
    if (options.validateOnly === true) return mission;

    await this.save(state);
    await this.renderMissionsIndex(state);
    await this.renderMissionFile(mission);
    const taskTickOnly =
      patch.taskDone !== undefined &&
      patch.status === undefined &&
      patch.note === undefined &&
      patch.blocker === undefined &&
      patch.clearBlockers === undefined &&
      patch.taskDrop === undefined &&
      patch.owner === undefined &&
      patch.scope === undefined &&
      patch.spawnBase === undefined;
    if (!taskTickOnly && options.silent !== true) {
      await this.appendLog(callerName, 'mission.update', {
        id,
        status: patch.status,
        note: patch.note !== undefined ? 'added' : undefined,
        blocker: patch.blocker !== undefined ? 'added' : undefined,
        task_drop: taskDropLog,
        owner: patch.owner,
        scope: patch.scope?.join(','),
        spawn_base: patch.spawnBase,
      });
    }
    return mission;
  }

  private async assertCompletable(state: TowerState, mission: TowerMission): Promise<void> {
    const open = mission.tasks.filter((t) => !t.done && t.dropped !== true);
    if (open.length > 0) {
      throw new TowerProtocolError(
        `mission ${mission.id} cannot transition to completed — ${String(open.length)} open task(s): ${open.map((t) => `"${t.text}"`).join(', ')}; tick finished tasks with task_done, or drop legitimately descoped ones with task_drop (a reason is mandatory and lands in the mission notes and the activity log)`,
      );
    }
    if (mission.blockers.length > 0) {
      throw new TowerProtocolError(
        `mission ${mission.id} cannot transition to completed — ${String(mission.blockers.length)} blocker(s) remain: ${mission.blockers.join(' | ')}; clear or resolve them before completing`,
      );
    }
    if (mission.kind === 'survey') {
      if (!(await branchExists(this.repoRoot, mission.branch))) return;
      const base = await this.diffBase(state, mission);
      const changed = await diffNameOnly(this.repoRoot, base, mission.branch);
      if (changed.length > 0) {
        throw new TowerProtocolError(
          `mission ${mission.id} cannot transition to completed — it is a read-only survey but branch "${mission.branch}" has ${String(changed.length)} changed file(s) vs "${base}": ${changed.slice(0, 5).join(', ')}; move any changes worth keeping to a build mission and leave the survey branch zero-diff`,
        );
      }
      return;
    }
    if (!(await branchExists(this.repoRoot, mission.branch))) {
      throw new TowerProtocolError(
        `mission ${mission.id} cannot transition to completed — its branch "${mission.branch}" does not exist, so no work has landed; a build mission must produce a diff on its branch: spawn a worker to do the work, or have the tower abandon the mission (status=abandoned) if it is no longer needed`,
      );
    }
    const base = await this.diffBase(state, mission);
    const changed = await diffNameOnly(this.repoRoot, base, mission.branch);
    if (changed.length === 0) {
      throw new TowerProtocolError(
        `mission ${mission.id} cannot transition to completed — branch "${mission.branch}" has no changes vs "${base}"; a build mission must produce a diff on its branch: commit the work there first, or if the work turned out unnecessary, have the tower abandon the mission (status=abandoned) instead`,
      );
    }
  }

  private async assertInboxRead(
    state: TowerState,
    callerName: string,
    mission: TowerMission,
    inboxItems?: readonly TowerInboxItem[],
  ): Promise<void> {
    const items = inboxItems ?? (await this.listInboxItems());
    const unread = items.filter(
      (item) => this.inboxItemVisibleTo(callerName, item) && this.isInboxItemUnread(state, callerName, item),
    );
    if (unread.length === 0) return;
    throw new TowerProtocolError(
      `mission ${mission.id} cannot transition to completed — ${String(unread.length)} unread inbox message(s) for ${callerName}; call TowerInbox until no unread messages remain, incorporate anything new into the delivery, then retry status=completed`,
    );
  }

  async send(callerName: string, input: TowerSendInput): Promise<string> {
    return (await this.sendDetailed(callerName, input)).item.file;
  }

  async sendDetailed(callerName: string, input: TowerSendInput): Promise<TowerSendResult> {
    const state = await this.load();
    return this.withInboxPublicationLock(() => this.sendDetailedSnapshot(callerName, input, state));
  }

  private async sendDetailedSnapshot(
    callerName: string,
    input: TowerSendInput,
    state: TowerState,
  ): Promise<TowerSendResult> {
    const to = input.to.trim();
    if (to !== TOWER_NAME && to !== BROADCAST_NAME && this.findAgent(state, to) === undefined) {
      const known = [TOWER_NAME, BROADCAST_NAME, ...state.roster.agents.map((a) => a.name)];
      throw new TowerProtocolError(
        `unknown recipient "${to}" — address a roster agent, ${TOWER_NAME}, or ${BROADCAST_NAME} (known: ${known.join(', ')})`,
      );
    }
    if (to === callerName) {
      throw new TowerProtocolError('cannot send an inbox message to yourself');
    }

    const messageId = randomUUID();
    const sentAt = new Date().toISOString();
    const body = input.body.trim();
    const frontmatter = renderFrontmatter({
      type: 'inbox',
      message_id: messageId,
      from: callerName,
      to,
      subject: singleLine(input.subject),
      sent_at: sentAt,
      scope: input.scope === undefined ? undefined : singleLine(input.scope),
      action: input.action === undefined ? undefined : singleLine(input.action),
      consent_ref: input.consentRef === undefined ? undefined : singleLine(input.consentRef),
    });
    const content = `${frontmatter}\n\n${body}\n`;
    const baseName = inboxFileName({ from: callerName, to, subject: input.subject });
    const rel = await this.writeUnique(join(INBOX_DIR, baseName), content);
    let activityLogError: string | undefined;
    try {
      await this.appendLog(callerName, 'inbox.send', { to, subject: slugify(input.subject) }, rel);
    } catch (error) {
      activityLogError = `inbox message ${rel} was stored, but appending its inbox.send activity log failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    const caller = this.findAgent(state, callerName);
    const recipient = to === TOWER_NAME || to === BROADCAST_NAME ? undefined : this.findAgent(state, to);
    const missionId =
      caller?.missionId ??
      caller?.reviewMissionId ??
      (callerName === TOWER_NAME ? (recipient?.missionId ?? recipient?.reviewMissionId) : undefined);
    return {
      item: {
        messageId,
        file: rel,
        from: callerName,
        to,
        subject: singleLine(input.subject),
        sentAt,
        scope: input.scope,
        action: input.action,
        consentRef: input.consentRef,
        body,
      },
      missionId,
      activityLogError,
    };
  }

  async complete(callerName: string, report: string): Promise<TowerCompleteResult> {
    const trimmed = report.trim();
    if (trimmed.length === 0) {
      throw new TowerProtocolError('TowerComplete report must not be empty');
    }
    return this.runPrepared(
      async () => {
        const snapshot = await this.loadSnapshot();
        const inbox = await this.listInboxSnapshot();
        await this.completeLocked(callerName, trimmed, structuredClone(snapshot.state), {
          validateOnly: true,
          inboxItems: inbox.items,
        });
        return { snapshot, inboxFiles: inbox.files, inboxItems: inbox.items };
      },
      (prepared) =>
        this.withCompletionLock(async () => {
          const state = await this.assertPreparationCurrent(prepared.snapshot, prepared.inboxFiles);
          return this.completeLocked(callerName, trimmed, state, {
            completionPrepared: true,
            inboxItems: prepared.inboxItems,
          });
        }),
    );
  }

  private async completeLocked(
    callerName: string,
    report: string,
    state: TowerState,
    options: TowerCompletionLockedOptions,
  ): Promise<TowerCompleteResult> {
    const caller = this.findAgent(state, callerName);
    const ownedMission =
      caller?.missionId !== undefined
        ? state.missions.find((mission) => mission.id === caller.missionId)
        : undefined;
    if (callerName === TOWER_NAME || caller?.kind !== 'worker' || ownedMission === undefined) {
      if (caller?.kind === 'worker' && state.recoveredAt !== undefined) {
        return this.completeStateLostLocked(caller, report, state, state.recoveredAt, options);
      }
      if (caller?.kind === 'worker' && caller.missionId !== undefined) {
        throw new TowerProtocolError(`unknown mission "${caller.missionId}"`);
      }
      throw new TowerProtocolError(
        `agent "${callerName}" cannot use TowerComplete — only the worker who owns a mission can complete it`,
      );
    }
    const beforeMission = ownedMission;
    const wasCompleted = beforeMission.status === 'completed';
    const subject = beforeMission.kind === 'survey' ? 'survey-summary' : 'review-request';
    if (wasCompleted) {
      const existing = await this.findCompletionMessage(
        callerName,
        beforeMission,
        subject,
        report,
        options.inboxItems,
      );
      if (existing !== undefined) {
        return {
          mission: beforeMission,
          message: { item: existing, missionId: beforeMission.id },
          notificationCreated: false,
        };
      }
      if (options.completionPrepared !== true) {
        await this.assertCompletable(state, beforeMission);
        await this.assertInboxRead(state, callerName, beforeMission, options.inboxItems);
      }
    }
    const mission = await this.updateMissionLocked(
      callerName,
      beforeMission.id,
      { status: 'completed' },
      state,
      options,
    );
    if (options.validateOnly === true) {
      return { mission, notificationCreated: false };
    }
    try {
      const message = await this.sendDetailedSnapshot(
        callerName,
        { to: TOWER_NAME, subject, body: report, scope: mission.id, action: 'complete' },
        state,
      );
      return {
        mission,
        message,
        notificationCreated: true,
        activityLogError: message.activityLogError,
      };
    } catch (error) {
      const existing = await this.findCompletionMessage(callerName, mission, subject, report);
      return {
        mission,
        message: existing === undefined ? undefined : { item: existing, missionId: mission.id },
        notificationCreated: false,
        notificationError: `mission ${mission.id} was persisted as completed, but storing its ${subject} notification failed: ${error instanceof Error ? error.message : String(error)} — retry with the same report to reuse an already stored notification instead of duplicating it`,
      };
    }
  }

  private async completeStateLostLocked(
    caller: TowerRosterEntry,
    report: string,
    state: TowerState,
    recoveredAt: string,
    options: TowerCompletionLockedOptions,
  ): Promise<TowerCompleteResult> {
    const subject = 'completion-report-state-lost';
    const items = options.inboxItems ?? (await this.listInboxItems());
    const existing = items.find(
      (item) =>
        item.from === caller.name &&
        item.to === TOWER_NAME &&
        item.subject === subject &&
        item.action === 'complete' &&
        item.body === report,
    );
    if (existing !== undefined) {
      return { recoveredAt, message: { item: existing }, notificationCreated: false };
    }
    if (options.validateOnly === true) {
      return { recoveredAt, notificationCreated: false };
    }
    try {
      const message = await this.sendDetailedSnapshot(
        caller.name,
        { to: TOWER_NAME, subject, body: report, action: 'complete' },
        state,
      );
      return {
        recoveredAt,
        message,
        notificationCreated: true,
        activityLogError: message.activityLogError,
      };
    } catch (error) {
      return {
        recoveredAt,
        notificationCreated: false,
        notificationError: `the tower state was recovered at ${recoveredAt} after a loss, so no mission was marked completed — and storing the degraded completion report also failed: ${error instanceof Error ? error.message : String(error)} — retry with the same report to deliver it`,
      };
    }
  }

  private async findCompletionMessage(
    callerName: string,
    mission: TowerMission,
    subject: string,
    report: string,
    inboxItems?: readonly TowerInboxItem[],
  ): Promise<TowerInboxItem | undefined> {
    return (inboxItems ?? (await this.listInboxItems())).find(
      (item) =>
        item.from === callerName &&
        item.to === TOWER_NAME &&
        item.subject === subject &&
        item.scope === mission.id &&
        item.action === 'complete' &&
        item.body === report,
    );
  }

  async readInbox(callerName: string, limit: number): Promise<readonly TowerInboxItem[]> {
    const items = (await this.listInboxItems()).filter((item) => this.inboxItemVisibleTo(callerName, item));
    return items.slice(0, Math.max(1, limit));
  }

  async readUnreadInbox(callerName: string, limit: number): Promise<readonly TowerInboxItem[]> {
    const state = await this.load();
    const items = await this.listUnreadInboxItems(state, callerName);
    return items.slice(0, Math.max(1, limit));
  }

  async countUnreadInbox(callerName: string): Promise<number> {
    const state = await this.load();
    return (await this.listUnreadInboxItems(state, callerName)).length;
  }

  async ackInbox(callerName: string, messageIds: readonly string[]): Promise<number> {
    return this.withStateLock(async () => {
      const state = await this.load();
      const index = state.roster.agents.findIndex((agent) => agent.name === callerName);
      const entry = state.roster.agents[index];
      const current = callerName === TOWER_NAME ? state.inboxAckIds : entry?.inboxAckIds;
      const ackIds = new Set(current);
      const previousSize = ackIds.size;
      for (const messageId of messageIds) ackIds.add(messageId);
      let changed = false;
      if (ackIds.size > previousSize) {
        if (callerName === TOWER_NAME) {
          state.inboxAckIds = [...ackIds];
          changed = true;
        } else if (entry !== undefined) {
          state.roster.agents[index] = { ...entry, inboxAckIds: [...ackIds] };
          changed = true;
        }
      }
      if (changed) await this.save(state);
      return (await this.listUnreadInboxItems(state, callerName)).length;
    });
  }

  private inboxItemVisibleTo(callerName: string, item: TowerInboxItem): boolean {
    return callerName === TOWER_NAME || item.to === callerName || item.to === BROADCAST_NAME;
  }

  private async listUnreadInboxItems(state: TowerState, callerName: string): Promise<TowerInboxItem[]> {
    return (await this.listInboxItems()).filter(
      (item) => this.inboxItemVisibleTo(callerName, item) && this.isInboxItemUnread(state, callerName, item),
    );
  }

  private isInboxItemUnread(state: TowerState, callerName: string, item: TowerInboxItem): boolean {
    const entry = callerName === TOWER_NAME ? undefined : this.findAgent(state, callerName);
    const ackIds = callerName === TOWER_NAME ? state.inboxAckIds : entry?.inboxAckIds;
    if (ackIds?.includes(item.messageId) === true) return false;
    if (callerName === TOWER_NAME) return true;
    const since = entry?.lastInboxReadAt ?? entry?.spawnedAt;
    return since === undefined || item.sentAt > since;
  }

  private async listInboxItems(): Promise<TowerInboxItem[]> {
    return (await this.listInboxSnapshot()).items;
  }

  private async listInboxSnapshot(): Promise<{
    readonly items: TowerInboxItem[];
    readonly files: readonly string[];
  }> {
    let files: string[];
    try {
      files = await readdir(this.abs(INBOX_DIR));
    } catch {
      return { items: [], files: [] };
    }
    const candidates = files.filter((file) => file.endsWith('.md'));
    const loaded = await mapWithConcurrency(
      candidates,
      TOWER_FILE_IO_CONCURRENCY,
      async (file): Promise<TowerInboxItem | undefined> => {
        const rel = join(INBOX_DIR, file);
        let text: string;
        try {
          text = await readFile(this.abs(rel), 'utf8');
        } catch {
          return undefined;
        }
        const { fields, body } = parseFrontmatter(text);
        if (fields['type'] !== 'inbox') return undefined;
        return {
          messageId: fields['message_id'] ?? rel,
          file: rel,
          from: fields['from'] ?? 'unknown',
          to: fields['to'] ?? '',
          subject: fields['subject'] ?? '',
          sentAt: fields['sent_at'] ?? '',
          scope: fields['scope'],
          action: fields['action'],
          consentRef: fields['consent_ref'],
          body,
        };
      },
    );
    const items = loaded.filter((item): item is TowerInboxItem => item !== undefined);
    items.sort((a, b) => b.sentAt.localeCompare(a.sentAt) || a.file.localeCompare(b.file));
    return { items, files: candidates.toSorted() };
  }

  async fileFinding(callerName: string, input: TowerFindingInput): Promise<string> {
    if (!FINDING_TYPES.includes(input.type)) {
      throw new TowerProtocolError(`finding type must be one of ${FINDING_TYPES.join(' | ')}`);
    }
    const state = await this.load();
    const caller = this.findAgent(state, callerName);
    const mission =
      caller?.missionId !== undefined ? state.missions.find((m) => m.id === caller.missionId) : undefined;

    const lines = [
      `# Finding: ${input.title}`,
      '',
      `**Date**: ${dateDash().replaceAll('-', '')}`,
      `**Agent**: ${callerName}`,
      `**Type**: ${input.type}`,
      `**Severity**: ${input.severity ?? 'medium'}`,
      `**Mission**: ${mission === undefined ? '(none)' : `${mission.id} — ${mission.title}`}`,
      '',
      '---',
      '',
      '## Summary',
      input.summary.trim(),
      '',
      '## Location',
      (input.location ?? '(not specified)').trim(),
      '',
      '## Details',
      input.details.trim(),
      '',
      '## Suggested Fix / Action',
      input.suggestedFix.trim(),
      '',
      '## Why Not Fixed Directly',
      mission === undefined
        ? 'This finding is outside the reporting agent’s assignment. Assigning to the control tower for routing.'
        : `This finding is outside the scope of mission ${mission.id} (${mission.scope.join(', ')}). Fixing it directly would violate scope isolation. Assigning to the control tower for routing.`,
      '',
      '---',
      '',
      `*Filed by tower agent ${callerName} via \`${FINDINGS_DIR}/\`*`,
      '',
    ];
    const baseName = findingFileName({ agent: callerName, type: input.type, slug: input.title });
    const rel = await this.writeUnique(join(FINDINGS_DIR, baseName), lines.join('\n'));
    await this.appendLog(callerName, 'finding.file', { type: input.type, slug: slugify(input.title) }, rel);
    return rel;
  }
