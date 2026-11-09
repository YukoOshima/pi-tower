import { describe, expect, it } from 'vitest';

import * as objectivePlanning from '../../src/prompts/objectivePlanning.ts';
import { buildObjectivePlanningPrompt } from '../../src/prompts/objectivePlanning.ts';

const KIMI_ONLY: readonly RegExp[] = [
  /Agent\(resume/,
  /(?<![A-Za-z])TaskList(?![A-Za-z])/,
  /(?<![A-Za-z])TaskOutput(?![A-Za-z])/,
  /(?<![A-Za-z])TaskStop(?![A-Za-z])/,
  /kimi-file:\/\//,
  /secondary_model/,
  /secondary-pool/,
  /run_in_background/,
  /(?<![A-Za-z])WaitFor(?![A-Za-z])/,
  /AskUserQuestion/,
  /AgentSwarm/,
  /TodoList/,
  /CreateGoal|UpdateGoal/,
  /NotifyUser|WebSearch/,
  /Read\/Write\/Edit/,
  /(?<![A-Za-z])Glob(?![A-Za-z])/,
  /kimi/i,
];

const TEXT = '  Ship a CSV export command.\n\nUsers run `report export --format csv`.\n';

function ordered(text: string, markers: readonly string[]): void {
  const positions = markers.map((marker) => text.indexOf(marker));
  for (const [index, position] of positions.entries()) expect(position, markers[index]).toBeGreaterThanOrEqual(0);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
}

const SWARM: readonly string[] = [
  '4. **Plan the features of every milestone — a parallel swarm.**',
  'Before requesting approval, plan the features of all milestones with `TowerPlan`, passing `milestone` on every item; only fix features wait until a validation fails.',
  'The features of a milestone run concurrently, each with its own worker, review, and merge, so split every milestone into as many small, independent features as the work allows:',
  '   - give each feature a file scope disjoint from the other features of its milestone: the merge gate enforces scope, and features of one milestone whose scopes overlap get an automatic dependency, so they run one after another instead of in parallel — two features that must edit the same file belong together;',
  "   - add `deps` only where a feature needs another feature's merged code: a feature starts only after its deps merge;",
  "   - when a skill available in this session fits a feature, name it in the feature's `context` so its worker uses it;",
  "   - when the mission text prescribes the plan's shape — milestones, features, scopes — follow it.",
];

describe('buildObjectivePlanningPrompt', () => {
  it('hands the interactive mission over with the interview before the planning steps', () => {
    const prompt = buildObjectivePlanningPrompt({ mode: 'interactive', text: TEXT });
    ordered(prompt, [
      '# New mission — plan it with the human',
      'The human started a new mission.',
      'The human calls this objective "the mission" and its features "features"',
      '## Mission goal\n\nShip a CSV export command.\n\nUsers run `report export --format csv`.\n\n## Plan it',
      '1. **Check the workspace.**',
      '2. **Interview the human before drafting.**',
      '3. **Draft the objective**',
      '4. **Plan the features of every milestone — a parallel swarm.**',
      '5. **Request approval — never approve yourself.**',
      'Completion is automatic and gated: never declare it yourself.',
    ]);
    for (const sentence of [
      'interview first, then draft the plan and request approval — nothing executes until the human approves the plan, in the approval dialog or with `/mission approve`',
      "the `goal` in the human's key wording",
      'verifiable `definition_of_done` items',
      '`milestones` — validation checkpoints, each leaving the product working and testable: one is enough for simple work; large or risky work needs more.',
      '`user_testing` with `qa_instructions`',
      'each includes its own setup (e.g. `npm ci && npm test`)',
      'Keep the draft current with `TowerObjective(action="update")`',
      "   - write verifiable tasks, and keep the human's key wording in `context`;",
      ...SWARM,
    ]) {
      expect(prompt).toContain(sentence);
    }
    expect(prompt).not.toContain('Source:');
    expect(prompt).not.toContain('never ask');
    expect(prompt).not.toContain('/tower');
  });

  it('interviews the human about done, scope, user flows, commands, and constraints, and pushes back on vague goals', () => {
    const prompt = buildObjectivePlanningPrompt({ mode: 'interactive', text: TEXT });
    ordered(prompt, [
      '2. **Interview the human before drafting.** Ask in your reply, then end your turn — a few questions per round, the most important first:',
      '   - the goal and what done looks like;',
      '   - what is out of scope;',
      '   - how a user will exercise the result — the user flows a QA pass should drive;',
      '   - which commands prove it (tests, builds, scripts);',
      '   - the constraints: stack, compatibility, performance, areas of the code to leave alone.',
      'Skip what the mission text already answers; when the human says it is complete as written, plan without questions.',
      'Push back on a vague or contradictory goal: say what is unclear and propose concrete readings — never guess a material requirement.',
      'Iterate with the human until the plan is solid.',
      '3. **Draft the objective**',
    ]);
  });

  it('asks the human to approve in the dialog or with /mission approve and reports the parallel plan', () => {
    const prompt = buildObjectivePlanningPrompt({ mode: 'interactive', text: TEXT });
    expect(prompt).toContain(
      '5. **Request approval — never approve yourself.** Call `TowerObjective(action="request-approval")`, then summarize the plan in your reply: the milestones, the features of each and how many of them run in parallel, the validation, and the estimated runs (a floor, not a ceiling). Tell the human to approve it in the approval dialog or with `/mission approve` — only the human can approve — and that they can ask you for changes; then end your turn. When the human asks for changes, update the plan and request approval again.',
    );
  });

  it('explains the mission terminology while keeping the Tower tool names', () => {
    for (const mode of ['interactive', 'headless'] as const) {
      expect(buildObjectivePlanningPrompt({ mode, text: TEXT })).toContain(
        'The human calls this objective "the mission" and its features "features" — say "mission O1" and "feature M3" when you report to them. The Tower tools keep their names: the mission is the tower objective (`TowerObjective`), each feature is a tower mission (`TowerPlan`, `TowerMission`), and its milestones are validation checkpoints.',
      );
    }
  });

  it('plans headless without questions and records assumptions as notes', () => {
    const prompt = buildObjectivePlanningPrompt({
      mode: 'headless',
      text: TEXT,
      file: '/work/specs/csv export.md',
    });
    ordered(prompt, [
      '# New mission — plan it headless',
      '`/tower objective --headless`',
      'The human calls this objective "the mission"',
      '## Mission goal\nSource: /work/specs/csv export.md\n\nShip a CSV export command.',
      '2. **Decide the open points yourself.**',
      "the `goal` in the objective's own wording",
      '4. **Plan the features of every milestone — a parallel swarm.**',
      '5. **Request approval as soon as the plan is complete — never approve yourself.**',
    ]);
    for (const sentence of [
      'never ask one and never wait for a reply',
      'without stopping before the approval request',
      'record each assumption as a `note` on the objective',
      'Block the objective with `TowerObjective(action="block", reason)` only when no reasonable decision exists',
      'the runner approves the plan or hands it to the human',
      "   - write verifiable tasks, and keep the objective's own wording in `context`;",
      ...SWARM,
    ]) {
      expect(prompt).toContain(sentence);
    }
    for (const interactiveOnly of [
      'Interview the human',
      'Ask in your reply',
      'Push back',
      '/mission approve',
      'Keep the draft current',
    ]) {
      expect(prompt).not.toContain(interactiveOnly);
    }
  });

  it('revises an objective still in planning and archives a finished one', () => {
    const planning = buildObjectivePlanningPrompt({
      mode: 'headless',
      text: TEXT,
      current: { id: 'O2', title: 'CSV export', status: 'planning' },
    });
    expect(planning).toContain(
      'Objective O2 "CSV export" is still planning: revise it into this objective with `TowerObjective(action="update")` instead of drafting — a draft is refused while it is open.',
    );
    ordered(planning, ['Objective O2 "CSV export" is still planning', '## Mission goal']);

    for (const status of ['completed', 'blocked'] as const) {
      expect(
        buildObjectivePlanningPrompt({ mode: 'interactive', text: TEXT, current: { id: 'O1', title: 'Old', status } }),
      ).toContain(`The previous objective O1 "Old" is ${status}; drafting the new objective archives it.`);
    }
  });

  it('renders no foreign tool names and exports only the builder', () => {
    for (const mode of ['interactive', 'headless'] as const) {
      const prompt = buildObjectivePlanningPrompt({
        mode,
        text: TEXT,
        file: '/work/objective.md',
        current: { id: 'O1', title: 'Old', status: 'planning' },
      });
      for (const pattern of KIMI_ONLY) expect(pattern.test(prompt), `${mode} matches ${String(pattern)}`).toBe(false);
    }
    expect(Object.keys(objectivePlanning)).toEqual(['buildObjectivePlanningPrompt']);
  });
});
