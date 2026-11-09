import { describe, expect, it } from 'vitest';

import {
  continueResumePrompt,
  reviewerStoppedWake,
  validatorStoppedWake,
  workerIdleWake,
} from '../../../src/tower/autopilot/texts.ts';

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

describe('wakes for a reviewer or validator the human stopped', () => {
  it('the review waits for the human, who alone decides about a fresh reviewer', () => {
    const [first, options, last] = reviewerStoppedWake({ mission: BUILD, reviewer: 'ap-r-M3-1', tip: '0123456789abcdef' }).split('\n\n');
    expect(first).toBe(
      'review-stuck: the human stopped reviewer ap-r-M3-1 of feature M3 "Core A" (milestone MS1, branch feat/core-a) on tip 0123456 before it submitted a review. The review waits: the autopilot never replaces an agent the human stopped.',
    );
    expect(options!.split('\n')).toEqual([
      'Ask the human how to continue, then act only on the answer:',
      '- review it after all → spawn a fresh reviewer with TowerSpawn(kind="reviewer", review_target="feat/core-a") under a new name;',
      '- rework it first → tell the worker what to change with TowerSend, or TowerResume when it is idle; its next TowerComplete gets a fresh review;',
      '- drop or re-plan it → abandon M3 with TowerMission(id="M3", status="abandoned") and plan replacement features with TowerPlan;',
      '- stop here → block the objective with TowerObjective(action="block", reason).',
    ]);
    expect(last).toBe(
      'Never spawn a replacement reviewer on your own. In a headless run nobody can answer: block the objective and name the stopped reviewer.',
    );
  });

  it('the validation waits for the human, who alone decides about a fresh validator', () => {
    const text = validatorStoppedWake({
      objective: { id: 'O1', title: 'Ship' },
      milestone: { id: 'MS1', title: 'Core' },
      kind: 'user-testing',
      validator: 'ap-v-MS1-user-testing-2',
      commit: 'fedcba9876543210',
    });
    expect(text.split('\n')[0]).toBe(
      'validation-stuck: the human stopped validator ap-v-MS1-user-testing-2 before it submitted a verdict — the user-testing validation of milestone MS1 "Core" on fedcba9 waits (objective O1 "Ship"). The autopilot never replaces an agent the human stopped.',
    );
    expect(text).toContain(
      '- validate after all → spawn a fresh validator with TowerSpawn(kind="validator", milestone="MS1", validation_kind="user-testing") under a new name;',
    );
    expect(text).toContain('- fix something first → plan a fix feature with TowerPlan(milestone="MS1", origin="fix"); the validation runs again once it merges;');
    expect(text.split('\n\n').at(-1)).toBe(
      'Never start a replacement validator on your own. In a headless run nobody can answer: block the objective and name the stopped validator.',
    );
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

  it('after a nudge on this tip names the feature, not the worker, as resumed — a respawned worker never was', () => {
    const text = workerIdleWake({ mission: BUILD, worker: 'ap-w-M3-2', autopilot: true, nudged: true });
    expect(text.split('\n')[0]).toBe(
      'worker-idle: worker ap-w-M3-2 on feature M3 "Core A" (milestone MS1, branch feat/core-a) is idle without TowerComplete, a blocker or an unanswered message, and the feature is still active. A worker of this feature was already resumed once on this tip with a reminder to finish, report a blocker or ask — the autopilot does not resume the feature again until its tip moves.',
    );
  });

  it('says nothing about resuming when the autopilot has not nudged the worker yet', () => {
    const text = workerIdleWake({ mission: { ...BUILD, milestone: undefined }, worker: 'w', autopilot: true, nudged: false });
    expect(text.split('\n')[0]).toBe(
      'worker-idle: worker w on feature M3 "Core A" (branch feat/core-a) is idle without TowerComplete, a blocker or an unanswered message, and the feature is still active.',
    );
  });
});
