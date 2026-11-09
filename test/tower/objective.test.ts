import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionStartEvent } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';

import { TOWER_OBJECTIVE_DEFAULTS } from '../../src/config/index.ts';
import { TowerController } from '../../src/tower/controller.ts';
import { TowerModels } from '../../src/tower/models.ts';
import { objectiveSettingValues, objectiveSettingsView } from '../../src/tower/objectiveSettings.ts';
import { FakeContext, FakePi, FakeRuntime, FakeSessionManager, createRepo, removeDir } from './fakes.ts';

const SESSION_ID = 'session-objective';
const START: SessionStartEvent = { type: 'session_start', reason: 'startup' };

interface Harness {
  readonly repo: string;
  readonly ctx: FakeContext;
  readonly pi: FakePi;
  readonly runtime: FakeRuntime;
  readonly controller: TowerController;
}

interface HarnessOptions {
  readonly config?: unknown;
  readonly models?: boolean;
}

const cleanups: string[] = [];
const controllers: TowerController[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.onSessionShutdown();
  for (const dir of cleanups.splice(0)) await removeDir(dir);
});

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const repo = await createRepo('tower-objective-');
  const agentDir = await mkdtemp(join(tmpdir(), 'tower-objective-agent-'));
  cleanups.push(repo, agentDir);
  if (options.config !== undefined) {
    const config = options.config;
    await writeFile(join(agentDir, 'tower.json'), typeof config === 'string' ? config : `${JSON.stringify(config)}\n`);
  }
  const session = new FakeSessionManager(SESSION_ID);
  const ctx = new FakeContext(repo, session);
  ctx.model = ctx.modelRegistry.add('prov', 'session-model');
  const pi = new FakePi();
  pi.session = session;
  pi.context = ctx;
  const runtime = new FakeRuntime();
  const models =
    options.models === false
      ? undefined
      : new TowerModels({ agentDir, configDirName: '.pi', env: {}, getFlag: () => undefined });
  const controller = new TowerController({
    pi,
    ...(models === undefined ? {} : { models }),
    isProcessAlive: () => true,
    createRuntime: () => runtime,
  });
  controllers.push(controller);
  await controller.onSessionStart(START, ctx.asContext);
  return { repo, ctx, pi, runtime, controller };
}

describe('objective settings', () => {
  it('maps the resolved config values and omits unset budgets', () => {
    expect(objectiveSettingValues(undefined)).toBe(TOWER_OBJECTIVE_DEFAULTS);
    expect(objectiveSettingsView(TOWER_OBJECTIVE_DEFAULTS)).toEqual({
      autopilot: true,
      autoApprove: false,
      maxValidationRounds: 3,
      maxFeatureAttempts: 3,
      skipScrutiny: false,
      skipUserTesting: false,
    });
    expect(
      objectiveSettingsView({ ...TOWER_OBJECTIVE_DEFAULTS, maxWallTimeMs: 60_000, maxCostUsd: 2.5 }),
    ).toMatchObject({ maxWallTimeMs: 60_000, maxCostUsd: 2.5 });
  });

  it('serves the configured objective section to the tools, the commands and the autopilot', async () => {
    const h = await harness({
      config: {
        maxRunningAgents: 3,
        objective: {
          autopilot: false,
          autoApprove: true,
          maxValidationRounds: 2,
          maxFeatureAttempts: 4,
          skipScrutiny: true,
          maxCostUsd: 12.5,
          watchdogIntervalMs: 5_000,
          stallTimeoutMs: 20_000,
          maxStallWakes: 1,
        },
      },
    });

    expect(h.controller.objectiveSettings()).toEqual({
      autopilot: false,
      autoApprove: true,
      maxValidationRounds: 2,
      maxFeatureAttempts: 4,
      skipScrutiny: true,
      skipUserTesting: false,
      maxCostUsd: 12.5,
    });
    h.runtime.snapshotValue = { budget: 3, inflight: 0, blockedUntil: null };
    expect(h.controller.autopilotSettings()).toEqual({
      ...h.controller.objectiveSettings(),
      maxRunningAgents: 3,
      watchdogIntervalMs: 5_000,
      stallTimeoutMs: 20_000,
      maxStallWakes: 1,
    });
  });

  it('feeds the autopilot the live concurrency budget', async () => {
    const h = await harness({ config: {} });

    h.runtime.snapshotValue = { budget: 1, inflight: 1, blockedUntil: null };

    expect(h.controller.autopilotSettings().maxRunningAgents).toBe(1);
  });

  it('falls back to the defaults when the tower config fails to load', async () => {
    const h = await harness({ config: '{ not json' });

    expect(h.ctx.ui.notices.some((notice) => notice.level === 'warning')).toBe(true);
    expect(h.controller.objectiveSettings()).toEqual(objectiveSettingsView(TOWER_OBJECTIVE_DEFAULTS));
    expect(h.controller.autopilotSettings()).toMatchObject({
      watchdogIntervalMs: TOWER_OBJECTIVE_DEFAULTS.watchdogIntervalMs,
      stallTimeoutMs: TOWER_OBJECTIVE_DEFAULTS.stallTimeoutMs,
      maxStallWakes: TOWER_OBJECTIVE_DEFAULTS.maxStallWakes,
    });
  });

  it('uses the defaults without a model configuration', async () => {
    const h = await harness({ models: false });

    expect(h.controller.objectiveSettings()).toEqual(objectiveSettingsView(TOWER_OBJECTIVE_DEFAULTS));
  });
});
