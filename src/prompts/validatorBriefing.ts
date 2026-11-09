import { numberedList, shortCommit } from './objectiveFormat.ts';
import type {
  PromptFeature,
  PromptMilestone,
  PromptMissionTask,
  PromptObjectiveContract,
  PromptValidationRound,
  PromptValidatorKind,
} from './objectiveTypes.ts';

export const VALIDATION_HISTORY_ROUNDS = 6;
export const VALIDATION_FAILURES_MAX_CHARS = 4000;

export interface ValidatorBriefingInput {
  readonly name: string;
  readonly validationKind: PromptValidatorKind;
  readonly round: number;
  readonly objective: PromptObjectiveContract;
  readonly milestone: Pick<PromptMilestone, 'id' | 'title' | 'description' | 'validation' | 'rounds'>;
  readonly finalMilestone: boolean;
  readonly features: readonly PromptFeature[];
  readonly validatedCommit: string;
  readonly diffBase?: string;
  readonly worktreePath: string;
  readonly repoRoot: string;
  readonly base: string;
  readonly instructions?: string;
}

export function buildValidatorBriefing(input: ValidatorBriefingInput): string {
  const { name, validationKind, milestone } = input;
  return [
    `You are "${name}", a tower validator agent in a multi-agent workspace, assigned the ${validationKind} validation of milestone ${milestone.id} (${validationKind} round ${String(input.round)}). The milestone's features were built in parallel by separate workers, each reviewed and merged on its own; you validate the integrated result on one exact commit and report a verdict. You verify — you never fix.`,
    validatorWorkplaceSection(input),
    objectiveSection(input),
    milestoneSection(input),
    commandsSection(input),
    validationHistorySection(input),
    validatorGroundRules(input),
    validationKind === 'scrutiny' ? scrutinyChecklist() : userTestingChecklist(input),
    validatorReportSection(input),
  ]
    .filter((section) => section.length > 0)
    .join('\n\n')
    .concat(additionalInstructions(input.instructions));
}

function validatorWorkplaceSection(input: ValidatorBriefingInput): string {
  const commit = input.validatedCommit;
  const diff =
    input.diffBase !== undefined
      ? `- The milestone's changes: \`git diff ${input.diffBase}..${commit}\` (and \`git log --first-parent ${input.diffBase}..${commit}\` for the feature merges).`
      : `- The milestone's changes: list the feature merges with \`git log --first-parent --merges --oneline ${commit}\` and inspect each merge M with \`git diff M^1 M\`.`;
  return [
    '# Your workplace',
    `- Validation worktree (detached, read-only): ${input.worktreePath}`,
    `- Validated commit: ${commit} — the tip of base "${input.base}" after this milestone's features merged. Everything you judge is this exact commit; \`git rev-parse HEAD\` in the worktree must print it.`,
    diff,
    `- Your working directory is this worktree. You may install dependencies, build, run tests, and start the product here — generated files are fine, the worktree is discarded after your verdict — but never edit tracked files, never commit, never check out another commit or branch, and never touch the main checkout (${input.repoRoot}) or another agent's worktree.`,
  ].join('\n');
}

function objectiveSection(input: ValidatorBriefingInput): string {
  const { objective } = input;
  const scope = input.finalMilestone
    ? 'This is the FINAL milestone: the whole definition of done must hold on the validated commit.'
    : 'This milestone delivers the part that its description and features name; later milestones deliver the rest.';
  return [
    `# Objective ${objective.id}: ${objective.title}`,
    `Goal: ${objective.goal.trim()}`,
    `## Definition of done\n${scope}\n${numbered(objective.definitionOfDone)}`,
  ].join('\n\n');
}

function milestoneSection(input: ValidatorBriefingInput): string {
  const { milestone, features } = input;
  const parts = [`# Milestone ${milestone.id}: ${milestone.title}`];
  const description = milestone.description?.trim();
  if (description !== undefined && description.length > 0) parts.push(description);
  if (features.length === 0) {
    parts.push('No features are recorded for this milestone — judge it against its description and the definition of done.');
    return parts.join('\n\n');
  }
  parts.push(
    "## Its features — every task of a merged feature must be delivered on the validated commit",
    ...features.map(featureBlock),
  );
  return parts.join('\n\n');
}

function featureBlock(feature: PromptFeature): string {
  const labels = [
    feature.status === 'abandoned'
      ? 'abandoned — its work did not land; the milestone must still meet its definition of done without it'
      : feature.status,
    ...(feature.origin === 'fix' ? ['fix feature'] : []),
    ...(feature.branch !== undefined ? [`branch ${feature.branch}`] : []),
  ];
  const tasks = feature.tasks ?? [];
  const lines = [`### ${feature.id}: ${feature.title} (${labels.join(', ')})`];
  if (tasks.length > 0) lines.push(...tasks.map(taskLine));
  return lines.join('\n');
}

function taskLine(task: PromptMissionTask): string {
  if (task.dropped === true) return `- [~] ${task.text} (dropped)`;
  return `- [${task.done ? 'x' : ' '}] ${task.text}`;
}

function commandsSection(input: ValidatorBriefingInput): string {
  const commands = input.milestone.validation.commands;
  const acceptance = input.finalMilestone ? input.objective.acceptanceCommands : [];
  if (commands.length === 0 && acceptance.length === 0) {
    return "# Commands\nNo commands are configured for this milestone. Find the project's own typecheck, lint, and test commands (package.json scripts, Makefile, README) and run them.";
  }
  const parts = [
    '# Commands',
    'The tower also runs these mechanically as the separate `commands` validation; run them yourself as part of your checks and read their output.',
  ];
  if (commands.length > 0) parts.push(`Milestone commands:\n${commandList(commands)}`);
  if (acceptance.length > 0) {
    parts.push(`Acceptance commands of the objective (final milestone):\n${commandList(acceptance)}`);
  }
  return parts.join('\n\n');
}

function validationHistorySection(input: ValidatorBriefingInput): string {
  const failed = input.milestone.rounds.filter((round) => round.verdict === 'fail');
  if (failed.length === 0) return '';
  const recent = failed.slice(-VALIDATION_HISTORY_ROUNDS);
  const omitted = failed.length - recent.length;
  const parts = [
    '# Earlier failed validation rounds of this milestone',
    `Fix features were planned from these failures. Failures of your kind (${input.validationKind}): re-check each one on the validated commit — report it again if it still reproduces, do not report it if it is fixed. Failures of other kinds are context: check them only where your kind of validation covers them.`,
  ];
  if (omitted > 0) {
    parts.push(`(${String(omitted)} earlier failed round(s) omitted — the full record lives in .tower/comms/validations/.)`);
  }
  for (const round of recent) parts.push(roundBlock(round));
  return parts.join('\n\n');
}

function roundBlock(round: PromptValidationRound): string {
  const header = `## ${round.kind} round ${String(round.round)} by ${round.validator} on ${shortCommit(round.validatedCommit)}: ${round.verdict}`;
  const failures =
    round.failures.length > 0 ? numbered(round.failures) : '(no failures listed — see the validation file)';
  return `${header}\n${truncate(failures, VALIDATION_FAILURES_MAX_CHARS)}`;
}

function validatorGroundRules(input: ValidatorBriefingInput): string {
  return [
    '# Ground rules',
    '- You verify; you do not fix. A problem you find becomes a failure in your report, never a patch.',
    `- Judge only ${shortCommit(input.validatedCommit)}. If the base moves while you work, keep validating this commit — the tower re-runs validation on the new tip when needed.`,
    '- Every failure is concrete and reproducible: what is wrong, where (file:line, command, or user step), how to reproduce it, and what was expected.',
    input.finalMilestone
      ? "- Fail for anything that breaks this milestone's features, the definition of done, or the acceptance commands, including regressions. Report unrelated pre-existing issues with TowerFinding instead."
      : "- Fail only for problems within this milestone: its features' tasks, the part of the definition of done it delivers, and regressions it introduced. Report unrelated pre-existing issues with TowerFinding instead.",
    '- If a check cannot run at all (missing tool, broken environment), do not guess: report fail with a failure that states exactly what could not run and why.',
    "- If the contract is too vague to judge an item, judge it by the objective's goal and name the ambiguity in your evidence.",
  ].join('\n');
}

function scrutinyChecklist(): string {
  return [
    '# What to check — scrutiny (code review + tests)',
    '1. Intent: map every task of every merged feature to the code on the validated commit. A missing, partial, or silently dropped task is a failure; healthy code that answers the wrong requirement is a failure too.',
    '2. Definition of done: the items this milestone delivers are really implemented, not stubbed or faked.',
    '3. Integration: the features were built in parallel and merged separately — look for the seams between them: conflicting assumptions, duplicated or diverging helpers, broken imports or call sites, behaviour one feature changed under another.',
    '4. Typecheck, lint, and the full test suite pass on the validated commit, and the new behaviour has tests.',
    '5. Correctness and robustness: error handling, edge cases, security, data integrity.',
  ].join('\n');
}

function userTestingChecklist(input: ValidatorBriefingInput): string {
  const qa = input.milestone.validation.qaInstructions?.trim();
  return [
    '# What to check — user-testing (behavioural QA)',
    '1. Use the product the way a user would: start it as the QA instructions say and drive the flows end to end — CLI runs, scripts, HTTP calls, UI automation — observing outputs, files, logs, and exit codes.',
    '2. Exercise every definition-of-done item this milestone delivers through real use, not by reading code.',
    '3. Probe what a real user will hit: invalid input, missing files, repeated or interrupted runs, help and error messages.',
    '4. Every deviation from the expected behaviour is a failure with exact reproduction steps: commands, inputs, observed versus expected output.',
    '',
    '## QA instructions',
    qa !== undefined && qa.length > 0
      ? qa
      : "None were given: derive the user flows from the goal, the definition of done, and the features' tasks, and list the flows you exercised in your evidence.",
  ].join('\n');
}

function validatorReportSection(input: ValidatorBriefingInput): string {
  const { milestone, validationKind } = input;
  return [
    '# When done — TowerValidate exactly once',
    `1. Call TowerValidate once: { milestone: "${milestone.id}", kind: "${validationKind}", verdict: "pass" | "fail", failures, checks, evidence }. Verdict "pass" only when every check above holds on the validated commit. On "fail", list every failure — at least one, each self-contained — because the orchestrator plans fix features from them; on "pass", failures is empty. The tool stamps your verdict with the validated commit and stores the validation-result notification itself: never send a manual TowerSend, never call TowerValidate a second time.`,
    '2. Then finish with a short summary: verdict, number of failures, and what you exercised.',
  ].join('\n');
}

function numbered(items: readonly string[]): string {
  return items.length === 0 ? '(none recorded)' : numberedList(items);
}

function commandList(commands: readonly string[]): string {
  return commands.map((command) => `- \`${command}\``).join('\n');
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…(truncated)`;
}

function additionalInstructions(instructions: string | undefined): string {
  return instructions !== undefined && instructions.trim().length > 0
    ? `\n\n# Additional instructions from the tower\n${instructions.trim()}`
    : '';
}
