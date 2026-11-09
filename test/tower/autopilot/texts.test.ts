import { describe, expect, it } from 'vitest';

import { continueResumePrompt, workerIdleWake } from '../../../src/tower/autopilot/texts.ts';

const BUILD = { id: 'M3', title: 'Core A', branch: 'feat/core-a', milestone: 'MS1', kind: 'build' as const };

describe('continue resume prompt', () => {
  it('names the three ways to end a turn and forbids stopping silently', () => {
    const lines = continueResumePrompt(BUILD).split('\n');
    expect(lines[0]).toBe(
      'continue: Read TowerInbox first — an answer may be waiting. Your mission M3 "Core A" (branch feat/core-a) is still active, but you are idle without TowerComplete, a blocker or an unanswered message — a result or a question that is only in your final text reaches no one.',
    );
    expect(lines.slice(2)).toEqual([
      '1. The work is done → run the tests, commit, and finish with TowerComplete(report) — the autopilot spawns a reviewer for the new tip.',
      '2. Something only others can give stops you (access, a decision outside your scope, a broken environment) → report it with TowerMission(id="M3", blocker="...").',
      '3. The mission leaves substantive doubt about what to build → TowerSend(to="tower", subject="clarify-request", body=what needs pinning down), then end your turn; the answer comes back through your inbox.',
      'Never stop silently.',
    ]);
  });

  it('asks a survey for its report instead of a reviewed tip', () => {
    const prompt = continueResumePrompt({ ...BUILD, kind: 'survey' });
    expect(prompt).toContain('1. The investigation is done → finish with TowerComplete(report=the full result).');
    expect(prompt).toContain('3. The mission leaves substantive doubt about what to investigate →');
    expect(prompt).not.toContain('reviewer');
  });
});

describe('worker-idle wake', () => {
  it('quotes only the tail of a long last message', () => {
    const text = workerIdleWake({
      mission: BUILD,
      worker: 'ap-w-M3-1',
      lastText: `${'x'.repeat(3_000)}\nWhich storage format should I use?\n`,
      autopilot: true,
      nudged: true,
    });
    const quote = text.split('\n\n')[1]!;
    expect(quote).toMatch(/^Its last message:\n> …x+\n> Which storage format should I use\?$/);
    expect(quote.length).toBeLessThan(1_600);
  });

  it('says nothing about resuming when the autopilot has not nudged the worker yet', () => {
    const text = workerIdleWake({ mission: { ...BUILD, milestone: undefined }, worker: 'w', autopilot: true, nudged: false });
    expect(text.split('\n')[0]).toBe(
      'worker-idle: worker w on feature M3 "Core A" (branch feat/core-a) is idle without TowerComplete, a blocker or an unanswered message, and the feature is still active.',
    );
  });
});
