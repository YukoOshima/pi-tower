import { describe, expect, it } from 'vitest';

import {
  VALIDATION_KINDS,
  describeValidation,
  formatDuration,
  formatUsd,
  latestRound,
  numberedList,
  requiredValidationKinds,
  shortCommit,
} from '../../src/prompts/objectiveFormat.ts';
import type { PromptValidationRound } from '../../src/prompts/objectiveTypes.ts';

const FULL = { scrutiny: true, userTesting: true, commands: ['npm test'] };

function round(kind: PromptValidationRound['kind'], number: number): PromptValidationRound {
  return { round: number, kind, validator: 'v', validatedCommit: 'c', verdict: 'pass', failures: [] };
}

describe('objective formatting helpers', () => {
  it('lists the validation kinds in contract order', () => {
    expect(VALIDATION_KINDS).toEqual(['scrutiny', 'user-testing', 'commands']);
  });

  it('formats durations at the most useful precision', () => {
    expect(formatDuration(-5)).toBe('0s');
    expect(formatDuration(45_900)).toBe('45s');
    expect(formatDuration(185_000)).toBe('3m 05s');
    expect(formatDuration(4_980_000)).toBe('1h 23m');
  });

  it('formats dollars and short commits', () => {
    expect(formatUsd(8.4)).toBe('$8.40');
    expect(formatUsd(0)).toBe('$0.00');
    expect(shortCommit('c0ffee1234567')).toBe('c0ffee1');
  });

  it('derives the required kinds from the spec and the acceptance commands', () => {
    expect(requiredValidationKinds(FULL)).toEqual(['scrutiny', 'user-testing', 'commands']);
    expect(requiredValidationKinds({ scrutiny: false, userTesting: true, commands: [] })).toEqual(['user-testing']);
    expect(requiredValidationKinds({ scrutiny: false, userTesting: false, commands: [] }, ['npm run e2e'])).toEqual([
      'commands',
    ]);
  });

  it('drops skipped kinds from the required kinds and the description', () => {
    expect(requiredValidationKinds(FULL, [], ['user-testing'])).toEqual(['scrutiny', 'commands']);
    expect(describeValidation(FULL, ['npm run e2e'], ['scrutiny', 'user-testing'])).toBe(
      'commands `npm test`, `npm run e2e`',
    );
    expect(describeValidation({ scrutiny: true, userTesting: true, commands: [] }, [], ['scrutiny', 'user-testing'])).toBe(
      'none (passes as soon as its features merge)',
    );
  });

  it('describes the validation in one line', () => {
    expect(describeValidation(FULL, ['npm run e2e'])).toBe(
      'scrutiny · user-testing · commands `npm test`, `npm run e2e`',
    );
    expect(describeValidation({ scrutiny: false, userTesting: false, commands: [] })).toBe(
      'none (passes as soon as its features merge)',
    );
  });

  it('finds the latest round of a kind', () => {
    const rounds = [round('scrutiny', 1), round('user-testing', 3), round('scrutiny', 2)];
    expect(latestRound(rounds, 'scrutiny')?.round).toBe(2);
    expect(latestRound(rounds, 'user-testing')?.round).toBe(3);
    expect(latestRound(rounds, 'commands')).toBeUndefined();
  });

  it('numbers list items', () => {
    expect(numberedList([' a ', 'b'])).toBe('1. a\n2. b');
    expect(numberedList([])).toBe('');
  });
});
