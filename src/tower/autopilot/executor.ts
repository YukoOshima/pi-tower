import type {
  AutopilotAction,
  AutopilotBlockObjective,
  AutopilotDecision,
  AutopilotPauseObjective,
  AutopilotSnapshot,
  AutopilotValidatorRun,
} from '../../autopilot/index.ts';
import {
  findMilestone,
  type TowerMilestone,
  type TowerMission,
  type TowerObjective,
  type TowerReviewInfo,
  type TowerState,
  type TowerStore,
} from '../../protocol/index.ts';
import { budgetPausedNotice } from '../../prompts/objectiveWakes.ts';
import { missionReviewerEntries, validationSettings, type AutopilotWorld } from './snapshot.ts';
import {
  blockedNoticeKey,
  blockedNoticeText,
  completedNoticeKey,
  completedNoticeText,
  orchestratorWakeText,
  rebaseConflictResumePrompt,
  respawnReason,
  reviewFindingsResumePrompt,
} from './texts.ts';
import type { AutopilotEffects, AutopilotValidatorKind, EffectResult } from './types.ts';

export interface AutopilotLaunch {
  /** Identity of the decided action the launch belongs to; a refusal counts against it. */
  readonly identity: string;
  readonly agent: string;
  readonly mission?: string;
  readonly validator?: AutopilotValidatorRun;
  /** Wake key recorded once the launch succeeded (resume keys). */
  readonly wakeKey?: string;
  readonly start: () => Promise<EffectResult>;
}

export interface AutopilotExecution {
  readonly store: TowerStore;
  readonly effects: AutopilotEffects;
  readonly world: AutopilotWorld;
  readonly snapshot: AutopilotSnapshot;
  readonly decision: AutopilotDecision;
  /** Agent names already taken by pending launches. */
  readonly reserved: ReadonlySet<string>;
  launch(launch: AutopilotLaunch): void;
  runCommands(milestoneId: string, commit: string): void;
}

export type AutopilotActionOutcome =
  | { readonly status: 'done'; readonly detail?: string; readonly wakeKey?: string }
  | { readonly status: 'launched'; readonly detail: string }
  | { readonly status: 'refused'; readonly error: string };

export function autopilotActionIdentity(action: AutopilotAction): string {
  switch (action.type) {
    case 'wake-orchestrator':
    case 'resume-worker':
      return `${action.type}:${action.key}`;
    case 'start-validation':
      return `${action.type}:${action.milestone}:${action.commit}:${action.kinds.join('+')}`;
    case 'advance-milestone':
      return `${action.type}:${action.milestone}`;
    case 'complete-objective':
    case 'block-objective':
    case 'pause-objective':
      return `${action.type}:${action.objective}`;
    default:
      return `${action.type}:${action.mission}`;
  }
}

export function autopilotActionMission(action: AutopilotAction): string | undefined {
  switch (action.type) {
    case 'spawn-worker':
    case 'respawn-worker':
    case 'resume-worker':
    case 'spawn-reviewer':
    case 'rebase':
    case 'merge':
      return action.mission;
    default:
      return undefined;
  }
}

export function autopilotActionSubject(action: AutopilotAction): string {
  switch (action.type) {
    case 'wake-orchestrator':
      return `${action.reason} ${action.subject}`;
    case 'start-validation':
    case 'advance-milestone':
      return `milestone ${action.milestone}`;
    case 'complete-objective':
    case 'block-objective':
    case 'pause-objective':
      return `objective ${action.objective}`;
    default:
      return `mission ${action.mission}`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueAgentName(
  state: TowerState,
  reserved: ReadonlySet<string>,
  used: ReadonlySet<string>,
  start: number,
  format: (n: number) => string,
): string {
  const taken = new Set(state.roster.agents.map((entry) => entry.name));
  for (let n = Math.max(1, start); ; n += 1) {
    const name = format(n);
    if (!taken.has(name) && !reserved.has(name) && !used.has(name)) return name;
  }
}

export function workerAgentName(
  state: TowerState,
  missionId: string,
  attempt: number,
  reserved: ReadonlySet<string> = new Set(),
): string {
  return uniqueAgentName(state, reserved, new Set(), attempt, (n) => `ap-w-${missionId}-${String(n)}`);
}

export function reviewerAgentName(
  state: TowerState,
  mission: TowerMission,
  reviews: readonly TowerReviewInfo[],
  reserved: ReadonlySet<string> = new Set(),
): string {
  return uniqueAgentName(
    state,
    reserved,
    new Set(reviews.map((review) => review.reviewer)),
    missionReviewerEntries(state, mission).length + 1,
    (n) => `ap-r-${mission.id}-${String(n)}`,
  );
}

export function validatorAgentName(
  state: TowerState,
  milestone: TowerMilestone,
  kind: AutopilotValidatorKind,
  reserved: ReadonlySet<string> = new Set(),
): string {
  const previous = state.roster.agents.filter(
    (entry) => entry.kind === 'validator' && entry.milestoneId === milestone.id && entry.validationKind === kind,
  ).length;
  return uniqueAgentName(
    state,
    reserved,
    new Set(milestone.rounds.map((round) => round.validator)),
    previous + 1,
    (n) => `ap-v-${milestone.id}-${kind}-${String(n)}`,
  );
}

function requireMission(state: TowerState, id: string): TowerMission {
  const mission = state.missions.find((candidate) => candidate.id === id);
  if (mission === undefined) throw new Error(`unknown mission "${id}"`);
  return mission;
}

function launched(execution: AutopilotExecution, launch: AutopilotLaunch): AutopilotActionOutcome {
  execution.launch(launch);
  return { status: 'launched', detail: `name=${launch.agent}` };
}

function effectOutcome(result: EffectResult): AutopilotActionOutcome {
  return result.ok
    ? { status: 'done', ...(result.detail === undefined ? {} : { detail: result.detail }) }
    : { status: 'refused', error: result.error };
}

export async function executeAutopilotAction(
  execution: AutopilotExecution,
  action: AutopilotAction,
): Promise<AutopilotActionOutcome> {
  try {
    return await execute(execution, action);
  } catch (error) {
    return { status: 'refused', error: errorMessage(error) };
  }
}

async function execute(execution: AutopilotExecution, action: AutopilotAction): Promise<AutopilotActionOutcome> {
  const { store, effects, world, reserved } = execution;
  const { state } = world;
  const identity = autopilotActionIdentity(action);
  switch (action.type) {
    case 'spawn-worker': {
      const mission = requireMission(state, action.mission);
      const name = workerAgentName(state, mission.id, (mission.attempts ?? 0) + 1, reserved);
      return launched(execution, {
        identity,
        agent: name,
        mission: mission.id,
        start: () => effects.spawnWorker(mission.id, name),
      });
    }
    case 'respawn-worker': {
      const mission = requireMission(state, action.mission);
      const name = workerAgentName(state, mission.id, action.attempt, reserved);
      const max = state.objective?.limits.maxFeatureAttempts ?? action.attempt;
      const reason = respawnReason(world, mission, action.attempt, max);
      return launched(execution, {
        identity,
        agent: name,
        mission: mission.id,
        start: () => effects.respawnWorker(mission.id, name, reason),
      });
    }
    case 'resume-worker': {
      const mission = requireMission(state, action.mission);
      const prompt =
        action.reason === 'rebase-conflict'
          ? rebaseConflictResumePrompt(mission, state.base)
          : reviewFindingsResumePrompt(mission);
      return launched(execution, {
        identity,
        agent: action.worker,
        mission: mission.id,
        wakeKey: action.key,
        start: () => effects.resumeWorker(action.worker, prompt),
      });
    }
    case 'spawn-reviewer': {
      const mission = requireMission(state, action.mission);
      const name = reviewerAgentName(state, mission, world.reviews.get(mission.id) ?? [], reserved);
      return launched(execution, {
        identity,
        agent: name,
        mission: mission.id,
        start: () => effects.spawnReviewer(mission.id, name),
      });
    }
    case 'rebase':
      return effectOutcome(await effects.rebase(action.mission));
    case 'merge':
      return effectOutcome(await effects.merge(action.mission));
    case 'start-validation':
      return startValidation(execution, action.milestone, action.commit, action.kinds, identity);
    case 'advance-milestone': {
      const activated = await store.activateNextMilestone();
      return { status: 'done', detail: activated === undefined ? 'nothing to activate' : `activated=${activated.id}` };
    }
    case 'complete-objective':
      return completeObjective(execution);
    case 'block-objective':
      return blockObjective(execution, action);
    case 'pause-objective':
      return pauseObjective(execution, action);
    case 'wake-orchestrator':
      effects.wakeOrchestrator(orchestratorWakeText(world, execution.snapshot, execution.decision, action));
      return { status: 'done', detail: `key=${action.key}`, wakeKey: action.key };
  }
}

async function startValidation(
  execution: AutopilotExecution,
  milestoneId: string,
  commit: string,
  kinds: readonly string[],
  identity: string,
): Promise<AutopilotActionOutcome> {
  const { store, effects, world, reserved } = execution;
  const started = await store.startMilestoneValidation(
    milestoneId,
    commit,
    validationSettings(world.settings),
  );
  const status = started.milestone.status;
  if (status !== 'validating') return { status: 'done', detail: `status=${status}` };
  const milestone = findMilestone(world.state.objective, milestoneId) ?? started.milestone;
  const names = new Set(reserved);
  const launchedKinds: string[] = [];
  for (const kind of kinds) {
    if (kind !== 'scrutiny' && kind !== 'user-testing') continue;
    const name = validatorAgentName(world.state, milestone, kind, names);
    names.add(name);
    execution.launch({
      identity,
      agent: name,
      validator: { milestone: milestoneId, kind, commit: started.commit, name },
      start: () => effects.spawnValidator(milestoneId, kind, name),
    });
    launchedKinds.push(`${kind}=${name}`);
  }
  if (kinds.includes('commands')) {
    execution.runCommands(milestoneId, started.commit);
    launchedKinds.push('commands');
  }
  return {
    status: 'done',
    detail: `status=${status} commit=${started.commit.slice(0, 7)}${launchedKinds.length > 0 ? ` kinds=${launchedKinds.join(',')}` : ''}`,
  };
}

function elapsedSince(objective: TowerObjective, now: number): number | undefined {
  if (objective.startedAt === undefined) return undefined;
  const started = Date.parse(objective.startedAt);
  return Number.isNaN(started) ? undefined : Math.max(0, now - started);
}

async function completeObjective(execution: AutopilotExecution): Promise<AutopilotActionOutcome> {
  const { store, effects, world } = execution;
  const completed = await store.completeObjective(validationSettings(world.settings));
  const state = await store.load();
  effects.notifyHuman(
    completedNoticeText({ objective: completed, state, baseTip: world.baseTip, now: world.now }),
    'info',
  );
  return { status: 'done', detail: `objective=${completed.id}`, wakeKey: completedNoticeKey(completed) };
}

function blockReason(world: AutopilotWorld, action: AutopilotBlockObjective): string {
  return action.reason === 'stalled'
    ? `the autopilot saw no progress after ${String(world.settings.maxStallWakes)} stall wake(s) of the orchestrator (${action.detail})`
    : `${action.detail} — the autopilot cannot continue it`;
}

async function blockObjective(
  execution: AutopilotExecution,
  action: AutopilotBlockObjective,
): Promise<AutopilotActionOutcome> {
  const { store, effects, world } = execution;
  const blocked = await store.blockObjective(blockReason(world, action));
  effects.notifyHuman(blockedNoticeText(blocked, world.settings), 'error');
  return { status: 'done', detail: `reason=${action.reason}`, wakeKey: blockedNoticeKey(blocked) };
}

async function pauseObjective(
  execution: AutopilotExecution,
  action: AutopilotPauseObjective,
): Promise<AutopilotActionOutcome> {
  const { store, effects, world } = execution;
  const paused = await store.pauseObjective(`${action.reason}: ${action.detail}`);
  const elapsedMs = elapsedSince(paused, world.now);
  effects.notifyHuman(
    budgetPausedNotice({
      objective: paused,
      limit: action.reason === 'max-cost' ? 'cost' : 'wall-time',
      costUsd: paused.usage?.costUsd ?? 0,
      ...(paused.limits.maxCostUsd === undefined ? {} : { maxCostUsd: paused.limits.maxCostUsd }),
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
      ...(paused.limits.maxWallTimeMs === undefined ? {} : { maxWallTimeMs: paused.limits.maxWallTimeMs }),
    }),
    'warning',
  );
  return { status: 'done', detail: `reason=${action.reason}` };
}
