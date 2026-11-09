import type { TowerAgentKind, TowerMissionStatus } from '../protocol/types.ts';

export type PromptAgentKind = TowerAgentKind | 'validator';

export type PromptObjectiveStatus =
  | 'planning'
  | 'awaiting-approval'
  | 'executing'
  | 'paused'
  | 'completed'
  | 'blocked';

export type PromptMilestoneStatus =
  | 'pending'
  | 'active'
  | 'validating'
  | 'passed'
  | 'failed'
  | 'blocked';

export type PromptValidationKind = 'scrutiny' | 'user-testing' | 'commands';
export type PromptValidatorKind = Exclude<PromptValidationKind, 'commands'>;
export type PromptValidationVerdict = 'pass' | 'fail';
export type PromptFeatureOrigin = 'plan' | 'fix';

export interface PromptMilestoneValidationSpec {
  readonly scrutiny: boolean;
  readonly userTesting: boolean;
  readonly commands: readonly string[];
  readonly qaInstructions?: string;
}

export interface PromptValidationRound {
  readonly round: number;
  readonly kind: PromptValidationKind;
  readonly validator: string;
  readonly validatedCommit: string;
  readonly verdict: PromptValidationVerdict;
  readonly failures: readonly string[];
  readonly file?: string;
  readonly date?: string;
}

export interface PromptMilestone {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly order: number;
  readonly validation: PromptMilestoneValidationSpec;
  readonly status: PromptMilestoneStatus;
  readonly rounds: readonly PromptValidationRound[];
  readonly validationCommit?: string;
}

export interface PromptObjectiveContract {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly definitionOfDone: readonly string[];
  readonly acceptanceCommands: readonly string[];
}

export interface PromptObjectiveLimits {
  readonly maxValidationRounds: number;
  readonly maxFeatureAttempts?: number;
  readonly maxWallTimeMs?: number;
  readonly maxCostUsd?: number;
}

export interface PromptObjective extends PromptObjectiveContract {
  readonly status: PromptObjectiveStatus;
  readonly milestones: readonly PromptMilestone[];
  readonly limits?: PromptObjectiveLimits;
  readonly approvedBy?: 'human' | 'auto';
  readonly approvalReason?: string;
  readonly createdAt?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly blockedReason?: string;
  readonly pausedReason?: string;
  readonly usage?: { readonly costUsd: number };
}

export interface PromptLiveAgent {
  readonly name: string;
  readonly kind: PromptAgentKind;
  readonly missionId?: string;
  readonly reviewTarget?: string;
  readonly milestoneId?: string;
  readonly validationKind?: PromptValidationKind;
  readonly validationRound?: number;
}

export interface PromptMissionTask {
  readonly text: string;
  readonly done: boolean;
  readonly dropped?: boolean;
}

export interface PromptFeature {
  readonly id: string;
  readonly title: string;
  readonly status: TowerMissionStatus;
  readonly branch?: string;
  readonly milestone?: string;
  readonly origin?: PromptFeatureOrigin;
  readonly attempts?: number;
  readonly owner?: string;
  readonly tasks?: readonly PromptMissionTask[];
}
