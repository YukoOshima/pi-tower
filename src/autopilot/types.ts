export type AutopilotObjectiveStatus =
  | 'planning'
  | 'awaiting-approval'
  | 'executing'
  | 'paused'
  | 'completed'
  | 'blocked';

export type AutopilotMilestoneStatus =
  | 'pending'
  | 'active'
  | 'validating'
  | 'passed'
  | 'failed'
  | 'blocked';

export type AutopilotValidationKind = 'scrutiny' | 'user-testing' | 'commands';

export type AutopilotValidationVerdict = 'pass' | 'fail';

export type AutopilotMissionStatus =
  | 'planned'
  | 'active'
  | 'completed'
  | 'blocked'
  | 'paused'
  | 'merged'
  | 'abandoned';

export type AutopilotMissionKind = 'build' | 'survey';

/**
 * `running`: mid-turn (takes an agent slot). `idle`: alive between turns, resumable.
 * `dead`: the session failed, timed out or was retired. `none`: no worker was ever registered.
 * A runtime that cannot be observed (runtime 'unknown', gate 'worker-unknown') is never `running`:
 * map it to `idle`, or `dead` once the agent is gone; a phantom `running` holds the stall watchdog forever.
 */
export type AutopilotWorkerState = 'none' | 'running' | 'idle' | 'dead';

export interface AutopilotValidationSpec {
  readonly scrutiny: boolean;
  readonly userTesting: boolean;
  /** Number of the milestone's own validation commands. */
  readonly commands: number;
}

export interface AutopilotRound {
  readonly kind: AutopilotValidationKind;
  /** Per (milestone, kind), starting at 1. */
  readonly round: number;
  /** Base tip the round validated. */
  readonly commit: string;
  readonly verdict: AutopilotValidationVerdict;
}

export interface AutopilotMilestone {
  readonly id: string;
  readonly order: number;
  readonly status: AutopilotMilestoneStatus;
  readonly validation: AutopilotValidationSpec;
  readonly rounds: readonly AutopilotRound[];
  /** Commit the current or last validation started on; the objective completes only when it is the base tip. */
  readonly validationCommit?: string;
}

export interface AutopilotLimits {
  readonly maxValidationRounds: number;
  readonly maxFeatureAttempts: number;
  readonly maxWallTimeMs?: number;
  readonly maxCostUsd?: number;
}

export interface AutopilotObjective {
  readonly id: string;
  readonly status: AutopilotObjectiveStatus;
  /** Epoch ms of the first approval. */
  readonly startedAt?: number;
  /** Sum of all agent and orchestrator usage. */
  readonly costUsd: number;
  /** Number of objective acceptance commands; they run with the final milestone's commands. */
  readonly acceptanceCommands: number;
  readonly limits: AutopilotLimits;
  readonly milestones: readonly AutopilotMilestone[];
}

export interface AutopilotSettings {
  /**
   * false: the orchestrator drives feature execution (spawn, resume and respawn workers, spawn
   * reviewers, rebase, merge); milestone advance, validation, completion and the watchdog stay automatic.
   */
  readonly autopilot: boolean;
  readonly maxRunningAgents: number;
  readonly stallTimeoutMs: number;
  readonly maxStallWakes: number;
  readonly skipScrutiny: boolean;
  readonly skipUserTesting: boolean;
}

export interface AutopilotWorker {
  readonly state: AutopilotWorkerState;
  readonly name?: string;
  /** The human stopped this worker: autopilot never resumes or respawns it and wakes the orchestrator once instead. */
  readonly humanStopped: boolean;
  /** The worker has unread review findings (a non-clean review-result) in its inbox. */
  readonly unreadFindings: boolean;
  /**
   * The worker sent the tower a message that is not an autopilot-handled mechanical action (e.g. a
   * clarify-request) after its spawn and after the latest message addressed to it: that message
   * already woke the orchestrator, and the worker waits for its reply.
   */
  readonly awaitingReply: boolean;
}

export interface AutopilotReviewVerdict {
  readonly status: string;
  readonly merge: string;
}

export interface AutopilotGate {
  readonly ready: boolean;
  /** Merge-gate reason codes, e.g. 'stale-base', 'no-review', 'out-of-scope' (TowerMissionGateReason). */
  readonly blocks: readonly string[];
}

export interface AutopilotMission {
  readonly id: string;
  readonly kind: AutopilotMissionKind;
  readonly status: AutopilotMissionStatus;
  /**
   * Milestone id. Only missions on one of the objective's milestones are its features; autopilot
   * leaves every other mission (no milestone, or an earlier objective's milestone) alone.
   */
  readonly milestone?: string;
  readonly deps: readonly string[];
  /** Number of worker spawns so far. */
  readonly attempts: number;
  /** Current branch tip; undefined while the branch does not exist. */
  readonly tip?: string;
  readonly worker: AutopilotWorker;
  /** An unanswered review-request from the author covers the current tip (a tower rebase keeps it valid). */
  readonly reviewRequestOnTip: boolean;
  /** A reviewer is observed mid-turn; like workers, an unobservable runtime is not running. */
  readonly reviewerRunning: boolean;
  /** Reviewers spawned for the current tip that ended without submitting a review. */
  readonly reviewerAttemptsOnTip: number;
  /** The human stopped the latest reviewer of the current tip before it reviewed: autopilot never replaces it. */
  readonly reviewerHumanStopped: boolean;
  /** Latest review stamped on the current tip (or carried over by a clean-rebase waiver). */
  readonly latestReviewOnTip?: AutopilotReviewVerdict;
  readonly gate: AutopilotGate;
  /** A tower rebase conflicted and left the mission blocked for the worker to resolve. */
  readonly rebaseConflict: boolean;
  /** Blockers reported by the worker, excluding the tower rebase-conflict blocker. */
  readonly blockers: readonly string[];
}

/**
 * A validation run still in flight: a validator agent that has not reported yet, or the mechanical
 * commands run while it executes. Runs of kind 'commands' never take an agent slot.
 */
export interface AutopilotValidatorRun {
  readonly milestone: string;
  readonly kind: AutopilotValidationKind;
  readonly commit: string;
  readonly name?: string;
}

/** Validator runs of `kind` for `milestone` on `commit` that ended without a verdict. */
export interface AutopilotValidationAttempts {
  readonly milestone: string;
  readonly kind: AutopilotValidationKind;
  readonly commit: string;
  readonly attempts: number;
  /** The human stopped the latest of these validators: autopilot never replaces it. */
  readonly humanStopped: boolean;
}

export interface AutopilotMemory {
  readonly progressKey?: string;
  /** Epoch ms when the current quiet period started (see AutopilotStall.progressAt). */
  readonly progressAt?: number;
  /** Consecutive stall wakes since the last progress. */
  readonly stallWakes: number;
  /** Dedupe keys of wakes (and resumes) already sent. */
  readonly wakeKeys: readonly string[];
}

export interface AutopilotSnapshot {
  /** Epoch ms of this tick; the only clock the decision reads. */
  readonly now: number;
  readonly objective?: AutopilotObjective;
  readonly settings: AutopilotSettings;
  readonly baseTip: string;
  /** Every tower mission, objective features and others alike. */
  readonly missions: readonly AutopilotMission[];
  readonly validators: readonly AutopilotValidatorRun[];
  readonly validationAttempts: readonly AutopilotValidationAttempts[];
  /** Running agents not represented by a mission worker, a mission reviewer or a validator run. */
  readonly otherRunningAgents: number;
  readonly orchestratorBusy: boolean;
  /** Total number of review files, for the progress key. */
  readonly reviewCount: number;
  /**
   * Inbox messages from agents, for the progress key. Exclude what autopilot itself delivers (wakes,
   * resume prompts; wakes go out through pi.sendMessage, not the inbox) and orchestrator-originated
   * chatter: if a wake counted as progress, every stall wake would reset the stall count and
   * block-objective('stalled') could never fire.
   */
  readonly inboxCount: number;
  readonly memory: AutopilotMemory;
}

export type AutopilotWakeReason =
  | 'plan-milestone'
  | 'validation-failed'
  | 'feature-attempts-exhausted'
  | 'rebase-conflict'
  | 'blocker'
  | 'merge-blocked'
  | 'review-stuck'
  | 'validation-stuck'
  | 'stalled'
  | 'worker-idle'
  | 'worker-stopped';

/**
 * `continue`: the worker of an active feature is idle without TowerComplete, a blocker or an
 * unanswered message (not awaitingReply), with no unread findings and no rebase conflict. It is
 * resumed once per (mission, tip); idle again on that tip — or at once in manual mode — it becomes a
 * 'worker-idle' wake instead.
 */
export type AutopilotResumeReason = 'review-findings' | 'rebase-conflict' | 'continue';

export type AutopilotBlockReason = 'stalled' | 'milestone-blocked';

export type AutopilotPauseReason = 'max-wall-time' | 'max-cost';

export interface AutopilotSpawnWorker {
  readonly type: 'spawn-worker';
  readonly mission: string;
}

export interface AutopilotResumeWorker {
  readonly type: 'resume-worker';
  readonly mission: string;
  readonly worker: string;
  readonly reason: AutopilotResumeReason;
  /**
   * Dedupe key `resume-${reason}:${mission}:${revision}`; record it with the sent wake keys. The
   * revision is `${tip}#${reviewCount}` for review-findings, `${tip}@${baseTip}` for rebase-conflict
   * and `${tip}` for continue.
   */
  readonly key: string;
}

export interface AutopilotRespawnWorker {
  readonly type: 'respawn-worker';
  readonly mission: string;
  /** The attempt number this spawn becomes (attempts + 1). */
  readonly attempt: number;
  readonly previousWorker?: string;
}

export interface AutopilotSpawnReviewer {
  readonly type: 'spawn-reviewer';
  readonly mission: string;
}

export interface AutopilotRebase {
  readonly type: 'rebase';
  readonly mission: string;
}

export interface AutopilotMerge {
  readonly type: 'merge';
  readonly mission: string;
}

/**
 * Begin or continue validating `milestone` on `commit` for `kinds`: the milestone is (re-)stamped on
 * that commit, one validator spawns per LLM kind and the commands kind runs mechanically.
 * Empty `kinds` passes the milestone only when no kind is required. Otherwise (a stale final
 * milestone, no free slot, or every required kind already has a round on `commit`) it only
 * (re-)stamps the milestone on `commit`: missing kinds start on later ticks, and when every required
 * kind already passed there the store re-derives the milestone. The store decides the resulting status.
 */
export interface AutopilotStartValidation {
  readonly type: 'start-validation';
  readonly milestone: string;
  readonly commit: string;
  readonly kinds: readonly AutopilotValidationKind[];
}

/** Activate the current (pending) milestone; `from` is the milestone that passed before it. */
export interface AutopilotAdvanceMilestone {
  readonly type: 'advance-milestone';
  readonly milestone: string;
  readonly from?: string;
}

export interface AutopilotCompleteObjective {
  readonly type: 'complete-objective';
  readonly objective: string;
}

export interface AutopilotWakeOrchestrator {
  readonly type: 'wake-orchestrator';
  readonly reason: AutopilotWakeReason;
  /**
   * Mission id for feature wakes, milestone id for milestone wakes, `${milestone}:${kind}` for
   * validation-stuck, objective id for stalls.
   */
  readonly subject: string;
  readonly revision: string;
  /** Dedupe key `${reason}:${subject}:${revision}`; each key is sent once. */
  readonly key: string;
  readonly detail: string;
}

export interface AutopilotBlockObjective {
  readonly type: 'block-objective';
  readonly objective: string;
  readonly reason: AutopilotBlockReason;
  readonly detail: string;
}

export interface AutopilotPauseObjective {
  readonly type: 'pause-objective';
  readonly objective: string;
  readonly reason: AutopilotPauseReason;
  readonly detail: string;
}

export type AutopilotAction =
  | AutopilotSpawnWorker
  | AutopilotResumeWorker
  | AutopilotRespawnWorker
  | AutopilotSpawnReviewer
  | AutopilotRebase
  | AutopilotMerge
  | AutopilotStartValidation
  | AutopilotAdvanceMilestone
  | AutopilotCompleteObjective
  | AutopilotWakeOrchestrator
  | AutopilotBlockObjective
  | AutopilotPauseObjective;

export type AutopilotActionType = AutopilotAction['type'];

export interface AutopilotStall {
  /**
   * Start of the current quiet period, to persist as the memory's progressAt: now when the
   * progress key changed, while an agent, a validator run or the orchestrator is live, and after a
   * stall wake. Due actions do not restart it: an action that never takes effect still stalls.
   */
  readonly progressAt: number;
  /** How long the system had been quiet at this tick. */
  readonly idleMs: number;
  /** The stall condition held at this tick. */
  readonly stalled: boolean;
  /** Consecutive stall wakes to persist after executing the actions. */
  readonly stallWakes: number;
}

export interface AutopilotDecision {
  readonly actions: readonly AutopilotAction[];
  readonly progressKey: string;
  readonly stall: AutopilotStall;
}
