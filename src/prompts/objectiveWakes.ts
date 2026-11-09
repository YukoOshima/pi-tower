import {
  VALIDATION_KINDS,
  describeValidation,
  formatDuration,
  formatUsd,
  latestRound,
  numberedList,
  requiredValidationKinds,
  shortCommit,
} from './objectiveFormat.ts';
import type {
  PromptFeature,
  PromptMilestone,
  PromptObjectiveContract,
  PromptValidationKind,
  PromptValidationRound,
  PromptValidatorKind,
} from './objectiveTypes.ts';

export type ObjectiveRef = Pick<PromptObjectiveContract, 'id' | 'title'>;
export type MilestoneRef = Pick<PromptMilestone, 'id' | 'title'>;
export type FeatureRef = Pick<PromptFeature, 'id' | 'title' | 'branch' | 'milestone'>;

export interface ValidationResultWakeInput {
  readonly objective: ObjectiveRef;
  readonly milestone: MilestoneRef;
  readonly result: PromptValidationRound;
  readonly pendingKinds?: readonly PromptValidationKind[];
}

export interface FixRequestInput {
  readonly objective: ObjectiveRef;
  readonly milestone: MilestoneRef;
  readonly validatedCommit: string;
  readonly failedRounds: readonly PromptValidationRound[];
  readonly failedRoundCounts: Readonly<Partial<Record<PromptValidationKind, number>>>;
  readonly maxValidationRounds: number;
  readonly openFixFeatures?: readonly Pick<PromptFeature, 'id' | 'title' | 'status'>[];
}

export interface PlanMilestoneRequestInput {
  readonly objective: Pick<
    PromptObjectiveContract,
    'id' | 'title' | 'goal' | 'definitionOfDone' | 'acceptanceCommands'
  >;
  readonly milestone: Pick<PromptMilestone, 'id' | 'title' | 'description' | 'validation'>;
  readonly finalMilestone: boolean;
  readonly previous?: MilestoneRef;
  readonly skipKinds?: readonly PromptValidationKind[];
}

export interface StallReevaluationInput {
  readonly objective: ObjectiveRef;
  readonly stalledForMs: number;
  readonly stallWakes: number;
  readonly maxStallWakes: number;
  readonly milestone?: Pick<PromptMilestone, 'id' | 'title' | 'status'>;
  readonly openFeatures?: readonly Pick<PromptFeature, 'id' | 'title' | 'status'>[];
}

export interface FeatureAttemptsExhaustedInput {
  readonly feature: FeatureRef;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastOutcome?: string;
}

export interface RebaseConflictWakeInput {
  readonly feature: FeatureRef & Pick<PromptFeature, 'owner'>;
  readonly files: readonly string[];
}

export interface BlockerWakeInput {
  readonly feature: FeatureRef;
  readonly agent: string;
  readonly source: 'blocker' | 'question';
  readonly items: readonly string[];
}

export interface MergeBlockedWakeInput {
  readonly feature: FeatureRef & Pick<PromptFeature, 'owner'>;
  readonly blocks: readonly { readonly reason: string; readonly message?: string }[];
}

export interface StuckAgentAttempt {
  readonly name: string;
  readonly status?: string;
  readonly reason?: string;
}

export interface ReviewStuckWakeInput {
  readonly feature: FeatureRef & { readonly branch: string };
  readonly tip?: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly recent?: readonly StuckAgentAttempt[];
}

export interface ValidationStuckWakeInput {
  readonly objective: ObjectiveRef;
  readonly milestone: MilestoneRef;
  readonly validationKind: PromptValidatorKind;
  readonly validatedCommit: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly recent?: readonly StuckAgentAttempt[];
}

export interface BudgetPausedNoticeInput {
  readonly objective: ObjectiveRef;
  readonly limit: 'cost' | 'wall-time';
  readonly costUsd?: number;
  readonly maxCostUsd?: number;
  readonly elapsedMs?: number;
  readonly maxWallTimeMs?: number;
}

export interface ObjectiveCompletedNoticeInput {
  readonly objective: Pick<PromptObjectiveContract, 'id' | 'title' | 'definitionOfDone'>;
  readonly milestones: readonly Pick<PromptMilestone, 'id' | 'title' | 'order' | 'rounds'>[];
  readonly features: readonly Pick<PromptFeature, 'status' | 'origin'>[];
  readonly base: string;
  readonly baseTip: string;
  readonly elapsedMs?: number;
  readonly costUsd?: number;
}

export interface ObjectiveBlockedNoticeInput {
  readonly objective: ObjectiveRef;
  readonly reason: string;
  readonly milestone?: Pick<PromptMilestone, 'id' | 'title' | 'status'>;
  readonly failures?: readonly string[];
}

export interface ApprovalRequestInput {
  readonly objective: PromptObjectiveContract;
  readonly milestones: readonly Pick<
    PromptMilestone,
    'id' | 'title' | 'description' | 'order' | 'validation'
  >[];
  readonly features: readonly Pick<PromptFeature, 'id' | 'title' | 'milestone'>[];
  readonly approvalReason?: string;
  readonly notes?: readonly string[];
  readonly skipKinds?: readonly PromptValidationKind[];
}

export function validationResultWake(input: ValidationResultWakeInput): string {
  const { result, milestone } = input;
  const failed = result.verdict === 'fail';
  const verdict = failed ? `FAIL with ${countLabel(result.failures.length, 'failure')}` : 'pass';
  const lines = [
    `validation-result: ${milestoneLabel(milestone)} — ${result.kind} round ${String(result.round)} by ${result.validator}: ${verdict} on ${shortCommit(result.validatedCommit)} (${objectiveLabel(input.objective)}).`,
  ];
  if (result.file !== undefined) lines.push(`Report: ${result.file}`);
  if (failed && result.failures.length > 0) lines.push('', numberedList(result.failures));
  const pending = input.pendingKinds ?? [];
  lines.push('');
  if (!failed) {
    lines.push(
      pending.length > 0
        ? `Still running on this commit: ${pending.join(', ')}. Nothing to do yet — the milestone passes once every required kind passes on the same commit; end your turn.`
        : 'Nothing to do — the milestone passes once every required kind passes on the same commit, and the next milestone then becomes current; end your turn.',
    );
    return lines.join('\n');
  }
  lines.push(
    `${capitalize(milestoneLabel(milestone))} failed on this commit. Fix features are planned from the validation-failed wake (it carries every failing round), not from this message; if fixes for these failures are already planned, do nothing.`,
  );
  if (pending.length > 0) {
    lines.push(`Still running on this commit: ${pending.join(', ')} — their results arrive separately.`);
  }
  return lines.join('\n');
}

export function fixRequest(input: FixRequestInput): string {
  const { milestone, maxValidationRounds } = input;
  const sections = [
    `validation-failed: ${milestoneLabel(milestone)} failed validation on ${shortCommit(input.validatedCommit)} (${objectiveLabel(input.objective)}).`,
    ['## Failures', ...input.failedRounds.map(failedRoundBlock)].join('\n\n'),
    [
      `## Next step — plan fix features into ${milestone.id}`,
      '1. Read every failure (open the report file when you need the evidence) and find its cause — fix causes, not symptoms.',
      `2. Call TowerPlan with milestone="${milestone.id}" and origin="fix" on every item: one feature per failure or per tightly related group, each failure quoted verbatim in the feature's tasks so its worker and reviewer can verify the fix, with disjoint scopes so the fixes run in parallel.`,
      '3. Planning into the failed milestone reopens it; the autopilot spawns the fix workers (with the autopilot off, spawn them yourself with TowerSpawn), and validation re-runs automatically on the new base tip once every fix is merged or abandoned.',
      '4. If a failure shows that the contract itself is wrong (definition of done, acceptance commands, or a validation spec), change it with TowerObjective(action="update") instead — the human must approve it again. If the failures cannot be fixed as specified, call TowerObjective(action="block", reason) with what the human must decide.',
    ].join('\n'),
  ];
  const counts = VALIDATION_KINDS.flatMap((kind) => {
    const count = input.failedRoundCounts[kind] ?? 0;
    return count > 0 ? [`${kind} ${String(count)} of ${String(maxValidationRounds)}`] : [];
  });
  if (counts.length > 0) {
    sections.push(
      `Failed rounds so far: ${counts.join(', ')}. When one kind reaches ${String(maxValidationRounds)} failed rounds, the milestone and the objective block — make these fixes complete.`,
    );
  }
  const open = input.openFixFeatures ?? [];
  if (open.length > 0) {
    sections.push(
      [
        'Fix features already planned and still open — do not plan a second feature for a failure they cover:',
        ...open.map((feature) => `- ${feature.id} "${feature.title}" (${feature.status})`),
      ].join('\n'),
    );
  }
  sections.push('Then end your turn.');
  return sections.join('\n\n');
}

export function planMilestoneRequest(input: PlanMilestoneRequestInput): string {
  const { milestone, objective } = input;
  const acceptance = input.finalMilestone ? objective.acceptanceCommands : [];
  const description = milestone.description?.trim();
  const qa = milestone.validation.qaInstructions?.trim();
  const opening =
    `plan-milestone: ${milestoneLabel(milestone)} is now current but has no features (${objectiveLabel(objective)}).` +
    (input.previous !== undefined ? ` ${capitalize(milestoneLabel(input.previous))} passed validation.` : '');
  const about = [
    `## ${milestone.id}: ${milestone.title}`,
    ...(description !== undefined && description.length > 0 ? [description] : []),
    `Validation: ${describeValidation(milestone.validation, acceptance, input.skipKinds)}`,
    ...(qa !== undefined &&
    qa.length > 0 &&
    requiredValidationKinds(milestone.validation, acceptance, input.skipKinds).includes('user-testing')
      ? [`QA instructions: ${qa}`]
      : []),
    ...(input.finalMilestone
      ? ['This is the final milestone: together with the earlier milestones it must deliver the whole definition of done.']
      : []),
  ].join('\n');
  const contract = [
    '## Objective',
    `Goal: ${objective.goal.trim()}`,
    'Definition of done:',
    numberedList(objective.definitionOfDone),
  ].join('\n');
  const next = [
    '## Next step',
    `Plan its features now with TowerPlan, passing milestone="${milestone.id}" on every item: verifiable tasks that together deliver this milestone's part of the definition of done, disjoint scopes so the features run in parallel, and explicit deps only for real ordering. The autopilot spawns the workers as soon as the features are planned (with the autopilot off, spawn them yourself with TowerSpawn) — then end your turn.`,
    "If this milestone turns out unnecessary or wrong, change the plan with TowerObjective(action=\"update\"); removing or reordering milestones needs the human's approval again.",
  ].join('\n');
  return [opening, about, contract, next].join('\n\n');
}

export function stallReevaluation(input: StallReevaluationInput): string {
  const open = input.openFeatures ?? [];
  const facts = [
    `stalled: ${objectiveLabel(input.objective)} has made no progress for ${formatDuration(input.stalledForMs)} — no agent is running and nothing changed (stall wake ${String(input.stallWakes)} of ${String(input.maxStallWakes)}).`,
    ...(input.milestone !== undefined
      ? [`Current milestone: ${input.milestone.id} "${input.milestone.title}" (${input.milestone.status}).`]
      : []),
    open.length > 0
      ? `Open features: ${open.map((feature) => `${feature.id} "${feature.title}" (${feature.status})`).join(', ')}.`
      : 'Open features: none.',
  ];
  return [
    facts.join('\n'),
    [
      'Re-evaluate now instead of waiting:',
      '- Find what waits on you: unread inbox messages (TowerInbox), a blocked feature or an unanswered question, a merge block, a planned feature that never started, or a current milestone without features. TowerObjective(action="status") and TowerStatus give the full picture.',
      '- Act on it: answer, re-plan, unblock, or route — whatever moves the objective forward.',
      '- If nothing can move it, call TowerObjective(action="block", reason) with what the human must decide.',
    ].join('\n'),
    `After ${String(input.maxStallWakes)} stall wakes without progress the objective blocks automatically.`,
  ].join('\n\n');
}

export function featureAttemptsExhausted(input: FeatureAttemptsExhaustedInput): string {
  const { feature } = input;
  const outcome = input.lastOutcome?.trim();
  return [
    [
      `feature-attempts-exhausted: ${featureLabel(feature)} used ${String(input.attempts)} of ${String(input.maxAttempts)} worker attempts without finishing — the autopilot will not spawn another worker for it.`,
      ...(outcome !== undefined && outcome.length > 0 ? [`Last outcome: ${sentence(outcome)}`] : []),
    ].join('\n'),
    [
      `Diagnose before deciding: read the mission (TowerMission(id="${feature.id}")), the last worker's output (TowerTaskOutput), and the branch's review history. Then choose one:`,
      `- the cause is fixed or was transient → spawn a fresh worker with TowerSpawn(kind="worker", mission_id="${feature.id}") and instructions that name the cause;`,
      `- the feature is too big or ill-posed → abandon it with TowerMission(id="${feature.id}", status="abandoned") and plan smaller replacement features into ${feature.milestone ?? 'its milestone'} with TowerPlan;`,
      '- only the human can resolve it → call TowerObjective(action="block", reason) and say what they must decide.',
    ].join('\n'),
  ].join('\n\n');
}

export function rebaseConflictWake(input: RebaseConflictWakeInput): string {
  const { feature } = input;
  const owner = feature.owner;
  const sections = [
    `rebase-conflict: ${featureLabel(feature)} conflicts with the base after other features merged — the rebase was aborted and the mission is blocked.`,
  ];
  if (input.files.length > 0) {
    sections.push(`Conflicting files:\n${input.files.map((file) => `- ${file}`).join('\n')}`);
  }
  sections.push(
    [
      owner !== undefined
        ? `The owning worker ${owner} resolves textual conflicts in its own worktree (the autopilot resumes it when it is idle; with the autopilot off, resume it yourself with TowerResume). Your part is the judgment:`
        : `No worker owns this feature any more: spawn one with TowerSpawn(kind="worker", mission_id="${feature.id}") and instructions to rebase onto the base and resolve the conflicts. Your part is the judgment:`,
      `- The features disagree (both changed the same behaviour differently) → decide which side wins and tell ${owner ?? 'the worker'} with TowerSend — it is steered into a running turn or read on the next resume.`,
      '- The features overlap by design (both need the same files) → decide which feature owns what, then re-plan the scope or add a dep so they merge in order.',
      'Never work around the merge gate.',
    ].join('\n'),
  );
  return sections.join('\n\n');
}

export function blockerWake(input: BlockerWakeInput): string {
  const { feature, agent } = input;
  return [
    [
      `blocker: ${agent} on ${featureLabel(feature)} ${input.source === 'question' ? 'asked a question' : 'reported a blocker'}:`,
      ...input.items.map((item) => `- ${item.trim()}`),
    ].join('\n'),
    [
      "Answer it from the objective — goal, definition of done, notes — and the human's own words:",
      `- Reply with TowerSend(to="${agent}", ...): it is steered into the worker's running turn; if the worker has no running turn, deliver the answer with TowerResume(agent="${agent}", prompt="...").`,
      `- Once it can continue, the worker clears its blocker — or clear it yourself with TowerMission(id="${feature.id}", clear_blockers=true).`,
      '- If only the human can decide, ask the human in your reply and end your turn; in a headless run decide yourself, record the decision with TowerObjective(action="update", note), and answer the worker.',
      '- If the question exposes a gap in the plan, fix the plan (TowerPlan, TowerObjective update) instead of improvising in the answer.',
    ].join('\n'),
  ].join('\n\n');
}

export function mergeBlockedWake(input: MergeBlockedWakeInput): string {
  const { feature } = input;
  const reasons = [...new Set(input.blocks.map((block) => block.reason))];
  const guidance = reasons.flatMap((reason) => {
    const advice = MERGE_BLOCK_GUIDANCE[reason];
    return advice !== undefined ? [advice(feature.id)] : [];
  });
  return [
    [
      `merge-blocked: ${featureLabel(feature)} cannot merge — the gate is blocked for a reason the autopilot cannot fix: ${reasons.join(', ')}.`,
      ...input.blocks.map(
        (block) => `- ${block.reason}${block.message !== undefined ? `: ${block.message}` : ''}`,
      ),
    ].join('\n'),
    [
      'Decide and act:',
      ...guidance,
      `- Anything else → follow the gate message; TowerStatus shows the full gate state of ${feature.id}.`,
      'Never merge around the gate: once it is ready, the autopilot merges (with the autopilot off, merge with TowerMerge).',
    ].join('\n'),
  ].join('\n\n');
}

export function reviewStuckWake(input: ReviewStuckWakeInput): string {
  const { feature } = input;
  const tip = input.tip !== undefined ? ` on tip ${shortCommit(input.tip)}` : '';
  return [
    [
      `review-stuck: ${featureLabel(feature)} is stuck in review — ${String(input.attempts)} of ${String(input.maxAttempts)} reviewers ended without submitting a review${tip}; the tower will not spawn another reviewer by itself.`,
      ...attemptLines(input.recent ?? []),
    ].join('\n'),
    [
      'Inspect, then act:',
      '1. Find out why the reviewers ended without TowerReview: the reasons above, their final messages (TowerTaskOutput), and TowerTasks with active_only=false — look for crashes, timeouts, rate limits, or a diff too large to review in one run.',
      `2. Transient cause → spawn a fresh reviewer with TowerSpawn(kind="reviewer", review_target="${feature.branch}") under a new name.`,
      `3. The diff is too large or tangled to review → have the worker simplify it (TowerSend, or TowerResume when it is idle), or split the feature: abandon ${feature.id} with TowerMission(id="${feature.id}", status="abandoned") and plan smaller replacement features into ${feature.milestone ?? 'its milestone'} with TowerPlan.`,
      '4. Nothing works → call TowerObjective(action="block", reason) with what the human must decide.',
    ].join('\n'),
  ].join('\n\n');
}

export function validationStuckWake(input: ValidationStuckWakeInput): string {
  const { milestone, validationKind } = input;
  return [
    [
      `validation-stuck: the ${validationKind} validation of ${milestoneLabel(milestone)} on ${shortCommit(input.validatedCommit)} is stuck — ${String(input.attempts)} of ${String(input.maxAttempts)} validators ended without a verdict (${objectiveLabel(input.objective)}); the tower will not start another one by itself.`,
      ...attemptLines(input.recent ?? []),
    ].join('\n'),
    [
      'Inspect, then act:',
      '1. Find out why the validators ended without TowerValidate: the reasons above, their final messages (TowerTaskOutput), and TowerTasks with active_only=false — look for crashes, timeouts, a validation worktree that cannot build or start the product, or a milestone too large to validate in one run.',
      `2. Transient cause → spawn a fresh validator with TowerSpawn(kind="validator", milestone="${milestone.id}", validation_kind="${validationKind}") under a new name.`,
      `3. The product cannot build or start on this commit → plan a fix feature into ${milestone.id} with TowerPlan(milestone="${milestone.id}", origin="fix"); validation re-runs automatically once it merges.`,
      "4. The milestone is too large or too vague to validate in one run → simplify or split it with TowerObjective(action=\"update\") — clearer qa_instructions or smaller milestones; contract changes need the human's approval again.",
      '5. Nothing works → call TowerObjective(action="block", reason) with what the human must decide.',
    ].join('\n'),
  ].join('\n\n');
}

export function budgetPausedNotice(input: BudgetPausedNoticeInput): string {
  const usage =
    input.limit === 'cost'
      ? `its cost budget is used up — ${formatUsd(input.costUsd ?? 0)} spent of ${input.maxCostUsd !== undefined ? formatUsd(input.maxCostUsd) : 'the limit'} (tower.json "objective" → maxCostUsd)`
      : `its wall-time limit is reached — ${formatDuration(input.elapsedMs ?? 0)} elapsed of ${input.maxWallTimeMs !== undefined ? formatDuration(input.maxWallTimeMs) : 'the limit'} (tower.json "objective" → maxWallTimeMs)`;
  return [
    `${capitalize(objectiveLabel(input.objective))} is paused: ${usage}.`,
    'No new agents start while it is paused; merged work, open branches, and the validation history are kept.',
    'To continue, raise or remove the limit in tower.json, then run /tower resume. To stop here, leave it paused.',
  ].join('\n');
}

export function objectiveCompletedNotice(input: ObjectiveCompletedNoticeInput): string {
  const milestones = [...input.milestones]
    .sort((a, b) => a.order - b.order)
    .map((milestone) => `- ${milestone.id} "${milestone.title}" — passed (${passedRounds(milestone.rounds)})`);
  const merged = input.features.filter((feature) => feature.status === 'merged');
  const fixes = merged.filter((feature) => feature.origin === 'fix').length;
  const abandoned = input.features.filter((feature) => feature.status === 'abandoned').length;
  const totals = [
    `Features: ${String(merged.length)} merged${fixes > 0 ? ` (${String(fixes)} fix)` : ''}${abandoned > 0 ? `, ${String(abandoned)} abandoned` : ''}.`,
    ...(input.elapsedMs !== undefined ? [`Elapsed: ${formatDuration(input.elapsedMs)}.`] : []),
    ...(input.costUsd !== undefined ? [`Cost: ${formatUsd(input.costUsd)}.`] : []),
  ];
  return [
    `${capitalize(objectiveLabel(input.objective))} is complete: every milestone passed validation, and the final validation ran on ${input.base} at ${shortCommit(input.baseTip)}.`,
    milestones.join('\n'),
    totals.join(' '),
    `Definition of done, verified by the validators:\n${numberedList(input.objective.definitionOfDone)}`,
    `The result is on ${input.base}. /tower teardown removes the mission worktrees (branches and .tower/comms/ stay as the audit trail); /tower objective starts the next objective.`,
  ]
    .filter((section) => section.length > 0)
    .join('\n\n');
}

export function objectiveBlockedNotice(input: ObjectiveBlockedNoticeInput): string {
  const { milestone } = input;
  const failures = input.failures ?? [];
  const sections = [
    `${capitalize(objectiveLabel(input.objective))} is blocked: ${sentence(input.reason)}` +
      (milestone !== undefined ? `\nMilestone ${milestone.id} "${milestone.title}" is ${milestone.status}.` : ''),
  ];
  if (failures.length > 0) sections.push(`Latest failures:\n${numberedList(failures)}`);
  sections.push(
    'No new work starts while it is blocked; merged work and open branches are kept. Decide how to continue: tell the orchestrator what to change or answer what it needs, then run /tower resume (resuming also resets the stall counters) — or leave the objective blocked.',
  );
  return sections.join('\n\n');
}

export function estimateObjectiveRuns(featureCount: number, milestoneCount: number): number {
  return featureCount + 2 * milestoneCount;
}

export function approvalRequest(input: ApprovalRequestInput): string {
  const { objective } = input;
  const milestones = [...input.milestones].sort((a, b) => a.order - b.order);
  const planIds = new Set(milestones.map((milestone) => milestone.id));
  const features = input.features.filter(
    (feature) => feature.milestone !== undefined && planIds.has(feature.milestone),
  );
  const finalId = milestones.at(-1)?.id;
  const notes = input.notes ?? [];
  const reason =
    input.approvalReason === 'contract-changed'
      ? ' The contract changed after approval, so the plan needs your approval again.'
      : input.approvalReason !== undefined
        ? ` Approval reason: ${input.approvalReason}.`
        : '';
  const sections = [
    `${capitalize(objectiveLabel(objective))} is ready for your approval.${reason}`,
    `Goal: ${objective.goal.trim()}`,
    `Definition of done:\n${numberedList(objective.definitionOfDone)}`,
  ];
  if (objective.acceptanceCommands.length > 0) {
    sections.push(
      `Acceptance commands (run on the final milestone): ${objective.acceptanceCommands.map((command) => `\`${command}\``).join(', ')}`,
    );
  }
  sections.push(
    [
      'Milestones — in order; the features inside a milestone run in parallel:',
      ...milestones.map((milestone, index) =>
        milestonePlan(
          milestone,
          index,
          features.filter((feature) => feature.milestone === milestone.id),
          milestone.id === finalId ? objective.acceptanceCommands : [],
          input.skipKinds ?? [],
        ),
      ),
    ].join('\n'),
  );
  if (notes.length > 0) sections.push(`Assumptions and notes:\n${notes.map((note) => `- ${note.trim()}`).join('\n')}`);
  sections.push(
    `Estimated runs: ≈ ${String(estimateObjectiveRuns(features.length, milestones.length))} (${countLabel(features.length, 'feature')} + 2 × ${countLabel(milestones.length, 'milestone')}). This is a floor, not a ceiling: failed validations add fix features and further validation rounds.`,
    'To approve, run: /tower approve\nOnly you can approve — the orchestrator cannot. To change the plan, tell the orchestrator what to change; it updates the plan and asks for approval again.',
  );
  return sections.join('\n\n');
}

function milestonePlan(
  milestone: Pick<PromptMilestone, 'id' | 'title' | 'description' | 'validation'>,
  index: number,
  features: readonly Pick<PromptFeature, 'id' | 'title'>[],
  acceptanceCommands: readonly string[],
  skipKinds: readonly PromptValidationKind[],
): string {
  const planned =
    features.length > 0
      ? `${countLabel(features.length, 'feature')}: ${features.map((feature) => `${feature.id} "${feature.title}"`).join(', ')}`
      : 'features are planned when it becomes current';
  const description = milestone.description?.replaceAll(/\s+/g, ' ').trim();
  return [
    `${String(index + 1)}. ${milestone.id} "${milestone.title}" — ${planned}`,
    ...(description !== undefined && description.length > 0 ? [`   ${description}`] : []),
    `   validation: ${describeValidation(milestone.validation, acceptanceCommands, skipKinds)}`,
  ].join('\n');
}

function passedRounds(rounds: readonly PromptValidationRound[]): string {
  const parts = VALIDATION_KINDS.flatMap((kind) => {
    const round = latestRound(rounds, kind);
    return round !== undefined ? [`${kind} r${String(round.round)}`] : [];
  });
  return parts.length > 0 ? parts.join(', ') : 'no validation required';
}

const HEADLESS_BLOCK =
  ' In a headless run nobody can answer: block the objective with the reason instead (TowerObjective(action="block", reason)).';

const MERGE_BLOCK_GUIDANCE: Readonly<Record<string, (missionId: string) => string>> = {
  'out-of-scope': (id) =>
    `- out-of-scope → if the extra files legitimately belong to this feature, widen its scope with TowerMission(id="${id}", scope=[...]); otherwise have the worker revert them, which needs a fresh review.`,
  'deps-unmerged': () =>
    '- deps-unmerged → a dependency has not merged yet: unblock or finish it first, or re-plan if the dependency is not real.',
  'base-mismatch': () =>
    `- base-mismatch → the main checkout is not on the base branch: ask the human to switch it back; never switch the checkout yourself.${HEADLESS_BLOCK}`,
  'base-dirty': () =>
    `- base-dirty → the main checkout has uncommitted changes in files the merge touches: ask the human to commit or stash them; never discard them yourself.${HEADLESS_BLOCK}`,
  'branch-missing': (id) =>
    `- branch-missing → the branch is gone: ask the human whether it was deleted on purpose, then abandon ${id} with TowerMission(id="${id}", status="abandoned") and plan a replacement feature.${HEADLESS_BLOCK}`,
  'read-only-survey': () =>
    '- read-only-survey → a survey changed files: have the worker revert them, or re-plan the work as a build feature.',
  'review-mission-mismatch': () =>
    '- review-mission-mismatch → the latest review belongs to another mission: spawn a fresh reviewer for this branch.',
};

function attemptLines(attempts: readonly StuckAgentAttempt[]): string[] {
  if (attempts.length === 0) return [];
  return [
    'Recent attempts:',
    ...attempts.map((attempt) => {
      const reason = attempt.reason?.trim();
      return `- ${attempt.name}${attempt.status !== undefined ? `: ${attempt.status}` : ''}${reason !== undefined && reason.length > 0 ? ` — ${reason}` : ''}`;
    }),
  ];
}

function failedRoundBlock(round: PromptValidationRound): string {
  const header = `### ${round.kind} round ${String(round.round)} by ${round.validator}${round.file !== undefined ? ` — report: ${round.file}` : ''}`;
  const failures =
    round.failures.length > 0 ? numberedList(round.failures) : '(no failures listed — read the report)';
  return `${header}\n${failures}`;
}

function objectiveLabel(objective: ObjectiveRef): string {
  return `objective ${objective.id} "${objective.title}"`;
}

function milestoneLabel(milestone: MilestoneRef): string {
  return `milestone ${milestone.id} "${milestone.title}"`;
}

function featureLabel(feature: FeatureRef): string {
  const details = [
    ...(feature.milestone !== undefined ? [`milestone ${feature.milestone}`] : []),
    ...(feature.branch !== undefined ? [`branch ${feature.branch}`] : []),
  ];
  return `feature ${feature.id} "${feature.title}"${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
}

function countLabel(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
