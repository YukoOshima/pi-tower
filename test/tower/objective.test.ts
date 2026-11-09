import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  MessageEndEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolDefinition,
  ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeSession, assistantMessage } from '../runtime/fakeSession.ts';

import { TOWER_OBJECTIVE_DEFAULTS } from '../../src/config/index.ts';
import { VALIDATOR_WRITE_VETO } from '../../src/guards/index.ts';
import {
  TOWER_MODE_FULL_REMINDER,
  TOWER_OBJECTIVE_HEADLESS_PLAYBOOK,
  TOWER_VALIDATOR_ROLE,
  TOWER_WORKER_ROLE,
} from '../../src/prompts/index.ts';
import {
  ACTIVITY_LOG,
  STATE_FILE,
  TowerStore,
  WORKTREES_DIR,
  type TowerRosterEntry,
  type TowerState,
  type TowerValidationWorktree,
} from '../../src/protocol/index.ts';
import type { TowerAgentSessionRequest } from '../../src/runtime/index.ts';
import { createTowerSpawnTool } from '../../src/tools/spawn/spawnTool.ts';
import { ORCHESTRATOR_CALLER } from '../../src/tools/support.ts';
import { createTowerAgentRuntime } from '../../src/tower/agentRuntime.ts';
import { AutopilotRunner } from '../../src/tower/autopilot/index.ts';
import { towerAutopilotEffects, towerAutopilotObservations } from '../../src/tower/autopilotHost.ts';
import { commandUi, handleTowerCommand, type TowerCommandDeps } from '../../src/tower/command.ts';
import {
  TOWER_AGENT_NOTIFICATION_MESSAGE,
  TOWER_AUTOPILOT_WAKE_MESSAGE,
  TOWER_INBOX_WAKE_MESSAGE,
  TOWER_MODE_ENTRY,
  TOWER_REVIEWER_BASE_TOOLS,
  TOWER_VALIDATOR_AGENT_TOOLS,
  TOWER_WORKER_BASE_TOOLS,
} from '../../src/tower/constants.ts';
import { TOWER_AGENT_GUARDS_EXTENSION } from '../../src/tower/guards.ts';
import { TowerController, type TowerAutopilot } from '../../src/tower/controller.ts';
import type { TowerRuntime } from '../../src/tower/runtimeTypes.ts';
import { TowerModels } from '../../src/tower/models.ts';
import { objectiveSettingValues, objectiveSettingsView } from '../../src/tower/objectiveSettings.ts';
import {
  FakeContext,
  FakePi,
  FakeRuntime,
  FakeSessionManager,
  commitFile,
  createRepo,
  git,
  removeDir,
  sentText,
  settle,
} from './fakes.ts';

const SESSION_ID = 'session-objective';
const WAIT = { timeout: 10_000 };
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

  async whenIdle(): Promise<void> {
    this.calls.push('idle');
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
  readonly createAutopilot?: (controller: TowerController) => TowerAutopilot;
  readonly alive?: (pid: number) => boolean;
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
    isProcessAlive: options.alive ?? (() => true),
    ...(options.runtime === false ? {} : { createRuntime: options.createRuntime ?? (() => runtime) }),
    createAutopilot:
      options.createAutopilot ??
      (() => {
        const autopilot = new FakeAutopilot();
        autopilots.push(autopilot);
        return autopilot;
      }),
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

async function mutateState(store: TowerStore, mutate: (state: TowerState) => void): Promise<void> {
  const file = store.abs(STATE_FILE);
  const state = JSON.parse(await readFile(file, 'utf8')) as TowerState;
  mutate(state);
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
}

async function validatingObjective(store: TowerStore): Promise<void> {
  await executingObjective(store);
  await mutateState(store, (state) => {
    for (const feature of state.missions) feature.status = 'merged';
  });
  await store.startMilestoneValidation('MS1', await git(store.repoRoot, 'rev-parse', 'main'));
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
          autoTeardown: false,
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
      autoTeardown: false,
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
      autoTeardown: true,
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

  it('starts one runner with tower mode, stops it and waits for it to settle when the mode ends or the session shuts down', async () => {
    const h = await harness();
    expect(h.autopilots).toEqual([]);

    await h.controller.enter();
    await h.controller.enter();
    await settle();
    expect(h.autopilots.map((autopilot) => autopilot.calls)).toEqual([['start']]);
    await h.controller.exit();
    await h.controller.exit();
    expect(h.autopilots[0]?.calls).toEqual(['start', 'stop', 'idle']);

    await h.controller.enter();
    await h.controller.onSessionShutdown();
    expect(h.autopilots.map((autopilot) => autopilot.calls)).toEqual([['start', 'stop', 'idle', 'start', 'stop', 'idle']]);
  });

  it('continues an executing objective with an immediate tick when tower mode is entered', async () => {
    const h = await harness({ prepare: executingObjective });

    await h.controller.enter();

    await vi.waitFor(() => expect(h.autopilots[0]?.calls).toEqual(['start', 'tick restart']), WAIT);
  });

  it('restores the autopilot with the tower mode after a restart and continues the executing objective', async () => {
    const h = await harness({ prepare: executingObjective, entries: [ACTIVE_MODE_RECORD] });

    expect(h.controller.isActive).toBe(true);
    await vi.waitFor(() => expect(h.autopilots[0]?.calls).toEqual(['start', 'tick restart']), WAIT);
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

    await vi.waitFor(() => expect(autopilot.calls).toContain('tick agent-end'), WAIT);
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
    expect(autopilot.calls).toEqual(['start', 'tick approve', 'stop', 'idle']);
  });
});

describe('tower agents on the real runtime', () => {
  interface AgentHarness extends Harness {
    readonly requests: TowerAgentSessionRequest[];
    readonly sessions: FakeSession[];
  }

  async function plannedMission(store: TowerStore): Promise<void> {
    await initialized(store);
    await store.plan([{ title: 'Build gemm', scope: ['src/gemm/**'] }]);
  }

  async function agentHarness(prepare: (store: TowerStore) => Promise<void> = plannedMission): Promise<AgentHarness> {
    const requests: TowerAgentSessionRequest[] = [];
    const sessions: FakeSession[] = [];
    const h = await harness({
      prepare,
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

  async function toolCallGuard(request: TowerAgentSessionRequest) {
    const extension = request.spec.extensionFactories?.find(
      (candidate) => typeof candidate !== 'function' && candidate.name === TOWER_AGENT_GUARDS_EXTENSION,
    );
    if (extension === undefined || typeof extension === 'function') throw new Error('no tower guard extension');
    let handler: ((event: ToolCallEvent, ctx: { readonly cwd: string }) => Promise<unknown>) | undefined;
    await extension.factory({
      on: (_event: string, registered: typeof handler) => {
        handler = registered;
      },
    } as unknown as ExtensionAPI);
    if (handler === undefined) throw new Error('no tool_call handler');
    return handler;
  }

  it('runs a spawned validator read-only in its validation worktree and removes the worktree after its verdict', async () => {
    const h = await agentHarness(validatingObjective);
    const spawned = await createTowerSpawnTool(h.controller, ORCHESTRATOR_CALLER).run(
      { name: 'ap-v-MS1-scrutiny-1', kind: 'validator', milestone: 'MS1', validation_kind: 'scrutiny' },
      { toolCallId: 'call_spawn' },
    );
    expect(spawned.isError, spawned.output).toBeUndefined();
    const [request] = h.requests;
    if (request === undefined) throw new Error('no validator session');
    const entry = (await h.store.load()).roster.agents.find((agent) => agent.name === 'ap-v-MS1-scrutiny-1');
    const worktree = h.store.abs(join(WORKTREES_DIR, entry?.worktree ?? ''));
    expect(entry).toMatchObject({ kind: 'validator', milestoneId: 'MS1', validationKind: 'scrutiny', cwd: worktree });
    expect(request.spec).toMatchObject({
      kind: 'validator',
      cwd: worktree,
      appendSystemPrompt: TOWER_VALIDATOR_ROLE,
      tools: TOWER_REVIEWER_BASE_TOOLS,
    });
    expect((request.spec.customTools ?? []).map((tool) => tool.name).sort()).toEqual([...TOWER_VALIDATOR_AGENT_TOOLS].sort());
    const guard = await toolCallGuard(request);
    const write = { type: 'tool_call', toolCallId: 'call_write', toolName: 'write', input: { path: 'src/a.ts', content: 'x' } };
    expect(await guard(write as ToolCallEvent, { cwd: worktree })).toEqual({ block: true, reason: VALIDATOR_WRITE_VETO });

    const context = h.ctx as unknown as Parameters<ToolDefinition['execute']>[4];
    const validated = await agentTool(h, 0, 'TowerValidate').execute(
      'call_validate',
      { milestone: 'MS1', kind: 'scrutiny', verdict: 'pass', failures: [], checks: ['npm test'], evidence: 'all green' },
      undefined,
      undefined,
      context,
    );
    expect(validated.isError).not.toBe(true);
    const milestone = (await h.store.load()).objective?.milestones.find((candidate) => candidate.id === 'MS1');
    expect(milestone?.rounds).toContainEqual(
      expect.objectContaining({ kind: 'scrutiny', verdict: 'pass', validator: 'ap-v-MS1-scrutiny-1' }),
    );
    expect(h.autopilots[0]?.calls).toContain('tick tool TowerValidate');
    expect(existsSync(worktree)).toBe(true);

    h.sessions[0]?.reply('Submitted pass for MS1 scrutiny.');
    h.sessions[0]?.settle();

    await vi.waitFor(() => expect(existsSync(worktree)).toBe(false), WAIT);
    expect(h.controller.agentOutput(entry?.agentId ?? '')).toMatchObject({
      kind: 'validator',
      lastAssistantText: 'Submitted pass for MS1 scrutiny.',
    });
  });
});

describe('autopilot observations', () => {
  async function launch(h: Harness, name: string, kind: 'worker' | 'reviewer' | 'validator' = 'worker'): Promise<string> {
    const launched = await h.controller.launchAgent({ name, kind, description: name, cwd: h.repo, prompt: 'go' });
    if (!launched.ok) throw new Error(launched.reason);
    return launched.agentId;
  }

  it('maps live runtime agents, keeping a winding-down agent running and passing the stop reason', async () => {
    const h = await harness();
    const running = await launch(h, 'w-running');
    const idle = await launch(h, 'w-idle');
    const failed = await launch(h, 'w-failed');
    const timedOut = await launch(h, 'w-timeout');
    const stopping = await launch(h, 'w-stopping');

    h.runtime.finish(idle, 'idle');
    h.runtime.finish(failed, 'failed', { stopReason: 'provider error' });
    h.runtime.finish(timedOut, 'timed_out', { stopReason: 'timed out after 2h' });
    h.runtime.finish(stopping, 'stopped', { stopReason: 'user', windingDown: true });

    expect(h.controller.autopilotAgent(running)).toEqual({ status: 'running' });
    expect(h.controller.autopilotAgent(idle)).toEqual({ status: 'idle' });
    expect(h.controller.autopilotAgent(failed)).toEqual({ status: 'failed', stopReason: 'provider error' });
    expect(h.controller.autopilotAgent(timedOut)).toEqual({ status: 'timeout', stopReason: 'timed out after 2h' });
    expect(h.controller.autopilotAgent(stopping)).toEqual({ status: 'running', stopReason: 'user' });
  });

  it('reports a disposed validator by its retained outcome and an agent this process never ran as gone', async () => {
    const h = await harness();
    await h.controller.enter();
    const validator = await launch(h, 'ap-v-MS1-scrutiny-1', 'validator');

    h.runtime.finish(validator, 'idle', { summary: 'pass' });
    await settle();

    expect(h.runtime.disposed).toEqual([validator]);
    expect(h.controller.autopilotAgent(validator)).toEqual({ status: 'completed', lastAssistantText: 'pass' });
    expect(h.controller.autopilotAgent('agent-from-a-previous-session')).toBeUndefined();
  });

  it("passes the agent's last assistant text so the autopilot can quote what the agent said last", async () => {
    const h = await harness();
    const worker = await launch(h, 'w-quiet');
    const silent = await launch(h, 'w-silent');

    h.runtime.finish(worker, 'idle', { summary: 'The migration needs a database URL — which one should I use?' });
    h.runtime.finish(silent, 'idle');

    expect(h.controller.autopilotAgent(worker)).toEqual({
      status: 'idle',
      lastAssistantText: 'The migration needs a database URL — which one should I use?',
    });
    expect(towerAutopilotObservations(h.controller).agent(worker)).toMatchObject({
      lastAssistantText: 'The migration needs a database URL — which one should I use?',
    });
    expect(h.controller.autopilotAgent(silent)).toEqual({ status: 'idle' });
  });

  it('reports unknown, never running, when the process has no agent runtime', async () => {
    const h = await harness({ runtime: false });

    expect(h.controller.autopilotAgent('agent-1')).toEqual({ status: 'unknown' });
  });

  it('sees the orchestrator busy while the main session runs a turn', async () => {
    const h = await harness();

    expect(h.controller.orchestratorBusy()).toBe(false);
    h.ctx.idle = false;
    expect(h.controller.orchestratorBusy()).toBe(true);
  });
});

describe('autopilot effects', () => {
  async function effectsHarness(): Promise<Harness & { readonly effects: ReturnType<typeof towerAutopilotEffects> }> {
    const h = await harness({
      prepare: async (store) => {
        await initialized(store);
        await store.plan([
          { title: 'Build gemm', scope: ['src/gemm/**'] },
          { title: 'Build conv', scope: ['src/conv/**'] },
        ]);
      },
    });
    await h.controller.enter();
    return { ...h, effects: towerAutopilotEffects(h.controller) };
  }

  async function mission(h: Harness, id: string) {
    const found = (await h.store.load()).missions.find((candidate) => candidate.id === id);
    if (found === undefined) throw new Error(`no mission ${id}`);
    return found;
  }

  it('spawns and respawns workers through TowerSpawn, registering them on their mission', async () => {
    const h = await effectsHarness();

    const spawned = await h.effects.spawnWorker('M1', 'ap-w-M1-1');
    expect(spawned).toMatchObject({ ok: true, detail: expect.stringMatching(/^name: ap-w-M1-1 kind: worker agent_id: agent-1 /) });
    expect(spawned.ok ? (spawned.detail ?? '') : '').not.toContain('\n');
    h.runtime.finish('agent-1', 'timed_out', { stopReason: 'timed out after 2h' });
    const respawned = await h.effects.respawnWorker('M1', 'ap-w-M1-2', 'the previous worker timed out');

    expect(respawned).toMatchObject({ ok: true });
    const m1 = await mission(h, 'M1');
    expect(m1.owner).toBe('ap-w-M1-2');
    expect(h.runtime.specs.map((spec) => [spec.name, spec.kind, spec.cwd])).toEqual([
      ['ap-w-M1-1', 'worker', h.store.abs(join('.tower', 'worktrees', m1.worktree))],
      ['ap-w-M1-2', 'worker', h.store.abs(join('.tower', 'worktrees', m1.worktree))],
    ]);
    expect(h.runtime.specs[1]?.prompt).toContain('the previous worker timed out');
    const roster = (await h.store.load()).roster.agents;
    expect(roster.map((entry) => [entry.name, entry.kind, entry.missionId])).toEqual([
      ['ap-w-M1-1', 'worker', 'M1'],
      ['ap-w-M1-2', 'worker', 'M1'],
    ]);
  });

  it('reports refusals with the tool error instead of acting', async () => {
    const h = await effectsHarness();

    expect(await h.effects.spawnWorker('M9', 'ap-w-M9-1')).toEqual({
      ok: false,
      error: 'unknown mission "M9" — known missions: M1, M2',
    });
    expect(await h.effects.spawnReviewer('M9', 'ap-r-M9-1')).toEqual({
      ok: false,
      error: 'unknown mission "M9" — known missions: M1, M2',
    });
    await h.effects.spawnWorker('M1', 'ap-w-M1-1');
    const resumed = await h.effects.resumeWorker('ap-w-M1-1', 'address the review findings');
    expect(resumed.ok).toBe(false);
    expect(h.runtime.specs).toHaveLength(1);
  });

  it('resumes an idle worker with the prompt and spawns a reviewer on the mission branch', async () => {
    const h = await effectsHarness();
    await h.effects.spawnWorker('M1', 'ap-w-M1-1');
    h.runtime.finish('agent-1', 'idle');

    expect(await h.effects.resumeWorker('ap-w-M1-1', 'address the review findings')).toMatchObject({ ok: true });
    expect(h.runtime.resumes).toEqual([{ id: 'agent-1', prompt: 'address the review findings' }]);

    expect(await h.effects.spawnReviewer('M1', 'ap-r-M1-1')).toMatchObject({ ok: true });
    const m1 = await mission(h, 'M1');
    const reviewer = (await h.store.load()).roster.agents.find((entry) => entry.name === 'ap-r-M1-1');
    expect(reviewer).toMatchObject({ kind: 'reviewer', reviewTarget: m1.branch, reviewMissionId: 'M1' });
  });

  it('goes through the merge gate and the rebase tool, never around them', async () => {
    const h = await effectsHarness();
    await h.effects.spawnWorker('M1', 'ap-w-M1-1');

    expect(await h.effects.merge('M1')).toEqual({
      ok: false,
      error: 'merge blocked: mission M1 is active — only a completed mission can merge',
    });
    expect((await mission(h, 'M1')).status).toBe('active');
    const rebased = await h.effects.rebase('M1');
    expect(rebased.ok === false ? rebased.error : '').toMatch(/^worker\(s\) ap-w-M1-1 are mid-turn — rebasing under a running worker/);
  });

  it('reports a rebase that conflicts as done, leaving the blocker for the worker', async () => {
    const h = await effectsHarness();
    await h.effects.spawnWorker('M1', 'ap-w-M1-1');
    h.runtime.finish('agent-1', 'idle');
    const m1 = await mission(h, 'M1');
    await commitFile(h.store.abs(join('.tower', 'worktrees', m1.worktree)), 'src/gemm/a.ts', 'branch\n', 'branch change');
    await commitFile(h.repo, 'src/gemm/a.ts', 'base\n', 'base change');

    const rebased = await h.effects.rebase('M1');

    expect(rebased).toMatchObject({ ok: true, detail: expect.stringMatching(/^rebase of mission M1 .* conflicted and was aborted/) });
    expect((await mission(h, 'M1')).status).toBe('blocked');
  });

  it('wakes the orchestrator with a follow-up turn while tower mode is on and notifies the human', async () => {
    const h = await effectsHarness();

    h.effects.wakeOrchestrator('validation-failed: MS1 scrutiny r1');
    h.effects.notifyHuman('Objective O1 is blocked: stalled', 'warning');
    await h.controller.exit();
    h.effects.wakeOrchestrator('after exit');

    expect(h.pi.sentOfType(TOWER_AUTOPILOT_WAKE_MESSAGE)).toEqual([
      {
        message: { customType: TOWER_AUTOPILOT_WAKE_MESSAGE, content: 'validation-failed: MS1 scrutiny r1', display: true },
        options: { triggerTurn: true, deliverAs: 'followUp' },
      },
    ]);
    expect(h.ctx.ui.notices).toContainEqual({ message: 'Objective O1 is blocked: stalled', level: 'warning' });
  });
});

describe('validation worktrees', () => {
  const DEAD_PID = 434_343;

  async function registerValidator(
    store: TowerStore,
    name: string,
    agentId: string,
    sessionId: string,
  ): Promise<TowerValidationWorktree> {
    const prepared = await store.prepareValidationWorktree('MS1', 'scrutiny');
    const revision = (await store.load()).objective?.contractRevision;
    await store.registerAgent({
      name,
      agentId,
      sessionId,
      kind: 'validator',
      milestoneId: 'MS1',
      validationKind: 'scrutiny',
      validationRound: prepared.round,
      validatedCommit: prepared.commit,
      worktree: prepared.worktree,
      cwd: prepared.path,
      spawnedAt: new Date().toISOString(),
      ...(revision === undefined ? {} : { contractRevision: revision }),
    });
    return prepared;
  }

  async function launchValidator(h: Harness): Promise<{ readonly agentId: string; readonly prepared: TowerValidationWorktree }> {
    const launched = await h.controller.launchAgent({
      name: 'ap-v-MS1-scrutiny-1',
      kind: 'validator',
      description: 'validate MS1',
      cwd: h.repo,
      prompt: 'validate MS1',
    });
    if (!launched.ok) throw new Error(launched.reason);
    const prepared = await registerValidator(h.store, 'ap-v-MS1-scrutiny-1', launched.agentId, SESSION_ID);
    expect(existsSync(prepared.path)).toBe(true);
    return { agentId: launched.agentId, prepared };
  }

  async function activityLog(h: Harness): Promise<string> {
    return readFile(h.store.abs(ACTIVITY_LOG), 'utf8');
  }

  it('keeps the worktree while the validator runs and removes it after its verdict and normal end', async () => {
    const h = await harness({ prepare: validatingObjective });
    await h.controller.enter();
    const { agentId, prepared } = await launchValidator(h);
    await h.store.submitValidation(
      'ap-v-MS1-scrutiny-1',
      { milestone: 'MS1', kind: 'scrutiny', verdict: 'pass', failures: [], checks: ['typecheck'], evidence: 'green' },
      { skipScrutiny: false, skipUserTesting: false },
    );
    await settle();
    expect(existsSync(prepared.path)).toBe(true);

    h.runtime.finish(agentId, 'idle', { summary: 'Submitted pass.' });

    await vi.waitFor(() => expect(existsSync(prepared.path)).toBe(false), WAIT);
    expect(h.runtime.disposed).toEqual([agentId]);
    expect(await git(h.repo, 'worktree', 'list')).not.toContain(prepared.worktree);
    expect(await activityLog(h)).toContain(`worktree.remove worktree=${prepared.worktree}`);
  });

  it('removes the worktree of a validator that died without a verdict, after its death mark', async () => {
    const h = await harness({ prepare: validatingObjective });
    await h.controller.enter();
    const { agentId, prepared } = await launchValidator(h);

    h.runtime.finish(agentId, 'timed_out', { stopReason: 'timed out after 2h' });

    await vi.waitFor(() => expect(existsSync(prepared.path)).toBe(false), WAIT);
    const log = await activityLog(h);
    const died = log.indexOf(`died name=ap-v-MS1-scrutiny-1 agent=${agentId}`);
    expect(died).toBeGreaterThanOrEqual(0);
    expect(log.indexOf(`worktree.remove worktree=${prepared.worktree}`)).toBeGreaterThan(died);
    const entry = (await h.store.load()).roster.agents.find((agent) => agent.agentId === agentId);
    expect(entry).toMatchObject({ deathStatus: 'timed_out', worktree: prepared.worktree });
  });

  it('cleans the worktree a validator left behind when pi resumes the session after a restart', async () => {
    let left: TowerValidationWorktree | undefined;
    const h = await harness({
      prepare: async (store) => {
        await validatingObjective(store);
        left = await registerValidator(store, 'ap-v-MS1-scrutiny-1', 'agent-before-restart', SESSION_ID);
      },
      entries: [ACTIVE_MODE_RECORD],
    });

    expect(h.controller.isActive).toBe(true);
    expect(left === undefined || existsSync(left.path)).toBe(false);
    expect((await h.store.load()).roster.agents.map((entry) => entry.name)).toEqual(['ap-v-MS1-scrutiny-1']);
  });

  it('cleans the worktree of a validator the next session retires from a dead owner', async () => {
    let left: TowerValidationWorktree | undefined;
    const h = await harness({
      prepare: async (store) => {
        await validatingObjective(store);
        await mutateState(store, (state) => {
          state.sessionId = 'session-before-restart';
          state.ownerPid = DEAD_PID;
        });
        left = await registerValidator(store, 'ap-v-MS1-scrutiny-1', 'agent-gone', 'session-before-restart');
      },
      alive: (pid) => pid !== DEAD_PID,
    });

    await expect(h.controller.enter()).resolves.toEqual({ entered: true });

    expect(h.controller.isRetiredAgent('ap-v-MS1-scrutiny-1')).toBe(true);
    expect(left === undefined || existsSync(left.path)).toBe(false);
    expect((await h.store.load()).roster.agents).toEqual([]);
  });

  it('keeps the worktree of a validator still running in this process when tower mode is re-entered', async () => {
    const h = await harness({ prepare: validatingObjective });
    await h.controller.enter();
    const { agentId, prepared } = await launchValidator(h);

    await h.controller.exit();
    await h.controller.enter();

    expect(existsSync(prepared.path)).toBe(true);
    h.runtime.finish(agentId, 'idle');
    await vi.waitFor(() => expect(existsSync(prepared.path)).toBe(false), WAIT);
  });
});

describe('tower-mode reminders with an objective', () => {
  function beforeStart(): BeforeAgentStartEvent {
    return {
      type: 'before_agent_start',
      messageType: 'user',
      prompt: 'go',
      systemPrompt: '',
      systemPromptOptions: {},
    } as unknown as BeforeAgentStartEvent;
  }

  it('appends the playbook of the recorded objective mode, read from the store for the turn', async () => {
    const h = await harness({
      prepare: async (store) => {
        await planningObjective(store);
        await store.setObjectiveMode('headless');
      },
    });
    await h.controller.enter();

    const result = await h.controller.onBeforeAgentStart(beforeStart(), h.ctx.asContext);

    expect(result?.message?.content).toBe(`${TOWER_MODE_FULL_REMINDER}\n\n${TOWER_OBJECTIVE_HEADLESS_PLAYBOOK}`);
  });

  it('keeps the plain reminder without an objective and when the workspace is not initialized', async () => {
    const h = await harness();
    await h.controller.enter();

    const result = await h.controller.onBeforeAgentStart(beforeStart(), h.ctx.asContext);

    expect(result?.message?.content).toBe(TOWER_MODE_FULL_REMINDER);
  });
});

describe('the /tower objective command hooks', () => {
  function hooks(controller: TowerController): TowerCommandDeps {
    return {
      sendUserMessage: () => undefined,
      objective: {
        autopilotTick: (reason) => controller.autopilotTick(reason),
        objectiveSettings: () => controller.objectiveSettings(),
      },
    };
  }

  it('ticks the autopilot after approve and resume, and refreshes the limits from the configured settings', async () => {
    const h = await harness({
      config: { objective: { maxValidationRounds: 5, maxCostUsd: 20 } },
      prepare: async (store) => {
        await planningObjective(store);
        await store.requestObjectiveApproval();
      },
    });
    await h.controller.enter();
    const ui = commandUi(h.ctx.asCommandContext);
    const deps = hooks(h.controller);

    await handleTowerCommand(h.controller, 'approve', h.ctx.asCommandContext, deps, ui);
    await vi.waitFor(() => expect(h.autopilots[0]?.calls).toContain('tick approve'), WAIT);
    await handleTowerCommand(h.controller, 'pause checking the plan', h.ctx.asCommandContext, deps, ui);
    await handleTowerCommand(h.controller, 'resume', h.ctx.asCommandContext, deps, ui);

    await vi.waitFor(() => expect(h.autopilots[0]?.calls).toContain('tick resume'), WAIT);
    expect((await h.store.load()).objective).toMatchObject({
      status: 'executing',
      approvedBy: 'human',
      limits: { maxValidationRounds: 5, maxCostUsd: 20 },
    });
  });
});

describe('the autopilot runner wired to the controller', () => {
  const runners: AutopilotRunner[] = [];

  afterEach(async () => {
    for (const runner of runners.splice(0)) await runner.whenIdle();
  });

  function realRunner(controller: TowerController): AutopilotRunner {
    const runner = new AutopilotRunner({
      observations: towerAutopilotObservations(controller),
      effects: towerAutopilotEffects(controller),
    });
    runners.push(runner);
    return runner;
  }

  it('spawns the current milestone feature when tower mode is entered with an executing objective', async () => {
    const h = await harness({ prepare: executingObjective, createAutopilot: realRunner });

    await h.controller.enter();

    await vi.waitFor(() => expect(h.runtime.specs.map((spec) => [spec.name, spec.kind])).toEqual([['ap-w-M1-1', 'worker']]), WAIT);
    await runners[0]?.whenIdle();
    const state = await h.store.load();
    expect(state.missions.find((mission) => mission.id === 'M1')).toMatchObject({ status: 'active', owner: 'ap-w-M1-1' });
    expect(await readFile(h.store.abs(ACTIVITY_LOG), 'utf8')).toMatch(/ autopilot spawn-worker .*name=ap-w-M1-1/);
  });

  it('gives a feature whose worker a restart retired a fresh worker on the same branch', async () => {
    const h = await harness({
      prepare: async (store) => {
        await executingObjective(store);
        await store.registerSpawnedAgent(
          {
            name: 'ap-w-M1-1',
            agentId: 'agent-before-restart',
            sessionId: SESSION_ID,
            kind: 'worker',
            missionId: 'M1',
            spawnedAt: new Date().toISOString(),
          },
          { id: 'M1', owner: 'ap-w-M1-1' },
        );
      },
      entries: [ACTIVE_MODE_RECORD],
      createAutopilot: realRunner,
    });

    expect(h.controller.isActive).toBe(true);
    await vi.waitFor(() => expect(h.runtime.specs.map((spec) => spec.name)).toEqual(['ap-w-M1-2']), WAIT);
    await runners[0]?.whenIdle();
    const m1 = (await h.store.load()).missions.find((mission) => mission.id === 'M1');
    expect(m1).toMatchObject({ owner: 'ap-w-M1-2' });
    expect(h.runtime.specs[0]?.cwd).toBe(h.store.abs(join(WORKTREES_DIR, m1?.worktree ?? '')));
  });
});

async function objectiveWithChore(store: TowerStore): Promise<void> {
  await initialized(store);
  await store.plan([{ title: 'Write the docs', scope: ['docs/**'] }]);
  await store.draftObjective({
    title: 'Ship',
    goal: 'ship it',
    definitionOfDone: ['works'],
    milestones: [{ title: 'Core' }],
  });
  await store.plan([{ title: 'Core feature', scope: ['src/core/**'], milestone: 'MS1' }]);
  await store.requestObjectiveApproval();
  await store.approveObjective('human');
}

async function launchRegistered(
  h: Harness,
  entry: Omit<TowerRosterEntry, 'agentId' | 'sessionId' | 'spawnedAt'>,
): Promise<string> {
  const launched = await h.controller.launchAgent({
    name: entry.name,
    kind: entry.kind,
    description: entry.name,
    cwd: h.repo,
    prompt: 'go',
  });
  if (!launched.ok) throw new Error(launched.reason);
  await h.store.registerAgent({ ...entry, agentId: launched.agentId, sessionId: SESSION_ID, spawnedAt: new Date().toISOString() });
  return launched.agentId;
}

describe('agent-end notifications while the autopilot drives an objective', () => {
  function notifications(h: Harness) {
    return h.pi.sentOfType(TOWER_AGENT_NOTIFICATION_MESSAGE);
  }

  async function executing(config?: unknown): Promise<Harness> {
    const h = await harness({ prepare: objectiveWithChore, ...(config === undefined ? {} : { config }) });
    await h.controller.enter();
    await vi.waitFor(() => expect(h.autopilots[0]?.calls).toContain('tick restart'), WAIT);
    await settle();
    return h;
  }

  it('lets the workers and reviewers of objective features end without waking the orchestrator', async () => {
    const h = await executing();
    const worker = await launchRegistered(h, { name: 'ap-w-M2-1', kind: 'worker', missionId: 'M2' });
    const reviewer = await launchRegistered(h, { name: 'ap-r-M2-1', kind: 'reviewer', reviewMissionId: 'M2' });

    h.runtime.finish(worker, 'idle', { summary: 'Implemented the core feature.' });
    h.runtime.finish(reviewer, 'idle', { summary: 'Review submitted: clean.' });

    await vi.waitFor(() => expect(notifications(h)).toHaveLength(2), WAIT);
    expect(notifications(h).map((note) => note.options)).toEqual([
      { triggerTurn: false, deliverAs: 'followUp' },
      { triggerTurn: false, deliverAs: 'followUp' },
    ]);
    expect(sentText(notifications(h)[0])).toContain('Implemented the core feature.');
  });

  it('still wakes the orchestrator for agents outside the objective', async () => {
    const h = await executing();
    const chore = await launchRegistered(h, { name: 'agent-docs', kind: 'worker', missionId: 'M1' });
    const unregistered = await h.controller.launchAgent({
      name: 'agent-adhoc',
      kind: 'worker',
      description: 'adhoc',
      cwd: h.repo,
      prompt: 'go',
    });
    if (!unregistered.ok) throw new Error(unregistered.reason);

    h.runtime.finish(chore, 'idle');
    h.runtime.finish(unregistered.agentId, 'failed', { stopReason: 'provider error' });

    await vi.waitFor(() => expect(notifications(h)).toHaveLength(2), WAIT);
    expect(notifications(h).map((note) => note.options?.triggerTurn)).toEqual([true, true]);
  });

  it('keeps the v0.1 delivery with the autopilot off, before tower mode and once the objective stops executing', async () => {
    const off = await executing({ objective: { autopilot: false } });
    const offWorker = await launchRegistered(off, { name: 'ap-w-M2-1', kind: 'worker', missionId: 'M2' });
    off.runtime.finish(offWorker, 'idle');
    expect(notifications(off).map((note) => note.options)).toEqual([{ triggerTurn: true, deliverAs: 'followUp' }]);

    const paused = await executing();
    const pausedWorker = await launchRegistered(paused, { name: 'ap-w-M2-1', kind: 'worker', missionId: 'M2' });
    await paused.store.pauseObjective('the human is reviewing the plan');
    paused.runtime.finish(pausedWorker, 'idle');
    await vi.waitFor(() => expect(notifications(paused)).toHaveLength(1), WAIT);
    expect(notifications(paused)[0]?.options).toEqual({ triggerTurn: true, deliverAs: 'followUp' });

    const exited = await executing();
    const exitedWorker = await launchRegistered(exited, { name: 'ap-w-M2-1', kind: 'worker', missionId: 'M2' });
    await exited.controller.exit();
    exited.runtime.finish(exitedWorker, 'idle');
    expect(notifications(exited).map((note) => note.options?.triggerTurn)).toEqual([true]);
  });

  it('lets a validator of the objective end quietly', async () => {
    const h = await harness({ prepare: validatingObjective });
    await h.controller.enter();
    await settle();
    const state = await h.store.load();
    const milestone = state.objective?.milestones.find((candidate) => candidate.id === 'MS1');
    const validator = await launchRegistered(h, {
      name: 'ap-v-MS1-scrutiny-1',
      kind: 'validator',
      milestoneId: 'MS1',
      validationKind: 'scrutiny',
      validationRound: 1,
      validatedCommit: milestone?.validationCommit ?? '',
      ...(state.objective?.contractRevision === undefined ? {} : { contractRevision: state.objective.contractRevision }),
    });

    h.runtime.finish(validator, 'idle', { summary: 'Submitted pass.' });

    await vi.waitFor(() => expect(notifications(h)).toHaveLength(1), WAIT);
    expect(notifications(h)[0]?.options).toEqual({ triggerTurn: false, deliverAs: 'followUp' });
  });
});

describe('inbox wakes while the autopilot drives an objective', () => {
  interface Message {
    readonly from: string;
    readonly subject: string;
    readonly scope?: string;
    readonly action?: string;
  }

  const REVIEW_REQUEST: Message = { from: 'ap-w-M2-1', subject: 'review-request', scope: 'M2', action: 'complete' };
  const REVIEW_RESULT: Message = { from: 'ap-r-M2-1', subject: 'review-result', scope: 'M2', action: 'review-result' };
  const VALIDATION_RESULT: Message = {
    from: 'ap-w-M2-1',
    subject: 'validation MS1 scrutiny r1: pass',
    scope: 'MS1',
    action: 'validation-result',
  };
  const CLARIFY: Message = { from: 'ap-w-M2-1', subject: 'clarify-request' };
  const CHORE_DONE: Message = { from: 'agent-docs', subject: 'review-request', scope: 'M1', action: 'complete' };

  async function executing(config?: unknown): Promise<Harness> {
    const h = await harness({ prepare: objectiveWithChore, ...(config === undefined ? {} : { config }) });
    await h.controller.enter();
    await vi.waitFor(() => expect(h.autopilots[0]?.calls).toContain('tick restart'), WAIT);
    const spawnedAt = new Date().toISOString();
    for (const entry of [
      { name: 'ap-w-M2-1', agentId: 'agent-w', kind: 'worker', missionId: 'M2' },
      { name: 'ap-r-M2-1', agentId: 'agent-r', kind: 'reviewer', reviewMissionId: 'M2' },
      { name: 'agent-docs', agentId: 'agent-d', kind: 'worker', missionId: 'M1' },
    ] as const) {
      await h.store.registerAgent({ ...entry, sessionId: SESSION_ID, spawnedAt });
    }
    await settle();
    return h;
  }

  async function deliver(h: Harness, messages: readonly Message[]) {
    const stored = [];
    for (const message of messages) {
      stored.push(
        await h.store.sendDetailed(message.from, {
          to: 'tower',
          subject: message.subject,
          body: message.subject,
          ...(message.scope === undefined ? {} : { scope: message.scope }),
          ...(message.action === undefined ? {} : { action: message.action }),
        }),
      );
    }
    for (const sent of stored) {
      h.controller.publishInboxSent({
        from: sent.item.from,
        to: sent.item.to,
        subject: sent.item.subject,
        messageId: sent.item.messageId,
        file: sent.item.file,
        sentAt: sent.item.sentAt,
        ...(sent.missionId === undefined ? {} : { missionId: sent.missionId }),
      });
    }
    await vi.waitFor(() => expect(h.pi.sentOfType(TOWER_INBOX_WAKE_MESSAGE)).toHaveLength(1), WAIT);
    return h.pi.sentOfType(TOWER_INBOX_WAKE_MESSAGE)[0];
  }

  it('delivers a batch of review requests, review results and validation results as context only', async () => {
    const h = await executing();

    const wake = await deliver(h, [REVIEW_REQUEST, REVIEW_RESULT, VALIDATION_RESULT]);

    expect(wake?.options).toEqual({ triggerTurn: false, deliverAs: 'followUp' });
    expect(wake?.message.details).toEqual({ references: 3, omitted: 0 });
  });

  it('wakes the orchestrator for a mixed batch with one message that needs judgment', async () => {
    const h = await executing();

    const wake = await deliver(h, [REVIEW_REQUEST, REVIEW_RESULT, CLARIFY, VALIDATION_RESULT]);

    expect(wake?.options).toEqual({ triggerTurn: true, deliverAs: 'followUp' });
    expect(wake?.message.details).toEqual({ references: 4, omitted: 0 });
  });

  it('wakes the orchestrator for a mechanical message outside the objective', async () => {
    const h = await executing();

    const wake = await deliver(h, [REVIEW_RESULT, CHORE_DONE]);

    expect(wake?.options).toEqual({ triggerTurn: true, deliverAs: 'followUp' });
  });

  it('keeps waking the orchestrator for mechanical batches with the autopilot off or the objective paused', async () => {
    const off = await executing({ objective: { autopilot: false } });
    expect((await deliver(off, [REVIEW_REQUEST, REVIEW_RESULT]))?.options).toEqual({
      triggerTurn: true,
      deliverAs: 'followUp',
    });

    const paused = await executing();
    await paused.store.pauseObjective('the human is reviewing the plan');
    expect((await deliver(paused, [REVIEW_REQUEST, REVIEW_RESULT]))?.options).toEqual({
      triggerTurn: true,
      deliverAs: 'followUp',
    });
  });
});
