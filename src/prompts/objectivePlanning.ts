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
  interactive: '# New mission — plan it with the human',
  headless: '# New mission — plan it headless',
};

const INTRO: Readonly<Record<TowerObjectivePlaybookVariant, string>> = {
  interactive:
    'The human started a new mission. Plan it together with the human now: interview first, then draft the plan and request approval — nothing executes until the human approves the plan, in the approval dialog or with `/mission approve`.',
  headless:
    'A headless run started this mission with `/tower objective --headless`. Nobody answers questions in this run: never ask one and never wait for a reply — decide every open point yourself and work through every step below now, without stopping before the approval request.',
};

const TERMS =
  'The human calls this objective "the mission" and its features "features" — say "mission O1" and "feature M3" when you report to them. The Tower tools keep their names: the mission is the tower objective (`TowerObjective`), each feature is a tower mission (`TowerPlan`, `TowerMission`), and its milestones are validation checkpoints.';

const REQUIREMENTS_STEP: Readonly<Record<TowerObjectivePlaybookVariant, string>> = {
  interactive: [
    '2. **Interview the human before drafting.** Ask in your reply, then end your turn — a few questions per round, the most important first:',
    '   - the goal and what done looks like;',
    '   - what is out of scope;',
    '   - how a user will exercise the result — the user flows a QA pass should drive;',
    '   - which commands prove it (tests, builds, scripts);',
    '   - the constraints: stack, compatibility, performance, areas of the code to leave alone.',
    '   Skip what the mission text already answers; when the human says it is complete as written, plan without questions. Push back on a vague or contradictory goal: say what is unclear and propose concrete readings — never guess a material requirement. Iterate with the human until the plan is solid.',
  ].join('\n'),
  headless:
    '2. **Decide the open points yourself.** Read the objective and the repository. For every open point prefer the reading that keeps the objective\'s literal requirements, and record each assumption as a `note` on the objective so the human can audit it later. Block the objective with `TowerObjective(action="block", reason)` only when no reasonable decision exists.',
};

const GOAL_WORDING: Readonly<Record<TowerObjectivePlaybookVariant, string>> = {
  interactive: "the human's key wording",
  headless: "the objective's own wording",
};

const APPROVAL_STEP: Readonly<Record<TowerObjectivePlaybookVariant, string>> = {
  interactive:
    '5. **Request approval — never approve yourself.** Call `TowerObjective(action="request-approval")`, then summarize the plan in your reply: the milestones, the features of each and how many of them run in parallel, the validation, and the estimated runs (a floor, not a ceiling). Tell the human to approve it in the approval dialog or with `/mission approve` — only the human can approve — and that they can ask you for changes; then end your turn. When the human asks for changes, update the plan and request approval again.',
  headless:
    '5. **Request approval as soon as the plan is complete — never approve yourself.** Call `TowerObjective(action="request-approval")`, then end your turn: the runner approves the plan or hands it to the human.',
};

function featuresStep(mode: TowerObjectivePlaybookVariant): string {
  return [
    '4. **Plan the features of every milestone — a parallel swarm.** Before requesting approval, plan the features of all milestones with `TowerPlan`, passing `milestone` on every item; only fix features wait until a validation fails. The features of a milestone run concurrently, each with its own worker, review, and merge, so split every milestone into as many small, independent features as the work allows:',
    '   - give each feature a file scope disjoint from the other features of its milestone: the merge gate enforces scope, and features of one milestone whose scopes overlap get an automatic dependency, so they run one after another instead of in parallel — two features that must edit the same file belong together;',
    "   - add `deps` only where a feature needs another feature's merged code: a feature starts only after its deps merge;",
    `   - write verifiable tasks, and keep ${GOAL_WORDING[mode]} in \`context\`;`,
    "   - when a skill available in this session fits a feature, name it in the feature's `context` so its worker uses it;",
    "   - when the mission text prescribes the plan's shape — milestones, features, scopes — follow it.",
  ].join('\n');
}

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
    '1. **Check the workspace.** `TowerStatus` shows what it already holds. Settle open tower missions carried over from earlier work before planning: continue the ones this objective needs, and abandon unrelated ones with `TowerMission(status="abandoned")` so their scopes free up.',
    REQUIREMENTS_STEP[mode],
    `3. **Draft the objective** with \`TowerObjective(action="draft")\`: a \`title\`, the \`goal\` in ${GOAL_WORDING[mode]}, verifiable \`definition_of_done\` items, \`acceptance_commands\` when a command can prove the result, and ordered \`milestones\` — validation checkpoints, each leaving the product working and testable: one is enough for simple work; large or risky work needs more. Give every milestone its validation: \`scrutiny\` (code review of the merged diff plus typecheck/tests), \`user_testing\` with \`qa_instructions\` (how to start the product, which flows to drive, what to observe), and \`commands\` that must exit 0. Commands run in a fresh checkout without installed dependencies or build output, so each includes its own setup (e.g. \`npm ci && npm test\`). Switch a validator off only when it genuinely cannot apply.${mode === 'interactive' ? ' Keep the draft current with `TowerObjective(action="update")` as the discussion moves.' : ''}`,
    featuresStep(mode),
    APPROVAL_STEP[mode],
  ];
  return [
    HEADING[mode],
    INTRO[mode],
    TERMS,
    ...(current === undefined ? [] : [current]),
    ['## Mission goal', ...(input.file === undefined ? [] : [`Source: ${input.file}`]), '', input.text.trim()].join('\n'),
    ['## Plan it', ...steps].join('\n'),
    'After approval the autopilot runs the mechanics — workers, reviews, merges, validation, and milestone advancement — until every milestone has passed validation; you are woken only for judgment work, such as planning fix features after a failed validation. Completion is automatic and gated: never declare it yourself.',
  ].join('\n\n');
}
