import { describe, expect, it } from 'vitest';

import { TOWER_OBJECTIVE_DEFAULTS } from '../../src/config/index.ts';
import {
  DEFAULT_OBJECTIVE_SETTINGS_VIEW,
  objectiveSettingsOf,
  skippedValidationKinds,
  validationSettingsOf,
  type TowerObjectiveSettingsView,
} from '../../src/tools/support.ts';

const CONFIGURED: TowerObjectiveSettingsView = {
  autopilot: false,
  autoApprove: true,
  maxValidationRounds: 5,
  maxFeatureAttempts: 2,
  skipScrutiny: true,
  skipUserTesting: false,
  maxWallTimeMs: 3_600_000,
  maxCostUsd: 12.5,
};

describe('objective settings seam', () => {
  it('falls back to the config defaults when the host does not provide objectiveSettings', () => {
    expect(objectiveSettingsOf({})).toBe(DEFAULT_OBJECTIVE_SETTINGS_VIEW);
    expect(DEFAULT_OBJECTIVE_SETTINGS_VIEW).toEqual({
      autopilot: TOWER_OBJECTIVE_DEFAULTS.autopilot,
      autoApprove: TOWER_OBJECTIVE_DEFAULTS.autoApprove,
      maxValidationRounds: TOWER_OBJECTIVE_DEFAULTS.maxValidationRounds,
      maxFeatureAttempts: TOWER_OBJECTIVE_DEFAULTS.maxFeatureAttempts,
      skipScrutiny: TOWER_OBJECTIVE_DEFAULTS.skipScrutiny,
      skipUserTesting: TOWER_OBJECTIVE_DEFAULTS.skipUserTesting,
    });
    expect('maxWallTimeMs' in DEFAULT_OBJECTIVE_SETTINGS_VIEW).toBe(false);
    expect('maxCostUsd' in DEFAULT_OBJECTIVE_SETTINGS_VIEW).toBe(false);
  });

  it('reads the configured values from the host on every call', () => {
    let reads = 0;
    const host = {
      objectiveSettings: (): TowerObjectiveSettingsView => {
        reads += 1;
        return CONFIGURED;
      },
    };

    expect(objectiveSettingsOf(host)).toBe(CONFIGURED);
    expect(objectiveSettingsOf(host)).toBe(CONFIGURED);
    expect(reads).toBe(2);
  });

  it('derives the store validation settings and the skipped prompt kinds', () => {
    expect(validationSettingsOf(CONFIGURED)).toEqual({ skipScrutiny: true, skipUserTesting: false });
    expect(skippedValidationKinds(CONFIGURED)).toEqual(['scrutiny']);
    expect(skippedValidationKinds({ ...CONFIGURED, skipScrutiny: false, skipUserTesting: true })).toEqual([
      'user-testing',
    ]);
    expect(skippedValidationKinds(DEFAULT_OBJECTIVE_SETTINGS_VIEW)).toEqual([]);
  });
});
