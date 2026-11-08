import type {
  AgentSettledEvent,
  AfterProviderResponseEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';

import {
  TOWER_WORKER_ROLE,
  formatGateDigestLine,
  renderAgentNotification,
  renderInboxWake,
  wakeDigestTargets,
  type TowerAgentEndStatus as NotificationEndStatus,
} from '../prompts/index.ts';
import {
  BROADCAST_NAME,
  TOWER_GIT_CONCURRENCY,
  TOWER_NAME,
  TowerProtocolError,
  TowerStore,
  assertLocalBaseBranch,
  branchExists,
  checkoutNewLocalBranch,
  commitPaths,
  listBaseDirtyEntries,
  mapWithConcurrency,
  resolveTowerRepoRoot,
  type TowerAgentKind,
} from '../protocol/index.ts';
import { createTowerSpawnTool } from '../tools/spawn/spawnTool.ts';
import {
  ORCHESTRATOR_CALLER,
  toToolDefinition,
  type TowerInboxSentPayload,
  type TowerLaunchRequest,
  type TowerOwner,
  type TowerSpawnModelResolution,
  type TowerToolHost,
} from '../tools/support.ts';
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  HUMAN_STOP_REASON,
  SHUTDOWN_STOP_REASON,
  TOWER_REVIEWER_BASE_TOOLS,
  TOWER_WORKER_BASE_TOOLS,
  isHumanStopReason,
  isTowerStopReason,
  TOWER_AGENT_NOTIFICATION_MESSAGE,
  TOWER_INBOX_WAKE_MESSAGE,
  TOWER_MODE_ENTRY,
  TOWER_MODE_TOOLS,
  TOWER_REMINDER_MESSAGE,
  TOWER_STATUS_KEY,
} from './constants.ts';
import { BranchLeases } from './leases.ts';
import { isForeignLiveOwner, isOwnerLive, isProcessAlive } from './liveness.ts';
import { latestTowerModeRecord, type TowerModeRecord, type TowerSessionModel } from './modeRecord.ts';
import { towerPrimaryModel, type TowerModels } from './models.ts';
import { selectReminderForContext } from './reminders.ts';
import type {
  TowerAgentEvent,
  TowerAgentFinishedEvent,
  TowerAgentInfo,
  TowerAgentOutput,
  TowerRateLimitSnapshot,
  TowerRunStartResult,
  TowerRuntime,
  TowerSteerResult,
  TowerStopResult,
} from './runtimeTypes.ts';
import { towerModeVeto } from './vetoes.ts';
import { InboxWakeQueue, type InboxWakeBatch } from './wakes.ts';

export type TowerExtensionApi = Pick<
  ExtensionAPI,
  | 'appendEntry'
  | 'getActiveTools'
  | 'getFlag'
  | 'getThinkingLevel'
  | 'registerTool'
  | 'sendMessage'
  | 'sendUserMessage'
  | 'setActiveTools'
  | 'setModel'
  | 'setThinkingLevel'
>;

export type TowerExitReason = 'user' | 'foreign-reconcile';

export type TowerEnterFailure =
  | { readonly entered: false; readonly reason: 'no-session' }
  | {
      readonly entered: false;
      readonly reason: 'owned-by-live-session';
      readonly owner: string;
      readonly pid?: number;
    };

export type TowerEnterResult = { readonly entered: true } | TowerEnterFailure;

export function towerEnterFailureMessage(failure: TowerEnterFailure): string {
  switch (failure.reason) {
    case 'no-session':
      return 'tower mode needs an active pi session — start one and retry';
    case 'owned-by-live-session':
      return `another live session owns the workspace tower (session ${failure.owner}${failure.pid === undefined ? '' : `, pid ${String(failure.pid)}`})`;
  }
}

export interface TowerLog {
  info(message: string, payload?: Readonly<Record<string, unknown>>): void;
  warn(message: string, payload?: Readonly<Record<string, unknown>>): void;
}

const SILENT_LOG: TowerLog = { info: () => undefined, warn: () => undefined };

const DEFAULT_RATE_LIMIT_SNAPSHOT: TowerRateLimitSnapshot = {
  budget: 256,
  inflight: 0,
  blockedUntil: null,
};

export interface TowerControllerOptions {
  readonly pi: TowerExtensionApi;
  readonly createRuntime?: (controller: TowerController) => TowerRuntime;
  readonly models?: TowerModels;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly log?: TowerLog;
}

export class TowerController implements TowerToolHost {
  readonly models: TowerModels | undefined;
  private readonly pi: TowerExtensionApi;
  private readonly createRuntime: ((controller: TowerController) => TowerRuntime) | undefined;
  private readonly alive: (pid: number) => boolean;
  private readonly log: TowerLog;
  private spawnDescription: string | undefined;
  private readonly leases = new BranchLeases();
  private readonly wakes = new InboxWakeQueue();
  private readonly retired = new Set<string>();
  private readonly abortedSpawns = new Set<string>();
  private readonly retainedOutputs = new Map<string, TowerAgentOutput>();
  private readonly pendingWrites = new Set<Promise<unknown>>();
  private readonly deathChains = new Map<string, Promise<void>>();
  private ctx: ExtensionContext | undefined;
  private boundSessionId: string | undefined;
  private boundRepoRoot: string | undefined;
  private runtimeInstance: TowerRuntime | undefined;
  private active = false;
  private shuttingDown = false;
  private releasing: Promise<void> = Promise.resolve();
  private modeRecord: TowerModeRecord | undefined;
  private wakeGeneration = 0;
  private wakeScheduled = false;
  private wakeFlushing = false;
  private wakeWaitingForIdle = false;

  constructor(options: TowerControllerOptions) {
    this.pi = options.pi;
    this.models = options.models;
    this.createRuntime = options.createRuntime;
    this.alive = options.isProcessAlive ?? isProcessAlive;
    this.log = options.log ?? SILENT_LOG;
  }

  get isActive(): boolean {
    return this.active;
  }

  get sessionId(): string {
    if (this.boundSessionId === undefined) {
      throw new TowerProtocolError('the tower is not bound to a pi session yet — retry once the session has started');
    }
    return this.boundSessionId;
  }

  get repoRoot(): string {
    if (this.boundRepoRoot === undefined) {
      throw new TowerProtocolError('the tower is not bound to a pi session yet — retry once the session has started');
    }
    return this.boundRepoRoot;
  }

  get context(): ExtensionContext | undefined {
    return this.ctx;
  }

  observe(ctx: ExtensionContext): void {
    this.ctx = ctx;
    this.boundSessionId = ctx.sessionManager.getSessionId();
    this.boundRepoRoot = resolveTowerRepoRoot(ctx.cwd);
  }

  store(): TowerStore {
    return new TowerStore(this.repoRoot);
  }

  isOwnerLive(owner: TowerOwner): boolean {
    return isOwnerLive(owner, this.boundSessionId, this.alive);
  }

  noteRetiredAgents(names: readonly string[]): void {
    for (const name of names) this.retired.add(name);
  }

  isRetiredAgent(name: string): boolean {
    return this.retired.has(name);
  }

  isBranchLeased(branch: string): boolean {
    return this.leases.isLeased(branch);
  }

  withBranchLease<T>(branch: string, execute: () => Promise<T>): Promise<T> {
    return this.leases.withLease(branch, execute);
  }

  get runtime(): TowerRuntime | undefined {
    if (this.runtimeInstance !== undefined || this.shuttingDown) return this.runtimeInstance;
    if (this.createRuntime === undefined) return undefined;
    const runtime = this.createRuntime(this);
    runtime.onEvent((event) => this.onRuntimeEvent(event));
    this.runtimeInstance = runtime;
    return runtime;
  }

  activeAgentIds(): ReadonlySet<string> {
    return this.runtimeInstance?.activeAgentIds() ?? new Set<string>();
  }

  rateLimitSnapshot(): TowerRateLimitSnapshot {
    return this.runtime?.limiter.snapshot() ?? DEFAULT_RATE_LIMIT_SNAPSHOT;
  }

  publishInboxSent(event: TowerInboxSentPayload): void {
    if (!this.active || this.shuttingDown) return;
    if (event.from === TOWER_NAME) return;
    if (event.to !== TOWER_NAME && event.to !== BROADCAST_NAME) return;
    this.wakes.enqueue(this.wakes.entryFor(event));
    this.scheduleInboxWake();
  }

  async steerAgent(agentId: string, text: string): Promise<TowerSteerResult> {
    const runtime = this.runtimeInstance;
    if (runtime === undefined) return 'missing';
    return runtime.steer(agentId, text);
  }

  async resolveSpawnModel(
    kind: TowerAgentKind,
    choice: string | undefined,
  ): Promise<TowerSpawnModelResolution> {
    const models = this.models;
    if (models === undefined) return { ok: true };
    if (models.config === undefined && models.loadError === undefined && this.ctx !== undefined) {
      await models.load(this.modelsContext(this.ctx));
    }
    return models.resolveSpawn(kind, choice, this.primaryModel(), this.ctx?.modelRegistry);
  }

  primaryModel(): ReturnType<typeof towerPrimaryModel> {
    let thinkingLevel: string | undefined;
    try {
      thinkingLevel = this.pi.getThinkingLevel();
    } catch {
      thinkingLevel = undefined;
    }
    return towerPrimaryModel(this.ctx?.model, thinkingLevel);
  }

  modelsContext(ctx: ExtensionContext): { readonly cwd: string; readonly projectTrusted: boolean } {
    return { cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() };
  }

  async reloadModels(): Promise<void> {
    if (this.models === undefined || this.ctx === undefined) return;
    await this.models.load(this.modelsContext(this.ctx));
    this.refreshSpawnTool();
  }

  refreshSpawnTool(): void {
    const lines = this.models?.spawnModelLines(this.primaryModel());
    const tool = createTowerSpawnTool(this, ORCHESTRATOR_CALLER, lines);
    if (tool.description === this.spawnDescription) return;
    this.spawnDescription = tool.description;
    this.pi.registerTool(
      toToolDefinition(tool, { defaultActive: false, onContext: (ctx) => this.observe(ctx) }),
    );
  }

  async launchAgent(request: TowerLaunchRequest): Promise<TowerRunStartResult> {
    const runtime = this.runtime;
    if (runtime === undefined) {
      return { ok: false, reason: 'tower spawn failed: the tower agent runtime is not available in this process' };
    }
    return runtime.spawn({
      name: request.name,
      kind: request.kind,
      description: request.description,
      cwd: request.cwd,
      prompt: request.prompt,
      appendSystemPrompt: TOWER_WORKER_ROLE,
      tools: request.kind === 'reviewer' ? TOWER_REVIEWER_BASE_TOOLS : TOWER_WORKER_BASE_TOOLS,
      timeoutMs: this.models?.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
      ...(request.binding === undefined ? {} : { model: request.binding.model }),
      ...(request.binding?.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: request.binding.thinkingLevel }),
    });
  }

  async abortAgent(agentId: string): Promise<void> {
    const runtime = this.runtimeInstance;
    if (runtime === undefined) return;
    this.abortedSpawns.add(agentId);
    await runtime.stop(agentId, 'tower spawn aborted: the roster entry could not be persisted').catch(() => 'missing');
    await runtime.dispose(agentId, 'tower spawn aborted').catch(() => false);
  }

  agentInfo(id: string): TowerAgentInfo | undefined {
    return this.runtimeInstance?.get(id) ?? this.retainedOutput(id);
  }

  agentOutput(id: string): TowerAgentOutput | undefined {
    return this.runtimeInstance?.output(id) ?? this.retainedOutput(id);
  }

  listAgents(activeOnly: boolean): readonly TowerAgentInfo[] {
    const live = this.runtimeInstance?.list(activeOnly) ?? [];
    if (activeOnly) return live;
    const liveIds = new Set(live.map((info) => info.agentId));
    return [...live, ...[...this.retainedOutputs.values()].filter((info) => !liveIds.has(info.agentId))];
  }

  async resumeAgent(agentId: string, prompt: string): Promise<TowerRunStartResult> {
    const runtime = this.runtimeInstance;
    if (runtime === undefined) {
      return { ok: false, reason: `unknown tower agent "${agentId}"` };
    }
    return runtime.resume(agentId, prompt);
  }

  async stopAgent(id: string, reason: string): Promise<TowerStopResult> {
    const runtime = this.runtimeInstance;
    if (runtime === undefined) return 'missing';
    return runtime.stop(id, reason);
  }

  async humanStop(id: string): Promise<TowerStopResult> {
    return this.stopAgent(id, HUMAN_STOP_REASON);
  }

  async enter(base?: string): Promise<TowerEnterResult> {
    if (this.ctx === undefined || this.boundSessionId === undefined) {
      return { entered: false, reason: 'no-session' };
    }
    await this.releasing;
    const owner = await this.resolveOwner();
    if (isForeignLiveOwner(owner, this.boundSessionId, this.alive)) {
      return {
        entered: false,
        reason: 'owned-by-live-session',
        owner: owner.sessionId,
        ...(owner.pid === undefined ? {} : { pid: owner.pid }),
      };
    }
    if (base !== undefined) await this.prepareUserBase(base);
    if (this.active) {
      this.activateTowerTools();
      return { entered: true };
    }
    await this.adoptTowerRoster();
    this.activateTowerTools();
    this.active = true;
    const switched = await this.applyOrchestratorModel();
    this.persistMode({
      active: true,
      sessionId: this.boundSessionId,
      pid: process.pid,
      ...(switched ?? {}),
    });
    this.renderStatus();
    return { entered: true };
  }

  async exit(reason: TowerExitReason = 'user'): Promise<void> {
    if (!this.active) return;
    const record = this.persistedRecord();
    this.persistMode({ active: false });
    this.active = false;
    this.dropInboxWake();
    this.renderStatus();
    this.log.info('tower: exit', { reason, sessionId: this.boundSessionId });
    await this.restoreSessionModel(record);
    this.releasing = this.releaseTowerOwnership();
    await this.releasing;
  }

  async onSessionStart(_event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
    this.observe(ctx);
    if (this.models !== undefined) {
      await this.models.load(this.modelsContext(ctx));
      this.refreshSpawnTool();
    }
    await this.restoreTowerMode(ctx);
  }

  onModelChanged(ctx: ExtensionContext): void {
    this.observe(ctx);
    this.refreshSpawnTool();
  }

  private async applyOrchestratorModel(): Promise<
    | Pick<TowerModeRecord, 'previousModel' | 'previousThinkingLevel' | 'orchestratorModel'>
    | undefined
  > {
    const ctx = this.ctx;
    const binding = this.models?.orchestratorBinding(this.primaryModel());
    if (ctx === undefined || binding === undefined) return undefined;
    const current = ctx.model;
    const currentThinking = this.currentThinkingLevel();
    const sameModel = current?.provider === binding.provider && current.id === binding.modelId;
    if (sameModel && (binding.thinkingLevel === undefined || binding.thinkingLevel === currentThinking)) {
      return undefined;
    }
    if (!sameModel) {
      const target = ctx.modelRegistry.find(binding.provider, binding.modelId);
      if (target === undefined) {
        this.notify(
          `Tower orchestrator model ${binding.model} is not in pi's model registry — staying on ${describeSessionModel(current)}.`,
          'warning',
        );
        return undefined;
      }
      if (!(await this.pi.setModel(target))) {
        this.notify(
          `Tower orchestrator model ${binding.model} has no configured credentials — staying on ${describeSessionModel(current)}.`,
          'warning',
        );
        return undefined;
      }
    }
    if (binding.thinkingLevel !== undefined) this.pi.setThinkingLevel(binding.thinkingLevel);
    this.refreshSpawnTool();
    return {
      ...(current === undefined ? {} : { previousModel: { provider: current.provider, modelId: current.id } }),
      ...(currentThinking === undefined ? {} : { previousThinkingLevel: currentThinking }),
      orchestratorModel: { provider: binding.provider, modelId: binding.modelId },
    };
  }

  private async restoreSessionModel(record: TowerModeRecord | undefined): Promise<void> {
    const ctx = this.ctx;
    if (ctx === undefined || record?.active !== true || record.orchestratorModel === undefined) return;
    const current = ctx.model;
    if (current?.provider !== record.orchestratorModel.provider || current.id !== record.orchestratorModel.modelId) {
      return;
    }
    const previous = record.previousModel;
    if (previous !== undefined && (previous.provider !== current.provider || previous.modelId !== current.id)) {
      const target = ctx.modelRegistry.find(previous.provider, previous.modelId);
      if (target === undefined || !(await this.pi.setModel(target))) {
        this.notify(
          `Could not restore the previous model ${previous.provider}/${previous.modelId} — staying on ${describeSessionModel(current)}.`,
          'warning',
        );
        return;
      }
    }
    if (record.previousThinkingLevel !== undefined) {
      this.pi.setThinkingLevel(record.previousThinkingLevel as Parameters<TowerExtensionApi['setThinkingLevel']>[0]);
    }
    this.refreshSpawnTool();
  }

  private currentThinkingLevel(): string | undefined {
    try {
      return this.pi.getThinkingLevel();
    } catch {
      return undefined;
    }
  }

  async onSessionShutdown(): Promise<void> {
    this.shuttingDown = true;
    this.dropInboxWake();
    const runtime = this.runtimeInstance;
    if (runtime !== undefined) {
      await runtime.disposeAll(SHUTDOWN_STOP_REASON).catch((error: unknown) => {
        this.log.warn('tower: failed to stop the tower agents on shutdown', { error: errorText(error) });
      });
    }
    await Promise.allSettled([...this.pendingWrites]);
  }

  onBeforeAgentStart(
    event: BeforeAgentStartEvent,
    ctx: ExtensionContext,
  ): BeforeAgentStartEventResult | undefined {
    this.observe(ctx);
    if (this.active) this.activateTowerTools();
    const reminder = selectReminderForContext(
      this.active,
      ctx.sessionManager.buildContextEntries(),
      event.messageType === 'user' ? 'user' : 'custom',
    );
    if (reminder === undefined) return undefined;
    return {
      message: {
        customType: TOWER_REMINDER_MESSAGE,
        content: reminder.text,
        display: false,
        details: { kind: reminder.kind },
      },
    };
  }

  onToolCall(event: ToolCallEvent, ctx: ExtensionContext): ToolCallEventResult | undefined {
    this.observe(ctx);
    if (!this.active) return undefined;
    const veto = towerModeVeto(event.toolName);
    return veto === undefined ? undefined : { block: true, reason: veto };
  }

  onAfterProviderResponse(event: AfterProviderResponseEvent): void {
    if (event.status === 429) this.runtime?.limiter.reportRateLimited();
  }

  onAgentSettled(_event: AgentSettledEvent, ctx: ExtensionContext): void {
    this.observe(ctx);
    if (!this.wakeWaitingForIdle) return;
    this.wakeWaitingForIdle = false;
    this.scheduleInboxWake();
  }

  private async resolveOwner(): Promise<TowerOwner | undefined> {
    const owner = await this.store().owner();
    if (owner?.sessionId !== undefined) return owner;
    const record = this.persistedRecord();
    return record?.active === true && record.sessionId !== undefined
      ? { sessionId: record.sessionId, ...(record.pid === undefined ? {} : { pid: record.pid }) }
      : owner;
  }

  private persistedRecord(): TowerModeRecord | undefined {
    if (this.modeRecord !== undefined) return this.modeRecord;
    const entries = this.ctx?.sessionManager.getBranch() ?? [];
    return latestTowerModeRecord(entries);
  }

  private persistMode(record: TowerModeRecord): void {
    this.pi.appendEntry(TOWER_MODE_ENTRY, record);
    this.modeRecord = record;
  }

  private async restoreTowerMode(ctx: ExtensionContext): Promise<void> {
    const record = latestTowerModeRecord(ctx.sessionManager.getBranch());
    this.modeRecord = record;
    if (record?.active !== true) return;
    const owner = await this.resolveOwner();
    const foreign = owner?.sessionId !== undefined && owner.sessionId !== this.boundSessionId;
    if (foreign && this.isOwnerLive(owner)) {
      await this.reconcileForeign(
        record,
        `another live session owns the workspace tower (session ${owner.sessionId ?? '?'}${owner.pid === undefined ? '' : `, pid ${String(owner.pid)}`}) — tower mode was turned off in this session`,
      );
      return;
    }
    try {
      await this.adoptTowerRoster();
    } catch (error) {
      this.log.warn('tower: failed to adopt the tower workspace roster on restore', {
        error: errorText(error),
      });
      await this.reconcileForeign(record, errorText(error));
      return;
    }
    this.active = true;
    if (record.sessionId !== this.boundSessionId || record.pid !== process.pid) {
      this.persistMode({ ...record, sessionId: this.boundSessionId, pid: process.pid });
    }
    this.activateTowerTools();
    this.renderStatus();
  }

  private async reconcileForeign(record: TowerModeRecord, reason: string): Promise<void> {
    this.active = false;
    this.persistMode({ active: false });
    this.renderStatus();
    this.notify(`Tower mode: OFF — ${reason}`, 'warning');
    await this.restoreSessionModel(record);
    this.releasing = this.releaseTowerOwnership();
    await this.releasing;
  }

  private async adoptTowerRoster(): Promise<void> {
    try {
      this.noteRetiredAgents(await this.store().adopt(this.sessionId));
    } catch (error) {
      throw new TowerProtocolError(
        `failed to adopt the tower workspace roster: ${errorText(error)}`,
      );
    }
  }

  private async releaseTowerOwnership(): Promise<void> {
    const sessionId = this.boundSessionId;
    if (sessionId === undefined || this.boundRepoRoot === undefined) return;
    await this.store()
      .release(sessionId)
      .catch((error: unknown) => {
        this.log.warn(`failed to release tower workspace ownership: ${errorText(error)}`);
      });
  }

  private async prepareUserBase(base: string): Promise<void> {
    const repoRoot = this.repoRoot;
    const store = this.store();
    await store.ensureRepository(base);
    if (await store.isInitialized()) {
      const state = await store.load();
      if (state.base === base) {
        await assertLocalBaseBranch(repoRoot, base);
        return;
      }
      if (!(await branchExists(repoRoot, base))) {
        await createBaseBranch(repoRoot, base);
      }
      await store.rebase(base);
      return;
    }
    if (await branchExists(repoRoot, base)) {
      await store.init(this.sessionId, base);
      return;
    }
    await createBaseBranch(repoRoot, base);
    await store.init(this.sessionId, base);
  }

  activateTowerTools(): void {
    const active = this.pi.getActiveTools();
    if (TOWER_MODE_TOOLS.every((name) => active.includes(name))) return;
    this.pi.setActiveTools([...new Set([...active, ...TOWER_MODE_TOOLS])]);
  }

  private renderStatus(): void {
    try {
      this.ctx?.ui.setStatus(TOWER_STATUS_KEY, this.active ? 'tower: on' : undefined);
    } catch {
      return;
    }
  }

  notify(message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    try {
      this.ctx?.ui.notify(message, level);
    } catch {
      return;
    }
  }

  private isMainIdle(): boolean {
    try {
      return this.ctx?.isIdle() ?? true;
    } catch {
      return true;
    }
  }

  private scheduleInboxWake(): void {
    if (this.wakeScheduled || this.wakeFlushing || this.wakes.size === 0) return;
    this.wakeScheduled = true;
    queueMicrotask(() => {
      void this.flushInboxWake();
    });
  }

  private dropInboxWake(): void {
    this.wakeGeneration += 1;
    this.wakes.reset();
    this.wakeFlushing = false;
    this.wakeWaitingForIdle = false;
  }

  private async flushInboxWake(): Promise<void> {
    this.wakeScheduled = false;
    if (this.shuttingDown || !this.active) {
      this.wakes.discardPending();
      return;
    }
    if (this.wakes.size === 0) return;
    if (!this.isMainIdle()) {
      this.wakeWaitingForIdle = true;
      return;
    }
    const batch = this.wakes.take();
    if (batch === undefined) return;
    const generation = this.wakeGeneration;
    this.wakeFlushing = true;
    let text: string;
    try {
      text = await this.renderInboxWakeText(batch);
    } finally {
      if (generation === this.wakeGeneration) this.wakeFlushing = false;
    }
    if (generation !== this.wakeGeneration || this.shuttingDown || !this.active) return;
    if (!this.isMainIdle()) {
      this.wakes.requeue(batch);
      this.wakeWaitingForIdle = true;
      return;
    }
    try {
      this.pi.sendMessage(
        {
          customType: TOWER_INBOX_WAKE_MESSAGE,
          content: text,
          display: true,
          details: { references: batch.items.length, omitted: batch.omitted },
        },
        { triggerTurn: true, deliverAs: 'followUp' },
      );
    } catch (error) {
      this.log.warn('tower: failed to deliver the inbox wake', { error: errorText(error) });
      this.wakes.requeue(batch);
      this.wakeWaitingForIdle = true;
      return;
    }
    if (this.wakes.size > 0) this.scheduleInboxWake();
  }

  private async renderInboxWakeText(batch: InboxWakeBatch): Promise<string> {
    const targets = wakeDigestTargets(batch.items);
    const store = this.store();
    const state = await store.load().then(
      (loaded) => loaded,
      () => undefined,
    );
    let gateDigest: string[] = [];
    if (targets.missionIds.length > 0) {
      if (state === undefined) {
        gateDigest = targets.missionIds.map((missionId) =>
          formatGateDigestLine(missionId, 'unavailable'),
        );
      } else {
        const activeAgentIds = this.activeAgentIds();
        gateDigest = await mapWithConcurrency(
          targets.missionIds,
          TOWER_GIT_CONCURRENCY,
          async (missionId): Promise<string> => {
            const mission = state.missions.find((candidate) => candidate.id === missionId);
            if (mission === undefined) return formatGateDigestLine(missionId, 'mission-missing');
            if (mission.status === 'merged' || mission.status === 'abandoned') {
              return formatGateDigestLine(missionId, mission.status);
            }
            try {
              const gate = await store.missionGate(state, mission, { activeAgentIds });
              return formatGateDigestLine(missionId, gate);
            } catch {
              return formatGateDigestLine(missionId, 'unavailable');
            }
          },
        );
      }
    }
    return renderInboxWake({
      items: batch.items,
      omitted: batch.omitted,
      ...(state?.recoveredAt === undefined ? {} : { recoveredAt: state.recoveredAt }),
      gateDigest,
      digestOmitted: targets.omitted,
    });
  }

  private onRuntimeEvent(event: TowerAgentEvent): void {
    if (event.type === 'started') {
      if (event.resumed) {
        this.enqueueDeathWork(event.agentId, () => this.clearTowerAgentDeath(event.agentId));
      }
      return;
    }
    if (event.type !== 'finished') return;
    this.enqueueDeathWork(event.agentId, () => this.recordTowerAgentDeath(event));
    this.deliverAgentNotification(event);
    this.retireFinishedReviewer(event);
  }

  private enqueueDeathWork(agentId: string, work: () => Promise<void>): void {
    const previous = this.deathChains.get(agentId) ?? Promise.resolve();
    const next = previous.then(work, work).catch(() => undefined);
    this.deathChains.set(agentId, next);
    this.track(
      next.finally(() => {
        if (this.deathChains.get(agentId) === next) this.deathChains.delete(agentId);
      }),
    );
  }

  private track(promise: Promise<unknown>): void {
    const tracked = promise.catch(() => undefined).finally(() => {
      this.pendingWrites.delete(tracked);
    });
    this.pendingWrites.add(tracked);
  }

  private async recordTowerAgentDeath(event: TowerAgentFinishedEvent): Promise<void> {
    if (event.status === 'idle') return;
    if (!this.active) return;
    const store = this.store();
    const foreignOwner = await this.foreignStoreOwner(store);
    if (foreignOwner !== undefined) {
      this.log.info('tower: skipping roster agent death mark — tower store is owned by another session', {
        event: 'finished',
        agentId: event.agentId,
        sessionId: this.boundSessionId,
        owner: foreignOwner,
        pid: process.pid,
      });
      return;
    }
    this.log.info('tower: marking roster agent died', {
      event: 'finished',
      agentId: event.agentId,
      taskId: event.taskId,
      status: event.status,
      stopReason: event.stopReason,
      sessionId: this.boundSessionId,
      pid: process.pid,
    });
    await store
      .markAgentDied(event.agentId, event.status, event.stopReason, this.boundSessionId)
      .then(
        () => undefined,
        () => undefined,
      );
  }

  private async clearTowerAgentDeath(agentId: string): Promise<void> {
    if (!this.active) return;
    const store = this.store();
    const foreignOwner = await this.foreignStoreOwner(store);
    if (foreignOwner !== undefined) {
      this.log.info('tower: skipping roster agent death clear — tower store is owned by another session', {
        event: 'started',
        agentId,
        sessionId: this.boundSessionId,
        owner: foreignOwner,
        pid: process.pid,
      });
      return;
    }
    this.log.info('tower: clearing roster agent death mark', {
      event: 'started',
      agentId,
      sessionId: this.boundSessionId,
      pid: process.pid,
    });
    await store.clearAgentDied(agentId, this.boundSessionId).then(
      () => undefined,
      () => undefined,
    );
  }

  private async foreignStoreOwner(store: TowerStore): Promise<string | undefined> {
    const owner = await store.load().then(
      (state) => state.sessionId,
      () => undefined,
    );
    return owner !== undefined && owner !== this.boundSessionId ? owner : undefined;
  }

  private deliverAgentNotification(event: TowerAgentFinishedEvent): void {
    if (this.shuttingDown || this.abortedSpawns.has(event.agentId)) return;
    const info = this.runtimeInstance?.get(event.agentId);
    const kind: TowerAgentKind = info?.kind === 'reviewer' ? 'reviewer' : 'worker';
    const status: NotificationEndStatus = event.status === 'idle' ? 'completed' : event.status;
    const text = renderAgentNotification({
      name: info?.name ?? event.name,
      agentId: event.agentId,
      taskId: event.taskId,
      kind,
      description: info?.description ?? event.name,
      status,
      ...(event.stopReason === undefined ? {} : { stopReason: event.stopReason }),
      stoppedByHuman: event.status === 'stopped' && isHumanStopReason(event.stopReason),
      stoppedByTower: event.status === 'stopped' && isTowerStopReason(event.stopReason),
      wallTimeMs: event.at - (info?.startedAt ?? event.at),
      ...(event.summary === undefined ? {} : { result: event.summary }),
      undeliveredSteers: event.undeliveredSteers ?? [],
    });
    try {
      this.pi.sendMessage(
        {
          customType: TOWER_AGENT_NOTIFICATION_MESSAGE,
          content: text,
          display: true,
          details: { agentId: event.agentId, taskId: event.taskId, status },
        },
        { triggerTurn: true, deliverAs: 'followUp' },
      );
    } catch (error) {
      this.log.warn('tower: failed to deliver the agent notification', { error: errorText(error) });
    }
  }

  private retireFinishedReviewer(event: TowerAgentFinishedEvent): void {
    const runtime = this.runtimeInstance;
    if (runtime === undefined || this.shuttingDown) return;
    const output = runtime.output(event.agentId);
    if (output?.kind !== 'reviewer') return;
    this.retainedOutputs.set(output.agentId, output);
    queueMicrotask(() => {
      void runtime.dispose(event.agentId, 'reviewer finished').catch(() => false);
    });
  }

  private retainedOutput(id: string): TowerAgentOutput | undefined {
    const direct = this.retainedOutputs.get(id);
    if (direct !== undefined) return direct;
    for (const output of this.retainedOutputs.values()) {
      if (output.taskId === id) return output;
    }
    return undefined;
  }
}

async function createBaseBranch(repoRoot: string, base: string): Promise<void> {
  const dirty = await listBaseDirtyEntries(repoRoot);
  if (dirty.some((entry) => entry.unmerged)) {
    throw new TowerProtocolError(
      'the checkout has unmerged paths (an in-progress merge, rebase, or cherry-pick) — finish or abort it before starting a tower on a new base',
    );
  }
  await checkoutNewLocalBranch(repoRoot, base);
  if (dirty.length === 0) return;
  try {
    await commitPaths(
      repoRoot,
      dirty.map((entry) => entry.path),
      `tower: snapshot of uncommitted base checkout changes (base ${base})`,
    );
  } catch (error) {
    throw new TowerProtocolError(
      `created and switched to "${base}", but committing the checkout's uncommitted changes onto it failed: ${errorText(error)}. ` +
        `The changes are still uncommitted on "${base}" — commit or move them, then re-run /tower ${base}.`,
    );
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeSessionModel(model: { readonly provider: string; readonly id: string } | undefined): string {
  return model === undefined ? 'the current model' : `${model.provider}/${model.id}`;
}

export type { TowerSessionModel };
