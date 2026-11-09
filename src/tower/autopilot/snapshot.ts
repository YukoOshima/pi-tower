import { readdir } from 'node:fs/promises';

import type {
  AutopilotGate,
  AutopilotMemory,
  AutopilotMilestone,
  AutopilotMission,
  AutopilotObjective,
  AutopilotReviewVerdict,
  AutopilotSettings,
  AutopilotSnapshot,
  AutopilotValidationAttempts,
  AutopilotValidatorRun,
  AutopilotWorker,
  AutopilotWorkerState,
} from '../../autopilot/index.ts';
import {
  REVIEWS_DIR,
  TOWER_GIT_CONCURRENCY,
  TOWER_NAME,
  branchTip,
  contractRevisionOf,
  findMilestone,
  git,
  isOpenMission,
  mapWithConcurrency,
  objectiveMissions,
  roundContractRevision,
  type TowerInboxItem,
  type TowerMission,
  type TowerMissionGateResult,
  type TowerObjective,
  type TowerReviewInfo,
  type TowerRosterEntry,
  type TowerState,
  type TowerStore,
  type TowerValidationSettings,
} from '../../protocol/index.ts';
import { AUTOPILOT_INBOX_ACTIONS } from '../autopilotEvents.ts';
import { isHumanStopReason } from '../constants.ts';
import type {
  AutopilotAgentObservation,
  AutopilotObservations,
  AutopilotRuntimeSettings,
} from './types.ts';

export const REBASE_CONFLICT_BLOCKER_PREFIX = 'tower rebase onto ';

export interface AutopilotPendingWork {
  /** Names of agents a pending spawn or resume effect is starting. */
  readonly agents: readonly string[];
  /** Validator spawns not settled yet and mechanical commands runs in flight. */
  readonly validators: readonly AutopilotValidatorRun[];
}

export const NO_PENDING_WORK: AutopilotPendingWork = { agents: [], validators: [] };

export interface AutopilotCommitTimes {
  readonly committedAt: number;
  readonly authoredAt: number;
}

export interface AutopilotWorld {
  readonly now: number;
  readonly state: TowerState;
  readonly baseTip: string;
  readonly settings: AutopilotRuntimeSettings;
  readonly orchestratorBusy: boolean;
  readonly agent: (agentId: string) => AutopilotAgentObservation | undefined;
  /** Merge gates of the objective's open features, by mission id. */
  readonly gates: ReadonlyMap<string, TowerMissionGateResult>;
  /** Reviews of each open feature's branch, by mission id. */
  readonly reviews: ReadonlyMap<string, readonly TowerReviewInfo[]>;
  readonly commitTimes: ReadonlyMap<string, AutopilotCommitTimes>;
  readonly inbox: readonly TowerInboxItem[];
  readonly reviewCount: number;
  readonly pending: AutopilotPendingWork;
}

export function validationSettings(
  settings: Pick<AutopilotRuntimeSettings, 'skipScrutiny' | 'skipUserTesting'>,
): TowerValidationSettings {
  return { skipScrutiny: settings.skipScrutiny, skipUserTesting: settings.skipUserTesting };
}

export function isRebaseConflictBlocker(blocker: string): boolean {
  return blocker.startsWith(REBASE_CONFLICT_BLOCKER_PREFIX);
}

export function missionWorkerEntries(state: TowerState, mission: TowerMission): TowerRosterEntry[] {
  return state.roster.agents.filter((entry) => entry.kind === 'worker' && entry.missionId === mission.id);
}

export function missionReviewerEntries(state: TowerState, mission: TowerMission): TowerRosterEntry[] {
  return state.roster.agents.filter(
    (entry) =>
      entry.kind === 'reviewer' &&
      (entry.reviewMissionId === mission.id ||
        (entry.reviewMissionId === undefined && entry.reviewTarget === mission.branch)),
  );
}

function gateWorkers(state: TowerState, mission: TowerMission): TowerRosterEntry[] {
  return state.roster.agents.filter(
    (entry) =>
      entry.kind === 'worker' &&
      (entry.missionId === mission.id || entry.branch === mission.branch || entry.worktree === mission.worktree),
  );
}

export async function observeAutopilotWorld(input: {
  readonly store: TowerStore;
  readonly observations: AutopilotObservations;
  readonly state: TowerState;
  readonly pending?: AutopilotPendingWork;
}): Promise<AutopilotWorld> {
  const { store, observations, state } = input;
  const now = observations.now();
  const settings = observations.settings();
  const baseTip = await branchTip(store.repoRoot, state.base);
  const observed = new Map<string, AutopilotAgentObservation | undefined>();
  for (const entry of state.roster.agents) observed.set(entry.agentId, observations.agent(entry.agentId));
  const agent = (agentId: string): AutopilotAgentObservation | undefined =>
    observed.has(agentId) ? observed.get(agentId) : observations.agent(agentId);
  const running = new Set(
    [...observed].flatMap(([agentId, observation]) => (observation?.status === 'running' ? [agentId] : [])),
  );
  const gates = new Map<string, TowerMissionGateResult>();
  const reviews = new Map<string, readonly TowerReviewInfo[]>();
  await mapWithConcurrency(
    objectiveMissions(state).filter(isOpenMission),
    TOWER_GIT_CONCURRENCY,
    async (mission) => {
      const unobservable = gateWorkers(state, mission).some(
        (entry) => observed.get(entry.agentId)?.status === 'unknown',
      );
      const [gate, missionReviews] = await Promise.all([
        store.missionGate(state, mission, unobservable ? {} : { activeAgentIds: running }),
        store.reviewsFor(mission.branch),
      ]);
      gates.set(mission.id, gate);
      reviews.set(mission.id, missionReviews);
    },
  );
  const tips = [...gates.values()].flatMap((gate) =>
    gate.observations.branch === undefined ? [] : [gate.observations.branch.tip],
  );
  const [commitTimes, inbox, reviewCount] = await Promise.all([
    readCommitTimes(store.repoRoot, tips),
    store.readInbox(TOWER_NAME, Number.MAX_SAFE_INTEGER),
    countReviewFiles(store),
  ]);
  return {
    now,
    state,
    baseTip,
    settings,
    orchestratorBusy: observations.orchestratorBusy(),
    agent,
    gates,
    reviews,
    commitTimes,
    inbox,
    reviewCount,
    pending: input.pending ?? NO_PENDING_WORK,
  };
}

export async function readCommitTimes(
  repoRoot: string,
  commits: readonly string[],
): Promise<Map<string, AutopilotCommitTimes>> {
  const times = new Map<string, AutopilotCommitTimes>();
  const unique = [...new Set(commits)];
  if (unique.length === 0) return times;
  let output: string;
  try {
    output = await git(repoRoot, ['show', '-s', '--format=%H %ct %at', ...unique]);
  } catch {
    return times;
  }
  for (const line of output.split('\n')) {
    const match = /^([0-9a-f]+) (\d+) (\d+)$/.exec(line.trim());
    if (match === null) continue;
    times.set(match[1]!, { committedAt: Number(match[2]) * 1000, authoredAt: Number(match[3]) * 1000 });
  }
  return times;
}

async function countReviewFiles(store: TowerStore): Promise<number> {
  try {
    return (await readdir(store.abs(REVIEWS_DIR))).filter(
      (file) => file.startsWith('review-') && file.endsWith('.md'),
    ).length;
  } catch {
    return 0;
  }
}

export function buildAutopilotSnapshot(world: AutopilotWorld): AutopilotSnapshot {
  const objective = world.state.objective;
  const revision = objective === undefined ? 0 : contractRevisionOf(objective);
  const runs = validatorRuns(world, objective, revision);
  const missions = world.state.missions.map((mission) => autopilotMission(world, mission));
  return {
    now: world.now,
    ...(objective === undefined ? {} : { objective: autopilotObjective(objective, revision) }),
    settings: autopilotSettings(world.settings),
    baseTip: world.baseTip,
    missions,
    validators: runs.inFlight,
    validationAttempts: runs.attempts,
    otherRunningAgents: otherRunningAgents(world, missions, runs.agentRuns),
    orchestratorBusy: world.orchestratorBusy,
    reviewCount: world.reviewCount,
    inboxCount: world.inbox.filter((item) => item.from !== TOWER_NAME).length,
    memory: autopilotMemory(objective),
  };
}

function autopilotSettings(settings: AutopilotRuntimeSettings): AutopilotSettings {
  return {
    autopilot: settings.autopilot,
    maxRunningAgents: settings.maxRunningAgents,
    stallTimeoutMs: settings.stallTimeoutMs,
    maxStallWakes: settings.maxStallWakes,
    skipScrutiny: settings.skipScrutiny,
    skipUserTesting: settings.skipUserTesting,
  };
}

function epochMs(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

function autopilotObjective(objective: TowerObjective, revision: number): AutopilotObjective {
  const startedAt = epochMs(objective.startedAt);
  return {
    id: objective.id,
    status: objective.status,
    ...(startedAt === undefined ? {} : { startedAt }),
    costUsd: objective.usage?.costUsd ?? 0,
    acceptanceCommands: objective.acceptanceCommands.length,
    limits: { ...objective.limits },
    milestones: objective.milestones.map(
      (milestone): AutopilotMilestone => ({
        id: milestone.id,
        order: milestone.order,
        status: milestone.status,
        validation: {
          scrutiny: milestone.validation.scrutiny !== false,
          userTesting: milestone.validation.userTesting !== false,
          commands: milestone.validation.commands.length,
        },
        rounds: milestone.rounds
          .filter((round) => roundContractRevision(round) === revision)
          .map((round) => ({
            kind: round.kind,
            round: round.round,
            commit: round.validatedCommit,
            verdict: round.verdict,
          })),
        ...(milestone.validationCommit === undefined ? {} : { validationCommit: milestone.validationCommit }),
      }),
    ),
  };
}

function autopilotMemory(objective: TowerObjective | undefined): AutopilotMemory {
  const autopilot = objective?.autopilot;
  const progressAt = epochMs(autopilot?.progressAt);
  return {
    ...(autopilot?.progressKey === undefined ? {} : { progressKey: autopilot.progressKey }),
    ...(progressAt === undefined ? {} : { progressAt }),
    stallWakes: autopilot?.stallWakes ?? 0,
    wakeKeys: [...(autopilot?.wakeKeys ?? [])],
  };
}

export function workerStateOf(
  entry: TowerRosterEntry,
  observation: AutopilotAgentObservation | undefined,
): AutopilotWorkerState {
  switch (observation?.status) {
    case 'running':
      return 'running';
    case 'idle':
      return 'idle';
    case 'unknown':
      return entry.diedAt === undefined ? 'idle' : 'dead';
    default:
      return 'dead';
  }
}

export function stoppedByHuman(
  entry: TowerRosterEntry,
  observation: AutopilotAgentObservation | undefined,
): boolean {
  return (
    (observation?.status === 'stopped' && isHumanStopReason(observation.stopReason)) ||
    (entry.deathStatus === 'stopped' && isHumanStopReason(entry.deathReason))
  );
}

function autopilotWorker(world: AutopilotWorld, mission: TowerMission): AutopilotWorker {
  const entry = missionWorkerEntries(world.state, mission).at(-1);
  if (entry === undefined) return { state: 'none', humanStopped: false, unreadFindings: false, awaitingReply: false };
  const observation = world.agent(entry.agentId);
  return {
    state: workerStateOf(entry, observation),
    name: entry.name,
    humanStopped: stoppedByHuman(entry, observation),
    unreadFindings: hasUnreadFindings(world.inbox, entry, mission),
    awaitingReply: isAwaitingReply(world.inbox, entry),
  };
}

function isAwaitingReply(inbox: readonly TowerInboxItem[], entry: TowerRosterEntry): boolean {
  let since = entry.spawnedAt;
  for (const item of inbox) {
    if (item.to === entry.name && item.sentAt > since) since = item.sentAt;
  }
  return inbox.some(
    (item) =>
      item.from === entry.name &&
      item.to === TOWER_NAME &&
      (item.action === undefined || !AUTOPILOT_INBOX_ACTIONS.includes(item.action)) &&
      item.sentAt > since,
  );
}

function hasUnreadFindings(
  inbox: readonly TowerInboxItem[],
  entry: TowerRosterEntry,
  mission: TowerMission,
): boolean {
  const since = entry.lastInboxReadAt ?? entry.spawnedAt;
  const acked = new Set(entry.inboxAckIds ?? []);
  return inbox.some(
    (item) =>
      item.to === entry.name &&
      item.action === 'review-result' &&
      (item.scope === undefined || item.scope === mission.id) &&
      !acked.has(item.messageId) &&
      item.sentAt > since,
  );
}

export function latestReviewRequest(
  inbox: readonly TowerInboxItem[],
  missionId: string,
): TowerInboxItem | undefined {
  let latest: TowerInboxItem | undefined;
  for (const item of inbox) {
    if (
      item.to !== TOWER_NAME ||
      item.action !== 'complete' ||
      item.subject !== 'review-request' ||
      item.scope !== missionId
    ) {
      continue;
    }
    if (latest === undefined || item.sentAt > latest.sentAt) latest = item;
  }
  return latest;
}

function reviewRequestOnTip(world: AutopilotWorld, mission: TowerMission, tip: string | undefined): boolean {
  if (mission.kind !== 'build' || mission.status !== 'completed' || tip === undefined) return false;
  const sentAt = epochMs(latestReviewRequest(world.inbox, mission.id)?.sentAt);
  const times = world.commitTimes.get(tip);
  if (sentAt === undefined || times === undefined) return false;
  return times.committedAt <= sentAt || (mission.lastRebase?.toCommit === tip && times.authoredAt <= sentAt);
}

function reviewerAttemptsOnTip(
  world: AutopilotWorld,
  reviewers: readonly TowerRosterEntry[],
  reviews: readonly TowerReviewInfo[],
  tip: string | undefined,
): number {
  const times = tip === undefined ? undefined : world.commitTimes.get(tip);
  if (times === undefined) return 0;
  const reviewed = new Set(reviews.map((review) => review.reviewer));
  return reviewers.filter((entry) => {
    if (world.agent(entry.agentId)?.status === 'running' || reviewed.has(entry.name)) return false;
    const spawnedAt = epochMs(entry.spawnedAt);
    return spawnedAt !== undefined && spawnedAt >= times.committedAt;
  }).length;
}

function reviewOnTip(gate: TowerMissionGateResult | undefined): AutopilotReviewVerdict | undefined {
  const review = gate?.selectedReview;
  if (review === undefined) return undefined;
  if (gate?.reviewBinding !== 'exact-tip' && gate?.reviewBinding !== 'clean-rebase-waived') return undefined;
  return { status: review.status, merge: review.merge };
}

function autopilotGate(gate: TowerMissionGateResult | undefined): AutopilotGate {
  if (gate === undefined) return { ready: false, blocks: [] };
  return { ready: gate.ready, blocks: gate.blocks.map((block) => block.reason) };
}

function autopilotMission(world: AutopilotWorld, mission: TowerMission): AutopilotMission {
  const gate = world.gates.get(mission.id);
  const tip = gate?.observations.branch?.tip;
  const reviewers = missionReviewerEntries(world.state, mission);
  const latestReview = reviewOnTip(gate);
  return {
    id: mission.id,
    kind: mission.kind,
    status: mission.status,
    ...(mission.milestone === undefined ? {} : { milestone: mission.milestone }),
    deps: [...mission.deps],
    attempts: mission.attempts ?? 0,
    ...(tip === undefined ? {} : { tip }),
    worker: autopilotWorker(world, mission),
    reviewRequestOnTip: reviewRequestOnTip(world, mission, tip),
    reviewerRunning: reviewers.some((entry) => world.agent(entry.agentId)?.status === 'running'),
    reviewerAttemptsOnTip: reviewerAttemptsOnTip(world, reviewers, world.reviews.get(mission.id) ?? [], tip),
    ...(latestReview === undefined ? {} : { latestReviewOnTip: latestReview }),
    gate: autopilotGate(gate),
    rebaseConflict: mission.blockers.some(isRebaseConflictBlocker),
    blockers: mission.blockers.filter((blocker) => !isRebaseConflictBlocker(blocker)),
  };
}

function validatorRuns(
  world: AutopilotWorld,
  objective: TowerObjective | undefined,
  revision: number,
): {
  readonly inFlight: AutopilotValidatorRun[];
  readonly agentRuns: number;
  readonly attempts: AutopilotValidationAttempts[];
} {
  const inFlight: AutopilotValidatorRun[] = [];
  const attempts = new Map<string, AutopilotValidationAttempts>();
  let agentRuns = 0;
  for (const entry of objective === undefined ? [] : world.state.roster.agents) {
    const { milestoneId, validationKind: kind, validatedCommit: commit } = entry;
    if (entry.kind !== 'validator' || milestoneId === undefined || kind === undefined || commit === undefined) {
      continue;
    }
    const milestone = findMilestone(objective, milestoneId);
    if (milestone === undefined || (entry.contractRevision ?? 0) !== revision) continue;
    if (milestone.rounds.some((round) => round.validator === entry.name && round.kind === kind)) continue;
    if (world.agent(entry.agentId)?.status === 'running') {
      inFlight.push({ milestone: milestone.id, kind, commit, name: entry.name });
      agentRuns += 1;
      continue;
    }
    const key = `${milestone.id} ${kind} ${commit}`;
    const previous = attempts.get(key)?.attempts ?? 0;
    attempts.set(key, { milestone: milestone.id, kind, commit, attempts: previous + 1 });
  }
  for (const run of world.pending.validators) {
    if (run.name !== undefined && inFlight.some((existing) => existing.name === run.name)) continue;
    inFlight.push(run);
  }
  return { inFlight, agentRuns, attempts: [...attempts.values()] };
}

function otherRunningAgents(
  world: AutopilotWorld,
  missions: readonly AutopilotMission[],
  validatorAgents: number,
): number {
  const runningNames = new Set<string>();
  const runningIds = new Set<string>();
  for (const entry of world.state.roster.agents) {
    if (world.agent(entry.agentId)?.status !== 'running') continue;
    runningIds.add(entry.agentId);
    runningNames.add(entry.name);
  }
  const represented =
    missions.filter((mission) => mission.worker.state === 'running').length +
    missions.filter((mission) => mission.reviewerRunning).length +
    validatorAgents;
  const pending = world.pending.agents.filter((name) => !runningNames.has(name)).length;
  return Math.max(0, runningIds.size - represented) + pending;
}
