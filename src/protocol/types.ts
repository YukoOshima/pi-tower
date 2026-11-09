export type TowerAgentKind = 'worker' | 'reviewer' | 'validator';
export type TowerObjectiveStatus =
  | 'planning'
  | 'awaiting-approval'
  | 'executing'
  | 'paused'
  | 'completed'
  | 'blocked';
export type TowerMilestoneStatus = 'pending' | 'active' | 'validating' | 'passed' | 'failed' | 'blocked';
export type TowerValidationKind = 'scrutiny' | 'user-testing' | 'commands';
export type TowerValidationVerdict = 'pass' | 'fail';
export type TowerMissionOrigin = 'plan' | 'fix';
export type TowerObjectiveMode = 'interactive' | 'headless';

export interface TowerMilestoneValidationSpec {
  scrutiny: boolean;
  userTesting: boolean;
  commands: string[];
  qaInstructions?: string;
}

export interface TowerValidationRound {
  round: number;
  kind: TowerValidationKind;
  validator: string;
  validatedCommit: string;
  verdict: TowerValidationVerdict;
  failures: string[];
  file: string;
  date: string;
  contractRevision?: number;
}

export interface TowerMilestone {
  readonly id: string;
  title: string;
  description?: string;
  order: number;
  validation: TowerMilestoneValidationSpec;
  status: TowerMilestoneStatus;
  rounds: TowerValidationRound[];
  validationCommit?: string;
  startedAt?: string;
  passedAt?: string;
}

export interface TowerObjectiveLimits {
  maxValidationRounds: number;
  maxFeatureAttempts: number;
  maxWallTimeMs?: number;
  maxCostUsd?: number;
}

export interface TowerObjectiveAutopilotState {
  progressKey?: string;
  progressAt?: string;
  stallWakes: number;
  wakeKeys: string[];
}

export interface TowerObjective {
  readonly id: string;
  title: string;
  goal: string;
  definitionOfDone: string[];
  acceptanceCommands: string[];
  contractRevision?: number;
  status: TowerObjectiveStatus;
  milestones: TowerMilestone[];
  removedMilestones?: string[];
  limits: TowerObjectiveLimits;
  approvedBy?: 'human' | 'auto';
  approvedAt?: string;
  approvalReason?: string;
  approvalRequiresHuman?: boolean;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  blockedReason?: string;
  pausedReason?: string;
  usage?: { costUsd: number };
  autopilot?: TowerObjectiveAutopilotState;
  notes: string[];
}

export interface TowerRosterEntry {
  readonly name: string;
  readonly agentId: string;
  readonly sessionId?: string;
  readonly kind: TowerAgentKind;
  readonly missionId?: string;
  readonly reviewTarget?: string;
  readonly reviewMissionId?: string;
  readonly worktree?: string;
  readonly branch?: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly agentSessionFile?: string;
  readonly spawnedAt: string;
  readonly lastInboxReadAt?: string;
  readonly inboxAckIds?: string[];
  readonly diedAt?: string;
  readonly deathStatus?: string;
  readonly deathReason?: string;
  readonly milestoneId?: string;
  readonly validationKind?: TowerValidationKind;
  readonly validationRound?: number;
  readonly validatedCommit?: string;
  readonly contractRevision?: number;
}

export interface TowerRoster {
  readonly agents: TowerRosterEntry[];
}

export type TowerMissionStatus =
  | 'planned'
  | 'active'
  | 'completed'
  | 'blocked'
  | 'paused'
  | 'merged'
  | 'abandoned';

export type TowerMissionKind = 'build' | 'survey';

export interface TowerMissionTask {
  text: string;
  done: boolean;
  dropped?: boolean;
}

export interface TowerMission {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  kind: TowerMissionKind;
  scope: string[];
  readonly branch: string;
  readonly worktree: string;
  spawnBase?: string;
  deps: string[];
  lastRebase?: {
    readonly fromCommit: string;
    readonly toCommit: string;
  };
  status: TowerMissionStatus;
  owner?: string;
  context?: string;
  tasks: TowerMissionTask[];
  notes: string[];
  blockers: string[];
  milestone?: string;
  origin?: TowerMissionOrigin;
  attempts?: number;
}

export interface TowerState {
  readonly version: 1;
  readonly base: string;
  readonly mode: 'branch' | 'pr';
  readonly createdAt: string;
  recoveredAt?: string;
  sessionId?: string;
  ownerPid?: number;
  inboxAckIds?: string[];
  roster: TowerRoster;
  missions: TowerMission[];
  objective?: TowerObjective;
  objectiveHistory?: TowerObjective[];
  objectiveMode?: TowerObjectiveMode;
  objectiveModeFor?: string;
}

export type TowerFindingType = 'bug' | 'improve' | 'vuln' | 'idea';
export type TowerFindingSeverity = 'low' | 'medium' | 'high' | 'critical';

export type TowerReviewStatus = 'clean' | `p1-${number}items` | `p2-${number}items`;
export type TowerReviewMerge = 'merge' | 'fix-then-merge' | 'hold';

export interface TowerReviewInfo {
  readonly reviewer: string;
  readonly target: string;
  readonly round: number;
  readonly status: string;
  readonly merge: string;
  readonly reviewedCommit: string;
  readonly date: string;
  readonly file: string;
  readonly mtimeMs: number;
  readonly seq?: number;
  readonly mission?: string;
}

export interface TowerInboxItem {
  readonly messageId: string;
  readonly file: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly sentAt: string;
  readonly scope?: string;
  readonly action?: string;
  readonly consentRef?: string;
  readonly body: string;
}
