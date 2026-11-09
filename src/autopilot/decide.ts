import {
  compareIds,
  currentMilestone,
  depsSettled,
  finalMilestone,
  isClosed,
  latestRound,
  milestoneFeatures,
  milestoneRequiredKinds,
  runningAgents,
  sortedMilestones,
  sortedMissions,
  validationAttemptsOn,
  validationInFlight,
} from './derive.ts';
import { computeProgressKey, dedupeKey, digest } from './progress.ts';
import type {
  AutopilotAction,
  AutopilotAdvanceMilestone,
  AutopilotBlockObjective,
  AutopilotBlockReason,
  AutopilotCompleteObjective,
  AutopilotDecision,
  AutopilotMerge,
  AutopilotMilestone,
  AutopilotMission,
  AutopilotObjective,
  AutopilotRebase,
  AutopilotRespawnWorker,
  AutopilotResumeReason,
  AutopilotResumeWorker,
  AutopilotRound,
  AutopilotSnapshot,
  AutopilotSpawnReviewer,
  AutopilotSpawnWorker,
  AutopilotStall,
  AutopilotStartValidation,
  AutopilotValidationKind,
  AutopilotWakeOrchestrator,
  AutopilotWakeReason,
} from './types.ts';

export const AUTOPILOT_HANDLED_GATE_CODES: readonly string[] = [
  'not-completed',
  'worker-busy',
  'worker-unknown',
  'deps-unmerged',
  'stale-base',
  'blockers',
];

export const AUTOPILOT_REVIEW_GATE_CODES: readonly string[] = [
  'no-review',
  'tip-moved',
  'review-hold',
  'not-clean',
  'review-not-approved',
];

type WorkerAction = AutopilotResumeWorker | AutopilotRespawnWorker | AutopilotSpawnWorker;

interface Draft {
  readonly snapshot: AutopilotSnapshot;
  readonly objective: AutopilotObjective;
  readonly current: AutopilotMilestone | undefined;
  readonly sent: ReadonlySet<string>;
  free: number;
  readonly merges: AutopilotMerge[];
  readonly rebases: AutopilotRebase[];
  readonly reviewers: AutopilotSpawnReviewer[];
  readonly resumes: AutopilotResumeWorker[];
  readonly respawns: AutopilotRespawnWorker[];
  readonly spawns: AutopilotSpawnWorker[];
  readonly validations: AutopilotStartValidation[];
  readonly transitions: Array<AutopilotAdvanceMilestone | AutopilotCompleteObjective>;
  readonly wakes: AutopilotWakeOrchestrator[];
}

export function decideAutopilot(snapshot: AutopilotSnapshot): AutopilotDecision {
  const progressKey = computeProgressKey(snapshot);
  const objective = snapshot.objective;
  if (objective === undefined || objective.status !== 'executing') {
    return { actions: [], progressKey, stall: restingStall(snapshot) };
  }
  const pause = budgetPause(snapshot, objective);
  if (pause !== undefined) return { actions: [pause], progressKey, stall: restingStall(snapshot) };

  const current = currentMilestone(objective);
  const block = milestoneBlock(objective, current);
  if (block !== undefined) return { actions: [block], progressKey, stall: restingStall(snapshot) };

  const draft: Draft = {
    snapshot,
    objective,
    current,
    sent: new Set(snapshot.memory.wakeKeys),
    free: Math.max(0, snapshot.settings.maxRunningAgents - runningAgents(snapshot)),
    merges: [],
    rebases: [],
    reviewers: [],
    resumes: [],
    respawns: [],
    spawns: [],
    validations: [],
    transitions: [],
    wakes: [],
  };
  for (const feature of eligibleFeatures(draft)) planFeature(draft, feature);
  allocateAgentSlots(draft);
  planMilestone(draft);
  const { stall, block: stalledBlock } = watchdog(draft, progressKey);
  if (stalledBlock !== undefined) return { actions: [stalledBlock], progressKey, stall };
  return { actions: assemble(draft), progressKey, stall };
}

function restingStall(snapshot: AutopilotSnapshot): AutopilotStall {
  return { progressAt: snapshot.now, idleMs: 0, stalled: false, stallWakes: snapshot.memory.stallWakes };
}

function budgetPause(
  snapshot: AutopilotSnapshot,
  objective: AutopilotObjective,
): AutopilotAction | undefined {
  const { maxWallTimeMs, maxCostUsd } = objective.limits;
  if (maxWallTimeMs !== undefined && objective.startedAt !== undefined) {
    const elapsed = snapshot.now - objective.startedAt;
    if (elapsed >= maxWallTimeMs) {
      return {
        type: 'pause-objective',
        objective: objective.id,
        reason: 'max-wall-time',
        detail: `wall time ${String(elapsed)}ms reached the ${String(maxWallTimeMs)}ms limit`,
      };
    }
  }
  if (maxCostUsd !== undefined && objective.costUsd >= maxCostUsd) {
    return {
      type: 'pause-objective',
      objective: objective.id,
      reason: 'max-cost',
      detail: `cost $${String(objective.costUsd)} reached the $${String(maxCostUsd)} limit`,
    };
  }
  return undefined;
}

function blockAction(
  objective: AutopilotObjective,
  reason: AutopilotBlockReason,
  detail: string,
): AutopilotBlockObjective {
  return { type: 'block-objective', objective: objective.id, reason, detail };
}

function milestoneBlock(
  objective: AutopilotObjective,
  current: AutopilotMilestone | undefined,
): AutopilotBlockObjective | undefined {
  if (current?.status !== 'blocked') return undefined;
  return blockAction(objective, 'milestone-blocked', `milestone ${current.id} is blocked`);
}

function milestoneOrder(objective: AutopilotObjective, id: string | undefined): number | undefined {
  return objective.milestones.find((milestone) => milestone.id === id)?.order;
}

function eligibleFeatures(draft: Draft): AutopilotMission[] {
  const limit = draft.current?.order ?? Number.POSITIVE_INFINITY;
  return sortedMissions(draft.snapshot.missions).filter((mission) => {
    const order = milestoneOrder(draft.objective, mission.milestone);
    return order !== undefined && order <= limit && !isClosed(mission) && mission.status !== 'paused';
  });
}

function wake(
  draft: Draft,
  reason: AutopilotWakeReason,
  subject: string,
  revision: string,
  detail: string,
): void {
  const key = dedupeKey(reason, subject, revision);
  if (draft.sent.has(key) || draft.wakes.some((pending) => pending.key === key)) return;
  draft.wakes.push({ type: 'wake-orchestrator', reason, subject, revision, key, detail });
}

function planFeature(draft: Draft, feature: AutopilotMission): void {
  if (feature.blockers.length > 0) {
    wake(
      draft,
      'blocker',
      feature.id,
      digest(feature.blockers.join('\n')),
      `${feature.id} reported ${String(feature.blockers.length)} blocker(s): ${feature.blockers.join(' | ')}`,
    );
  }
  if (draft.current?.status === 'pending' && feature.milestone === draft.current.id) return;
  const autopilot = draft.snapshot.settings.autopilot;
  if (feature.gate.ready) {
    if (autopilot) draft.merges.push({ type: 'merge', mission: feature.id });
    return;
  }
  const staleBase = feature.gate.blocks.includes('stale-base');
  if (autopilot && staleBase && rebaseReady(feature)) {
    draft.rebases.push({ type: 'rebase', mission: feature.id });
  }
  if (!staleBase && reviewDue(feature)) planReviewer(draft, feature);
  planWorker(draft, feature);
  planMergeBlocked(draft, feature);
}

function planReviewer(draft: Draft, feature: AutopilotMission): void {
  const max = draft.objective.limits.maxFeatureAttempts;
  if (feature.reviewerAttemptsOnTip >= max) {
    wake(
      draft,
      'review-stuck',
      feature.id,
      feature.tip ?? '-',
      `${feature.id}: ${String(feature.reviewerAttemptsOnTip)} reviewer(s) for the current tip ended without a review (max ${String(max)})`,
    );
    return;
  }
  if (!draft.snapshot.settings.autopilot) return;
  draft.reviewers.push({ type: 'spawn-reviewer', mission: feature.id });
}

function rebaseReady(feature: AutopilotMission): boolean {
  return (
    feature.kind === 'build' &&
    feature.worker.state !== 'running' &&
    !feature.reviewerRunning &&
    !feature.rebaseConflict
  );
}

function reviewDue(feature: AutopilotMission): boolean {
  return (
    feature.kind === 'build' &&
    feature.status === 'completed' &&
    feature.reviewRequestOnTip &&
    !feature.reviewerRunning &&
    feature.latestReviewOnTip === undefined
  );
}

function needsWorker(feature: AutopilotMission): boolean {
  return (
    feature.status === 'planned' ||
    feature.status === 'active' ||
    (feature.status === 'blocked' && feature.rebaseConflict)
  );
}

function planWorker(draft: Draft, feature: AutopilotMission): void {
  const { worker } = feature;
  if (!needsWorker(feature) || worker.state === 'running') return;
  const autopilot = draft.snapshot.settings.autopilot;
  if (worker.humanStopped) {
    if (feature.rebaseConflict) wakeRebaseConflict(draft, feature);
    return;
  }
  if (worker.state === 'idle') {
    planResume(draft, feature);
    return;
  }
  const startable = feature.status !== 'planned' || depsSettled(draft.snapshot, feature);
  if (worker.state === 'none' && feature.attempts === 0) {
    if (autopilot && startable) draft.spawns.push({ type: 'spawn-worker', mission: feature.id });
    return;
  }
  const max = draft.objective.limits.maxFeatureAttempts;
  if (feature.attempts >= max) {
    wake(
      draft,
      'feature-attempts-exhausted',
      feature.id,
      String(feature.attempts),
      `${feature.id} used ${String(feature.attempts)} of ${String(max)} worker attempt(s) and has no live worker`,
    );
    return;
  }
  if (!autopilot) {
    if (feature.rebaseConflict) wakeRebaseConflict(draft, feature);
    return;
  }
  if (!startable) return;
  draft.respawns.push({
    type: 'respawn-worker',
    mission: feature.id,
    attempt: feature.attempts + 1,
    ...(worker.name === undefined ? {} : { previousWorker: worker.name }),
  });
}

function planResume(draft: Draft, feature: AutopilotMission): void {
  const { snapshot } = draft;
  const tip = feature.tip ?? '-';
  const conflict = feature.rebaseConflict;
  if (!conflict && (feature.status !== 'active' || !feature.worker.unreadFindings)) return;
  const reason: AutopilotResumeReason = conflict ? 'rebase-conflict' : 'review-findings';
  const revision = conflict ? `${tip}@${snapshot.baseTip}` : `${tip}#${String(snapshot.reviewCount)}`;
  const key = dedupeKey(`resume-${reason}`, feature.id, revision);
  const worker = feature.worker.name;
  if (!snapshot.settings.autopilot || worker === undefined || draft.sent.has(key)) {
    if (conflict) wakeRebaseConflict(draft, feature);
    return;
  }
  draft.resumes.push({ type: 'resume-worker', mission: feature.id, worker, reason, key });
}

function wakeRebaseConflict(draft: Draft, feature: AutopilotMission): void {
  wake(
    draft,
    'rebase-conflict',
    feature.id,
    `${feature.tip ?? '-'}@${draft.snapshot.baseTip}`,
    `${feature.id} has an unresolved rebase conflict onto the base and autopilot cannot route it to a worker`,
  );
}

function planMergeBlocked(draft: Draft, feature: AutopilotMission): void {
  if (feature.status !== 'completed' || feature.worker.state === 'running') return;
  if (feature.reviewerRunning) return;
  const reviewPending = reviewDue(feature);
  const stuck = feature.gate.blocks
    .filter(
      (code) =>
        !AUTOPILOT_HANDLED_GATE_CODES.includes(code) &&
        !(reviewPending && AUTOPILOT_REVIEW_GATE_CODES.includes(code)),
    )
    .sort();
  if (stuck.length === 0) return;
  wake(
    draft,
    'merge-blocked',
    feature.id,
    `${feature.tip ?? '-'}:${stuck.join('+')}`,
    `${feature.id} merge gate is blocked by ${stuck.join(', ')}`,
  );
}

function allocateAgentSlots(draft: Draft): void {
  for (const group of [draft.reviewers, draft.resumes, draft.respawns, draft.spawns]) {
    group.splice(draft.free);
    draft.free -= group.length;
  }
}

function planMilestone(draft: Draft): void {
  const { current, objective, snapshot } = draft;
  if (current === undefined) {
    planCompletion(draft);
    return;
  }
  if (current.status === 'pending') {
    const ordered = sortedMilestones(objective);
    const previous = ordered[ordered.indexOf(current) - 1];
    draft.transitions.push({
      type: 'advance-milestone',
      milestone: current.id,
      ...(previous === undefined ? {} : { from: previous.id }),
    });
  }
  const features = milestoneFeatures(snapshot, current.id);
  if (features.length === 0) {
    wake(
      draft,
      'plan-milestone',
      current.id,
      snapshot.baseTip,
      `milestone ${current.id} is current and has no features — plan them`,
    );
    return;
  }
  const kinds = milestoneRequiredKinds(objective, current, snapshot.settings);
  const failures = failingRounds(current, kinds, snapshot.baseTip);
  if (failures.length > 0) {
    const rounds = failures.map((round) => `${round.kind}-r${String(round.round)}`);
    wake(
      draft,
      'validation-failed',
      current.id,
      rounds.join('+'),
      `milestone ${current.id} failed validation (${rounds.join(', ')}) — plan fix features into ${current.id}`,
    );
    return;
  }
  if (current.status !== 'active' && current.status !== 'validating') return;
  if (features.some((feature) => !isClosed(feature))) return;
  planValidation(draft, current, kinds, false);
}

function failingRounds(
  milestone: AutopilotMilestone,
  kinds: readonly AutopilotValidationKind[],
  commit: string,
): AutopilotRound[] {
  const onCommit = milestone.status === 'failed' ? undefined : commit;
  const failures: AutopilotRound[] = [];
  for (const kind of kinds) {
    const round = latestRound(milestone, kind, onCommit);
    if (round?.verdict === 'fail') failures.push(round);
  }
  return failures;
}

function planValidation(
  draft: Draft,
  milestone: AutopilotMilestone,
  kinds: readonly AutopilotValidationKind[],
  restamp: boolean,
): void {
  const commit = draft.snapshot.baseTip;
  const max = draft.objective.limits.maxFeatureAttempts;
  const missing: AutopilotValidationKind[] = [];
  for (const kind of kinds) {
    if (latestRound(milestone, kind, commit) !== undefined) continue;
    if (validationInFlight(draft.snapshot, milestone.id, kind, commit)) continue;
    const attempts = validationAttemptsOn(draft.snapshot, milestone.id, kind, commit);
    if (attempts < max) {
      missing.push(kind);
      continue;
    }
    wake(
      draft,
      'validation-stuck',
      `${milestone.id}:${kind}`,
      commit,
      `${milestone.id} ${kind}: ${String(attempts)} validator run(s) on ${commit} ended without a verdict (max ${String(max)})`,
    );
  }
  const agents = missing.filter((kind) => kind !== 'commands').slice(0, draft.free);
  draft.free -= agents.length;
  const started = missing.filter((kind) => kind === 'commands' || agents.includes(kind));
  if (started.length === 0 && kinds.length > 0 && !restamp) return;
  draft.validations.push({ type: 'start-validation', milestone: milestone.id, commit, kinds: started });
}

function planCompletion(draft: Draft): void {
  const { objective, snapshot } = draft;
  const final = finalMilestone(objective);
  if (final === undefined) return;
  const ids = new Set(objective.milestones.map((milestone) => milestone.id));
  const open = snapshot.missions.some(
    (mission) => mission.milestone !== undefined && ids.has(mission.milestone) && !isClosed(mission),
  );
  if (open) return;
  const kinds = milestoneRequiredKinds(objective, final, snapshot.settings);
  const verdicts = kinds.map((kind) => latestRound(final, kind, snapshot.baseTip)?.verdict);
  const stamped = final.validationCommit === snapshot.baseTip;
  if (stamped && verdicts.includes('fail')) return;
  if (stamped && verdicts.every((verdict) => verdict === 'pass')) {
    draft.transitions.push({ type: 'complete-objective', objective: objective.id });
    return;
  }
  planValidation(draft, final, kinds, !stamped);
}

function assemble(draft: Draft): AutopilotAction[] {
  const workers: WorkerAction[] = [...draft.resumes, ...draft.respawns, ...draft.spawns].sort(
    (a, b) => compareIds(a.mission, b.mission),
  );
  return [
    ...draft.merges.slice(0, 1),
    ...draft.rebases,
    ...draft.reviewers,
    ...workers,
    ...draft.validations,
    ...draft.transitions,
    ...draft.wakes,
  ];
}

function watchdog(
  draft: Draft,
  progressKey: string,
): { readonly stall: AutopilotStall; readonly block?: AutopilotBlockObjective } {
  const { snapshot, objective } = draft;
  const { memory, settings, now } = snapshot;
  const progressed = memory.progressKey !== progressKey;
  const live =
    runningAgents(snapshot) > 0 || snapshot.validators.length > 0 || snapshot.orchestratorBusy;
  const clock = progressed || live ? now : (memory.progressAt ?? now);
  const stallWakes = progressed ? 0 : memory.stallWakes;
  const idleMs = now - clock;
  const stalled = !progressed && !live && idleMs >= settings.stallTimeoutMs;
  if (!stalled) return { stall: { progressAt: clock, idleMs, stalled, stallWakes } };
  if (stallWakes >= settings.maxStallWakes) {
    const detail = `no progress after ${String(stallWakes)} stall wake(s); quiet for ${String(idleMs)}ms`;
    return {
      stall: { progressAt: clock, idleMs, stalled, stallWakes },
      block: blockAction(objective, 'stalled', detail),
    };
  }
  const due = assemble(draft).length;
  wake(
    draft,
    'stalled',
    objective.id,
    `${progressKey}#${String(stallWakes + 1)}@${String(clock)}`,
    `no progress for ${String(idleMs)}ms with no live agent; ${String(due)} due action(s) are not taking effect (stall wake ${String(stallWakes + 1)} of ${String(settings.maxStallWakes)})`,
  );
  return { stall: { progressAt: now, idleMs, stalled, stallWakes: stallWakes + 1 } };
}
