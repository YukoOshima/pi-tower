export type TowerAgentStatus = 'running' | 'idle' | 'failed' | 'stopped' | 'timed_out';

export type TowerAgentEndStatus = Exclude<TowerAgentStatus, 'running'>;

export interface TowerAgentUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly cost: number;
}

export interface TowerToolCallRecord {
  readonly toolCallId: string;
  readonly name: string;
  readonly args: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly isError?: boolean;
}

export interface TowerAgentInfo {
  readonly agentId: string;
  readonly taskId: string;
  readonly name: string;
  readonly kind?: string;
  readonly description?: string;
  readonly cwd: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly status: TowerAgentStatus;
  readonly runs: number;
  readonly createdAt: number;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly lastAssistantText?: string;
  readonly stopReason?: string;
  readonly usage: TowerAgentUsage;
}

export interface TowerAgentOutput extends TowerAgentInfo {
  readonly streamingText?: string;
  readonly recentToolCalls: readonly TowerToolCallRecord[];
}

export type TowerRunStartResult =
  | { readonly ok: true; readonly agentId: string; readonly taskId: string }
  | { readonly ok: false; readonly reason: string };

export type TowerSteerResult = 'steered' | 'handled' | 'idle' | 'missing';

export type TowerStopResult = 'stopped' | 'idle' | 'missing';

interface TowerAgentEventBase {
  readonly agentId: string;
  readonly taskId: string;
  readonly name: string;
  readonly at: number;
}

export interface TowerAgentStartedEvent extends TowerAgentEventBase {
  readonly type: 'started';
  readonly resumed: boolean;
}

export interface TowerAgentFinishedEvent extends TowerAgentEventBase {
  readonly type: 'finished';
  readonly status: TowerAgentEndStatus;
  readonly summary?: string;
  readonly stopReason?: string;
  readonly undeliveredSteers?: readonly string[];
  readonly usage: TowerAgentUsage;
}

export interface TowerAgentRateLimitedEvent extends TowerAgentEventBase {
  readonly type: 'rate-limited';
  readonly message: string;
}

export interface TowerAgentRequestSucceededEvent extends TowerAgentEventBase {
  readonly type: 'request-succeeded';
}

export type TowerAgentEvent =
  | TowerAgentStartedEvent
  | TowerAgentFinishedEvent
  | TowerAgentRateLimitedEvent
  | TowerAgentRequestSucceededEvent;

export type TowerAgentEventListener = (event: TowerAgentEvent) => void | Promise<void>;

export interface TowerRateLimitSnapshot {
  readonly budget: number;
  readonly inflight: number;
  readonly blockedUntil: number | null;
}

export interface TowerAgentSpecInput {
  readonly name: string;
  readonly kind?: string;
  readonly description?: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
  readonly appendSystemPrompt?: string | readonly string[];
  readonly tools?: readonly string[];
  readonly timeoutMs?: number;
}

export interface TowerRuntime {
  readonly limiter: {
    snapshot(): TowerRateLimitSnapshot;
    reportRateLimited(): void;
    reportSuccess(): void;
  };
  onEvent(listener: TowerAgentEventListener): () => void;
  spawn(spec: TowerAgentSpecInput): Promise<TowerRunStartResult>;
  resume(id: string, prompt: string): Promise<TowerRunStartResult>;
  steer(id: string, text: string): Promise<TowerSteerResult>;
  stop(id: string, reason?: string): Promise<TowerStopResult>;
  get(id: string): TowerAgentInfo | undefined;
  output(id: string): TowerAgentOutput | undefined;
  list(activeOnly?: boolean): TowerAgentInfo[];
  activeAgentIds(): ReadonlySet<string>;
  dispose(id: string, reason?: string): Promise<boolean>;
  disposeAll(reason?: string): Promise<void>;
}
