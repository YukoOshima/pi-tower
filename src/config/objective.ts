import type {
  TowerConfig,
  TowerObjectiveSetting,
  TowerObjectiveSettingKey,
  TowerObjectiveSettingValues,
  TowerObjectiveSettings,
} from './types.ts';

export const TOWER_OBJECTIVE_KEYS: readonly TowerObjectiveSettingKey[] = [
  'autopilot',
  'autoApprove',
  'maxValidationRounds',
  'maxFeatureAttempts',
  'watchdogIntervalMs',
  'stallTimeoutMs',
  'maxStallWakes',
  'maxWallTimeMs',
  'maxCostUsd',
  'skipScrutiny',
  'skipUserTesting',
  'autoTeardown',
];

export const TOWER_OBJECTIVE_DEFAULTS: TowerObjectiveSettingValues = {
  autopilot: true,
  autoApprove: false,
  maxValidationRounds: 3,
  maxFeatureAttempts: 3,
  watchdogIntervalMs: 60_000,
  stallTimeoutMs: 180_000,
  maxStallWakes: 3,
  maxWallTimeMs: undefined,
  maxCostUsd: undefined,
  skipScrutiny: false,
  skipUserTesting: false,
  autoTeardown: false,
};

export function resolveObjectiveSettings(config: TowerConfig): TowerObjectiveSettings {
  const sections = config.objective ?? [];
  const setting = <K extends TowerObjectiveSettingKey>(
    key: K,
  ): TowerObjectiveSetting<TowerObjectiveSettingValues[K]> => {
    for (const section of sections) {
      const value = section.value[key];
      if (value !== undefined) return { value, source: section.source };
    }
    return { value: TOWER_OBJECTIVE_DEFAULTS[key], source: { kind: 'default' } };
  };
  return {
    autopilot: setting('autopilot'),
    autoApprove: setting('autoApprove'),
    maxValidationRounds: setting('maxValidationRounds'),
    maxFeatureAttempts: setting('maxFeatureAttempts'),
    watchdogIntervalMs: setting('watchdogIntervalMs'),
    stallTimeoutMs: setting('stallTimeoutMs'),
    maxStallWakes: setting('maxStallWakes'),
    maxWallTimeMs: setting('maxWallTimeMs'),
    maxCostUsd: setting('maxCostUsd'),
    skipScrutiny: setting('skipScrutiny'),
    skipUserTesting: setting('skipUserTesting'),
    autoTeardown: setting('autoTeardown'),
  };
}
