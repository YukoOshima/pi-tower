import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  MessageEndEvent,
  SessionStartEvent,
  ToolDefinition,
  ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeSession, assistantMessage } from '../runtime/fakeSession.ts';

import { TOWER_OBJECTIVE_DEFAULTS } from '../../src/config/index.ts';
import { TOWER_VALIDATOR_ROLE, TOWER_WORKER_ROLE } from '../../src/prompts/index.ts';
import { TowerStore } from '../../src/protocol/index.ts';
import type { TowerAgentSessionRequest } from '../../src/runtime/index.ts';
import { createTowerSpawnTool } from '../../src/tools/spawn/spawnTool.ts';
import { ORCHESTRATOR_CALLER } from '../../src/tools/support.ts';
import { createTowerAgentRuntime } from '../../src/tower/agentRuntime.ts';
import {
  TOWER_AGENT_NOTIFICATION_MESSAGE,
  TOWER_MODE_ENTRY,
  TOWER_REVIEWER_BASE_TOOLS,
  TOWER_WORKER_BASE_TOOLS,
} from '../../src/tower/constants.ts';
import { TowerController, type TowerAutopilot } from '../../src/tower/controller.ts';
import type { TowerRuntime } from '../../src/tower/runtimeTypes.ts';
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

class FakeAutopilot implements TowerAutopilot {
  readonly calls: string[] = [];
  onTick: ((reason: string) => Promise<void>) | undefined;

  start(): void {
    this.calls.push('start');
  }

  stop(): void {
    this.calls.push('stop');
  }

  async tick(reason: string): Promise<void> {
    this.calls.push(`tick ${reason}`);
    await this.onTick?.(reason);
  }
}

interface Harness {
  readonly repo: string;
  readonly store: TowerStore;
  readonly ctx: FakeContext;
  readonly pi: FakePi;
  readonly runtime: FakeRuntime;
  readonly controller: TowerController;
  readonly autopilots: FakeAutopilot[];
  readonly warnings: string[];
}

interface HarnessOptions {
  readonly config?: unknown;
  readonly models?: boolean;
  readonly runtime?: boolean;
  readonly prepare?: (store: TowerStore) => Promise<void>;
  readonly entries?: FakeSessionManager['entries'];
  readonly createRuntime?: (controller: TowerController) => TowerRuntime;
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
  const store = new TowerStore(repo);
  await options.prepare?.(store);
  const session = new FakeSessionManager(SESSION_ID, options.entries ?? []);
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
  const autopilots: FakeAutopilot[] = [];
  const warnings: string[] = [];
  const controller = new TowerController({
    pi,
    ...(models === undefined ? {} : { models }),
    isProcessAlive: () => true,
    ...(options.runtime === false ? {} : { createRuntime: options.createRuntime ?? (() => runtime) }),
    createAutopilot: () => {
      const autopilot = new FakeAutopilot();
      autopilots.push(autopilot);
      return autopilot;
    },
    log: {
      info: () => undefined,
      warn: (message) => {
        warnings.push(message);
      },
    },
  });
  controllers.push(controller);
  await controller.onSessionStart(START, ctx.asContext);
  if (options.runtime !== false && options.createRuntime === undefined) expect(controller.runtime).toBe(runtime);
  return { repo, store, ctx, pi, runtime, controller, autopilots, warnings };
}

async function initialized(store: TowerStore): Promise<void> {
  await store.init(SESSION_ID, 'main');
}

async function planningObjective(store: TowerStore): Promise<void> {
  await initialized(store);
  await store.draftObjective({
    title: 'Ship',
    goal: 'ship it',
    definitionOfDone: ['works'],
    milestones: [{ title: 'Core' }],
  });
  await store.plan([{ title: 'Core feature', scope: ['src/core/**'], milestone: 'MS1' }]);
}

async function executingObjective(store: TowerStore): Promise<void> {
  await planningObjective(store);
  await store.requestObjectiveApproval();
  await store.approveObjective('human');
}

const ACTIVE_MODE_RECORD = {
  type: 'custom',
  id: 'mode-1',
  customType: TOWER_MODE_ENTRY,
  data: { active: true, sessionId: SESSION_ID, pid: process.pid },
};

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

describe('autopilot lifecycle', () => {
  function toolResult(toolName: string, isError = false): ToolResultEvent {
    return {
      type: 'tool_result',
      toolCallId: `call_${toolName}`,
      toolName,
      input: {},
      content: [],
      isError,
      details: undefined,
    } as ToolResultEvent;
  }

  it('starts with tower mode and stops when the mode ends or the session shuts down', async () => {
    const h = await harness();
    expect(h.autopilots).toEqual([]);

    await h.controller.enter();
    await h.controller.enter();
    await settle();
    expect(h.autopilots.map((autopilot) => autopilot.calls)).toEqual([['start']]);
    await h.controller.exit();
    expect(h.autopilots[0]?.calls).toEqual(['start', 'stop']);

    await h.controller.enter();
    await h.controller.onSessionShutdown();
    expect(h.autopilots.map((autopilot) => autopilot.calls)).toEqual([
      ['start', 'stop'],
      ['start', 'stop'],
    ]);
  });

  it('continues an executing objective with an immediate tick when tower mode is entered', async () => {
    const h = await harness({ prepare: executingObjective });

    await h.controller.enter();

    await vi.waitFor(() => expect(h.autopilots[0]?.calls).toEqual(['start', 'tick restart']));
  });

  it('restores the autopilot with the tower mode after a restart and continues the executing objective', async () => {
    const h = await harness({ prepare: executingObjective, entries: [ACTIVE_MODE_RECORD] });

    expect(h.controller.isActive).toBe(true);
    await vi.waitFor(() => expect(h.autopilots[0]?.calls).toEqual(['start', 'tick restart']));
  });

  it('only starts the runner when the objective is not executing', async () => {
    const h = await harness({ prepare: planningObjective, entries: [ACTIVE_MODE_RECORD] });
    await settle();

    expect(h.autopilots.map((autopilot) => autopilot.calls)).toEqual([['start']]);
  });

  it('ticks once an agent has ended and its death mark is written', async () => {
    const h = await harness({ prepare: initialized });
    await h.controller.enter();
    const launched = await h.controller.launchAgent({
      name: 'agent-build',
      kind: 'worker',
      description: 'build',
      cwd: h.repo,
      prompt: 'build it',
    });
    if (!launched.ok) throw new Error(launched.reason);
    await h.store.registerAgent({
      name: 'agent-build',
      agentId: launched.agentId,
      sessionId: SESSION_ID,
      kind: 'worker',
      spawnedAt: new Date().toISOString(),
    });
    const autopilot = h.autopilots[0];
    if (autopilot === undefined) throw new Error('the autopilot did not start');
    const seen: (string | undefined)[] = [];
    autopilot.onTick = async () => {
      const entry = (await h.store.load()).roster.agents.find((agent) => agent.agentId === launched.agentId);
      seen.push(entry?.deathStatus);
    };

    h.runtime.finish(launched.agentId, 'failed', { stopReason: 'provider error' });

    await vi.waitFor(() => expect(autopilot.calls).toContain('tick agent-end'));
    expect(seen).toEqual(['failed']);
  });

  it('ticks on inbox events addressed to the tower by agents, not on its own or direct messages', async () => {
    const h = await harness({ prepare: initialized });
    await h.controller.enter();
    await settle();

    h.controller.publishInboxSent({ from: 'tower', to: 'all', subject: 'self broadcast' });
    h.controller.publishInboxSent({ from: 'w1', to: 'w2', subject: 'direct' });
    h.controller.publishInboxSent({ from: 'w1', to: 'tower', subject: 'review-request', missionId: 'M1' });
    await settle();

    expect(h.autopilots[0]?.calls).toEqual(['start', 'tick inbox']);
  });

  it('ticks after successful store-changing tool results only', async () => {
    const h = await harness({ prepare: initialized });
    await h.controller.enter();
    await settle();

    h.controller.onToolResult(toolResult('TowerStatus'));
    h.controller.onToolResult(toolResult('TowerInbox'));
    h.controller.onToolResult(toolResult('read'));
    h.controller.onToolResult(toolResult('TowerPlan', true));
    h.controller.onToolResult(toolResult('TowerPlan'));
    h.controller.onToolResult(toolResult('TowerObjective'));
    await settle();

    expect(h.autopilots[0]?.calls).toEqual(['start', 'tick tool TowerPlan', 'tick tool TowerObjective']);
  });

  it('serves the command hook tick only while tower mode is on and logs a failing tick', async () => {
    const h = await harness({ prepare: initialized });
    await h.controller.autopilotTick('approve');
    expect(h.autopilots).toEqual([]);

    await h.controller.enter();
    const autopilot = h.autopilots[0];
    if (autopilot === undefined) throw new Error('the autopilot did not start');
    autopilot.onTick = () => Promise.reject(new Error('store locked'));

    await expect(h.controller.autopilotTick('approve')).resolves.toBeUndefined();
    expect(autopilot.calls).toEqual(['start', 'tick approve']);
    expect(h.warnings).toContain('tower: autopilot tick failed');

    await h.controller.exit();
    await h.controller.autopilotTick('resume');
    expect(autopilot.calls).toEqual(['start', 'tick approve', 'stop']);
  });
});

describe('tower agents on the real runtime', () => {
  interface AgentHarness extends Harness {
    readonly requests: TowerAgentSessionRequest[];
    readonly sessions: FakeSession[];
  }

  async function agentHarness(): Promise<AgentHarness> {
    const requests: TowerAgentSessionRequest[] = [];
    const sessions: FakeSession[] = [];
    const h = await harness({
      prepare: async (store) => {
        await initialized(store);
        await store.plan([{ title: 'Build gemm', scope: ['src/gemm/**'] }]);
      },
      createRuntime: (controller) =>
        createTowerAgentRuntime(controller, {
          maxRunningAgents: () => undefined,
          createSessionFactory: () => async (request) => {
            requests.push(request);
            const session = new FakeSession(`pi-${request.agentId}`);
            sessions.push(session);
            return session;
          },
          stopGraceMs: 50,
        }),
    });
    await h.controller.enter();
    return { ...h, requests, sessions };
  }

  function agentTool(h: AgentHarness, index: number, name: string): ToolDefinition {
    const tool = h.requests[index]?.spec.customTools?.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`${name} is not among the agent tools`);
    return tool;
  }

  it('ticks when an agent changes the store through its own tower tools, not when it only reads', async () => {
    const h = await agentHarness();
    const spawn = createTowerSpawnTool(h.controller, ORCHESTRATOR_CALLER);
    const spawned = await spawn.run({ name: 'agent-build', kind: 'worker', mission_id: 'M1' }, { toolCallId: 'call_spawn' });
    expect(spawned.isError).toBeUndefined();
    await settle();
    const autopilot = h.autopilots[0];
    if (autopilot === undefined) throw new Error('the autopilot did not start');
    const context = h.ctx as unknown as Parameters<ToolDefinition['execute']>[4];

    await agentTool(h, 0, 'TowerStatus').execute('call_status', {}, undefined, undefined, context);
    expect(autopilot.calls).toEqual(['start']);
    const sent = await agentTool(h, 0, 'TowerSend').execute(
      'call_send',
      { to: 'tower', subject: 'question', body: 'which scope?' },
      undefined,
      undefined,
      context,
    );

    expect(sent.isError).not.toBe(true);
    expect(autopilot.calls).toEqual(['start', 'tick inbox', 'tick tool TowerSend']);
  });
});
