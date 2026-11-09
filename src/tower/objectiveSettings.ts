import {
  TOWER_OBJECTIVE_DEFAULTS,
  type TowerObjectiveSettingValues,
  type TowerObjectiveSettings,
} from '../config/index.ts';

export interface TowerObjectiveSettingsView {
  readonly autopilot: boolean;
  readonly autoApprove: boolean;
  readonly maxValidationRounds: number;
  readonly maxFeatureAttempts: number;
  readonly skipScrutiny: boolean;
  readonly skipUserTesting: boolean;
  readonly maxWallTimeMs?: number;
  readonly maxCostUsd?: number;
}

export interface TowerAutopilotSettings extends TowerObjectiveSettingsView {
  readonly maxRunningAgents: number;
  readonly watchdogIntervalMs: number;
  readonly stallTimeoutMs: number;
  readonly maxStallWakes: number;
}

export function objectiveSettingValues(
  settings: TowerObjectiveSettings | undefined,
): TowerObjectiveSettingValues {
  if (settings === undefined) return TOWER_OBJECTIVE_DEFAULTS;
  return {
    autopilot: settings.autopilot.value,
    autoApprove: settings.autoApprove.value,
    maxValidationRounds: settings.maxValidationRounds.value,
    maxFeatureAttempts: settings.maxFeatureAttempts.value,
    watchdogIntervalMs: settings.watchdogIntervalMs.value,
    stallTimeoutMs: settings.stallTimeoutMs.value,
    maxStallWakes: settings.maxStallWakes.value,
    maxWallTimeMs: settings.maxWallTimeMs.value,
    maxCostUsd: settings.maxCostUsd.value,
    skipScrutiny: settings.skipScrutiny.value,
    skipUserTesting: settings.skipUserTesting.value,
    autoTeardown: settings.autoTeardown.value,
  };
}

export function objectiveSettingsView(values: TowerObjectiveSettingValues): TowerObjectiveSettingsView {
  return {
    autopilot: values.autopilot,
    autoApprove: values.autoApprove,
    maxValidationRounds: values.maxValidationRounds,
    maxFeatureAttempts: values.maxFeatureAttempts,
    skipScrutiny: values.skipScrutiny,
    skipUserTesting: values.skipUserTesting,
    ...(values.maxWallTimeMs === undefined ? {} : { maxWallTimeMs: values.maxWallTimeMs }),
    ...(values.maxCostUsd === undefined ? {} : { maxCostUsd: values.maxCostUsd }),
  };
}

export function autopilotSettings(
  values: TowerObjectiveSettingValues,
  maxRunningAgents: number,
): TowerAutopilotSettings {
  return {
    ...objectiveSettingsView(values),
    maxRunningAgents,
    watchdogIntervalMs: values.watchdogIntervalMs,
    stallTimeoutMs: values.stallTimeoutMs,
    maxStallWakes: values.maxStallWakes,
  };
}
