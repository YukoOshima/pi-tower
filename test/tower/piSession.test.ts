import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxProviderHandle,
  type Message,
} from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TOWER_VALIDATOR_ROLE, TOWER_WORKER_ROLE } from '../../src/prompts/index.ts';
import { STATE_FILE, TowerStore, type TowerState } from '../../src/protocol/index.ts';
import { PiTowerAgentSession, createPiSessionFactory } from '../../src/runtime/index.ts';
import { createOrchestratorTools, toToolDefinition } from '../../src/tools/index.ts';
import { createTowerAgentRuntime } from '../../src/tower/agentRuntime.ts';
import {
  TOWER_AGENT_NOTIFICATION_MESSAGE,
  TOWER_AGENT_TOOLS,
  TOWER_REVIEWER_BASE_TOOLS,
  TOWER_VALIDATOR_AGENT_TOOLS,
  TOWER_WORKER_BASE_TOOLS,
} from '../../src/tower/constants.ts';
import { TowerController } from '../../src/tower/controller.ts';
import { TowerModels } from '../../src/tower/models.ts';
import { FakeContext, FakePi, FakeSessionManager, createRepo, git, removeDir, sentText } from './fakes.ts';

const SESSION_ID = 'session-pi';
const PROVIDER = 'faux-tower';
const MODEL = 'faux-worker';

interface Sandbox {
  readonly repo: string;
  readonly faux: FauxProviderHandle;
  readonly ctx: FakeContext;
  readonly pi: FakePi;
  readonly controller: TowerController;
  readonly sessions: PiTowerAgentSession[];
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

async function sandbox(): Promise<Sandbox> {
  const root = mkdtempSync(join(tmpdir(), 'tower-pi-session-'));
  const agentDir = join(root, 'agent');
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
  writeFileSync(join(agentDir, 'tower.json'), JSON.stringify({ worker: `${PROVIDER}/${MODEL}` }));
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
  });
  const faux = fauxProvider({ provider: PROVIDER, models: [{ id: MODEL }] });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.getAvailable();
  const registry = new ModelRegistry(modelRuntime);
  const repo = await createRepo('tower-pi-session-repo-');
  cleanups.push(root, repo);

  const session = new FakeSessionManager(SESSION_ID);
  const ctx = new FakeContext(repo, session);
  Object.defineProperty(ctx, 'modelRegistry', { value: registry });
  ctx.model = registry.find(PROVIDER, MODEL);
  const pi = new FakePi();
  pi.session = session;
  pi.context = ctx;
  const models = new TowerModels({ agentDir, configDirName: '.pi', env: {}, getFlag: () => undefined });
  const sessions: PiTowerAgentSession[] = [];
  const controller = new TowerController({
    pi,
    models,
    isProcessAlive: () => true,
    createRuntime: (owner) =>
      createTowerAgentRuntime(owner, {
        agentDir,
        maxRunningAgents: () => models.maxRunningAgents,
        createSessionFactory: (options) => {
          const real = createPiSessionFactory(options);
          return async (request) => {
            const created = await real(request);
            if (created instanceof PiTowerAgentSession) sessions.push(created);
            return created;
          };
        },
      }),
  });
  controllers.push(controller);
  for (const tool of createOrchestratorTools(controller)) {
    pi.registerTool(toToolDefinition(tool, { defaultActive: false }));
  }
  await controller.onSessionStart({ type: 'session_start', reason: 'startup' }, ctx.asContext);
  const store = new TowerStore(repo);
  await store.init(SESSION_ID, 'main');
  await store.plan([{ title: 'Build gemm', scope: ['src/gemm/**'] }]);
  expect(await controller.enter()).toEqual({ entered: true });
  return { repo, faux, ctx, pi, controller, sessions };
}

function toolResults(messages: readonly Message[]): { readonly toolName: string; readonly isError: boolean; readonly text: string }[] {
  return messages.flatMap((message) =>
    message.role === 'toolResult'
      ? [
          {
            toolName: message.toolName,
            isError: message.isError,
            text: message.content.map((block) => (block.type === 'text' ? block.text : '')).join(''),
          },
        ]
      : [],
  );
}

function lastToolResultText(messages: readonly Message[]): string {
  return toolResults(messages).at(-1)?.text ?? '';
}

async function spawnWorker(s: Sandbox, name: string): Promise<string> {
  const spawn = s.pi.registeredTools.get('TowerSpawn') as RegisteredTool;
  const result = await spawn.execute(
    'call_spawn',
    { name, kind: 'worker', mission_id: 'M1' },
    undefined,
    undefined,
    s.ctx.asContext,
  );
  const text = result.content[0]?.text ?? '';
  expect(result.isError, text).toBeUndefined();
  const agentId = /agent_id: (\S+)/.exec(text)?.[1];
  if (agentId === undefined) throw new Error(`no agent_id in:\n${text}`);
  return agentId;
}

describe('a tower worker in a real pi session', () => {
  it('runs with the worker role prompt, exactly the worker tools, and tower tools bound to its own roster identity', async () => {
    const s = await sandbox();
    s.faux.setResponses([
      fauxAssistantMessage(fauxToolCall('TowerStatus', {})),
      (context) => fauxAssistantMessage(`STATUS SEEN: ${lastToolResultText(context.messages).split('\n')[0] ?? ''}`),
    ]);

    const agentId = await spawnWorker(s, 'agent-faux');

    await vi.waitFor(() => expect(s.pi.sentOfType(TOWER_AGENT_NOTIFICATION_MESSAGE)).toHaveLength(1), {
      timeout: 10_000,
    });
    const notification = sentText(s.pi.sentOfType(TOWER_AGENT_NOTIFICATION_MESSAGE)[0]);
    expect(notification).toContain('agent-faux');
    expect(notification).toContain('STATUS SEEN: # Tower status — base: main (mode: branch), you are: agent-faux');
    const [worker] = s.sessions;
    expect(worker?.session.systemPrompt).toContain(TOWER_WORKER_ROLE);
    expect([...(worker?.session.getActiveToolNames() ?? [])].sort()).toEqual(
      [...TOWER_WORKER_BASE_TOOLS, ...TOWER_AGENT_TOOLS].sort(),
    );
    expect(s.controller.agentInfo(agentId)).toMatchObject({
      status: 'idle',
      windingDown: false,
      model: `${PROVIDER}/${MODEL}`,
    });
    expect(s.controller.agentOutput(agentId)?.recentToolCalls).toEqual([
      expect.objectContaining({ name: 'TowerStatus', isError: false }),
    ]);
  });

  it('blocks writes outside its worktree and bash that would wipe the tower state', async () => {
    const s = await sandbox();
    const outside = join(s.repo, 'OUTSIDE.md');
    const comms = join(s.repo, '.tower', 'comms');
    s.faux.setResponses([
      fauxAssistantMessage(fauxToolCall('write', { path: outside, content: 'escape' })),
      fauxAssistantMessage(fauxToolCall('bash', { command: `rm -rf ${comms}` })),
      fauxAssistantMessage(fauxToolCall('write', { path: 'notes.md', content: 'inside' })),
      (context) =>
        fauxAssistantMessage(
          `RESULTS ${toolResults(context.messages)
            .map((result) => `${result.toolName}:${result.isError ? 'blocked' : 'ok'}:${result.text.split('\n')[0] ?? ''}`)
            .join(' | ')}`,
        ),
    ]);

    await spawnWorker(s, 'agent-guarded');

    await vi.waitFor(() => expect(s.pi.sentOfType(TOWER_AGENT_NOTIFICATION_MESSAGE)).toHaveLength(1), {
      timeout: 10_000,
    });
    const summary = sentText(s.pi.sentOfType(TOWER_AGENT_NOTIFICATION_MESSAGE)[0]);
    expect(summary).toMatch(/write:blocked:[^|]*tower workers may only write inside their own worktree/);
    expect(summary).toMatch(/bash:blocked:[^|]*`rm` is not allowed on tower protocol paths/);
    expect(summary).toMatch(/write:ok:/);
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(join(comms, 'state.json'))).toBe(true);
    const mission = (await new TowerStore(s.repo).load()).missions.find((candidate) => candidate.id === 'M1');
    expect(existsSync(join(s.repo, '.tower', 'worktrees', mission?.worktree ?? '', 'notes.md'))).toBe(true);
  });
});

describe('a tower validator in a real pi session', () => {
  async function validatingMilestone(s: Sandbox): Promise<TowerStore> {
    const store = new TowerStore(s.repo);
    await store.draftObjective({ title: 'Ship', goal: 'ship it', definitionOfDone: ['works'], milestones: [{ title: 'Core' }] });
    await store.plan([{ title: 'Core feature', scope: ['src/core/**'], milestone: 'MS1' }]);
    await store.requestObjectiveApproval();
    await store.approveObjective('human');
    const file = join(s.repo, STATE_FILE);
    const state = JSON.parse(readFileSync(file, 'utf8')) as TowerState;
    for (const mission of state.missions) if (mission.milestone === 'MS1') mission.status = 'merged';
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
    await store.startMilestoneValidation('MS1', await git(s.repo, 'rev-parse', 'main'));
    return store;
  }

  it('runs read-only with the validator role and tools, records its verdict and leaves no worktree behind', async () => {
    const s = await sandbox();
    const store = await validatingMilestone(s);
    s.faux.setResponses([
      fauxAssistantMessage(fauxToolCall('write', { path: 'src/core/hack.ts', content: 'x' })),
      fauxAssistantMessage(
        fauxToolCall('TowerValidate', {
          milestone: 'MS1',
          kind: 'scrutiny',
          verdict: 'pass',
          failures: [],
          checks: ['read the merged diff'],
          evidence: 'the core feature matches its tasks',
        }),
      ),
      (context) =>
        fauxAssistantMessage(
          `RESULTS ${toolResults(context.messages)
            .map((result) => `${result.toolName}:${result.isError ? 'error' : 'ok'}`)
            .join(' | ')}`,
        ),
    ]);
    const spawn = s.pi.registeredTools.get('TowerSpawn') as RegisteredTool;

    const spawned = await spawn.execute(
      'call_spawn',
      { name: 'ap-v-MS1-scrutiny-1', kind: 'validator', milestone: 'MS1', validation_kind: 'scrutiny' },
      undefined,
      undefined,
      s.ctx.asContext,
    );
    expect(spawned.isError, spawned.content[0]?.text).toBeUndefined();
    const entry = (await store.load()).roster.agents.find((agent) => agent.name === 'ap-v-MS1-scrutiny-1');
    const worktree = join(s.repo, '.tower', 'worktrees', entry?.worktree ?? '');

    await vi.waitFor(() => expect(s.pi.sentOfType(TOWER_AGENT_NOTIFICATION_MESSAGE)).toHaveLength(1), {
      timeout: 10_000,
    });
    const summary = sentText(s.pi.sentOfType(TOWER_AGENT_NOTIFICATION_MESSAGE)[0]);
    expect(summary).toContain('Background validator completed');
    expect(summary).toContain('RESULTS write:error | TowerValidate:ok');
    const [validator] = s.sessions;
    expect(validator?.session.systemPrompt).toContain(TOWER_VALIDATOR_ROLE);
    expect([...(validator?.session.getActiveToolNames() ?? [])].sort()).toEqual(
      [...TOWER_REVIEWER_BASE_TOOLS, ...TOWER_VALIDATOR_AGENT_TOOLS].sort(),
    );
    expect(existsSync(join(worktree, 'src', 'core', 'hack.ts'))).toBe(false);
    const milestone = (await store.load()).objective?.milestones.find((candidate) => candidate.id === 'MS1');
    expect(milestone?.rounds).toContainEqual(
      expect.objectContaining({ kind: 'scrutiny', verdict: 'pass', validator: 'ap-v-MS1-scrutiny-1' }),
    );
    await vi.waitFor(() => expect(existsSync(worktree)).toBe(false), { timeout: 10_000 });
  });
});
