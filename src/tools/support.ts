import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type, type Static, type TSchema, type TUnsafe } from 'typebox';

import { TOWER_OBJECTIVE_DEFAULTS } from '../config/index.ts';
import type { PromptValidationKind, TowerToolName } from '../prompts/index.ts';
import {
  GitError,
  MAIN_AGENT_ID,
  TowerProtocolError,
  type TowerAgentKind,
  type TowerStore,
  type TowerValidationSettings,
} from '../protocol/index.ts';
import type {
  TowerAgentInfo,
  TowerAgentOutput,
  TowerRateLimitSnapshot,
  TowerRunStartResult,
  TowerSteerResult,
  TowerStopResult,
  TowerThinkingLevel,
} from '../tower/runtimeTypes.ts';

export interface TowerToolResult {
  readonly output: string;
  readonly isError?: boolean;
}

export interface TowerToolCall {
  readonly toolCallId: string;
  readonly signal?: AbortSignal;
}

export interface TowerTool<TParams extends TSchema = TSchema> {
  readonly name: TowerToolName;
  readonly label: string;
  readonly description: string;
  readonly parameters: TParams;
  run(args: Static<TParams>, call: TowerToolCall): Promise<TowerToolResult>;
}

export interface TowerCaller {
  readonly agentId: string;
}

export const ORCHESTRATOR_CALLER: TowerCaller = { agentId: MAIN_AGENT_ID };

export interface TowerOwner {
  readonly sessionId?: string;
  readonly pid?: number;
}

export interface TowerInboxSentPayload {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly messageId?: string;
  readonly file?: string;
  readonly sentAt?: string;
  readonly missionId?: string;
}

export interface TowerSpawnBinding {
  readonly choice: string;
  readonly model: string;
  readonly thinkingLevel?: TowerThinkingLevel;
}

export type TowerSpawnModelResolution =
  | { readonly ok: true; readonly binding?: TowerSpawnBinding }
  | { readonly ok: false; readonly error: string };

export interface TowerLaunchRequest {
  readonly name: string;
  readonly kind: TowerAgentKind;
  readonly description: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly binding?: TowerSpawnBinding;
}

export interface TowerToolHost {
  readonly isActive: boolean;
  readonly sessionId: string;
  store(): TowerStore;
  isOwnerLive(owner: TowerOwner): boolean;
  noteRetiredAgents(names: readonly string[]): void;
  isRetiredAgent(name: string): boolean;
  isBranchLeased(branch: string): boolean;
  withBranchLease<T>(branch: string, execute: () => Promise<T>): Promise<T>;
  activeAgentIds(): ReadonlySet<string>;
  rateLimitSnapshot(): TowerRateLimitSnapshot;
  publishInboxSent(event: TowerInboxSentPayload): void;
  steerAgent(agentId: string, text: string): Promise<TowerSteerResult>;
  resolveSpawnModel(kind: TowerAgentKind, choice: string | undefined): Promise<TowerSpawnModelResolution>;
  launchAgent(request: TowerLaunchRequest): Promise<TowerRunStartResult>;
  agentRegistered(agentId: string): void;
  abortAgent(agentId: string): Promise<void>;
  agentInfo(id: string): TowerAgentInfo | undefined;
  agentOutput(id: string): TowerAgentOutput | undefined;
  listAgents(activeOnly: boolean): readonly TowerAgentInfo[];
  resumeAgent(agentId: string, prompt: string): Promise<TowerRunStartResult>;
  stopAgent(id: string, reason: string): Promise<TowerStopResult>;
  objectiveSettings?(): TowerObjectiveSettingsView;
}

export interface TowerObjectiveSettingsView {
  readonly autopilot: boolean;
  readonly autoApprove: boolean;
  readonly maxValidationRounds: number;
  readonly maxFeatureAttempts: number;
  readonly skipScrutiny: boolean;
  readonly skipUserTesting: boolean;
  readonly maxWallTimeMs?: number;
  readonly maxCostUsd?: number;
  readonly autoTeardown?: boolean;
}

export const DEFAULT_OBJECTIVE_SETTINGS_VIEW: TowerObjectiveSettingsView = {
  autopilot: TOWER_OBJECTIVE_DEFAULTS.autopilot,
  autoApprove: TOWER_OBJECTIVE_DEFAULTS.autoApprove,
  maxValidationRounds: TOWER_OBJECTIVE_DEFAULTS.maxValidationRounds,
  maxFeatureAttempts: TOWER_OBJECTIVE_DEFAULTS.maxFeatureAttempts,
  skipScrutiny: TOWER_OBJECTIVE_DEFAULTS.skipScrutiny,
  skipUserTesting: TOWER_OBJECTIVE_DEFAULTS.skipUserTesting,
  autoTeardown: TOWER_OBJECTIVE_DEFAULTS.autoTeardown,
  ...(TOWER_OBJECTIVE_DEFAULTS.maxWallTimeMs === undefined
    ? {}
    : { maxWallTimeMs: TOWER_OBJECTIVE_DEFAULTS.maxWallTimeMs }),
  ...(TOWER_OBJECTIVE_DEFAULTS.maxCostUsd === undefined
    ? {}
    : { maxCostUsd: TOWER_OBJECTIVE_DEFAULTS.maxCostUsd }),
};

export function objectiveSettingsOf(
  host: Pick<TowerToolHost, 'objectiveSettings'>,
): TowerObjectiveSettingsView {
  return host.objectiveSettings?.() ?? DEFAULT_OBJECTIVE_SETTINGS_VIEW;
}

export function validationSettingsOf(settings: TowerObjectiveSettingsView): TowerValidationSettings {
  return { skipScrutiny: settings.skipScrutiny, skipUserTesting: settings.skipUserTesting };
}

export function skippedValidationKinds(settings: TowerObjectiveSettingsView): PromptValidationKind[] {
  return [
    ...(settings.skipScrutiny ? (['scrutiny'] as const) : []),
    ...(settings.skipUserTesting ? (['user-testing'] as const) : []),
  ];
}

export async function runTowerTool(
  execute: () => Promise<TowerToolResult>,
): Promise<TowerToolResult> {
  try {
    return await execute();
  } catch (error) {
    if (error instanceof TowerProtocolError || error instanceof GitError) {
      return { output: error.message, isError: true };
    }
    throw error;
  }
}

export function isMainAgent(caller: TowerCaller): boolean {
  return caller.agentId === MAIN_AGENT_ID;
}

export interface TowerToolDefinitionOptions {
  readonly defaultActive?: boolean;
  readonly onContext?: (ctx: ExtensionContext) => void;
}

export function toToolDefinition<TParams extends TSchema>(
  tool: TowerTool<TParams>,
  options: TowerToolDefinitionOptions = {},
): ToolDefinition<TParams, undefined> {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    ...(options.defaultActive === undefined ? {} : { defaultActive: options.defaultActive }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      options.onContext?.(ctx);
      const result = await tool.run(params, { toolCallId, ...(signal === undefined ? {} : { signal }) });
      return {
        content: [{ type: 'text', text: result.output }],
        details: undefined,
        ...(result.isError === true ? { isError: true } : {}),
      };
    },
  };
}

export function stringEnum<const T extends readonly string[]>(
  values: T,
  description?: string,
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({
    type: 'string',
    enum: [...values],
    ...(description === undefined ? {} : { description }),
  });
}
