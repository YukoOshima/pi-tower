import type { TowerMissionStatus } from '../protocol/types.ts';
import {
  VALIDATION_KINDS,
  describeValidation,
  formatDuration,
  formatUsd,
  latestRound,
  requiredValidationKinds,
  shortCommit,
} from './objectiveFormat.ts';
import type {
  PromptFeature,
  PromptLiveAgent,
  PromptMilestone,
  PromptMilestoneStatus,
  PromptObjective,
  PromptObjectiveStatus,
  PromptValidationKind,
} from './objectiveTypes.ts';

export const OBJECTIVE_STATUS_MARKERS: Readonly<Record<PromptObjectiveStatus, string>> = {
  planning: '📝',
  'awaiting-approval': '✋',
  executing: '🔵',
  paused: '⏸️',
  completed: '✅',
  blocked: '🔴',
};

export const MILESTONE_STATUS_MARKERS: Readonly<Record<PromptMilestoneStatus, string>> = {
  pending: '⚪',
  active: '🔵',
  validating: '🔍',
  passed: '✅',
  failed: '❌',
  blocked: '🔴',
};

export const FEATURE_STATUS_MARKERS: Readonly<Record<TowerMissionStatus, string>> = {
  planned: '🟡',
  active: '🔵',
  completed: '🟢',
  blocked: '🔴',
  paused: '⏸️',
  merged: '✅',
  abandoned: '🚫',
};

export const OBJECTIVE_GOAL_PREVIEW_MAX = 240;

export interface ObjectiveStatusInput {
  readonly objective: PromptObjective;
  readonly features: readonly PromptFeature[];
  readonly agents: readonly PromptLiveAgent[];
  readonly nowMs: number;
  readonly skipKinds?: readonly PromptValidationKind[];
  readonly nextStep?: string;
}

export function renderObjectiveStatus(input: ObjectiveStatusInput): string {
  const milestones = [...input.objective.milestones].sort((a, b) => a.order - b.order);
  const current = milestones.find((milestone) => milestone.status !== 'passed');
  const finalId = milestones.at(-1)?.id;
  const sections = [headerSection(input), milestonesSection(input, milestones, finalId)];
  if (current !== undefined) sections.push(currentFeaturesSection(input, current));
  sections.push(
    agentsSection(input),
    `## Next\n${input.nextStep ?? nextStep(input, current, current?.id === finalId)}`,
  );
  return sections.join('\n\n');
}

function headerSection(input: ObjectiveStatusInput): string {
  const { objective } = input;
  const elapsed = elapsedMs(objective, input.nowMs);
  const maxWall = objective.limits?.maxWallTimeMs;
  const cost = objective.usage?.costUsd;
  const maxCost = objective.limits?.maxCostUsd;
  const facts = [
    `${OBJECTIVE_STATUS_MARKERS[objective.status]} ${objective.status}`,
    elapsed === undefined
      ? 'not started'
      : `elapsed ${formatDuration(elapsed)}${maxWall !== undefined ? ` of ${formatDuration(maxWall)}` : ''}`,
    ...(cost !== undefined || maxCost !== undefined
      ? [`cost ${formatUsd(cost ?? 0)}${maxCost !== undefined ? ` of ${formatUsd(maxCost)}` : ''}`]
      : []),
    ...(objective.approvedBy !== undefined ? [`approved by ${objective.approvedBy}`] : []),
  ];
  const lines = [
    `# Mission ${objective.id} — ${objective.title}`,
    facts.join(' · '),
    `Goal: ${preview(objective.goal, OBJECTIVE_GOAL_PREVIEW_MAX)}`,
  ];
  if (objective.status === 'blocked' && objective.blockedReason !== undefined) {
    lines.push(`Blocked: ${objective.blockedReason}`);
  }
  if (objective.status === 'paused' && objective.pausedReason !== undefined) {
    lines.push(`Paused: ${objective.pausedReason}`);
  }
  if (objective.status === 'awaiting-approval' && objective.approvalReason !== undefined) {
    lines.push(`Approval reason: ${objective.approvalReason}`);
  }
  return lines.join('\n');
}

function milestonesSection(
  input: ObjectiveStatusInput,
  milestones: readonly PromptMilestone[],
  finalId: string | undefined,
): string {
  if (milestones.length === 0) return '## Milestones\nnone yet';
  return [
    '## Milestones',
    ...milestones.map((milestone) => milestoneLine(input, milestone, milestone.id === finalId)),
  ].join('\n');
}

function milestoneLine(input: ObjectiveStatusInput, milestone: PromptMilestone, final: boolean): string {
  const features = featuresOf(input, milestone.id);
  const merged = features.filter((feature) => feature.status === 'merged').length;
  const abandoned = features.filter((feature) => feature.status === 'abandoned').length;
  const fixes = features.filter((feature) => feature.origin === 'fix').length;
  const extras = [
    ...(abandoned > 0 ? [`${String(abandoned)} abandoned`] : []),
    ...(fixes > 0 ? [`${String(fixes)} fix`] : []),
  ];
  const state =
    milestone.status === 'validating' && milestone.validationCommit !== undefined
      ? `validating ${shortCommit(milestone.validationCommit)}`
      : milestone.status;
  return [
    `${MILESTONE_STATUS_MARKERS[milestone.status]} ${milestone.id} ${milestone.title} — ${state}`,
    `features ${String(merged)}/${String(features.length)} merged${extras.length > 0 ? ` (${extras.join(', ')})` : ''}`,
    validationText(input, milestone, final),
  ].join(' · ');
}

function validationText(input: ObjectiveStatusInput, milestone: PromptMilestone, final: boolean): string {
  const acceptance = final ? input.objective.acceptanceCommands : [];
  const required = requiredKinds(input, milestone, final);
  const running = validatorsOf(input, milestone.id);
  if (milestone.rounds.length === 0 && running.length === 0 && milestone.status !== 'validating') {
    return required.length === 0
      ? 'validation: none'
      : `validation: ${describeValidation(milestone.validation, acceptance, input.skipKinds)}`;
  }
  const kinds = VALIDATION_KINDS.filter(
    (kind) => required.includes(kind) || milestone.rounds.some((round) => round.kind === kind),
  );
  return kinds.map((kind) => kindState(input, milestone, kind)).join(' · ');
}

function kindState(input: ObjectiveStatusInput, milestone: PromptMilestone, kind: PromptValidationKind): string {
  const agent = validatorsOf(input, milestone.id).find((entry) => entry.validationKind === kind);
  const latest = latestRound(milestone.rounds, kind);
  if (agent !== undefined) {
    return `${kind} r${String(agent.validationRound ?? (latest?.round ?? 0) + 1)} running`;
  }
  if (
    milestone.status === 'validating' &&
    milestone.validationCommit !== undefined &&
    latest?.validatedCommit !== milestone.validationCommit
  ) {
    return `${kind} r${String((latest?.round ?? 0) + 1)} pending`;
  }
  if (latest === undefined) return `${kind} not run`;
  if (latest.verdict === 'pass') return `${kind} r${String(latest.round)} pass`;
  const failedRounds = milestone.rounds.filter((round) => round.kind === kind && round.verdict === 'fail').length;
  const cap = input.objective.limits?.maxValidationRounds;
  return `${kind} r${String(latest.round)} fail (${String(latest.failures.length)} failure${latest.failures.length === 1 ? '' : 's'}${cap !== undefined ? `; ${String(failedRounds)}/${String(cap)} failed rounds` : ''})`;
}

function currentFeaturesSection(input: ObjectiveStatusInput, current: PromptMilestone): string {
  const features = featuresOf(input, current.id);
  const heading = `## Current milestone ${current.id} — features (run in parallel)`;
  if (features.length === 0) return `${heading}\nnone planned yet`;
  return [heading, ...features.map((feature) => featureLine(input, feature))].join('\n');
}

function featureLine(input: ObjectiveStatusInput, feature: PromptFeature): string {
  const worker = input.agents.find((agent) => agent.kind === 'worker' && agent.missionId === feature.id);
  const maxAttempts = input.objective.limits?.maxFeatureAttempts;
  const facts = [
    feature.status,
    ...(feature.origin === 'fix' ? ['fix'] : []),
    ...(worker !== undefined ? [`worker ${worker.name}`] : []),
    ...(feature.attempts !== undefined && feature.attempts > 1
      ? [`attempt ${String(feature.attempts)}${maxAttempts !== undefined ? `/${String(maxAttempts)}` : ''}`]
      : []),
  ];
  return `- ${FEATURE_STATUS_MARKERS[feature.status]} ${feature.id} ${feature.title} — ${facts.join(' · ')}`;
}

function agentsSection(input: ObjectiveStatusInput): string {
  if (input.agents.length === 0) return '## Live agents\nnone';
  return [
    `## Live agents (${String(input.agents.length)})`,
    ...input.agents.map((agent) => agentLine(input, agent)),
  ].join('\n');
}

function agentLine(input: ObjectiveStatusInput, agent: PromptLiveAgent): string {
  if (agent.kind === 'validator') {
    const round = agent.validationRound !== undefined ? ` r${String(agent.validationRound)}` : '';
    return `- ${agent.name} — validator · ${agent.milestoneId ?? '?'} ${agent.validationKind ?? 'validation'}${round}`;
  }
  if (agent.kind === 'reviewer') return `- ${agent.name} — reviewer · ${agent.reviewTarget ?? '?'}`;
  const feature = input.features.find((entry) => entry.id === agent.missionId);
  return `- ${agent.name} — worker · ${agent.missionId ?? '?'}${feature !== undefined ? ` ${feature.title}` : ''}`;
}

function nextStep(input: ObjectiveStatusInput, current: PromptMilestone | undefined, final: boolean): string {
  const { objective } = input;
  if (objective.status === 'planning') {
    return 'The orchestrator plans the mission with the human: it asks about the goal, drafts the milestones, plans the features of every milestone to run in parallel, and requests approval.';
  }
  if (objective.status === 'awaiting-approval') {
    return 'Waiting for the human: approve in the approval dialog or with /mission approve, or tell the orchestrator what to change.';
  }
  if (objective.status === 'paused') {
    return `Paused${objective.pausedReason !== undefined ? ` (${objective.pausedReason})` : ''} — /mission resume continues.`;
  }
  if (objective.status === 'blocked') {
    return `Blocked${objective.blockedReason !== undefined ? ` (${objective.blockedReason})` : ''} — the human decides; /mission resume continues.`;
  }
  if (objective.status === 'completed') {
    return `Done${objective.completedAt !== undefined ? ` — completed at ${objective.completedAt}` : ''}.`;
  }
  return executingNextStep(input, current, final);
}

function executingNextStep(
  input: ObjectiveStatusInput,
  current: PromptMilestone | undefined,
  final: boolean,
): string {
  if (current === undefined) {
    return 'Every milestone passed — the mission completes once the final validation is stamped on the current base tip.';
  }
  if (current.status === 'failed') {
    return `${current.id} failed validation — the orchestrator plans fix features into it (TowerPlan with milestone="${current.id}", origin "fix").`;
  }
  if (current.status === 'blocked') return `${current.id} is blocked — the human decides how to continue.`;
  if (current.status === 'validating') {
    const waiting = requiredKinds(input, current, final).filter(
      (kind) =>
        !current.rounds.some(
          (round) => round.kind === kind && round.validatedCommit === current.validationCommit,
        ),
    );
    const commit = current.validationCommit !== undefined ? ` on ${shortCommit(current.validationCommit)}` : '';
    return `Validating ${current.id}${commit}${waiting.length > 0 ? ` — waiting for ${waiting.join(', ')}` : ''}; it passes when every required kind passes on the same commit.`;
  }
  const features = featuresOf(input, current.id);
  const open = features.filter((feature) => feature.status !== 'merged' && feature.status !== 'abandoned');
  if (features.length === 0) {
    return `${current.id} has no features yet — the orchestrator plans them (TowerPlan with milestone="${current.id}").`;
  }
  if (open.length > 0) {
    return `${String(open.length)} of ${String(features.length)} features of ${current.id} still open, running in parallel — validation starts once every feature is merged or abandoned.`;
  }
  return `Every feature of ${current.id} is merged or abandoned — validation starts on the current base tip.`;
}

function requiredKinds(
  input: ObjectiveStatusInput,
  milestone: PromptMilestone,
  final: boolean,
): PromptValidationKind[] {
  return requiredValidationKinds(
    milestone.validation,
    final ? input.objective.acceptanceCommands : [],
    input.skipKinds,
  );
}

function featuresOf(input: ObjectiveStatusInput, milestoneId: string): readonly PromptFeature[] {
  return input.features.filter((feature) => feature.milestone === milestoneId);
}

function validatorsOf(input: ObjectiveStatusInput, milestoneId: string): readonly PromptLiveAgent[] {
  return input.agents.filter((agent) => agent.kind === 'validator' && agent.milestoneId === milestoneId);
}

function elapsedMs(objective: PromptObjective, nowMs: number): number | undefined {
  if (objective.startedAt === undefined) return undefined;
  const start = Date.parse(objective.startedAt);
  if (Number.isNaN(start)) return undefined;
  const end = objective.completedAt !== undefined ? Date.parse(objective.completedAt) : nowMs;
  return (Number.isNaN(end) ? nowMs : end) - start;
}

function preview(text: string, max: number): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
