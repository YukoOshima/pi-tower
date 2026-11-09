import { TOWER_STATUS_DESCRIPTION } from '../../prompts/index.ts';
import {
  currentMilestone,
  isObjectiveOpen,
  type TowerMission,
  type TowerObjective,
  type TowerRosterEntry,
} from '../../protocol/index.ts';
import { HUMAN_STOP_REASON } from '../../tower/constants.ts';
import type { TowerAgentInfo } from '../../tower/runtimeTypes.ts';
import { validatorAssignment } from '../agents.ts';
import { renderObjectiveDashboard } from '../objective/views.ts';
import {
  objectiveSettingsOf,
  runTowerTool,
  skippedValidationKinds,
  type TowerCaller,
  type TowerObjectiveSettingsView,
  type TowerTool,
  type TowerToolHost,
} from '../support.ts';
import { TowerStatusToolInputSchema } from './status.ts';
import {
  readTowerStatus,
  type TowerStatusConcurrency,
  type TowerStatusGate,
  type TowerStatusState,
} from './statusReader.ts';

const STATUS_EMOJI: Record<TowerMission['status'], string> = {
  planned: '🟡',
  active: '🔵',
  completed: '🟢',
  blocked: '🔴',
  paused: '⏸️',
  merged: '✅',
  abandoned: '🚫',
};

export function createTowerStatusTool(
  host: TowerToolHost,
  caller: TowerCaller,
): TowerTool<typeof TowerStatusToolInputSchema> {
  return {
    name: 'TowerStatus',
    label: 'Tower Status',
    description: TOWER_STATUS_DESCRIPTION,
    parameters: TowerStatusToolInputSchema,
    run: () =>
      runTowerTool(async () => {
        const status = await readTowerStatus({
          active: true,
          store: host.store(),
          agentId: caller.agentId,
          activeAgentIds: () => host.activeAgentIds(),
          concurrency: () => host.rateLimitSnapshot(),
        });
        if (!status.initialized) {
          if (status.stateLost) return { output: renderStateLostReport() };
          return {
            output: 'tower is not initialized in this repository — run TowerInit first',
            isError: true,
          };
        }
        if (!status.active) return { output: '# Tower status — OFF' };
        return {
          output: renderTowerDashboard(status.state, status.caller, status.gate, {
            inboxCount: status.inbox.count,
            concurrency: status.concurrency,
            recentActivity: status.recentActivity,
            runtimeAgent: (agentId) => host.agentInfo(agentId),
            ...(status.state.objective === undefined
              ? {}
              : {
                  objective: {
                    activeAgentIds: host.activeAgentIds(),
                    settings: objectiveSettingsOf(host),
                  },
                }),
          }),
        };
      }),
  };
}

export interface TowerDashboardExtras {
  readonly inboxCount: number;
  readonly concurrency: TowerStatusConcurrency;
  readonly recentActivity: readonly string[];
  readonly runtimeAgent?: RuntimeAgentLookup;
  readonly objective?: TowerDashboardObjectiveExtras;
}

export interface TowerDashboardObjectiveExtras {
  readonly activeAgentIds: ReadonlySet<string>;
  readonly settings: TowerObjectiveSettingsView;
}

type RuntimeAgentLookup = (agentId: string) => Pick<TowerAgentInfo, 'windingDown'> | undefined;

export function renderTowerDashboard(
  state: TowerStatusState,
  caller: string,
  gate: readonly TowerStatusGate[],
  extras: TowerDashboardExtras,
): string {
  const sections: string[] = [
    `# Tower status — base: ${state.base} (mode: ${state.mode}), you are: ${caller}`,
    '',
    ...renderRecoveredAtWarning(state),
    ...renderObjectiveBlock(state, extras.objective),
    '## Missions',
    '',
    ...renderMissions(state),
    ...renderUnspawnedMissions(state, extras.objective?.settings),
    ...renderDeathWarnings(state, extras.runtimeAgent),
    '',
    '## Roster',
    '',
    ...renderRoster(state),
    '',
    '## Review gate (unmerged branches)',
    '',
    ...renderReviewGate(state, gate),
  ];
  if (
    state.missions.length > 0 &&
    state.missions.every((mission) => mission.status === 'merged' || mission.status === 'abandoned')
  ) {
    sections.push(
      '',
      '## Done',
      '',
      isObjectiveOpen(state.objective)
        ? `All missions are merged or abandoned, but objective ${state.objective?.id ?? '?'} is still ${state.objective?.status ?? 'open'} — validation, later milestones, or fix features follow; do not run TowerTeardown until the objective completes.`
        : 'All missions are merged or abandoned. Free the worktree checkouts now: run TowerTeardown (branches and .tower/comms/ are kept; dirty worktrees are protected).',
    );
  }
  sections.push(
    '',
    '## Inbox',
    '',
    `${String(extras.inboxCount)} message(s) visible to you — read with TowerInbox.`,
    '',
    '## Concurrency (adaptive)',
    '',
    renderConcurrency(extras.concurrency),
    '',
    '## Recent activity',
    '',
    ...(extras.recentActivity.length > 0 ? extras.recentActivity : ['(activity log is empty)']),
  );
  return sections.join('\n');
}

export function renderStateLostReport(): string {
  return [
    '# Tower status — STATE LOST',
    '',
    '.tower/comms/state.json is missing but the .tower/ directory still exists — this tower was initialized here before, and its comms state was deleted (e.g. by git clean). All recorded mission, roster, and review history is lost.',
    '',
    'Report this history loss to the user now — continuing silently would pretend the loss never happened.',
    '',
    'What still works:',
    '- TowerSend and TowerComplete recover a minimal state automatically (stamped recoveredAt, base taken from the current checkout branch) and keep delivering messages — worker reports are not lost.',
    '- TowerMerge and TowerRebase refuse with an explicit state-lost error instead of silently running against an empty history.',
    '- Mission branches and worktrees under .tower/worktrees survive on disk; re-plan from that evidence only after the user decides how to proceed.',
  ].join('\n');
}

function renderObjectiveBlock(
  state: TowerStatusState,
  extras: TowerDashboardObjectiveExtras | undefined,
): string[] {
  const objective = state.objective;
  if (objective === undefined) return [];
  const dashboard = renderObjectiveDashboard(state, objective, {
    activeAgentIds: extras?.activeAgentIds ?? new Set<string>(),
    skipKinds: extras === undefined ? [] : skippedValidationKinds(extras.settings),
  });
  return [dashboard.replaceAll(/^(#+) /gm, '#$1 '), ''];
}

function renderRecoveredAtWarning(state: TowerStatusState): string[] {
  if (state.recoveredAt === undefined) return [];
  return [
    '## ⚠️ State recovered after a loss',
    '',
    `This tower's state was reconstructed at ${state.recoveredAt} after .tower/comms/state.json was lost — every mission, roster entry, and review from before that point is gone, so the lists below are the recovered minimum, not reality. Report the history loss to the user before continuing routine orchestration.`,
    '',
  ];
}

function renderReviewGate(state: TowerStatusState, gate: readonly TowerStatusGate[]): string[] {
  const pending = state.missions.filter(
    (mission) => mission.status !== 'merged' && mission.status !== 'abandoned',
  );
  if (pending.length === 0) return ['(no open missions — or none planned yet)'];
  const lines: string[] = [];
  for (const missionGate of gate) {
    const review = missionGate.selectedReview;
    const reviewText =
      review === undefined
        ? ''
        : `; review=round ${String(review.round)} by ${review.reviewer} ${review.status}/${review.merge || 'legacy'} binding=${missionGate.reviewBinding ?? 'unavailable'}`;
    if (missionGate.ready) {
      lines.push(
        `- ${missionGate.branch} (${missionGate.missionId}): READY reasons=none${missionGate.noop ? '; zero-diff survey no-op, review skipped' : ''}${reviewText}`,
      );
      continue;
    }
    const reasons = missionGate.blocks.map((block) => block.reason).join(',');
    const details = missionGate.blocks
      .map((block) => block.message.replace(/^merge blocked: /, ''))
      .join(' | ');
    lines.push(
      `- ${missionGate.branch} (${missionGate.missionId}): BLOCKED reasons=${reasons}; ${details}${reviewText}`,
    );
  }
  return lines;
}

function renderConcurrency(snapshot: TowerStatusConcurrency): string {
  const budget = Number.isFinite(snapshot.budget) ? String(snapshot.budget) : 'unlimited';
  const parts = [`budget: ${budget} agent(s) · inflight: ${String(snapshot.inflight)}`];
  if (snapshot.blockedUntil !== null) {
    const remainingMs = snapshot.blockedUntil - Date.now();
    parts.push(
      remainingMs > 0
        ? `spawns PAUSED for ~${String(Math.ceil(remainingMs / 1000))}s (provider rate limit — successful requests lift the pause early)`
        : 'spawn pause expired — budget probing resumes',
    );
  } else {
    parts.push('spawns open');
  }
  return parts.join(' · ');
}

function renderMissions(state: TowerStatusState): string[] {
  if (state.missions.length === 0) return ['(no missions planned — use TowerPlan)'];
  return [
    '| ID | Mission | Branch | Worktree | Status | Owner |',
    '| -- | ------- | ------ | -------- | ------ | ----- |',
    ...state.missions.map(
      (m) =>
        `| ${m.id} | ${m.title}${m.kind === 'survey' ? ' 🔍' : ''} | ${m.branch} | ${m.worktree} | ${STATUS_EMOJI[m.status]} ${m.status} | ${m.owner ?? '—'} |`,
    ),
  ];
}

function renderRoster(state: TowerStatusState): string[] {
  if (state.roster.agents.length === 0) {
    return ['(no agents registered — spawn workers/reviewers with TowerSpawn)'];
  }
  return state.roster.agents.map((a) => {
    const assignment =
      a.kind === 'worker'
        ? `mission ${a.missionId ?? '?'} (branch ${a.branch ?? '?'}, worktree ${a.worktree ?? '?'})`
        : a.kind === 'validator'
          ? `${validatorAssignment(a)} (worktree ${a.worktree ?? '?'})`
          : `reviewing ${a.reviewTarget ?? '?'}`;
    const model = a.model === undefined ? '' : `, model ${a.model}`;
    const death = a.diedAt === undefined ? '' : ` — 💀 ${a.deathStatus ?? 'died'}`;
    return `- ${a.name} (${a.kind}) — agent ${a.agentId}, ${assignment}${model}${death}`;
  });
}

function renderUnspawnedMissions(
  state: TowerStatusState,
  settings: TowerObjectiveSettingsView | undefined,
): string[] {
  const pending = state.missions.filter((m) => m.status === 'planned' && m.owner === undefined);
  if (pending.length === 0) return [];
  return [
    '',
    '## Awaiting spawn',
    '',
    ...pending.map(
      (m) =>
        featureSpawnHint(m, state.objective, settings) ??
        `- ${m.id} (${m.branch}) — planned but no worker spawned yet: launch one with TowerSpawn(kind="worker", mission_id="${m.id}", name="...")`,
    ),
  ];
}

function featureSpawnHint(
  mission: TowerMission,
  objective: TowerObjective | undefined,
  settings: TowerObjectiveSettingsView | undefined,
): string | undefined {
  if (mission.milestone === undefined || objective === undefined || !isObjectiveOpen(objective)) {
    return undefined;
  }
  const head = `- ${mission.id} (${mission.branch}) — feature of ${mission.milestone}`;
  if (objective.status !== 'executing') {
    return `${head}: nothing starts while objective ${objective.id} is ${objective.status}`;
  }
  if (currentMilestone(objective)?.id !== mission.milestone) {
    return `${head}: it starts when ${mission.milestone} becomes the current milestone`;
  }
  if (settings?.autopilot === false) return undefined;
  return `${head}, the current milestone: the autopilot spawns its worker once its deps are merged or abandoned`;
}

function renderDeathWarnings(
  state: TowerStatusState,
  runtimeAgent: RuntimeAgentLookup | undefined,
): string[] {
  const deadByName = new Map(
    state.roster.agents.filter((a) => a.diedAt !== undefined).map((a) => [a.name, a]),
  );
  const lines: string[] = [];
  for (const mission of state.missions) {
    if (mission.owner === undefined) continue;
    if (mission.status === 'merged' || mission.status === 'abandoned') continue;
    const entry = deadByName.get(mission.owner);
    if (entry === undefined) continue;
    lines.push(
      isStoppedByUser(entry)
        ? `- 🛑 ${mission.id} owner ${entry.name} was stopped by the user (${entry.deathStatus ?? 'unknown'}) — dead by intent: never resume it and do not reassign the mission unless the human asks`
        : entry.kind === 'reviewer'
          ? `- ⚠️ ${mission.id} reviewer ${entry.name} died (${entry.deathStatus ?? 'unknown'}) — diagnose first: check the death status/reason and task state. A reviewer is one-shot: do not resume it or another roster agent; after diagnosis, spawn a fresh reviewer only if the mission still needs one`
          : `- ⚠️ ${mission.id} owner ${entry.name} died (${entry.deathStatus ?? 'unknown'}) — diagnose first: check why it died (the died entry's status/reason, its task state) before reviving anything. ${reviveHint(entry, runtimeAgent)} only when the cause is transient (lost contact, timeout, OOM); a systematic cause (code or environment defect) is fixed or escalated to the human before any revive`,
    );
  }
  if (lines.length === 0) return lines;
  return ['', '## Dead workers', '', ...lines];
}

function reviveHint(entry: TowerRosterEntry, runtimeAgent: RuntimeAgentLookup | undefined): string {
  if (runtimeAgent !== undefined) {
    const info = runtimeAgent(entry.agentId);
    if (info === undefined) {
      return 'Its run is not in this process (the tower restarted), so it cannot be resumed: spawn a fresh worker for the mission under a new name with TowerSpawn, or reassign the mission,';
    }
    if (info.windingDown) {
      return `Its stopped run is still winding down, so TowerResume refuses until it settles — then resume with TowerResume(agent="${entry.name}", prompt="...") (it always runs in the background) or reassign the mission`;
    }
  }
  return `Resume with TowerResume(agent="${entry.name}", prompt="...") (it always runs in the background) or reassign the mission`;
}

export function isStoppedByUser(entry: Pick<TowerRosterEntry, 'deathReason'>): boolean {
  return entry.deathReason?.trim() === HUMAN_STOP_REASON;
}
