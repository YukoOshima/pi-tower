import { describe, expect, it } from 'vitest';

import * as objectiveFormat from '../../src/prompts/objectiveFormat.ts';
import * as objectiveStatus from '../../src/prompts/objectiveStatus.ts';
import * as objectiveWakes from '../../src/prompts/objectiveWakes.ts';
import * as validatorBriefing from '../../src/prompts/validatorBriefing.ts';
import * as validatorNotes from '../../src/prompts/validatorNotes.ts';

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

const OBJECTIVE = {
  id: 'O1',
  title: 'CSV export',
  goal: 'Users can export reports as CSV.',
  definitionOfDone: ['CSV export works'],
  acceptanceCommands: ['npm run e2e'],
};
const SPEC = { scrutiny: true, userTesting: true, commands: ['npm test'], qaInstructions: 'Run the CLI.' };
const ROUND = {
  round: 1,
  kind: 'scrutiny' as const,
  validator: 'v1',
  validatedCommit: 'c0ffee1234',
  verdict: 'fail' as const,
  failures: ['header missing'],
};
const MILESTONE = { id: 'MS1', title: 'Core', order: 1, validation: SPEC, status: 'validating' as const, rounds: [ROUND], validationCommit: 'c0ffee1234' };
const FEATURE = { id: 'M1', title: 'Exporter', status: 'merged' as const, branch: 'feat/exporter', milestone: 'MS1', owner: 'agent-1', tasks: [{ text: 'rows', done: true }] };

function renderedTexts(): readonly { readonly label: string; readonly text: string }[] {
  const samples: Readonly<Record<string, () => string>> = {
    buildValidatorBriefing: () =>
      ['scrutiny', 'user-testing']
        .map((kind) =>
          validatorBriefing.buildValidatorBriefing({
            name: 'v2',
            validationKind: kind === 'scrutiny' ? 'scrutiny' : 'user-testing',
            round: 2,
            objective: OBJECTIVE,
            milestone: MILESTONE,
            finalMilestone: true,
            features: [FEATURE],
            validatedCommit: 'c0ffee1234',
            worktreePath: '/repo/.tower/worktrees/val-ms1-scrutiny-r2',
            repoRoot: '/repo',
            base: 'main',
            instructions: 'extra',
          }),
        )
        .join('\n'),
    resumeValidatorRefusal: () => validatorNotes.resumeValidatorRefusal('v2'),
    renderObjectiveStatus: () =>
      objectiveStatus.renderObjectiveStatus({
        objective: { ...OBJECTIVE, status: 'executing', milestones: [MILESTONE], startedAt: '2026-11-09T10:00:00.000Z' },
        features: [FEATURE],
        agents: [{ name: 'v2', kind: 'validator', milestoneId: 'MS1', validationKind: 'scrutiny', validationRound: 2 }],
        nowMs: Date.parse('2026-11-09T11:00:00.000Z'),
      }),
    describeValidation: () => objectiveFormat.describeValidation(SPEC, OBJECTIVE.acceptanceCommands),
    validationResultWake: () => objectiveWakes.validationResultWake({ objective: OBJECTIVE, milestone: MILESTONE, result: ROUND }),
    fixRequest: () =>
      objectiveWakes.fixRequest({
        objective: OBJECTIVE,
        milestone: MILESTONE,
        validatedCommit: 'c0ffee1234',
        failedRounds: [ROUND],
        failedRoundCounts: { scrutiny: 1 },
        maxValidationRounds: 3,
      }),
    planMilestoneRequest: () =>
      objectiveWakes.planMilestoneRequest({ objective: OBJECTIVE, milestone: MILESTONE, finalMilestone: true }),
    stallReevaluation: () =>
      objectiveWakes.stallReevaluation({ objective: OBJECTIVE, stalledForMs: 1000, stallWakes: 1, maxStallWakes: 3 }),
    featureAttemptsExhausted: () => objectiveWakes.featureAttemptsExhausted({ feature: FEATURE, attempts: 3, maxAttempts: 3 }),
    rebaseConflictWake: () => objectiveWakes.rebaseConflictWake({ feature: FEATURE, files: ['a.ts'] }),
    blockerWake: () => objectiveWakes.blockerWake({ feature: FEATURE, agent: 'agent-1', source: 'question', items: ['?'] }),
    mergeBlockedWake: () =>
      objectiveWakes.mergeBlockedWake({
        feature: FEATURE,
        blocks: ['out-of-scope', 'deps-unmerged', 'base-mismatch', 'base-dirty', 'branch-missing', 'read-only-survey', 'review-mission-mismatch'].map(
          (reason) => ({ reason }),
        ),
      }),
    reviewStuckWake: () => objectiveWakes.reviewStuckWake({ feature: FEATURE, attempts: 3, maxAttempts: 3, recent: [{ name: 'r1' }] }),
    validationStuckWake: () =>
      objectiveWakes.validationStuckWake({
        objective: OBJECTIVE,
        milestone: MILESTONE,
        validationKind: 'user-testing',
        validatedCommit: 'c0ffee1234',
        attempts: 3,
        maxAttempts: 3,
      }),
    budgetPausedNotice: () => objectiveWakes.budgetPausedNotice({ objective: OBJECTIVE, limit: 'wall-time', elapsedMs: 1, maxWallTimeMs: 1 }),
    objectiveCompletedNotice: () =>
      objectiveWakes.objectiveCompletedNotice({ objective: OBJECTIVE, milestones: [MILESTONE], features: [FEATURE], base: 'main', baseTip: 'c0ffee1234' }),
    objectiveBlockedNotice: () => objectiveWakes.objectiveBlockedNotice({ objective: OBJECTIVE, reason: 'stalled', failures: ['x'] }),
    approvalRequest: () =>
      objectiveWakes.approvalRequest({ objective: OBJECTIVE, milestones: [MILESTONE], features: [FEATURE], notes: ['assumed'] }),
  };
  return Object.entries(samples).map(([label, sample]) => ({ label, text: sample() }));
}

describe('objective-mode texts outside the barrel', () => {
  it('render without foreign tool names', () => {
    const texts = renderedTexts();
    expect(texts.length).toBeGreaterThan(15);
    for (const { label, text } of texts) {
      expect(text.length, label).toBeGreaterThan(0);
      for (const pattern of KIMI_ONLY) expect(pattern.test(text), `${label} matches ${String(pattern)}`).toBe(false);
    }
  });

  it('export only functions, strings, string records, and positive integer limits', () => {
    for (const module of [objectiveFormat, objectiveStatus, objectiveWakes, validatorBriefing, validatorNotes]) {
      for (const [name, value] of Object.entries(module)) {
        expect(['function', 'string', 'number', 'object'], name).toContain(typeof value);
        if (typeof value === 'number') expect(Number.isInteger(value) && value > 0, name).toBe(true);
      }
    }
  });
});
