import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TOWER_MODEL_FLAGS } from '../../src/config/index.ts';
import towerExtension from '../../src/index.ts';
import { MISSION_COMMAND, MISSION_COMMAND_ALIAS } from '../../src/mission/constants.ts';
import { TOWER_MODE_USER_ENABLED_ONLY, todoToolDenied } from '../../src/prompts/index.ts';
import {
  ACTIVITY_LOG,
  STATE_FILE,
  TOWER_ROOT,
  TowerStore,
  WORKTREES_DIR,
  type TowerState,
} from '../../src/protocol/index.ts';
import {
  TOWER_COMMAND,
  TOWER_MODE_ENTRY,
  TOWER_MODE_TOOLS,
  TOWER_REMINDER_MESSAGE,
  TOWER_STATUS_KEY,
} from '../../src/tower/constants.ts';
import { MissionContext } from '../mission/fakes.ts';
import { FakeContext, FakeSessionManager, commitFile, createRepo, git, removeDir } from './fakes.ts';

const EVENTS = [
  'session_start',
  'session_shutdown',
  'before_agent_start',
  'input',
  'tool_call',
  'tool_result',
  'after_provider_response',
  'message_end',
  'agent_settled',
  'model_select',
  'thinking_level_select',
];

const REGISTRATIONS = new Set(['registerTool', 'registerFlag', 'registerCommand', 'on']);

type Handler = (event: unknown, ctx: unknown) => unknown;

interface RecordedTool {
  readonly name: string;
  readonly description: string;
  readonly defaultActive?: boolean;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ): Promise<{ readonly content: readonly { readonly text: string }[]; readonly isError?: boolean }>;
}

interface RecordedCommand {
  readonly description?: string;
  getArgumentCompletions?(prefix: string): unknown;
  handler(args: string, ctx: unknown): Promise<void>;
}

class RecordingPi {
  readonly calls: string[] = [];
  readonly unexpected: string[] = [];
  readonly tools = new Map<string, RecordedTool>();
  readonly flags = new Map<string, unknown>();
  readonly commands = new Map<string, RecordedCommand>();
  readonly handlers = new Map<string, Handler[]>();
  readonly appended: { readonly customType: string; readonly data?: unknown }[] = [];
  activeTools: string[] = ['read', 'bash', 'edit', 'write'];

  registerTool(tool: RecordedTool): void {
    this.calls.push('registerTool');
    this.tools.set(tool.name, tool);
  }

  registerFlag(name: string, options: unknown): void {
    this.calls.push('registerFlag');
    this.flags.set(name, options);
  }

  registerCommand(name: string, options: RecordedCommand): void {
    this.calls.push('registerCommand');
    this.commands.set(name, options);
  }

  on(event: string, handler: Handler): void {
    this.calls.push('on');
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  getFlag(): undefined {
    this.calls.push('getFlag');
    return undefined;
  }

  getActiveTools(): string[] {
    this.calls.push('getActiveTools');
    return [...this.activeTools];
  }

  setActiveTools(names: string[]): void {
    this.calls.push('setActiveTools');
    this.activeTools = [...names];
  }

  appendEntry(customType: string, data?: unknown): void {
    this.calls.push('appendEntry');
    this.appended.push({ customType, data });
  }

  sendMessage(): void {
    this.calls.push('sendMessage');
  }

  sendUserMessage(): void {
    this.calls.push('sendUserMessage');
  }

  getThinkingLevel(): string {
    this.calls.push('getThinkingLevel');
    return 'medium';
  }

  setThinkingLevel(): void {
    this.calls.push('setThinkingLevel');
  }

  async setModel(): Promise<boolean> {
    this.calls.push('setModel');
    return true;
  }

  async emit(event: string, payload: unknown, ctx: unknown): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of this.handlers.get(event) ?? []) results.push(await handler(payload, ctx));
    return results;
  }

  tool(name: string): RecordedTool {
    const tool = this.tools.get(name);
    if (tool === undefined) throw new Error(`${name} is not registered`);
    return tool;
  }

  command(name: string): RecordedCommand {
    const command = this.commands.get(name);
    if (command === undefined) throw new Error(`/${name} is not registered`);
    return command;
  }

  get api(): ExtensionAPI {
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (typeof prop === 'string' && !(prop in target)) {
          target.unexpected.push(prop);
          return () => undefined;
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as unknown as ExtensionAPI;
  }
}

const cleanups: string[] = [];
let agentDir: string;

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'tower-index-agent-'));
  cleanups.push(agentDir);
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of cleanups.splice(0)) await removeDir(dir);
});

describe('tower extension factory', () => {
  it('only registers the tower tools, the model flags, the /tower and /mission commands and the event handlers', async () => {
    expect(getAgentDir()).toBe(agentDir);
    const pi = new RecordingPi();

    towerExtension(pi.api);

    expect([...pi.tools.keys()].sort()).toEqual([...TOWER_MODE_TOOLS].sort());
    for (const tool of pi.tools.values()) expect(tool.defaultActive).toBe(false);
    expect(pi.tools.has('TowerComplete')).toBe(false);
    expect([...pi.flags.keys()].sort()).toEqual(
      ['tower-orchestrator-model', 'tower-reviewer-model', 'tower-validator-model', 'tower-worker-model'],
    );
    expect(Object.values(TOWER_MODEL_FLAGS).sort()).toEqual([...pi.flags.keys()].sort());
    for (const flag of pi.flags.values()) expect(flag).toMatchObject({ type: 'string' });
    expect([...pi.commands.keys()]).toEqual([TOWER_COMMAND, MISSION_COMMAND, MISSION_COMMAND_ALIAS]);
    expect([...pi.handlers.keys()].sort()).toEqual([...EVENTS].sort());
    for (const handlers of pi.handlers.values()) expect(handlers).toHaveLength(1);

    expect(pi.calls.filter((call) => !REGISTRATIONS.has(call))).toEqual([]);
    expect(pi.unexpected).toEqual([]);
    expect(await readdir(agentDir)).toEqual([]);
  });

  it('wires the tools, the command and the handlers to one tower controller', async () => {
    const repo = await createRepo('tower-index-');
    cleanups.push(repo);
    const session = new FakeSessionManager('session-index');
    const ctx = new FakeContext(repo, session);
    ctx.model = ctx.modelRegistry.add('prov', 'session-model');
    const pi = new RecordingPi();
    towerExtension(pi.api);
    const tower = pi.commands.get(TOWER_COMMAND);
    if (tower === undefined) throw new Error('the tower command is not registered');

    await pi.emit('session_start', { type: 'session_start', reason: 'startup' }, ctx);
    expect(pi.tool('TowerSpawn').description).toContain(
      '- worker [worker default]: prov/session-model, thinking medium',
    );
    expect(pi.tool('TowerSpawn').defaultActive).toBe(false);

    const refused = await pi.tool('TowerInit').execute('call_init', {}, undefined, undefined, ctx);
    expect(refused).toMatchObject({ isError: true, content: [{ text: TOWER_MODE_USER_ENABLED_ONLY }] });

    await tower.handler('on', ctx);
    expect(ctx.ui.notices).toContainEqual({ message: 'Tower mode: ON', level: 'info' });
    expect(ctx.ui.statuses.get(TOWER_STATUS_KEY)).toBe('tower: on');
    for (const name of TOWER_MODE_TOOLS) expect(pi.activeTools).toContain(name);
    expect(pi.appended.at(-1)).toMatchObject({ customType: TOWER_MODE_ENTRY, data: { active: true, sessionId: 'session-index' } });

    const status = await pi.tool('TowerStatus').execute('call_status', {}, undefined, undefined, ctx);
    expect(status).toMatchObject({
      isError: true,
      content: [{ text: 'tower is not initialized in this repository — run TowerInit first' }],
    });

    const [injected] = await pi.emit(
      'before_agent_start',
      { type: 'before_agent_start', messageType: 'user', prompt: 'go', systemPrompt: '', systemPromptOptions: {} },
      ctx,
    );
    expect(injected).toMatchObject({ message: { customType: TOWER_REMINDER_MESSAGE, display: false } });

    const [veto] = await pi.emit(
      'tool_call',
      { type: 'tool_call', toolCallId: 'call_todo', toolName: 'todo_write', input: {} },
      ctx,
    );
    expect(veto).toEqual({ block: true, reason: todoToolDenied('todo_write') });

    expect(tower.getArgumentCompletions?.('mo')).toEqual([
      { value: 'models', label: 'models', description: 'Show or set the orchestrator, worker, reviewer and validator models' },
    ]);

    await tower.handler('models', ctx);
    const shown = ctx.ui.notices.at(-1)?.message ?? '';
    expect(shown).toMatch(/^Tower models\nrole\s+model\s+thinking\s+source/);
    expect(shown).toContain(`global config: ${join(agentDir, 'tower.json')} (not found)`);

    await tower.handler('off', ctx);
    expect(ctx.ui.notices).toContainEqual({ message: 'Tower mode: OFF', level: 'info' });
    for (const name of TOWER_MODE_TOOLS) expect(pi.activeTools).toContain(name);

    await pi.emit('session_shutdown', { type: 'session_shutdown' }, ctx);
    expect(pi.unexpected).toEqual([]);
  });

  it('hands the objective commands the configured settings and an autopilot tick', async () => {
    const repo = await createRepo('tower-index-objective-');
    cleanups.push(repo);
    await writeFile(
      join(agentDir, 'tower.json'),
      `${JSON.stringify({ objective: { autopilot: false, maxValidationRounds: 5 } })}\n`,
    );
    const store = new TowerStore(repo);
    await store.init('session-index', 'main');
    await store.draftObjective({ title: 'Ship', goal: 'ship it', definitionOfDone: ['works'], milestones: [{ title: 'Core' }] });
    await store.plan([{ title: 'Core feature', scope: ['src/core/**'], milestone: 'MS1' }]);
    await store.requestObjectiveApproval();
    const ctx = new FakeContext(repo, new FakeSessionManager('session-index'));
    ctx.model = ctx.modelRegistry.add('prov', 'session-model');
    const pi = new RecordingPi();
    towerExtension(pi.api);
    const tower = pi.commands.get(TOWER_COMMAND);
    if (tower === undefined) throw new Error('the tower command is not registered');
    await pi.emit('session_start', { type: 'session_start', reason: 'startup' }, ctx);
    await tower.handler('on', ctx);

    await tower.handler('approve', ctx);

    await vi.waitFor(async () => {
      expect((await store.load()).objective?.autopilot?.progressKey).toBeDefined();
    });
    expect((await store.load()).objective).toMatchObject({
      status: 'executing',
      approvedBy: 'human',
      limits: { maxValidationRounds: 3 },
    });
    await tower.handler('pause checking the plan', ctx);
    await tower.handler('resume', ctx);
    expect((await store.load()).objective).toMatchObject({ status: 'executing', limits: { maxValidationRounds: 5 } });

    await pi.emit('session_shutdown', { type: 'session_shutdown' }, ctx);
    expect(pi.unexpected).toEqual([]);
  });
});

describe('a repository nested under a tower worktree', () => {
  const OUTER_SESSION = 'session-outer';
  const NESTED_SESSION = 'session-nested';

  interface NestedSetup {
    readonly outer: string;
    readonly nested: string;
    readonly ctx: MissionContext;
    readonly pi: RecordingPi;
    readonly storeRoots: Set<string>;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function nestedUnderWorktree(outerOwnerPid?: number): Promise<NestedSetup> {
    const outer = await createRepo('tower-index-outer-');
    cleanups.push(outer);
    const store = new TowerStore(outer);
    await store.init(OUTER_SESSION, 'main');
    for (const name of ['agent-mission-e2e', 'agent-mission-docs']) {
      await store.registerAgent({
        name,
        agentId: `${name}-id`,
        sessionId: OUTER_SESSION,
        kind: 'worker',
        spawnedAt: new Date().toISOString(),
      });
    }
    if (outerOwnerPid !== undefined) {
      const state = JSON.parse(await readFile(join(outer, STATE_FILE), 'utf8')) as TowerState;
      await writeFile(join(outer, STATE_FILE), `${JSON.stringify({ ...state, ownerPid: outerOwnerPid }, null, 2)}\n`);
    }
    const worktree = join(outer, WORKTREES_DIR, 'wt-x');
    await git(outer, 'worktree', 'add', '-q', '-b', 'feat/x', worktree);
    const nested = join(worktree, 'tmp', 'repo');
    await mkdir(nested, { recursive: true });
    await git(nested, 'init', '-q', '-b', 'main');
    await git(nested, 'config', 'user.email', 'tower-test@example.com');
    await git(nested, 'config', 'user.name', 'Tower Test');
    await commitFile(nested, 'README.md', '# nested\n', 'initial');

    const ctx = new MissionContext(nested, new FakeSessionManager(NESTED_SESSION));
    ctx.model = ctx.modelRegistry.add('prov', 'session-model');
    const pi = new RecordingPi();
    towerExtension(pi.api);
    return { outer, nested, ctx, pi, storeRoots: recordStoreRoots() };
  }

  function recordStoreRoots(): Set<string> {
    const roots = new Set<string>();
    const load = TowerStore.prototype.load;
    const isInitialized = TowerStore.prototype.isInitialized;
    vi.spyOn(TowerStore.prototype, 'load').mockImplementation(function (this: TowerStore) {
      roots.add(this.repoRoot);
      return load.call(this);
    });
    vi.spyOn(TowerStore.prototype, 'isInitialized').mockImplementation(function (this: TowerStore) {
      roots.add(this.repoRoot);
      return isInitialized.call(this);
    });
    return roots;
  }

  async function towerFiles(repo: string): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (path === join(repo, WORKTREES_DIR)) continue;
        if (entry.isDirectory()) await walk(path);
        else files[relative(repo, path)] = await readFile(path, 'utf8');
      }
    };
    await walk(join(repo, TOWER_ROOT));
    return files;
  }

  async function liveOuterFiles(outer: string): Promise<Record<string, string>> {
    const files = await towerFiles(outer);
    expect(JSON.parse(files[STATE_FILE] ?? '{}')).toMatchObject({
      sessionId: OUTER_SESSION,
      roster: { agents: [{ name: 'agent-mission-e2e' }, { name: 'agent-mission-docs' }] },
    });
    expect(files[ACTIVITY_LOG]).toContain('tower init');
    return files;
  }

  it('/mission and /mission exit set up and release its own workspace and leave the outer one untouched', async () => {
    const { outer, nested, ctx, pi, storeRoots } = await nestedUnderWorktree();
    const outerFiles = await liveOuterFiles(outer);

    await pi.emit('session_start', { type: 'session_start', reason: 'startup' }, ctx);
    await pi.command(MISSION_COMMAND).handler('', ctx);

    expect(ctx.ui.notices.at(-1)?.message).toMatch(/^Mission mode\n/);
    expect(ctx.ui.notices.at(-1)?.message).toContain('(tower workspace initialized now)');
    expect(await new TowerStore(nested).load()).toMatchObject({ sessionId: NESTED_SESSION, roster: { agents: [] } });

    await pi.command(MISSION_COMMAND).handler('exit', ctx);
    await pi.emit('session_shutdown', { type: 'session_shutdown' }, ctx);

    expect((await new TowerStore(nested).load()).sessionId).toBeUndefined();
    expect(await towerFiles(outer)).toEqual(outerFiles);
    expect([...storeRoots]).toEqual([nested]);
  });

  it('/tower on, /tower main and /tower off keep to its own workspace while a live session owns the outer one', async () => {
    const { outer, nested, ctx, pi, storeRoots } = await nestedUnderWorktree(process.ppid);
    const outerFiles = await liveOuterFiles(outer);
    expect(JSON.parse(outerFiles[STATE_FILE] ?? '{}')).toMatchObject({ ownerPid: process.ppid });
    const tower = pi.command(TOWER_COMMAND);

    await pi.emit('session_start', { type: 'session_start', reason: 'startup' }, ctx);
    await tower.handler('on', ctx);
    expect(ctx.ui.notices).toContainEqual({ message: 'Tower mode: ON', level: 'info' });
    expect(await new TowerStore(nested).isInitialized()).toBe(false);

    await tower.handler('main', ctx);
    expect(ctx.ui.notices).toContainEqual({ message: 'Tower base: main', level: 'info' });
    expect(await new TowerStore(nested).load()).toMatchObject({
      base: 'main',
      sessionId: NESTED_SESSION,
      roster: { agents: [] },
    });

    await tower.handler('off', ctx);
    await pi.emit('session_shutdown', { type: 'session_shutdown' }, ctx);

    expect((await new TowerStore(nested).load()).sessionId).toBeUndefined();
    expect(await towerFiles(outer)).toEqual(outerFiles);
    expect([...storeRoots]).toEqual([nested]);
  });
});
