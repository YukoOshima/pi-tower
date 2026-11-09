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
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { listBaseDirtyEntries, snapshotBaseWip } from './baseWip.ts';
import {
  mapWithConcurrency,
  TOWER_FILE_IO_CONCURRENCY,
  TOWER_GIT_CONCURRENCY,
} from './concurrency.ts';
import { TowerProtocolError } from './errors.ts';
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
  worktreeAddDetached,
  worktreeAddNewBranch,
  worktreeRemove,
} from './git.ts';
import { evaluateMissionGate } from './missionGate.ts';
import type { TowerMissionGateResult, TowerMissionGitObservations } from './missionGate.ts';
import {
  applyAutopilotPatch,
  applyObjectiveUpdate,
  applyValidationRound,
  buildObjective,
  canPlanObjective,
  contractRevisionOf,
  currentMilestone,
  estimateObjectiveRuns,
  evaluateObjective,
  failedRoundsOn,
  finalMilestone,
  finalPassBroken,
  findMilestone,
  isObjectiveOpen,
  isTerminalObjectiveStatus,
  latestValidationRound,
  milestoneMissions,
  milestoneOrderOf,
  milestonePassesOn,
  nextValidationRound,
  objectiveApprovalProblems,
  planPlacement,
  requiredValidationKinds,
  roundContractRevision,
  sortedMilestones,
  TOWER_OBJECTIVE_MODES,
  TOWER_VALIDATION_KINDS,
  TowerObjectiveCompletionError,
  validationResultSubject,
} from './objective.ts';
import type {
  TowerMilestoneOrderOf,
  TowerObjectiveAutopilotPatch,
  TowerObjectiveDraftInput,
  TowerObjectiveEvaluation,
  TowerObjectiveUpdateInput,
  TowerObjectiveUpdateResult,
  TowerValidationOutcome,
  TowerValidationSettings,
} from './objective.ts';
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
  VALIDATION_WORKTREE_PREFIX,
  VALIDATIONS_DIR,
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
  validationFileName,
  validationWorktreeName,
} from './paths.ts';
import type {
  TowerFindingSeverity,
  TowerFindingType,
  TowerInboxItem,
  TowerMilestone,
  TowerMission,
  TowerMissionKind,
  TowerMissionOrigin,
  TowerMissionStatus,
  TowerObjective,
  TowerObjectiveAutopilotState,
  TowerObjectiveMode,
  TowerReviewInfo,
  TowerRosterEntry,
  TowerState,
  TowerValidationKind,
  TowerValidationRound,
  TowerValidationVerdict,
} from './types.ts';

export { TowerProtocolError } from './errors.ts';

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
  readonly milestone?: string;
  readonly origin?: TowerMissionOrigin;
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

export interface TowerValidationInput {
  readonly milestone: string;
  readonly kind: TowerValidationKind;
  readonly verdict: TowerValidationVerdict;
  readonly failures?: readonly string[];
  readonly checks?: readonly string[];
  readonly evidence?: string;
  readonly validatedCommit?: string;
  readonly contractRevision?: number;
}

export interface TowerValidationResult {
  readonly round: TowerValidationRound;
  readonly milestone: TowerMilestone;
  readonly objective: TowerObjective;
  readonly message?: TowerSendResult;
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

export interface TowerValidationWorktree {
  readonly worktree: string;
  readonly path: string;
  readonly commit: string;
  readonly round: number;
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
  orderOf: TowerMilestoneOrderOf = () => undefined,
): void {
  if (mission.kind === 'survey') return;
  const own = orderOf(mission);
  for (const other of candidates) {
    if (other.id === mission.id || other.kind === 'survey') continue;
    const theirs = orderOf(other);
    if (own !== undefined && theirs !== undefined && theirs > own) continue;
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
      const attempted = this.registerAgentLocked(await this.resolveValidatorEntry(entry), state);
      await this.save(state);
      if (attempted !== undefined) await this.renderMissionFile(attempted);
    });
  }

  async registerSpawnedAgent(
    entry: TowerRosterEntry,
    mission?: { readonly id: string; readonly owner: string },
  ): Promise<void> {
    await this.withStateLock(async () => {
      const state = await this.load();
      const attempted = this.registerAgentLocked(await this.resolveValidatorEntry(entry), state);
      if (mission === undefined) {
        await this.save(state);
        if (attempted !== undefined) await this.renderMissionFile(attempted);
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

  private registerAgentLocked(entry: TowerRosterEntry, state: TowerState): TowerMission | undefined {
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
    if (entry.validationKind === 'commands') {
      throw new TowerProtocolError(
        `agent "${entry.name}" cannot register for the commands validation — the tower runs the milestone and acceptance commands mechanically and records them itself`,
      );
    }
    if (entry.kind === 'validator') this.assertValidatorRegistration(entry, state);
    for (let index = state.roster.agents.length - 1; index >= 0; index -= 1) {
      if (state.roster.agents[index]!.agentId === entry.agentId) {
        state.roster.agents.splice(index, 1);
      }
    }
    if (this.findAgent(state, entry.name) !== undefined) {
      throw new TowerProtocolError(`tower agent name "${entry.name}" is already registered`);
    }
    const stored: TowerRosterEntry = {
      ...entry,
      lastInboxReadAt: entry.lastInboxReadAt ?? entry.spawnedAt,
    };
    state.roster.agents.push(
      withContractRevision(
        stored,
        entry.kind === 'validator' && state.objective !== undefined ? contractRevisionOf(state.objective) : 0,
      ),
    );
    if (entry.kind !== 'worker' || state.objective === undefined) return undefined;
    const mission = state.missions.find((candidate) => candidate.id === entry.missionId);
    if (mission === undefined) return undefined;
    mission.attempts = (mission.attempts ?? 0) + 1;
    return mission;
  }

  private assertValidatorRegistration(entry: TowerRosterEntry, state: TowerState): void {
    if (entry.milestoneId === undefined || entry.validationKind === undefined) {
      throw new TowerProtocolError(
        `validator "${entry.name}" needs a milestone and a validation kind — a validator checks exactly one (milestone, kind, round)`,
      );
    }
    if (!TOWER_VALIDATION_KINDS.includes(entry.validationKind)) {
      throw new TowerProtocolError(
        `validator "${entry.name}" validation kind must be ${TOWER_VALIDATION_KINDS.join(' | ')}, got "${String(entry.validationKind)}"`,
      );
    }
    const objective = state.objective;
    if (objective === undefined || !isObjectiveOpen(objective)) {
      throw new TowerProtocolError(
        `validator "${entry.name}" cannot be registered — there is no open objective${objective === undefined ? '' : ` (objective ${objective.id} is ${objective.status})`}`,
      );
    }
    const milestone = findMilestone(objective, entry.milestoneId);
    if (milestone === undefined) {
      throw new TowerProtocolError(
        `validator "${entry.name}" names milestone "${entry.milestoneId}", which objective ${objective.id} does not have`,
      );
    }
    if (milestone.status !== 'validating') {
      throw new TowerProtocolError(
        `validator "${entry.name}" cannot be registered — milestone ${milestone.id} is ${milestone.status}, and validators are registered only while it is validating`,
      );
    }
    if (entry.validatedCommit === undefined) {
      throw new TowerProtocolError(
        `validator "${entry.name}" needs a validatedCommit — the commit its validation worktree was checked out at, which stamps its round`,
      );
    }
    const revision = contractRevisionOf(objective);
    const briefed: unknown = entry.contractRevision;
    if (briefed !== undefined && (typeof briefed !== 'number' || !Number.isSafeInteger(briefed) || briefed < 0)) {
      throw new TowerProtocolError(
        `validator "${entry.name}" contractRevision must be the non-negative integer revision it was briefed under, got ${JSON.stringify(briefed)}`,
      );
    }
    if (briefed === undefined && revision > 0) {
      throw new TowerProtocolError(
        `validator "${entry.name}" must state the contract revision it was briefed under (contractRevision) — objective ${objective.id} is at revision ${String(revision)}, and a round is stamped with the contract its validator checked`,
      );
    }
    if (briefed !== undefined && briefed !== revision) {
      throw new TowerProtocolError(
        `validator "${entry.name}" was briefed under contract revision ${String(briefed)}, but objective ${objective.id} is at revision ${String(revision)} — brief a new validator on the current contract`,
      );
    }
    if (entry.validatedCommit !== milestone.validationCommit) {
      throw new TowerProtocolError(
        `validator "${entry.name}" was checked out at ${entry.validatedCommit.slice(0, 7)}, but milestone ${milestone.id} is validating ${milestone.validationCommit?.slice(0, 7) ?? 'no commit'} — prepare a validation worktree for the current validation commit`,
      );
    }
  }

  private async resolveValidatorEntry(entry: TowerRosterEntry): Promise<TowerRosterEntry> {
    if (entry.kind !== 'validator' || entry.validatedCommit === undefined) return entry;
    let validatedCommit: string;
    try {
      validatedCommit = await this.resolveCommit(entry.validatedCommit);
    } catch {
      throw new TowerProtocolError(
        `validator "${entry.name}" validatedCommit "${entry.validatedCommit}" does not name a commit in this repository — register the commit its validation worktree was checked out at`,
      );
    }
    return { ...entry, validatedCommit };
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

  async draftObjective(input: TowerObjectiveDraftInput): Promise<TowerObjective> {
    return this.withStateLock(async () => {
      const state = await this.load();
      const previous = state.objective;
      if (previous !== undefined && !isTerminalObjectiveStatus(previous.status)) {
        throw new TowerProtocolError(
          `objective ${previous.id} is still ${previous.status} — update it instead, or block it before drafting a new objective`,
        );
      }
      const objective = buildObjective(state, input, new Date().toISOString());
      if (previous !== undefined) {
        state.objectiveHistory = [...(state.objectiveHistory ?? []), previous];
      }
      state.objective = objective;
      await this.saveObjective(state, 'objective.draft', {
        id: objective.id,
        milestones:
          objective.milestones.length > 0
            ? objective.milestones.map((milestone) => milestone.id).join(',')
            : undefined,
        archived: previous?.id,
      });
      return objective;
    });
  }

  async updateObjective(input: TowerObjectiveUpdateInput): Promise<TowerObjectiveUpdateResult> {
    return this.withStateLock(async () => {
      const state = await this.load();
      const result = applyObjectiveUpdate(state, input);
      if (result.changes.length === 0) return result;
      state.objective = result.objective;
      await this.saveObjective(state, 'objective.update', {
        id: result.objective.id,
        changes: result.changes.join(','),
        status: result.objective.status,
        reopened: result.reopened.length > 0 ? result.reopened.join(',') : undefined,
        approval: result.objective.approvalRequiresHuman === true ? 'human' : undefined,
      });
      return result;
    });
  }

  async requestObjectiveApproval(): Promise<{
    readonly objective: TowerObjective;
    readonly estimatedRuns: number;
  }> {
    return this.withStateLock(async () => {
      const state = await this.load();
      const objective = this.requireObjective(state);
      if (objective.status !== 'planning' && objective.status !== 'awaiting-approval') {
        throw new TowerProtocolError(
          `objective ${objective.id} is ${objective.status} — only a planning objective can request approval`,
        );
      }
      this.assertApprovable(state, objective, 'request approval');
      objective.status = 'awaiting-approval';
      const estimatedRuns = estimateObjectiveRuns(state);
      await this.saveObjective(state, 'objective.request-approval', {
        id: objective.id,
        estimated_runs: estimatedRuns,
      });
      return { objective, estimatedRuns };
    });
  }

  async approveObjective(by: 'human' | 'auto'): Promise<TowerObjective> {
    if (by !== 'human' && by !== 'auto') {
      throw new TowerProtocolError(`an objective is approved by "human" or "auto", got "${String(by)}"`);
    }
    return this.withStateLock(async () => {
      const state = await this.load();
      const objective = this.requireObjective(state);
      if (objective.status !== 'awaiting-approval') {
        throw new TowerProtocolError(
          `objective ${objective.id} is ${objective.status} — only an objective awaiting approval can be approved; the orchestrator requests approval first`,
        );
      }
      if (by === 'auto' && objective.approvalRequiresHuman === true) {
        throw new TowerProtocolError(
          `objective ${objective.id} changed its contract while it was blocked or paused, so only a human can approve it — auto-approval stays refused until a human approves`,
        );
      }
      this.assertApprovable(state, objective, 'be approved');
      const now = new Date().toISOString();
      objective.status = 'executing';
      objective.approvedBy = by;
      objective.approvedAt = now;
      objective.startedAt ??= now;
      delete objective.approvalReason;
      delete objective.approvalRequiresHuman;
      const activated = this.activateCurrentMilestoneLocked(objective, now);
      await this.saveObjective(state, 'objective.approve', {
        id: objective.id,
        by,
        activated: activated?.id,
      });
      return objective;
    });
  }

  async pauseObjective(reason: string): Promise<TowerObjective> {
    return this.withStateLock(async () => {
      const state = await this.load();
      const objective = this.requireObjective(state);
      if (objective.status !== 'executing') {
        throw new TowerProtocolError(
          `objective ${objective.id} is ${objective.status} — only an executing objective can be paused`,
        );
      }
      objective.status = 'paused';
      objective.pausedReason = reason.trim().length > 0 ? reason.trim() : 'paused on request';
      await this.saveObjective(state, 'objective.pause', {
        id: objective.id,
        reason: objective.pausedReason,
      });
      return objective;
    });
  }

  async resumeObjective(): Promise<TowerObjective> {
    return this.withStateLock(async () => {
      const state = await this.load();
      const objective = this.requireObjective(state);
      const from = objective.status;
      if (from !== 'paused' && from !== 'blocked') {
        throw new TowerProtocolError(
          `objective ${objective.id} is ${from} — only a paused or blocked objective can be resumed`,
        );
      }
      objective.status = objective.approvedAt !== undefined ? 'executing' : 'planning';
      delete objective.pausedReason;
      delete objective.blockedReason;
      const reopened: string[] = [];
      for (const milestone of objective.milestones) {
        if (milestone.status !== 'blocked') continue;
        milestone.status = 'failed';
        reopened.push(milestone.id);
      }
      if (objective.autopilot !== undefined) {
        objective.autopilot.stallWakes = 0;
        objective.autopilot.progressAt = new Date().toISOString();
      }
      await this.saveObjective(state, 'objective.resume', {
        id: objective.id,
        from,
        status: objective.status,
        reopened: reopened.length > 0 ? reopened.join(',') : undefined,
      });
      return objective;
    });
  }

  async blockObjective(reason: string): Promise<TowerObjective> {
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      throw new TowerProtocolError('blocking an objective needs a reason — the human is notified with it');
    }
    return this.withStateLock(async () => {
      const state = await this.load();
      const objective = this.requireObjective(state);
      if (objective.status === 'completed' || objective.status === 'blocked') {
        throw new TowerProtocolError(`objective ${objective.id} is already ${objective.status}`);
      }
      objective.status = 'blocked';
      objective.blockedReason = trimmed;
      delete objective.pausedReason;
      await this.saveObjective(state, 'objective.block', { id: objective.id, reason: trimmed });
      return objective;
    });
  }

  /**
   * Wave 2 must pass the configured objective settings (skipScrutiny, skipUserTesting): they decide
   * which validation kinds the completion gate requires. The default `{}` requires every kind.
   */
  async completeObjective(settings: TowerValidationSettings = {}): Promise<TowerObjective> {
    return this.withStateLock(async () => {
      const state = await this.load();
      const objective = this.requireObjective(state);
      const baseTip = await branchTip(this.repoRoot, state.base);
      const evaluation = evaluateObjective(state, baseTip, settings);
      if (!evaluation.completion.ready) {
        throw new TowerObjectiveCompletionError(objective.id, evaluation.completion.blocks);
      }
      objective.status = 'completed';
      objective.completedAt = new Date().toISOString();
      await this.saveObjective(state, 'objective.complete', {
        id: objective.id,
        base_tip: baseTip.slice(0, 7),
      });
      return objective;
    });
  }

  /**
   * Wave 2 must pass the configured objective settings (skipScrutiny, skipUserTesting): they decide
   * the required kinds, readiness and the completion gate. The default `{}` requires every kind.
   */
  async objectiveEvaluation(settings: TowerValidationSettings = {}): Promise<TowerObjectiveEvaluation> {
    const state = await this.load();
    return evaluateObjective(state, await branchTip(this.repoRoot, state.base), settings);
  }

  async activateNextMilestone(): Promise<TowerMilestone | undefined> {
    return this.withStateLock(async () => {
      const state = await this.load();
      const objective = this.requireExecutingObjective(state, 'activate a milestone');
      const activated = this.activateCurrentMilestoneLocked(objective, new Date().toISOString());
      if (activated === undefined) return undefined;
      await this.saveObjective(state, 'milestone.activate', {
        objective: objective.id,
        milestone: activated.id,
      });
      return activated;
    });
  }

  /**
   * Wave 2 must pass the configured objective settings (skipScrutiny, skipUserTesting): they decide
   * the required kinds (the milestone passes immediately when none is required, or when every one
   * already passed on the commit under the current contract), whether a passed final milestone is
   * stale, and which failed rounds block a same-tip restart. The default `{}` requires every kind.
   */
  async startMilestoneValidation(
    milestoneId: string,
    commit: string,
    settings: TowerValidationSettings = {},
  ): Promise<{
    readonly milestone: TowerMilestone;
    readonly commit: string;
    readonly requiredKinds: readonly TowerValidationKind[];
  }> {
    return this.withStateLock(async () => {
      const state = await this.load();
      const objective = this.requireExecutingObjective(state, 'start a validation');
      const milestone = findMilestone(objective, milestoneId);
      if (milestone === undefined) {
        throw new TowerProtocolError(`objective ${objective.id} has no milestone "${milestoneId}"`);
      }
      if (milestone.status === 'pending' || milestone.status === 'blocked') {
        throw new TowerProtocolError(
          `milestone ${milestone.id} is ${milestone.status} — only an active, validating or failed milestone, or a stale final one, can be validated`,
        );
      }
      if (milestone.status === 'passed' && finalMilestone(objective)?.id !== milestone.id) {
        throw new TowerProtocolError(
          `milestone ${milestone.id} already passed — only the final milestone is validated again, when the base tip moved after it passed`,
        );
      }
      const earlier = sortedMilestones(objective).filter(
        (other) => other.order < milestone.order && other.status !== 'passed',
      );
      if (earlier.length > 0) {
        throw new TowerProtocolError(
          `milestone ${milestone.id} cannot be validated before ${earlier.map((other) => other.id).join(', ')} passed`,
        );
      }
      const features = milestoneMissions(state, milestone.id);
      const open = features.filter(isOpenMission);
      if (features.length === 0 || open.length > 0) {
        throw new TowerProtocolError(
          features.length === 0
            ? `milestone ${milestone.id} has no features — plan them with TowerPlan(milestone=${milestone.id}) before validating it`
            : `milestone ${milestone.id} still has open features (${open.map((mission) => `${mission.id} ${mission.status}`).join(', ')}) — validation starts once every feature is merged or abandoned`,
        );
      }
      const resolved = await this.resolveCommit(commit);
      const baseTip = await branchTip(this.repoRoot, state.base);
      if (resolved !== baseTip) {
        throw new TowerProtocolError(
          `milestone ${milestone.id} is validated on the current base tip ${baseTip.slice(0, 7)} of "${state.base}", not on ${resolved.slice(0, 7)}`,
        );
      }
      if (
        milestone.status === 'passed' &&
        milestone.validationCommit === baseTip &&
        milestonePassesOn(objective, milestone, baseTip, settings)
      ) {
        throw new TowerProtocolError(
          `final milestone ${milestone.id} already passed on the current base tip ${baseTip.slice(0, 7)} — it is validated again only after the base tip moves`,
        );
      }
      const failedHere = failedRoundsOn(objective, milestone, baseTip, settings).map(
        (round) => `${round.kind} r${String(round.round)}`,
      );
      if (failedHere.length > 0) {
        throw new TowerProtocolError(
          `milestone ${milestone.id} already failed ${failedHere.join(', ')} on the base tip ${baseTip.slice(0, 7)} — a new validation needs a new base tip: merge a fix planned into ${milestone.id} first`,
        );
      }
      const now = new Date().toISOString();
      milestone.status = 'validating';
      milestone.validationCommit = resolved;
      delete milestone.passedAt;
      const requiredKinds = requiredValidationKinds(objective, milestone, settings);
      if (milestonePassesOn(objective, milestone, resolved, settings)) {
        milestone.status = 'passed';
        milestone.passedAt = now;
      }
      await this.saveObjective(state, 'milestone.validate', {
        objective: objective.id,
        milestone: milestone.id,
        commit: resolved.slice(0, 7),
        kinds: requiredKinds.length > 0 ? requiredKinds.join(',') : 'none',
        status: milestone.status,
      });
      return { milestone, commit: resolved, requiredKinds };
    });
  }

  async recordObjectiveUsage(deltaUsd: number): Promise<TowerObjective | undefined> {
    if (!Number.isFinite(deltaUsd) || deltaUsd < 0) {
      throw new TowerProtocolError(`objective usage must be a non-negative cost in USD, got ${String(deltaUsd)}`);
    }
    return this.withStateLock(async () => {
      const state = await this.load();
      const objective = state.objective;
      if (objective === undefined || deltaUsd === 0 || isTerminalObjectiveStatus(objective.status)) {
        return objective;
      }
      objective.usage = { costUsd: (objective.usage?.costUsd ?? 0) + deltaUsd };
      await this.save(state);
      return objective;
    });
  }

  async updateObjectiveAutopilot(
    patch: TowerObjectiveAutopilotPatch,
  ): Promise<TowerObjectiveAutopilotState> {
    return this.withStateLock(async () => {
      const state = await this.load();
      const autopilot = applyAutopilotPatch(this.requireObjective(state), patch);
      await this.save(state);
      return autopilot;
    });
  }

  async setObjectiveMode(mode: TowerObjectiveMode): Promise<void> {
    if (!TOWER_OBJECTIVE_MODES.includes(mode)) {
      throw new TowerProtocolError(
        `objective mode must be ${TOWER_OBJECTIVE_MODES.join(' | ')}, got "${String(mode)}"`,
      );
    }
    await this.withStateLock(async () => {
      const state = await this.load();
      const objective = state.objective;
      if (!canPlanObjective(objective)) {
        throw new TowerProtocolError(
          `objective ${objective!.id} is ${objective!.status} — the objective mode is chosen while an objective is planned, so it changes only when no objective is open or the open one is still planning`,
        );
      }
      if (state.objectiveMode === mode) return;
      const from = state.objectiveMode;
      state.objectiveMode = mode;
      await this.save(state);
      await this.appendLog(TOWER_NAME, 'objective.mode', { mode, from });
    });
  }

  private async resolveCommit(commit: string): Promise<string> {
    try {
      return await git(this.repoRoot, ['rev-parse', '--verify', '--quiet', `${commit.trim()}^{commit}`]);
    } catch {
      throw new TowerProtocolError(`"${commit}" does not name a commit in this repository`);
    }
  }

  private requireExecutingObjective(state: TowerState, action: string): TowerObjective {
    const objective = this.requireObjective(state);
    if (objective.status !== 'executing') {
      throw new TowerProtocolError(
        `objective ${objective.id} is ${objective.status} — cannot ${action} unless it is executing`,
      );
    }
    return objective;
  }

  private requireObjective(state: TowerState): TowerObjective {
    if (state.objective === undefined) {
      throw new TowerProtocolError('there is no objective — draft one first');
    }
    return state.objective;
  }

  private assertApprovable(state: TowerState, objective: TowerObjective, action: string): void {
    const problems = objectiveApprovalProblems(state, objective);
    if (problems.length > 0) {
      throw new TowerProtocolError(`objective ${objective.id} cannot ${action} — ${problems.join('; ')}`);
    }
  }

  private activateCurrentMilestoneLocked(
    objective: TowerObjective,
    now: string,
  ): TowerMilestone | undefined {
    const milestone = currentMilestone(objective);
    if (milestone?.status !== 'pending') return undefined;
    milestone.status = 'active';
    milestone.startedAt = now;
    return milestone;
  }

  private async saveObjective(
    state: TowerState,
    action: string,
    details: Readonly<Record<string, string | number | undefined>>,
  ): Promise<void> {
    await this.save(state);
    await this.renderMissionsIndex(state);
    await this.appendLog(TOWER_NAME, action, details, MISSIONS_INDEX);
  }

  /**
   * Wave 2 must pass the configured objective settings (skipScrutiny, skipUserTesting) whenever an
   * objective exists: they decide whether a passed final milestone still holds or may take a fix.
   * The default `{}` requires every kind.
   */
  async plan(
    input: readonly TowerPlanInput[],
    settings: TowerValidationSettings = {},
  ): Promise<readonly TowerMission[]> {
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
      const baseTip =
        state.objective !== undefined && input.some((item) => item.milestone !== undefined)
          ? await branchTip(this.repoRoot, state.base)
          : undefined;
      const placements = input.map((item) => planPlacement(state, item, { baseTip, settings }));

      const missions: TowerMission[] = input.map((item, index) => {
        const n = startIndex + index + 1;
        const slug = slugify(item.title, 40);
        const placement = placements[index]!;
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
          ...(placement.milestone === undefined
            ? {}
            : { milestone: placement.milestone.id, origin: placement.origin }),
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
      const orderOf = milestoneOrderOf(state);
      const everyMission = new Map([...state.missions, ...missions].map((m): [string, TowerMission] => [m.id, m]));
      for (const mission of missions) {
        const own = orderOf(mission);
        if (own === undefined) continue;
        for (const dep of mission.deps) {
          const target = everyMission.get(dep)!;
          const theirs = orderOf(target);
          if (theirs === undefined || theirs <= own) continue;
          throw new TowerProtocolError(
            `mission ${mission.id} (milestone ${mission.milestone ?? '?'}) cannot depend on ${dep} — ${dep} belongs to the later milestone ${target.milestone ?? '?'}, whose features start only after ${mission.milestone ?? '?'} passes, so the dependency could never be met; drop it, milestone order already runs ${mission.milestone ?? '?'} first`,
          );
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
        addAutoDeps(mission, older, byId, orderOf);
      }
      this.assertScopesDisjoint([...openExisting, ...missions], orderOf);

      const reactivated = new Set<string>();
      for (const placement of placements) {
        if (placement.milestone === undefined || !placement.reopens) continue;
        placement.milestone.status = 'active';
        delete placement.milestone.passedAt;
        reactivated.add(placement.milestone.id);
      }
      const milestones = new Set(missions.flatMap((m) => (m.milestone === undefined ? [] : [m.milestone])));
      state.missions.push(...missions);
      await this.save(state);
      await this.renderMissionsIndex(state);
      for (const mission of missions) {
        await this.renderMissionFile(mission);
      }
      await this.appendLog(
        TOWER_NAME,
        'plan',
        {
          missions: missions.map((m) => m.id).join(','),
          milestones: milestones.size > 0 ? [...milestones].join(',') : undefined,
          reactivated: reactivated.size > 0 ? [...reactivated].join(',') : undefined,
        },
        MISSIONS_INDEX,
      );
      return missions;
    });
  }

  private assertScopesDisjoint(
    missions: readonly TowerMission[],
    orderOf: TowerMilestoneOrderOf = () => undefined,
  ): void {
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
        const orderA = orderOf(byId.get(a.id)!);
        const orderB = orderOf(byId.get(b.id)!);
        if (orderA !== undefined && orderB !== undefined && orderA !== orderB) continue;
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
      const orderOf = milestoneOrderOf(state);
      addAutoDeps(patched, others, byId, orderOf);
      this.assertScopesDisjoint([...others, patched], orderOf);
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
    options: { readonly allowSelf?: boolean } = {},
  ): Promise<TowerSendResult> {
    const to = input.to.trim();
    if (to !== TOWER_NAME && to !== BROADCAST_NAME && this.findAgent(state, to) === undefined) {
      const known = [TOWER_NAME, BROADCAST_NAME, ...state.roster.agents.map((a) => a.name)];
      throw new TowerProtocolError(
        `unknown recipient "${to}" — address a roster agent, ${TOWER_NAME}, or ${BROADCAST_NAME} (known: ${known.join(', ')})`,
      );
    }
    if (to === callerName && options.allowSelf !== true) {
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

  async submitReview(callerName: string, input: TowerReviewInput): Promise<TowerReviewResult> {
    return this.runPrepared(
      async () => {
        const snapshot = await this.loadSnapshot();
        this.assertReviewSubmission(callerName, input, snapshot.state);
        const reviewFiles = await this.reviewFileNames();
        const existing = await this.reviewsFor(input.target);
        const nextReviewSeq = await this.nextReviewSeq();
        const reviewedCommit = await branchTip(this.repoRoot, input.target);
        const inbox = await this.listInboxSnapshot();
        const options: TowerReviewLockedOptions = {
          existing,
          nextReviewSeq,
          reviewedCommit,
          inboxItems: inbox.items,
          activityLogRefs: new Map(),
        };
        await this.submitReviewLocked(callerName, input, structuredClone(snapshot.state), {
          ...options,
          validateOnly: true,
        });
        return { snapshot, reviewFiles, inboxFiles: inbox.files, options };
      },
      (prepared) =>
        this.withStateLock(async () => {
          const state = await this.assertPreparationCurrent(
            prepared.snapshot,
            prepared.inboxFiles,
            prepared.reviewFiles,
          );
          if ((await branchTip(this.repoRoot, input.target)) !== prepared.options.reviewedCommit) {
            throw new TowerPreparationConflict();
          }
          return this.submitReviewLocked(callerName, input, state, prepared.options);
        }),
    );
  }

  private assertReviewSubmission(
    callerName: string,
    input: TowerReviewInput,
    state: TowerState,
  ): TowerRosterEntry | undefined {
    let callerEntry: TowerRosterEntry | undefined;
    if (callerName !== TOWER_NAME) {
      callerEntry = this.findAgent(state, callerName);
      if (callerEntry?.kind !== 'reviewer' || callerEntry.reviewTarget !== input.target) {
        throw new TowerProtocolError(
          `agent "${callerName}" is not an assigned reviewer for "${input.target}"`,
        );
      }
    }
    if (!/^(clean|p[12]-\d+items)$/.test(input.status)) {
      throw new TowerProtocolError(
        `review status must be clean | p1-Nitems | p2-Nitems, got "${input.status}"`,
      );
    }
    if (!['merge', 'fix-then-merge', 'hold'].includes(input.merge)) {
      throw new TowerProtocolError(
        `review merge verdict must be merge | fix-then-merge | hold, got "${input.merge}"`,
      );
    }
    return callerEntry;
  }

  private async submitReviewLocked(
    callerName: string,
    input: TowerReviewInput,
    state: TowerState,
    options: TowerReviewLockedOptions,
  ): Promise<TowerReviewResult> {
    const callerEntry = this.assertReviewSubmission(callerName, input, state);
    const existing = options.existing;
    const reviewedCommit = options.reviewedCommit;
    const reviewMissionId =
      callerEntry === undefined
        ? resolveMissionByBranch(state, input.target)?.id
        : callerEntry.reviewMissionId;
    const reviewMission =
      reviewMissionId !== undefined
        ? state.missions.find((mission) => mission.id === reviewMissionId)
        : resolveMissionByBranch(state, input.target);
    const activityLogErrors: string[] = [];
    let review = await this.findReviewRecovery(
      state,
      callerName,
      input,
      existing,
      reviewedCommit,
      reviewMission,
      options.inboxItems,
      options.activityLogRefs,
    );
    const myRounds = existing.filter((candidate) => candidate.reviewer === callerName).length;
    if (review === undefined && myRounds >= MAX_REVIEW_ROUNDS) {
      throw new TowerProtocolError(
        `branch "${input.target}" has already been through ${String(MAX_REVIEW_ROUNDS)} review rounds by "${callerName}" — the rework loop is not converging, so another round from the same reviewer is refused; redirect instead: reassign the work (spawn a different worker or a fresh reviewer), split the mission into smaller pieces, or descope it (TowerMission status=abandoned)`,
      );
    }
    if (options.validateOnly === true) {
      if (review === undefined) {
        const round = myRounds + 1;
        review = {
          reviewer: callerName,
          target: input.target,
          round,
          status: input.status,
          merge: input.merge,
          reviewedCommit,
          date: dateDash(),
          file: join(REVIEWS_DIR, reviewFileName({ target: input.target, reviewer: callerName, round })),
          mtimeMs: 0,
          seq: options.nextReviewSeq,
          mission: reviewMissionId,
        };
      }
      await this.storeReviewMessages(
        state,
        callerName,
        input,
        review,
        reviewMission,
        activityLogErrors,
        options.inboxItems,
        options.activityLogRefs,
        true,
      );
      return { review, storedMessages: [] };
    }
    if (
      review !== undefined &&
      !(await this.hasCachedActivityLogRef('review.write', review.file, options.activityLogRefs))
    ) {
      try {
        await this.appendLog(
          callerName,
          'review.write',
          {
            target: input.target,
            round: review.round,
            verdict: review.status,
            reviewed: review.reviewedCommit.slice(0, 7),
          },
          review.file,
        );
      } catch (error) {
        activityLogErrors.push(
          `review ${review.file} was stored, but appending its review.write activity log failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (review === undefined) {
      const round = myRounds + 1;
      const seq = options.nextReviewSeq;
      const date = dateDash();
      const frontmatter = renderFrontmatter({
        date,
        reviewer: callerName,
        target: input.target,
        round: String(round),
        seq: String(seq),
        status: input.status,
        merge: input.merge,
        reviewed_commit: reviewedCommit,
        mission: reviewMissionId,
      });
      const content = `${frontmatter}\n\n${reviewDocumentBody(input)}\n`;
      const rel = await this.writeUnique(
        join(REVIEWS_DIR, reviewFileName({ target: input.target, reviewer: callerName, round })),
        content,
      );
      review = {
        reviewer: callerName,
        target: input.target,
        round,
        status: input.status,
        merge: input.merge,
        reviewedCommit,
        date,
        file: rel,
        mtimeMs: (await stat(this.abs(rel))).mtimeMs,
        seq,
        mission: reviewMissionId,
      };
      try {
        await this.appendLog(
          callerName,
          'review.write',
          {
            target: input.target,
            round,
            verdict: input.status,
            reviewed: reviewedCommit.slice(0, 7),
          },
          rel,
        );
      } catch (error) {
        activityLogErrors.push(
          `review ${rel} was stored, but appending its review.write activity log failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (input.status !== 'clean' && reviewMission?.status === 'completed') {
      reviewMission.status = 'active';
      await this.save(state);
      await this.renderMissionsIndex(state);
      await this.renderMissionFile(reviewMission);
      try {
        await this.appendLog(
          callerName,
          'mission.rework',
          { id: reviewMission.id, verdict: input.status },
          join(MISSIONS_DIR, missionFileName(reviewMission.id, reviewMission.slug)),
        );
      } catch (error) {
        activityLogErrors.push(
          `mission ${reviewMission.id} was marked active, but appending mission.rework activity log failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const { storedMessages, notificationErrors } = await this.storeReviewMessages(
      state,
      callerName,
      input,
      review,
      reviewMission,
      activityLogErrors,
      options.inboxItems,
      options.activityLogRefs,
    );
    return {
      review,
      storedMessages,
      notificationError:
        notificationErrors.length > 0
          ? `review ${review.file} was stored, but storing review-result notification(s) failed: ${notificationErrors.join(' | ')}`
          : undefined,
      activityLogError:
        activityLogErrors.length > 0 ? activityLogErrors.join(' | ') : undefined,
    };
  }

  private async findReviewRecovery(
    state: TowerState,
    callerName: string,
    input: TowerReviewInput,
    existing: readonly TowerReviewInfo[],
    reviewedCommit: string,
    reviewMission: TowerMission | undefined,
    inboxItems: readonly TowerInboxItem[],
    activityLogRefs: Map<string, boolean>,
  ): Promise<TowerReviewInfo | undefined> {
    const expectedBody = reviewDocumentBody(input);
    const recipients = this.reviewRecipients(state, callerName, input, reviewMission);
    for (const candidate of existing.toReversed()) {
      if (
        candidate.reviewer !== callerName ||
        candidate.reviewedCommit !== reviewedCommit ||
        candidate.status !== input.status ||
        candidate.merge !== input.merge
      ) {
        continue;
      }
      const { body } = parseFrontmatter(await readFile(this.abs(candidate.file), 'utf8'));
      if (body !== expectedBody) continue;
      if (!(await this.hasCachedActivityLogRef('review.write', candidate.file, activityLogRefs))) {
        return candidate;
      }
      let needsRecovery = false;
      for (const recipient of recipients) {
        const message = inboxItems.find((item) =>
          this.isReviewResultMessage(item, callerName, recipient, candidate, reviewMission, input),
        );
        if (
          message === undefined ||
          !(await this.hasCachedActivityLogRef('inbox.send', message.file, activityLogRefs))
        ) {
          needsRecovery = true;
          break;
        }
      }
      if (needsRecovery) return candidate;
      return undefined;
    }
    return undefined;
  }

  private async storeReviewMessages(
    state: TowerState,
    callerName: string,
    input: TowerReviewInput,
    review: TowerReviewInfo,
    reviewMission: TowerMission | undefined,
    activityLogErrors: string[],
    inboxItems: readonly TowerInboxItem[],
    activityLogRefs: Map<string, boolean>,
    validateOnly = false,
  ): Promise<{
    readonly storedMessages: readonly TowerSendResult[];
    readonly notificationErrors: readonly string[];
  }> {
    const recipients = this.reviewRecipients(state, callerName, input, reviewMission);
    const body = this.reviewNotificationBody(review, reviewMission, input);
    const storedMessages: TowerSendResult[] = [];
    const notificationErrors: string[] = [];
    for (const recipient of recipients) {
      const existing = inboxItems.find((item) =>
        this.isReviewResultMessage(item, callerName, recipient, review, reviewMission, input),
      );
      if (existing !== undefined) {
        storedMessages.push({
          item: existing,
          missionId: reviewMission?.id ?? review.mission,
        });
        const logPresent = await this.hasCachedActivityLogRef(
          'inbox.send',
          existing.file,
          activityLogRefs,
        );
        if (validateOnly) continue;
        if (!logPresent) {
          try {
            await this.appendLog(
              callerName,
              'inbox.send',
              { to: recipient, subject: slugify('review-result') },
              existing.file,
            );
          } catch (error) {
            activityLogErrors.push(
              `inbox message ${existing.file} was stored, but appending its inbox.send activity log failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        continue;
      }
      if (validateOnly) continue;
      try {
        const sent = await this.sendDetailedSnapshot(
          callerName,
          {
            to: recipient,
            subject: 'review-result',
            body,
            scope: reviewMission?.id ?? review.mission,
            action: 'review-result',
          },
          state,
        );
        storedMessages.push(sent);
        if (sent.activityLogError !== undefined) activityLogErrors.push(sent.activityLogError);
      } catch (error) {
        notificationErrors.push(
          `${recipient}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { storedMessages, notificationErrors };
  }

  private reviewRecipients(
    state: TowerState,
    callerName: string,
    input: TowerReviewInput,
    reviewMission: TowerMission | undefined,
  ): readonly string[] {
    const owner =
      reviewMission !== undefined && isOpenMission(reviewMission) && reviewMission.owner !== undefined
        ? state.roster.agents.find(
            (agent) =>
              agent.name === reviewMission.owner &&
              agent.kind === 'worker' &&
              agent.missionId === reviewMission.id &&
              agent.diedAt === undefined,
          )
        : undefined;
    const recipients: string[] = [];
    if (input.status !== 'clean' && owner !== undefined && owner.name !== callerName) {
      recipients.push(owner.name);
    }
    if (callerName !== TOWER_NAME) recipients.push(TOWER_NAME);
    return recipients;
  }

  private reviewNotificationBody(
    review: TowerReviewInfo,
    reviewMission: TowerMission | undefined,
    input: TowerReviewInput,
  ): string {
    return [
      `file: ${review.file}`,
      `target: ${review.target}`,
      `mission: ${reviewMission?.id ?? review.mission ?? '(none)'}`,
      `round: ${String(review.round)}`,
      `verdict: ${input.status}`,
      `merge recommendation: ${input.merge}`,
      `reviewedCommit: ${review.reviewedCommit}`,
      `owner: ${reviewMission?.owner ?? '(none)'}`,
    ].join('\n');
  }

  private isReviewResultMessage(
    item: TowerInboxItem,
    callerName: string,
    recipient: string,
    review: TowerReviewInfo,
    reviewMission: TowerMission | undefined,
    input: TowerReviewInput,
  ): boolean {
    return (
      item.from === callerName &&
      item.to === recipient &&
      item.subject === 'review-result' &&
      item.scope === (reviewMission?.id ?? review.mission) &&
      item.action === 'review-result' &&
      item.body === this.reviewNotificationBody(review, reviewMission, input)
    );
  }

  private async hasActivityLogRef(action: string, rel: string): Promise<boolean> {
    const handle = await open(this.abs(ACTIVITY_LOG), 'r').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      },
    );
    if (handle === undefined) return false;
    try {
      const { size } = await handle.stat();
      const actionNeedle = Buffer.from(` ${action} `);
      const refNeedle = Buffer.from(`ref=${rel}`);
      const matches = (line: Buffer): boolean =>
        line.includes(actionNeedle) &&
        line.length >= refNeedle.length &&
        line.subarray(line.length - refNeedle.length).equals(refNeedle);
      let remainder = Buffer.alloc(0);
      let end = size;
      while (end > 0) {
        const start = Math.max(0, end - 16 * 1024);
        const buffer = Buffer.allocUnsafe(end - start);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
        const content = Buffer.concat([buffer.subarray(0, bytesRead), remainder]);
        let lineEnd = content.length;
        for (;;) {
          const newline = lineEnd === 0 ? -1 : content.lastIndexOf(0x0a, lineEnd - 1);
          if (newline === -1) {
            if (start === 0 && matches(content.subarray(0, lineEnd))) return true;
            remainder = Buffer.from(content.subarray(0, lineEnd));
            break;
          }
          if (matches(content.subarray(newline + 1, lineEnd))) return true;
          lineEnd = newline;
        }
        end = start;
      }
      return false;
    } finally {
      await handle.close();
    }
  }

  private async hasCachedActivityLogRef(
    action: string,
    rel: string,
    cache: Map<string, boolean>,
  ): Promise<boolean> {
    const key = `${action}\0${rel}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const present = await this.hasActivityLogRef(action, rel);
    cache.set(key, present);
    return present;
  }

  async reviewsFor(target: string): Promise<readonly TowerReviewInfo[]> {
    let files: string[];
    try {
      files = await readdir(this.abs(REVIEWS_DIR));
    } catch {
      return [];
    }
    const prefix = `review-${targetSlug(target)}-`;
    const candidates = files.filter((file) => file.startsWith(prefix) && file.endsWith('.md'));
    const loaded = await mapWithConcurrency(
      candidates,
      TOWER_FILE_IO_CONCURRENCY,
      async (file): Promise<TowerReviewInfo | undefined> => {
        const rel = join(REVIEWS_DIR, file);
        let text: string;
        try {
          text = await readFrontmatterPrefix(this.abs(rel));
        } catch {
          return undefined;
        }
        const { fields } = parseFrontmatter(text);
        const round = Number.parseInt(fields['round'] ?? '', 10);
        if (Number.isNaN(round)) return undefined;
        const seq = Number.parseInt(fields['seq'] ?? '', 10);
        const { mtimeMs } = await stat(this.abs(rel));
        return {
          reviewer: fields['reviewer'] ?? 'unknown',
          target: fields['target'] ?? target,
          round,
          status: fields['status'] ?? '',
          merge: fields['merge'] ?? '',
          reviewedCommit: fields['reviewed_commit'] ?? '',
          date: fields['date'] ?? '',
          file: rel,
          mtimeMs,
          seq: Number.isNaN(seq) ? undefined : seq,
          mission: fields['mission'],
        };
      },
    );
    const reviews = loaded.filter((review): review is TowerReviewInfo => review !== undefined);
    reviews.sort(
      (a, b) =>
        (a.seq ?? -1) - (b.seq ?? -1) ||
        a.mtimeMs - b.mtimeMs ||
        a.round - b.round ||
        a.file.localeCompare(b.file),
    );
    return reviews;
  }

  async latestReview(target: string): Promise<TowerReviewInfo | undefined> {
    const reviews = await this.reviewsFor(target);
    return reviews.at(-1);
  }

  private async reviewFileNames(): Promise<readonly string[]> {
    try {
      return (await readdir(this.abs(REVIEWS_DIR)))
        .filter((file) => file.startsWith('review-') && file.endsWith('.md'))
        .toSorted();
    } catch {
      return [];
    }
  }

  private async nextReviewSeq(): Promise<number> {
    const candidates = await this.reviewFileNames();
    const sequences = await mapWithConcurrency(
      candidates,
      TOWER_FILE_IO_CONCURRENCY,
      async (file): Promise<number | undefined> => {
        let text: string;
        try {
          text = await readFrontmatterPrefix(this.abs(join(REVIEWS_DIR, file)));
        } catch {
          return undefined;
        }
        const seq = Number.parseInt(parseFrontmatter(text).fields['seq'] ?? '', 10);
        return Number.isNaN(seq) ? undefined : seq;
      },
    );
    let max = 0;
    for (const seq of sequences) {
      if (seq !== undefined && seq > max) max = seq;
    }
    return max + 1;
  }

  async merge(
    branch: string,
    runtime: TowerMissionRuntimeOptions = {},
  ): Promise<TowerMergeResult> {
    return this.withStateLock(async () => {
      const state = await this.load();
      const block = async (reason: string, message: string): Promise<TowerProtocolError> => {
        await this.appendLog(TOWER_NAME, 'merge.blocked', { branch, reason });
        return new TowerProtocolError(message);
      };
      const mission = resolveMissionByBranch(state, branch);
      if (mission === undefined) {
        const closed = state.missions.filter((candidate) => candidate.branch === branch);
        if (closed.length > 0) {
          throw await block(
            'branch-owned-by-closed-missions',
            `merge blocked: branch "${branch}" resolves only to closed mission(s) ${closed.map((candidate) => `${candidate.id} (${candidate.status})`).join(', ')} — TowerMerge never flips a closed mission's status; re-plan the work under a new title if it should land`,
          );
        }
        throw new TowerProtocolError(`no tower mission owns branch "${branch}"`);
      }

      const gate = await this.missionGate(state, mission, runtime);
      if (!gate.ready) {
        const primary = gate.blocks[0]!;
        throw await block(primary.reason, primary.message);
      }
      const observation = gate.observations.branch!;
      const evaluatedBranchTip = observation.tip;

      if (gate.noop) {
        const currentBranchTip = await branchTip(this.repoRoot, branch);
        if (currentBranchTip !== evaluatedBranchTip) {
          await this.appendLog(TOWER_NAME, 'merge.advanced', {
            branch,
            evaluated: evaluatedBranchTip.slice(0, 7),
            current: currentBranchTip.slice(0, 7),
          });
          return {
            status: 'advanced',
            mergeCommit: gate.observations.headTip,
            evaluatedBranchTip,
            currentBranchTip,
            conflictsWith: [],
            noop: true,
          };
        }
        mission.status = 'merged';
        await this.save(state);
        await this.renderMissionsIndex(state);
        await this.renderMissionFile(mission);
        await this.appendLog(TOWER_NAME, 'merge.noop', { branch, kind: 'survey' });
        return {
          status: 'noop',
          mergeCommit: gate.observations.headTip,
          evaluatedBranchTip,
          currentBranchTip,
          conflictsWith: [],
          noop: true,
        };
      }

      const mergeCommit = await mergeNoFf(
        this.repoRoot,
        evaluatedBranchTip,
        `Merge branch '${branch}'`,
      );
      const headTip = await branchTip(this.repoRoot, 'HEAD');
      if (!(await isAncestor(this.repoRoot, evaluatedBranchTip, headTip))) {
        throw new TowerProtocolError(
          `recovery-required: merge of ${branch} returned but HEAD ${headTip} does not contain the evaluated commit ${evaluatedBranchTip} — mission ${mission.id} was not marked merged; inspect the base checkout before retrying`,
        );
      }
      const currentBranchTip = await branchTip(this.repoRoot, branch);
      if (currentBranchTip !== evaluatedBranchTip) {
        await this.appendLog(TOWER_NAME, 'merge.advanced', {
          branch,
          evaluated: evaluatedBranchTip.slice(0, 7),
          current: currentBranchTip.slice(0, 7),
          merge_commit: mergeCommit.slice(0, 7),
        });
        return {
          status: 'advanced',
          mergeCommit,
          evaluatedBranchTip,
          currentBranchTip,
          conflictsWith: [],
        };
      }

      const changedSet = new Set(observation.changedFiles);
      const otherMissions = state.missions.filter(
        (other) => other.branch !== branch && isOpenMission(other),
      );
      const conflicts = await mapWithConcurrency(
        otherMissions,
        TOWER_GIT_CONCURRENCY,
        async (
          other,
        ): Promise<{ readonly branch: string; readonly files: readonly string[] } | undefined> => {
          if (!(await branchExists(this.repoRoot, other.branch))) return undefined;
          const otherChanged = await diffNameOnly(
            this.repoRoot,
            await this.diffBase(state, other),
            other.branch,
          );
          const overlap = otherChanged.filter((file) => changedSet.has(file));
          return overlap.length > 0 ? { branch: other.branch, files: overlap } : undefined;
        },
      );
      const conflictsWith = conflicts.filter(
        (conflict): conflict is { readonly branch: string; readonly files: readonly string[] } =>
          conflict !== undefined,
      );

      mission.status = 'merged';
      await this.save(state);
      await this.renderMissionsIndex(state);
      await this.renderMissionFile(mission);
      await this.appendLog(TOWER_NAME, 'merge', {
        branch,
        base: state.base,
        merge_commit: mergeCommit.slice(0, 7),
        review_waived: gate.reviewBinding === 'clean-rebase-waived' ? 'yes' : undefined,
      });
      return {
        status: 'merged',
        mergeCommit,
        evaluatedBranchTip,
        currentBranchTip,
        conflictsWith,
      };
    });
  }

  async missionGate(
    state: TowerState,
    mission: TowerMission,
    runtime: TowerMissionRuntimeOptions = {},
  ): Promise<TowerMissionGateResult> {
    const [reviews, observations] = await Promise.all([
      this.reviewsFor(mission.branch),
      this.observeMissionGit(state, mission),
    ]);
    const activeAgentIds =
      typeof runtime.activeAgentIds === 'function'
        ? runtime.activeAgentIds()
        : runtime.activeAgentIds;
    const workers = state.roster.agents
      .filter(
        (agent) =>
          agent.kind === 'worker' &&
          (agent.missionId === mission.id ||
            agent.branch === mission.branch ||
            agent.worktree === mission.worktree),
      )
      .map((agent) => ({
        agentId: agent.agentId,
        name: agent.name,
        status:
          activeAgentIds === undefined
            ? ('unknown' as const)
            : activeAgentIds.has(agent.agentId)
              ? ('busy' as const)
              : ('idle' as const),
      }));
    return evaluateMissionGate({ state, mission, reviews, workers, observations });
  }

  private async observeMissionGit(
    state: TowerState,
    mission: TowerMission,
  ): Promise<TowerMissionGitObservations> {
    const checkedOutBranch = async (): Promise<string | undefined> => {
      try {
        return await currentBranch(this.repoRoot);
      } catch (error) {
        if (error instanceof GitError) throw error;
        return undefined;
      }
    };
    const [baseTip, headTip, checkout, dirtyEntries, hasBranch] = await Promise.all([
      branchTip(this.repoRoot, state.base),
      branchTip(this.repoRoot, 'HEAD'),
      checkedOutBranch(),
      listBaseDirtyEntries(this.repoRoot),
      branchExists(this.repoRoot, mission.branch),
    ]);
    const baseDirtyFiles = dirtyEntries.map((entry) => entry.path);
    if (!hasBranch) return { baseTip, headTip, checkedOutBranch: checkout, baseDirtyFiles };
    const tip = await branchTip(this.repoRoot, mission.branch);
    const [baseIsAncestor, spawnBaseIsAncestor] = await Promise.all([
      isAncestor(this.repoRoot, baseTip, tip),
      mission.spawnBase === undefined
        ? Promise.resolve(false)
        : isAncestor(this.repoRoot, mission.spawnBase, tip),
    ]);
    const diffBase = spawnBaseIsAncestor ? mission.spawnBase! : baseTip;
    const [changedFiles, mergeTouchedFiles] = await Promise.all([
      diffNameOnly(this.repoRoot, diffBase, tip),
      diffNameOnly(this.repoRoot, headTip, tip),
    ]);
    return {
      baseTip,
      headTip,
      checkedOutBranch: checkout,
      baseDirtyFiles,
      branch: { tip, baseIsAncestor, diffBase, changedFiles, mergeTouchedFiles },
    };
  }

  async rebaseMission(
    callerName: string,
    id: string,
    runtime: TowerMissionRuntimeOptions = {},
  ): Promise<TowerRebaseMissionResult> {
    return this.withStateLock(async () => {
      if (callerName !== TOWER_NAME) {
        throw new TowerProtocolError(
          `agent "${callerName}" cannot rebase a mission branch — only the tower runs TowerRebase; a worker rebases only when the tower asks it to`,
        );
      }
      const state = await this.load();
      const mission = state.missions.find((candidate) => candidate.id === id);
      if (mission === undefined) {
        throw new TowerProtocolError(`unknown mission "${id}"`);
      }
      if (!isOpenMission(mission)) {
        throw new TowerProtocolError(
          `mission ${id} is ${mission.status} — only open missions rebase; closed missions are historical records`,
        );
      }
      if (mission.kind === 'survey') {
        throw new TowerProtocolError(
          `mission ${id} is a read-only survey — it has no work branch to rebase`,
        );
      }
      const activeAgentIds =
        typeof runtime.activeAgentIds === 'function'
          ? runtime.activeAgentIds()
          : runtime.activeAgentIds;
      const workers = state.roster.agents.filter(
        (agent) =>
          agent.kind === 'worker' &&
          (agent.missionId === mission.id ||
            agent.branch === mission.branch ||
            agent.worktree === mission.worktree),
      );
      const busyWorkers = workers.filter(
        (worker) => activeAgentIds?.has(worker.agentId) === true,
      );
      if (busyWorkers.length > 0) {
        throw new TowerProtocolError(
          `worker(s) ${busyWorkers.map((worker) => worker.name).join(', ')} are mid-turn — rebasing under a running worker could race its edits; TowerSend a message asking for a worker-run rebase, or retry once every worker is idle`,
        );
      }
      if (activeAgentIds === undefined && workers.length > 0) {
        throw new TowerProtocolError(
          `worker runtime for ${workers.map((worker) => worker.name).join(', ')} cannot be observed authoritatively — unknown is not idle; retry TowerRebase from the main tower agent`,
        );
      }
      if (!(await branchExists(this.repoRoot, mission.branch))) {
        throw new TowerProtocolError(
          `mission ${id} has no branch "${mission.branch}" yet — spawn a worker to create it before rebasing`,
        );
      }
      const worktreeAbs = this.abs(join(WORKTREES_DIR, mission.worktree));
      if (!(await isRegisteredWorktree(this.repoRoot, worktreeAbs))) {
        throw new TowerProtocolError(
          `mission ${id} has no registered worktree at ${join(WORKTREES_DIR, mission.worktree)} — spawn a worker to create it before rebasing`,
        );
      }
      if (await isWorktreeDirty(worktreeAbs)) {
        throw new TowerProtocolError(
          `worktree ${mission.worktree} has uncommitted changes — rebasing under uncommitted work could lose it; have the worker commit or stash first, then retry`,
        );
      }
      const gitDir = resolve(worktreeAbs, (await git(worktreeAbs, ['rev-parse', '--git-dir'])).trim());
      if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) {
        throw new TowerProtocolError(
          `worktree ${mission.worktree} already has a rebase in progress — finish or abort it (git rebase --continue / --abort in the worktree) before the tower rebases the branch`,
        );
      }
      const baseCommit = await branchTip(this.repoRoot, state.base);
      const fromCommit = await branchTip(this.repoRoot, mission.branch);
      const checkedOut = await git(worktreeAbs, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (checkedOut !== mission.branch) {
        throw new TowerProtocolError(
          `worktree ${mission.worktree} is on "${checkedOut}", not mission branch "${mission.branch}" — restore the registered checkout before rebasing; nothing was changed`,
        );
      }
      const worktreeHead = await branchTip(worktreeAbs, 'HEAD');
      if (worktreeHead !== fromCommit) {
        throw new TowerProtocolError(
          `worktree ${mission.worktree} HEAD ${worktreeHead} does not match mission branch "${mission.branch}" at ${fromCommit} — repair the diverged checkout before rebasing; nothing was changed`,
        );
      }
      if (await isAncestor(this.repoRoot, baseCommit, fromCommit)) {
        await this.appendLog(TOWER_NAME, 'rebase.mission', { id, result: 'up-to-date' });
        return { status: 'up-to-date' };
      }

      let rebaseErrorMessage: string | undefined;
      try {
        await git(worktreeAbs, ['rebase', baseCommit]);
      } catch (error) {
        rebaseErrorMessage = error instanceof Error ? error.message : 'non-Error thrown value';
      }
      if (rebaseErrorMessage !== undefined) {
        let conflicted: string;
        let inProgress: boolean;
        try {
          conflicted = await git(worktreeAbs, ['diff', '--name-only', '--diff-filter=U']);
          inProgress =
            existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'));
        } catch (error) {
          throw new TowerProtocolError(
            `recovery-required: rebase of mission ${id} failed and its state could not be inspected: ${error instanceof Error ? error.message : String(error)} — no waiver was recorded and the mission was not marked blocked`,
          );
        }
        const files = conflicted.split('\n').filter((file) => file.trim().length > 0);
        if (inProgress) {
          try {
            await git(worktreeAbs, ['rebase', '--abort']);
          } catch (error) {
            throw new TowerProtocolError(
              `recovery-required: rebase of mission ${id} failed and git rebase --abort also failed: ${error instanceof Error ? error.message : String(error)} — no recovery is claimed, no waiver was recorded, and the mission was not marked blocked`,
            );
          }
        }
        await this.assertRebaseRecovered(worktreeAbs, gitDir, mission, fromCommit);
        if (inProgress && files.length > 0) {
          mission.blockers.push(
            `tower rebase onto ${state.base} conflicted in: ${files.join(', ')} — the rebase was aborted and your worktree is back to the pre-rebase state. Resolve it yourself: run \`git rebase ${state.base}\` in your worktree, fix the listed conflicts, \`git add\` the resolved files, then continue with \`GIT_EDITOR=true git rebase --continue\` (a plain \`git rebase --continue\` opens an editor and hangs a non-interactive shell). Re-run your tests, then clear this blocker (TowerMission clear_blockers) and finish with TowerComplete, which requests the fresh review — a worker-run rebase is not covered by the clean-rebase waiver, so the moved tip needs a new clean review before the merge can land`,
          );
          mission.status = 'blocked';
          await this.save(state);
          await this.renderMissionsIndex(state);
          await this.renderMissionFile(mission);
          await this.appendLog(TOWER_NAME, 'rebase.mission', {
            id,
            result: 'conflict',
            files: files.join(','),
          });
          return { status: 'conflict', fromCommit, files };
        }
        throw new TowerProtocolError(
          `rebase of mission ${id} failed: ${rebaseErrorMessage} — no rebase conflict with unmerged paths was observed, so the mission was not marked blocked and no review waiver was recorded`,
        );
      }

      let toCommit: string;
      const problems: string[] = [];
      try {
        toCommit = await branchTip(this.repoRoot, mission.branch);
        if ((await git(worktreeAbs, ['rev-parse', '--abbrev-ref', 'HEAD'])) !== mission.branch) {
          problems.push('the worktree no longer has the mission branch checked out');
        }
        if ((await branchTip(worktreeAbs, 'HEAD')) !== toCommit) {
          problems.push('worktree HEAD and the mission branch tip differ');
        }
        if (await isWorktreeDirty(worktreeAbs)) problems.push('the worktree is dirty');
        if (!(await isAncestor(this.repoRoot, baseCommit, toCommit))) {
          problems.push('the rebased branch does not contain the evaluated base commit');
        }
      } catch (error) {
        throw new TowerProtocolError(
          `recovery-required: rebase of mission ${id} returned success but its postconditions could not be inspected: ${error instanceof Error ? error.message : String(error)} — no review waiver was recorded`,
        );
      }
      if (problems.length > 0) {
        throw new TowerProtocolError(
          `recovery-required: rebase of mission ${id} returned success but its postconditions failed (${problems.join('; ')}) — no review waiver was recorded; inspect the worktree and branch before retrying`,
        );
      }
      mission.lastRebase = { fromCommit, toCommit };
      await this.save(state);
      await this.renderMissionsIndex(state);
      await this.renderMissionFile(mission);
      await this.appendLog(TOWER_NAME, 'rebase.mission', {
        id,
        result: 'clean',
        from: fromCommit.slice(0, 7),
        to: toCommit.slice(0, 7),
      });
      return { status: 'rebased', fromCommit, toCommit };
    });
  }

  private async assertRebaseRecovered(
    worktreeAbs: string,
    gitDir: string,
    mission: TowerMission,
    fromCommit: string,
  ): Promise<void> {
    const problems: string[] = [];
    if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) {
      problems.push('a rebase is still in progress');
    }
    try {
      if ((await git(worktreeAbs, ['rev-parse', '--abbrev-ref', 'HEAD'])) !== mission.branch) {
        problems.push('the mission branch is not checked out');
      }
      if ((await branchTip(worktreeAbs, 'HEAD')) !== fromCommit) {
        problems.push('worktree HEAD was not restored to the pre-rebase commit');
      }
      if ((await branchTip(this.repoRoot, mission.branch)) !== fromCommit) {
        problems.push('the mission branch tip was not restored');
      }
      if (await isWorktreeDirty(worktreeAbs)) problems.push('the worktree is not clean');
    } catch (error) {
      problems.push(`recovery inspection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (problems.length > 0) {
      throw new TowerProtocolError(
        `recovery-required: rebase recovery for mission ${mission.id} failed its postconditions (${problems.join('; ')}) — no recovery is claimed, no waiver was recorded, and the mission was not marked blocked`,
      );
    }
  }

  async diffBase(state: TowerState, mission: TowerMission): Promise<string> {
    if (
      mission.spawnBase !== undefined &&
      (await isAncestor(this.repoRoot, mission.spawnBase, mission.branch))
    ) {
      return mission.spawnBase;
    }
    return state.base;
  }

  async addWorktree(worktree: string, branch: string, base: string): Promise<TowerAddWorktreeResult> {
    const rel = join(WORKTREES_DIR, worktree);
    let spawnBase: string | undefined;
    if (await branchExists(this.repoRoot, branch)) {
      const state = await this.load();
      const mission = state.missions.find((m) => m.worktree === worktree && m.branch === branch);
      const registered = await isRegisteredWorktree(this.repoRoot, this.abs(rel));
      const checkedOut = registered
        ? await tryGit(this.abs(rel), ['rev-parse', '--abbrev-ref', 'HEAD'])
        : null;
      if (mission?.owner === undefined && checkedOut?.trim() !== branch) {
        throw new TowerProtocolError(unownedBranchMessage(branch));
      }
      await worktreeAdd(this.repoRoot, this.abs(rel), branch);
      await this.appendLog(TOWER_NAME, 'worktree.add', { worktree, branch, base, spawn_base: spawnBase });
      return { rel, spawnBase };
    }
    const dirty = await listBaseDirtyEntries(this.repoRoot);
    if (dirty.some((entry) => entry.unmerged)) {
      throw new TowerProtocolError(
        'the base checkout has unmerged paths (an in-progress merge, rebase, or cherry-pick) — finish or abort it before spawning workers',
      );
    }
    if (dirty.length > 0) {
      let checkout: string;
      try {
        checkout = await currentBranch(this.repoRoot);
      } catch {
        throw new TowerProtocolError(
          `the main checkout is in a detached HEAD state with uncommitted changes, and the recorded base is "${base}" — a WIP snapshot would carry detached-HEAD content into the mission branch; check out "${base}" (\`git checkout ${base}\`) or commit/stash the changes before spawning workers`,
        );
      }
      if (checkout !== base) {
        throw new TowerProtocolError(
          `the main checkout is on "${checkout}" with uncommitted changes, not the recorded base "${base}" — a WIP snapshot would carry "${checkout}" content into the mission branch; switch back to "${base}" (\`git checkout ${base}\`) or commit/stash the changes before spawning workers`,
        );
      }
    }
    spawnBase =
      (await snapshotBaseWip(
        this.repoRoot,
        base,
        dirty.map((entry) => entry.path),
        `tower: snapshot of uncommitted base checkout changes (worktree ${worktree})`,
      )) ?? undefined;
    try {
      await worktreeAddNewBranch(this.repoRoot, this.abs(rel), branch, spawnBase ?? base);
    } catch (error) {
      if (await branchExists(this.repoRoot, branch)) {
        throw new TowerProtocolError(unownedBranchMessage(branch));
      }
      throw error;
    }
    await this.appendLog(TOWER_NAME, 'worktree.add', { worktree, branch, base, spawn_base: spawnBase });
    return { rel, spawnBase };
  }

  /**
   * Wave 2 must pass the configured objective settings (skipScrutiny, skipUserTesting): they decide
   * which kinds the milestone status is derived from. The default `{}` requires every kind.
   */
  async submitValidation(
    callerName: string,
    input: TowerValidationInput,
    settings: TowerValidationSettings = {},
  ): Promise<TowerValidationResult> {
    if (!TOWER_VALIDATION_KINDS.includes(input.kind)) {
      throw new TowerProtocolError(
        `validation kind must be ${TOWER_VALIDATION_KINDS.join(' | ')}, got "${String(input.kind)}"`,
      );
    }
    if (input.verdict !== 'pass' && input.verdict !== 'fail') {
      throw new TowerProtocolError(`validation verdict must be pass | fail, got "${String(input.verdict)}"`);
    }
    const failures = (input.failures ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
    if (input.verdict === 'fail' && failures.length === 0) {
      throw new TowerProtocolError(
        'a fail verdict must list at least one failure — the orchestrator plans fix features from them',
      );
    }
    if (input.verdict === 'pass' && failures.length > 0) {
      throw new TowerProtocolError(
        'a pass verdict lists no failures — use verdict fail, or move non-blocking remarks into the evidence',
      );
    }
    return this.withStateLock(async () => {
      const state = await this.load();
      const objective = this.requireObjective(state);
      if (objective.status === 'completed') {
        throw new TowerProtocolError(`objective ${objective.id} is completed — validations are closed`);
      }
      const milestone = findMilestone(objective, input.milestone);
      if (milestone === undefined) {
        throw new TowerProtocolError(`objective ${objective.id} has no milestone "${input.milestone}"`);
      }
      if (milestone.status === 'pending') {
        throw new TowerProtocolError(`milestone ${milestone.id} is pending — its validation has not started`);
      }
      const stamp = await this.validationStampFor(state, callerName, input, objective, milestone);
      const validatedCommit = stamp.commit;
      const baseTip = await branchTip(this.repoRoot, state.base);
      const round = nextValidationRound(milestone, input.kind);
      const date = new Date().toISOString();
      await mkdir(this.abs(VALIDATIONS_DIR), { recursive: true });
      const frontmatter = renderFrontmatter({
        milestone: milestone.id,
        kind: input.kind,
        validator: callerName,
        round: String(round),
        verdict: input.verdict,
        validatedCommit,
        date,
      });
      const file = await this.writeUnique(
        join(
          VALIDATIONS_DIR,
          validationFileName({ milestone: milestone.id, kind: input.kind, validator: callerName, round }),
        ),
        `${frontmatter}\n\n${validationDocumentBody(failures, input.checks ?? [], input.evidence ?? '')}\n`,
      );
      const record: TowerValidationRound = {
        round,
        kind: input.kind,
        validator: callerName,
        validatedCommit,
        verdict: input.verdict,
        failures,
        file,
        date,
        ...(stamp.contractRevision > 0 ? { contractRevision: stamp.contractRevision } : {}),
      };
      const outcome = applyValidationRound(objective, milestone, record, settings);
      await this.save(state);
      await this.renderMissionsIndex(state);
      let activityLogError: string | undefined;
      try {
        await this.appendLog(
          callerName,
          'validation.submit',
          {
            milestone: milestone.id,
            kind: input.kind,
            round,
            verdict: input.verdict,
            commit: validatedCommit.slice(0, 7),
            status: milestone.status,
            objective: outcome.objectiveBlocked ? objective.status : undefined,
          },
          file,
        );
      } catch (error) {
        activityLogError = `validation ${file} was stored, but appending its validation.submit activity log failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      let message: TowerSendResult | undefined;
      let notificationError: string | undefined;
      try {
        message = await this.withInboxPublicationLock(() =>
          this.sendDetailedSnapshot(
            callerName,
            {
              to: TOWER_NAME,
              subject: validationResultSubject(milestone.id, record),
              body: validationResultBody(
                objective,
                milestone,
                record,
                outcome,
                record.verdict === 'fail' &&
                  record.validatedCommit === baseTip &&
                  finalPassBroken(objective, milestone, baseTip, settings) === 'failed',
              ),
              scope: milestone.id,
              action: 'validation-result',
            },
            state,
            { allowSelf: true },
          ),
        );
      } catch (error) {
        notificationError = `validation ${file} was stored, but storing its validation-result notification failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      return {
        round: record,
        milestone,
        objective,
        message,
        notificationError,
        activityLogError: activityLogError ?? message?.activityLogError,
      };
    });
  }

  private async validationStampFor(
    state: TowerState,
    callerName: string,
    input: TowerValidationInput,
    objective: TowerObjective,
    milestone: TowerMilestone,
  ): Promise<{ readonly commit: string; readonly contractRevision: number }> {
    const current = contractRevisionOf(objective);
    if (callerName === TOWER_NAME) {
      if (input.kind !== 'commands') {
        throw new TowerProtocolError(
          `the tower records only the mechanical commands validation — ${input.kind} is reported by its validator`,
        );
      }
      if (input.validatedCommit === undefined || input.validatedCommit.trim().length === 0) {
        throw new TowerProtocolError(
          'the tower must state the commit it ran the validation commands on (validatedCommit)',
        );
      }
      const given = input.contractRevision;
      if (given === undefined && current > 0) {
        throw new TowerProtocolError(
          `the tower must state the contract revision whose command list it ran (contractRevision) — objective ${objective.id} is at revision ${String(current)}`,
        );
      }
      if (given !== undefined && (!Number.isSafeInteger(given) || given < 0 || given > current)) {
        throw new TowerProtocolError(
          `contractRevision ${String(given)} is not a revision of objective ${objective.id} up to its current ${String(current)} — stamp the revision whose command list was run`,
        );
      }
      return { commit: await this.resolveCommit(input.validatedCommit), contractRevision: given ?? 0 };
    }
    if (input.kind === 'commands') {
      throw new TowerProtocolError(
        `the commands validation is recorded only by the tower — agent "${callerName}" cannot report it`,
      );
    }
    const entry = this.findAgent(state, callerName);
    if (
      entry?.kind !== 'validator' ||
      entry.milestoneId !== milestone.id ||
      entry.validationKind !== input.kind
    ) {
      throw new TowerProtocolError(
        `agent "${callerName}" is not the validator registered for ${milestone.id} ${input.kind}`,
      );
    }
    if (milestone.rounds.some((round) => round.validator === callerName && round.kind === input.kind)) {
      throw new TowerProtocolError(
        `validator "${callerName}" already reported its ${milestone.id} ${input.kind} round — a validator reports exactly once`,
      );
    }
    if (entry.validatedCommit === undefined) {
      throw new TowerProtocolError(
        `validator "${callerName}" has no validatedCommit on its roster entry, so its round cannot be stamped — spawn a validator for the current validation commit`,
      );
    }
    const stamped = await this.resolveCommit(entry.validatedCommit);
    if (
      input.validatedCommit !== undefined &&
      (await this.resolveCommit(input.validatedCommit)) !== stamped
    ) {
      throw new TowerProtocolError(
        `validator "${callerName}" was checked out at ${stamped.slice(0, 7)}, not ${input.validatedCommit} — a round is stamped on the commit its worktree validated`,
      );
    }
    const briefed = entry.contractRevision ?? 0;
    if (input.contractRevision !== undefined && input.contractRevision !== briefed) {
      throw new TowerProtocolError(
        `validator "${callerName}" was briefed under contract revision ${String(briefed)}, not ${String(input.contractRevision)} — a round is stamped with the contract its validator checked`,
      );
    }
    return { commit: stamped, contractRevision: briefed };
  }

  async prepareValidationWorktree(
    milestoneId: string,
    kind: TowerValidationKind,
  ): Promise<TowerValidationWorktree> {
    if (!TOWER_VALIDATION_KINDS.includes(kind)) {
      throw new TowerProtocolError(
        `validation kind must be ${TOWER_VALIDATION_KINDS.join(' | ')}, got "${String(kind)}"`,
      );
    }
    return this.withStateLock(async () => {
      const state = await this.load();
      const objective = this.requireObjective(state);
      const milestone = findMilestone(objective, milestoneId);
      if (milestone === undefined) {
        throw new TowerProtocolError(`objective ${objective.id} has no milestone "${milestoneId}"`);
      }
      const commit = milestone.validationCommit;
      if (milestone.status !== 'validating' || commit === undefined) {
        throw new TowerProtocolError(
          `milestone ${milestone.id} is ${milestone.status}, not validating — start its validation on the base tip before preparing a validation worktree`,
        );
      }
      let round = nextValidationRound(milestone, kind);
      let worktree = validationWorktreeName(milestone.id, kind, round);
      while (existsSync(this.abs(join(WORKTREES_DIR, worktree)))) {
        round += 1;
        worktree = validationWorktreeName(milestone.id, kind, round);
      }
      const path = this.abs(join(WORKTREES_DIR, worktree));
      await mkdir(this.abs(WORKTREES_DIR), { recursive: true });
      await worktreeAddDetached(this.repoRoot, path, commit);
      await this.appendLog(TOWER_NAME, 'worktree.add', {
        worktree,
        milestone: milestone.id,
        kind,
        commit: commit.slice(0, 7),
      });
      return { worktree, path, commit, round };
    });
  }

  async removeValidationWorktree(worktree: string): Promise<boolean> {
    const trimmed = worktree.trim().replace(/\/+$/, '');
    const name = isAbsolute(trimmed)
      ? relative(this.abs(WORKTREES_DIR), trimmed)
      : trimmed.startsWith(`${WORKTREES_DIR}/`)
        ? trimmed.slice(WORKTREES_DIR.length + 1)
        : trimmed;
    if (!name.startsWith(VALIDATION_WORKTREE_PREFIX) || name.includes('/')) {
      throw new TowerProtocolError(
        `"${worktree}" is not a validation worktree — only ${VALIDATION_WORKTREE_PREFIX}* worktrees under ${WORKTREES_DIR} are removed here`,
      );
    }
    const absPath = this.abs(join(WORKTREES_DIR, name));
    if (!(await isRegisteredWorktree(this.repoRoot, absPath))) return false;
    await worktreeRemove(this.repoRoot, absPath);
    await this.appendLog(TOWER_NAME, 'worktree.remove', { worktree: name });
    return true;
  }

  private async validationWorktrees(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.abs(WORKTREES_DIR));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const registered: string[] = [];
    for (const name of entries.filter((entry) => entry.startsWith(VALIDATION_WORKTREE_PREFIX)).toSorted()) {
      if (await isRegisteredWorktree(this.repoRoot, this.abs(join(WORKTREES_DIR, name)))) {
        registered.push(name);
      }
    }
    return registered;
  }

  async teardown(options: TowerTeardownOptions = {}): Promise<readonly string[]> {
    const state = await this.load();
    const dryRun = options.dryRun === true;
    const force = options.force === true;
    const liveAgentIds = options.liveAgentIds ?? new Set<string>();
    const excluded = new Map<string, string>();
    for (const raw of options.exclude ?? []) {
      const trimmed = raw.trim().replace(/\/+$/, '');
      if (trimmed.length === 0) continue;
      const short = trimmed.startsWith(`${WORKTREES_DIR}/`)
        ? trimmed.slice(WORKTREES_DIR.length + 1)
        : trimmed;
      excluded.set(short, raw);
    }
    const report: string[] = [];
    const kept = async (
      worktree: string,
      rel: string,
      reason: string,
      log: Record<string, string | number | undefined>,
    ): Promise<void> => {
      report.push(`${dryRun ? 'would keep' : 'kept'} ${rel} (${reason})`);
      if (!dryRun) {
        await this.appendLog(TOWER_NAME, 'worktree.keep', {
          worktree,
          ...log,
        });
      }
    };
    const removeRegistered = async (worktree: string, wasExcluded: boolean): Promise<void> => {
      const rel = join(WORKTREES_DIR, worktree);
      const absPath = this.abs(rel);
      if (wasExcluded) {
        await kept(worktree, rel, 'excluded', { reason: 'excluded' });
        return;
      }
      const liveAgent = state.roster.agents.find(
        (agent) => agent.worktree === worktree && liveAgentIds.has(agent.agentId),
      );
      if (liveAgent !== undefined) {
        await kept(worktree, rel, `live agent: ${liveAgent.name}`, {
          reason: 'live-agent',
          agent: liveAgent.name,
        });
        return;
      }
      if (!force) {
        if (await isWorktreeDirty(absPath)) {
          await kept(worktree, rel, 'uncommitted changes — rerun with force to remove', {
            reason: 'uncommitted-changes',
          });
          return;
        }
      }
      if (dryRun) {
        report.push(`would remove ${rel}`);
        return;
      }
      try {
        await worktreeRemove(this.repoRoot, absPath);
        report.push(`removed ${rel}`);
        await this.appendLog(TOWER_NAME, 'worktree.remove', { worktree });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        report.push(`failed to remove ${rel}: ${reason}`);
        await this.appendLog(TOWER_NAME, 'worktree.remove.failed', {
          worktree,
          reason,
        });
      }
    };
    for (const mission of state.missions) {
      const rel = join(WORKTREES_DIR, mission.worktree);
      const absPath = this.abs(rel);
      const wasExcluded = excluded.delete(mission.worktree);
      if (!(await isRegisteredWorktree(this.repoRoot, absPath))) {
        report.push(`already removed ${rel}`);
        if (!dryRun) {
          await this.appendLog(TOWER_NAME, 'worktree.remove.skipped', {
            worktree: mission.worktree,
            reason: 'already-removed',
          });
        }
        continue;
      }
      await removeRegistered(mission.worktree, wasExcluded);
    }
    for (const worktree of await this.validationWorktrees()) {
      await removeRegistered(worktree, excluded.delete(worktree));
    }
    for (const original of excluded.values()) {
      report.push(`excluded worktree "${original}" matched no mission worktree`);
    }
    if (!dryRun) {
      await this.appendLog(TOWER_NAME, 'teardown', { force: force ? 'yes' : undefined });
    }
    return report;
  }

  private async renderMissionsIndex(state: TowerState): Promise<void> {
    const rows = state.missions.map(
      (m) =>
        `| ${m.id} | ${m.title} | ${m.branch} | ${m.worktree} | ${STATUS_EMOJI[m.status]} | ${m.owner ?? '—'} |`,
    );
    const deps = state.missions
      .flatMap((m) => m.deps.map((dep) => `${dep} → ${m.id}`))
      .join('\n');
    const scopes = state.missions
      .map((m) => `- ${m.id}${m.kind === 'survey' ? ' (survey — informational, reserves nothing)' : ''}: ${m.scope.join(', ')}`)
      .join('\n');
    const content = [
      '# MISSIONS',
      '',
      '<!-- Generated by tower tools from state.json — do not edit by hand. -->',
      '',
      ...(state.objective === undefined ? [] : objectiveSection(state, state.objective)),
      '| ID | Mission | Branch | Worktree | Status | Owner |',
      '| -- | ------- | ------ | -------- | ------ | ----- |',
      ...rows,
      '',
      'Status: 🟡 planned · 🔵 active · 🟢 completed · 🔴 blocked · ⏸️ paused · ✅ merged · 🚫 abandoned',
      `Mode: ${state.mode} — Base: ${state.base}`,
      '',
      '## Dependency Flow',
      deps.length > 0 ? deps : '(none)',
      '',
      '## Scope Map',
      scopes.length > 0 ? scopes : '(none)',
      '',
    ].join('\n');
    await writeFile(this.abs(MISSIONS_INDEX), content, 'utf8');
  }

  private async renderMissionFile(mission: TowerMission): Promise<void> {
    const rel = join(MISSIONS_DIR, missionFileName(mission.id, mission.slug));
    const objectiveFields = [
      ...(mission.milestone === undefined ? [] : [`Milestone: ${mission.milestone}`]),
      ...(mission.origin === undefined ? [] : [`Origin: ${mission.origin}`]),
      ...(mission.attempts === undefined ? [] : [`Attempts: ${String(mission.attempts)}`]),
    ];
    const content = [
      `# Mission ${mission.id}: ${mission.title}${mission.kind === 'survey' ? ' 🔍 (read-only survey)' : ''}`,
      '',
      '<!-- Generated by tower tools from state.json — update via the TowerMission tool. -->',
      '',
      '| Branch | Worktree | Status | Scope | Owner |',
      '| ------ | -------- | ------ | ----- | ----- |',
      `| ${mission.branch} | ${mission.worktree} | ${STATUS_EMOJI[mission.status]} | ${mission.scope.join(', ')} | ${mission.owner ?? '—'} |`,
      '',
      ...(objectiveFields.length > 0 ? [objectiveFields.join(' · '), ''] : []),
      ...(mission.context !== undefined
        ? ['## Context — the user\'s own words, verbatim', '', mission.context, '']
        : []),
      '## Tasks',
      ...(mission.tasks.length > 0
        ? mission.tasks.map(
            (t) =>
              `- [${t.done ? 'x' : t.dropped === true ? '-' : ' '}] ${t.text}${t.dropped === true ? ' (dropped)' : ''}`,
          )
        : ['- [ ] (no tasks recorded)']),
      '',
      '## Dependencies',
      mission.deps.length > 0 ? mission.deps.join(', ') : '(none)',
      '',
      '## Blockers',
      ...(mission.blockers.length > 0 ? mission.blockers.map((b) => `- ${b}`) : ['- (none)']),
      '',
      '## Notes',
      ...(mission.notes.length > 0 ? mission.notes.map((n) => `- ${n}`) : ['- (none)']),
      '',
    ].join('\n');
    await writeFile(this.abs(rel), content, 'utf8');
  }

  abs(rel: string): string {
    return join(this.repoRoot, rel);
  }

  private async writeUnique(rel: string, content: string): Promise<string> {
    const dot = rel.lastIndexOf('.');
    const stem = dot === -1 ? rel : rel.slice(0, dot);
    const ext = dot === -1 ? '' : rel.slice(dot);
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = attempt === 0 ? rel : `${stem}-${attempt + 1}${ext}`;
      const temporary = `${candidate}.tmp-${String(process.pid)}-${randomUUID()}`;
      try {
        const handle = await open(this.abs(temporary), 'wx');
        try {
          await handle.writeFile(content, 'utf8');
        } finally {
          await handle.close();
        }
        await link(this.abs(temporary), this.abs(candidate));
        await rm(this.abs(temporary), { force: true });
        return candidate;
      } catch (error) {
        await rm(this.abs(temporary), { force: true });
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') continue;
        if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'ENOSYS') {
          try {
            await writeFile(this.abs(candidate), content, { encoding: 'utf8', flag: 'wx' });
            return candidate;
          } catch (fallbackError) {
            if ((fallbackError as NodeJS.ErrnoException).code === 'EEXIST') continue;
            throw fallbackError;
          }
        }
        throw error;
      }
    }
    throw new TowerProtocolError(`could not create a unique file for ${rel}`);
  }
}

function reviewDocumentBody(input: TowerReviewInput): string {
  const checks = (input.checks ?? []).map((check) => `- [x] ${check}`).join('\n');
  return [
    '## Findings',
    '',
    input.findings.trim(),
    '',
    '## Checks',
    checks.length > 0 ? checks : '- [x] (reviewer reported no formal checks)',
    '',
    '## Decision',
    input.decision.trim(),
  ].join('\n');
}

function objectiveSection(state: TowerState, objective: TowerObjective): string[] {
  const status = [
    objective.status,
    ...(objective.approvedBy === undefined ? [] : [`approved by ${objective.approvedBy}`]),
    ...(objective.approvalReason === undefined ? [] : [`approval: ${objective.approvalReason}`]),
    ...(objective.approvalRequiresHuman === true ? ['only a human can approve'] : []),
    ...(objective.pausedReason === undefined ? [] : [`paused: ${objective.pausedReason}`]),
    ...(objective.blockedReason === undefined ? [] : [`blocked: ${objective.blockedReason}`]),
  ].join(' · ');
  const rows = sortedMilestones(objective).map((milestone) => {
    const features = milestoneMissions(state, milestone.id)
      .map((mission) => `${mission.id} ${STATUS_EMOJI[mission.status]}`)
      .join(', ');
    const rounds = TOWER_VALIDATION_KINDS.flatMap((kind) => {
      const latest = latestValidationRound(milestone, kind);
      return latest === undefined ? [] : [`${kind} r${String(latest.round)} ${latest.verdict}`];
    }).join(', ');
    const commit =
      milestone.validationCommit === undefined || milestone.status === 'pending' || milestone.status === 'active'
        ? ''
        : ` @ ${milestone.validationCommit.slice(0, 7)}`;
    return `| ${milestone.id} | ${milestone.title} | ${milestone.status}${commit} | ${features.length > 0 ? features : '—'} | ${rounds.length > 0 ? rounds : '—'} |`;
  });
  return [
    `## Objective ${objective.id}: ${objective.title}`,
    '',
    `Status: ${status}`,
    `Goal: ${objective.goal.length > 0 ? objective.goal : '(not set)'}`,
    '',
    '### Definition of Done',
    ...(objective.definitionOfDone.length > 0
      ? objective.definitionOfDone.map((item) => `- ${item}`)
      : ['- (none)']),
    '',
    ...(objective.acceptanceCommands.length > 0
      ? ['### Acceptance Commands', ...objective.acceptanceCommands.map((command) => `- \`${command}\``), '']
      : []),
    '### Milestones',
    '',
    '| ID | Milestone | Status | Features | Latest rounds |',
    '| -- | --------- | ------ | -------- | ------------- |',
    ...(rows.length > 0 ? rows : ['| — | (no milestones yet) | — | — | — |']),
    '',
  ];
}

function withContractRevision(entry: TowerRosterEntry, revision: number): TowerRosterEntry {
  const { contractRevision: _given, ...rest } = entry;
  return revision > 0 ? { ...rest, contractRevision: revision } : rest;
}

function validationDocumentBody(
  failures: readonly string[],
  checks: readonly string[],
  evidence: string,
): string {
  const checkLines = checks
    .map((check) => check.trim())
    .filter((check) => check.length > 0)
    .map((check) => `- [x] ${check}`);
  return [
    '## Failures',
    '',
    failures.length > 0 ? failures.map((failure) => `- ${failure}`).join('\n') : '- (none)',
    '',
    '## Checks',
    '',
    checkLines.length > 0 ? checkLines.join('\n') : '- [x] (validator reported no formal checks)',
    '',
    '## Evidence',
    '',
    evidence.trim().length > 0 ? evidence.trim() : '(none)',
  ].join('\n');
}

function validationResultBody(
  objective: TowerObjective,
  milestone: TowerMilestone,
  round: TowerValidationRound,
  outcome: TowerValidationOutcome,
  finalBroken: boolean,
): string {
  const lines = [
    `Validation ${round.kind} round ${String(round.round)} of milestone ${milestone.id} "${milestone.title}" by ${round.validator}: ${round.verdict} on ${round.validatedCommit.slice(0, 7)}.`,
    `Milestone ${milestone.id} is now ${milestone.status}.`,
  ];
  if (finalBroken) {
    lines.push(
      `${milestone.id} is the final milestone and no longer passes on this commit — plan a fix into it (TowerPlan milestone=${milestone.id}).`,
    );
  } else if (roundContractRevision(round) !== contractRevisionOf(objective)) {
    lines.push(
      `This round was recorded but does not decide the milestone: it checked contract revision ${String(roundContractRevision(round))}, and objective ${objective.id} is now at revision ${String(contractRevisionOf(objective))} — only a round under the current contract counts.`,
    );
  } else if (!outcome.counted) {
    lines.push(
      `This round was recorded but does not decide the milestone: it was ${outcome.previousStatus}${milestone.validationCommit === undefined ? '' : ` and validates ${milestone.validationCommit.slice(0, 7)}`}.`,
    );
  }
  if (outcome.objectiveBlocked) {
    lines.push(`Objective ${objective.id} is now blocked: ${objective.blockedReason ?? 'validation rounds exhausted'}.`);
  }
  if (round.failures.length > 0) {
    lines.push('', 'Failures:', ...round.failures.map((failure) => `- ${failure}`));
  }
  lines.push('', `Report: ${round.file}`);
  return lines.join('\n');
}

function singleLine(value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim();
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
