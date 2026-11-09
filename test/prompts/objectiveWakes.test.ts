import { describe, expect, it } from 'vitest';

import type { PromptValidationRound } from '../../src/prompts/objectiveTypes.ts';
import {
  approvalRequest,
  blockerWake,
  budgetPausedNotice,
  estimateObjectiveRuns,
  featureAttemptsExhausted,
  fixRequest,
  mergeBlockedWake,
  objectiveBlockedNotice,
  objectiveCompletedNotice,
  planMilestoneRequest,
  rebaseConflictWake,
  reviewStuckWake,
  stallReevaluation,
  validationResultWake,
  validationStuckWake,
  type ApprovalRequestInput,
} from '../../src/prompts/objectiveWakes.ts';

const OBJECTIVE = {
  id: 'O1',
  title: 'CSV export',
  goal: 'Users can export reports as CSV.',
  definitionOfDone: ['CSV export works', 'Errors exit non-zero'],
  acceptanceCommands: ['npm run e2e'],
};
const MILESTONE = { id: 'MS1', title: 'Exporter core' };
const FEATURE = { id: 'M2', title: 'CLI flag', branch: 'feat/cli-flag', milestone: 'MS1', owner: 'agent-cli' };

const FAILED: PromptValidationRound = {
  round: 2,
  kind: 'scrutiny',
  validator: 'validator-ms1-scrutiny-r2',
  validatedCommit: 'c0ffee1234',
  verdict: 'fail',
  failures: ['src/export.ts:42 drops the header row', 'no test covers quoted fields'],
  file: '.tower/comms/validations/validation-ms1-scrutiny-validator-ms1-scrutiny-r2-r2.md',
};

const APPROVAL: ApprovalRequestInput = {
  objective: OBJECTIVE,
  milestones: [
    { id: 'MS2', title: 'CLI polish', order: 2, validation: { scrutiny: true, userTesting: false, commands: [] } },
    {
      id: 'MS1',
      title: 'Exporter core',
      description: 'Library\nand flag.',
      order: 1,
      validation: { scrutiny: true, userTesting: true, commands: ['npm test'] },
    },
  ],
  features: [
    { id: 'M1', title: 'Exporter', milestone: 'MS1' },
    { id: 'M2', title: 'CLI flag', milestone: 'MS1' },
    { id: 'M3', title: 'Help text', milestone: 'MS1' },
  ],
};

const KIMI_ONLY = [/TaskList/, /(?<![A-Za-z])TaskOutput/, /(?<![A-Za-z])TaskStop/, /run_in_background/, /WaitFor/, /AskUserQuestion/, /kimi/i];

function allTexts(): readonly string[] {
  return [
    validationResultWake({ objective: OBJECTIVE, milestone: MILESTONE, result: FAILED, pendingKinds: ['user-testing'] }),
    validationResultWake({ objective: OBJECTIVE, milestone: MILESTONE, result: { ...FAILED, verdict: 'pass', failures: [] } }),
    fixRequest({
      objective: OBJECTIVE,
      milestone: MILESTONE,
      validatedCommit: FAILED.validatedCommit,
      failedRounds: [FAILED],
      failedRoundCounts: { scrutiny: 2 },
      maxValidationRounds: 3,
    }),
    planMilestoneRequest({
      objective: OBJECTIVE,
      milestone: { id: 'MS2', title: 'CLI polish', validation: { scrutiny: true, userTesting: true, commands: [] } },
      finalMilestone: false,
    }),
    stallReevaluation({ objective: OBJECTIVE, stalledForMs: 180_000, stallWakes: 1, maxStallWakes: 3 }),
    featureAttemptsExhausted({ feature: FEATURE, attempts: 3, maxAttempts: 3 }),
    rebaseConflictWake({ feature: FEATURE, files: ['src/cli.ts'] }),
    blockerWake({ feature: FEATURE, agent: 'agent-cli', source: 'blocker', items: ['missing fixture'] }),
    mergeBlockedWake({ feature: FEATURE, blocks: [{ reason: 'out-of-scope' }] }),
    reviewStuckWake({ feature: FEATURE, attempts: 3, maxAttempts: 3 }),
    validationStuckWake({
      objective: OBJECTIVE,
      milestone: MILESTONE,
      validationKind: 'user-testing',
      validatedCommit: 'c0ffee1234',
      attempts: 3,
      maxAttempts: 3,
    }),
    budgetPausedNotice({ objective: OBJECTIVE, limit: 'cost', costUsd: 1, maxCostUsd: 1 }),
    objectiveCompletedNotice({ objective: OBJECTIVE, milestones: [], features: [], base: 'main', baseTip: 'c0ffee1234' }),
    objectiveBlockedNotice({ objective: OBJECTIVE, reason: 'stalled' }),
    approvalRequest(APPROVAL),
  ];
}

describe('validationResultWake', () => {
  it('reports a failed round informationally and defers fix planning to the validation-failed wake', () => {
    const text = validationResultWake({ objective: OBJECTIVE, milestone: MILESTONE, result: FAILED, pendingKinds: ['user-testing'] });
    expect(text.split('\n')[0]).toBe(
      'validation-result: milestone MS1 "Exporter core" — scrutiny round 2 by validator-ms1-scrutiny-r2: FAIL with 2 failures on c0ffee1 (objective O1 "CSV export").',
    );
    expect(text).toContain(`Report: ${FAILED.file ?? ''}`);
    expect(text).toContain('1. src/export.ts:42 drops the header row\n2. no test covers quoted fields');
    expect(text).toContain(
      'Milestone MS1 "Exporter core" failed on this commit. Fix features are planned from the validation-failed wake (it carries every failing round), not from this message; if fixes for these failures are already planned, do nothing.',
    );
    expect(text.endsWith('Still running on this commit: user-testing — their results arrive separately.')).toBe(true);
    expect(text).not.toContain('TowerPlan');
    expect(text).not.toContain('origin="fix"');
    expect(text).not.toContain('end your turn');
  });

  it('asks for nothing on a pass', () => {
    const text = validationResultWake({
      objective: OBJECTIVE,
      milestone: MILESTONE,
      result: { ...FAILED, verdict: 'pass', failures: [], file: undefined },
      pendingKinds: ['commands'],
    });
    expect(text).toContain(': pass on c0ffee1');
    expect(text).toContain('Still running on this commit: commands. Nothing to do yet');
    expect(text).not.toContain('Report:');
    expect(text).not.toContain('origin="fix"');
    const done = validationResultWake({ objective: OBJECTIVE, milestone: MILESTONE, result: { ...FAILED, verdict: 'pass', failures: [] } });
    expect(done).toContain('the next milestone then becomes current; end your turn.');
  });

  it('counts a single failure in the singular', () => {
    const text = validationResultWake({ objective: OBJECTIVE, milestone: MILESTONE, result: { ...FAILED, failures: ['one'] } });
    expect(text).toContain('FAIL with 1 failure on');
  });
});

describe('fixRequest', () => {
  const text = fixRequest({
    objective: OBJECTIVE,
    milestone: MILESTONE,
    validatedCommit: FAILED.validatedCommit,
    failedRounds: [
      FAILED,
      { ...FAILED, kind: 'commands', round: 1, validator: 'tower', failures: [], file: undefined },
    ],
    failedRoundCounts: { scrutiny: 2, commands: 1 },
    maxValidationRounds: 3,
    openFixFeatures: [{ id: 'M7', title: 'Fix header row', status: 'active' }],
  });

  it('opens with the reason and lists every failing round', () => {
    expect(text.startsWith('validation-failed: milestone MS1 "Exporter core" failed validation on c0ffee1')).toBe(true);
    expect(text).toContain(`### scrutiny round 2 by validator-ms1-scrutiny-r2 — report: ${FAILED.file ?? ''}\n1. src/export.ts:42`);
    expect(text).toContain('### commands round 1 by tower\n(no failures listed — read the report)');
  });

  it('turns failures into fix features planned into the same milestone', () => {
    expect(text).toContain('## Next step — plan fix features into MS1');
    expect(text).toContain('Call TowerPlan with milestone="MS1" and origin="fix" on every item');
    expect(text).toContain('each failure quoted verbatim');
    expect(text).toContain('Planning into the failed milestone reopens it');
    expect(text).toContain(
      '(with the autopilot off, spawn them yourself with TowerSpawn), and validation re-runs automatically on the new base tip',
    );
    expect(text).toContain('TowerObjective(action="update")');
    expect(text).toContain('TowerObjective(action="block", reason)');
  });

  it('warns about the round cap and existing fix features', () => {
    expect(text).toContain('Failed rounds so far: scrutiny 2 of 3, commands 1 of 3.');
    expect(text).toContain('- M7 "Fix header row" (active)');
    expect(text.endsWith('Then end your turn.')).toBe(true);
  });

  it('omits the optional sections when there is nothing to say', () => {
    const bare = fixRequest({
      objective: OBJECTIVE,
      milestone: MILESTONE,
      validatedCommit: 'c0ffee1234',
      failedRounds: [FAILED],
      failedRoundCounts: {},
      maxValidationRounds: 3,
    });
    expect(bare).not.toContain('Failed rounds so far');
    expect(bare).not.toContain('already planned');
  });
});

describe('planMilestoneRequest', () => {
  it('asks to plan the features of the milestone that became current', () => {
    const text = planMilestoneRequest({
      objective: OBJECTIVE,
      milestone: {
        id: 'MS2',
        title: 'CLI polish',
        description: 'Flags and help.',
        validation: { scrutiny: true, userTesting: true, commands: ['npm test'], qaInstructions: 'Run report --help.' },
      },
      finalMilestone: true,
      previous: MILESTONE,
    });
    expect(text.startsWith('plan-milestone: milestone MS2 "CLI polish" is now current but has no features')).toBe(true);
    expect(text).toContain('Milestone MS1 "Exporter core" passed validation.');
    expect(text).toContain('Validation: scrutiny · user-testing · commands `npm test`, `npm run e2e`');
    expect(text).toContain('QA instructions: Run report --help.');
    expect(text).toContain('This is the final milestone');
    expect(text).toContain('Goal: Users can export reports as CSV.');
    expect(text).toContain('1. CSV export works\n2. Errors exit non-zero');
    expect(text).toContain('passing milestone="MS2" on every item');
    expect(text).toContain('run in parallel');
    expect(text).toContain('(with the autopilot off, spawn them yourself with TowerSpawn) — then end your turn.');
  });

  it('lists only the validators that will actually run', () => {
    const text = planMilestoneRequest({
      objective: OBJECTIVE,
      milestone: {
        id: 'MS2',
        title: 'CLI polish',
        validation: { scrutiny: true, userTesting: true, commands: ['npm test'], qaInstructions: 'Run report --help.' },
      },
      finalMilestone: false,
      skipKinds: ['user-testing'],
    });
    expect(text).toContain('Validation: scrutiny · commands `npm test`\n');
    expect(text).not.toContain('user-testing');
    expect(text).not.toContain('QA instructions');
  });

  it('leaves acceptance commands to the final milestone', () => {
    const text = planMilestoneRequest({
      objective: OBJECTIVE,
      milestone: { id: 'MS1', title: 'Core', validation: { scrutiny: true, userTesting: false, commands: [] } },
      finalMilestone: false,
    });
    expect(text).toContain('Validation: scrutiny\n');
    expect(text).not.toContain('npm run e2e');
    expect(text).not.toContain('passed validation.');
  });
});

describe('judgment wakes', () => {
  it('asks the orchestrator to re-evaluate a stall', () => {
    const text = stallReevaluation({
      objective: OBJECTIVE,
      stalledForMs: 185_000,
      stallWakes: 2,
      maxStallWakes: 3,
      milestone: { id: 'MS1', title: 'Exporter core', status: 'active' },
      openFeatures: [{ id: 'M2', title: 'CLI flag', status: 'blocked' }],
    });
    expect(text.startsWith('stalled: objective O1 "CSV export" has made no progress for 3m 05s')).toBe(true);
    expect(text).toContain('(stall wake 2 of 3)');
    expect(text).toContain('Current milestone: MS1 "Exporter core" (active).');
    expect(text).toContain('Open features: M2 "CLI flag" (blocked).');
    expect(text).toContain('TowerObjective(action="block", reason)');
    expect(text).toContain('After 3 stall wakes without progress the objective blocks automatically.');
    expect(stallReevaluation({ objective: OBJECTIVE, stalledForMs: 0, stallWakes: 1, maxStallWakes: 3 })).toContain('Open features: none.');
  });

  it('offers the three ways out of exhausted feature attempts', () => {
    const text = featureAttemptsExhausted({ feature: FEATURE, attempts: 3, maxAttempts: 3, lastOutcome: 'worker timed out' });
    expect(text.startsWith('feature-attempts-exhausted: feature M2 "CLI flag" (milestone MS1, branch feat/cli-flag) used 3 of 3 worker attempts')).toBe(true);
    expect(text).toContain('Last outcome: worker timed out.');
    expect(text).toContain('TowerSpawn(kind="worker", mission_id="M2")');
    expect(text).toContain('TowerMission(id="M2", status="abandoned") and plan smaller replacement features into MS1');
    expect(text).toContain('TowerObjective(action="block", reason)');
  });

  it('routes a rebase conflict to the owner and keeps the judgment', () => {
    const text = rebaseConflictWake({ feature: FEATURE, files: ['src/cli.ts', 'README.md'] });
    expect(text.startsWith('rebase-conflict: feature M2 "CLI flag"')).toBe(true);
    expect(text).toContain('Conflicting files:\n- src/cli.ts\n- README.md');
    expect(text).toContain(
      'The owning worker agent-cli resolves textual conflicts in its own worktree (the autopilot resumes it when it is idle; with the autopilot off, resume it yourself with TowerResume).',
    );
    expect(text).toContain('decide which side wins and tell agent-cli with TowerSend');
    expect(text).toContain('Never work around the merge gate.');
    const orphan = rebaseConflictWake({ feature: { ...FEATURE, owner: undefined }, files: [] });
    expect(orphan).toContain('No worker owns this feature any more: spawn one with TowerSpawn(kind="worker", mission_id="M2")');
    expect(orphan).not.toContain('Conflicting files');
  });

  it('answers blockers and questions from the objective', () => {
    const blocker = blockerWake({ feature: FEATURE, agent: 'agent-cli', source: 'blocker', items: ['  fixture missing  '] });
    expect(blocker.startsWith('blocker: agent-cli on feature M2 "CLI flag" (milestone MS1, branch feat/cli-flag) reported a blocker:\n- fixture missing')).toBe(true);
    expect(blocker).toContain('TowerSend(to="agent-cli", ...)');
    expect(blocker).toContain('TowerResume(agent="agent-cli", prompt="...")');
    expect(blocker).toContain('TowerMission(id="M2", clear_blockers=true)');
    expect(blocker).toContain('in a headless run decide yourself, record the decision with TowerObjective(action="update", note)');
    const question = blockerWake({ feature: FEATURE, agent: 'agent-cli', source: 'question', items: ['csv by default?'] });
    expect(question).toContain('asked a question:\n- csv by default?');
  });

  it('explains merge blocks the autopilot cannot fix', () => {
    const text = mergeBlockedWake({
      feature: FEATURE,
      blocks: [
        { reason: 'out-of-scope', message: 'src/other.ts is outside the mission scope' },
        { reason: 'base-dirty' },
        { reason: 'out-of-scope', message: 'docs/x.md is outside the mission scope' },
        { reason: 'worker-unknown' },
      ],
    });
    expect(text.split('\n')[0]).toBe(
      'merge-blocked: feature M2 "CLI flag" (milestone MS1, branch feat/cli-flag) cannot merge — the gate is blocked for a reason the autopilot cannot fix: out-of-scope, base-dirty, worker-unknown.',
    );
    expect(text).toContain('- out-of-scope: src/other.ts is outside the mission scope\n- base-dirty\n');
    expect(text).toContain('widen its scope with TowerMission(id="M2", scope=[...])');
    expect(text).toContain('ask the human to commit or stash them; never discard them yourself');
    expect(text.match(/- out-of-scope →/g)).toHaveLength(1);
    expect(text).toContain('TowerStatus shows the full gate state of M2');
    expect(text).toContain(
      'Never merge around the gate: once it is ready, the autopilot merges (with the autopilot off, merge with TowerMerge).',
    );
  });
});

describe('stuck wakes', () => {
  it('recovers a review that keeps ending without a verdict', () => {
    const text = reviewStuckWake({
      feature: FEATURE,
      tip: 'abc1234def',
      attempts: 3,
      maxAttempts: 3,
      recent: [
        { name: 'reviewer-m2-a', status: 'failed', reason: '  model error ' },
        { name: 'reviewer-m2-b', status: 'timed_out' },
        { name: 'reviewer-m2-c' },
      ],
    });
    expect(text.split('\n')[0]).toBe(
      'review-stuck: feature M2 "CLI flag" (milestone MS1, branch feat/cli-flag) is stuck in review — 3 of 3 reviewers ended without submitting a review on tip abc1234; the tower will not spawn another reviewer by itself.',
    );
    expect(text).toContain('Recent attempts:\n- reviewer-m2-a: failed — model error\n- reviewer-m2-b: timed_out\n- reviewer-m2-c\n');
    expect(text).toContain('their final messages (TowerTaskOutput), and TowerTasks with active_only=false');
    expect(text).toContain('spawn a fresh reviewer with TowerSpawn(kind="reviewer", review_target="feat/cli-flag") under a new name');
    expect(text).toContain('have the worker simplify it');
    expect(text).toContain('abandon M2 with TowerMission(id="M2", status="abandoned") and plan smaller replacement features into MS1');
    expect(text).toContain('TowerObjective(action="block", reason)');
  });

  it('recovers a validation that keeps ending without a verdict', () => {
    const text = validationStuckWake({
      objective: OBJECTIVE,
      milestone: MILESTONE,
      validationKind: 'scrutiny',
      validatedCommit: 'c0ffee1234',
      attempts: 2,
      maxAttempts: 3,
      recent: [{ name: 'validator-ms1-scrutiny-r2', status: 'timed_out' }],
    });
    expect(text.split('\n')[0]).toBe(
      'validation-stuck: the scrutiny validation of milestone MS1 "Exporter core" on c0ffee1 is stuck — 2 of 3 validators ended without a verdict (objective O1 "CSV export"); the tower will not start another one by itself.',
    );
    expect(text).toContain('Recent attempts:\n- validator-ms1-scrutiny-r2: timed_out');
    expect(text).toContain('a validation worktree that cannot build or start the product');
    expect(text).toContain('TowerSpawn(kind="validator", milestone="MS1", validation_kind="scrutiny") under a new name');
    expect(text).toContain('TowerPlan(milestone="MS1", origin="fix"); validation re-runs automatically once it merges');
    expect(text).toContain("simplify or split it with TowerObjective(action=\"update\") — clearer qa_instructions or smaller milestones; contract changes need the human's approval again");
    expect(text).toContain('TowerObjective(action="block", reason)');
  });

  it('omits the attempt list when nothing is known', () => {
    expect(reviewStuckWake({ feature: FEATURE, attempts: 3, maxAttempts: 3 })).not.toContain('Recent attempts');
    expect(reviewStuckWake({ feature: FEATURE, attempts: 3, maxAttempts: 3 })).toContain(
      'ended without submitting a review; the tower',
    );
  });
});

describe('human notices', () => {
  it('explains a budget pause and how to resume', () => {
    const cost = budgetPausedNotice({ objective: OBJECTIVE, limit: 'cost', costUsd: 12.4, maxCostUsd: 12 });
    expect(cost).toContain('Objective O1 "CSV export" is paused: its cost budget is used up — $12.40 spent of $12.00');
    expect(cost).toContain('raise or remove the limit in tower.json, then run /tower resume');
    const time = budgetPausedNotice({ objective: OBJECTIVE, limit: 'wall-time', elapsedMs: 7_500_000, maxWallTimeMs: 7_200_000 });
    expect(time).toContain('its wall-time limit is reached — 2h 05m elapsed of 2h 00m');
    const unknown = budgetPausedNotice({ objective: OBJECTIVE, limit: 'wall-time' });
    expect(unknown).toContain('0s elapsed of the limit');
  });

  it('summarizes a completed objective', () => {
    const rounds: PromptValidationRound[] = [
      { ...FAILED, round: 1 },
      { ...FAILED, round: 2, verdict: 'pass', failures: [] },
      { ...FAILED, kind: 'user-testing', round: 1, verdict: 'pass', failures: [] },
    ];
    const text = objectiveCompletedNotice({
      objective: OBJECTIVE,
      milestones: [
        { id: 'MS2', title: 'CLI polish', order: 2, rounds: [] },
        { id: 'MS1', title: 'Exporter core', order: 1, rounds },
      ],
      features: [{ status: 'merged' }, { status: 'merged', origin: 'fix' }, { status: 'abandoned' }],
      base: 'main',
      baseTip: 'c0ffee1234',
      elapsedMs: 4_980_000,
      costUsd: 8.4,
    });
    expect(text).toContain('Objective O1 "CSV export" is complete: every milestone passed validation, and the final validation ran on main at c0ffee1.');
    expect(text).toContain('- MS1 "Exporter core" — passed (scrutiny r2, user-testing r1)\n- MS2 "CLI polish" — passed (no validation required)');
    expect(text).toContain('Features: 2 merged (1 fix), 1 abandoned. Elapsed: 1h 23m. Cost: $8.40.');
    expect(text).toContain('1. CSV export works');
    expect(text).toContain('/tower teardown removes the mission worktrees');
  });

  it('explains a blocked objective and the way back', () => {
    const text = objectiveBlockedNotice({
      objective: OBJECTIVE,
      reason: 'milestone MS1 failed scrutiny 3 times',
      milestone: { id: 'MS1', title: 'Exporter core', status: 'blocked' },
      failures: ['header row missing'],
    });
    expect(text).toContain('Objective O1 "CSV export" is blocked: milestone MS1 failed scrutiny 3 times.\nMilestone MS1 "Exporter core" is blocked.');
    expect(text).toContain('Latest failures:\n1. header row missing');
    expect(text).toContain('then run /tower resume (resuming also resets the stall counters)');
    expect(objectiveBlockedNotice({ objective: OBJECTIVE, reason: 'Stalled!' })).toContain('is blocked: Stalled!\n\n');
  });
});

describe('approvalRequest', () => {
  it('estimates runs as features plus two per milestone', () => {
    expect(estimateObjectiveRuns(3, 2)).toBe(7);
    expect(estimateObjectiveRuns(0, 1)).toBe(2);
  });

  it('summarizes the plan, the estimate, and the exact approval command', () => {
    const text = approvalRequest(APPROVAL);
    expect(text.startsWith('Objective O1 "CSV export" is ready for your approval.\n\nGoal: Users can export reports as CSV.')).toBe(true);
    expect(text).toContain('Definition of done:\n1. CSV export works\n2. Errors exit non-zero');
    expect(text).toContain('Acceptance commands (run on the final milestone): `npm run e2e`');
    expect(text).toContain(
      [
        'Milestones — in order; the features inside a milestone run in parallel:',
        '1. MS1 "Exporter core" — 3 features: M1 "Exporter", M2 "CLI flag", M3 "Help text"',
        '   Library and flag.',
        '   validation: scrutiny · user-testing · commands `npm test`',
        '2. MS2 "CLI polish" — features are planned when it becomes current',
        '   validation: scrutiny · commands `npm run e2e`',
      ].join('\n'),
    );
    expect(text).toContain('Estimated runs: ≈ 7 (3 features + 2 × 2 milestones). This is a floor, not a ceiling');
    expect(text).toContain('To approve, run: /tower approve\nOnly you can approve — the orchestrator cannot.');
    expect(text).not.toContain('Assumptions and notes');
  });

  it('lists only the validators that will actually run', () => {
    const text = approvalRequest({ ...APPROVAL, skipKinds: ['user-testing'] });
    expect(text).toContain('   validation: scrutiny · commands `npm test`\n');
    expect(text).toContain('   validation: scrutiny · commands `npm run e2e`');
    expect(text).not.toContain('user-testing');
    const commandsOnly = approvalRequest({ ...APPROVAL, skipKinds: ['scrutiny', 'user-testing'] });
    expect(commandsOnly).toContain('   validation: commands `npm test`\n');
    expect(commandsOnly).toContain('   validation: commands `npm run e2e`');
    expect(commandsOnly).not.toMatch(/scrutiny|user-testing/);
  });

  it('carries the re-approval reason and the recorded assumptions', () => {
    const text = approvalRequest({ ...APPROVAL, approvalReason: 'contract-changed', notes: ['Assumed RFC 4180 quoting.'] });
    expect(text).toContain('is ready for your approval. The contract changed after approval, so the plan needs your approval again.');
    expect(text).toContain('Assumptions and notes:\n- Assumed RFC 4180 quoting.');
    expect(approvalRequest({ ...APPROVAL, approvalReason: 'scope widened' })).toContain('Approval reason: scope widened.');
    expect(approvalRequest({ ...APPROVAL, objective: { ...OBJECTIVE, acceptanceCommands: [] } })).not.toContain('Acceptance commands');
  });
});

describe('objective wake texts', () => {
  it('stay free of foreign tool names and triple newlines', () => {
    for (const text of allTexts()) {
      expect(text.trim()).toBe(text);
      expect(text).not.toMatch(/\n{3,}/);
      for (const pattern of KIMI_ONLY) expect(pattern.test(text), String(pattern)).toBe(false);
    }
  });
});
