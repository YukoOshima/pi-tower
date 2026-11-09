import { describe, expect, it } from 'vitest';

import {
  TOWER_MODE_DEDUP_MIN_TURNS,
  TOWER_MODE_EXIT_REMINDER,
  TOWER_MODE_FULL_REFRESH_TURNS,
  TOWER_MODE_FULL_REMINDER,
  TOWER_MODE_SPARSE_REMINDER,
  selectTowerModeReminder,
  towerModeReminderVariant,
  type TowerModeReminderKind,
  type TowerReminderHistoryEntry,
} from '../../src/prompts/index.ts';

const reminderEntry: TowerReminderHistoryEntry = { role: 'user', injected: true };
const assistant: TowerReminderHistoryEntry = { role: 'assistant' };
const human: TowerReminderHistoryEntry = { role: 'user' };
const injectedUser: TowerReminderHistoryEntry = { role: 'user', injected: true };
const toolResult: TowerReminderHistoryEntry = { role: 'toolResult' };

function assistants(count: number): TowerReminderHistoryEntry[] {
  return Array.from({ length: count }, () => assistant);
}

class ReminderSession {
  readonly history: TowerReminderHistoryEntry[] = [];
  private last: { readonly index: number; readonly kind: TowerModeReminderKind } | undefined;
  active = false;

  inject(): TowerModeReminderKind | undefined {
    const reminder = selectTowerModeReminder({
      active: this.active,
      last: this.last,
      history: this.history,
    });
    if (reminder === undefined) return undefined;
    this.history.push(reminderEntry);
    this.last = { index: this.history.length - 1, kind: reminder.kind };
    return reminder.kind;
  }
}

describe('tower mode reminder texts', () => {
  it('keeps the full reminder protocol rules', () => {
    for (const sentence of [
      'Tower mode is active',
      'TowerSpawn',
      'TowerMerge',
      'message references and a compact gate digest',
      'with `TowerInbox` only when it is needed',
      'structured reason and recovery details',
      'per reviewer',
      'merged or abandoned',
      'break-glass',
      '.tower/comms/',
      'These tower-specific orchestration choices take precedence over generic agent defaults',
      'Workers and reviewers escalate through `TowerSend` rather than contacting the human directly.',
      'You never write mission code yourself, except for merge-time integration fixes.',
      'Start every dependency-unblocked worker with code-built briefings, then end your turn instead of waiting or polling.',
      'A silently dropped task is unfinished work.',
      'A clean review is approval only when its merge verdict is `merge`; `hold` and `fix-then-merge` never approve a merge.',
      'Steered messages for a running worker become visible at its next step boundary; unread input still prevents premature completion.',
      '**A worker or reviewer stopped by the human is dead by intent: never resume, reassign, or replace it unless the human says otherwise.**',
      'Teardown does not exit tower mode.',
    ]) {
      expect(TOWER_MODE_FULL_REMINDER).toContain(sentence);
    }
    expect(TOWER_MODE_FULL_REMINDER).not.toContain('This supersedes any other instructions');
    expect(TOWER_MODE_FULL_REMINDER).not.toContain('never create or edit files under `.tower/` by hand');
  });

  it('adapts the full reminder to pi', () => {
    expect(TOWER_MODE_FULL_REMINDER).toContain(
      'When the human can answer, clarify material ambiguity before planning by asking in your reply and ending your turn. In print or other non-interactive modes, make a reasonable, recorded decision',
    );
    expect(TOWER_MODE_FULL_REMINDER).toContain(
      '`MISSIONS.md`, not a todo tool. Parallel delegation belongs to `TowerSpawn`, not a subagent tool. Todo and subagent tools are code-denied while tower mode is active.',
    );
    expect(TOWER_MODE_FULL_REMINDER).toContain(
      "quote their file paths in the mission's `context` so workers can read them",
    );
    expect(TOWER_MODE_FULL_REMINDER).toContain(
      'Roster resumes go through `TowerResume`, which always runs the agent in the background so the fleet keeps moving.',
    );
    expect(TOWER_MODE_FULL_REMINDER).toContain('`TowerTasks` and `TowerTaskOutput`');
    expect(TOWER_MODE_FULL_REMINDER).toContain('`TowerTaskStop`');
    expect(TOWER_MODE_FULL_REMINDER).not.toMatch(/goal/i);
  });

  it('limits the merge-only reading of auto-wired dependencies to work outside objective mode', () => {
    expect(TOWER_MODE_FULL_REMINDER).toContain(
      '- Prefer disjoint scopes for build missions. Outside objective mode, auto-wired dependencies order merges only, not spawning or editing; adjust explicit deps when one mission must merge after another. In objective mode, a feature starts only after its deps merge, auto-wired ones included. The merge gate still enforces scope.',
    );
    expect(TOWER_MODE_FULL_REMINDER).not.toMatch(/scopes for build missions\. Auto-wired dependencies order merges only/);
  });

  it('keeps the numbered work cycle intact', () => {
    const steps = [
      '1. **Initialize and plan.**',
      '2. **Spawn in parallel.**',
      '3. **Supervise by evidence.**',
      '4. **Integrate through structured outcomes.**',
      '5. **Diagnose deaths, then close.**',
    ];
    const positions = steps.map((step) => TOWER_MODE_FULL_REMINDER.indexOf(step));
    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(TOWER_MODE_FULL_REMINDER).toContain('## People, agents, and scope');
    expect(TOWER_MODE_FULL_REMINDER).toContain('## Work cycle');
  });

  it('keeps the sparse reminder short and code-denial aware', () => {
    expect(TOWER_MODE_SPARSE_REMINDER).toContain('Tower mode still active');
    expect(TOWER_MODE_SPARSE_REMINDER).toContain('todo and subagent tools are code-denied');
    expect(TOWER_MODE_SPARSE_REMINDER).toContain(
      'never create or edit protocol artifacts under `.tower/comms/` by hand',
    );
    expect(TOWER_MODE_SPARSE_REMINDER).not.toContain('see full instructions earlier');
    expect(TOWER_MODE_SPARSE_REMINDER.length).toBeLessThan(TOWER_MODE_FULL_REMINDER.length / 5);
  });

  it('restores normal capabilities in the exit reminder', () => {
    expect(TOWER_MODE_EXIT_REMINDER).toContain('Tower mode is no longer active');
    expect(TOWER_MODE_EXIT_REMINDER).toContain('(including todo and subagent tools) are restored');
    expect(TOWER_MODE_EXIT_REMINDER).toContain('is preserved on disk');
    expect(TOWER_MODE_EXIT_REMINDER).toContain('Re-enter tower mode with `/mission` or `/tower on`.');
  });
});

describe('towerModeReminderVariant', () => {
  it('uses the upstream thresholds', () => {
    expect(TOWER_MODE_DEDUP_MIN_TURNS).toBe(2);
    expect(TOWER_MODE_FULL_REFRESH_TURNS).toBe(5);
  });

  it('asks for the full reminder when nothing was injected yet', () => {
    expect(towerModeReminderVariant(null, [])).toBe('full');
    expect(towerModeReminderVariant(null, [human, ...assistants(3)])).toBe('full');
  });

  it('skips reinjection below two assistant turns', () => {
    expect(towerModeReminderVariant(0, [reminderEntry])).toBeNull();
    expect(towerModeReminderVariant(0, [reminderEntry, assistant])).toBeNull();
  });

  it('asks for the sparse reminder from two assistant turns', () => {
    expect(towerModeReminderVariant(0, [reminderEntry, ...assistants(2)])).toBe('sparse');
    expect(towerModeReminderVariant(0, [reminderEntry, ...assistants(4)])).toBe('sparse');
  });

  it('refreshes the full reminder from five assistant turns', () => {
    expect(towerModeReminderVariant(0, [reminderEntry, ...assistants(5)])).toBe('full');
    expect(towerModeReminderVariant(0, [reminderEntry, ...assistants(9)])).toBe('full');
  });

  it('refreshes the full reminder when a human message follows an assistant turn', () => {
    expect(towerModeReminderVariant(0, [reminderEntry, assistant, human])).toBe('full');
    expect(towerModeReminderVariant(2, [human, assistant, reminderEntry, assistant, human])).toBe(
      'full',
    );
  });

  it('does not refresh for injected user-role messages', () => {
    expect(towerModeReminderVariant(0, [reminderEntry, assistant, injectedUser])).toBeNull();
    expect(
      towerModeReminderVariant(0, [reminderEntry, assistant, injectedUser, assistant]),
    ).toBe('sparse');
  });

  it('does not duplicate the full reminder when the first objective follows activation directly', () => {
    expect(towerModeReminderVariant(0, [reminderEntry, human])).toBeNull();
  });

  it('counts only assistant messages after the last injection', () => {
    expect(
      towerModeReminderVariant(3, [assistant, assistant, assistant, reminderEntry, assistant]),
    ).toBeNull();
    expect(
      towerModeReminderVariant(0, [reminderEntry, toolResult, assistant, toolResult, assistant]),
    ).toBe('sparse');
  });
});

describe('selectTowerModeReminder', () => {
  it('injects nothing while tower mode was never active', () => {
    expect(selectTowerModeReminder({ active: false, history: [] })).toBeUndefined();
  });

  it('injects the full reminder on first activation and after an exit reminder', () => {
    expect(selectTowerModeReminder({ active: true, history: [] })).toEqual({
      kind: 'full',
      text: TOWER_MODE_FULL_REMINDER,
    });
    expect(
      selectTowerModeReminder({
        active: true,
        last: { index: 0, kind: 'exit' },
        history: [reminderEntry],
      }),
    ).toEqual({ kind: 'full', text: TOWER_MODE_FULL_REMINDER });
  });

  it('injects the exit reminder once after tower mode turns off', () => {
    expect(
      selectTowerModeReminder({
        active: false,
        last: { index: 0, kind: 'full' },
        history: [reminderEntry],
      }),
    ).toEqual({ kind: 'exit', text: TOWER_MODE_EXIT_REMINDER });
    expect(
      selectTowerModeReminder({
        active: false,
        last: { index: 1, kind: 'exit' },
        history: [reminderEntry, reminderEntry],
      }),
    ).toBeUndefined();
  });

  it('follows the cadence while active', () => {
    const last = { index: 0, kind: 'full' as const };
    expect(
      selectTowerModeReminder({ active: true, last, history: [reminderEntry, assistant] }),
    ).toBeUndefined();
    expect(
      selectTowerModeReminder({ active: true, last, history: [reminderEntry, ...assistants(2)] }),
    ).toEqual({ kind: 'sparse', text: TOWER_MODE_SPARSE_REMINDER });
    expect(
      selectTowerModeReminder({ active: true, last, history: [reminderEntry, ...assistants(5)] }),
    ).toEqual({ kind: 'full', text: TOWER_MODE_FULL_REMINDER });
  });

  it('emits the exit reminder only once and returns the full reminder on re-entry', () => {
    const session = new ReminderSession();
    session.active = true;
    expect(session.inject()).toBe('full');
    session.active = false;
    expect(session.inject()).toBe('exit');
    expect(session.inject()).toBeUndefined();
    session.history.push(assistant, human);
    expect(session.inject()).toBeUndefined();
    session.active = true;
    expect(session.inject()).toBe('full');
  });

  it('injects a sparse reminder every two assistant turns and a full one on new human input', () => {
    const session = new ReminderSession();
    session.active = true;
    const injected: (TowerModeReminderKind | undefined)[] = [session.inject()];
    for (let step = 0; step < 4; step += 1) {
      session.history.push(assistant);
      injected.push(session.inject());
    }
    session.history.push(assistant, human);
    injected.push(session.inject());
    expect(injected).toEqual(['full', undefined, 'sparse', undefined, 'sparse', 'full']);
  });
});
