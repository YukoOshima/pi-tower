import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  WORKTREES_DIR,
  contractRevisionOf,
  type TowerPlanInput,
  type TowerState,
  type TowerStore,
} from '../../../src/protocol/index.ts';
import { validationSettings } from '../../../src/tower/autopilot/snapshot.ts';
import type {
  AutopilotAgentObservation,
  AutopilotAgentStatus,
  AutopilotEffects,
  AutopilotLog,
  AutopilotObservations,
  AutopilotRuntimeSettings,
  AutopilotTimers,
  AutopilotValidatorKind,
  EffectResult,
} from '../../../src/tower/autopilot/types.ts';
import { git } from './repo.ts';

export const T0 = Date.parse('2026-11-09T10:00:00.000Z');

export const SIM_SETTINGS: AutopilotRuntimeSettings = {
  autopilot: true,
  autoApprove: false,
  maxValidationRounds: 3,
  maxFeatureAttempts: 3,
  skipScrutiny: false,
  skipUserTesting: false,
  maxRunningAgents: 4,
  watchdogIntervalMs: 60_000,
  stallTimeoutMs: 180_000,
  maxStallWakes: 3,
};

export interface SimAgent {
  readonly agentId: string;
  readonly name: string;
  readonly kind: 'worker' | 'reviewer' | 'validator';
  readonly mission?: string;
  readonly milestone?: string;
  readonly validationKind?: AutopilotValidatorKind;
  readonly worktree?: string;
  status: AutopilotAgentStatus;
  stopReason?: string;
  turns: number;
}

export interface SimScript {
  /** File and content a worker commits on its turn; undefined commits nothing. */
  work(missionTitle: string, turn: number): { readonly file: string; readonly content: string } | undefined;
  review(missionId: string, reviewNumber: number): string;
  validate(milestone: string, kind: AutopilotValidatorKind, round: number): 'pass' | 'fail';
  orchestrate(text: string, state: TowerState): readonly TowerPlanInput[] | undefined;
}

export class FakeTimers implements AutopilotTimers {
  callback: (() => void) | undefined;
  intervalMs: number | undefined;
  cleared = 0;

  setInterval(callback: () => void, ms: number): unknown {
    this.callback = callback;
    this.intervalMs = ms;
    return 'timer';
  }

  clearInterval(): void {
    this.callback = undefined;
    this.cleared += 1;
  }

  fire(): void {
    this.callback?.();
  }
}

export class RecordingLog implements AutopilotLog {
  readonly warnings: string[] = [];

  info(): void {
    return;
  }

  warn(message: string, payload?: Readonly<Record<string, unknown>>): void {
    this.warnings.push(`${message}${payload === undefined ? '' : ` ${JSON.stringify(payload)}`}`);
  }
}

export class FakeTower implements AutopilotObservations, AutopilotEffects {
  clock = T0;
  busy = false;
  headlessMode = false;
  cost = 0;
  settingsValue: AutopilotRuntimeSettings;
  readonly agents = new Map<string, SimAgent>();
  readonly calls: string[] = [];
  readonly wakes: string[] = [];
  readonly notices: Array<{ readonly text: string; readonly level: string }> = [];
  readonly unexpected: string[] = [];
  readonly refuse = new Map<string, string>();
  private readonly pendingWakes: string[] = [];
  private readonly reviewsByMission = new Map<string, number>();
  private readonly towerStore: TowerStore;
  private readonly script: SimScript;

  constructor(store: TowerStore, script: SimScript, settings: Partial<AutopilotRuntimeSettings> = {}) {
    this.towerStore = store;
    this.script = script;
    this.settingsValue = { ...SIM_SETTINGS, ...settings };
  }

  now(): number {
    return this.clock;
  }

  store(): TowerStore {
    return this.towerStore;
  }

  settings(): AutopilotRuntimeSettings {
    return this.settingsValue;
  }

  agent(agentId: string): AutopilotAgentObservation | undefined {
    const agent = this.agents.get(agentId);
    if (agent === undefined) return undefined;
    return { status: agent.status, ...(agent.stopReason === undefined ? {} : { stopReason: agent.stopReason }) };
  }

  orchestratorBusy(): boolean {
    return this.busy;
  }

  headless(state: TowerState): boolean {
    return this.headlessMode && state.objective !== undefined;
  }

  totalCostUsd(): number {
    return this.cost;
  }

  running(): Set<string> {
    return new Set([...this.agents.values()].filter((agent) => agent.status === 'running').map((agent) => agent.agentId));
  }

  runningCount(): number {
    return this.running().size;
  }

  private refused(call: string): EffectResult | undefined {
    const error = this.refuse.get(call.split(' ')[0]!);
    return error === undefined ? undefined : { ok: false, error };
  }

  private add(agent: Omit<SimAgent, 'status' | 'turns'>): void {
    this.agents.set(agent.agentId, { ...agent, status: 'running', turns: 0 });
  }

  async spawnWorker(missionId: string, name: string): Promise<EffectResult> {
    this.calls.push(`spawnWorker ${missionId} ${name}`);
    return this.refused('spawnWorker') ?? this.startWorker(missionId, name);
  }

  async respawnWorker(missionId: string, name: string, reason: string): Promise<EffectResult> {
    this.calls.push(`respawnWorker ${missionId} ${name} ${reason}`);
    return this.refused('respawnWorker') ?? this.startWorker(missionId, name);
  }

  private async startWorker(missionId: string, name: string): Promise<EffectResult> {
    const store = this.towerStore;
    const state = await store.load();
    const mission = state.missions.find((candidate) => candidate.id === missionId)!;
    const added = await store.addWorktree(mission.worktree, mission.branch, state.base);
    if (added.spawnBase !== undefined) {
      await store.updateMission('tower', mission.id, { spawnBase: added.spawnBase }, { silent: true });
    }
    const agentId = `agent-${name}`;
    this.add({ agentId, name, kind: 'worker', mission: mission.id, worktree: mission.worktree });
    await store.registerSpawnedAgent(
      {
        name,
        agentId,
        kind: 'worker',
        missionId: mission.id,
        worktree: mission.worktree,
        branch: mission.branch,
        cwd: store.abs(join(WORKTREES_DIR, mission.worktree)),
        spawnedAt: new Date().toISOString(),
      },
      { id: mission.id, owner: name },
    );
    return { ok: true };
  }

  async resumeWorker(agentName: string, prompt: string): Promise<EffectResult> {
    this.calls.push(`resumeWorker ${agentName} ${prompt.split(':')[0]!}`);
    const refusal = this.refused('resumeWorker');
    if (refusal !== undefined) return refusal;
    const agent = [...this.agents.values()].find((candidate) => candidate.name === agentName);
    if (agent === undefined || agent.status !== 'idle') return { ok: false, error: `agent ${agentName} is not idle` };
    agent.status = 'running';
    return { ok: true };
  }

  async spawnReviewer(missionId: string, name: string): Promise<EffectResult> {
    this.calls.push(`spawnReviewer ${missionId} ${name}`);
    const refusal = this.refused('spawnReviewer');
    if (refusal !== undefined) return refusal;
    const store = this.towerStore;
    const mission = (await store.load()).missions.find((candidate) => candidate.id === missionId)!;
    const agentId = `agent-${name}`;
    this.add({ agentId, name, kind: 'reviewer', mission: missionId });
    await store.registerSpawnedAgent({
      name,
      agentId,
      kind: 'reviewer',
      reviewTarget: mission.branch,
      reviewMissionId: missionId,
      cwd: store.repoRoot,
      spawnedAt: new Date().toISOString(),
    });
    return { ok: true };
  }

  async rebase(missionId: string): Promise<EffectResult> {
    this.calls.push(`rebase ${missionId}`);
    const refusal = this.refused('rebase');
    if (refusal !== undefined) return refusal;
    try {
      const result = await this.towerStore.rebaseMission('tower', missionId, { activeAgentIds: this.running() });
      return { ok: true, detail: result.status };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async merge(missionId: string): Promise<EffectResult> {
    this.calls.push(`merge ${missionId}`);
    const refusal = this.refused('merge');
    if (refusal !== undefined) return refusal;
    try {
      const mission = (await this.towerStore.load()).missions.find((candidate) => candidate.id === missionId)!;
      const result = await this.towerStore.merge(mission.branch, { activeAgentIds: this.running() });
      return { ok: true, detail: result.status };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async spawnValidator(milestoneId: string, kind: AutopilotValidatorKind, name: string): Promise<EffectResult> {
    this.calls.push(`spawnValidator ${milestoneId} ${kind} ${name}`);
    const refusal = this.refused('spawnValidator');
    if (refusal !== undefined) return refusal;
    const store = this.towerStore;
    const state = await store.load();
    const prepared = await store.prepareValidationWorktree(milestoneId, kind);
    const agentId = `agent-${name}`;
    this.add({ agentId, name, kind: 'validator', milestone: milestoneId, validationKind: kind, worktree: prepared.worktree });
    await store.registerSpawnedAgent({
      name,
      agentId,
      kind: 'validator',
      milestoneId,
      validationKind: kind,
      validationRound: prepared.round,
      validatedCommit: prepared.commit,
      worktree: prepared.worktree,
      cwd: prepared.path,
      spawnedAt: new Date().toISOString(),
      contractRevision: contractRevisionOf(state.objective!),
    });
    return { ok: true };
  }

  wakeOrchestrator(text: string): void {
    this.calls.push(`wake ${text.split(':')[0]!}`);
    this.wakes.push(text);
    this.pendingWakes.push(text);
    this.busy = true;
  }

  notifyHuman(text: string, level: 'info' | 'warning' | 'error'): void {
    this.calls.push(`notify ${level}`);
    this.notices.push({ text, level });
  }

  async actAll(): Promise<void> {
    for (const agent of [...this.agents.values()]) {
      if (agent.status !== 'running') continue;
      agent.turns += 1;
      if (agent.kind === 'worker') await this.workerTurn(agent);
      else if (agent.kind === 'reviewer') await this.reviewerTurn(agent);
      else await this.validatorTurn(agent);
    }
    await this.orchestratorTurn();
  }

  private async workerTurn(agent: SimAgent): Promise<void> {
    const store = this.towerStore;
    const state = await store.load();
    const mission = state.missions.find((candidate) => candidate.id === agent.mission)!;
    const unread = await store.readUnreadInbox(agent.name, 100);
    if (unread.length > 0) await store.ackInbox(agent.name, unread.map((item) => item.messageId));
    const work = this.script.work(mission.title, agent.turns);
    if (work !== undefined) {
      const worktree = store.abs(join(WORKTREES_DIR, mission.worktree));
      await mkdir(dirname(join(worktree, work.file)), { recursive: true });
      await writeFile(join(worktree, work.file), work.content);
      await git(worktree, 'add', work.file);
      await git(worktree, 'commit', '-m', `${mission.id} turn ${String(agent.turns)}`);
    }
    for (const task of mission.tasks.filter((candidate) => !candidate.done && candidate.dropped !== true)) {
      await store.updateMission(agent.name, mission.id, { taskDone: task.text });
    }
    await store.complete(agent.name, `${mission.id} done (turn ${String(agent.turns)})`);
    agent.status = 'idle';
  }

  private async reviewerTurn(agent: SimAgent): Promise<void> {
    const store = this.towerStore;
    const mission = (await store.load()).missions.find((candidate) => candidate.id === agent.mission)!;
    const count = (this.reviewsByMission.get(mission.id) ?? 0) + 1;
    this.reviewsByMission.set(mission.id, count);
    const status = this.script.review(mission.id, count);
    await store.submitReview(agent.name, {
      target: mission.branch,
      status,
      merge: status === 'clean' ? 'merge' : 'fix-then-merge',
      findings: status === 'clean' ? 'none' : '1. the value is not final yet',
      decision: status === 'clean' ? 'looks right' : 'needs a fix',
    });
    agent.status = 'completed';
  }

  private async validatorTurn(agent: SimAgent): Promise<void> {
    const store = this.towerStore;
    const state = await store.load();
    const milestone = state.objective!.milestones.find((candidate) => candidate.id === agent.milestone)!;
    const kind = agent.validationKind!;
    const round = milestone.rounds.filter((candidate) => candidate.kind === kind).length + 1;
    const verdict = this.script.validate(milestone.id, kind, round);
    await store.submitValidation(
      agent.name,
      {
        milestone: milestone.id,
        kind,
        verdict,
        failures: verdict === 'fail' ? [`${kind} found a problem in round ${String(round)}`] : [],
        checks: ['looked at it'],
        evidence: 'simulated',
      },
      validationSettings(this.settingsValue),
    );
    agent.status = 'completed';
    await store.removeValidationWorktree(agent.worktree!);
  }

  private async orchestratorTurn(): Promise<void> {
    const store = this.towerStore;
    for (const text of this.pendingWakes.splice(0)) {
      const plan = this.script.orchestrate(text, await store.load());
      if (plan === undefined) {
        this.unexpected.push(text.split('\n')[0]!);
        continue;
      }
      if (plan.length > 0) await store.plan(plan, validationSettings(this.settingsValue));
    }
    this.busy = false;
  }
}
