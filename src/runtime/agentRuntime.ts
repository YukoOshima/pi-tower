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
  TowerSteerDisposition,
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
  readonly onDiagnostic?: (message: string) => void;
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

interface Latch {
  readonly promise: Promise<void>;
  readonly open: () => void;
}

interface AgentRun {
  readonly taskId: string;
  readonly startedAt: number;
  readonly usage: MutableUsage;
  readonly undelivered: string[];
  readonly finalized: Latch;
  readonly promptDone: Latch;
  stopRequest?: StopRequest;
  lastText?: string;
  lastError?: string;
  streamed: boolean;
  agentSettled: boolean;
  abortedBySession: boolean;
  finished: boolean;
  promptSettled: boolean;
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
  readonly pendingSteers: Set<Promise<SteerOutcome>>;
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

type SteerOutcome =
  | { readonly disposition: TowerSteerDisposition }
  | { readonly error: unknown };

export class TowerAgentRuntime {
  readonly limiter: TowerRateLimiter;
  private readonly sessionFactory: TowerAgentSessionFactory;
  private readonly timeoutMs: number | undefined;
  private readonly stopGraceMs: number;
  private readonly now: () => number;
  private readonly createId: (prefix: 'agent' | 'task') => string;
  private readonly onListenerError: ((error: unknown, event: TowerAgentEvent) => void) | undefined;
  private readonly onDiagnostic: ((message: string) => void) | undefined;
  private readonly agents = new Map<string, AgentRecord>();
  private readonly taskOwners = new Map<string, string>();
  private readonly reservedIds = new Set<string>();
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
    this.onDiagnostic = options.onDiagnostic;
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
    const reserved: string[] = [];
    try {
      let agentId: string;
      let taskId: string;
      try {
        agentId = this.reserveId('agent', reserved);
        taskId = this.reserveId('task', reserved);
      } catch (error) {
        return { ok: false, reason: `tower spawn failed: ${errorMessage(error)}` };
      }
      return await this.startAgent(spec, agentId, taskId);
    } finally {
      for (const id of reserved) this.reservedIds.delete(id);
    }
  }

  async resume(id: string, prompt: string): Promise<TowerRunStartResult> {
    const found = this.lookup(id);
    if (found === undefined) {
      return { ok: false, reason: this.disposed ? RUNTIME_SHUT_DOWN : `unknown tower agent "${id}"` };
    }
    const { record } = found;
    let refusal = this.resumeRefusal(record);
    if (refusal !== undefined) return { ok: false, reason: refusal };
    if (prompt.trim().length === 0) return { ok: false, reason: 'resume prompt must not be empty' };
    if (record.pendingSteers.size > 0) {
      const drained = await settledWithin(Promise.allSettled([...record.pendingSteers]), this.stopGraceMs);
      if (!drained) {
        return {
          ok: false,
          reason: `tower agent ${describeAgent(record)} is still processing a steered message — retry shortly`,
        };
      }
      refusal = this.resumeRefusal(record);
      if (refusal !== undefined) return { ok: false, reason: refusal };
    }
    const reserved: string[] = [];
    try {
      let taskId: string;
      try {
        taskId = this.reserveId('task', reserved);
      } catch (error) {
        return { ok: false, reason: `tower resume failed: ${errorMessage(error)}` };
      }
      const gate = this.limiter.acquire();
      if (!gate.ok) return gate;
      this.launch(record, this.newRun(taskId), prompt, true);
      return { ok: true, agentId: record.agentId, taskId };
    } finally {
      for (const reservedId of reserved) this.reservedIds.delete(reservedId);
    }
  }

  async steer(id: string, text: string): Promise<TowerSteerResult> {
    const found = this.lookup(id);
    if (found === undefined) return 'missing';
    const { record } = found;
    const run = activeRun(found);
    if (run === undefined || !acceptsSteer(record, run)) return 'idle';
    const delivery = deliverSteer(record.session, text);
    record.pendingSteers.add(delivery);
    const outcome = await delivery;
    record.pendingSteers.delete(delivery);
    if (!acceptsSteer(record, run)) {
      this.discardQueued(record, run, text);
      return 'idle';
    }
    if ('error' in outcome) {
      this.diagnose(
        `steering tower agent ${describeAgent(record)} failed: ${errorMessage(outcome.error)}`,
      );
      return 'handled';
    }
    return outcome.disposition === 'queued' ? 'steered' : 'handled';
  }

  async stop(id: string, reason = 'user'): Promise<TowerStopResult> {
    const found = this.lookup(id);
    if (found === undefined) return 'missing';
    const run = activeRun(found);
    if (run === undefined) return 'idle';
    if (endingNaturally(found.record, run)) {
      await settledWithin(run.finalized.promise, this.stopGraceMs);
      if (run.finished) return 'idle';
    }
    this.requestStop(found.record, run, { status: 'stopped', reason });
    await run.finalized.promise;
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
      .filter((record) => !activeOnly || isActive(record))
      .map((record) => this.describe(record));
  }

  activeAgentIds(): ReadonlySet<string> {
    return new Set(
      this.liveRecords()
        .filter((record) => isActive(record))
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

  private async startAgent(
    spec: TowerAgentSpec,
    agentId: string,
    taskId: string,
  ): Promise<TowerRunStartResult> {
    const gate = this.limiter.acquire();
    if (!gate.ok) return gate;
    let session: TowerAgentSession;
    try {
      session = await this.sessionFactory({ agentId, spec });
    } catch (error) {
      this.limiter.release();
      return { ok: false, reason: `tower spawn failed: ${errorMessage(error)}` };
    }
    if (this.disposed) {
      this.limiter.release();
      await settle(() => session.dispose());
      return { ok: false, reason: RUNTIME_SHUT_DOWN };
    }
    const run = this.newRun(taskId);
    const record: AgentRecord = {
      agentId,
      spec,
      session,
      createdAt: run.startedAt,
      taskIds: [],
      usage: emptyUsage(),
      toolCalls: [],
      pendingSteers: new Set(),
      unsubscribe: () => undefined,
      run,
      status: 'running',
      disposed: false,
    };
    try {
      record.unsubscribe = session.subscribe((event) => {
        this.onSessionEvent(record, event);
      });
    } catch (error) {
      this.limiter.release();
      await settle(() => session.dispose());
      return { ok: false, reason: `tower spawn failed: ${errorMessage(error)}` };
    }
    this.agents.set(agentId, record);
    this.launch(record, run, spec.prompt, false);
    return { ok: true, agentId, taskId };
  }

  private resumeRefusal(record: AgentRecord): string | undefined {
    if (this.disposed) return RUNTIME_SHUT_DOWN;
    if (record.disposed) return `unknown tower agent "${record.agentId}"`;
    if (record.status === 'running') {
      return `tower agent ${describeAgent(record)} is still running task ${record.run.taskId} — steer it or stop it instead of resuming`;
    }
    if (!record.run.promptSettled || record.session.isStreaming) {
      return `tower agent ${describeAgent(record)} is still winding down its previous run — retry shortly`;
    }
    return undefined;
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

  private reserveId(prefix: 'agent' | 'task', reserved: string[]): string {
    for (let attempt = 0; attempt < ID_ATTEMPTS; attempt += 1) {
      const id = this.createId(prefix);
      if (!this.agents.has(id) && !this.taskOwners.has(id) && !this.reservedIds.has(id)) {
        this.reservedIds.add(id);
        reserved.push(id);
        return id;
      }
    }
    throw new Error(`could not allocate a unique tower ${prefix} id`);
  }

  private newRun(taskId: string): AgentRun {
    return {
      taskId,
      startedAt: this.now(),
      usage: emptyUsage(),
      undelivered: [],
      finalized: latch(),
      promptDone: latch(),
      streamed: false,
      agentSettled: false,
      abortedBySession: false,
      finished: false,
      promptSettled: false,
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
        this.onPromptSettled(record, run);
      },
      (error: unknown) => {
        this.onPromptSettled(record, run, { error });
      },
    );
  }

  private requestStop(record: AgentRecord, run: AgentRun, request: StopRequest): void {
    if (run.promptSettled) return;
    run.stopRequest ??= request;
    clearTimeout(run.timeoutTimer);
    if (!run.finished && run.graceTimer === undefined) {
      run.graceTimer = setTimeout(() => {
        this.finishRun(record, run);
      }, this.stopGraceMs);
      run.graceTimer.unref();
    }
    void settle(() => record.session.abort());
  }

  private onPromptSettled(record: AgentRecord, run: AgentRun, failure?: { readonly error: unknown }): void {
    if (run.promptSettled) return;
    run.promptSettled = true;
    clearTimeout(run.timeoutTimer);
    clearTimeout(run.graceTimer);
    try {
      this.limiter.release();
      if (run.finished) {
        this.discardQueued(record, run);
      } else {
        this.finishRun(record, run, failure);
      }
    } finally {
      run.promptDone.open();
    }
  }

  private finishRun(record: AgentRecord, run: AgentRun, failure?: { readonly error: unknown }): void {
    if (run.finished) return;
    run.finished = true;
    clearTimeout(run.graceTimer);
    try {
      this.discardQueued(record, run);
      const outcome = runOutcome(run, failure);
      const at = this.now();
      record.status = outcome.status;
      record.stopReason = outcome.stopReason;
      record.endedAt = at;
      record.streaming = undefined;
      this.emit({
        type: 'finished',
        agentId: record.agentId,
        taskId: run.taskId,
        name: record.spec.name,
        status: outcome.status,
        summary: run.lastText,
        stopReason: outcome.stopReason,
        undeliveredSteers: [...run.undelivered],
        usage: { ...run.usage },
        at,
      });
    } finally {
      run.finalized.open();
    }
  }

  private discardQueued(record: AgentRecord, run: AgentRun, own?: string): void {
    let discarded: string[];
    try {
      discarded = [...record.session.discardQueued()];
    } catch (error) {
      this.diagnose(
        `discarding queued steers of tower agent ${describeAgent(record)} failed: ${errorMessage(error)}`,
      );
      return;
    }
    if (own !== undefined) {
      const index = discarded.indexOf(own);
      if (index !== -1) discarded.splice(index, 1);
    }
    run.undelivered.push(...discarded);
  }

  private async disposeRecord(record: AgentRecord, reason: string): Promise<void> {
    if (record.disposed) return;
    record.disposed = true;
    const run = record.run;
    if (record.status === 'running') {
      this.requestStop(record, run, { status: 'stopped', reason });
      await run.finalized.promise;
    }
    this.agents.delete(record.agentId);
    for (const taskId of record.taskIds) this.taskOwners.delete(taskId);
    const teardown = run.promptDone.promise.then(async () => {
      record.unsubscribe();
      await settle(() => record.session.dispose());
    });
    await settledWithin(teardown, this.stopGraceMs);
  }

  private onSessionEvent(record: AgentRecord, event: AgentSessionEvent): void {
    const run = record.run;
    if (
      (event.type === 'agent_start' || event.type === 'compaction_start') &&
      run.stopRequest !== undefined &&
      !run.promptSettled
    ) {
      void settle(() => record.session.abort());
    }
    if (run.finished) return;
    switch (event.type) {
      case 'agent_start':
        run.streamed = true;
        return;
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
        run.agentSettled = true;
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
      windingDown: record.status !== 'running' && !run.promptSettled,
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

  private diagnose(message: string): void {
    try {
      this.onDiagnostic?.(message);
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

function isActive(record: AgentRecord): boolean {
  return record.status === 'running' || !record.run.promptSettled;
}

function acceptsSteer(record: AgentRecord, run: AgentRun): boolean {
  return (
    record.status === 'running' &&
    record.run === run &&
    !run.finished &&
    !run.agentSettled &&
    run.stopRequest === undefined &&
    record.session.isStreaming
  );
}

function endingNaturally(record: AgentRecord, run: AgentRun): boolean {
  return run.stopRequest === undefined && run.streamed && !record.session.isStreaming;
}

async function deliverSteer(session: TowerAgentSession, text: string): Promise<SteerOutcome> {
  try {
    return { disposition: await session.steer(text) };
  } catch (error) {
    return { error };
  }
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

function latch(): Latch {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function settle(action: () => unknown): Promise<void> {
  try {
    await action();
  } catch {
    return;
  }
}

async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
    timer.unref();
  });
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
