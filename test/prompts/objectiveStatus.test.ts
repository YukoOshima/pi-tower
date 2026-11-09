import { describe, expect, it } from 'vitest';

import {
  FEATURE_STATUS_MARKERS,
  MILESTONE_STATUS_MARKERS,
  OBJECTIVE_GOAL_PREVIEW_MAX,
  OBJECTIVE_STATUS_MARKERS,
  renderObjectiveStatus,
  type ObjectiveStatusInput,
} from '../../src/prompts/objectiveStatus.ts';
import type {
  PromptMilestone,
  PromptObjective,
  PromptValidationRound,
} from '../../src/prompts/objectiveTypes.ts';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const SPEC = { scrutiny: true, userTesting: true, commands: ['npm test'] };

function round(
  kind: PromptValidationRound['kind'],
  number: number,
  verdict: PromptValidationRound['verdict'],
  commit = 'a1a1a1a1',
  failures: readonly string[] = [],
): PromptValidationRound {
  return { round: number, kind, validator: `v-${kind}-${String(number)}`, validatedCommit: commit, verdict, failures };
}

function milestone(overrides: Partial<PromptMilestone> & Pick<PromptMilestone, 'id' | 'order'>): PromptMilestone {
  return { title: `Milestone ${overrides.id}`, validation: SPEC, status: 'pending', rounds: [], ...overrides };
}

function objective(overrides: Partial<PromptObjective> = {}): PromptObjective {
  return {
    id: 'O1',
    title: 'CSV export',
    goal: 'Users can export\nreports as CSV.',
    definitionOfDone: ['CSV export works'],
    acceptanceCommands: ['npm run e2e'],
    status: 'executing',
    startedAt: '2026-11-09T10:37:00.000Z',
    usage: { costUsd: 8.4 },
    limits: { maxValidationRounds: 3, maxFeatureAttempts: 3, maxCostUsd: 20 },
    approvedBy: 'human',
    milestones: [
      milestone({
        id: 'MS1',
        order: 1,
        title: 'Exporter core',
        status: 'passed',
        rounds: [round('scrutiny', 1, 'fail', 'a0', ['x']), round('scrutiny', 2, 'pass'), round('user-testing', 1, 'pass'), round('commands', 1, 'pass')],
      }),
      milestone({ id: 'MS2', order: 2, title: 'CLI polish', status: 'active' }),
      milestone({ id: 'MS3', order: 3, title: 'Docs', validation: { scrutiny: true, userTesting: false, commands: [] } }),
    ],
    ...overrides,
  };
}

function input(overrides: Partial<ObjectiveStatusInput> = {}): ObjectiveStatusInput {
  return {
    objective: objective(),
    features: [
      { id: 'M1', title: 'Exporter', status: 'merged', milestone: 'MS1' },
      { id: 'M2', title: 'Old exporter', status: 'abandoned', milestone: 'MS1' },
      { id: 'M3', title: 'Fix header', status: 'merged', milestone: 'MS1', origin: 'fix' },
      { id: 'M4', title: 'Flags', status: 'merged', milestone: 'MS2' },
      { id: 'M5', title: 'Help text', status: 'active', milestone: 'MS2', attempts: 2 },
      { id: 'M6', title: 'Docs page', status: 'planned', milestone: 'MS3' },
    ],
    agents: [
      { name: 'agent-help', kind: 'worker', missionId: 'M5' },
      { name: 'reviewer-m4', kind: 'reviewer', reviewTarget: 'feat/flags' },
    ],
    nowMs: NOW,
    ...overrides,
  };
}

describe('renderObjectiveStatus — header', () => {
  it('shows the title, status, elapsed time, cost, and approval', () => {
    const text = renderObjectiveStatus(input());
    expect(text.split('\n').slice(0, 3)).toEqual([
      '# Objective O1 — CSV export',
      '🔵 executing · elapsed 1h 23m · cost $8.40 of $20.00 · approved by human',
      'Goal: Users can export reports as CSV.',
    ]);
  });

  it('handles an objective that has not started, has a wall-time limit, or ran to completion', () => {
    const planning = renderObjectiveStatus(
      input({ objective: objective({ status: 'planning', startedAt: undefined, usage: undefined, limits: undefined, approvedBy: undefined }) }),
    );
    expect(planning.split('\n')[1]).toBe('📝 planning · not started');
    const limited = renderObjectiveStatus(
      input({ objective: objective({ limits: { maxValidationRounds: 3, maxWallTimeMs: 14_400_000 } }) }),
    );
    expect(limited).toContain('elapsed 1h 23m of 4h 00m · cost $8.40 ·');
    const done = renderObjectiveStatus(input({ objective: objective({ status: 'completed', completedAt: '2026-11-09T11:00:00.000Z' }) }));
    expect(done).toContain('✅ completed · elapsed 23m 00s');
  });

  it('states why the objective is blocked, paused, or awaiting approval', () => {
    expect(renderObjectiveStatus(input({ objective: objective({ status: 'blocked', blockedReason: 'stalled' }) }))).toContain('\nBlocked: stalled\n');
    expect(renderObjectiveStatus(input({ objective: objective({ status: 'paused', pausedReason: 'cost limit' }) }))).toContain('\nPaused: cost limit\n');
    expect(
      renderObjectiveStatus(input({ objective: objective({ status: 'awaiting-approval', approvalReason: 'contract-changed' }) })),
    ).toContain('\nApproval reason: contract-changed\n');
  });

  it('previews a long goal on one line', () => {
    const text = renderObjectiveStatus(input({ objective: objective({ goal: 'g'.repeat(OBJECTIVE_GOAL_PREVIEW_MAX + 10) }) }));
    expect(text).toContain(`Goal: ${'g'.repeat(OBJECTIVE_GOAL_PREVIEW_MAX)}…\n`);
  });
});

describe('renderObjectiveStatus — milestones', () => {
  it('lists milestones in order with markers, merged/total features, and validation per kind', () => {
    const text = renderObjectiveStatus(input());
    expect(text).toContain(
      [
        '## Milestones',
        '✅ MS1 Exporter core — passed · features 2/3 merged (1 abandoned, 1 fix) · scrutiny r2 pass · user-testing r1 pass · commands r1 pass',
        '🔵 MS2 CLI polish — active · features 1/2 merged · validation: scrutiny · user-testing · commands `npm test`',
        '⚪ MS3 Docs — pending · features 0/1 merged · validation: scrutiny · commands `npm run e2e`',
      ].join('\n'),
    );
  });

  it('shows running, pending, and failed validation rounds', () => {
    const validating = milestone({
      id: 'MS2',
      order: 2,
      title: 'CLI polish',
      status: 'validating',
      validationCommit: 'c0ffee1234',
      rounds: [
        round('user-testing', 1, 'fail', 'beef0000', ['a', 'b']),
        round('commands', 1, 'fail', 'c0ffee1234', ['npm test exited 1']),
      ],
    });
    const text = renderObjectiveStatus(
      input({
        objective: objective({ milestones: [validating] }),
        agents: [{ name: 'val-ms2-scrutiny-r1', kind: 'validator', milestoneId: 'MS2', validationKind: 'scrutiny', validationRound: 1 }],
      }),
    );
    expect(text).toContain(
      '🔍 MS2 CLI polish — validating c0ffee1 · features 1/2 merged · scrutiny r1 running · user-testing r2 pending · commands r1 fail (1 failure; 1/3 failed rounds)',
    );
    expect(text).toContain('- val-ms2-scrutiny-r1 — validator · MS2 scrutiny r1');
    expect(text).toContain('## Next\nValidating MS2 on c0ffee1 — waiting for scrutiny, user-testing; it passes when every required kind passes on the same commit.');
  });

  it('marks failed and never-run kinds and honours skipped kinds', () => {
    const failed = milestone({
      id: 'MS1',
      order: 1,
      status: 'failed',
      rounds: [round('scrutiny', 1, 'fail', 'c1', ['x', 'y'])],
    });
    const text = renderObjectiveStatus(input({ objective: objective({ milestones: [failed] }), skipKinds: ['user-testing'] }));
    expect(text).toContain('❌ MS1 Milestone MS1 — failed · features 2/3 merged (1 abandoned, 1 fix) · scrutiny r1 fail (2 failures; 1/3 failed rounds) · commands not run');
    expect(text).not.toContain('user-testing');
    expect(text).toContain('## Next\nMS1 failed validation — the orchestrator plans fix features into it (TowerPlan with milestone="MS1", origin "fix").');
  });

  it('says when nothing is planned yet', () => {
    const text = renderObjectiveStatus(input({ objective: objective({ status: 'planning', milestones: [] }), features: [], agents: [] }));
    expect(text).toContain('## Milestones\nnone yet');
    expect(text).toContain('## Live agents\nnone');
    expect(text).not.toContain('## Current milestone');
  });

  it('describes milestones without any required validation', () => {
    const bare = milestone({ id: 'MS1', order: 1, status: 'active', validation: { scrutiny: false, userTesting: false, commands: [] } });
    const text = renderObjectiveStatus(
      input({ objective: objective({ acceptanceCommands: [], milestones: [bare, milestone({ id: 'MS2', order: 2 })] }) }),
    );
    expect(text).toContain('🔵 MS1 Milestone MS1 — active · features 2/3 merged (1 abandoned, 1 fix) · validation: none');
  });
});

describe('renderObjectiveStatus — features and agents', () => {
  it('details the current milestone features with workers and attempts', () => {
    const text = renderObjectiveStatus(input());
    expect(text).toContain(
      [
        '## Current milestone MS2 — features (run in parallel)',
        '- ✅ M4 Flags — merged',
        '- 🔵 M5 Help text — active · worker agent-help · attempt 2/3',
      ].join('\n'),
    );
  });

  it('lists live agents with what they work on', () => {
    const text = renderObjectiveStatus(input());
    expect(text).toContain('## Live agents (2)\n- agent-help — worker · M5 Help text\n- reviewer-m4 — reviewer · feat/flags');
  });

  it('says when the current milestone has no features', () => {
    const text = renderObjectiveStatus(input({ features: [] }));
    expect(text).toContain('## Current milestone MS2 — features (run in parallel)\nnone planned yet');
    expect(text).toContain('## Next\nMS2 has no features yet — the orchestrator plans them (TowerPlan with milestone="MS2").');
  });
});

describe('renderObjectiveStatus — next expected step', () => {
  function next(overrides: Partial<ObjectiveStatusInput>): string {
    const text = renderObjectiveStatus(input(overrides));
    return text.slice(text.indexOf('## Next\n') + '## Next\n'.length);
  }

  it('follows the objective lifecycle', () => {
    expect(next({ objective: objective({ status: 'planning' }) })).toContain('requests approval');
    expect(next({ objective: objective({ status: 'awaiting-approval' }) })).toBe(
      'Waiting for the human: approve with /tower approve, or tell the orchestrator what to change.',
    );
    expect(next({ objective: objective({ status: 'paused', pausedReason: 'cost limit' }) })).toBe('Paused (cost limit) — /tower resume continues.');
    expect(next({ objective: objective({ status: 'blocked' }) })).toBe('Blocked — the human decides; /tower resume continues.');
    expect(next({ objective: objective({ status: 'completed', completedAt: '2026-11-09T11:00:00.000Z' }) })).toBe(
      'Done — completed at 2026-11-09T11:00:00.000Z.',
    );
  });

  it('follows the current milestone while executing', () => {
    expect(next({})).toBe('1 of 2 features of MS2 still open, running in parallel — validation starts once every feature is merged or abandoned.');
    const allMerged = input().features.map((feature) => ({ ...feature, status: 'merged' as const }));
    expect(next({ features: allMerged })).toBe('Every feature of MS2 is merged or abandoned — validation starts on the current base tip.');
    const blocked = objective({ milestones: [milestone({ id: 'MS1', order: 1, status: 'blocked' })] });
    expect(next({ objective: blocked })).toBe('MS1 is blocked — the human decides how to continue.');
    const passed = objective({ milestones: [milestone({ id: 'MS1', order: 1, status: 'passed' })] });
    expect(next({ objective: passed })).toBe(
      'Every milestone passed — the objective completes once the final validation is stamped on the current base tip.',
    );
  });

  it('accepts a caller-supplied next step', () => {
    expect(next({ nextStep: 'Rebasing M5 onto main.' })).toBe('Rebasing M5 onto main.');
  });
});

describe('status markers', () => {
  it('cover every status with the project palette', () => {
    expect(Object.keys(OBJECTIVE_STATUS_MARKERS)).toEqual(['planning', 'awaiting-approval', 'executing', 'paused', 'completed', 'blocked']);
    expect(Object.keys(MILESTONE_STATUS_MARKERS)).toEqual(['pending', 'active', 'validating', 'passed', 'failed', 'blocked']);
    expect(FEATURE_STATUS_MARKERS).toEqual({
      planned: '🟡',
      active: '🔵',
      completed: '🟢',
      blocked: '🔴',
      paused: '⏸️',
      merged: '✅',
      abandoned: '🚫',
    });
  });
});
