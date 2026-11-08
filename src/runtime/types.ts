import type { Api, Model } from '@earendil-works/pi-ai';
import type {
  AgentSessionEventListener,
  CreateAgentSessionOptions,
  InlineExtension,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';

export type TowerThinkingLevel = NonNullable<CreateAgentSessionOptions['thinkingLevel']>;

export type TowerAgentStatus = 'running' | 'idle' | 'failed' | 'stopped' | 'timed_out';

export type TowerAgentEndStatus = Exclude<TowerAgentStatus, 'running'>;

export interface TowerAgentSpec {
  readonly name: string;
  readonly kind?: string;
  readonly description?: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly model?: string | Model<Api>;
  readonly thinkingLevel?: TowerThinkingLevel;
  readonly appendSystemPrompt?: string | readonly string[];
  readonly tools?: readonly string[];
  readonly customTools?: readonly ToolDefinition[];
  readonly extensionFactories?: readonly InlineExtension[];
  readonly timeoutMs?: number;
}

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
  readonly thinkingLevel?: TowerThinkingLevel;
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

export type TowerSteerDisposition = 'queued' | 'handled';

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
  readonly undeliveredSteers: readonly string[];
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

export interface TowerAgentSession {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly model: { readonly provider: string; readonly id: string } | undefined;
  readonly thinkingLevel: TowerThinkingLevel;
  readonly isStreaming: boolean;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<TowerSteerDisposition>;
  discardQueued(): readonly string[];
  abort(): Promise<void>;
  subscribe(listener: AgentSessionEventListener): () => void;
  dispose(): void | Promise<void>;
}

export interface TowerAgentSessionRequest {
  readonly agentId: string;
  readonly spec: TowerAgentSpec;
}

export type TowerAgentSessionFactory = (
  request: TowerAgentSessionRequest,
) => Promise<TowerAgentSession>;
