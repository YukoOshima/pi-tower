export type TowerRole = 'orchestrator' | 'worker' | 'reviewer' | 'validator';

export type TowerSpawnKind = 'worker' | 'reviewer' | 'validator';

export type TowerThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type TowerConfigScope = 'global' | 'project';

export interface TowerModelRef {
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel?: TowerThinkingLevel;
}

export interface TowerModelSpec extends TowerModelRef {
  readonly description?: string;
}

export interface TowerConfigFile {
  readonly orchestrator?: TowerModelSpec;
  readonly worker?: TowerModelSpec;
  readonly reviewer?: TowerModelSpec;
  readonly validator?: TowerModelSpec;
  readonly models?: Readonly<Record<string, TowerModelSpec>>;
  readonly maxRunningAgents?: number;
  readonly agentTimeoutMs?: number;
  readonly objective?: TowerObjectiveConfigFile;
}

export interface TowerObjectiveSettingValues {
  readonly autopilot: boolean;
  readonly autoApprove: boolean;
  readonly maxValidationRounds: number;
  readonly maxFeatureAttempts: number;
  readonly watchdogIntervalMs: number;
  readonly stallTimeoutMs: number;
  readonly maxStallWakes: number;
  readonly maxWallTimeMs: number | undefined;
  readonly maxCostUsd: number | undefined;
  readonly skipScrutiny: boolean;
  readonly skipUserTesting: boolean;
  readonly autoTeardown: boolean;
}

export type TowerObjectiveSettingKey = keyof TowerObjectiveSettingValues;

export type TowerObjectiveConfigFile = {
  readonly [K in TowerObjectiveSettingKey]?: NonNullable<TowerObjectiveSettingValues[K]>;
};

export type TowerConfigSource =
  | { readonly kind: 'flag'; readonly flag: string }
  | { readonly kind: 'env'; readonly variable: string }
  | { readonly kind: 'file'; readonly scope: TowerConfigScope; readonly path: string };

export interface TowerConfigValue<T> {
  readonly value: T;
  readonly source: TowerConfigSource;
}

export type TowerConfigFileStatus = 'loaded' | 'missing' | 'untrusted';

export interface TowerConfigFileState {
  readonly scope: TowerConfigScope;
  readonly path: string;
  readonly status: TowerConfigFileStatus;
}

export interface TowerConfig {
  readonly roles: Readonly<Partial<Record<TowerRole, TowerConfigValue<TowerModelSpec>>>>;
  readonly models: Readonly<Record<string, TowerConfigValue<TowerModelSpec>>>;
  readonly maxRunningAgents?: TowerConfigValue<number>;
  readonly agentTimeoutMs?: TowerConfigValue<number>;
  readonly objective?: readonly TowerConfigValue<TowerObjectiveConfigFile>[];
  readonly files: readonly TowerConfigFileState[];
}

export type TowerObjectiveSettingSource = TowerConfigSource | { readonly kind: 'default' };

export interface TowerObjectiveSetting<T> {
  readonly value: T;
  readonly source: TowerObjectiveSettingSource;
}

export type TowerObjectiveSettings = {
  readonly [K in TowerObjectiveSettingKey]: TowerObjectiveSetting<TowerObjectiveSettingValues[K]>;
};

export type TowerPrimaryModel = TowerModelRef;

export interface TowerModelBinding {
  readonly model: string;
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel?: TowerThinkingLevel;
}

export type TowerModelOrigin =
  | TowerConfigSource
  | { readonly kind: 'session' }
  | { readonly kind: 'inherited'; readonly from: 'orchestrator' | 'reviewer' };

export interface TowerResolvedModel {
  readonly binding?: TowerModelBinding;
  readonly origin: TowerModelOrigin;
  readonly description?: string;
}

export interface TowerResolvedModels {
  readonly roles: Readonly<Record<TowerRole, TowerResolvedModel>>;
  readonly pool: Readonly<Record<string, TowerResolvedModel>>;
  readonly files: readonly TowerConfigFileState[];
}
