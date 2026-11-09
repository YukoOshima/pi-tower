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

describe('buildObjectivePlanningPrompt', () => {
  it('hands the interactive objective over with the planning steps in order', () => {
    const prompt = buildObjectivePlanningPrompt({ mode: 'interactive', text: TEXT });
    ordered(prompt, [
      '# New objective — plan it with the human',
      'The human started an objective with `/tower objective`.',
      '## Objective\n\nShip a CSV export command.\n\nUsers run `report export --format csv`.\n\n## Plan it',
      '1. **Check the workspace.**',
      '2. **Settle the requirements with the human.**',
      '3. **Draft the objective**',
      '4. **Plan the features**',
      '5. **Request approval — never approve yourself.**',
      'Completion is automatic and gated: never declare it yourself.',
    ]);
    for (const sentence of [
      'nothing executes until the human approves the plan with `/tower approve`',
      'ask in your reply what done looks like, what is out of scope, how a user would exercise the result, and which commands prove it, then end your turn',
      "the `goal` in the human's key wording",
      'verifiable `definition_of_done` items',
      '`user_testing` with `qa_instructions`',
      'each includes its own setup (e.g. `npm ci && npm test`)',
      'Keep the draft current with `TowerObjective(action="update")`',
      'passing `milestone` on every item',
      'tell them to approve with `/tower approve`, and end your turn',
    ]) {
      expect(prompt).toContain(sentence);
    }
    expect(prompt).not.toContain('Source:');
    expect(prompt).not.toContain('never ask');
  });

  it('plans headless without questions and records assumptions as notes', () => {
    const prompt = buildObjectivePlanningPrompt({
      mode: 'headless',
      text: TEXT,
      file: '/work/specs/csv export.md',
    });
    ordered(prompt, [
      '# New objective — plan it headless',
      '`/tower objective --headless`',
      '## Objective\nSource: /work/specs/csv export.md\n\nShip a CSV export command.',
      '2. **Decide the open points yourself.**',
      "the `goal` in the objective's own wording",
      '5. **Request approval as soon as the plan is complete — never approve yourself.**',
    ]);
    for (const sentence of [
      'never ask one and never wait for a reply',
      'without stopping before the approval request',
      'record each assumption as a `note` on the objective',
      'Block the objective with `TowerObjective(action="block", reason)` only when no reasonable decision exists',
      'the runner approves the plan or hands it to the human',
    ]) {
      expect(prompt).toContain(sentence);
    }
    for (const interactiveOnly of ['ask in your reply', '/tower approve`', 'Keep the draft current']) {
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
    ordered(planning, ['Objective O2 "CSV export" is still planning', '## Objective']);

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
