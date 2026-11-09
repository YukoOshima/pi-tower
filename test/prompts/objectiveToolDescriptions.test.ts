import { describe, expect, it } from 'vitest';

import {
  TOWER_OBJECTIVE_DESCRIPTION,
  TOWER_PARAMETER_DESCRIPTIONS,
  TOWER_PLAN_DESCRIPTION,
  TOWER_SPAWN_DESCRIPTION,
  TOWER_TOOL_DESCRIPTIONS,
  TOWER_VALIDATE_DESCRIPTION,
  towerSpawnDescription,
} from '../../src/prompts/index.ts';

describe('TOWER_OBJECTIVE_DESCRIPTION', () => {
  it('is registered under TowerObjective', () => {
    expect(TOWER_TOOL_DESCRIPTIONS.TowerObjective).toBe(TOWER_OBJECTIVE_DESCRIPTION);
  });

  it('lists exactly the five actions and no approve or complete action', () => {
    const actions = [...TOWER_OBJECTIVE_DESCRIPTION.matchAll(/^- ([a-z-]+) — /gm)].map(
      (match) => match[1],
    );
    expect(actions).toEqual(['draft', 'update', 'request-approval', 'status', 'block']);
    expect(TOWER_OBJECTIVE_DESCRIPTION).toContain('There is no approve action: only the human approves (`/tower approve`)');
    expect(TOWER_OBJECTIVE_DESCRIPTION).toContain("Never approve, or claim approval, on the human's behalf.");
    expect(TOWER_OBJECTIVE_DESCRIPTION).toContain('There is no complete action either: completion is automatic and gated');
  });

  it('states the completion gate and the approval preconditions', () => {
    for (const sentence of [
      'every milestone has passed validation, no feature is still open',
      "the final milestone's passing rounds are stamped on the current base tip",
      'Requires a goal, at least one definition-of-done item, at least one milestone, and at least one build feature planned into the first milestone.',
      'an estimated run count (features + 2 × milestones)',
      'sends the objective back to awaiting-approval until the human approves again; appending milestones at the end and adding notes do not.',
    ]) {
      expect(TOWER_OBJECTIVE_DESCRIPTION).toContain(sentence);
    }
  });

  it('explains milestones, validation kinds, parallel features, and the autopilot split', () => {
    for (const sentence of [
      'the features of the current milestone run in parallel as ordinary tower missions',
      'scrutiny (a validator reviews',
      'user-testing (a validator exercises the product the way a user would, following qa_instructions)',
      'commands (shell commands the tower runs itself, no model involved)',
      'TowerPlan(milestone="MS1")',
      'Orchestrator only',
      'You are woken only for judgment work',
    ]) {
      expect(TOWER_OBJECTIVE_DESCRIPTION).toContain(sentence);
    }
  });
});

describe('TOWER_VALIDATE_DESCRIPTION', () => {
  it('is registered under TowerValidate', () => {
    expect(TOWER_TOOL_DESCRIPTIONS.TowerValidate).toBe(TOWER_VALIDATE_DESCRIPTION);
  });

  it('names every parameter and the commit stamping', () => {
    for (const word of ['milestone', 'kind', 'verdict', 'failures', 'checks', 'evidence']) {
      expect(TOWER_VALIDATE_DESCRIPTION).toContain(word);
    }
    expect(TOWER_VALIDATE_DESCRIPTION).toContain(
      'The verdict is stamped with the commit your validation worktree was checked out at',
    );
    expect(TOWER_VALIDATE_DESCRIPTION).toContain(
      'the latest round of every required kind passes on the same commit',
    );
  });

  it('keeps validators read-only, one-shot, and off manual notifications', () => {
    for (const sentence of [
      'Validators only',
      'Call it exactly once',
      'do not send a manual TowerSend',
      'never edit files or commit there',
      'at least one on fail and none on pass',
    ]) {
      expect(TOWER_VALIDATE_DESCRIPTION).toContain(sentence);
    }
  });
});

describe('objective mode in existing tool descriptions', () => {
  it('teaches TowerPlan the milestone and origin fields', () => {
    expect(TOWER_PLAN_DESCRIPTION).toContain('pass milestone (e.g. "MS1") on each item');
    expect(TOWER_PLAN_DESCRIPTION).toContain('with origin "fix" (default "plan")');
    expect(TOWER_PLAN_DESCRIPTION).toContain('planning into a failed milestone reopens it');
    expect(TOWER_PLAN_DESCRIPTION).toContain('in parallel');
  });

  it('teaches TowerSpawn the validator kind', () => {
    expect(TOWER_SPAWN_DESCRIPTION).toContain(
      'pass kind="validator" with milestone and validation_kind ("scrutiny" or "user-testing")',
    );
    expect(TOWER_SPAWN_DESCRIPTION).toContain('reports exactly once via TowerValidate');
    expect(TOWER_SPAWN_DESCRIPTION).toContain(
      'validators use the validator model, falling back to the reviewer model and then the orchestrator model',
    );
    expect(TOWER_SPAWN_DESCRIPTION).toContain('never resume one');
    expect(towerSpawnDescription()).toBe(TOWER_SPAWN_DESCRIPTION);
  });

  it('keeps every new description free of triple newlines', () => {
    for (const text of [TOWER_OBJECTIVE_DESCRIPTION, TOWER_VALIDATE_DESCRIPTION]) {
      expect(text.trim()).toBe(text);
      expect(text).not.toMatch(/\n{3,}/);
    }
  });
});

describe('objective mode parameter descriptions', () => {
  it('describes every TowerObjective parameter, including the milestone item fields', () => {
    expect(Object.keys(TOWER_PARAMETER_DESCRIPTIONS.TowerObjective)).toEqual([
      'action',
      'title',
      'goal',
      'definition_of_done',
      'acceptance_commands',
      'milestones',
      'milestone_id',
      'milestone_title',
      'milestone_description',
      'milestone_scrutiny',
      'milestone_user_testing',
      'milestone_commands',
      'milestone_qa_instructions',
      'note',
      'reason',
    ]);
    const { action, milestones, reason } = TOWER_PARAMETER_DESCRIPTIONS.TowerObjective;
    expect(action).toContain('There is no approve or complete action');
    expect(milestones).toContain(
      'Each item: id?, title, description?, scrutiny?, user_testing?, commands?, qa_instructions?',
    );
    expect(reason).toContain('Required with "block"');
  });

  it('describes every TowerValidate parameter', () => {
    expect(Object.keys(TOWER_PARAMETER_DESCRIPTIONS.TowerValidate)).toEqual([
      'milestone',
      'kind',
      'verdict',
      'failures',
      'checks',
      'evidence',
    ]);
    expect(TOWER_PARAMETER_DESCRIPTIONS.TowerValidate.failures).toContain(
      'each failure becomes the basis of a fix feature',
    );
  });

  it('adds the objective fields to TowerPlan and TowerSpawn', () => {
    expect(TOWER_PARAMETER_DESCRIPTIONS.TowerPlan.milestone).toContain(
      'Required while an objective is open, omitted otherwise.',
    );
    expect(TOWER_PARAMETER_DESCRIPTIONS.TowerPlan.origin).toContain('"fix"');
    expect(TOWER_PARAMETER_DESCRIPTIONS.TowerSpawn.kind).toContain('validators (objective mode)');
    expect(TOWER_PARAMETER_DESCRIPTIONS.TowerSpawn.milestone).toContain('Required for validators');
    expect(TOWER_PARAMETER_DESCRIPTIONS.TowerSpawn.validation_kind).toContain(
      '"scrutiny" (code review',
    );
  });
});
