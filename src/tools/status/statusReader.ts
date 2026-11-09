import {
  MAIN_AGENT_ID,
  currentMilestone,
  mapWithConcurrency,
  TOWER_GIT_CONCURRENCY,
  type TowerMissionGateBlock,
  type TowerObjective,
  type TowerReviewBinding,
  type TowerState,
  type TowerStore,
} from '../../protocol/index.ts';
import type { TowerRateLimitSnapshot } from '../../tower/runtimeTypes.ts';
import { validatorAssignment } from '../agents.ts';

const INBOX_COUNT_LIMIT = 1000;
const RECENT_LOG_LINES = 10;

export type TowerStatusConcurrency = TowerRateLimitSnapshot;

export interface TowerStatusState {
  readonly base: TowerState['base'];
  readonly mode: TowerState['mode'];
  readonly recoveredAt?: string;
  readonly missions: TowerState['missions'];
  readonly roster: TowerState['roster'];
  readonly objective?: TowerObjective;
}

export interface TowerStatusReview {
  readonly reviewer: string;
  readonly round: number;
  readonly status: string;
  readonly merge: string;
}

export interface TowerStatusGate {
  readonly missionId: string;
  readonly branch: string;
  readonly ready: boolean;
  readonly noop: boolean;
  readonly blocks: readonly TowerMissionGateBlock[];
  readonly selectedReview?: TowerStatusReview;
  readonly reviewBinding?: TowerReviewBinding;
}

export interface InitializedTowerStatus {
  readonly active: boolean;
  readonly initialized: true;
  readonly state: TowerStatusState;
  readonly caller: string;
  readonly gate: readonly TowerStatusGate[];
  readonly inbox: { readonly count: number };
  readonly concurrency: TowerStatusConcurrency;
  readonly recentActivity: readonly string[];
}

export type TowerStatus =
  | { readonly active: boolean; readonly initialized: false; readonly stateLost: boolean }
  | InitializedTowerStatus;

export interface ReadTowerStatusInput {
  readonly active: boolean;
  readonly store: TowerStore;
  readonly agentId: string;
  readonly activeAgentIds: () => ReadonlySet<string>;
  readonly concurrency: () => TowerStatusConcurrency;
}

export async function readTowerStatus(input: ReadTowerStatusInput): Promise<TowerStatus> {
  const { store } = input;
  const initialized = await store.isInitialized();
  if (!initialized) {
    return { active: input.active, initialized: false, stateLost: await store.isStateLost() };
  }

  const state = await store.load();
  const caller = store.resolveCallerName(state, input.agentId);
  const pending = state.missions.filter(
    (mission) => mission.status !== 'merged' && mission.status !== 'abandoned',
  );
  const activeAgentIds =
    pending.length > 0 && input.agentId === MAIN_AGENT_ID ? input.activeAgentIds() : undefined;
  const gate = await mapWithConcurrency(
    pending,
    TOWER_GIT_CONCURRENCY,
    async (mission): Promise<TowerStatusGate> => {
      const result = await store.missionGate(
        state,
        mission,
        activeAgentIds === undefined ? {} : { activeAgentIds },
      );
      return {
        missionId: mission.id,
        branch: mission.branch,
        ready: result.ready,
        noop: result.noop,
        blocks: result.blocks,
        ...(result.selectedReview === undefined
          ? {}
          : {
              selectedReview: {
                reviewer: result.selectedReview.reviewer,
                round: result.selectedReview.round,
                status: result.selectedReview.status,
                merge: result.selectedReview.merge,
              },
            }),
        ...(result.reviewBinding === undefined ? {} : { reviewBinding: result.reviewBinding }),
      };
    },
  );
  const inbox = await store.readInbox(caller, INBOX_COUNT_LIMIT);
  const concurrency = input.concurrency();
  const recentActivity = await store.recentLog(RECENT_LOG_LINES);
  return {
    active: input.active,
    initialized: true,
    state: {
      base: state.base,
      mode: state.mode,
      ...(state.recoveredAt === undefined ? {} : { recoveredAt: state.recoveredAt }),
      missions: state.missions,
      roster: state.roster,
      ...(state.objective === undefined ? {} : { objective: state.objective }),
    },
    caller,
    gate,
    inbox: { count: inbox.length },
    concurrency,
    recentActivity,
  };
}

export async function readTowerStatusSummary(input: ReadTowerStatusInput): Promise<string> {
  const status = await readTowerStatus(input);
  if (!status.initialized) {
    if (status.stateLost) {
      return status.active
        ? 'Tower mode: ON\nTower state was lost: .tower/comms/state.json is missing but the .tower/ directory still exists — all recorded mission, roster, and review history is gone. Report this history loss to the user; TowerSend/TowerComplete recover a minimal state (stamped recoveredAt) automatically.'
        : 'Tower mode: OFF';
    }
    return status.active ? 'Tower mode: ON\nTower is not initialized.' : 'Tower mode: OFF';
  }
  const lines = [
    status.active ? 'Tower status — ON' : 'Tower mode: OFF',
    `Base: ${status.state.base} (mode: ${status.state.mode}) · You are: ${status.caller}`,
    ...summaryRecoveredAt(status.state),
    ...summaryObjective(status.state),
    'Missions:',
    ...summaryMissions(status.state),
    'Roster:',
    ...summaryRoster(status.state),
    'Review gate:',
    ...summaryGate(status.gate),
    `Inbox: ${String(status.inbox.count)} message(s)`,
    `Concurrency: ${summaryConcurrency(status.concurrency)}`,
    'Recent activity:',
    ...(status.recentActivity.length > 0
      ? status.recentActivity.map((line) => `  ${line}`)
      : ['  (empty)']),
  ];
  return lines.join('\n');
}

function summaryMissions(state: TowerStatusState): string[] {
  if (state.missions.length === 0) return ['  (none)'];
  return state.missions.map(
    (mission) =>
      `  ${mission.id} ${mission.title} — ${mission.status} · owner ${mission.owner ?? '—'} · ${mission.branch}`,
  );
}

function summaryRecoveredAt(state: TowerStatusState): string[] {
  if (state.recoveredAt === undefined) return [];
  return [
    `⚠️ State recovered at ${state.recoveredAt} after a state loss — all mission, roster, and review history from before that point is gone; report this history loss to the user instead of continuing as if nothing happened.`,
  ];
}

function summaryObjective(state: TowerStatusState): string[] {
  const objective = state.objective;
  if (objective === undefined) return [];
  const passed = objective.milestones.filter((milestone) => milestone.status === 'passed').length;
  const current = currentMilestone(objective);
  return [
    `Objective: ${objective.id} ${objective.title} — ${objective.status} · milestones ${String(passed)}/${String(objective.milestones.length)} passed${current === undefined ? '' : ` · current ${current.id} ${current.status}`}`,
  ];
}

function summaryRoster(state: TowerStatusState): string[] {
  if (state.roster.agents.length === 0) return ['  (none)'];
  return state.roster.agents.map((agent) => {
    const assignment =
      agent.kind === 'worker'
        ? `mission ${agent.missionId ?? '?'}`
        : agent.kind === 'validator'
          ? validatorAssignment(agent)
          : `reviewing ${agent.reviewTarget ?? '?'}`;
    const model = agent.model === undefined ? '' : ` · model ${agent.model}`;
    const death = agent.diedAt === undefined ? '' : ` · died ${agent.deathStatus ?? 'unknown'}`;
    return `  ${agent.name} (${agent.kind}) — ${assignment} · ${agent.agentId}${model}${death}`;
  });
}

function summaryGate(gate: readonly TowerStatusGate[]): string[] {
  if (gate.length === 0) return ['  (no open missions)'];
  return gate.map((missionGate) => {
    const review = missionGate.selectedReview;
    const reviewText =
      review === undefined
        ? ''
        : ` · review round ${String(review.round)} by ${review.reviewer} ${review.status}/${review.merge || 'legacy'} · binding ${missionGate.reviewBinding ?? 'unavailable'}`;
    if (missionGate.ready) {
      return `  ${missionGate.missionId} ${missionGate.branch} — READY${missionGate.noop ? ' (zero-diff no-op)' : ''}${reviewText}`;
    }
    const reasons = missionGate.blocks.map((block) => block.reason).join(', ');
    return `  ${missionGate.missionId} ${missionGate.branch} — BLOCKED: ${reasons}${reviewText}`;
  });
}

function summaryConcurrency(snapshot: TowerStatusConcurrency): string {
  const budget = Number.isFinite(snapshot.budget) ? String(snapshot.budget) : 'unlimited';
  const base = `budget: ${budget} agent(s) · inflight: ${String(snapshot.inflight)}`;
  if (snapshot.blockedUntil === null) return `${base} · spawns open`;
  const remainingMs = snapshot.blockedUntil - Date.now();
  return remainingMs > 0
    ? `${base} · spawns paused for ~${String(Math.ceil(remainingMs / 1000))}s`
    : `${base} · spawn pause expired`;
}
