import { describe, expect, it } from 'vitest';

import { buildSpawnBriefing } from '../../src/prompts/index.ts';
import type { PromptValidationRound } from '../../src/prompts/objectiveTypes.ts';
import {
  VALIDATION_FAILURES_MAX_CHARS,
  VALIDATION_HISTORY_ROUNDS,
  buildValidatorBriefing,
  type ValidatorBriefingInput,
} from '../../src/prompts/validatorBriefing.ts';

const COMMIT = 'c0ffee1234567890';

function failedRound(
  kind: PromptValidationRound['kind'],
  round: number,
  failures: readonly string[],
): PromptValidationRound {
  return {
    round,
    kind,
    validator: `validator-ms1-${kind}-r${String(round)}`,
    validatedCommit: 'abc1234def',
    verdict: 'fail',
    failures,
  };
}

function input(overrides: Partial<ValidatorBriefingInput> = {}): ValidatorBriefingInput {
  return {
    name: 'validator-ms1-scrutiny-r2',
    validationKind: 'scrutiny',
    round: 2,
    objective: {
      id: 'O1',
      title: 'CSV export',
      goal: 'Users can export reports as CSV from the CLI.',
      definitionOfDone: ['`report export --format csv` writes a valid CSV file', 'Errors exit non-zero with a message'],
      acceptanceCommands: ['npm run e2e'],
    },
    milestone: {
      id: 'MS1',
      title: 'Exporter core',
      description: 'The exporter library and the CLI flag.',
      validation: {
        scrutiny: true,
        userTesting: true,
        commands: ['npm run typecheck', 'npm test'],
        qaInstructions: 'Run `node bin/report.js export --format csv out.csv` and open out.csv.',
      },
      rounds: [
        failedRound('scrutiny', 1, ['src/export.ts:42 drops the header row']),
        { ...failedRound('user-testing', 1, []), verdict: 'pass' },
        failedRound('commands', 1, ['`npm test` exited 1: export.test.ts fails']),
      ],
    },
    finalMilestone: false,
    features: [
      {
        id: 'M1',
        title: 'Exporter library',
        status: 'merged',
        branch: 'feat/exporter-library',
        tasks: [
          { text: 'Write rows as RFC 4180 CSV', done: true },
          { text: 'Escape embedded quotes', done: false },
          { text: 'Stream large reports', done: false, dropped: true },
        ],
      },
      { id: 'M2', title: 'CLI flag', status: 'abandoned', branch: 'feat/cli-flag' },
      { id: 'M3', title: 'Fix header row', status: 'merged', origin: 'fix', tasks: [{ text: 'Emit the header', done: true }] },
    ],
    validatedCommit: COMMIT,
    worktreePath: '/repo/.tower/worktrees/val-ms1-scrutiny-r2',
    repoRoot: '/repo',
    base: 'main',
    ...overrides,
  };
}

describe('buildValidatorBriefing — scrutiny', () => {
  const text = buildValidatorBriefing(input());

  it('names the validator, the milestone, the kind, and the round', () => {
    expect(text.startsWith('You are "validator-ms1-scrutiny-r2", a tower validator agent')).toBe(true);
    expect(text).toContain('assigned the scrutiny validation of milestone MS1 (scrutiny round 2)');
    expect(text).toContain('You verify — you never fix.');
  });

  it('pins the detached worktree, the validated commit, and the read-only rules', () => {
    expect(text).toContain('- Validation worktree (detached, read-only): /repo/.tower/worktrees/val-ms1-scrutiny-r2');
    expect(text).toContain(`- Validated commit: ${COMMIT} — the tip of base "main"`);
    expect(text).toContain('never edit tracked files, never commit, never check out another commit or branch');
    expect(text).toContain('never touch the main checkout (/repo)');
    expect(text).toContain(`git log --first-parent --merges --oneline ${COMMIT}`);
  });

  it('carries the objective goal and definition of done', () => {
    expect(text).toContain('# Objective O1: CSV export');
    expect(text).toContain('Goal: Users can export reports as CSV from the CLI.');
    expect(text).toContain('1. `report export --format csv` writes a valid CSV file\n2. Errors exit non-zero with a message');
    expect(text).toContain('later milestones deliver the rest');
    expect(text).not.toContain('FINAL milestone');
  });

  it('lists the milestone features with their tasks, origin, and abandoned state', () => {
    expect(text).toContain('# Milestone MS1: Exporter core\n\nThe exporter library and the CLI flag.');
    expect(text).toContain('### M1: Exporter library (merged, branch feat/exporter-library)');
    expect(text).toContain('- [x] Write rows as RFC 4180 CSV\n- [ ] Escape embedded quotes\n- [~] Stream large reports (dropped)');
    expect(text).toContain('### M2: CLI flag (abandoned — its work did not land');
    expect(text).toContain('### M3: Fix header row (merged, fix feature)');
  });

  it('lists the milestone commands but not the acceptance commands before the final milestone', () => {
    expect(text).toContain('Milestone commands:\n- `npm run typecheck`\n- `npm test`');
    expect(text).not.toContain('npm run e2e');
  });

  it("carries earlier rounds' failures and skips passing rounds", () => {
    expect(text).toContain('# Earlier failed validation rounds of this milestone');
    expect(text).toContain('Failures of your kind (scrutiny): re-check each one on the validated commit');
    expect(text).toContain('## scrutiny round 1 by validator-ms1-scrutiny-r1 on abc1234: fail\n1. src/export.ts:42 drops the header row');
    expect(text).toContain('## commands round 1 by validator-ms1-commands-r1 on abc1234: fail');
    expect(text).not.toContain('user-testing round 1');
  });

  it('checks scrutiny concerns and reports through TowerValidate exactly once', () => {
    expect(text).toContain('# What to check — scrutiny (code review + tests)');
    expect(text).toContain('1. Intent: map every task of every merged feature to the code on the validated commit.');
    expect(text).toContain('3. Integration: the features were built in parallel and merged separately');
    expect(text).toContain('4. Typecheck, lint, and the full test suite pass');
    expect(text).not.toContain('user-testing (behavioural QA)');
    expect(text).toContain('# When done — TowerValidate exactly once');
    expect(text).toContain('Call TowerValidate once: { milestone: "MS1", kind: "scrutiny", verdict: "pass" | "fail", failures, checks, evidence }');
    expect(text).toContain('never send a manual TowerSend, never call TowerValidate a second time');
    expect(text).toContain('Report unrelated pre-existing issues with TowerFinding instead.');
  });

  it('keeps sections separated by single blank lines', () => {
    expect(text).not.toMatch(/\n{3,}/);
    expect(text.trim()).toBe(text);
  });
});

describe('buildValidatorBriefing — user-testing', () => {
  it('follows the QA instructions with the behavioural checklist', () => {
    const text = buildValidatorBriefing(input({ name: 'validator-ms1-user-testing-r1', validationKind: 'user-testing', round: 1 }));
    expect(text).toContain('assigned the user-testing validation of milestone MS1 (user-testing round 1)');
    expect(text).toContain('# What to check — user-testing (behavioural QA)');
    expect(text).toContain('## QA instructions\nRun `node bin/report.js export --format csv out.csv` and open out.csv.');
    expect(text).toContain('through real use, not by reading code');
    expect(text).toContain('kind: "user-testing"');
    expect(text).not.toContain('# What to check — scrutiny');
  });

  it('derives the flows itself when no QA instructions were given', () => {
    const base = input();
    const text = buildValidatorBriefing({
      ...base,
      validationKind: 'user-testing',
      milestone: { ...base.milestone, validation: { scrutiny: true, userTesting: true, commands: [] } },
    });
    expect(text).toContain('## QA instructions\nNone were given: derive the user flows from the goal');
  });
});

describe('buildValidatorBriefing — variants', () => {
  it('requires the whole definition of done and the acceptance commands on the final milestone', () => {
    const text = buildValidatorBriefing(input({ finalMilestone: true }));
    expect(text).toContain('This is the FINAL milestone: the whole definition of done must hold on the validated commit.');
    expect(text).toContain('Acceptance commands of the objective (final milestone):\n- `npm run e2e`');
    expect(text).toContain('the definition of done, or the acceptance commands, including regressions');
  });

  it('points at the milestone diff when a diff base is known', () => {
    const text = buildValidatorBriefing(input({ diffBase: 'base000' }));
    expect(text).toContain(`\`git diff base000..${COMMIT}\``);
    expect(text).not.toContain('--merges');
  });

  it('falls back to the project commands when none are configured', () => {
    const base = input();
    const text = buildValidatorBriefing({
      ...base,
      milestone: { ...base.milestone, validation: { scrutiny: true, userTesting: false, commands: [] }, rounds: [] },
      features: [],
    });
    expect(text).toContain("# Commands\nNo commands are configured for this milestone. Find the project's own typecheck");
    expect(text).toContain('No features are recorded for this milestone');
    expect(text).not.toContain('# Earlier failed validation rounds');
  });

  it('bounds the history to the latest failed rounds and truncates long failure lists', () => {
    const base = input();
    const rounds = Array.from({ length: VALIDATION_HISTORY_ROUNDS + 2 }, (_, index) =>
      failedRound('scrutiny', index + 1, [`failure ${String(index + 1)} ${'x'.repeat(VALIDATION_FAILURES_MAX_CHARS)}`]),
    );
    const text = buildValidatorBriefing({ ...base, milestone: { ...base.milestone, rounds } });
    expect(text).toContain('(2 earlier failed round(s) omitted — the full record lives in .tower/comms/validations/.)');
    expect(text).not.toContain('## scrutiny round 2 by');
    expect(text).toContain('## scrutiny round 3 by');
    expect(text).toContain('…(truncated)');
  });

  it('appends extra tower instructions', () => {
    const text = buildValidatorBriefing(input({ instructions: '  Use port 4100.  ' }));
    expect(text.endsWith('\n\n# Additional instructions from the tower\nUse port 4100.')).toBe(true);
  });
});

describe('buildSpawnBriefing — validator', () => {
  it('dispatches the validator kind', () => {
    expect(buildSpawnBriefing({ kind: 'validator', ...input() })).toBe(buildValidatorBriefing(input()));
  });
});
