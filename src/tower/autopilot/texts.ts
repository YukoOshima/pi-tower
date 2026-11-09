import {
  dedupeKey,
  digest,
  type AutopilotDecision,
  type AutopilotSnapshot,
  type AutopilotWakeOrchestrator,
} from '../../autopilot/index.ts';
import {
  contractRevisionOf,
  currentMilestone,
  failedValidationRounds,
  findMilestone,
  isOpenMission,
  latestValidationRound,
  milestoneMissions,
  objectiveMissions,
  requiredValidationKinds,
  roundContractRevision,
  sortedMilestones,
  TOWER_VALIDATION_KINDS,
  type TowerMilestone,
  type TowerMission,
  type TowerObjective,
  type TowerRosterEntry,
  type TowerState,
  type TowerValidationKind,
  type TowerValidationRound,
} from '../../protocol/index.ts';
import { formatDuration } from '../../prompts/objectiveFormat.ts';
import {
  blockerWake,
  featureAttemptsExhausted,
  fixRequest,
  mergeBlockedWake,
  objectiveBlockedNotice,
  objectiveCompletedNotice,
  planMilestoneRequest,
  rebaseConflictWake,
  reviewStuckWake,
  stallReevaluation,
  validationStuckWake,
  type StuckAgentAttempt,
} from '../../prompts/objectiveWakes.ts';
import {
  humanStoppedReviewer,
  humanStoppedValidator,
  isRebaseConflictBlocker,
  missionReviewerEntries,
  missionWorkerEntries,
  validationSettings,
  type AutopilotWorld,
} from './snapshot.ts';
import type { AutopilotRuntimeSettings, AutopilotValidatorKind } from './types.ts';

const RECENT_ATTEMPTS = 3;
const WORKER_TEXT_MAX_CHARS = 1_500;

export function blockedNoticeKey(objective: Pick<TowerObjective, 'id' | 'blockedReason'>): string {
  return `blocked-notice:${objective.id}:${digest(objective.blockedReason ?? '')}`;
}

export function completedNoticeKey(objective: Pick<TowerObjective, 'id'>): string {
  return `completed-notice:${objective.id}`;
}

function blockedMilestoneFailures(
  objective: TowerObjective,
  milestone: TowerMilestone,
  settings: Pick<AutopilotRuntimeSettings, 'skipScrutiny' | 'skipUserTesting'>,
): string[] {
  const revision = contractRevisionOf(objective);
  return requiredValidationKinds(objective, milestone, validationSettings(settings)).flatMap((kind) => {
    const round = latestValidationRound(milestone, kind, milestone.validationCommit, revision);
    return round?.verdict === 'fail' ? round.failures : [];
  });
}

export function blockedNoticeText(
  objective: TowerObjective,
  settings: Pick<AutopilotRuntimeSettings, 'skipScrutiny' | 'skipUserTesting'>,
): string {
  const milestone = objective.milestones.find((candidate) => candidate.status === 'blocked');
  const failures = milestone === undefined ? [] : blockedMilestoneFailures(objective, milestone, settings);
  return objectiveBlockedNotice({
    objective,
    reason: objective.blockedReason ?? `objective ${objective.id} is blocked`,
    ...(milestone === undefined ? {} : { milestone }),
    ...(failures.length === 0 ? {} : { failures }),
  });
}

export function completedNoticeText(input: {
  readonly objective: TowerObjective;
  readonly state: TowerState;
  readonly baseTip: string;
  readonly now: number;
}): string {
  const { objective, state } = input;
  const started = objective.startedAt === undefined ? Number.NaN : Date.parse(objective.startedAt);
  const ended = objective.completedAt === undefined ? input.now : Date.parse(objective.completedAt);
  const elapsedMs = Number.isNaN(started) || Number.isNaN(ended) ? undefined : Math.max(0, ended - started);
  return objectiveCompletedNotice({
    objective,
    milestones: objective.milestones,
    features: objectiveMissions({ ...state, objective }),
    base: state.base,
    baseTip: input.baseTip,
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    costUsd: objective.usage?.costUsd ?? 0,
  });
}

export function skipKinds(
  settings: Pick<AutopilotRuntimeSettings, 'skipScrutiny' | 'skipUserTesting'>,
): TowerValidationKind[] {
  return [
    ...(settings.skipScrutiny ? (['scrutiny'] as const) : []),
    ...(settings.skipUserTesting ? (['user-testing'] as const) : []),
  ];
}

export function rebaseConflictFiles(mission: Pick<TowerMission, 'blockers'>): string[] {
  const blocker = mission.blockers.find(isRebaseConflictBlocker);
  const match = blocker === undefined ? null : /conflicted in: (.+?) — /.exec(blocker);
  return match === null ? [] : match[1]!.split(', ').filter((file) => file.length > 0);
}

export function reviewFindingsResumePrompt(mission: Pick<TowerMission, 'id' | 'title' | 'branch'>): string {
  return [
    `review-findings: a reviewer sent findings for your mission ${mission.id} "${mission.title}" (branch ${mission.branch}), and the mission is active again.`,
    '1. Read every finding with TowerInbox, including the review file each one points to.',
    '2. Fix each finding on your branch — or, when you disagree with one, explain why to the tower with TowerSend — then re-run the tests and commit.',
    '3. Finish with TowerComplete: the autopilot spawns a fresh reviewer for the new tip.',
  ].join('\n');
}

export function rebaseConflictResumePrompt(
  mission: Pick<TowerMission, 'id' | 'blockers'>,
  base: string,
): string {
  const files = rebaseConflictFiles(mission);
  return [
    `rebase-conflict: the tower could not rebase your mission ${mission.id} onto ${base}${files.length > 0 ? ` — conflicts in ${files.join(', ')}` : ''}; the rebase was aborted and your worktree is back at its pre-rebase state.`,
    `Resolve it yourself as the blocker on your mission describes (TowerMission(id="${mission.id}")): run \`git rebase ${base}\`, fix the conflicts, \`git add\` the resolved files, continue with \`GIT_EDITOR=true git rebase --continue\`, re-run the tests, clear the blocker (TowerMission clear_blockers=true), then finish with TowerComplete so the moved tip gets a fresh review.`,
  ].join('\n');
}

export function continueResumePrompt(mission: Pick<TowerMission, 'id' | 'title' | 'branch' | 'kind'>): string {
  return [
    `continue: Read TowerInbox first — an answer may be waiting. Your mission ${mission.id} "${mission.title}" (branch ${mission.branch}) is still active, but you are idle without TowerComplete, a blocker or an unanswered message — a result or a question that is only in your final text reaches no one.`,
    `Check where you stopped with TowerMission(id="${mission.id}"), keep working until one of these applies, and end your turn with it:`,
    mission.kind === 'survey'
      ? '1. The investigation is done → finish with TowerComplete(report=the full result).'
      : '1. The work is done → run the tests, commit, and finish with TowerComplete(report) — the autopilot spawns a reviewer for the new tip.',
    `2. Something only others can give stops you (access, a decision outside your scope, a broken environment) → report it with TowerMission(id="${mission.id}", blocker="...").`,
    `3. The mission leaves substantive doubt about what to ${mission.kind === 'survey' ? 'investigate' : 'build'} → TowerSend(to="tower", subject="clarify-request", body=what needs pinning down), then end your turn; the answer comes back through your inbox.`,
    'Never stop silently.',
  ].join('\n');
}

function quotedTail(text: string, limit: number): string {
  const trimmed = text.trim();
  const tail = trimmed.length > limit ? `…${trimmed.slice(-limit)}` : trimmed;
  return tail
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function featureLabel(mission: Pick<TowerMission, 'id' | 'title' | 'branch' | 'milestone'>): string {
  const details = [...(mission.milestone === undefined ? [] : [`milestone ${mission.milestone}`]), `branch ${mission.branch}`];
  return `feature ${mission.id} "${mission.title}" (${details.join(', ')})`;
}

export function workerIdleWake(input: {
  readonly mission: Pick<TowerMission, 'id' | 'title' | 'branch' | 'milestone'>;
  readonly worker: string;
  readonly lastText?: string;
  readonly autopilot: boolean;
  readonly nudged: boolean;
}): string {
  const { mission, worker } = input;
  const lastText = input.lastText?.trim() ?? '';
  const situation = input.nudged
    ? ' A worker of this feature was already resumed once on this tip with a reminder to finish, report a blocker or ask — the autopilot does not resume the feature again until its tip moves.'
    : input.autopilot
      ? ''
      : ' With the autopilot off, nobody resumes it unless you do.';
  return [
    `worker-idle: worker ${worker} on ${featureLabel(mission)} is idle without TowerComplete, a blocker or an unanswered message, and the feature is still active.${situation}`,
    lastText.length > 0
      ? `Its last message:\n${quotedTail(lastText, WORKER_TEXT_MAX_CHARS)}`
      : `Its last message is not available here — read it with TowerTaskOutput(agent="${worker}").`,
    [
      'Decide what it needs:',
      `- It asked a question or waits for a decision → answer it with TowerSend(to="${worker}", ...) and resume it with TowerResume(agent="${worker}", prompt="...") — an idle worker reads its inbox only when resumed. If only the human can decide, ask the human; in a headless run decide yourself and record the decision with TowerObjective(action="update", note).`,
      `- It is stuck, confused or going in circles → reassign the feature: spawn a fresh worker with TowerSpawn(kind="worker", mission_id="${mission.id}") and instructions that name the problem — or, when the feature itself is ill-posed, abandon it with TowerMission(id="${mission.id}", status="abandoned") and re-plan it with TowerPlan.`,
      `- Only the human can unblock it → record a blocker with TowerMission(id="${mission.id}", blocker="...") or block the objective with TowerObjective(action="block", reason).`,
    ].join('\n'),
  ].join('\n\n');
}

export function workerStoppedWake(input: {
  readonly mission: Pick<TowerMission, 'id' | 'title' | 'branch' | 'milestone' | 'blockers'>;
  readonly worker: string;
}): string {
  const { mission, worker } = input;
  const files = rebaseConflictFiles(mission);
  const conflict = mission.blockers.some(isRebaseConflictBlocker)
    ? ` It also has an unresolved rebase conflict onto the base${files.length > 0 ? ` in ${files.join(', ')}` : ''}, which whoever continues it resolves first.`
    : '';
  return [
    `worker-stopped: the human stopped worker ${worker} on ${featureLabel(mission)}. The feature waits: the autopilot never resumes, reassigns or replaces an agent the human stopped.${conflict}`,
    [
      'Ask the human how to continue, then act only on the answer:',
      `- continue it → spawn a fresh worker with TowerSpawn(kind="worker", mission_id="${mission.id}") and instructions that carry the human's direction;`,
      `- change or drop it → abandon it with TowerMission(id="${mission.id}", status="abandoned") and re-plan the work with TowerPlan;`,
      '- stop here → block the objective with TowerObjective(action="block", reason).',
    ].join('\n'),
    'Never replace the stopped worker on your own. In a headless run nobody can answer: block the objective and name the stopped worker.',
  ].join('\n\n');
}

export function reviewerStoppedWake(input: {
  readonly mission: Pick<TowerMission, 'id' | 'title' | 'branch' | 'milestone'>;
  readonly reviewer: string;
  readonly tip?: string;
}): string {
  const { mission, reviewer } = input;
  return [
    `review-stuck: the human stopped reviewer ${reviewer} of ${featureLabel(mission)}${input.tip === undefined ? '' : ` on tip ${input.tip.slice(0, 7)}`} before it submitted a review. The review waits: the autopilot never replaces an agent the human stopped.`,
    [
      'Ask the human how to continue, then act only on the answer:',
      `- review it after all → spawn a fresh reviewer with TowerSpawn(kind="reviewer", review_target="${mission.branch}") under a new name;`,
      '- rework it first → tell the worker what to change with TowerSend, or TowerResume when it is idle; its next TowerComplete gets a fresh review;',
      `- drop or re-plan it → abandon ${mission.id} with TowerMission(id="${mission.id}", status="abandoned") and plan replacement features with TowerPlan;`,
      '- stop here → block the objective with TowerObjective(action="block", reason).',
    ].join('\n'),
    'Never spawn a replacement reviewer on your own. In a headless run nobody can answer: block the objective and name the stopped reviewer.',
  ].join('\n\n');
}

export function validatorStoppedWake(input: {
  readonly objective: Pick<TowerObjective, 'id' | 'title'>;
  readonly milestone: Pick<TowerMilestone, 'id' | 'title'>;
  readonly kind: AutopilotValidatorKind;
  readonly validator: string;
  readonly commit: string;
}): string {
  const { milestone, kind } = input;
  return [
    `validation-stuck: the human stopped validator ${input.validator} before it submitted a verdict — the ${kind} validation of milestone ${milestone.id} "${milestone.title}" on ${input.commit.slice(0, 7)} waits (objective ${input.objective.id} "${input.objective.title}"). The autopilot never replaces an agent the human stopped.`,
    [
      'Ask the human how to continue, then act only on the answer:',
      `- validate after all → spawn a fresh validator with TowerSpawn(kind="validator", milestone="${milestone.id}", validation_kind="${kind}") under a new name;`,
      `- fix something first → plan a fix feature with TowerPlan(milestone="${milestone.id}", origin="fix"); the validation runs again once it merges;`,
      "- change the milestone → TowerObjective(action=\"update\"); a contract change needs the human's approval again;",
      '- stop here → block the objective with TowerObjective(action="block", reason).',
    ].join('\n'),
    'Never start a replacement validator on your own. In a headless run nobody can answer: block the objective and name the stopped validator.',
  ].join('\n\n');
}

export function workerOutcome(world: AutopilotWorld, entry: TowerRosterEntry | undefined): string {
  if (entry === undefined) return 'no worker of it is known to this session — it was retired when the tower restarted';
  const observation = world.agent(entry.agentId);
  const status = observation?.status ?? entry.deathStatus ?? 'gone';
  const reason = observation?.stopReason ?? entry.deathReason;
  return `worker ${entry.name} ended (${status}${reason !== undefined && reason.trim().length > 0 ? `: ${reason.trim()}` : ''})`;
}

export function respawnReason(
  world: AutopilotWorld,
  mission: TowerMission,
  attempt: number,
  maxAttempts: number,
): string {
  const previous = missionWorkerEntries(world.state, mission).at(-1);
  return `autopilot respawn, attempt ${String(attempt)} of ${String(maxAttempts)}: ${workerOutcome(world, previous)} — continue mission ${mission.id} on its existing branch ${mission.branch} from where the history shows it stopped.`;
}

export function planningStallWake(objective: Pick<TowerObjective, 'id' | 'title'>, quietMs: number): string {
  return [
    `planning-stalled: objective ${objective.id} "${objective.title}" has been planning for ${formatDuration(quietMs)} without progress, and this is a headless run — nobody will answer questions.`,
    'Finish the plan now: decide open questions yourself and record them as assumptions with TowerObjective(action="update", notes=[...]); make sure the first milestone has at least one build feature (TowerPlan with milestone=<id>); then call TowerObjective(action="request-approval").',
    'If the objective cannot be planned at all, call TowerObjective(action="block", reason) with what is missing.',
  ].join('\n\n');
}

export function refusedActionRemedy(type: string): string {
  switch (type) {
    case 'spawn-worker':
    case 'respawn-worker':
    case 'resume-worker':
    case 'spawn-reviewer':
      return 'a concurrency budget or provider rate limit clears by itself as running agents finish; anything else (model configuration, worktree setup, an agent that cannot start) needs a fix — then do it yourself with TowerSpawn or TowerResume, or abandon the feature and re-plan it.';
    case 'rebase':
      return 'inspect the mission worktree (uncommitted changes, an unfinished rebase, a detached checkout) and fix it, or ask the worker to rebase with TowerSend; TowerRebase retries it.';
    case 'merge':
      return 'read the gate in TowerStatus and fix what blocks it (scope, base checkout, dependencies); TowerMerge retries it once the gate is ready.';
    case 'start-validation':
      return 'check the milestone with TowerObjective(action="status") — a validation needs every feature merged or abandoned and starts only on the current base tip. When the error names a validation worktree (.tower/worktrees/val-…), the tower already removes a stale registration by itself and retries on every tick; only a failure that persists, such as a locked worktree, needs `git worktree remove --force <path>` in the main checkout (unlock a locked one with `git worktree unlock <path>` first). Otherwise fix what the error names.';
    default:
      return 'check the objective with TowerObjective(action="status") and fix what the error names; if it cannot be fixed, block the objective with the reason.';
  }
}

export function refusedActionWake(input: {
  readonly type: string;
  readonly subject: string;
  readonly error: string;
  readonly attempts: number;
}): string {
  return [
    `autopilot-refused: the autopilot tried \`${input.type}\` for ${input.subject} on ${String(input.attempts)} consecutive ticks and it was refused every time with:`,
    input.error
      .trim()
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n'),
    `Remedy: ${refusedActionRemedy(input.type)}`,
    'The autopilot keeps retrying and continues by itself once the cause is gone. If it cannot be fixed, call TowerObjective(action="block", reason) with what the human must decide.',
  ].join('\n\n');
}

function recentAttempts(world: AutopilotWorld, entries: readonly TowerRosterEntry[]): StuckAgentAttempt[] {
  return entries.slice(-RECENT_ATTEMPTS).map((entry) => {
    const observation = world.agent(entry.agentId);
    const status = observation?.status ?? entry.deathStatus;
    const reason = observation?.stopReason ?? entry.deathReason;
    return {
      name: entry.name,
      ...(status === undefined ? {} : { status }),
      ...(reason === undefined ? {} : { reason }),
    };
  });
}

function failedRoundCounts(
  milestone: Parameters<typeof failedValidationRounds>[0],
): Partial<Record<TowerValidationKind, number>> {
  const counts: Partial<Record<TowerValidationKind, number>> = {};
  for (const kind of TOWER_VALIDATION_KINDS) {
    const count = failedValidationRounds(milestone, kind);
    if (count > 0) counts[kind] = count;
  }
  return counts;
}

function failingRoundsOf(
  objective: TowerObjective,
  rounds: readonly TowerValidationRound[],
  revision: string,
): TowerValidationRound[] {
  const contract = contractRevisionOf(objective);
  return revision.split('+').flatMap((token) => {
    const match = /^(.+)-r(\d+)$/.exec(token);
    if (match === null) return [];
    const found = rounds.find(
      (round) =>
        round.kind === match[1] && round.round === Number(match[2]) && roundContractRevision(round) === contract,
    );
    return found === undefined ? [] : [found];
  });
}

function fallbackWake(wake: AutopilotWakeOrchestrator): string {
  return `${wake.reason}: ${wake.detail}`;
}

export function orchestratorWakeText(
  world: AutopilotWorld,
  snapshot: AutopilotSnapshot,
  decision: AutopilotDecision,
  wake: AutopilotWakeOrchestrator,
): string {
  const { state } = world;
  const objective = state.objective;
  if (objective === undefined) return fallbackWake(wake);
  const mission = state.missions.find((candidate) => candidate.id === wake.subject);
  const maxAttempts = objective.limits.maxFeatureAttempts;
  switch (wake.reason) {
    case 'plan-milestone': {
      const ordered = sortedMilestones(objective);
      const index = ordered.findIndex((candidate) => candidate.id === wake.subject);
      const milestone = ordered[index];
      if (milestone === undefined) return fallbackWake(wake);
      const previous = index > 0 ? ordered[index - 1] : undefined;
      return planMilestoneRequest({
        objective,
        milestone,
        finalMilestone: index === ordered.length - 1,
        ...(previous === undefined ? {} : { previous }),
        skipKinds: skipKinds(world.settings),
      });
    }
    case 'validation-failed': {
      const milestone = findMilestone(objective, wake.subject);
      if (milestone === undefined) return fallbackWake(wake);
      const failedRounds = failingRoundsOf(objective, milestone.rounds, wake.revision);
      return fixRequest({
        objective,
        milestone,
        validatedCommit: failedRounds[0]?.validatedCommit ?? milestone.validationCommit ?? world.baseTip,
        failedRounds,
        failedRoundCounts: failedRoundCounts(milestone),
        maxValidationRounds: objective.limits.maxValidationRounds,
        openFixFeatures: milestoneMissions(state, milestone.id).filter(
          (feature) => isOpenMission(feature) && feature.origin === 'fix',
        ),
      });
    }
    case 'feature-attempts-exhausted':
      if (mission === undefined) return fallbackWake(wake);
      return featureAttemptsExhausted({
        feature: mission,
        attempts: mission.attempts ?? 0,
        maxAttempts,
        lastOutcome: workerOutcome(world, missionWorkerEntries(state, mission).at(-1)),
      });
    case 'rebase-conflict':
      if (mission === undefined) return fallbackWake(wake);
      return rebaseConflictWake({ feature: mission, files: rebaseConflictFiles(mission) });
    case 'blocker': {
      if (mission === undefined) return fallbackWake(wake);
      const worker = missionWorkerEntries(state, mission).at(-1);
      return blockerWake({
        feature: mission,
        agent: worker?.name ?? mission.owner ?? 'the worker',
        source: 'blocker',
        items: mission.blockers.filter((blocker) => !isRebaseConflictBlocker(blocker)),
      });
    }
    case 'merge-blocked': {
      if (mission === undefined) return fallbackWake(wake);
      const gate = world.gates.get(mission.id);
      const codes = wake.revision.slice(wake.revision.indexOf(':') + 1).split('+');
      return mergeBlockedWake({
        feature: mission,
        blocks: codes.map((code) => {
          const message = gate?.blocks.find((block) => block.reason === code)?.message;
          return { reason: code, ...(message === undefined ? {} : { message }) };
        }),
      });
    }
    case 'review-stuck': {
      if (mission === undefined) return fallbackWake(wake);
      const observed = snapshot.missions.find((candidate) => candidate.id === mission.id);
      const stopped = observed?.reviewerHumanStopped === true ? humanStoppedReviewer(world, mission, observed.tip) : undefined;
      if (stopped !== undefined) {
        return reviewerStoppedWake({
          mission,
          reviewer: stopped.name,
          ...(wake.revision === '-' ? {} : { tip: wake.revision }),
        });
      }
      return reviewStuckWake({
        feature: mission,
        ...(wake.revision === '-' ? {} : { tip: wake.revision }),
        attempts: observed?.reviewerAttemptsOnTip ?? 0,
        maxAttempts,
        recent: recentAttempts(world, missionReviewerEntries(state, mission)),
      });
    }
    case 'validation-stuck': {
      const separator = wake.subject.lastIndexOf(':');
      const milestone = findMilestone(objective, wake.subject.slice(0, separator));
      const kind = wake.subject.slice(separator + 1);
      if (milestone === undefined || (kind !== 'scrutiny' && kind !== 'user-testing')) return fallbackWake(wake);
      const entries = snapshot.validationAttempts.filter(
        (entry) => entry.milestone === milestone.id && entry.kind === kind && entry.commit === wake.revision,
      );
      const stopped = entries.some((entry) => entry.humanStopped)
        ? humanStoppedValidator(world, milestone.id, kind, wake.revision)
        : undefined;
      if (stopped !== undefined) {
        return validatorStoppedWake({ objective, milestone, kind, validator: stopped.name, commit: wake.revision });
      }
      const attempts = entries.reduce((sum, entry) => sum + entry.attempts, 0);
      return validationStuckWake({
        objective,
        milestone,
        validationKind: kind,
        validatedCommit: wake.revision,
        attempts,
        maxAttempts,
        recent: recentAttempts(
          world,
          state.roster.agents.filter(
            (entry) =>
              entry.kind === 'validator' &&
              entry.milestoneId === milestone.id &&
              entry.validationKind === kind &&
              entry.validatedCommit === wake.revision,
          ),
        ),
      });
    }
    case 'stalled': {
      const milestone = currentMilestone(objective);
      return stallReevaluation({
        objective,
        stalledForMs: decision.stall.idleMs,
        stallWakes: decision.stall.stallWakes,
        maxStallWakes: world.settings.maxStallWakes,
        ...(milestone === undefined ? {} : { milestone }),
        openFeatures: objectiveMissions(state).filter(isOpenMission),
      });
    }
    case 'worker-stopped':
      if (mission === undefined) return fallbackWake(wake);
      return workerStoppedWake({ mission, worker: wake.revision });
    case 'worker-idle': {
      if (mission === undefined) return fallbackWake(wake);
      const worker = missionWorkerEntries(state, mission).at(-1);
      const lastText = worker === undefined ? undefined : world.agent(worker.agentId)?.lastAssistantText;
      return workerIdleWake({
        mission,
        worker: worker?.name ?? mission.owner ?? 'the worker',
        ...(lastText === undefined ? {} : { lastText }),
        autopilot: snapshot.settings.autopilot,
        nudged: snapshot.memory.wakeKeys.includes(dedupeKey('resume-continue', mission.id, wake.revision)),
      });
    }
  }
}
