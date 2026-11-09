import {
  latestRound,
  milestoneRequiredKinds,
  type AutopilotAction,
  type AutopilotDecision,
  type AutopilotMemory,
  type AutopilotMilestone,
  type AutopilotMilestoneStatus,
  type AutopilotMission,
  type AutopilotObjective,
  type AutopilotSettings,
  type AutopilotSnapshot,
  type AutopilotWorker,
} from '../../src/autopilot/index.ts';

export const NOW = 10_000_000;
export const BASE = 'base-0';

export function worker(overrides: Partial<AutopilotWorker> = {}): AutopilotWorker {
  return { state: 'none', humanStopped: false, unreadFindings: false, awaitingReply: false, ...overrides };
}

export function feature(id: string, overrides: Partial<AutopilotMission> = {}): AutopilotMission {
  return {
    id,
    kind: 'build',
    status: 'planned',
    milestone: 'MS1',
    deps: [],
    attempts: 0,
    worker: worker(),
    reviewRequestOnTip: false,
    reviewerRunning: false,
    reviewerAttemptsOnTip: 0,
    reviewerHumanStopped: false,
    gate: { ready: false, blocks: ['not-completed'] },
    rebaseConflict: false,
    blockers: [],
    ...overrides,
  };
}

export function working(id: string, overrides: Partial<AutopilotMission> = {}): AutopilotMission {
  return feature(id, {
    status: 'active',
    attempts: 1,
    tip: `tip-${id}`,
    worker: worker({ state: 'running', name: `w-${id}` }),
    ...overrides,
  });
}

export function awaitingReview(id: string, overrides: Partial<AutopilotMission> = {}): AutopilotMission {
  return feature(id, {
    status: 'completed',
    attempts: 1,
    tip: `tip-${id}`,
    worker: worker({ state: 'idle', name: `w-${id}` }),
    reviewRequestOnTip: true,
    gate: { ready: false, blocks: ['no-review'] },
    ...overrides,
  });
}

export function mergeable(id: string, overrides: Partial<AutopilotMission> = {}): AutopilotMission {
  return feature(id, {
    status: 'completed',
    attempts: 1,
    tip: `tip-${id}`,
    worker: worker({ state: 'idle', name: `w-${id}` }),
    latestReviewOnTip: { status: 'clean', merge: 'merge' },
    gate: { ready: true, blocks: [] },
    ...overrides,
  });
}

export function merged(id: string, overrides: Partial<AutopilotMission> = {}): AutopilotMission {
  return feature(id, {
    status: 'merged',
    attempts: 1,
    tip: `tip-${id}`,
    worker: worker({ state: 'idle', name: `w-${id}` }),
    gate: { ready: false, blocks: ['not-completed'] },
    ...overrides,
  });
}

export function milestone(
  id: string,
  order: number,
  overrides: Partial<AutopilotMilestone> = {},
): AutopilotMilestone {
  return {
    id,
    order,
    status: 'pending',
    validation: { scrutiny: true, userTesting: true, commands: 0 },
    rounds: [],
    ...overrides,
  };
}

export const SETTINGS: AutopilotSettings = {
  autopilot: true,
  maxRunningAgents: 4,
  stallTimeoutMs: 180_000,
  maxStallWakes: 3,
  skipScrutiny: false,
  skipUserTesting: false,
  autoTeardown: true,
};

export interface SnapshotParts
  extends Partial<Omit<AutopilotSnapshot, 'objective' | 'settings' | 'memory'>> {
  readonly objective?: Partial<AutopilotObjective>;
  readonly settings?: Partial<AutopilotSettings>;
  readonly memory?: Partial<AutopilotMemory>;
}

export function snapshot(parts: SnapshotParts = {}): AutopilotSnapshot {
  const { objective, settings, memory, ...rest } = parts;
  return {
    now: NOW,
    settings: { ...SETTINGS, ...settings },
    baseTip: BASE,
    missions: [],
    validators: [],
    validationAttempts: [],
    otherRunningAgents: 0,
    orchestratorBusy: false,
    reviewCount: 0,
    inboxCount: 0,
    memory: { stallWakes: 0, wakeKeys: [], ...memory },
    objective: {
      id: 'O1',
      status: 'executing',
      startedAt: NOW - 60_000,
      costUsd: 0,
      acceptanceCommands: 0,
      limits: { maxValidationRounds: 3, maxFeatureAttempts: 3 },
      milestones: [milestone('MS1', 1, { status: 'active' }), milestone('MS2', 2)],
      ...objective,
    },
    ...rest,
  };
}

function patchMission(
  snap: AutopilotSnapshot,
  id: string,
  patch: (mission: AutopilotMission) => Partial<AutopilotMission>,
): AutopilotSnapshot {
  return {
    ...snap,
    missions: snap.missions.map((mission) =>
      mission.id === id ? { ...mission, ...patch(mission) } : mission,
    ),
  };
}

function patchMilestone(
  snap: AutopilotSnapshot,
  id: string,
  patch: Partial<AutopilotMilestone>,
): AutopilotSnapshot {
  const objective = snap.objective!;
  return {
    ...snap,
    objective: {
      ...objective,
      milestones: objective.milestones.map((ms) => (ms.id === id ? { ...ms, ...patch } : ms)),
    },
  };
}

export function statusOnStart(
  objective: AutopilotObjective,
  milestoneId: string,
  settings: AutopilotSettings,
  commit: string,
): AutopilotMilestoneStatus {
  const ms = objective.milestones.find((candidate) => candidate.id === milestoneId)!;
  const required = milestoneRequiredKinds(objective, ms, settings);
  if (required.length === 0) return 'passed';
  const rederived = required.every((kind) => latestRound(ms, kind, commit)?.verdict === 'pass');
  return rederived ? 'passed' : 'validating';
}

export function applyAction(snap: AutopilotSnapshot, action: AutopilotAction): AutopilotSnapshot {
  const remember = (key: string): AutopilotSnapshot => ({
    ...snap,
    memory: { ...snap.memory, wakeKeys: [...snap.memory.wakeKeys, key] },
  });
  switch (action.type) {
    case 'spawn-worker':
    case 'respawn-worker':
      return patchMission(snap, action.mission, (mission) => ({
        status: mission.status === 'planned' ? 'active' : mission.status,
        attempts: mission.attempts + 1,
        worker: worker({ state: 'running', name: `w-${mission.id}-${String(mission.attempts + 1)}` }),
      }));
    case 'resume-worker':
      return patchMission(remember(action.key), action.mission, (mission) => ({
        worker: { ...mission.worker, state: 'running' },
      }));
    case 'spawn-reviewer':
      return patchMission(snap, action.mission, () => ({ reviewerRunning: true }));
    case 'rebase':
      return patchMission(snap, action.mission, (mission) => ({
        tip: `${mission.tip ?? 'tip'}+rebased`,
        gate:
          mission.latestReviewOnTip?.status === 'clean'
            ? { ready: true, blocks: [] }
            : { ready: false, blocks: ['no-review'] },
      }));
    case 'merge':
      return {
        ...patchMission(snap, action.mission, () => ({ status: 'merged' })),
        baseTip: `${snap.baseTip}+${action.mission}`,
      };
    case 'start-validation':
      return {
        ...patchMilestone(snap, action.milestone, {
          status: statusOnStart(snap.objective!, action.milestone, snap.settings, action.commit),
          validationCommit: action.commit,
        }),
        validators: [
          ...snap.validators,
          ...action.kinds.map((kind) => ({ milestone: action.milestone, kind, commit: action.commit })),
        ],
      };
    case 'advance-milestone':
      return patchMilestone(snap, action.milestone, { status: 'active' });
    case 'complete-objective':
      return { ...snap, objective: { ...snap.objective!, status: 'completed' } };
    case 'block-objective':
      return { ...snap, objective: { ...snap.objective!, status: 'blocked' } };
    case 'pause-objective':
      return { ...snap, objective: { ...snap.objective!, status: 'paused' } };
    case 'wake-orchestrator':
      return { ...remember(action.key), orchestratorBusy: true };
  }
}

export function applyDecision(snap: AutopilotSnapshot, decision: AutopilotDecision): AutopilotSnapshot {
  const after = decision.actions.reduce(applyAction, snap);
  return {
    ...after,
    memory: {
      ...after.memory,
      progressKey: decision.progressKey,
      progressAt: decision.stall.progressAt,
      stallWakes: decision.stall.stallWakes,
    },
  };
}

export function actionIdentity(action: AutopilotAction): string {
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
