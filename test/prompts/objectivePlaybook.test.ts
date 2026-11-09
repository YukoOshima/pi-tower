import { describe, expect, it } from 'vitest';

import {
  TOWER_MODE_EXIT_REMINDER,
  TOWER_MODE_FULL_REMINDER,
  TOWER_MODE_SPARSE_REMINDER,
  TOWER_OBJECTIVE_HEADLESS_PLAYBOOK,
  TOWER_OBJECTIVE_PLAYBOOK,
  TOWER_OBJECTIVE_SPARSE_REMINDER,
  selectTowerModeReminder,
  type TowerModeReminderInput,
  type TowerReminderHistoryEntry,
} from '../../src/prompts/index.ts';

const reminderEntry: TowerReminderHistoryEntry = { role: 'user', injected: true };
const assistant: TowerReminderHistoryEntry = { role: 'assistant' };

function assistants(count: number): TowerReminderHistoryEntry[] {
  return Array.from({ length: count }, () => assistant);
}

const CASES: readonly Omit<TowerModeReminderInput, 'objective'>[] = [
  { active: false, history: [] },
  { active: true, history: [] },
  { active: true, last: { index: 0, kind: 'exit' }, history: [reminderEntry] },
  { active: false, last: { index: 0, kind: 'full' }, history: [reminderEntry] },
  { active: true, last: { index: 0, kind: 'full' }, history: [reminderEntry, assistant] },
  { active: true, last: { index: 0, kind: 'full' }, history: [reminderEntry, ...assistants(2)] },
  { active: true, last: { index: 0, kind: 'sparse' }, history: [reminderEntry, ...assistants(5)] },
];

describe('TOWER_OBJECTIVE_PLAYBOOK', () => {
  it('walks the orchestrator through the objective lifecycle in order', () => {
    const steps = [
      '## Objective mode',
      '1. **Plan with the human, then draft.**',
      '2. **Give every milestone a validation contract.**',
      '3. **Plan features with `TowerPlan(milestone)`.**',
      '4. **Request approval — never self-approve.**',
      '5. **Let the autopilot run the mechanics.**',
      '6. **Own the judgment work.**',
    ];
    const positions = steps.map((step) => TOWER_OBJECTIVE_PLAYBOOK.indexOf(step));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('plans with the human before drafting and keeps the contract verifiable', () => {
    for (const sentence of [
      'ask in your reply and end your turn instead of guessing material requirements',
      'TowerObjective(action="draft")',
      'verifiable `definition_of_done` items',
      '`acceptance_commands`',
      'scrutiny (a validator reviews the merged diff',
      'user-testing (a validator exercises the product the way a user would',
      '`qa_instructions`',
      'Milestone commands and acceptance commands run mechanically in a fresh detached checkout of the base tip with no installed dependencies or build output, so each command must include its own setup (e.g. `npm ci && npm test`).',
      'passing `milestone` on every item',
      'the features inside a milestone run in parallel',
    ]) {
      expect(TOWER_OBJECTIVE_PLAYBOOK).toContain(sentence);
    }
  });

  it('reserves approval for the human and completion for the gate', () => {
    for (const sentence of [
      'TowerObjective(action="request-approval")',
      'tell them to approve with `/tower approve`',
      'Approval belongs to the human alone: no tool can approve, and you never state or imply that the plan is approved.',
      'Completion is automatic and gated — never declare it yourself.',
    ]) {
      expect(TOWER_OBJECTIVE_PLAYBOOK).toContain(sentence);
    }
  });

  it('hands the mechanics to the autopilot and keeps the judgment duties', () => {
    for (const sentence of [
      'it spawns workers, reviewers, and validators',
      'starts validation once every feature of the current milestone is merged or abandoned',
      'Do not duplicate these steps and do not poll',
      'With the autopilot off (`objective.autopilot=false`), you drive feature execution yourself with the work cycle above — spawn workers and reviewers, rebase, merge — but validation start, milestone advancement, and objective completion stay automatic in both modes',
      'never start a validation yourself (spawn a validator only to recover a validation-stuck round)',
      '- review-stuck, validation-stuck → reviewers or validators keep ending without a verdict',
      '- validation-failed → read every failure, then plan fix features into the same milestone with `TowerPlan(milestone, origin="fix")`',
      '- plan-milestone →',
      '- blocker →',
      '- rebase-conflict, merge-blocked →',
      '- feature-attempts-exhausted, stalled →',
      'TowerObjective(action="block", reason)',
      'escalate only what you cannot decide',
    ]) {
      expect(TOWER_OBJECTIVE_PLAYBOOK).toContain(sentence);
    }
  });
});

describe('TOWER_OBJECTIVE_HEADLESS_PLAYBOOK', () => {
  it('plans without questions and records assumptions as notes', () => {
    expect(TOWER_OBJECTIVE_HEADLESS_PLAYBOOK).toContain('1. **Plan without asking, then draft.**');
    expect(TOWER_OBJECTIVE_HEADLESS_PLAYBOOK).toContain(
      'nobody answers questions, so never ask one and never wait for a reply',
    );
    expect(TOWER_OBJECTIVE_HEADLESS_PLAYBOOK).toContain(
      'record each assumption as a note (`TowerObjective` with `note`)',
    );
    expect(TOWER_OBJECTIVE_HEADLESS_PLAYBOOK).toContain(
      'block only when no reasonable decision exists',
    );
    expect(TOWER_OBJECTIVE_HEADLESS_PLAYBOOK).not.toContain('ask in your reply');
    expect(TOWER_OBJECTIVE_HEADLESS_PLAYBOOK).not.toContain('tell them to approve');
  });

  it('shares the contract, autopilot, and judgment sections with the interactive playbook', () => {
    for (const shared of [
      'Milestone commands and acceptance commands run mechanically in a fresh detached checkout of the base tip with no installed dependencies or build output, so each command must include its own setup (e.g. `npm ci && npm test`).',
      '2. **Give every milestone a validation contract.**',
      '3. **Plan features with `TowerPlan(milestone)`.**',
      '4. **Request approval — never self-approve.**',
      '5. **Let the autopilot run the mechanics.**',
      '6. **Own the judgment work.**',
      'you never state or imply that the plan is approved',
    ]) {
      expect(TOWER_OBJECTIVE_HEADLESS_PLAYBOOK).toContain(shared);
    }
  });
});

describe('selectTowerModeReminder with an objective', () => {
  it('stays byte-identical without the flag', () => {
    for (const input of CASES) {
      const plain = selectTowerModeReminder(input);
      expect(selectTowerModeReminder({ ...input, objective: undefined })).toEqual(plain);
      if (plain !== undefined) {
        expect(plain.text).toBe(
          { full: TOWER_MODE_FULL_REMINDER, sparse: TOWER_MODE_SPARSE_REMINDER, exit: TOWER_MODE_EXIT_REMINDER }[
            plain.kind
          ],
        );
      }
    }
  });

  it('keeps the cadence and only extends the text', () => {
    for (const input of CASES) {
      const plain = selectTowerModeReminder(input);
      const withObjective = selectTowerModeReminder({ ...input, objective: 'interactive' });
      expect(withObjective?.kind).toBe(plain?.kind);
    }
  });

  it('appends the playbook to the full reminder', () => {
    expect(selectTowerModeReminder({ active: true, history: [], objective: 'interactive' })).toEqual({
      kind: 'full',
      text: `${TOWER_MODE_FULL_REMINDER}\n\n${TOWER_OBJECTIVE_PLAYBOOK}`,
    });
    expect(selectTowerModeReminder({ active: true, history: [], objective: 'headless' })).toEqual({
      kind: 'full',
      text: `${TOWER_MODE_FULL_REMINDER}\n\n${TOWER_OBJECTIVE_HEADLESS_PLAYBOOK}`,
    });
  });

  it('appends the short objective line to the sparse reminder', () => {
    expect(
      selectTowerModeReminder({
        active: true,
        last: { index: 0, kind: 'full' },
        history: [reminderEntry, ...assistants(2)],
        objective: 'headless',
      }),
    ).toEqual({ kind: 'sparse', text: `${TOWER_MODE_SPARSE_REMINDER} ${TOWER_OBJECTIVE_SPARSE_REMINDER}` });
    expect(TOWER_OBJECTIVE_SPARSE_REMINDER).toContain('approval comes only from `/tower approve`');
    expect(TOWER_OBJECTIVE_SPARSE_REMINDER).toContain(
      'Validation start, milestone advancement, and completion are always automatic; the feature mechanics are too unless the autopilot is off.',
    );
    expect(TOWER_OBJECTIVE_SPARSE_REMINDER.length).toBeLessThan(TOWER_OBJECTIVE_PLAYBOOK.length / 5);
  });

  it('leaves the exit reminder untouched', () => {
    expect(
      selectTowerModeReminder({
        active: false,
        last: { index: 0, kind: 'full' },
        history: [reminderEntry],
        objective: 'interactive',
      }),
    ).toEqual({ kind: 'exit', text: TOWER_MODE_EXIT_REMINDER });
  });
});
