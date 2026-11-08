import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxProviderHandle,
} from '@earendil-works/pi-ai';
import {
  defineTool,
  ModelRegistry,
  ModelRuntime,
  type ExtensionAPI,
  type ExtensionError,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TowerAgentRuntime } from '../../src/runtime/agentRuntime.ts';
import { TowerRateLimiter } from '../../src/runtime/rateLimit.ts';
import {
  createPiSessionFactory,
  DEFAULT_TOWER_AGENT_TOOLS,
  PI_TOWER_PACKAGE_ROOT,
  PiTowerAgentSession,
  type PiSessionFactoryOptions,
} from '../../src/runtime/sessionFactory.ts';
import type { TowerAgentEvent, TowerAgentSession, TowerAgentSpec } from '../../src/runtime/types.ts';
import { nextEvent } from './fakeSession.ts';

const FIXTURE_EXTENSION = fileURLToPath(new URL('./fixtures/towerExtension.ts', import.meta.url));

interface Sandbox {
  readonly root: string;
  readonly agentDir: string;
  readonly cwd: string;
  readonly repoRoot: string;
  readonly modelRuntime: ModelRuntime;
  readonly registry: ModelRegistry;
  readonly faux: FauxProviderHandle;
}

const pingTool = defineTool({
  name: 'TowerPing',
  label: 'Tower ping',
  description: 'Replies pong.',
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: 'text', text: 'pong' }], details: {} }),
});

function inlineToolExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'TowerInline',
    label: 'Tower inline',
    description: 'Registered by an inline extension factory.',
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text', text: 'inline' }], details: {} }),
  });
}

function userExtensionSource(toolName: string): string {
  return [
    'export default function (pi) {',
    `  pi.registerTool({ name: '${toolName}', label: '${toolName}', description: '${toolName}',`,
    "    parameters: { type: 'object', properties: {} },",
    "    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }) });",
    '}',
    '',
  ].join('\n');
}

describe('createPiSessionFactory', () => {
  let sandbox: Sandbox;
  const handles: TowerAgentSession[] = [];

  beforeEach(async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-tower-runtime-'));
    const agentDir = join(root, 'agent');
    const cwd = join(root, 'work');
    const repoRoot = join(root, 'repo');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd);
    mkdirSync(repoRoot);
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: join(agentDir, 'models.json'),
    });
    const faux = fauxProvider({ provider: 'faux-test', models: [{ id: 'faux-1' }] });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.getAvailable();
    sandbox = { root, agentDir, cwd, repoRoot, modelRuntime, registry: new ModelRegistry(modelRuntime), faux };
  });

  afterEach(async () => {
    await Promise.all(handles.splice(0).map(async (handle) => handle.dispose()));
    vi.unstubAllEnvs();
    rmSync(sandbox.root, { recursive: true, force: true });
  });

  function factory(options: PiSessionFactoryOptions = {}) {
    return createPiSessionFactory({ agentDir: sandbox.agentDir, modelRegistry: sandbox.registry, ...options });
  }

  function spec(overrides: Partial<TowerAgentSpec> = {}): TowerAgentSpec {
    return { name: 'agent-alpha', cwd: sandbox.cwd, prompt: 'Say hello.', model: 'faux-test/faux-1', ...overrides };
  }

  async function open(options: PiSessionFactoryOptions, overrides: Partial<TowerAgentSpec> = {}, agentId = 'agent-t1') {
    const handle = await factory(options)({ agentId, spec: spec(overrides) });
    handles.push(handle);
    expect(handle).toBeInstanceOf(PiTowerAgentSession);
    return (handle as PiTowerAgentSession).session;
  }

  it('builds a pi session with the spec model, tools, custom tools, inline extensions and prompt append', async () => {
    const session = await open(
      {},
      {
        thinkingLevel: 'off',
        appendSystemPrompt: ['TOWER WORKER OVERLAY', 'SECOND APPEND'],
        customTools: [pingTool],
        extensionFactories: [{ name: 'tower-worker', factory: inlineToolExtension }],
      },
    );

    expect(`${session.model?.provider ?? ''}/${session.model?.id ?? ''}`).toBe('faux-test/faux-1');
    expect(session.thinkingLevel).toBe('off');
    expect(session.sessionId).toBe('agent-t1');
    expect(session.sessionFile).toBeUndefined();
    expect([...session.getActiveToolNames()].sort()).toEqual(
      [...DEFAULT_TOWER_AGENT_TOOLS, 'TowerPing', 'TowerInline'].sort(),
    );
    expect(session.systemPrompt).toContain('TOWER WORKER OVERLAY');
    expect(session.systemPrompt).toContain('SECOND APPEND');
  });

  it("keeps the user's skills and the project's context files", async () => {
    mkdirSync(join(sandbox.agentDir, 'skills', 'tower-probe-skill'), { recursive: true });
    writeFileSync(
      join(sandbox.agentDir, 'skills', 'tower-probe-skill', 'SKILL.md'),
      [
        '---',
        'name: tower-probe-skill',
        "description: Probe skill proving that tower agents keep the user's skills.",
        '---',
        'Reply with PROBE.',
        '',
      ].join('\n'),
    );
    writeFileSync(join(sandbox.cwd, 'AGENTS.md'), 'PROJECT CONTEXT MARKER 5150\n');

    const session = await open({});

    expect(session.resourceLoader.getSkills().skills.map((skill) => skill.name)).toContain('tower-probe-skill');
    expect(session.systemPrompt).toContain('tower-probe-skill');
    expect(session.systemPrompt).toContain('PROJECT CONTEXT MARKER 5150');
  });

  it('reuses the parent model runtime: models registered only there resolve', async () => {
    const isolated = createPiSessionFactory({ agentDir: sandbox.agentDir });

    await expect(isolated({ agentId: 'agent-t2', spec: spec() })).rejects.toThrow(
      'unknown model "faux-test/faux-1"',
    );
    const session = await open({ modelRegistry: () => sandbox.registry });
    expect(session.model?.id).toBe('faux-1');
    expect(session.modelRuntime).toBe(sandbox.modelRuntime);
  });

  it('falls back to a model runtime created from the same agentDir', async () => {
    writeFileSync(
      join(sandbox.agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          'local-test': {
            baseUrl: 'http://127.0.0.1:9/v1',
            api: 'openai-completions',
            apiKey: 'dummy',
            models: [{ id: 'local-1' }],
          },
        },
      }),
    );

    const session = await open({ modelRegistry: undefined }, { model: 'local-test/local-1' });

    expect(`${session.model?.provider ?? ''}/${session.model?.id ?? ''}`).toBe('local-test/local-1');
    expect(session.modelRuntime).not.toBe(sandbox.modelRuntime);
  });

  it('refuses unknown models, providers without credentials, +/- tool modifiers and missing cwds', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const create = factory();

    await expect(create({ agentId: 'agent-x1', spec: spec({ model: 'faux-test/missing' }) })).rejects.toThrow(
      'unknown model "faux-test/missing"',
    );
    await expect(create({ agentId: 'agent-x2', spec: spec({ model: 'faux-1' }) })).rejects.toThrow(
      'unknown model "faux-1"',
    );
    await expect(
      create({ agentId: 'agent-x3', spec: spec({ model: 'anthropic/claude-sonnet-4-5' }) }),
    ).rejects.toThrow('no credentials configured for provider "anthropic"');
    await expect(create({ agentId: 'agent-x4', spec: spec({ tools: ['read', '+bash'] }) })).rejects.toThrow(
      'is a +/- modifier',
    );
    await expect(
      create({ agentId: 'agent-x5', spec: spec({ cwd: join(sandbox.root, 'missing-worktree') }) }),
    ).rejects.toThrow('is not a directory');
  });

  it('keeps user extensions but drops extensions under the excluded roots', async () => {
    const fakeTower = join(sandbox.root, 'fake-tower');
    mkdirSync(join(fakeTower, 'src'), { recursive: true });
    writeFileSync(join(fakeTower, 'src', 'index.ts'), userExtensionSource('TowerInit'));
    mkdirSync(join(sandbox.agentDir, 'extensions'));
    writeFileSync(join(sandbox.agentDir, 'extensions', 'user-ext.ts'), userExtensionSource('UserTool'));
    writeFileSync(
      join(sandbox.agentDir, 'settings.json'),
      JSON.stringify({ retry: { enabled: false }, extensions: [join(fakeTower, 'src', 'index.ts')] }),
    );

    const session = await open(
      { excludeExtensionRoots: [fakeTower] },
      { tools: [...DEFAULT_TOWER_AGENT_TOOLS, 'UserTool', 'TowerInit'] },
    );

    const paths = session.resourceLoader.getExtensions().extensions.map((extension) => extension.path);
    expect(paths).toEqual([join(sandbox.agentDir, 'extensions', 'user-ext.ts')]);
    expect(session.getActiveToolNames()).toContain('UserTool');
    expect(session.getActiveToolNames()).not.toContain('TowerInit');
  });

  it('excludes extensions from this package root by default, through symlinks too', async () => {
    expect(JSON.parse(readFileSync(join(PI_TOWER_PACKAGE_ROOT, 'package.json'), 'utf8'))).toMatchObject({
      name: 'pi-tower',
    });
    mkdirSync(join(sandbox.agentDir, 'extensions'));
    symlinkSync(FIXTURE_EXTENSION, join(sandbox.agentDir, 'extensions', 'linked-tower.ts'));
    writeFileSync(join(sandbox.agentDir, 'extensions', 'user-ext.ts'), userExtensionSource('UserTool'));
    writeFileSync(
      join(sandbox.agentDir, 'settings.json'),
      JSON.stringify({ retry: { enabled: false }, extensions: [FIXTURE_EXTENSION] }),
    );

    const included = await open(
      { excludeExtensionRoots: [] },
      { tools: ['read', 'TowerFixtureInit', 'UserTool'] },
      'agent-t3',
    );
    expect(included.getActiveToolNames()).toContain('TowerFixtureInit');

    const session = await open({}, { tools: ['read', 'TowerFixtureInit', 'UserTool'] }, 'agent-t4');
    const paths = session.resourceLoader.getExtensions().extensions.map((extension) => extension.path);
    expect(paths).toEqual([join(sandbox.agentDir, 'extensions', 'user-ext.ts')]);
    expect(session.getActiveToolNames()).toEqual(['read', 'UserTool']);
  });

  it('binds extensions on creation and emits session_shutdown on dispose', async () => {
    const lifecycle: string[] = [];
    const errors: Array<[string, ExtensionError]> = [];
    const handle = await factory({
      onExtensionError: (agentId, error) => {
        errors.push([agentId, error]);
      },
    })({
      agentId: 'agent-t5',
      spec: spec({
        extensionFactories: [
          (pi) => {
            pi.on('session_start', () => {
              lifecycle.push('start');
            });
            pi.on('session_shutdown', () => {
              lifecycle.push('shutdown');
            });
          },
          (pi) => {
            pi.on('session_start', () => {
              throw new Error('extension start failure');
            });
          },
        ],
      }),
    });

    expect(lifecycle).toEqual(['start']);
    expect(errors.map(([agentId, error]) => [agentId, error.error])).toEqual([
      ['agent-t5', 'extension start failure'],
    ]);
    await handle.dispose();
    expect(lifecycle).toEqual(['start', 'shutdown']);
  });

  describe('with TowerAgentRuntime', () => {
    let runtime: TowerAgentRuntime;
    let events: TowerAgentEvent[];

    beforeEach(() => {
      runtime = new TowerAgentRuntime({
        sessionFactory: factory({ repoRoot: sandbox.repoRoot }),
        limiter: new TowerRateLimiter(),
      });
      events = [];
      runtime.onEvent((event) => {
        events.push(event);
      });
    });

    afterEach(async () => {
      await runtime.disposeAll();
    });

    async function spawned(overrides: Partial<TowerAgentSpec> = {}): Promise<string> {
      const result = await runtime.spawn(spec(overrides));
      if (!result.ok) throw new Error(result.reason);
      return result.agentId;
    }

    it('runs to idle, persists the transcript under .tower/agents and continues it on resume', async () => {
      sandbox.faux.setResponses([
        fauxAssistantMessage('FIRST-REPLY'),
        (context) => {
          const prompts = context.messages
            .filter((message) => message.role === 'user')
            .map((message) => JSON.stringify(message.content));
          return fauxAssistantMessage(
            prompts.some((text) => text.includes('Say hello.')) ? 'REMEMBERS-FIRST-PROMPT' : 'FORGOT',
          );
        },
      ]);
      let finished = nextEvent(runtime, 'finished');
      const agentId = await spawned();

      expect(await finished).toMatchObject({ agentId, status: 'idle', summary: 'FIRST-REPLY' });
      const info = runtime.get(agentId);
      expect(info?.model).toBe('faux-test/faux-1');
      expect(info?.sessionId).toBe(agentId);
      expect(dirname(info?.sessionFile ?? '')).toBe(join(sandbox.repoRoot, '.tower', 'agents'));
      expect(info?.sessionFile).toContain(agentId);
      expect(existsSync(info?.sessionFile ?? '')).toBe(true);

      finished = nextEvent(runtime, 'finished');
      const resumed = await runtime.resume(agentId, 'What did I ask first?');
      expect(resumed.ok).toBe(true);
      expect(await finished).toMatchObject({ status: 'idle', summary: 'REMEMBERS-FIRST-PROMPT' });
      expect(readFileSync(info?.sessionFile ?? '', 'utf8')).toContain('What did I ask first?');
      expect(events.map((event) => event.type)).toEqual([
        'started',
        'request-succeeded',
        'finished',
        'started',
        'request-succeeded',
        'finished',
      ]);
    });

    it('steers a running session; the message reaches the model at the next step boundary', async () => {
      sandbox.faux.setResponses([
        fauxAssistantMessage(fauxToolCall('bash', { command: 'sleep 1' })),
        (context) => {
          const steered = context.messages.some(
            (message) => message.role === 'user' && JSON.stringify(message.content).includes('STEER-TOKEN-42'),
          );
          return fauxAssistantMessage(steered ? 'SAW-STEER' : 'NO-STEER');
        },
      ]);
      const finished = nextEvent(runtime, 'finished');
      const agentId = await spawned();
      await vi.waitFor(() => {
        expect(runtime.output(agentId)?.recentToolCalls.map((call) => call.name)).toEqual(['bash']);
      });

      expect(await runtime.steer(agentId, 'STEER-TOKEN-42: please acknowledge')).toBe('steered');

      expect(await finished).toMatchObject({ status: 'idle', summary: 'SAW-STEER' });
      expect(runtime.output(agentId)?.recentToolCalls).toMatchObject([{ name: 'bash', isError: false }]);
      expect(await runtime.steer(agentId, 'after the run')).toBe('idle');
    });

    it('stops a running session mid-tool and records the user stop', async () => {
      sandbox.faux.setResponses([
        fauxAssistantMessage(fauxToolCall('bash', { command: 'sleep 20' })),
        fauxAssistantMessage('should never be requested'),
      ]);
      const agentId = await spawned();
      await vi.waitFor(() => {
        expect(runtime.output(agentId)?.recentToolCalls).toHaveLength(1);
      });
      const startedAt = Date.now();

      expect(await runtime.stop(agentId)).toBe('stopped');

      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(runtime.get(agentId)).toMatchObject({ status: 'stopped', stopReason: 'user' });
      expect(sandbox.faux.getPendingResponseCount()).toBe(1);
    });

    it('fails a run on a provider 429 and feeds the limiter', async () => {
      sandbox.faux.setResponses([
        fauxAssistantMessage('', { stopReason: 'error', errorMessage: '429 Too Many Requests: rate limit exceeded' }),
      ]);
      const finished = nextEvent(runtime, 'finished');
      const agentId = await spawned();

      expect(await finished).toMatchObject({
        agentId,
        status: 'failed',
        stopReason: '429 Too Many Requests: rate limit exceeded',
      });
      expect(events.map((event) => event.type)).toEqual(['started', 'rate-limited', 'finished']);
      expect(runtime.limiter.snapshot().blockedUntil).not.toBeNull();
    });

    it('refuses a spawn for an unknown model without leaking a slot', async () => {
      const result = await runtime.spawn(spec({ model: 'faux-test/nope' }));

      expect(result).toEqual({
        ok: false,
        reason: 'tower spawn failed: unknown model "faux-test/nope" — expected provider/modelId from the model registry',
      });
      expect(runtime.limiter.snapshot().inflight).toBe(0);
    });
  });
});
