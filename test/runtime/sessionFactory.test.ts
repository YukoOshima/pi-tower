import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxProviderHandle,
  type Message,
} from '@earendil-works/pi-ai';
import {
  defineTool,
  ModelRegistry,
  ModelRuntime,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionError,
  type ExtensionFactory,
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
import type {
  TowerAgentEvent,
  TowerAgentSession,
  TowerAgentSessionFactory,
  TowerAgentSpec,
  TowerRunStartResult,
} from '../../src/runtime/types.ts';
import { deferred, nextEvent } from './fakeSession.ts';

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

const NATIVE_LEAK_KEY = '__piTowerNativeLeak';

function leakingExtensionSource(): string {
  return [
    'export default function (pi) {',
    "  pi.registerTool({ name: 'TowerInit', label: 'TowerInit', description: 'TowerInit',",
    "    parameters: { type: 'object', properties: {} },",
    "    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }) });",
    "  pi.registerProvider('leaked-provider', { baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions',",
    "    apiKey: 'dummy', models: [{ id: 'leaked-1', name: 'leaked-1', reasoning: false, input: ['text'],",
    '      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }] });',
    `  const native = globalThis.${NATIVE_LEAK_KEY};`,
    '  if (native) pi.registerProvider(native);',
    "  pi.registerMcpServer('leaked-mcp', { command: 'true', enabled: false });",
    '}',
    '',
  ].join('\n');
}

function userTexts(context: { readonly messages: readonly Message[] }): string[] {
  return context.messages.flatMap((message) => {
    if (message.role !== 'user') return [];
    if (typeof message.content === 'string') return [message.content];
    return [message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')];
  });
}

function started(result: TowerRunStartResult): string {
  if (!result.ok) throw new Error(result.reason);
  return result.agentId;
}

function untilAborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal === undefined || signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sessionOf(handle: TowerAgentSession): AgentSession {
  if (!(handle instanceof PiTowerAgentSession)) throw new Error('expected a PiTowerAgentSession');
  return handle.session;
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
    await sandbox.modelRuntime.getAvailable();
    vi.unstubAllEnvs();
    rmSync(sandbox.root, { recursive: true, force: true });
  });

  function factory(options: Partial<PiSessionFactoryOptions> = {}) {
    return createPiSessionFactory({
      projectTrusted: false,
      agentDir: sandbox.agentDir,
      modelRegistry: sandbox.registry,
      ...options,
    });
  }

  function spec(overrides: Partial<TowerAgentSpec> = {}): TowerAgentSpec {
    return { name: 'agent-alpha', cwd: sandbox.cwd, prompt: 'Say hello.', model: 'faux-test/faux-1', ...overrides };
  }

  async function open(
    options: Partial<PiSessionFactoryOptions>,
    overrides: Partial<TowerAgentSpec> = {},
    agentId = 'agent-t1',
  ) {
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
    const isolated = createPiSessionFactory({ projectTrusted: false, agentDir: sandbox.agentDir });

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

  it('reports once when a parent registry was given but its model runtime cannot be reused', async () => {
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
    const diagnostics: string[] = [];
    const opaqueRegistry: ModelRegistry = Object.create(ModelRegistry.prototype);
    const create = factory({
      modelRegistry: opaqueRegistry,
      onDiagnostic: (message) => {
        diagnostics.push(message);
      },
    });

    handles.push(await create({ agentId: 'agent-d1', spec: spec({ model: 'local-test/local-1' }) }));
    handles.push(await create({ agentId: 'agent-d2', spec: spec({ model: 'local-test/local-1' }) }));

    expect(diagnostics).toEqual([
      `the parent model registry exposes no reusable model runtime — tower agents use a model runtime loaded from ${sandbox.agentDir}, so the parent session's runtime-only API keys and extension-registered providers are not available to them`,
    ]);
    const quiet: string[] = [];
    handles.push(
      await factory({
        onDiagnostic: (message) => {
          quiet.push(message);
        },
      })({ agentId: 'agent-d3', spec: spec() }),
    );
    expect(quiet).toEqual([]);
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

  it('loads project-local extensions only while the project is trusted, re-reading trust per spawn', async () => {
    mkdirSync(join(sandbox.cwd, '.pi', 'extensions'), { recursive: true });
    writeFileSync(join(sandbox.cwd, '.pi', 'extensions', 'project-ext.ts'), userExtensionSource('ProjectTool'));
    const tools = { tools: ['read', 'ProjectTool'] };

    const untrusted = await open({ projectTrusted: false }, tools, 'agent-p1');
    expect(untrusted.resourceLoader.getExtensions().extensions).toEqual([]);
    expect(untrusted.getActiveToolNames()).toEqual(['read']);

    let trusted = false;
    const create = factory({ projectTrusted: () => trusted });
    const before = await create({ agentId: 'agent-p2', spec: spec(tools) });
    handles.push(before);
    trusted = true;
    const after = await create({ agentId: 'agent-p3', spec: spec(tools) });
    handles.push(after);

    expect(sessionOf(before).getActiveToolNames()).toEqual(['read']);
    expect(sessionOf(after).getActiveToolNames()).toEqual(['read', 'ProjectTool']);
    expect(sessionOf(after).resourceLoader.getExtensions().extensions.map((extension) => extension.path)).toEqual([
      join(sandbox.cwd, '.pi', 'extensions', 'project-ext.ts'),
    ]);
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

  it('excludes this package by root (through symlinks too) and by package name, each on its own', async () => {
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

    const tools = { tools: ['read', 'TowerFixtureInit', 'UserTool'] };

    const included = await open({ excludeExtensionRoots: [], excludePackageNames: [] }, tools, 'agent-t3');
    expect(included.getActiveToolNames()).toContain('TowerFixtureInit');

    for (const [options, agentId] of [
      [{ excludePackageNames: [] }, 'agent-t4'],
      [{ excludeExtensionRoots: [] }, 'agent-t5'],
      [{}, 'agent-t6'],
    ] as const) {
      const session = await open(options, tools, agentId);
      const paths = session.resourceLoader.getExtensions().extensions.map((extension) => extension.path);
      expect(paths, agentId).toEqual([join(sandbox.agentDir, 'extensions', 'user-ext.ts')]);
      expect(session.getActiveToolNames(), agentId).toEqual(['read', 'UserTool']);
    }
  });

  it('drops provider, native provider and MCP registrations of excluded extensions so nothing leaks into the parent runtime', async () => {
    const fakeTower = join(sandbox.root, 'fake-tower');
    mkdirSync(join(fakeTower, 'src'), { recursive: true });
    writeFileSync(join(fakeTower, 'src', 'index.ts'), leakingExtensionSource());
    writeFileSync(
      join(sandbox.agentDir, 'settings.json'),
      JSON.stringify({ retry: { enabled: false }, extensions: [join(fakeTower, 'src', 'index.ts')] }),
    );
    const globals = globalThis as Record<string, unknown>;
    globals[NATIVE_LEAK_KEY] = fauxProvider({ provider: 'leaked-native', models: [{ id: 'native-1' }] }).provider;
    try {
      const excluded = await open({ excludeExtensionRoots: [fakeTower] }, {}, 'agent-l1');
      expect(excluded.resourceLoader.getExtensions().extensions).toEqual([]);
      expect(excluded.resourceLoader.getExtensions().runtime.mcpServers.list()).toEqual([]);
      expect(sandbox.modelRuntime.getModel('leaked-provider', 'leaked-1')).toBeUndefined();
      expect(sandbox.modelRuntime.getModel('leaked-native', 'native-1')).toBeUndefined();

      const control = await open({ excludeExtensionRoots: [] }, {}, 'agent-l2');
      expect(control.resourceLoader.getExtensions().runtime.mcpServers.list().map((server) => server.name)).toEqual([
        'leaked-mcp',
      ]);
      expect(sandbox.modelRuntime.getModel('leaked-provider', 'leaked-1')).toBeDefined();
      expect(sandbox.modelRuntime.getModel('leaked-native', 'native-1')).toBeDefined();
    } finally {
      delete globals[NATIVE_LEAK_KEY];
    }
  });

  it('excludes a second pi-tower copy at another path by its package.json name', async () => {
    const otherCheckout = join(sandbox.root, 'other-checkout');
    mkdirSync(join(otherCheckout, 'src', 'nested'), { recursive: true });
    writeFileSync(join(otherCheckout, 'package.json'), JSON.stringify({ name: 'pi-tower', version: '0.0.1' }));
    writeFileSync(join(otherCheckout, 'src', 'nested', 'index.ts'), userExtensionSource('TowerInit'));
    const unrelated = join(sandbox.root, 'unrelated-package');
    mkdirSync(join(unrelated, 'src'), { recursive: true });
    writeFileSync(join(unrelated, 'package.json'), JSON.stringify({ name: 'pi-tower-helpers' }));
    writeFileSync(join(unrelated, 'src', 'index.ts'), userExtensionSource('HelperTool'));
    writeFileSync(
      join(sandbox.agentDir, 'settings.json'),
      JSON.stringify({
        retry: { enabled: false },
        extensions: [join(otherCheckout, 'src', 'nested', 'index.ts'), join(unrelated, 'src', 'index.ts')],
      }),
    );
    const tools = { tools: ['read', 'TowerInit', 'HelperTool'] };

    const session = await open({}, tools, 'agent-n1');
    expect(session.resourceLoader.getExtensions().extensions.map((extension) => extension.path)).toEqual([
      join(unrelated, 'src', 'index.ts'),
    ]);
    expect(session.getActiveToolNames()).toEqual(['read', 'HelperTool']);

    const allowed = await open({ excludePackageNames: [] }, tools, 'agent-n2');
    expect(allowed.getActiveToolNames()).toEqual(['read', 'TowerInit', 'HelperTool']);
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
    let sessions: Map<string, TowerAgentSession>;

    function capturingFactory(): TowerAgentSessionFactory {
      const create = factory({ repoRoot: sandbox.repoRoot });
      return async (request) => {
        const session = await create(request);
        sessions.set(request.agentId, session);
        return session;
      };
    }

    beforeEach(() => {
      sessions = new Map();
      runtime = new TowerAgentRuntime({ sessionFactory: capturingFactory(), limiter: new TowerRateLimiter() });
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

    for (const ending of ['stop', 'timeout'] as const) {
      it(`drops a steer sent during a model request that ends by ${ending}: the resumed run never sees it`, async () => {
        const seen: string[][] = [];
        sandbox.faux.setResponses([
          async (_context, options) => {
            await untilAborted(options?.signal);
            return fauxAssistantMessage('never delivered');
          },
          (context) => {
            seen.push(userTexts(context));
            return fauxAssistantMessage('RESUMED-CLEAN');
          },
        ]);
        let finished = nextEvent(runtime, 'finished');
        const agentId = await spawned({
          prompt: 'FIRST PROMPT',
          ...(ending === 'timeout' ? { timeoutMs: 400 } : {}),
        });
        await vi.waitFor(() => {
          expect(sandbox.faux.state.callCount).toBe(1);
        });

        expect(await runtime.steer(agentId, 'STALE-STEER-1 urgent directive')).toBe('steered');
        expect(await runtime.steer(agentId, '/STALE-STEER-2 looks like a command')).toBe('steered');
        expect(await runtime.steer(agentId, ' /STALE-STEER-3 began with a space')).toBe('steered');
        if (ending === 'stop') expect(await runtime.stop(agentId)).toBe('stopped');

        expect(await finished).toMatchObject({
          status: ending === 'stop' ? 'stopped' : 'timed_out',
          undeliveredSteers: [
            'STALE-STEER-1 urgent directive',
            '/STALE-STEER-2 looks like a command',
            ' /STALE-STEER-3 began with a space',
          ],
        });
        finished = nextEvent(runtime, 'finished');
        expect((await runtime.resume(agentId, 'RESUME PROMPT')).ok).toBe(true);
        expect(await finished).toMatchObject({ status: 'idle', summary: 'RESUMED-CLEAN', undeliveredSteers: [] });
        expect(seen).toEqual([['FIRST PROMPT', 'RESUME PROMPT']]);
      });
    }

    it('reports idle for a steer during a slow agent_settled handler, and the next run never sees it', async () => {
      const settling = deferred();
      const seen: string[][] = [];
      sandbox.faux.setResponses([
        fauxAssistantMessage('FIRST-DONE'),
        (context) => {
          seen.push(userTexts(context));
          return fauxAssistantMessage('SECOND-DONE');
        },
      ]);
      let slowed = false;
      const slowSettle: ExtensionFactory = (pi) => {
        pi.on('agent_settled', async () => {
          if (slowed) return;
          slowed = true;
          settling.resolve();
          await delay(200);
        });
      };
      let finished = nextEvent(runtime, 'finished');
      const agentId = await spawned({ prompt: 'FIRST PROMPT 2', extensionFactories: [slowSettle] });
      await settling.promise;

      expect(runtime.get(agentId)?.status).toBe('running');
      expect(await runtime.steer(agentId, 'LATE-STEER-2 directive')).toBe('idle');
      expect(await finished).toMatchObject({ status: 'idle', summary: 'FIRST-DONE', undeliveredSteers: [] });

      finished = nextEvent(runtime, 'finished');
      expect((await runtime.resume(agentId, 'RESUME PROMPT 2')).ok).toBe(true);
      expect(await finished).toMatchObject({ status: 'idle', summary: 'SECOND-DONE' });
      expect(seen).toEqual([['FIRST PROMPT 2', 'RESUME PROMPT 2']]);
    });

    it('waits for a steer held by a slow input handler past the end of the run, then drops it', async () => {
      const inputGate = deferred();
      const seen: string[][] = [];
      sandbox.faux.setResponses([
        fauxAssistantMessage(fauxToolCall('bash', { command: 'sleep 0.2' })),
        fauxAssistantMessage('FIRST-DONE'),
        (context) => {
          seen.push(userTexts(context));
          return fauxAssistantMessage('SECOND-DONE');
        },
      ]);
      const slowInput: ExtensionFactory = (pi) => {
        pi.on('input', async (event) => {
          if (event.text.includes('SLOW-STEER-3')) await inputGate.promise;
          return { action: 'continue' };
        });
      };
      let finished = nextEvent(runtime, 'finished');
      const agentId = await spawned({ prompt: 'FIRST PROMPT 3', extensionFactories: [slowInput] });
      await vi.waitFor(() => {
        expect(runtime.output(agentId)?.recentToolCalls).toHaveLength(1);
      });
      const steering = runtime.steer(agentId, 'SLOW-STEER-3 directive');
      expect(await finished).toMatchObject({ status: 'idle', summary: 'FIRST-DONE', undeliveredSteers: [] });

      finished = nextEvent(runtime, 'finished');
      const resuming = runtime.resume(agentId, 'RESUME PROMPT 3');
      inputGate.resolve();

      expect(await steering).toBe('idle');
      expect((await resuming).ok).toBe(true);
      expect(await finished).toMatchObject({ status: 'idle', summary: 'SECOND-DONE' });
      expect(seen).toEqual([['FIRST PROMPT 3', 'RESUME PROMPT 3']]);
    });

    it('reports handled when an extension input handler consumes the steer, and the model never sees it', async () => {
      const seen: string[][] = [];
      sandbox.faux.setResponses([
        fauxAssistantMessage(fauxToolCall('bash', { command: 'sleep 0.3' })),
        (context) => {
          seen.push(userTexts(context));
          return fauxAssistantMessage('DONE');
        },
      ]);
      const swallow: ExtensionFactory = (pi) => {
        pi.on('input', (event) => (event.text.includes('SWALLOW') ? { action: 'handled' } : { action: 'continue' }));
      };
      const finished = nextEvent(runtime, 'finished');
      const agentId = await spawned({ prompt: 'FIRST PROMPT 4', extensionFactories: [swallow] });
      await vi.waitFor(() => {
        expect(runtime.output(agentId)?.recentToolCalls).toHaveLength(1);
      });

      expect(await runtime.steer(agentId, 'SWALLOW this directive')).toBe('handled');
      expect(await runtime.steer(agentId, 'KEEP this directive')).toBe('steered');

      expect(await finished).toMatchObject({ status: 'idle', summary: 'DONE', undeliveredSteers: [] });
      expect(seen).toEqual([['FIRST PROMPT 4', 'KEEP this directive']]);
    });

    it('delivers steers that look like an extension command or a prompt template verbatim', async () => {
      mkdirSync(join(sandbox.agentDir, 'prompts'), { recursive: true });
      writeFileSync(join(sandbox.agentDir, 'prompts', 'review.md'), 'TEMPLATE BODY MUST NOT APPEAR');
      const seen: string[][] = [];
      sandbox.faux.setResponses([
        fauxAssistantMessage(fauxToolCall('bash', { command: 'sleep 0.3' })),
        fauxAssistantMessage('NEXT'),
        (context) => {
          seen.push(userTexts(context));
          return fauxAssistantMessage('DONE');
        },
      ]);
      const command: ExtensionFactory = (pi) => {
        pi.registerCommand('deploy', { description: 'deploy', handler: async () => undefined });
      };
      const finished = nextEvent(runtime, 'finished');
      const agentId = await spawned({ prompt: 'FIRST PROMPT 5', extensionFactories: [command] });
      await vi.waitFor(() => {
        expect(runtime.output(agentId)?.recentToolCalls).toHaveLength(1);
      });

      expect(await runtime.steer(agentId, '/deploy the branch now')).toBe('steered');
      expect(await runtime.steer(agentId, '/review the diff')).toBe('steered');

      expect(await finished).toMatchObject({ status: 'idle', summary: 'DONE', undeliveredSteers: [] });
      expect(seen).toEqual([['FIRST PROMPT 5', ' /deploy the branch now', ' /review the diff']]);
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

    it('aborts a run stopped synchronously after spawn, before pi started it: the tool never runs', async () => {
      sandbox.faux.setResponses([
        fauxAssistantMessage(fauxToolCall('bash', { command: 'echo RAN > ran.txt' })),
        fauxAssistantMessage('DONE'),
      ]);
      const agentId = started(await runtime.spawn(spec({ prompt: 'RUN THE TOOL' })));
      const streamingAtStop = sessions.get(agentId)?.isStreaming;
      const stopping = runtime.stop(agentId);

      expect(streamingAtStop).toBe(false);
      expect(await stopping).toBe('stopped');
      await vi.waitFor(() => {
        expect(runtime.limiter.snapshot().inflight).toBe(0);
      });
      await delay(300);
      expect(existsSync(join(sandbox.cwd, 'ran.txt'))).toBe(false);
      expect(sandbox.faux.state.callCount).toBeLessThanOrEqual(1);
      expect(events.map((event) => event.type)).toEqual(['started', 'finished']);
      expect(runtime.get(agentId)).toMatchObject({ status: 'stopped', stopReason: 'user', windingDown: false });
    });

    it('aborts a run whose prompt sat in a slow input handler when stopped, even after a forced finalize', async () => {
      const graceful = new TowerAgentRuntime({
        sessionFactory: capturingFactory(),
        limiter: new TowerRateLimiter(),
        stopGraceMs: 150,
      });
      try {
        sandbox.faux.setResponses([
          fauxAssistantMessage(fauxToolCall('bash', { command: 'echo RAN > ran-slow-input.txt' })),
          fauxAssistantMessage('DONE'),
        ]);
        const slowInput: ExtensionFactory = (pi) => {
          pi.on('input', async (event) => {
            if (event.text.includes('SLOW START')) await delay(600);
            return { action: 'continue' };
          });
        };
        const agentId = started(
          await graceful.spawn(spec({ prompt: 'SLOW START prompt', extensionFactories: [slowInput] })),
        );

        expect(await graceful.stop(agentId)).toBe('stopped');

        expect(graceful.limiter.snapshot().inflight).toBe(1);
        expect(graceful.activeAgentIds()).toEqual(new Set([agentId]));
        expect((await graceful.resume(agentId, 'continue')).ok).toBe(false);
        expect(graceful.get(agentId)).toMatchObject({ status: 'stopped', stopReason: 'user', windingDown: true });
        await delay(900);
        await vi.waitFor(
          () => {
            expect(graceful.limiter.snapshot().inflight).toBe(0);
          },
          { timeout: 5_000 },
        );
        await delay(300);
        expect(existsSync(join(sandbox.cwd, 'ran-slow-input.txt'))).toBe(false);
        expect(sandbox.faux.state.callCount).toBeLessThanOrEqual(1);
        expect(graceful.activeAgentIds()).toEqual(new Set());
        expect(graceful.get(agentId)?.windingDown).toBe(false);
      } finally {
        await graceful.disposeAll();
      }
    });

    it('refuses a resume until a force-finalized run settles in pi, and runs no untracked turn', async () => {
      const graceful = new TowerAgentRuntime({
        sessionFactory: capturingFactory(),
        limiter: new TowerRateLimiter(),
        stopGraceMs: 100,
      });
      try {
        const settling = deferred();
        const seen: string[][] = [];
        sandbox.faux.setResponses([
          fauxAssistantMessage('FIRST-DONE'),
          (context) => {
            seen.push(userTexts(context));
            return fauxAssistantMessage(fauxToolCall('bash', { command: 'echo RAN > ran-resumed.txt' }));
          },
          fauxAssistantMessage('SECOND-DONE'),
        ]);
        let slowed = false;
        const slowSettle: ExtensionFactory = (pi) => {
          pi.on('agent_settled', async () => {
            if (slowed) return;
            slowed = true;
            settling.resolve();
            await delay(800);
          });
        };
        const agentId = started(
          await graceful.spawn(spec({ prompt: 'FIRST PROMPT 6', extensionFactories: [slowSettle] })),
        );
        await settling.promise;

        expect(await graceful.stop(agentId)).toBe('stopped');
        expect(await graceful.resume(agentId, 'RESUME PROMPT 6')).toEqual({
          ok: false,
          reason: `tower agent "agent-alpha" (${agentId}) is still winding down its previous run — retry shortly`,
        });
        expect(graceful.limiter.snapshot().inflight).toBe(1);
        await vi.waitFor(
          () => {
            expect(graceful.get(agentId)?.windingDown).toBe(false);
          },
          { timeout: 5_000 },
        );
        await delay(200);
        expect(sandbox.faux.state.callCount).toBe(1);
        expect(existsSync(join(sandbox.cwd, 'ran-resumed.txt'))).toBe(false);
        expect(graceful.limiter.snapshot().inflight).toBe(0);

        const finished = nextEvent(graceful, 'finished');
        expect((await graceful.resume(agentId, 'RESUME PROMPT 6')).ok).toBe(true);
        expect(await finished).toMatchObject({ status: 'idle', summary: 'SECOND-DONE' });
        expect(seen).toEqual([['FIRST PROMPT 6', 'RESUME PROMPT 6']]);
        expect(existsSync(join(sandbox.cwd, 'ran-resumed.txt'))).toBe(true);
      } finally {
        await graceful.disposeAll();
      }
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
