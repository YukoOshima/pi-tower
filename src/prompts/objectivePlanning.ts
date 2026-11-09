import type { PromptObjectiveStatus } from './objectiveTypes.ts';
import type { TowerObjectivePlaybookVariant } from './reminders.ts';

export interface ObjectivePlanningCurrent {
  readonly id: string;
  readonly title: string;
  readonly status: PromptObjectiveStatus;
}

export interface ObjectivePlanningPromptInput {
  readonly mode: TowerObjectivePlaybookVariant;
  readonly text: string;
  readonly file?: string;
  readonly current?: ObjectivePlanningCurrent;
}

const HEADING: Readonly<Record<TowerObjectivePlaybookVariant, string>> = {
  interactive: '# New objective — plan it with the human',
  headless: '# New objective — plan it headless',
};

const INTRO: Readonly<Record<TowerObjectivePlaybookVariant, string>> = {
  interactive:
    'The human started an objective with `/tower objective`. Plan it with the human now: nothing executes until the human approves the plan with `/tower approve`.',
  headless:
    'A headless run started this objective with `/tower objective --headless`. Nobody answers questions in this run: never ask one and never wait for a reply — decide every open point yourself and work through every step below now, without stopping before the approval request.',
};

const REQUIREMENTS_STEP: Readonly<Record<TowerObjectivePlaybookVariant, string>> = {
  interactive:
    '2. **Settle the requirements with the human.** Before drafting, ask in your reply what done looks like, what is out of scope, how a user would exercise the result, and which commands prove it, then end your turn. Never guess a material requirement; skip the questions the objective already answers.',
  headless:
    '2. **Decide the open points yourself.** Read the objective and the repository. For every open point prefer the reading that keeps the objective\'s literal requirements, and record each assumption as a `note` on the objective so the human can audit it later. Block the objective with `TowerObjective(action="block", reason)` only when no reasonable decision exists.',
};

const GOAL_WORDING: Readonly<Record<TowerObjectivePlaybookVariant, string>> = {
  interactive: "the human's key wording",
  headless: "the objective's own wording",
};

const APPROVAL_STEP: Readonly<Record<TowerObjectivePlaybookVariant, string>> = {
  interactive:
    '5. **Request approval — never approve yourself.** Call `TowerObjective(action="request-approval")`, summarize the plan for the human (milestones, features, validation, estimated runs), tell them to approve with `/tower approve`, and end your turn. When the human asks for changes, update the plan and request approval again.',
  headless:
    '5. **Request approval as soon as the plan is complete — never approve yourself.** Call `TowerObjective(action="request-approval")`, then end your turn: the runner approves the plan or hands it to the human.',
};

function currentObjectiveLine(current: ObjectivePlanningCurrent | undefined): string | undefined {
  if (current === undefined) return undefined;
  if (current.status === 'planning') {
    return `Objective ${current.id} "${current.title}" is still planning: revise it into this objective with \`TowerObjective(action="update")\` instead of drafting — a draft is refused while it is open. Only when it is unrelated to this objective, block it first with \`TowerObjective(action="block", reason)\`, then draft.`;
  }
  return `The previous objective ${current.id} "${current.title}" is ${current.status}; drafting the new objective archives it.`;
}

export function buildObjectivePlanningPrompt(input: ObjectivePlanningPromptInput): string {
  const { mode } = input;
  const current = currentObjectiveLine(input.current);
  const steps = [
    '1. **Check the workspace.** `TowerStatus` shows what it already holds. Settle carried-over open missions before planning: continue the ones this objective needs, and abandon unrelated ones with `TowerMission(status="abandoned")` so their scopes free up.',
    REQUIREMENTS_STEP[mode],
    `3. **Draft the objective** with \`TowerObjective(action="draft")\`: a \`title\`, the \`goal\` in ${GOAL_WORDING[mode]}, verifiable \`definition_of_done\` items, \`acceptance_commands\` when a command can prove the result, and ordered \`milestones\`, each leaving the product working and testable — one is enough for a small objective; long or risky work needs more. Give every milestone its validation: \`scrutiny\` (code review of the merged diff plus typecheck/tests), \`user_testing\` with \`qa_instructions\` (how to start the product, which flows to drive, what to observe), and \`commands\` that must exit 0. Commands run in a fresh checkout without installed dependencies or build output, so each includes its own setup (e.g. \`npm ci && npm test\`). Switch a validator off only when it genuinely cannot apply.${mode === 'interactive' ? ' Keep the draft current with `TowerObjective(action="update")` as the discussion moves.' : ''}`,
    `4. **Plan the features** with \`TowerPlan\`, passing \`milestone\` on every item — at least the first milestone's features before approval; later milestones can wait until they become current. Shape them for parallel execution: disjoint scopes, explicit deps only for real ordering, verifiable tasks, and ${GOAL_WORDING[mode]} in \`context\`.`,
    APPROVAL_STEP[mode],
  ];
  return [
    HEADING[mode],
    INTRO[mode],
    ...(current === undefined ? [] : [current]),
    ['## Objective', ...(input.file === undefined ? [] : [`Source: ${input.file}`]), '', input.text.trim()].join('\n'),
    ['## Plan it', ...steps].join('\n'),
    'After approval the autopilot runs the mechanics — workers, reviews, merges, validation, and milestone advancement — until every milestone has passed validation; you are woken only for judgment work. Completion is automatic and gated: never declare it yourself.',
  ].join('\n\n');
}
