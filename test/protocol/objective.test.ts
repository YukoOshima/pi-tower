import { describe, expect, it } from 'vitest';

import {
  TowerProtocolError,
  applyObjectiveUpdate,
  buildObjective,
  currentMilestone,
  deriveMilestoneStatus,
  estimateObjectiveRuns,
  evaluateObjective,
  finalMilestone,
  forwardDependencies,
  milestoneMissions,
  nextValidationRound,
  objectiveApprovalProblems,
  requiredValidationKinds,
  validationCommands,
} from '../../src/protocol/index.ts';
import type {
  TowerMilestone,
  TowerMission,
  TowerMissionStatus,
  TowerObjective,
  TowerState,
  TowerValidationKind,
  TowerValidationRound,
  TowerValidationVerdict,
} from '../../src/protocol/index.ts';

const C1 = 'a'.repeat(40);
const C2 = 'b'.repeat(40);

function milestone(id: string, order: number, overrides: Partial<TowerMilestone> = {}): TowerMilestone {
  return {
    id,
    title: `Milestone ${id}`,
    order,
    validation: { scrutiny: true, userTesting: true, commands: [] },
    status: 'pending',
    rounds: [],
    ...overrides,
  };
}

function objective(overrides: Partial<TowerObjective> = {}): TowerObjective {
  return {
    id: 'O1',
    title: 'Ship it',
    goal: 'ship the feature',
    definitionOfDone: ['tests pass'],
    acceptanceCommands: [],
    status: 'executing',
    milestones: [milestone('MS1', 1), milestone('MS2', 2)],
    limits: { maxValidationRounds: 3, maxFeatureAttempts: 3 },
    createdAt: '2026-01-01T00:00:00.000Z',
    notes: [],
    ...overrides,
  };
}

function mission(
  id: string,
  milestoneId: string | undefined,
  status: TowerMissionStatus = 'planned',
  kind: TowerMission['kind'] = 'build',
): TowerMission {
  return {
    id,
    title: `Mission ${id}`,
    slug: id.toLowerCase(),
    kind,
    scope: [`src/${id.toLowerCase()}/**`],
    branch: `feat/${id.toLowerCase()}`,
    worktree: `wt-${id.slice(1)}`,
    deps: [],
    status,
    tasks: [],
    notes: [],
    blockers: [],
    ...(milestoneId === undefined ? {} : { milestone: milestoneId }),
  };
}

function state(obj: TowerObjective | undefined, missions: TowerMission[] = []): TowerState {
  return {
    version: 1,
    base: 'main',
    mode: 'branch',
    createdAt: '2026-01-01T00:00:00.000Z',
    roster: { agents: [] },
    missions,
    ...(obj === undefined ? {} : { objective: obj }),
  };
}

function round(
  kind: TowerValidationKind,
  n: number,
  verdict: TowerValidationVerdict,
  commit = C1,
): TowerValidationRound {
  return {
    round: n,
    kind,
    validator: kind === 'commands' ? 'tower' : `val-${kind}-${String(n)}`,
    validatedCommit: commit,
    verdict,
    failures: verdict === 'fail' ? ['broken'] : [],
    file: `.tower/comms/validations/validation-ms1-${kind}-r${String(n)}.md`,
    date: '2026-01-02T00:00:00.000Z',
  };
}

describe('requiredValidationKinds and validationCommands', () => {
  it('requires scrutiny and user-testing by default and commands only when there are commands', () => {
    const obj = objective();
    expect(requiredValidationKinds(obj, obj.milestones[0]!)).toEqual(['scrutiny', 'user-testing']);
  });

  it('honours the milestone spec and the config skips', () => {
    const obj = objective({
      milestones: [
        milestone('MS1', 1, {
          validation: { scrutiny: false, userTesting: true, commands: ['npm test'] },
        }),
        milestone('MS2', 2),
      ],
    });
    const first = obj.milestones[0]!;
    expect(requiredValidationKinds(obj, first)).toEqual(['user-testing', 'commands']);
    expect(requiredValidationKinds(obj, first, { skipUserTesting: true })).toEqual(['commands']);
    expect(requiredValidationKinds(obj, obj.milestones[1]!, { skipScrutiny: true, skipUserTesting: true })).toEqual([]);
  });

  it('adds the acceptance commands to the final milestone only, without duplicates', () => {
    const obj = objective({
      acceptanceCommands: ['npm run typecheck', 'npm test'],
      milestones: [
        milestone('MS1', 1, { validation: { scrutiny: true, userTesting: true, commands: ['npm test'] } }),
        milestone('MS2', 2, { validation: { scrutiny: true, userTesting: true, commands: ['npm test'] } }),
      ],
    });
    expect(validationCommands(obj, obj.milestones[0]!)).toEqual(['npm test']);
    expect(validationCommands(obj, obj.milestones[1]!)).toEqual(['npm test', 'npm run typecheck']);
    expect(requiredValidationKinds(obj, obj.milestones[1]!, { skipScrutiny: true, skipUserTesting: true })).toEqual([
      'commands',
    ]);
  });

  it('uses the order field, not the array position, to find the final milestone', () => {
    const obj = objective({
      acceptanceCommands: ['make check'],
      milestones: [milestone('MS2', 2), milestone('MS1', 1)],
    });
    expect(finalMilestone(obj)?.id).toBe('MS2');
    expect(validationCommands(obj, obj.milestones[0]!)).toEqual(['make check']);
    expect(validationCommands(obj, obj.milestones[1]!)).toEqual([]);
  });
});

describe('currentMilestone and milestoneMissions', () => {
  it('returns the lowest-order milestone that has not passed', () => {
    const obj = objective({
      milestones: [
        milestone('MS3', 3),
        milestone('MS1', 1, { status: 'passed' }),
        milestone('MS2', 2, { status: 'failed' }),
      ],
    });
    expect(currentMilestone(obj)?.id).toBe('MS2');
    for (const m of obj.milestones) m.status = 'passed';
    expect(currentMilestone(obj)).toBeUndefined();
  });

  it('derives milestone membership from mission.milestone', () => {
    const s = state(objective(), [mission('M1', 'MS1'), mission('M2', 'MS2'), mission('M3', undefined), mission('M4', 'MS1')]);
    expect(milestoneMissions(s, 'MS1').map((m) => m.id)).toEqual(['M1', 'M4']);
    expect(milestoneMissions(s, 'MS9')).toEqual([]);
  });
});

describe('deriveMilestoneStatus', () => {
  function validating(rounds: TowerValidationRound[], overrides: Partial<TowerMilestone> = {}): {
    obj: TowerObjective;
    ms: TowerMilestone;
  } {
    const ms = milestone('MS1', 1, { status: 'validating', validationCommit: C1, rounds, ...overrides });
    return { obj: objective({ milestones: [ms, milestone('MS2', 2)] }), ms };
  }

  it('passes only when every required kind passed on the validation commit', () => {
    const waiting = validating([round('scrutiny', 1, 'pass')]);
    expect(deriveMilestoneStatus(waiting.obj, waiting.ms)).toBe('validating');
    const passed = validating([round('scrutiny', 1, 'pass'), round('user-testing', 1, 'pass')]);
    expect(deriveMilestoneStatus(passed.obj, passed.ms)).toBe('passed');
  });

  it('ignores rounds stamped on another commit', () => {
    const { obj, ms } = validating([round('scrutiny', 1, 'pass', C2), round('user-testing', 1, 'pass')]);
    expect(deriveMilestoneStatus(obj, ms)).toBe('validating');
  });

  it('fails on any failing round of a required kind on the validation commit', () => {
    const { obj, ms } = validating([round('scrutiny', 1, 'fail')]);
    expect(deriveMilestoneStatus(obj, ms)).toBe('failed');
  });

  it('blocks when the failed rounds of a failing kind reach maxValidationRounds', () => {
    const { obj, ms } = validating([
      round('scrutiny', 1, 'fail', C2),
      round('scrutiny', 2, 'fail', C2),
      round('scrutiny', 3, 'fail'),
    ]);
    expect(deriveMilestoneStatus(obj, ms)).toBe('blocked');
  });

  it('lets a resumed milestone pass on a new commit despite exhausted failure counts', () => {
    const { obj, ms } = validating(
      [
        round('scrutiny', 1, 'fail', C1),
        round('scrutiny', 2, 'fail', C1),
        round('scrutiny', 3, 'fail', C1),
        round('scrutiny', 4, 'pass', C2),
        round('user-testing', 1, 'pass', C2),
      ],
      { validationCommit: C2 },
    );
    expect(deriveMilestoneStatus(obj, ms)).toBe('passed');
  });

  it('uses the latest round of a kind on the same commit', () => {
    const { obj, ms } = validating([
      round('scrutiny', 1, 'fail'),
      round('scrutiny', 2, 'pass'),
      round('user-testing', 1, 'pass'),
    ]);
    expect(deriveMilestoneStatus(obj, ms)).toBe('passed');
  });

  it('keeps a failed milestone failed until a new validation starts, but may still block it', () => {
    const failed = validating([round('scrutiny', 1, 'fail'), round('user-testing', 1, 'pass')], { status: 'failed' });
    failed.ms.rounds.push(round('scrutiny', 2, 'pass'));
    expect(deriveMilestoneStatus(failed.obj, failed.ms)).toBe('failed');
    const exhausted = validating(
      [round('user-testing', 1, 'fail', C2), round('user-testing', 2, 'fail', C2), round('scrutiny', 1, 'fail')],
      { status: 'failed' },
    );
    exhausted.ms.rounds.push(round('user-testing', 3, 'fail'));
    expect(deriveMilestoneStatus(exhausted.obj, exhausted.ms)).toBe('blocked');
  });

  it('decides only on rounds of the current contract revision', () => {
    const { obj, ms } = validating([round('scrutiny', 1, 'fail'), round('user-testing', 1, 'pass')]);
    obj.contractRevision = 1;
    expect(deriveMilestoneStatus(obj, ms)).toBe('validating');
    ms.rounds.push({ ...round('scrutiny', 2, 'pass'), contractRevision: 1 });
    expect(deriveMilestoneStatus(obj, ms)).toBe('validating');
    ms.rounds.push({ ...round('user-testing', 2, 'pass'), contractRevision: 1 });
    expect(deriveMilestoneStatus(obj, ms)).toBe('passed');
  });

  it('passes immediately when no kind is required', () => {
    const { obj, ms } = validating([], { validation: { scrutiny: false, userTesting: false, commands: [] } });
    expect(deriveMilestoneStatus(obj, ms)).toBe('passed');
  });

  it('leaves pending, active, passed and blocked milestones alone', () => {
    for (const status of ['pending', 'active', 'passed', 'blocked'] as const) {
      const { obj, ms } = validating([round('scrutiny', 1, 'fail')], { status });
      expect(deriveMilestoneStatus(obj, ms)).toBe(status);
    }
  });

  it('numbers rounds per kind', () => {
    const { ms } = validating([round('scrutiny', 1, 'fail'), round('scrutiny', 2, 'pass'), round('commands', 1, 'pass')]);
    expect(nextValidationRound(ms, 'scrutiny')).toBe(3);
    expect(nextValidationRound(ms, 'commands')).toBe(2);
    expect(nextValidationRound(ms, 'user-testing')).toBe(1);
  });
});

describe('evaluateObjective', () => {
  function completedState(): TowerState {
    const obj = objective({
      milestones: [
        milestone('MS1', 1, {
          status: 'passed',
          validationCommit: C2,
          rounds: [round('scrutiny', 1, 'pass', C2), round('user-testing', 1, 'pass', C2)],
        }),
        milestone('MS2', 2, {
          status: 'passed',
          validationCommit: C1,
          rounds: [round('scrutiny', 1, 'pass'), round('user-testing', 1, 'pass')],
        }),
      ],
    });
    return state(obj, [mission('M1', 'MS1', 'merged'), mission('M2', 'MS2', 'merged'), mission('M3', 'MS2', 'abandoned')]);
  }

  it('reports no-objective without an objective', () => {
    const result = evaluateObjective(state(undefined), C1);
    expect(result.completion).toEqual({
      ready: false,
      blocks: [{ code: 'no-objective', detail: expect.any(String) }],
    });
  });

  it('is ready when every milestone passed, no feature is open and the final pass is on the base tip', () => {
    const result = evaluateObjective(completedState(), C1);
    expect(result.completion).toEqual({ ready: true, blocks: [] });
    expect(result.currentMilestone).toBeUndefined();
    expect(result.milestones.map((m) => [m.id, m.final, m.validationStale])).toEqual([
      ['MS1', false, true],
      ['MS2', true, false],
    ]);
  });

  it('tells a failed final validation on the tip apart from a stale one', () => {
    const s = completedState();
    s.objective!.milestones[1]!.rounds.push(round('scrutiny', 2, 'fail'));
    expect(evaluateObjective(s, C1).completion.blocks).toEqual([
      {
        code: 'final-validation-failed',
        detail: `final milestone MS2 failed scrutiny on the base tip ${C1.slice(0, 7)} — plan a fix into MS2`,
      },
    ]);
    expect(evaluateObjective(s, C2).completion.blocks.map((block) => block.code)).toEqual(['final-validation-stale']);
  });

  it('flags a final validation stamped on an older commit', () => {
    const result = evaluateObjective(completedState(), C2);
    expect(result.completion.blocks.map((block) => block.code)).toEqual(['final-validation-stale']);
  });

  it('flags a final milestone whose passing rounds do not cover a newly required kind', () => {
    const s = completedState();
    s.objective!.acceptanceCommands = ['npm test'];
    const result = evaluateObjective(s, C1);
    expect(result.completion.blocks.map((block) => block.code)).toEqual(['final-validation-stale']);
    expect(evaluateObjective(s, C1, { skipScrutiny: true }).milestones[1]!.requiredKinds).toEqual([
      'user-testing',
      'commands',
    ]);
  });

  it('reports every failed condition with a stable code', () => {
    const s = completedState();
    s.objective!.status = 'paused';
    s.objective!.milestones[1]!.status = 'failed';
    s.missions.push(mission('M4', 'MS2', 'active'), mission('M5', undefined, 'active'));
    const result = evaluateObjective(s, C1);
    expect(result.completion.ready).toBe(false);
    expect(result.completion.blocks.map((block) => block.code)).toEqual([
      'not-executing',
      'milestone-not-passed',
      'open-feature',
    ]);
    expect(result.completion.blocks[2]!.detail).toContain('M4');
  });

  it('reports no-milestones for an empty objective', () => {
    const result = evaluateObjective(state(objective({ milestones: [] })), C1);
    expect(result.completion.blocks.map((block) => block.code)).toEqual(['no-milestones']);
  });

  it('describes per-milestone progress', () => {
    const obj = objective({
      acceptanceCommands: ['npm test'],
      milestones: [
        milestone('MS1', 1, { status: 'active' }),
        milestone('MS2', 2, {
          status: 'validating',
          validationCommit: C2,
          rounds: [round('scrutiny', 1, 'fail', C1), round('scrutiny', 2, 'pass', C2)],
        }),
      ],
    });
    const s = state(obj, [mission('M1', 'MS1', 'merged'), mission('M2', 'MS1', 'abandoned'), mission('M3', 'MS2', 'merged')]);
    const result = evaluateObjective(s, C1);
    expect(result.currentMilestone).toBe('MS1');
    const [first, second] = result.milestones;
    expect(first).toMatchObject({
      id: 'MS1',
      current: true,
      final: false,
      features: ['M1', 'M2'],
      openFeatures: [],
      mergedFeatures: ['M1'],
      requiredKinds: ['scrutiny', 'user-testing'],
      readyForValidation: true,
      validationStale: false,
    });
    expect(second).toMatchObject({
      id: 'MS2',
      current: false,
      final: true,
      commands: ['npm test'],
      requiredKinds: ['scrutiny', 'user-testing', 'commands'],
      readyForValidation: false,
      validationStale: true,
    });
    expect(second!.kinds.map((k) => [k.kind, k.rounds, k.failedRounds, k.latest?.verdict])).toEqual([
      ['scrutiny', 2, 1, 'pass'],
      ['user-testing', 0, 0, undefined],
      ['commands', 0, 0, undefined],
    ]);
  });

  it('is not ready for validation while a required kind already failed on the tip', () => {
    const s = state(
      objective({
        milestones: [
          milestone('MS1', 1, {
            status: 'active',
            validationCommit: C1,
            rounds: [round('scrutiny', 1, 'fail'), round('scrutiny', 2, 'pass', C2)],
          }),
        ],
      }),
      [mission('M1', 'MS1', 'merged')],
    );
    expect(evaluateObjective(s, C1).milestones[0]).toMatchObject({ failedOnTip: ['scrutiny'], readyForValidation: false });
    expect(evaluateObjective(s, C1, { skipScrutiny: true }).milestones[0]).toMatchObject({
      failedOnTip: [],
      readyForValidation: true,
    });
    expect(evaluateObjective(s, C2).milestones[0]).toMatchObject({ failedOnTip: [], readyForValidation: true });
  });

  it('does not mark a milestone without features ready for validation', () => {
    const s = state(objective({ milestones: [milestone('MS1', 1, { status: 'active' })] }));
    expect(evaluateObjective(s, C1).milestones[0]!.readyForValidation).toBe(false);
  });
});

describe('approval preconditions and run estimate', () => {
  it('lists every unmet precondition', () => {
    const obj = objective({ goal: ' ', definitionOfDone: [], milestones: [] });
    expect(objectiveApprovalProblems(state(obj), obj)).toEqual([
      'the goal is empty',
      'the definition of done has no items',
      'there are no milestones',
    ]);
  });

  it('requires a non-abandoned build feature in the first milestone', () => {
    const obj = objective();
    const s = state(obj, [mission('M1', 'MS1', 'abandoned'), mission('M2', 'MS1', 'planned', 'survey'), mission('M3', 'MS2')]);
    expect(objectiveApprovalProblems(s, obj)).toEqual([expect.stringContaining('first milestone MS1')]);
    s.missions.push(mission('M4', 'MS1'));
    expect(objectiveApprovalProblems(s, obj)).toEqual([]);
  });

  it('estimates runs as features plus two per milestone', () => {
    const s = state(objective(), [mission('M1', 'MS1'), mission('M2', 'MS2'), mission('M3', 'MS2', 'abandoned'), mission('M4', undefined)]);
    expect(estimateObjectiveRuns(s)).toBe(6);
    expect(estimateObjectiveRuns(state(undefined))).toBe(0);
  });
});

describe('buildObjective', () => {
  it('assigns ids, defaults and cleans the input', () => {
    const obj = buildObjective(
      state(undefined),
      {
        title: '  Ship it ',
        goal: ' goal ',
        definitionOfDone: [' a ', ' '],
        acceptanceCommands: ['npm test', ''],
        notes: ['n1'],
        milestones: [
          { title: 'First', description: ' d ' },
          { title: 'Second', validation: { userTesting: false, commands: [' make ', ''], qaInstructions: '  ' } },
        ],
      },
      '2026-02-02T00:00:00.000Z',
    );
    expect(obj).toEqual({
      id: 'O1',
      title: 'Ship it',
      goal: 'goal',
      definitionOfDone: ['a'],
      acceptanceCommands: ['npm test'],
      status: 'planning',
      milestones: [
        {
          id: 'MS1',
          title: 'First',
          description: 'd',
          order: 1,
          validation: { scrutiny: true, userTesting: true, commands: [] },
          status: 'pending',
          rounds: [],
        },
        {
          id: 'MS2',
          title: 'Second',
          order: 2,
          validation: { scrutiny: true, userTesting: false, commands: ['make'] },
          status: 'pending',
          rounds: [],
        },
      ],
      limits: { maxValidationRounds: 3, maxFeatureAttempts: 3 },
      createdAt: '2026-02-02T00:00:00.000Z',
      notes: ['n1'],
    });
  });

  it('continues objective and milestone numbering across the history and existing missions', () => {
    const old = objective({ status: 'completed' });
    const s = state(old, [mission('M1', 'MS4', 'merged')]);
    s.objectiveHistory = [objective({ id: 'O3', milestones: [milestone('MS3', 1)] })];
    const obj = buildObjective(s, { title: 'Next', milestones: [{ title: 'A' }] }, '2026-02-02T00:00:00.000Z');
    expect(obj.id).toBe('O4');
    expect(obj.milestones.map((m) => m.id)).toEqual(['MS5']);
  });

  it('validates limits and titles', () => {
    expect(() => buildObjective(state(undefined), { title: ' ' }, 'now')).toThrow(TowerProtocolError);
    expect(() => buildObjective(state(undefined), { title: 'x', milestones: [{ title: '' }] }, 'now')).toThrow(
      /non-blank title/,
    );
    expect(() => buildObjective(state(undefined), { title: 'x', milestones: [{ id: 'MS1', title: 'a' }] }, 'now')).toThrow(
      /must not carry an id/,
    );
    expect(() => buildObjective(state(undefined), { title: 'x', limits: { maxValidationRounds: 0 } }, 'now')).toThrow(
      /maxValidationRounds must be a positive integer/,
    );
    expect(() => buildObjective(state(undefined), { title: 'x', limits: { maxCostUsd: -1 } }, 'now')).toThrow(
      /maxCostUsd must be a positive number/,
    );
    const limited = buildObjective(
      state(undefined),
      { title: 'x', limits: { maxValidationRounds: 5, maxWallTimeMs: 1000, maxCostUsd: 2.5 } },
      'now',
    );
    expect(limited.limits).toEqual({ maxValidationRounds: 5, maxFeatureAttempts: 3, maxWallTimeMs: 1000, maxCostUsd: 2.5 });
  });
});

describe('applyObjectiveUpdate', () => {
  function approved(overrides: Partial<TowerObjective> = {}): TowerState {
    return state(
      objective({ approvedBy: 'human', approvedAt: '2026-01-01T01:00:00.000Z', startedAt: '2026-01-01T01:00:00.000Z', ...overrides }),
      [mission('M1', 'MS1', 'active')],
    );
  }

  it('edits a planning objective without touching its status', () => {
    const s = state(objective({ status: 'planning' }));
    const result = applyObjectiveUpdate(s, { goal: 'new goal', definitionOfDone: ['x', 'y'] });
    expect(result.contractChanged).toBe(true);
    expect(result.objective.status).toBe('planning');
    expect(result.objective.goal).toBe('new goal');
    expect(result.changes).toEqual(['goal', 'definitionOfDone']);
    expect(s.objective!.goal).toBe('ship the feature');
  });

  it('sends an approved objective back to approval on a contract change', () => {
    for (const input of [
      { goal: 'other' },
      { definitionOfDone: ['other'] },
      { acceptanceCommands: ['npm test'] },
      { milestones: [{ id: 'MS2', validation: { commands: ['make'] } }] },
      { milestoneOrder: ['MS2', 'MS1'] },
      { removeMilestones: ['MS2'] },
    ]) {
      const result = applyObjectiveUpdate(approved(), input);
      expect(result.contractChanged).toBe(true);
      expect(result.objective).toMatchObject({ status: 'awaiting-approval', approvalReason: 'contract-changed' });
      expect(result.objective.approvedBy).toBeUndefined();
      expect(result.objective.approvedAt).toBeUndefined();
      expect(result.objective.startedAt).toBe('2026-01-01T01:00:00.000Z');
    }
  });

  it('appends milestones, notes, titles and limits without a new approval', () => {
    const result = applyObjectiveUpdate(approved(), {
      title: 'Renamed',
      notes: ['assumed X'],
      limits: { maxFeatureAttempts: 5 },
      milestones: [{ id: 'MS1', title: 'Renamed MS1', description: 'about' }, { title: 'Third' }],
    });
    expect(result.contractChanged).toBe(false);
    expect(result.objective.status).toBe('executing');
    expect(result.objective.approvedBy).toBe('human');
    expect(result.objective.milestones.map((m) => [m.id, m.order, m.title])).toEqual([
      ['MS1', 1, 'Renamed MS1'],
      ['MS2', 2, 'Milestone MS2'],
      ['MS3', 3, 'Third'],
    ]);
    expect(result.objective.notes).toEqual(['assumed X']);
    expect(result.objective.limits.maxFeatureAttempts).toBe(5);
    expect(result.changes).toEqual(['title', 'limits', 'MS1.title', 'MS1.description', 'appended:MS3', 'notes']);
  });

  it('counts a contract revision for contract changes only', () => {
    const s = state(objective({ status: 'planning' }));
    const first = applyObjectiveUpdate(s, { goal: 'another goal' });
    expect(first.objective.contractRevision).toBe(1);
    s.objective = first.objective;
    const cosmetic = applyObjectiveUpdate(s, { title: 'Renamed', notes: ['n'], milestones: [{ title: 'More' }] });
    expect(cosmetic.objective.contractRevision).toBe(1);
    expect(applyObjectiveUpdate(s, { acceptanceCommands: ['npm test'] }).objective.contractRevision).toBe(2);
    expect(applyObjectiveUpdate(state(objective()), { notes: ['n'] }).objective.contractRevision).toBeUndefined();
  });

  it('treats an unchanged value as no change', () => {
    const result = applyObjectiveUpdate(approved(), {
      goal: ' ship the feature ',
      definitionOfDone: ['tests pass'],
      milestoneOrder: ['MS1', 'MS2'],
      milestones: [{ id: 'MS1', validation: { scrutiny: true } }],
    });
    expect(result.contractChanged).toBe(false);
    expect(result.changes).toEqual([]);
    expect(result.objective.status).toBe('executing');
  });

  it('clears paused and blocked reasons when a contract change re-requests approval', () => {
    const result = applyObjectiveUpdate(approved({ status: 'blocked', blockedReason: 'stalled' }), { goal: 'g2' });
    expect(result.objective.status).toBe('awaiting-approval');
    expect(result.objective.blockedReason).toBeUndefined();
  });

  it('refuses invalid milestone edits', () => {
    expect(() => applyObjectiveUpdate(approved(), { removeMilestones: ['MS1'] })).toThrow(/features M1 are attached/);
    expect(() => applyObjectiveUpdate(approved(), { removeMilestones: ['MS9'] })).toThrow(/no milestone "MS9"/);
    expect(() => applyObjectiveUpdate(approved(), { milestones: [{ id: 'MS9', title: 'x' }] })).toThrow(
      /omit the id to append/,
    );
    expect(() => applyObjectiveUpdate(approved(), { milestoneOrder: ['MS1'] })).toThrow(/exactly once/);
    expect(() => applyObjectiveUpdate(approved(), { milestoneOrder: ['MS1', 'MS1'] })).toThrow(/exactly once/);
    expect(() => applyObjectiveUpdate(approved(), { milestones: [{ title: ' ' }] })).toThrow(/non-blank title/);
    expect(() => applyObjectiveUpdate(state(undefined), { goal: 'x' })).toThrow(/no objective/);
    expect(() => applyObjectiveUpdate(approved({ status: 'completed' }), { notes: ['x'] })).toThrow(/completed/);
  });

  it('never reuses a removed, archived or roster-referenced milestone id', () => {
    const s = state(
      objective({ status: 'planning', milestones: [milestone('MS1', 1), milestone('MS2', 2), milestone('MS3', 3)] }),
    );
    const removed = applyObjectiveUpdate(s, { removeMilestones: ['MS3'] });
    expect(removed.objective.removedMilestones).toEqual(['MS3']);
    s.objective = removed.objective;
    const appended = applyObjectiveUpdate(s, { milestones: [{ title: 'Next' }] });
    expect(appended.objective.milestones.map((m) => m.id)).toEqual(['MS1', 'MS2', 'MS4']);
    s.roster.agents.push({
      name: 'val-x',
      agentId: 'agent-x',
      kind: 'validator',
      milestoneId: 'MS7',
      validationKind: 'scrutiny',
      spawnedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(applyObjectiveUpdate(s, { milestones: [{ title: 'Later' }] }).objective.milestones.at(-1)?.id).toBe('MS8');
    const archived = state(undefined);
    archived.objectiveHistory = [objective({ status: 'blocked', milestones: [milestone('MS1', 1)], removedMilestones: ['MS9'] })];
    expect(buildObjective(archived, { title: 'Again', milestones: [{ title: 'A' }] }, 'now').milestones[0]!.id).toBe('MS10');
  });

  it('refuses a reorder that would leave an open feature waiting for an open feature of a later milestone', () => {
    const s = state(objective({ status: 'planning', milestones: [milestone('MS1', 1), milestone('MS2', 2)] }), [
      mission('M1', 'MS1'),
      { ...mission('M2', 'MS2'), deps: ['M1'] },
      { ...mission('M3', 'MS2', 'merged'), deps: ['M1'] },
    ]);
    expect(forwardDependencies(s, s.objective!)).toEqual([]);
    expect(() => applyObjectiveUpdate(s, { milestoneOrder: ['MS2', 'MS1'] })).toThrow(
      /later milestone: M2 \(MS2\) → M1 \(MS1\) — /,
    );
    s.missions[0]!.status = 'abandoned';
    expect(applyObjectiveUpdate(s, { milestoneOrder: ['MS2', 'MS1'] }).changes).toEqual(['reordered:MS2+MS1']);
  });

  it('allows removing a milestone whose features were all abandoned', () => {
    const s = approved();
    s.missions.push(mission('M2', 'MS2', 'abandoned'));
    const result = applyObjectiveUpdate(s, { removeMilestones: ['MS2'], milestones: [{ title: 'Replacement' }] });
    expect(result.objective.milestones.map((m) => [m.id, m.order])).toEqual([
      ['MS1', 1],
      ['MS3', 2],
    ]);
  });

  it('reopens milestones whose validation contract grew or changed', () => {
    const s = approved({
      acceptanceCommands: ['npm test'],
      milestones: [
        milestone('MS1', 1, { status: 'passed', passedAt: 'p', validationCommit: C1 }),
        milestone('MS2', 2, { status: 'passed', passedAt: 'p', validationCommit: C1 }),
        milestone('MS3', 3, { status: 'failed', validationCommit: C1 }),
      ],
    });
    const grown = applyObjectiveUpdate(s, {
      milestones: [{ id: 'MS1', validation: { commands: ['make lint'] } }, { id: 'MS3', validation: { userTesting: false } }],
    });
    expect(grown.reopened).toEqual(['MS1', 'MS3']);
    expect(grown.objective.milestones.map((m) => [m.id, m.status, m.passedAt])).toEqual([
      ['MS1', 'active', undefined],
      ['MS2', 'passed', 'p'],
      ['MS3', 'active', undefined],
    ]);
    const shrunk = applyObjectiveUpdate(s, { milestones: [{ id: 'MS2', validation: { scrutiny: false } }] });
    expect(shrunk.reopened).toEqual([]);
  });

  it('reopens a passed final milestone when acceptance commands grow, but not when a milestone is appended', () => {
    const s = approved({
      acceptanceCommands: ['npm test'],
      milestones: [
        milestone('MS1', 1, { status: 'passed', validationCommit: C1 }),
        milestone('MS2', 2, { status: 'passed', validationCommit: C1 }),
      ],
    });
    expect(applyObjectiveUpdate(s, { acceptanceCommands: ['npm test', 'npm run e2e'] }).reopened).toEqual(['MS2']);
    const appended = applyObjectiveUpdate(s, { milestones: [{ title: 'More' }] });
    expect(appended.reopened).toEqual([]);
    expect(appended.contractChanged).toBe(false);
  });
});
