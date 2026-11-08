import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { TowerStore, type TowerAgentKind } from '../../src/protocol/index.ts';
import type {
  TowerInboxSentPayload,
  TowerLaunchRequest,
  TowerOwner,
  TowerSpawnModelResolution,
  TowerToolHost,
} from '../../src/tools/support.ts';
import type { TowerExtensionApi } from '../../src/tower/controller.ts';
import { BranchLeases } from '../../src/tower/leases.ts';
import type {
  TowerAgentEndStatus,
  TowerAgentEvent,
  TowerAgentEventListener,
  TowerAgentInfo,
  TowerAgentOutput,
  TowerAgentSpec,
  TowerAgentUsage,
  TowerRateLimitSnapshot,
  TowerRunStartResult,
  TowerRuntime,
  TowerSteerResult,
  TowerStopResult,
  TowerThinkingLevel,
  TowerToolCallRecord,
} from '../../src/tower/runtimeTypes.ts';

const execFileAsync = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

export async function commitFile(
  cwd: string,
  rel: string,
  content: string,
  message: string,
): Promise<void> {
  const abs = join(cwd, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
  await git(cwd, 'add', rel);
  await git(cwd, 'commit', '-m', message);
}

export async function createRepo(prefix = 'pi-tower-test-'): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'tower-test@example.com');
  await git(repo, 'config', 'user.name', 'Tower Test');
  await commitFile(repo, 'README.md', '# fixture\n', 'initial');
  return repo;
}

export async function removeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

const ZERO_USAGE: TowerAgentUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: 0,
};

interface FakeAgentRecord {
  agentId: string;
  taskId: string;
  name: string;
  kind?: string;
  description?: string;
  cwd: string;
  model?: string;
  thinkingLevel?: TowerThinkingLevel;
  sessionId: string;
  status: TowerAgentInfo['status'];
  windingDown: boolean;
  runs: number;
  createdAt: number;
  startedAt: number;
  endedAt?: number;
  lastAssistantText?: string;
  stopReason?: string;
  taskIds: string[];
  recentToolCalls: TowerToolCallRecord[];
  prompts: string[];
}

export interface FakeFinishOptions {
  readonly stopReason?: string;
  readonly summary?: string;
  readonly undeliveredSteers?: readonly string[];
  readonly windingDown?: boolean;
}

export class FakeRuntime implements TowerRuntime {
  snapshotValue: TowerRateLimitSnapshot = { budget: 2, inflight: 0, blockedUntil: null };
  rateLimited = 0;
  successes = 0;
  readonly limiter = {
    snapshot: (): TowerRateLimitSnapshot => this.snapshotValue,
    reportRateLimited: (): void => {
      this.rateLimited += 1;
    },
    reportSuccess: (): void => {
      this.successes += 1;
    },
  };
  readonly specs: TowerAgentSpec[] = [];
  readonly steers: { readonly id: string; readonly text: string }[] = [];
  readonly stops: { readonly id: string; readonly reason: string }[] = [];
  readonly disposed: string[] = [];
  readonly resumes: { readonly id: string; readonly prompt: string }[] = [];
  gate: { readonly ok: false; readonly reason: string } | undefined;
  failSpawn: string | undefined;
  resumeRefusal: string | undefined;
  steerResult: TowerSteerResult | undefined;
  finishOnSpawn: { readonly status: TowerAgentEndStatus; readonly stopReason?: string } | undefined;
  disposedAll: string | undefined;
  now: () => number = () => Date.now();
  private readonly agents = new Map<string, FakeAgentRecord>();
  private readonly listeners = new Set<TowerAgentEventListener>();
  private counter = 0;

  onEvent(listener: TowerAgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async spawn(spec: TowerAgentSpec): Promise<TowerRunStartResult> {
    this.specs.push(spec);
    if (this.gate !== undefined) return this.gate;
    if (this.failSpawn !== undefined) {
      return { ok: false, reason: `tower spawn failed: ${this.failSpawn}` };
    }
    this.counter += 1;
    const agentId = `agent-${String(this.counter)}`;
    const taskId = `task-${String(this.counter)}`;
    const at = this.now();
    const record: FakeAgentRecord = {
      agentId,
      taskId,
      name: spec.name,
      ...(spec.kind === undefined ? {} : { kind: spec.kind }),
      ...(spec.description === undefined ? {} : { description: spec.description }),
      cwd: spec.cwd,
      model:
        spec.model === undefined
          ? 'fake/default-model'
          : typeof spec.model === 'string'
            ? spec.model
            : `${spec.model.provider}/${spec.model.id}`,
      thinkingLevel: spec.thinkingLevel ?? 'medium',
      sessionId: `pi-session-${agentId}`,
      status: 'running',
      windingDown: false,
      runs: 1,
      createdAt: at,
      startedAt: at,
      taskIds: [taskId],
      recentToolCalls: [],
      prompts: [spec.prompt],
    };
    this.agents.set(agentId, record);
    this.emit({ type: 'started', agentId, taskId, name: spec.name, resumed: false, at });
    if (this.finishOnSpawn !== undefined) {
      this.finish(agentId, this.finishOnSpawn.status, {
        ...(this.finishOnSpawn.stopReason === undefined
          ? {}
          : { stopReason: this.finishOnSpawn.stopReason }),
      });
    }
    return { ok: true, agentId, taskId };
  }

  finish(id: string, status: TowerAgentEndStatus = 'idle', options: FakeFinishOptions = {}): void {
    const record = this.lookup(id);
    if (record === undefined) throw new Error(`no fake agent ${id}`);
    record.status = status;
    record.windingDown = options.windingDown ?? false;
    record.endedAt = this.now();
    if (options.stopReason === undefined) delete record.stopReason;
    else record.stopReason = options.stopReason;
    if (options.summary !== undefined) record.lastAssistantText = options.summary;
    this.emit({
      type: 'finished',
      agentId: record.agentId,
      taskId: record.taskId,
      name: record.name,
      status,
      ...(options.summary === undefined ? {} : { summary: options.summary }),
      ...(options.stopReason === undefined ? {} : { stopReason: options.stopReason }),
      undeliveredSteers: options.undeliveredSteers ?? [],
      usage: ZERO_USAGE,
      at: record.endedAt,
    });
  }

  settle(id: string): void {
    const record = this.lookup(id);
    if (record !== undefined) record.windingDown = false;
  }

  addToolCall(id: string, call: TowerToolCallRecord): void {
    this.lookup(id)?.recentToolCalls.push(call);
  }

  promptsOf(id: string): readonly string[] {
    return this.lookup(id)?.prompts ?? [];
  }

  async resume(id: string, prompt: string): Promise<TowerRunStartResult> {
    this.resumes.push({ id, prompt });
    const record = this.lookup(id);
    if (record === undefined) return { ok: false, reason: `unknown tower agent "${id}"` };
    if (record.status === 'running') {
      return { ok: false, reason: `tower agent "${record.name}" is still running` };
    }
    if (record.windingDown) {
      return {
        ok: false,
        reason: `tower agent "${record.name}" (${record.agentId}) is still winding down its previous run — retry shortly`,
      };
    }
    if (this.resumeRefusal !== undefined) return { ok: false, reason: this.resumeRefusal };
    this.counter += 1;
    record.taskId = `task-${String(this.counter)}`;
    record.taskIds.push(record.taskId);
    record.status = 'running';
    record.runs += 1;
    record.startedAt = this.now();
    delete record.endedAt;
    delete record.stopReason;
    record.prompts.push(prompt);
    this.emit({
      type: 'started',
      agentId: record.agentId,
      taskId: record.taskId,
      name: record.name,
      resumed: true,
      at: record.startedAt,
    });
    return { ok: true, agentId: record.agentId, taskId: record.taskId };
  }

  async steer(id: string, text: string): Promise<TowerSteerResult> {
    const record = this.lookup(id);
    if (record === undefined) return 'missing';
    if (this.steerResult !== undefined) return this.steerResult;
    if (record.status !== 'running') return 'idle';
    this.steers.push({ id: record.agentId, text });
    return 'steered';
  }

  async stop(id: string, reason = 'user'): Promise<TowerStopResult> {
    const record = this.lookup(id);
    if (record === undefined) return 'missing';
    if (record.status !== 'running') return 'idle';
    this.stops.push({ id: record.agentId, reason });
    this.finish(record.agentId, 'stopped', { stopReason: reason });
    return 'stopped';
  }

  get(id: string): TowerAgentInfo | undefined {
    const record = this.lookup(id);
    return record === undefined ? undefined : this.describe(record);
  }

  output(id: string): TowerAgentOutput | undefined {
    const record = this.lookup(id);
    return record === undefined
      ? undefined
      : { ...this.describe(record), recentToolCalls: [...record.recentToolCalls] };
  }

  list(activeOnly = false): TowerAgentInfo[] {
    return [...this.agents.values()]
      .filter((record) => !activeOnly || record.status === 'running' || record.windingDown)
      .map((record) => this.describe(record));
  }

  activeAgentIds(): ReadonlySet<string> {
    return new Set(
      [...this.agents.values()]
        .filter((record) => record.status === 'running' || record.windingDown)
        .map((record) => record.agentId),
    );
  }

  async dispose(id: string): Promise<boolean> {
    const record = this.lookup(id);
    if (record === undefined) return false;
    this.disposed.push(record.agentId);
    this.agents.delete(record.agentId);
    return true;
  }

  async disposeAll(reason = 'shutdown'): Promise<void> {
    this.disposedAll = reason;
    for (const record of [...this.agents.values()]) {
      if (record.status === 'running') this.finish(record.agentId, 'stopped', { stopReason: reason });
    }
    this.agents.clear();
  }

  private lookup(id: string): FakeAgentRecord | undefined {
    const direct = this.agents.get(id);
    if (direct !== undefined) return direct;
    return [...this.agents.values()].find((record) => record.taskIds.includes(id));
  }

  private describe(record: FakeAgentRecord): TowerAgentInfo {
    return {
      agentId: record.agentId,
      taskId: record.taskId,
      name: record.name,
      ...(record.kind === undefined ? {} : { kind: record.kind }),
      ...(record.description === undefined ? {} : { description: record.description }),
      cwd: record.cwd,
      ...(record.model === undefined ? {} : { model: record.model }),
      ...(record.thinkingLevel === undefined ? {} : { thinkingLevel: record.thinkingLevel }),
      sessionId: record.sessionId,
      status: record.status,
      windingDown: record.windingDown,
      runs: record.runs,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
      ...(record.lastAssistantText === undefined
        ? {}
        : { lastAssistantText: record.lastAssistantText }),
      ...(record.stopReason === undefined ? {} : { stopReason: record.stopReason }),
      usage: ZERO_USAGE,
    };
  }

  private emit(event: TowerAgentEvent): void {
    for (const listener of [...this.listeners]) void listener(event);
  }
}

export class TestHost implements TowerToolHost {
  active = true;
  sessionId = 'session-test';
  readonly liveOwners = new Set<string>();
  readonly leases = new BranchLeases();
  readonly runtime = new FakeRuntime();
  readonly published: TowerInboxSentPayload[] = [];
  readonly launches: TowerLaunchRequest[] = [];
  readonly aborted: string[] = [];
  readonly registered: string[] = [];
  readonly retired = new Set<string>();
  spawnModel: TowerSpawnModelResolution = { ok: true };
  publishFailure: Error | undefined;
  private readonly repo: string;

  constructor(repo: string) {
    this.repo = repo;
  }

  get isActive(): boolean {
    return this.active;
  }

  store(): TowerStore {
    return new TowerStore(this.repo);
  }

  isOwnerLive(owner: TowerOwner): boolean {
    return owner.sessionId !== undefined && this.liveOwners.has(owner.sessionId);
  }

  noteRetiredAgents(names: readonly string[]): void {
    for (const name of names) this.retired.add(name);
  }

  isRetiredAgent(name: string): boolean {
    return this.retired.has(name);
  }

  isBranchLeased(branch: string): boolean {
    return this.leases.isLeased(branch);
  }

  withBranchLease<T>(branch: string, execute: () => Promise<T>): Promise<T> {
    return this.leases.withLease(branch, execute);
  }

  activeAgentIds(): ReadonlySet<string> {
    return this.runtime.activeAgentIds();
  }

  rateLimitSnapshot(): TowerRateLimitSnapshot {
    return this.runtime.limiter.snapshot();
  }

  publishInboxSent(event: TowerInboxSentPayload): void {
    if (this.publishFailure !== undefined) {
      const failure = this.publishFailure;
      this.publishFailure = undefined;
      throw failure;
    }
    this.published.push(event);
  }

  steerAgent(agentId: string, text: string): Promise<TowerSteerResult> {
    return this.runtime.steer(agentId, text);
  }

  async resolveSpawnModel(
    _kind: TowerAgentKind,
    _choice: string | undefined,
  ): Promise<TowerSpawnModelResolution> {
    return this.spawnModel;
  }

  launchAgent(request: TowerLaunchRequest): Promise<TowerRunStartResult> {
    this.launches.push(request);
    return this.runtime.spawn({
      name: request.name,
      kind: request.kind,
      description: request.description,
      cwd: request.cwd,
      prompt: request.prompt,
      ...(request.binding === undefined ? {} : { model: request.binding.model }),
      ...(request.binding?.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: request.binding.thinkingLevel }),
    });
  }

  agentRegistered(agentId: string): void {
    this.registered.push(agentId);
  }

  async abortAgent(agentId: string): Promise<void> {
    this.aborted.push(agentId);
    await this.runtime.stop(agentId, 'tower spawn aborted');
    await this.runtime.dispose(agentId);
  }

  agentInfo(id: string): TowerAgentInfo | undefined {
    return this.runtime.get(id);
  }

  agentOutput(id: string): TowerAgentOutput | undefined {
    return this.runtime.output(id);
  }

  listAgents(activeOnly: boolean): readonly TowerAgentInfo[] {
    return this.runtime.list(activeOnly);
  }

  resumeAgent(agentId: string, prompt: string): Promise<TowerRunStartResult> {
    return this.runtime.resume(agentId, prompt);
  }

  stopAgent(id: string, reason: string): Promise<TowerStopResult> {
    return this.runtime.stop(id, reason);
  }
}

export interface FakeEntry {
  readonly type: string;
  readonly id: string;
  readonly customType?: string;
  readonly data?: unknown;
  readonly content?: unknown;
  readonly display?: boolean;
  readonly details?: unknown;
  readonly message?: { readonly role: string; readonly content?: unknown };
}

export class FakeSessionManager {
  sessionId: string;
  entries: FakeEntry[] = [];
  contextStart = 0;
  private counter = 0;

  constructor(sessionId: string, entries: FakeEntry[] = []) {
    this.sessionId = sessionId;
    this.entries = entries;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getBranch(): FakeEntry[] {
    return [...this.entries];
  }

  getEntries(): FakeEntry[] {
    return [...this.entries];
  }

  buildContextEntries(): FakeEntry[] {
    return this.entries.slice(this.contextStart);
  }

  append(entry: Omit<FakeEntry, 'id'>): void {
    this.counter += 1;
    this.entries.push({ ...entry, id: `entry-${String(this.counter)}` });
  }

  appendMessage(role: string, text = ''): void {
    this.append({ type: 'message', message: { role, content: text } });
  }

  compact(): void {
    this.append({ type: 'compaction' });
    this.contextStart = this.entries.length - 1;
  }
}

export interface FakeUi {
  readonly notices: { readonly message: string; readonly level?: string }[];
  readonly statuses: Map<string, string | undefined>;
}

export interface FakeModel {
  readonly provider: string;
  readonly id: string;
}

export class FakeModelRegistry {
  private readonly models = new Map<string, FakeModel>();
  private readonly credentials = new Set<string>();

  add(provider: string, id: string, options: { readonly auth?: boolean } = {}): FakeModel {
    const model: FakeModel = { provider, id };
    this.models.set(`${provider}/${id}`, model);
    if (options.auth !== false) this.credentials.add(`${provider}/${id}`);
    return model;
  }

  find(provider: string, modelId: string): FakeModel | undefined {
    return this.models.get(`${provider}/${modelId}`);
  }

  hasConfiguredAuth(model: FakeModel): boolean {
    return this.credentials.has(`${model.provider}/${model.id}`);
  }
}

export class FakeContext {
  cwd: string;
  idle = true;
  hasUI = true;
  mode: 'tui' | 'rpc' | 'print' | 'json' = 'tui';
  trusted = true;
  confirmAnswer = true;
  readonly confirms: { readonly title: string; readonly message: string }[] = [];
  model: FakeModel | undefined;
  readonly modelRegistry = new FakeModelRegistry();
  readonly sessionManager: FakeSessionManager;
  readonly ui: FakeUi & {
    notify(message: string, level?: string): void;
    setStatus(key: string, text: string | undefined): void;
    confirm(title: string, message: string): Promise<boolean>;
  };

  constructor(cwd: string, sessionManager: FakeSessionManager) {
    this.cwd = cwd;
    this.sessionManager = sessionManager;
    const notices: { message: string; level?: string }[] = [];
    const statuses = new Map<string, string | undefined>();
    this.ui = {
      notices,
      statuses,
      confirm: async (title: string, message: string): Promise<boolean> => {
        this.confirms.push({ title, message });
        return this.confirmAnswer;
      },
      notify(message: string, level?: string): void {
        notices.push(level === undefined ? { message } : { message, level });
      },
      setStatus(key: string, text: string | undefined): void {
        statuses.set(key, text);
      },
    };
  }

  isIdle(): boolean {
    return this.idle;
  }

  isProjectTrusted(): boolean {
    return this.trusted;
  }

  get asContext(): ExtensionContext {
    return this as unknown as ExtensionContext;
  }

  get asCommandContext(): ExtensionCommandContext {
    return this as unknown as ExtensionCommandContext;
  }
}

export interface SentMessage {
  readonly message: {
    readonly customType: string;
    readonly content: unknown;
    readonly display: boolean;
    readonly details?: unknown;
  };
  readonly options?: { readonly triggerTurn?: boolean; readonly deliverAs?: string };
}

export class FakePi implements TowerExtensionApi {
  activeTools: string[] = ['read', 'bash', 'edit', 'write'];
  readonly sent: SentMessage[] = [];
  readonly userMessages: { readonly text: unknown; readonly options?: unknown }[] = [];
  readonly appended: { readonly customType: string; readonly data?: unknown }[] = [];
  readonly registeredTools = new Map<string, unknown>();
  readonly flags = new Map<string, string | boolean>();
  readonly modelChanges: unknown[] = [];
  thinkingLevel = 'medium';
  setModelResult = true;
  session: FakeSessionManager | undefined;
  context: FakeContext | undefined;
  sendFailure: Error | undefined;

  appendEntry: TowerExtensionApi['appendEntry'] = (customType, data) => {
    this.appended.push({ customType, data });
    this.session?.append({ type: 'custom', customType, data });
  };

  getActiveTools: TowerExtensionApi['getActiveTools'] = () => [...this.activeTools];

  setActiveTools: TowerExtensionApi['setActiveTools'] = (names) => {
    this.activeTools = [...names];
  };

  getFlag: TowerExtensionApi['getFlag'] = (name) => this.flags.get(name);

  getThinkingLevel: TowerExtensionApi['getThinkingLevel'] = () =>
    this.thinkingLevel as ReturnType<TowerExtensionApi['getThinkingLevel']>;

  setThinkingLevel: TowerExtensionApi['setThinkingLevel'] = (level) => {
    this.thinkingLevel = level;
  };

  setModel: TowerExtensionApi['setModel'] = async (model) => {
    this.modelChanges.push(model);
    if (!this.setModelResult) return false;
    if (this.context !== undefined) this.context.model = model;
    return true;
  };

  registerTool: TowerExtensionApi['registerTool'] = (tool) => {
    this.registeredTools.set(tool.name, tool);
  };

  sendMessage: TowerExtensionApi['sendMessage'] = (message, options) => {
    if (this.sendFailure !== undefined) {
      const failure = this.sendFailure;
      this.sendFailure = undefined;
      throw failure;
    }
    this.sent.push({
      message: message as SentMessage['message'],
      ...(options === undefined ? {} : { options }),
    });
    this.session?.append({
      type: 'custom_message',
      customType: message.customType,
      content: message.content,
      display: message.display,
      details: message.details,
    });
  };

  sendUserMessage: TowerExtensionApi['sendUserMessage'] = (text, options) => {
    this.userMessages.push(options === undefined ? { text } : { text, options });
  };

  sentOfType(customType: string): SentMessage[] {
    return this.sent.filter((entry) => entry.message.customType === customType);
  }
}

export function sentText(entry: SentMessage | undefined): string {
  const content = entry?.message.content;
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

export async function settle(times = 5): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}
