import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MessageEndEvent, SessionStartEvent } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';

import { assistantMessage } from '../runtime/fakeSession.ts';

import { TOWER_OBJECTIVE_DEFAULTS } from '../../src/config/index.ts';
import { TOWER_VALIDATOR_ROLE, TOWER_WORKER_ROLE } from '../../src/prompts/index.ts';
import {
  TOWER_AGENT_NOTIFICATION_MESSAGE,
  TOWER_REVIEWER_BASE_TOOLS,
  TOWER_WORKER_BASE_TOOLS,
} from '../../src/tower/constants.ts';
import { TowerController } from '../../src/tower/controller.ts';
import { TowerModels } from '../../src/tower/models.ts';
import { objectiveSettingValues, objectiveSettingsView } from '../../src/tower/objectiveSettings.ts';
import {
  FakeContext,
  FakePi,
  FakeRuntime,
  FakeSessionManager,
  createRepo,
  removeDir,
  sentText,
  settle,
} from './fakes.ts';

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
  readonly runtime?: boolean;
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
    ...(options.runtime === false ? {} : { createRuntime: () => runtime }),
  });
  controllers.push(controller);
  await controller.onSessionStart(START, ctx.asContext);
  if (options.runtime !== false) expect(controller.runtime).toBe(runtime);
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

describe('cost accounting', () => {
  function messageEnd(message: MessageEndEvent['message']): MessageEndEvent {
    return { type: 'message_end', message };
  }

  it('sums the agent runtime usage and the orchestrator turns taken while tower mode is on', async () => {
    const h = await harness();
    h.controller.onMessageEnd(messageEnd(assistantMessage('before tower mode', { cost: { total: 0.5 } })));
    await h.controller.enter();

    h.runtime.usageTotal = { ...h.runtime.usageTotal, totalTokens: 100, cost: 1.25 };
    h.controller.onMessageEnd(messageEnd(assistantMessage('planning', { cost: { total: 0.25 } })));
    h.controller.onMessageEnd(messageEnd({ role: 'user', content: 'go on', timestamp: 0 }));

    expect(h.controller.totalCostUsd()).toBe(1.5);
    await h.controller.exit();
    h.controller.onMessageEnd(messageEnd(assistantMessage('after tower mode', { cost: { total: 2 } })));
    expect(h.controller.totalCostUsd()).toBe(1.5);
  });

  it('counts no agent usage before an agent runtime exists', async () => {
    const h = await harness({ runtime: false });
    await h.controller.enter();

    h.controller.onMessageEnd(messageEnd(assistantMessage('planning', { cost: { total: 0.25 } })));

    expect(h.controller.totalCostUsd()).toBe(0.25);
  });
});

describe('validator agents', () => {
  async function launchValidator(h: Harness): Promise<string> {
    const launched = await h.controller.launchAgent({
      name: 'ap-v-MS1-scrutiny-1',
      kind: 'validator',
      description: 'validate MS1 (scrutiny)',
      cwd: h.repo,
      prompt: 'validate MS1',
    });
    if (!launched.ok) throw new Error(launched.reason);
    return launched.agentId;
  }

  it('launches with the validator role and the read-only reviewer tools', async () => {
    const h = await harness();

    await launchValidator(h);

    expect(h.runtime.specs).toEqual([
      expect.objectContaining({
        kind: 'validator',
        appendSystemPrompt: TOWER_VALIDATOR_ROLE,
        tools: TOWER_REVIEWER_BASE_TOOLS,
      }),
    ]);
    expect(TOWER_REVIEWER_BASE_TOOLS).not.toContain('write');
    expect(TOWER_REVIEWER_BASE_TOOLS).not.toContain('edit');
  });

  it('keeps the worker role and tools for workers and the reviewer tools for reviewers', async () => {
    const h = await harness();

    await h.controller.launchAgent({ name: 'w', kind: 'worker', description: 'w', cwd: h.repo, prompt: 'go' });
    await h.controller.launchAgent({ name: 'r', kind: 'reviewer', description: 'r', cwd: h.repo, prompt: 'go' });

    expect(h.runtime.specs.map((spec) => [spec.appendSystemPrompt, spec.tools])).toEqual([
      [TOWER_WORKER_ROLE, TOWER_WORKER_BASE_TOOLS],
      [TOWER_WORKER_ROLE, TOWER_REVIEWER_BASE_TOOLS],
    ]);
  });

  it('announces a finished validator as a validator and retires it with its output retained', async () => {
    const h = await harness();
    await h.controller.enter();
    const agentId = await launchValidator(h);

    h.runtime.finish(agentId, 'idle', { summary: 'Submitted pass for MS1 scrutiny.' });
    await settle();

    const notification = h.pi.sentOfType(TOWER_AGENT_NOTIFICATION_MESSAGE).at(-1);
    expect(sentText(notification)).toContain('Title: Background validator completed');
    expect(h.runtime.disposed).toEqual([agentId]);
    expect(h.controller.agentOutput(agentId)).toMatchObject({
      kind: 'validator',
      lastAssistantText: 'Submitted pass for MS1 scrutiny.',
    });
  });
});
