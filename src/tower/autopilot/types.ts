import type { TowerStore } from '../../protocol/store.ts';
import type { TowerState } from '../../protocol/types.ts';

export interface ObjectiveSettingsValues {
  readonly autopilot: boolean;
  readonly autoApprove: boolean;
  readonly maxValidationRounds: number;
  readonly maxFeatureAttempts: number;
  readonly skipScrutiny: boolean;
  readonly skipUserTesting: boolean;
  readonly maxWallTimeMs?: number;
  readonly maxCostUsd?: number;
}

export interface AutopilotRuntimeSettings extends ObjectiveSettingsValues {
  /** The current agent budget: the configured maxRunningAgents capped by the rate-limit governor. */
  readonly maxRunningAgents: number;
  readonly watchdogIntervalMs: number;
  readonly stallTimeoutMs: number;
  readonly maxStallWakes: number;
}

/**
 * `running`: mid-turn or winding down while it still holds a slot. `idle`: alive between turns.
 * `completed`: a disposed reviewer or validator that ended normally. `unknown`: the process has no
 * agent runtime at all — never treated as running.
 */
export type AutopilotAgentStatus =
  | 'running'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'stopped'
  | 'unknown';

export interface AutopilotAgentObservation {
  readonly status: AutopilotAgentStatus;
  readonly stopReason?: string;
  /** Final assistant text of the agent's last turn, when the runtime still holds it. */
  readonly lastAssistantText?: string;
}

export interface AutopilotObservations {
  now(): number;
  store(): TowerStore;
  settings(): AutopilotRuntimeSettings;
  /** undefined: this process's runtime does not know the agent (retired, previous session, disposed) — it is gone. */
  agent(agentId: string): AutopilotAgentObservation | undefined;
  orchestratorBusy(): boolean;
  headless(state: TowerState): boolean;
  /** All agents and the orchestrator; the runner records the deltas as objective usage. */
  totalCostUsd(): number;
}

export type EffectResult =
  | { readonly ok: true; readonly detail?: string }
  | { readonly ok: false; readonly error: string };

export type AutopilotValidatorKind = 'scrutiny' | 'user-testing';

/**
 * Agent effects resolve once the agent started or was refused. While a promise is pending the
 * runner counts it as a live agent and repeats no action on its mission or validation.
 */
export interface AutopilotEffects {
  spawnWorker(missionId: string, name: string): Promise<EffectResult>;
  respawnWorker(missionId: string, name: string, reason: string): Promise<EffectResult>;
  resumeWorker(agentName: string, prompt: string): Promise<EffectResult>;
  spawnReviewer(missionId: string, name: string): Promise<EffectResult>;
  rebase(missionId: string): Promise<EffectResult>;
  merge(missionId: string): Promise<EffectResult>;
  spawnValidator(milestoneId: string, kind: AutopilotValidatorKind, name: string): Promise<EffectResult>;
  wakeOrchestrator(text: string): void;
  notifyHuman(text: string, level: 'info' | 'warning' | 'error'): void;
}

export interface AutopilotTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface AutopilotLog {
  info(message: string, payload?: Readonly<Record<string, unknown>>): void;
  warn(message: string, payload?: Readonly<Record<string, unknown>>): void;
}
