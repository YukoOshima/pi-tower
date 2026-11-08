import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import type { AgentSessionEvent, AgentSessionEventListener } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TOWER_WORKER_ROLE } from '../../src/prompts/index.ts';
import { TowerStore, WORKTREES_DIR } from '../../src/protocol/index.ts';
import type {
  PiSessionFactoryOptions,
  TowerAgentSession,
  TowerAgentSessionFactory,
  TowerAgentSessionRequest,
  TowerSteerDisposition,
  TowerThinkingLevel,
} from '../../src/runtime/index.ts';
import { createOrchestratorTools, toToolDefinition } from '../../src/tools/index.ts';
import { createTowerAgentRuntime } from '../../src/tower/agentRuntime.ts';
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  TOWER_AGENT_NOTIFICATION_MESSAGE,
  TOWER_AGENT_TOOLS,
  TOWER_REVIEWER_BASE_TOOLS,
  TOWER_WORKER_BASE_TOOLS,
} from '../../src/tower/constants.ts';
import { TowerController } from '../../src/tower/controller.ts';
import { TowerModels } from '../../src/tower/models.ts';
import { FakeContext, FakePi, FakeSessionManager, createRepo, removeDir, sentText, settle } from './fakes.ts';

const SESSION_ID = 'session-runtime';

class FakeAgentSession implements TowerAgentSession {
  readonly sessionId: string;
  readonly sessionFile = undefined;
  readonly model: { readonly provider: string; readonly id: string };
  readonly thinkingLevel: TowerThinkingLevel;
  readonly prompts: string[] = [];
  isStreaming = false;
  ignoreAbort = false;
  disposed = false;
  private readonly listeners = new Set<AgentSessionEventListener>();
  private pending: (() => void) | undefined;

  constructor(request: TowerAgentSessionRequest) {
    this.sessionId = `pi-${request.agentId}`;
    const ref = typeof request.spec.model === 'string' ? request.spec.model : 'fake/default-model';
    const slash = ref.indexOf('/');
    this.model = { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
    this.thinkingLevel = request.spec.thinkingLevel ?? 'medium';
  }

  prompt(text: string): Promise<void> {
    this.prompts.push(text);
    this.isStreaming = true;
    this.emit({ type: 'agent_start' } as AgentSessionEvent);
    return new Promise<void>((resolve) => {
      this.pending = resolve;
    });
  }

  async steer(): Promise<TowerSteerDisposition> {
    return 'queued';
  }

  discardQueued(): readonly string[] {
    return [];
  }

  async abort(): Promise<void> {
    if (this.ignoreAbort || !this.isStreaming) return;
    this.settle(true);
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.disposed = true;
  }

  complete(text: string): void {
    this.emit({ type: 'message_end', message: fauxAssistantMessage(text) } as AgentSessionEvent);
    this.settle(false);
  }

  settle(aborted: boolean): void {
    this.isStreaming = false;
    this.emit({ type: 'agent_settled', aborted } as AgentSessionEvent);
    const resolve = this.pending;
    this.pending = undefined;
    resolve?.();
  }

  private emit(event: AgentSessionEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

interface Harness {
  readonly repo: string;
  readonly ctx: FakeContext;
  readonly pi: FakePi;
  readonly controller: TowerController;
  readonly store: TowerStore;
  readonly factoryOptions: PiSessionFactoryOptions[];
  readonly requests: TowerAgentSessionRequest[];
  readonly sessions: FakeAgentSession[];
}

interface RegisteredTool {
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ): Promise<{ readonly content: readonly { readonly text: string }[]; readonly isError?: boolean }>;
}

const cleanups: string[] = [];
const controllers: TowerController[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.onSessionShutdown();
  for (const dir of cleanups.splice(0)) await removeDir(dir);
});

async function harness(config: unknown = {}): Promise<Harness> {
  const repo = await createRepo('tower-runtime-');
  const agentDir = await mkdtemp(join(tmpdir(), 'tower-runtime-agent-'));
  cleanups.push(repo, agentDir);
  await writeFile(join(agentDir, 'tower.json'), `${JSON.stringify(config)}\n`);
  const session = new FakeSessionManager(SESSION_ID);
  const ctx = new FakeContext(repo, session);
  ctx.model = ctx.modelRegistry.add('prov', 'session-model');
  ctx.modelRegistry.add('prov', 'worker-model');
  ctx.modelRegistry.add('prov', 'reviewer-model');
  const pi = new FakePi();
  pi.session = session;
  pi.context = ctx;
  const models = new TowerModels({ agentDir, configDirName: '.pi', env: {}, getFlag: () => undefined });
  const factoryOptions: PiSessionFactoryOptions[] = [];
  const requests: TowerAgentSessionRequest[] = [];
  const sessions: FakeAgentSession[] = [];
  const createSessionFactory = (options: PiSessionFactoryOptions): TowerAgentSessionFactory => {
    factoryOptions.push(options);
    return async (request) => {
      requests.push(request);
      const created = new FakeAgentSession(request);
      sessions.push(created);
      return created;
    };
  };
  const controller = new TowerController({
    pi,
    models,
    isProcessAlive: () => true,
    createRuntime: (owner) =>
      createTowerAgentRuntime(owner, {
        maxRunningAgents: () => models.maxRunningAgents,
        createSessionFactory,
        stopGraceMs: 50,
      }),
  });
  controllers.push(controller);
  for (const orchestratorTool of createOrchestratorTools(controller)) {
    pi.registerTool(toToolDefinition(orchestratorTool, { defaultActive: false }));
  }
  await controller.onSessionStart({ type: 'session_start', reason: 'startup' }, ctx.asContext);
  const store = new TowerStore(repo);
  await store.init(SESSION_ID, 'main');
  await store.plan([
    { title: 'Build gemm', scope: ['src/gemm/**'] },
    { title: 'Build conv', scope: ['src/conv/**'] },
  ]);
  expect(await controller.enter()).toEqual({ entered: true });
  return { repo, ctx, pi, controller, store, factoryOptions, requests, sessions };
}

function tool(h: Harness, name: string): RegisteredTool {
  const registered = h.pi.registeredTools.get(name) as RegisteredTool | undefined;
  if (registered !== undefined) return registered;
  throw new Error(`${name} is not registered`);
}

async function spawnTool(h: Harness, args: Record<string, unknown>) {
  const result = await tool(h, 'TowerSpawn').execute('call_spawn', args, undefined, undefined, h.ctx.asContext);
  return { text: result.content[0]?.text ?? '', isError: result.isError === true };
}

function agentIdOf(text: string): string {
  const match = /agent_id: (\S+)/.exec(text);
  if (match?.[1] === undefined) throw new Error(`no agent_id in:\n${text}`);
  return match[1];
}

describe('tower agents on the real runtime', () => {
  it('spawns a worker in its worktree with the worker role, its tool allowlist, the tower agent tools and the resolved model', async () => {
    const h = await harness({ worker: 'prov/worker-model:high' });

    const spawned = await spawnTool(h, { name: 'agent-build', kind: 'worker', mission_id: 'M1' });

    expect(spawned.isError).toBe(false);
    expect(spawned.text).toContain('model: prov/worker-model');
    const [request] = h.requests;
    const mission = (await h.store.load()).missions.find((candidate) => candidate.id === 'M1');
    expect(request?.agentId).toBe(agentIdOf(spawned.text));
    expect(request?.spec).toMatchObject({
      name: 'agent-build',
      kind: 'worker',
      cwd: h.store.abs(join(WORKTREES_DIR, mission?.worktree ?? '')),
      model: 'prov/worker-model',
      thinkingLevel: 'high',
      appendSystemPrompt: TOWER_WORKER_ROLE,
      tools: TOWER_WORKER_BASE_TOOLS,
      timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
    });
    expect((request?.spec.customTools ?? []).map((definition) => definition.name).sort()).toEqual(
      [...TOWER_AGENT_TOOLS].sort(),
    );
    const roster = (await h.store.load()).roster.agents;
    expect(roster).toEqual([
      expect.objectContaining({ name: 'agent-build', agentId: request?.agentId, model: 'prov/worker-model' }),
    ]);
    expect(h.controller.listAgents(true)).toEqual([
      expect.objectContaining({ name: 'agent-build', model: 'prov/worker-model', thinkingLevel: 'high' }),
    ]);
  });

  it('hands the session factory the live trust, the model registry and the repository root', async () => {
    const h = await harness();
    await spawnTool(h, { name: 'agent-build', kind: 'worker', mission_id: 'M1' });

    const [options] = h.factoryOptions;
    expect(h.factoryOptions).toHaveLength(1);
    expect(options?.repoRoot).toBe(h.store.repoRoot);
    const trusted = options?.projectTrusted;
    expect(typeof trusted).toBe('function');
    expect(typeof trusted === 'function' ? trusted() : trusted).toBe(true);
    h.ctx.trusted = false;
    expect(typeof trusted === 'function' ? trusted() : trusted).toBe(false);
    const registry = options?.modelRegistry;
    expect(typeof registry === 'function' ? registry() : registry).toBe(h.ctx.modelRegistry);
  });

  it('binds the tower agent tools to the spawned agent, not to the orchestrator', async () => {
    const h = await harness();
    await spawnTool(h, { name: 'agent-build', kind: 'worker', mission_id: 'M1' });
    const status = h.requests[0]?.spec.customTools?.find((definition) => definition.name === 'TowerStatus');
    if (status === undefined) throw new Error('TowerStatus is not among the agent tools');

    const toolContext = h.ctx as unknown as Parameters<typeof status.execute>[4];
    const result = await status.execute('call_status', {}, undefined, undefined, toolContext);

    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('you are: agent-build');
    expect(h.controller.sessionId).toBe(SESSION_ID);
  });

  it('feeds maxRunningAgents to the limiter as a live getter', async () => {
    const h = await harness({ maxRunningAgents: 1 });
    await spawnTool(h, { name: 'agent-build', kind: 'worker', mission_id: 'M1' });

    const refused = await spawnTool(h, { name: 'agent-conv', kind: 'worker', mission_id: 'M2' });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('tower concurrency budget exhausted (1/1 agents running)');
    expect(h.controller.rateLimitSnapshot()).toMatchObject({ budget: 1, inflight: 1 });
  });

  it("pauses new spawns after the orchestrator's provider answers 429", async () => {
    const h = await harness();

    h.controller.onAfterProviderResponse({ type: 'after_provider_response', status: 429, headers: {} });
    const refused = await spawnTool(h, { name: 'agent-build', kind: 'worker', mission_id: 'M1' });

    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('provider rate limit hit — new tower spawns paused');
  });

  it('gives a reviewer the read-only allowlist in the main checkout, notifies its completion and disposes it once settled', async () => {
    const h = await harness({ reviewer: 'prov/reviewer-model' });
    await spawnTool(h, { name: 'agent-build', kind: 'worker', mission_id: 'M1' });
    const mission = (await h.store.load()).missions.find((candidate) => candidate.id === 'M1');

    const spawned = await spawnTool(h, { name: 'reviewer-a', kind: 'reviewer', review_target: mission?.branch });

    expect(spawned.isError).toBe(false);
    const reviewerId = agentIdOf(spawned.text);
    const request = h.requests.find((candidate) => candidate.agentId === reviewerId);
    expect(request?.spec).toMatchObject({
      kind: 'reviewer',
      cwd: h.store.repoRoot,
      tools: TOWER_REVIEWER_BASE_TOOLS,
      model: 'prov/reviewer-model',
    });
    const reviewer = h.sessions.find((candidate) => candidate.sessionId === `pi-${reviewerId}`);
    reviewer?.complete('Review submitted: clean.');

    await vi.waitFor(() => expect(reviewer?.disposed).toBe(true));
    const notification = h.pi.sentOfType(TOWER_AGENT_NOTIFICATION_MESSAGE).at(-1);
    expect(sentText(notification)).toContain('reviewer-a');
    expect(sentText(notification)).toContain('Review submitted: clean.');
    expect(h.controller.agentOutput(reviewerId)?.lastAssistantText).toBe('Review submitted: clean.');
    expect(h.controller.activeAgentIds().has(reviewerId)).toBe(false);
  });

  it('keeps a stopped worker busy while it winds down and surfaces the resume refusal verbatim', async () => {
    const h = await harness();
    const spawned = await spawnTool(h, { name: 'agent-build', kind: 'worker', mission_id: 'M1' });
    const agentId = agentIdOf(spawned.text);
    const worker = h.sessions[0];
    if (worker === undefined) throw new Error('no worker session');
    worker.ignoreAbort = true;

    expect(await h.controller.stopAgent(agentId, 'stopped by the tower: redirect')).toBe('stopped');

    expect(h.controller.agentInfo(agentId)).toMatchObject({ status: 'stopped', windingDown: true });
    expect(h.controller.activeAgentIds().has(agentId)).toBe(true);
    await vi.waitFor(async () => {
      const entry = (await h.store.load()).roster.agents.find((candidate) => candidate.agentId === agentId);
      expect(entry).toMatchObject({ deathStatus: 'stopped', deathReason: 'stopped by the tower: redirect' });
    });
    const tasks = await tool(h, 'TowerTasks').execute('call_tasks', { active_only: true }, undefined, undefined, h.ctx.asContext);
    expect(tasks.content[0]?.text).toContain('winding down');
    const refused = await tool(h, 'TowerResume').execute(
      'call_resume',
      { agent: 'agent-build', prompt: 'continue' },
      undefined,
      undefined,
      h.ctx.asContext,
    );
    expect(refused).toMatchObject({
      isError: true,
      content: [{ text: `tower agent "agent-build" (${agentId}) is still winding down its previous run — retry shortly` }],
    });

    worker.settle(true);
    await settle();

    expect(h.controller.agentInfo(agentId)?.windingDown).toBe(false);
    expect(h.controller.activeAgentIds().has(agentId)).toBe(false);
    const resumed = await tool(h, 'TowerResume').execute(
      'call_resume_2',
      { agent: 'agent-build', prompt: 'continue' },
      undefined,
      undefined,
      h.ctx.asContext,
    );
    expect(resumed.isError).toBeUndefined();
    expect(worker.prompts.at(-1)).toBe('continue');
    await vi.waitFor(async () => {
      const entry = (await h.store.load()).roster.agents.find((candidate) => candidate.agentId === agentId);
      expect(entry?.diedAt).toBeUndefined();
    });
  });

  it('stops running agents on shutdown, records best-effort shutdown deaths and sends no notification', async () => {
    const h = await harness();
    const spawned = await spawnTool(h, { name: 'agent-build', kind: 'worker', mission_id: 'M1' });
    const agentId = agentIdOf(spawned.text);
    const before = h.pi.sentOfType(TOWER_AGENT_NOTIFICATION_MESSAGE).length;

    await h.controller.onSessionShutdown();

    expect(h.sessions[0]?.disposed).toBe(true);
    const entry = (await h.store.load()).roster.agents.find((candidate) => candidate.agentId === agentId);
    expect(entry).toMatchObject({ deathStatus: 'stopped', deathReason: 'shutdown' });
    expect(h.pi.sentOfType(TOWER_AGENT_NOTIFICATION_MESSAGE)).toHaveLength(before);
    expect((await h.store.load()).sessionId).toBe(SESSION_ID);
  });
});
