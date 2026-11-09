import { describe, expect, it } from 'vitest';

import {
  TOWER_MODE_EXIT_REMINDER,
  TOWER_MODE_FULL_REMINDER,
  TOWER_MODE_SPARSE_REMINDER,
  TOWER_OBJECTIVE_HEADLESS_PLAYBOOK,
  TOWER_OBJECTIVE_PLAYBOOK,
  TOWER_OBJECTIVE_SPARSE_REMINDER,
} from '../../src/prompts/index.ts';
import type { TowerObjective, TowerObjectiveStatus } from '../../src/protocol/index.ts';
import { TOWER_REMINDER_MESSAGE } from '../../src/tower/constants.ts';
import {
  reminderObjectiveVariant,
  selectReminderForContext,
  type TowerReminderObjectiveState,
} from '../../src/tower/reminders.ts';

function objective(status: TowerObjectiveStatus): TowerObjective {
  return {
    id: 'O1',
    title: 'Ship',
    goal: 'ship it',
    definitionOfDone: ['works'],
    acceptanceCommands: [],
    status,
    milestones: [],
    limits: { maxValidationRounds: 3, maxFeatureAttempts: 3 },
    createdAt: '2026-11-09T00:00:00.000Z',
    notes: [],
  };
}

const STATUSES: readonly TowerObjectiveStatus[] = [
  'planning',
  'awaiting-approval',
  'executing',
  'paused',
  'completed',
  'blocked',
];

const reminderEntry = (kind: 'full' | 'sparse' | 'exit') => ({
  type: 'custom_message',
  customType: TOWER_REMINDER_MESSAGE,
  details: { kind },
});
const assistant = { type: 'message', message: { role: 'assistant' } };

describe('reminderObjectiveVariant', () => {
  it('is set only while an objective mode is set and the objective is absent or non-terminal', () => {
    expect(reminderObjectiveVariant(undefined)).toBeUndefined();
    expect(reminderObjectiveVariant({})).toBeUndefined();
    for (const status of STATUSES) {
      expect(reminderObjectiveVariant({ objective: objective(status) }), status).toBeUndefined();
    }
    expect(reminderObjectiveVariant({ objectiveMode: 'headless' })).toBe('headless');
    expect(reminderObjectiveVariant({ objectiveMode: 'interactive' })).toBe('interactive');
    expect(
      STATUSES.map((status) => reminderObjectiveVariant({ objectiveMode: 'headless', objective: objective(status) })),
    ).toEqual(['headless', 'headless', 'headless', 'headless', undefined, undefined]);
  });
});

describe('selectReminderForContext with an objective', () => {
  it('stays exactly the v0.1 reminder without an objective mode', () => {
    for (const state of [undefined, {}, { objective: objective('executing') }] as TowerReminderObjectiveState[]) {
      expect(selectReminderForContext(true, [], 'user', state)).toEqual({ kind: 'full', text: TOWER_MODE_FULL_REMINDER });
      expect(selectReminderForContext(true, [reminderEntry('full'), assistant, assistant], 'custom', state)).toEqual({
        kind: 'sparse',
        text: TOWER_MODE_SPARSE_REMINDER,
      });
    }
    expect(selectReminderForContext(true, [], 'user')).toEqual({ kind: 'full', text: TOWER_MODE_FULL_REMINDER });
  });

  it('adds the playbook of the recorded mode, before the objective is drafted and while it is open', () => {
    expect(selectReminderForContext(true, [], 'user', { objectiveMode: 'headless' })).toEqual({
      kind: 'full',
      text: `${TOWER_MODE_FULL_REMINDER}\n\n${TOWER_OBJECTIVE_HEADLESS_PLAYBOOK}`,
    });
    expect(
      selectReminderForContext(true, [reminderEntry('exit')], 'user', {
        objectiveMode: 'interactive',
        objective: objective('awaiting-approval'),
      }),
    ).toEqual({ kind: 'full', text: `${TOWER_MODE_FULL_REMINDER}\n\n${TOWER_OBJECTIVE_PLAYBOOK}` });
    expect(
      selectReminderForContext(true, [reminderEntry('full'), assistant, assistant], 'custom', {
        objectiveMode: 'interactive',
        objective: objective('executing'),
      }),
    ).toEqual({ kind: 'sparse', text: `${TOWER_MODE_SPARSE_REMINDER} ${TOWER_OBJECTIVE_SPARSE_REMINDER}` });
    expect(
      selectReminderForContext(true, [reminderEntry('full'), assistant], 'custom', { objectiveMode: 'headless' }),
    ).toBeUndefined();
  });

  it('drops the playbook once the objective is terminal and never adds it to the exit reminder', () => {
    for (const status of ['completed', 'blocked'] as const) {
      expect(
        selectReminderForContext(true, [], 'user', { objectiveMode: 'headless', objective: objective(status) }),
      ).toEqual({ kind: 'full', text: TOWER_MODE_FULL_REMINDER });
    }
    expect(
      selectReminderForContext(false, [reminderEntry('full')], 'user', {
        objectiveMode: 'headless',
        objective: objective('executing'),
      }),
    ).toEqual({ kind: 'exit', text: TOWER_MODE_EXIT_REMINDER });
    expect(selectReminderForContext(false, [], 'user', { objectiveMode: 'headless' })).toBeUndefined();
  });
});
