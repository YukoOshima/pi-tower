import {
  decideAutopilot,
  digest,
  type AutopilotAction,
  type AutopilotDecision,
  type AutopilotSnapshot,
  type AutopilotValidatorRun,
} from '../../autopilot/index.ts';
import {
  sortedMilestones,
  type TowerObjective,
  type TowerState,
  type TowerStore,
} from '../../protocol/index.ts';
import { approvalRequest } from '../../prompts/objectiveWakes.ts';
import {
  runCommandsValidation,
  type CommandsValidationOutcome,
  type CommandsValidationRequest,
} from './commandsRunner.ts';
import {
  autopilotActionIdentity,
  autopilotActionMission,
  autopilotActionSubject,
  executeAutopilotAction,
  type AutopilotExecution,
  type AutopilotLaunch,
} from './executor.ts';
import {
  buildAutopilotSnapshot,
  observeAutopilotWorld,
  validationSettings,
  type AutopilotPendingWork,
  type AutopilotWorld,
} from './snapshot.ts';
import { planningStallWake, refusedActionWake, skipKinds } from './texts.ts';
import type {
  AutopilotEffects,
  AutopilotLog,
  AutopilotObservations,
  AutopilotTimers,
  EffectResult,
} from './types.ts';

export const AUTOPILOT_ACTOR = 'autopilot';
export const REFUSED_ACTION_WAKE_THRESHOLD = 3;

export interface AutopilotRunnerDeps {
  readonly observations: AutopilotObservations;
  readonly effects: AutopilotEffects;
  readonly timers?: AutopilotTimers;
  readonly log?: AutopilotLog;
  readonly commandTimeoutMs?: number;
  readonly commandEnv?: NodeJS.ProcessEnv;
  readonly runCommands?: (
    store: TowerStore,
    request: CommandsValidationRequest,
  ) => Promise<CommandsValidationOutcome>;
}

interface PendingLaunch {
  readonly launch: AutopilotLaunch;
  readonly type: AutopilotAction['type'];
  readonly subject: string;
  readonly tick: number;
}

interface CommandsRun {
  readonly milestone: string;
  readonly commit: string;
  readonly controller: AbortController;
}

interface Refusal {
  readonly type: string;
  readonly subject: string;
  count: number;
  tick: number;
  error: string;
}

const DEFAULT_TIMERS: AutopilotTimers = {
  setInterval: (callback, ms) => {
    const handle = setInterval(callback, ms);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => {
    clearInterval(handle as NodeJS.Timeout);
  },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function actionDetails(action: AutopilotAction): Record<string, string | number | undefined> {
  switch (action.type) {
    case 'spawn-worker':
    case 'spawn-reviewer':
    case 'rebase':
    case 'merge':
      return { mission: action.mission };
    case 'respawn-worker':
      return { mission: action.mission, attempt: action.attempt, previous: action.previousWorker };
    case 'resume-worker':
      return { mission: action.mission, worker: action.worker, reason: action.reason };
    case 'start-validation':
      return {
        milestone: action.milestone,
        commit: action.commit.slice(0, 7),
        kinds: action.kinds.length > 0 ? action.kinds.join(',') : 'none',
      };
    case 'advance-milestone':
      return { milestone: action.milestone, from: action.from };
    case 'complete-objective':
      return { objective: action.objective };
    case 'block-objective':
    case 'pause-objective':
      return { objective: action.objective, reason: action.reason };
    case 'wake-orchestrator':
      return { reason: action.reason, subject: action.subject };
  }
}

export function planningProgressKey(state: TowerState): string {
  const objective = state.objective;
  return digest(
    JSON.stringify({
      objective: objective === undefined ? null : { ...objective, autopilot: undefined },
      missions: state.missions.map((mission) => [mission.id, mission.status, mission.milestone ?? '', mission.tasks.length]),
    }),
  );
}

export class AutopilotRunner {
  private readonly observations: AutopilotObservations;
  private readonly effects: AutopilotEffects;
  private readonly timers: AutopilotTimers;
  private readonly log: AutopilotLog | undefined;
  private readonly deps: AutopilotRunnerDeps;
  private active = false;
  private timer: unknown;
  private reasons: string[] = [];
  private loop: Promise<void> | undefined;
  private ticks = 0;
  private readonly launches = new Map<string, PendingLaunch>();
  private readonly commandRuns = new Map<string, CommandsRun>();
  private readonly background = new Set<Promise<void>>();
  private readonly refusals = new Map<string, Refusal>();
  private cost: { readonly objectiveId: string; readonly total: number } | undefined;
  private planning: { readonly objectiveId: string; readonly key: string; readonly since: number } | undefined;

  constructor(deps: AutopilotRunnerDeps) {
    this.deps = deps;
    this.observations = deps.observations;
    this.effects = deps.effects;
    this.timers = deps.timers ?? DEFAULT_TIMERS;
    this.log = deps.log;
  }

  get started(): boolean {
    return this.active;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.timer = this.timers.setInterval(() => {
      void this.tick('watchdog');
    }, this.observations.settings().watchdogIntervalMs);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.reasons = [];
    if (this.timer !== undefined) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const run of this.commandRuns.values()) run.controller.abort();
  }

  tick(reason: string): Promise<void> {
    if (!this.active) return Promise.resolve();
    this.reasons.push(reason);
    this.loop ??= this.drain();
    return this.loop;
  }

  async whenIdle(): Promise<void> {
    for (;;) {
      const waiting: Promise<void>[] = [...this.background];
      if (this.loop !== undefined) waiting.push(this.loop);
      if (waiting.length === 0) return;
      await Promise.allSettled(waiting);
    }
  }

  pendingWork(): AutopilotPendingWork {
    const launches = [...this.launches.values()].map((pending) => pending.launch);
    const commands = [...this.commandRuns.values()].map(
      (run): AutopilotValidatorRun => ({ milestone: run.milestone, kind: 'commands', commit: run.commit }),
    );
    return {
      agents: launches.filter((launch) => launch.validator === undefined).map((launch) => launch.agent),
      validators: [
        ...launches.flatMap((launch) => (launch.validator === undefined ? [] : [launch.validator])),
        ...commands,
      ],
    };
  }

  private async drain(): Promise<void> {
    try {
      while (this.reasons.length > 0) {
        const batch = this.reasons.splice(0);
        if (this.active) await this.runTick(batch);
      }
    } finally {
      this.loop = undefined;
    }
  }

  private track(promise: Promise<void>): void {
    this.background.add(promise);
    void promise.finally(() => {
      this.background.delete(promise);
    });
  }

  private async activity(
    store: TowerStore,
    action: string,
    details: Readonly<Record<string, string | number | undefined>>,
  ): Promise<void> {
    try {
      await store.appendLog(AUTOPILOT_ACTOR, action, details);
    } catch (error) {
      this.log?.warn('tower autopilot could not append its activity log', { action, error: errorMessage(error) });
    }
  }

  private async runTick(reasons: readonly string[]): Promise<void> {
    this.ticks += 1;
    try {
      const store = this.observations.store();
      const state = await store.load();
      const objective = state.objective;
      if (objective === undefined) return;
      if (this.cost?.objectiveId !== objective.id) {
        this.cost = { objectiveId: objective.id, total: this.observations.totalCostUsd() };
        this.refusals.clear();
      }
      switch (objective.status) {
        case 'awaiting-approval':
          await this.awaitingApproval(store, state, objective);
          return;
        case 'planning':
          await this.planningTick(store, state, objective);
          return;
        case 'executing':
          await this.executingTick(store, state);
          return;
        default:
          this.refusals.clear();
          this.planning = undefined;
      }
    } catch (error) {
      this.log?.warn('tower autopilot tick failed', { reasons: reasons.join(','), error: errorMessage(error) });
    }
  }

  private async awaitingApproval(store: TowerStore, state: TowerState, objective: TowerObjective): Promise<void> {
    const settings = this.observations.settings();
    const request = approvalRequest({
      objective,
      milestones: sortedMilestones(objective),
      features: state.missions.filter((mission) => mission.status !== 'abandoned'),
      ...(objective.approvalReason === undefined ? {} : { approvalReason: objective.approvalReason }),
      notes: objective.notes,
      skipKinds: skipKinds(settings),
    });
    const sent = new Set(objective.autopilot?.wakeKeys ?? []);
    if (settings.autoApprove) {
      try {
        await store.approveObjective('auto');
      } catch (error) {
        const refusal = errorMessage(error);
        const key = `approval-refused:${objective.id}:${digest(`${refusal}\n${request}`)}`;
        if (sent.has(key)) return;
        this.effects.notifyHuman(
          `Automatic approval of objective ${objective.id} "${objective.title}" was refused: ${refusal}\nA human approval is needed.\n\n${request}`,
          'warning',
        );
        await store.updateObjectiveAutopilot({ addWakeKeys: [key] });
        await this.activity(store, 'notify-human', { objective: objective.id, reason: 'approval-refused' });
        return;
      }
      await this.activity(store, 'approve', { objective: objective.id, by: 'auto' });
      this.effects.notifyHuman(
        `Objective ${objective.id} "${objective.title}" was approved automatically (autoApprove) — the autopilot starts executing it.`,
        'info',
      );
      const approved = await store.load();
      if (approved.objective?.status === 'executing') await this.executingTick(store, approved);
      return;
    }
    const key = `approval:${objective.id}:${digest(request)}`;
    if (sent.has(key)) return;
    this.effects.notifyHuman(request, 'info');
    await store.updateObjectiveAutopilot({ addWakeKeys: [key] });
    await this.activity(store, 'notify-human', { objective: objective.id, reason: 'approval' });
  }

  private async planningTick(store: TowerStore, state: TowerState, objective: TowerObjective): Promise<void> {
    if (!this.observations.headless(state)) {
      this.planning = undefined;
      return;
    }
    const now = this.observations.now();
    const key = planningProgressKey(state);
    const planning = this.planning;
    if (
      planning === undefined ||
      planning.objectiveId !== objective.id ||
      planning.key !== key ||
      this.observations.orchestratorBusy()
    ) {
      this.planning = { objectiveId: objective.id, key, since: now };
      return;
    }
    const quietMs = now - planning.since;
    if (quietMs < this.observations.settings().stallTimeoutMs) return;
    const wakeKey = `planning-stalled:${objective.id}:${key}`;
    if ((objective.autopilot?.wakeKeys ?? []).includes(wakeKey)) return;
    this.effects.wakeOrchestrator(planningStallWake(objective, quietMs));
    await store.updateObjectiveAutopilot({ addWakeKeys: [wakeKey] });
    await this.activity(store, 'wake-orchestrator', { reason: 'planning-stalled', subject: objective.id });
  }

  private async recordUsage(store: TowerStore, objective: TowerObjective): Promise<boolean> {
    const total = this.observations.totalCostUsd();
    const baseline = this.cost?.objectiveId === objective.id ? this.cost.total : total;
    this.cost = { objectiveId: objective.id, total };
    const delta = total - baseline;
    if (!Number.isFinite(delta) || delta <= 0) return false;
    await store.recordObjectiveUsage(delta);
    return true;
  }

  private async executingTick(store: TowerStore, loaded: TowerState): Promise<void> {
    const objective = loaded.objective!;
    const state = (await this.recordUsage(store, objective)) ? await store.load() : loaded;
    if (state.objective?.status !== 'executing') return;
    const world = await observeAutopilotWorld({
      store,
      observations: this.observations,
      state,
      pending: this.pendingWork(),
    });
    const snapshot = buildAutopilotSnapshot(world);
    const decision = decideAutopilot(snapshot);
    const decided = new Set(decision.actions.map(autopilotActionIdentity));
    for (const identity of [...this.refusals.keys()]) {
      if (!decided.has(identity)) this.refusals.delete(identity);
    }
    const tick = this.ticks;
    const reserved = new Set(this.launches.keys());
    const wakeKeys: string[] = [];
    let current: AutopilotAction | undefined;
    let launchedByCurrent = 0;
    const execution: AutopilotExecution = {
      store,
      effects: this.effects,
      world,
      snapshot,
      decision,
      reserved,
      launch: (launch) => {
        reserved.add(launch.agent);
        launchedByCurrent += 1;
        this.startLaunch(store, launch, current!, tick);
      },
      runCommands: (milestoneId, commit) => {
        launchedByCurrent += 1;
        this.startCommands(store, world, milestoneId, commit);
      },
    };
    for (const action of decision.actions) {
      const mission = autopilotActionMission(action);
      if (mission !== undefined && this.missionPending(mission)) continue;
      current = action;
      launchedByCurrent = 0;
      const identity = autopilotActionIdentity(action);
      const outcome = await executeAutopilotAction(execution, action);
      if (outcome.status === 'refused') {
        this.refuse(identity, action.type, autopilotActionSubject(action), outcome.error, tick);
      } else if (outcome.status === 'done' && launchedByCurrent === 0) {
        this.refusals.delete(identity);
      }
      if (outcome.status === 'done' && outcome.wakeKey !== undefined) wakeKeys.push(outcome.wakeKey);
      await this.activity(store, action.type, {
        ...actionDetails(action),
        result: outcome.status,
        ...(outcome.status === 'refused'
          ? { error: outcome.error.slice(0, 300) }
          : outcome.detail === undefined
            ? {}
            : { detail: outcome.detail }),
      });
    }
    wakeKeys.push(...(await this.refusedWakes(store, snapshot, wakeKeys)));
    await this.persistMemory(store, snapshot, decision, wakeKeys);
  }

  private missionPending(missionId: string): boolean {
    return [...this.launches.values()].some((pending) => pending.launch.mission === missionId);
  }

  private refuse(identity: string, type: string, subject: string, error: string, tick: number): void {
    const existing = this.refusals.get(identity);
    if (existing === undefined) {
      this.refusals.set(identity, { type, subject, count: 1, tick, error });
      return;
    }
    existing.error = error;
    if (existing.tick === tick) return;
    existing.count += 1;
    existing.tick = tick;
  }

  private async refusedWakes(
    store: TowerStore,
    snapshot: AutopilotSnapshot,
    sentThisTick: readonly string[],
  ): Promise<string[]> {
    const sent = new Set([...snapshot.memory.wakeKeys, ...sentThisTick]);
    const keys: string[] = [];
    for (const [identity, refusal] of this.refusals) {
      if (refusal.count < REFUSED_ACTION_WAKE_THRESHOLD) continue;
      const key = `refused:${identity}:${digest(refusal.error.replaceAll(/\d+/g, '#'))}`;
      if (sent.has(key)) continue;
      sent.add(key);
      keys.push(key);
      this.effects.wakeOrchestrator(
        refusedActionWake({ type: refusal.type, subject: refusal.subject, error: refusal.error, attempts: refusal.count }),
      );
      await this.activity(store, 'wake-orchestrator', { reason: 'refused', subject: identity, attempts: refusal.count });
    }
    return keys;
  }

  private async persistMemory(
    store: TowerStore,
    snapshot: AutopilotSnapshot,
    decision: AutopilotDecision,
    wakeKeys: readonly string[],
  ): Promise<void> {
    const { memory } = snapshot;
    const { stall } = decision;
    if (
      memory.progressKey === decision.progressKey &&
      memory.progressAt === stall.progressAt &&
      memory.stallWakes === stall.stallWakes &&
      wakeKeys.length === 0
    ) {
      return;
    }
    await store.updateObjectiveAutopilot({
      progressKey: decision.progressKey,
      progressAt: new Date(stall.progressAt).toISOString(),
      stallWakes: stall.stallWakes,
      ...(wakeKeys.length === 0 ? {} : { addWakeKeys: wakeKeys }),
    });
  }

  private startLaunch(store: TowerStore, launch: AutopilotLaunch, action: AutopilotAction, tick: number): void {
    const pending: PendingLaunch = { launch, type: action.type, subject: autopilotActionSubject(action), tick };
    this.launches.set(launch.agent, pending);
    const run = async (): Promise<void> => {
      let result: EffectResult;
      try {
        result = await launch.start();
      } catch (error) {
        result = { ok: false, error: errorMessage(error) };
      }
      this.launches.delete(launch.agent);
      if (result.ok) {
        if (action.type !== 'start-validation') this.refusals.delete(launch.identity);
        if (launch.wakeKey !== undefined) {
          try {
            await store.updateObjectiveAutopilot({ addWakeKeys: [launch.wakeKey] });
          } catch (error) {
            this.log?.warn('tower autopilot could not record a resume key', { key: launch.wakeKey, error: errorMessage(error) });
          }
        }
      } else {
        this.refuse(launch.identity, pending.type, pending.subject, result.error, tick);
      }
      await this.activity(store, action.type, {
        ...actionDetails(action),
        name: launch.agent,
        result: result.ok ? 'started' : 'refused',
        ...(result.ok
          ? result.detail === undefined
            ? {}
            : { detail: result.detail }
          : { error: result.error.slice(0, 300) }),
      });
    };
    this.track(run());
  }

  private startCommands(store: TowerStore, world: AutopilotWorld, milestoneId: string, commit: string): void {
    if (this.commandRuns.has(milestoneId)) return;
    const controller = new AbortController();
    this.commandRuns.set(milestoneId, { milestone: milestoneId, commit, controller });
    const runCommands = this.deps.runCommands ?? runCommandsValidation;
    const run = async (): Promise<void> => {
      try {
        const outcome = await runCommands(store, {
          milestoneId,
          settings: validationSettings(world.settings),
          signal: controller.signal,
          ...(this.deps.commandTimeoutMs === undefined ? {} : { timeoutMs: this.deps.commandTimeoutMs }),
          ...(this.deps.commandEnv === undefined ? {} : { env: this.deps.commandEnv }),
        });
        if (outcome.cleanupError !== undefined) this.log?.warn(outcome.cleanupError);
        await this.activity(store, 'commands', {
          milestone: milestoneId,
          commit: outcome.commit.slice(0, 7),
          result: outcome.status,
          ...(outcome.status === 'submitted'
            ? { round: outcome.round.round, verdict: outcome.round.verdict, revision: outcome.contractRevision }
            : outcome.status === 'skipped'
              ? { detail: outcome.reason }
              : {}),
        });
      } catch (error) {
        this.log?.warn('tower autopilot commands validation failed', { milestone: milestoneId, error: errorMessage(error) });
        await this.activity(store, 'commands', {
          milestone: milestoneId,
          commit: commit.slice(0, 7),
          result: 'failed',
          error: errorMessage(error).slice(0, 300),
        });
      } finally {
        this.commandRuns.delete(milestoneId);
      }
    };
    this.track(run());
  }
}
