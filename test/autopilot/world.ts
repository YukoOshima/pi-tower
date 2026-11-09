import {
  latestRound,
  milestoneRequiredKinds,
  type AutopilotAction,
  type AutopilotDecision,
  type AutopilotGate,
  type AutopilotMilestone,
  type AutopilotMission,
  type AutopilotMissionStatus,
  type AutopilotObjective,
  type AutopilotReviewVerdict,
  type AutopilotSettings,
  type AutopilotSnapshot,
  type AutopilotValidationKind,
  type AutopilotValidationVerdict,
  type AutopilotValidatorRun,
  type AutopilotWakeOrchestrator,
  type AutopilotWorkerState,
} from '../../src/autopilot/index.ts';
import { SETTINGS } from './fixtures.ts';

export interface WorldFeature {
  readonly id: string;
  readonly milestone: string;
  readonly deps: string[];
  status: AutopilotMissionStatus;
  attempts: number;
  worker: AutopilotWorkerState;
  workerName?: string;
  commits: number;
  tip?: string;
  baseAt?: string;
  reviewRequested: boolean;
  reviewerRunning: boolean;
  review?: AutopilotReviewVerdict & { readonly commit: string };
  waiver?: { readonly from: string; readonly to: string };
  unreadFindings: boolean;
}

export interface WorldScript {
  readonly reviewVerdict: (feature: WorldFeature, reviewNumber: number) => string;
  readonly validationVerdict: (
    milestone: string,
    kind: AutopilotValidationKind,
    round: number,
  ) => AutopilotValidationVerdict;
  readonly plan: (milestone: string, reason: 'plan-milestone' | 'validation-failed') => WorldFeature[];
}

export class World {
  now = 1_000_000;
  baseTip = 'main-0';
  merges = 0;
  reviewCount = 0;
  inboxCount = 0;
  orchestratorBusy = false;
  objective: AutopilotObjective;
  features: WorldFeature[];
  validators: AutopilotValidatorRun[] = [];
  memory: AutopilotSnapshot['memory'] = { stallWakes: 0, wakeKeys: [] };
  readonly unexpected: string[] = [];
  readonly settings: AutopilotSettings;
  private readonly script: WorldScript;
  private readonly wakes: AutopilotWakeOrchestrator[] = [];
  private readonly reviews = new Map<string, number>();

  constructor(
    objective: AutopilotObjective,
    features: WorldFeature[],
    script: WorldScript,
    maxRunningAgents: number,
  ) {
    this.objective = objective;
    this.features = features;
    this.script = script;
    this.settings = { ...SETTINGS, maxRunningAgents };
  }

  snapshot(): AutopilotSnapshot {
    return {
      now: this.now,
      objective: this.objective,
      settings: this.settings,
      baseTip: this.baseTip,
      missions: this.features.map((feature) => this.mission(feature)),
      validators: [...this.validators],
      otherRunningAgents: 0,
      orchestratorBusy: this.orchestratorBusy,
      reviewCount: this.reviewCount,
      inboxCount: this.inboxCount,
      memory: this.memory,
    };
  }

  private reviewOnTip(feature: WorldFeature): AutopilotReviewVerdict | undefined {
    const review = feature.review;
    if (review === undefined || feature.tip === undefined) return undefined;
    const waived = feature.waiver?.from === review.commit && feature.waiver.to === feature.tip;
    return review.commit === feature.tip || waived ? { status: review.status, merge: review.merge } : undefined;
  }

  private gate(feature: WorldFeature): AutopilotGate {
    const blocked = (code: string): AutopilotGate => ({ ready: false, blocks: [code] });
    if (feature.status !== 'completed') return blocked('not-completed');
    if (feature.worker === 'running') return blocked('worker-busy');
    const open = feature.deps.filter((dep) => this.feature(dep).status !== 'merged');
    if (open.length > 0) return blocked('deps-unmerged');
    if (feature.baseAt !== this.baseTip) return blocked('stale-base');
    const review = this.reviewOnTip(feature);
    if (review === undefined) return blocked(feature.review === undefined ? 'no-review' : 'tip-moved');
    if (review.status !== 'clean') return blocked('not-clean');
    return { ready: true, blocks: [] };
  }

  private mission(feature: WorldFeature): AutopilotMission {
    const review = this.reviewOnTip(feature);
    return {
      id: feature.id,
      kind: 'build',
      status: feature.status,
      milestone: feature.milestone,
      deps: feature.deps,
      attempts: feature.attempts,
      ...(feature.tip === undefined ? {} : { tip: feature.tip }),
      worker: {
        state: feature.worker,
        ...(feature.workerName === undefined ? {} : { name: feature.workerName }),
        humanStopped: false,
        unreadFindings: feature.unreadFindings,
      },
      reviewRequestOnTip: feature.reviewRequested,
      reviewerRunning: feature.reviewerRunning,
      ...(review === undefined ? {} : { latestReviewOnTip: review }),
      gate: this.gate(feature),
      rebaseConflict: false,
      blockers: [],
    };
  }

  feature(id: string): WorldFeature {
    const found = this.features.find((feature) => feature.id === id);
    if (found === undefined) throw new Error(`unknown feature ${id}`);
    return found;
  }

  private setMilestone(id: string, patch: Partial<AutopilotMilestone>): void {
    this.objective = {
      ...this.objective,
      milestones: this.objective.milestones.map((ms) => (ms.id === id ? { ...ms, ...patch } : ms)),
    };
  }

  private milestone(id: string): AutopilotMilestone {
    const found = this.objective.milestones.find((ms) => ms.id === id);
    if (found === undefined) throw new Error(`unknown milestone ${id}`);
    return found;
  }

  apply(decision: AutopilotDecision): void {
    for (const action of decision.actions) this.applyAction(action);
    this.memory = {
      ...this.memory,
      progressKey: decision.progressKey,
      progressAt: decision.stall.progressAt,
      stallWakes: decision.stall.stallWakes,
    };
  }

  private remember(key: string): void {
    this.memory = { ...this.memory, wakeKeys: [...this.memory.wakeKeys, key] };
  }

  private applyAction(action: AutopilotAction): void {
    switch (action.type) {
      case 'spawn-worker':
      case 'respawn-worker': {
        const feature = this.feature(action.mission);
        feature.attempts += 1;
        feature.worker = 'running';
        feature.workerName = `w-${feature.id}-${String(feature.attempts)}`;
        if (feature.status === 'planned') feature.status = 'active';
        if (feature.baseAt === undefined) feature.baseAt = this.baseTip;
        return;
      }
      case 'resume-worker':
        this.remember(action.key);
        this.feature(action.mission).worker = 'running';
        return;
      case 'spawn-reviewer':
        this.feature(action.mission).reviewerRunning = true;
        return;
      case 'rebase': {
        const feature = this.feature(action.mission);
        const from = feature.tip!;
        feature.tip = `${from}+r`;
        feature.baseAt = this.baseTip;
        if (feature.review?.commit === from) feature.waiver = { from, to: feature.tip };
        return;
      }
      case 'merge':
        this.feature(action.mission).status = 'merged';
        this.merges += 1;
        this.baseTip = `main-${String(this.merges)}`;
        return;
      case 'start-validation':
        this.setMilestone(action.milestone, { status: action.kinds.length === 0 ? 'passed' : 'validating' });
        for (const kind of action.kinds) {
          this.validators.push({ milestone: action.milestone, kind, commit: action.commit });
        }
        return;
      case 'advance-milestone':
        this.setMilestone(action.milestone, { status: 'active' });
        return;
      case 'complete-objective':
        this.objective = { ...this.objective, status: 'completed' };
        return;
      case 'wake-orchestrator':
        this.remember(action.key);
        this.orchestratorBusy = true;
        this.wakes.push(action);
        return;
      case 'block-objective':
      case 'pause-objective':
        this.unexpected.push(`${action.type}: ${action.detail}`);
        this.objective = { ...this.objective, status: action.type === 'block-objective' ? 'blocked' : 'paused' };
        return;
    }
  }

  agentsAct(): void {
    for (const feature of this.features) {
      if (feature.worker === 'running') this.workerTurn(feature);
    }
    for (const feature of this.features) {
      if (feature.reviewerRunning) this.reviewerTurn(feature);
    }
    const runs = this.validators.splice(0);
    for (const run of runs) this.validatorTurn(run);
    for (const wake of this.wakes.splice(0)) this.orchestratorTurn(wake);
    this.orchestratorBusy = false;
    this.now += 60_000;
  }

  private workerTurn(feature: WorldFeature): void {
    feature.commits += 1;
    feature.tip = `${feature.id}-c${String(feature.commits)}`;
    feature.worker = 'idle';
    feature.unreadFindings = false;
    feature.status = 'completed';
    feature.reviewRequested = true;
    this.inboxCount += 1;
  }

  private reviewerTurn(feature: WorldFeature): void {
    const count = (this.reviews.get(feature.id) ?? 0) + 1;
    this.reviews.set(feature.id, count);
    const status = this.script.reviewVerdict(feature, count);
    feature.review = { status, merge: status === 'clean' ? 'merge' : 'hold', commit: feature.tip! };
    feature.reviewerRunning = false;
    feature.reviewRequested = false;
    this.reviewCount += 1;
    if (status !== 'clean') {
      feature.status = 'active';
      feature.unreadFindings = true;
    }
  }

  private validatorTurn(run: AutopilotValidatorRun): void {
    const milestone = this.milestone(run.milestone);
    const round = milestone.rounds.filter((existing) => existing.kind === run.kind).length + 1;
    const verdict = this.script.validationVerdict(run.milestone, run.kind, round);
    const rounds = [...milestone.rounds, { kind: run.kind, round, commit: run.commit, verdict }];
    const updated = { ...milestone, rounds };
    const kinds = milestoneRequiredKinds(this.objective, updated, this.settings);
    const verdicts = kinds.map((kind) => latestRound(updated, kind, run.commit)?.verdict);
    const status = verdicts.includes('fail')
      ? 'failed'
      : verdicts.every((value) => value === 'pass')
        ? 'passed'
        : milestone.status;
    this.setMilestone(run.milestone, { rounds, status });
    this.inboxCount += 1;
  }

  private orchestratorTurn(wake: AutopilotWakeOrchestrator): void {
    if (wake.reason !== 'plan-milestone' && wake.reason !== 'validation-failed') {
      this.unexpected.push(`wake ${wake.key}`);
      return;
    }
    this.features.push(...this.script.plan(wake.subject, wake.reason));
    if (this.milestone(wake.subject).status === 'failed') this.setMilestone(wake.subject, { status: 'active' });
  }
}

export function plannedFeature(id: string, milestone: string, deps: string[] = []): WorldFeature {
  return {
    id,
    milestone,
    deps,
    status: 'planned',
    attempts: 0,
    worker: 'none',
    commits: 0,
    reviewRequested: false,
    reviewerRunning: false,
    unreadFindings: false,
  };
}
