import { describe, expect, it } from 'vitest';

import {
  resolveObjectiveSettings,
  TOWER_OBJECTIVE_DEFAULTS,
  TOWER_OBJECTIVE_KEYS,
} from '../../src/config/index.ts';
import type { TowerConfig, TowerConfigSource } from '../../src/config/index.ts';

const GLOBAL: TowerConfigSource = { kind: 'file', scope: 'global', path: '/u/.pi/agent/tower.json' };
const PROJECT: TowerConfigSource = { kind: 'file', scope: 'project', path: '/repo/.pi/tower.json' };
const DEFAULT = { kind: 'default' } as const;

function config(objective?: TowerConfig['objective']): TowerConfig {
  return { roles: {}, models: {}, files: [], ...(objective === undefined ? {} : { objective }) };
}

describe('resolveObjectiveSettings', () => {
  it('applies the documented defaults when no file sets an objective key', () => {
    expect(resolveObjectiveSettings(config())).toStrictEqual({
      autopilot: { value: true, source: DEFAULT },
      autoApprove: { value: false, source: DEFAULT },
      maxValidationRounds: { value: 3, source: DEFAULT },
      maxFeatureAttempts: { value: 3, source: DEFAULT },
      watchdogIntervalMs: { value: 60_000, source: DEFAULT },
      stallTimeoutMs: { value: 180_000, source: DEFAULT },
      maxStallWakes: { value: 3, source: DEFAULT },
      maxWallTimeMs: { value: undefined, source: DEFAULT },
      maxCostUsd: { value: undefined, source: DEFAULT },
      skipScrutiny: { value: false, source: DEFAULT },
      skipUserTesting: { value: false, source: DEFAULT },
      autoTeardown: { value: false, source: DEFAULT },
    });
  });

  it('takes each key from the first section that sets it and keeps that section as its source', () => {
    const settings = resolveObjectiveSettings(
      config([
        { value: { autoApprove: true, maxWallTimeMs: 3_600_000 }, source: PROJECT },
        { value: { autoApprove: false, maxCostUsd: 7.5, autopilot: false }, source: GLOBAL },
      ]),
    );
    expect(settings.autoApprove).toStrictEqual({ value: true, source: PROJECT });
    expect(settings.maxWallTimeMs).toStrictEqual({ value: 3_600_000, source: PROJECT });
    expect(settings.maxCostUsd).toStrictEqual({ value: 7.5, source: GLOBAL });
    expect(settings.autopilot).toStrictEqual({ value: false, source: GLOBAL });
    expect(settings.stallTimeoutMs).toStrictEqual({ value: 180_000, source: DEFAULT });
  });

  it('keeps an explicit false or minimal value instead of the default', () => {
    const settings = resolveObjectiveSettings(
      config([{ value: { autopilot: false, maxStallWakes: 1 }, source: GLOBAL }]),
    );
    expect(settings.autopilot).toStrictEqual({ value: false, source: GLOBAL });
    expect(settings.maxStallWakes).toStrictEqual({ value: 1, source: GLOBAL });
  });

  it('lists every objective key once, in the documented order', () => {
    expect(TOWER_OBJECTIVE_KEYS).toEqual(Object.keys(TOWER_OBJECTIVE_DEFAULTS));
    expect(new Set(TOWER_OBJECTIVE_KEYS).size).toBe(12);
    expect(Object.keys(resolveObjectiveSettings(config()))).toEqual(TOWER_OBJECTIVE_KEYS);
  });
});
