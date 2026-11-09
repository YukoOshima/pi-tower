import type {
  TowerAgentEventListener,
  TowerAgentInfo,
  TowerAgentOutput,
  TowerAgentSpec,
  TowerAgentUsage,
  TowerRateLimitSnapshot,
  TowerRunStartResult,
  TowerSteerResult,
  TowerStopResult,
} from '../runtime/index.ts';

export type {
  TowerAgentEndStatus,
  TowerAgentEvent,
  TowerAgentEventListener,
  TowerAgentFinishedEvent,
  TowerAgentInfo,
  TowerAgentOutput,
  TowerAgentSpec,
  TowerAgentStartedEvent,
  TowerAgentStatus,
  TowerAgentUsage,
  TowerRateLimitSnapshot,
  TowerRunStartResult,
  TowerSteerResult,
  TowerStopResult,
  TowerThinkingLevel,
  TowerToolCallRecord,
} from '../runtime/index.ts';

export interface TowerRuntime {
  readonly limiter: {
    snapshot(): TowerRateLimitSnapshot;
    reportRateLimited(): void;
    reportSuccess(): void;
  };
  onEvent(listener: TowerAgentEventListener): () => void;
  spawn(spec: TowerAgentSpec): Promise<TowerRunStartResult>;
  resume(id: string, prompt: string): Promise<TowerRunStartResult>;
  steer(id: string, text: string): Promise<TowerSteerResult>;
  stop(id: string, reason?: string): Promise<TowerStopResult>;
  get(id: string): TowerAgentInfo | undefined;
  output(id: string): TowerAgentOutput | undefined;
  list(activeOnly?: boolean): TowerAgentInfo[];
  activeAgentIds(): ReadonlySet<string>;
  usage(): TowerAgentUsage;
  dispose(id: string, reason?: string): Promise<boolean>;
  disposeAll(reason?: string): Promise<void>;
}
