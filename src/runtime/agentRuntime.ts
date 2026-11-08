import { randomUUID } from 'node:crypto';

import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

import { isRateLimitError, TowerRateLimiter } from './rateLimit.ts';
import type {
  TowerAgentEndStatus,
  TowerAgentEvent,
  TowerAgentEventListener,
  TowerAgentInfo,
  TowerAgentOutput,
  TowerAgentSession,
  TowerAgentSessionFactory,
  TowerAgentSpec,
  TowerAgentStatus,
  TowerRunStartResult,
  TowerSteerResult,
  TowerStopResult,
} from './types.ts';

export const TOWER_AGENT_STOP_GRACE_MS = 10_000;
export const TOWER_AGENT_RECENT_TOOL_CALLS = 20;

const TOOL_ARGS_PREVIEW_MAX = 200;
const ID_ATTEMPTS = 100;
const RUNTIME_SHUT_DOWN = 'the tower agent runtime is shut down — no agent was started';

export interface TowerAgentRuntimeOptions {
  readonly sessionFactory: TowerAgentSessionFactory;
  readonly limiter?: TowerRateLimiter;
  readonly timeoutMs?: number;
  readonly stopGraceMs?: number;
  readonly now?: () => number;
  readonly createId?: (prefix: 'agent' | 'task') => string;
  readonly onListenerError?: (error: unknown, event: TowerAgentEvent) => void;
}

interface MutableUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

interface StopRequest {
  readonly status: 'stopped' | 'timed_out';
  readonly reason: string;
}

interface ToolCallState {
  readonly toolCallId: string;
  readonly name: string;
  readonly args: string;
  readonly startedAt: number;
  endedAt?: number;
  isError?: boolean;
}

interface AgentRun {
  readonly taskId: string;
  readonly startedAt: number;
  readonly usage: MutableUsage;
  readonly done: Promise<void>;
  readonly resolveDone: () => void;
  stopRequest?: StopRequest;
  lastText?: string;
  lastError?: string;
  settled: boolean;
  abortedBySession: boolean;
  finished: boolean;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  graceTimer?: ReturnType<typeof setTimeout>;
}

interface AgentRecord {
  readonly agentId: string;
  readonly spec: TowerAgentSpec;
  readonly session: TowerAgentSession;
  readonly createdAt: number;
  readonly taskIds: string[];
  readonly usage: MutableUsage;
  readonly toolCalls: ToolCallState[];
  unsubscribe: () => void;
  run: AgentRun;
  status: TowerAgentStatus;
  lastAssistantText?: string;
  stopReason?: string;
  streaming?: AssistantMessage;
  endedAt?: number;
  disposed: boolean;
}

interface AgentLookup {
  readonly record: AgentRecord;
  readonly taskId?: string;
}

interface RunOutcome {
  readonly status: TowerAgentEndStatus;
  readonly stopReason?: string;
}

export class TowerAgentRuntime {
  readonly limiter: TowerRateLimiter;
  private readonly sessionFactory: TowerAgentSessionFactory;
  private readonly timeoutMs: number | undefined;
  private readonly stopGraceMs: number;
  private readonly now: () => number;
  private readonly createId: (prefix: 'agent' | 'task') => string;
  private readonly onListenerError: ((error: unknown, event: TowerAgentEvent) => void) | undefined;
  private readonly agents = new Map<string, AgentRecord>();
  private readonly taskOwners = new Map<string, string>();
  private readonly pendingAgentIds = new Set<string>();
  private readonly listeners = new Set<TowerAgentEventListener>();
  private disposed = false;

  constructor(options: TowerAgentRuntimeOptions) {
    if (options.timeoutMs !== undefined && !isPositiveDuration(options.timeoutMs)) {
      throw new RangeError('tower agent timeoutMs must be a positive number of milliseconds');
    }
    if (options.stopGraceMs !== undefined && !isPositiveDuration(options.stopGraceMs)) {
      throw new RangeError('tower agent stopGraceMs must be a positive number of milliseconds');
    }
    this.sessionFactory = options.sessionFactory;
    this.now = options.now ?? (() => Date.now());
    this.limiter = options.limiter ?? new TowerRateLimiter({ now: this.now });
    this.timeoutMs = options.timeoutMs;
    this.stopGraceMs = options.stopGraceMs ?? TOWER_AGENT_STOP_GRACE_MS;
    this.createId = options.createId ?? randomId;
    this.onListenerError = options.onListenerError;
  }

  onEvent(listener: TowerAgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async spawn(spec: TowerAgentSpec): Promise<TowerRunStartResult> {
    if (this.disposed) return { ok: false, reason: RUNTIME_SHUT_DOWN };
    const problem = specProblem(spec);
    if (problem !== undefined) return { ok: false, reason: problem };
    const gate = this.limiter.acquire();
    if (!gate.ok) return gate;
    const agentId = this.nextId('agent');
    this.pendingAgentIds.add(agentId);
    let session: TowerAgentSession;
    try {
      session = await this.sessionFactory({ agentId, spec });
    } catch (error) {
      this.limiter.release();
      return { ok: false, reason: `tower spawn failed: ${errorMessage(error)}` };
    } finally {
      this.pendingAgentIds.delete(agentId);
    }
    if (this.disposed) {
      this.limiter.release();
      await settle(() => session.dispose());
      return { ok: false, reason: RUNTIME_SHUT_DOWN };
    }
    const run = this.newRun();
    const record: AgentRecord = {
      agentId,
      spec,
      session,
      createdAt: run.startedAt,
      taskIds: [],
      usage: emptyUsage(),
      toolCalls: [],
      unsubscribe: () => undefined,
      run,
      status: 'running',
      disposed: false,
    };
    this.agents.set(agentId, record);
    record.unsubscribe = session.subscribe((event) => {
      this.onSessionEvent(record, event);
    });
    this.launch(record, run, spec.prompt, false);
    return { ok: true, agentId, taskId: run.taskId };
  }

  async resume(id: string, prompt: string): Promise<TowerRunStartResult> {
    if (this.disposed) return { ok: false, reason: RUNTIME_SHUT_DOWN };
    const found = this.lookup(id);
    if (found === undefined) return { ok: false, reason: `unknown tower agent "${id}"` };
    const { record } = found;
    if (record.status === 'running') {
      return {
        ok: false,
        reason: `tower agent ${describeAgent(record)} is still running task ${record.run.taskId} — steer it or stop it instead of resuming`,
      };
    }
    if (record.session.isStreaming) {
      return {
        ok: false,
        reason: `tower agent ${describeAgent(record)} is still winding down its previous run — retry shortly`,
      };
    }
    if (prompt.trim().length === 0) return { ok: false, reason: 'resume prompt must not be empty' };
    const gate = this.limiter.acquire();
    if (!gate.ok) return gate;
    const run = this.newRun();
    this.launch(record, run, prompt, true);
    return { ok: true, agentId: record.agentId, taskId: run.taskId };
  }

  async steer(id: string, text: string): Promise<TowerSteerResult> {
    const found = this.lookup(id);
    if (found === undefined) return 'missing';
    const run = activeRun(found);
    if (run === undefined || run.settled || run.stopRequest !== undefined) return 'idle';
    await found.record.session.steer(text);
    return 'steered';
  }

  async stop(id: string, reason = 'user'): Promise<TowerStopResult> {
    const found = this.lookup(id);
    if (found === undefined) return 'missing';
    const run = activeRun(found);
    if (run === undefined) return 'idle';
    this.requestStop(found.record, run, { status: 'stopped', reason });
    await run.done;
    return 'stopped';
  }

  get(id: string): TowerAgentInfo | undefined {
    const found = this.lookup(id);
    return found === undefined ? undefined : this.describe(found.record);
  }

  output(id: string): TowerAgentOutput | undefined {
    const found = this.lookup(id);
    if (found === undefined) return undefined;
    const { record } = found;
    return {
      ...this.describe(record),
      streamingText:
        record.status === 'running' && record.streaming !== undefined
          ? assistantText(record.streaming)
          : undefined,
      recentToolCalls: record.toolCalls.map((call) => ({ ...call })),
    };
  }

  list(activeOnly = false): TowerAgentInfo[] {
    return this.liveRecords()
      .filter((record) => !activeOnly || record.status === 'running')
      .map((record) => this.describe(record));
  }

  activeAgentIds(): ReadonlySet<string> {
    return new Set(
      this.liveRecords()
        .filter((record) => record.status === 'running')
        .map((record) => record.agentId),
    );
  }

  async dispose(id: string, reason = 'disposed'): Promise<boolean> {
    const found = this.lookup(id);
    if (found === undefined) return false;
    await this.disposeRecord(found.record, reason);
    return true;
  }

  async disposeAll(reason = 'shutdown'): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.agents.values()].map((record) => this.disposeRecord(record, reason)));
  }

  private liveRecords(): AgentRecord[] {
    return [...this.agents.values()].filter((record) => !record.disposed);
  }

  private lookup(id: string): AgentLookup | undefined {
    const direct = this.agents.get(id);
    if (direct !== undefined) return direct.disposed ? undefined : { record: direct };
    const owner = this.taskOwners.get(id);
    const record = owner === undefined ? undefined : this.agents.get(owner);
    return record === undefined || record.disposed ? undefined : { record, taskId: id };
  }

  private nextId(prefix: 'agent' | 'task'): string {
    for (let attempt = 0; attempt < ID_ATTEMPTS; attempt += 1) {
      const id = this.createId(prefix);
      if (!this.agents.has(id) && !this.taskOwners.has(id) && !this.pendingAgentIds.has(id)) {
        return id;
      }
    }
    throw new Error(`could not allocate a unique tower ${prefix} id`);
  }

  private newRun(): AgentRun {
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    return {
      taskId: this.nextId('task'),
      startedAt: this.now(),
      usage: emptyUsage(),
      done,
      resolveDone,
      settled: false,
      abortedBySession: false,
      finished: false,
    };
  }

  private launch(record: AgentRecord, run: AgentRun, prompt: string, resumed: boolean): void {
    record.run = run;
    record.status = 'running';
    record.stopReason = undefined;
    record.endedAt = undefined;
    record.streaming = undefined;
    record.taskIds.push(run.taskId);
    this.taskOwners.set(run.taskId, record.agentId);
    const timeoutMs = record.spec.timeoutMs ?? this.timeoutMs;
    if (timeoutMs !== undefined) {
      run.timeoutTimer = setTimeout(() => {
        this.requestStop(record, run, {
          status: 'timed_out',
          reason: `timed out after ${formatDuration(timeoutMs)}`,
        });
      }, timeoutMs);
      run.timeoutTimer.unref();
    }
    this.emit({
      type: 'started',
      agentId: record.agentId,
      taskId: run.taskId,
      name: record.spec.name,
      resumed,
      at: run.startedAt,
    });
    let completion: Promise<void>;
    try {
      completion = record.session.prompt(prompt);
    } catch (error) {
      completion = Promise.reject(error);
    }
    completion.then(
      () => {
        this.finishRun(record, run);
      },
      (error: unknown) => {
        this.finishRun(record, run, { error });
      },
    );
  }

  private requestStop(record: AgentRecord, run: AgentRun, request: StopRequest): void {
    if (run.finished) return;
    run.stopRequest ??= request;
    clearTimeout(run.timeoutTimer);
    if (run.graceTimer === undefined) {
      run.graceTimer = setTimeout(() => {
        this.finishRun(record, run);
      }, this.stopGraceMs);
      run.graceTimer.unref();
    }
    void settle(() => record.session.abort());
  }

  private finishRun(record: AgentRecord, run: AgentRun, failure?: { readonly error: unknown }): void {
    if (run.finished) return;
    run.finished = true;
    clearTimeout(run.timeoutTimer);
    clearTimeout(run.graceTimer);
    try {
      const outcome = runOutcome(run, failure);
      const at = this.now();
      record.status = outcome.status;
      record.stopReason = outcome.stopReason;
      record.endedAt = at;
      record.streaming = undefined;
      this.limiter.release();
      this.emit({
        type: 'finished',
        agentId: record.agentId,
        taskId: run.taskId,
        name: record.spec.name,
        status: outcome.status,
        summary: run.lastText,
        stopReason: outcome.stopReason,
        usage: { ...run.usage },
        at,
      });
    } finally {
      run.resolveDone();
    }
  }

  private async disposeRecord(record: AgentRecord, reason: string): Promise<void> {
    if (record.disposed) return;
    record.disposed = true;
    if (record.status === 'running') {
      this.requestStop(record, record.run, { status: 'stopped', reason });
      await record.run.done;
    }
    record.unsubscribe();
    this.agents.delete(record.agentId);
    for (const taskId of record.taskIds) this.taskOwners.delete(taskId);
    await settle(() => record.session.dispose());
  }

  private onSessionEvent(record: AgentRecord, event: AgentSessionEvent): void {
    const run = record.run;
    if (run.finished) return;
    switch (event.type) {
      case 'message_update':
        if (event.message.role === 'assistant') record.streaming = event.message;
        return;
      case 'message_end':
        if (event.message.role === 'assistant') this.onAssistantMessage(record, run, event.message);
        return;
      case 'tool_execution_start':
        if (event.parentToolCallId === undefined) {
          record.toolCalls.push({
            toolCallId: event.toolCallId,
            name: event.toolName,
            args: previewArgs(event.args),
            startedAt: this.now(),
          });
          if (record.toolCalls.length > TOWER_AGENT_RECENT_TOOL_CALLS) record.toolCalls.shift();
        }
        return;
      case 'tool_execution_end': {
        const call = record.toolCalls.findLast((candidate) => candidate.toolCallId === event.toolCallId);
        if (call !== undefined) {
          call.endedAt = this.now();
          call.isError = event.isError;
        }
        return;
      }
      case 'agent_settled':
        run.settled = true;
        if (event.aborted) run.abortedBySession = true;
        return;
      default:
        return;
    }
  }

  private onAssistantMessage(record: AgentRecord, run: AgentRun, message: AssistantMessage): void {
    record.streaming = undefined;
    addUsage(run.usage, message.usage);
    addUsage(record.usage, message.usage);
    const text = assistantText(message);
    if (text !== undefined) {
      run.lastText = text;
      record.lastAssistantText = text;
    }
    const base = { agentId: record.agentId, taskId: run.taskId, name: record.spec.name, at: this.now() };
    if (message.stopReason === 'error') {
      run.lastError = message.errorMessage ?? 'provider request failed';
      if (isRateLimitError(message.errorMessage)) {
        this.limiter.reportRateLimited();
        this.emit({ type: 'rate-limited', ...base, message: run.lastError });
      }
      return;
    }
    run.lastError = undefined;
    if (message.stopReason === 'aborted') return;
    this.limiter.reportSuccess();
    this.emit({ type: 'request-succeeded', ...base });
  }

  private describe(record: AgentRecord): TowerAgentInfo {
    const { session, spec, run } = record;
    return {
      agentId: record.agentId,
      taskId: run.taskId,
      name: spec.name,
      kind: spec.kind,
      description: spec.description,
      cwd: spec.cwd,
      model: session.model === undefined ? undefined : `${session.model.provider}/${session.model.id}`,
      thinkingLevel: session.thinkingLevel,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      status: record.status,
      runs: record.taskIds.length,
      createdAt: record.createdAt,
      startedAt: run.startedAt,
      endedAt: record.endedAt,
      lastAssistantText: record.lastAssistantText,
      stopReason: record.stopReason,
      usage: { ...record.usage },
    };
  }

  private emit(event: TowerAgentEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        const result = listener(event);
        if (result instanceof Promise) {
          result.catch((error: unknown) => {
            this.reportListenerError(error, event);
          });
        }
      } catch (error) {
        this.reportListenerError(error, event);
      }
    }
  }

  private reportListenerError(error: unknown, event: TowerAgentEvent): void {
    try {
      this.onListenerError?.(error, event);
    } catch {
      return;
    }
  }
}

function activeRun(found: AgentLookup): AgentRun | undefined {
  const { record, taskId } = found;
  if (record.status !== 'running') return undefined;
  if (taskId !== undefined && taskId !== record.run.taskId) return undefined;
  return record.run;
}

function runOutcome(run: AgentRun, failure: { readonly error: unknown } | undefined): RunOutcome {
  if (run.stopRequest !== undefined) {
    return { status: run.stopRequest.status, stopReason: run.stopRequest.reason };
  }
  if (failure !== undefined) return { status: 'failed', stopReason: errorMessage(failure.error) };
  if (run.abortedBySession) return { status: 'stopped', stopReason: 'aborted' };
  if (run.lastError !== undefined) return { status: 'failed', stopReason: run.lastError };
  return { status: 'idle' };
}

function specProblem(spec: TowerAgentSpec): string | undefined {
  if (spec.name.trim().length === 0) return 'tower agent name must not be blank';
  if (spec.cwd.trim().length === 0) return 'tower agent cwd must not be blank';
  if (spec.prompt.trim().length === 0) return 'tower agent prompt must not be empty';
  if (spec.timeoutMs !== undefined && !isPositiveDuration(spec.timeoutMs)) {
    return 'tower agent timeoutMs must be a positive number of milliseconds';
  }
  return undefined;
}

function isPositiveDuration(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function describeAgent(record: AgentRecord): string {
  return `"${record.spec.name}" (${record.agentId})`;
}

function emptyUsage(): MutableUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

function addUsage(target: MutableUsage, usage: Usage): void {
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.totalTokens += usage.totalTokens;
  target.cost += usage.cost.total;
}

function assistantText(message: AssistantMessage): string | undefined {
  let text = '';
  for (const block of message.content) {
    if (block.type === 'text') text += block.text;
  }
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function previewArgs(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(args) ?? String(args);
  } catch {
    text = String(args);
  }
  return text.length > TOOL_ARGS_PREVIEW_MAX ? `${text.slice(0, TOOL_ARGS_PREVIEW_MAX)}…` : text;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  return seconds % 60 === 0 ? `${String(seconds / 60)}m` : `${String(seconds)}s`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function randomId(prefix: 'agent' | 'task'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

async function settle(action: () => unknown): Promise<void> {
  try {
    await action();
  } catch {
    return;
  }
}
