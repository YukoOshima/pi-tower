import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  TerminalInputHandler,
  UIPromptEndEvent,
  UIPromptStartEvent,
} from '@earendil-works/pi-coding-agent';

import {
  currentMilestone,
  hasAnyCommit,
  isInsideRepo,
  isTerminalObjectiveStatus,
  objectiveMissions,
  tryGit,
  type TowerObjective,
  type TowerObjectiveStatus,
  type TowerState,
  type TowerStore,
} from '../protocol/index.ts';
import { TOWER_DEFAULT_MAX_RUNNING_AGENTS } from '../runtime/rateLimit.ts';
import { renderTowerTasks } from '../tools/tasks/tasksTool.ts';
import {
  approveTowerObjective,
  commandUi,
  continueTowerObjective,
  describeLimits,
  ensureTowerWorkspace,
  exhaustedBudgets,
  handOverObjective,
  humanStopAgent,
  liveRosterAgents,
  objectiveStatusMarkdown,
  pauseTowerObjective,
  resumeTowerObjective,
  setTowerMode,
  type ObjectiveHandOverRequest,
  type TowerCommandDeps,
  type TowerCommandUi,
  type TowerObjectiveCommandHooks,
} from '../tower/command.ts';
import type { TowerChange, TowerController, TowerExtensionApi } from '../tower/controller.ts';
import {
  MISSION_APPROVAL_GRACE_MS,
  MISSION_APPROVAL_QUIET_MS,
  MISSION_MODE_ENTRY,
  MISSION_REFRESH_THROTTLE_MS,
  MISSION_REFRESH_TICK_MS,
  MISSION_STATUS_KEY,
  MISSION_WIDGET_KEY,
} from './constants.ts';
import { selectionKey, typedInput, type TypedInput } from './keys.ts';
import {
  missionPanelComponent,
  renderMissionPanel,
  renderMissionStatus,
  type MissionPanelInput,
} from './panel.ts';
import { DEFAULT_MISSION_TIMERS, MissionRefresher, type MissionTimers } from './refresher.ts';
import {
  MISSION_AGENTS_TITLE,
  MISSION_ALREADY_OFF,
  MISSION_CONTINUES_LATER,
  MISSION_CONTROL_TITLE,
  MISSION_DETACHED_HEAD,
  MISSION_HANDED_TITLE,
  MISSION_MODE_TITLE,
  MISSION_NO_COMMITS,
  MISSION_NOTHING_TO_RESUME,
  MISSION_OFF_BODY,
  MISSION_OFF_TITLE,
  MISSION_STATUS_PLANNING_GOAL,
  MISSION_STATUS_WAITING_FOR_GOAL,
  MISSION_STOP_USAGE,
  missionAgentsFailed,
  missionApprovalDialog,
  missionApprovalFailed,
  missionApprovedBody,
  missionApprovedTitle,
  missionFailure,
  missionHandedBody,
  missionKeepPlanning,
  missionNotARepository,
  missionNotResumable,
  missionNotRunning,
  missionOpenRefusal,
  missionOverBudget,
  missionPauseFailed,
  missionPausedBody,
  missionPausedTitle,
  missionResumeFailed,
  missionResumedBody,
  missionResumedTitle,
  missionStopFailed,
  missionStoppedBody,
  missionStoppedTitle,
  missionTickFailed,
  missionWorkspaceFailure,
  type MissionApprovalDialog,
} from './texts.ts';
import {
  renderMissionControl,
  renderMissionHeader,
  renderMissionPlanning,
  type MissionModelsView,
} from './views.ts';

export type MissionPhase = 'idle' | 'armed' | 'planning';

export type MissionPi = Pick<TowerExtensionApi, 'appendEntry' | 'sendUserMessage'> & Pick<ExtensionAPI, 'on'>;

export interface MissionModeOptions {
  readonly controller: TowerController;
  readonly pi: MissionPi;
  readonly objective?: TowerObjectiveCommandHooks;
  readonly timers?: MissionTimers;
  readonly throttleMs?: number;
  readonly tickMs?: number;
}

export interface MissionToolResult {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly isError: boolean;
}

interface ObservedObjective {
  readonly id: string;
  readonly status: TowerObjectiveStatus;
}

interface ApprovalDialog {
  readonly objectiveId: string;
  readonly abort: AbortController;
  readonly openedAt: number;
  unguard: (() => void) | undefined;
}

type UIPromptEvent = UIPromptStartEvent | UIPromptEndEvent;

interface SessionEntryLike {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}

type InputImages = NonNullable<InputEvent['images']>;

const CONTINUE: InputEventResult = { action: 'continue' };
const HANDLED: InputEventResult = { action: 'handled' };

export class MissionMode {
  private readonly controller: TowerController;
  private readonly pi: MissionPi;
  private readonly hooks: TowerObjectiveCommandHooks;
  private readonly timers: MissionTimers;
  private readonly refresher: MissionRefresher;
  private readonly ownPromptTitles = new Set<string>();
  private on = false;
  private phase: MissionPhase = 'idle';
  private goal: string | undefined;
  private hidden: ObservedObjective | undefined;
  private observed: ObservedObjective | null | undefined;
  private approvalRequested = false;
  private offerFor: string | undefined;
  private dialog: ApprovalDialog | undefined;
  private unwatchKeys: (() => void) | undefined;
  private unwatchPrompts: (() => void) | undefined;
  private lastInputAt: number | undefined;
  private otherPromptOpen = false;
  private shownLines: string | undefined;
  private shownStatus: string | undefined;

  constructor(options: MissionModeOptions) {
    this.controller = options.controller;
    this.pi = options.pi;
    this.hooks = options.objective ?? {
      autopilotTick: (reason) => options.controller.autopilotTick(reason),
      objectiveSettings: () => options.controller.objectiveSettings(),
    };
    this.timers = options.timers ?? DEFAULT_MISSION_TIMERS;
    this.refresher = new MissionRefresher({
      refresh: () => this.refresh(),
      timers: this.timers,
      throttleMs: options.throttleMs ?? MISSION_REFRESH_THROTTLE_MS,
      tickMs: options.tickMs ?? MISSION_REFRESH_TICK_MS,
      onError: (error) => {
        this.controller.diagnostic(`mission control refresh failed: ${errorText(error)}`);
      },
    });
  }

  get active(): boolean {
    return this.on;
  }

  get intakeArmed(): boolean {
    return this.phase === 'armed';
  }

  get approvalOpen(): boolean {
    return this.dialog !== undefined;
  }

  get refreshing(): boolean {
    return this.refresher.started;
  }

  async enter(ctx: ExtensionCommandContext, ui: TowerCommandUi): Promise<void> {
    const workspace = await this.prepare(ui);
    if (workspace === undefined) return;
    let state: TowerState;
    try {
      await this.controller.reloadModels();
      state = await workspace.store.load();
    } catch (error) {
      ui.error(missionFailure(errorText(error)));
      return;
    }
    this.activate(ctx);
    const visible = this.visibleObjective(state);
    try {
      if (visible === undefined && (this.phase === 'planning' || handoverPending(state))) {
        const stale = this.goal === undefined || idle(ctx);
        ui.notice(MISSION_MODE_TITLE, renderMissionPlanning(this.modelsView(), this.goal, stale));
      } else if (visible !== undefined && visible.status !== 'completed') {
        this.setPhase('idle');
        ui.notice(MISSION_CONTROL_TITLE, this.controlView(state, visible));
      } else {
        const previous = state.objective?.status === 'completed' ? state.objective : undefined;
        if (state.objective !== undefined) this.hide(state.objective);
        this.setPhase('armed');
        ui.notice(
          MISSION_MODE_TITLE,
          renderMissionHeader({
            models: this.modelsView(),
            base: state.base,
            initialized: workspace.initializedBase !== undefined,
            maxRunningAgents: this.maxRunningAgents(),
            ...(previous === undefined ? {} : { previous }),
          }),
        );
      }
    } catch (error) {
      ui.error(missionFailure(errorText(error)));
    }
    this.refresher.request();
  }

  async startGoal(request: ObjectiveHandOverRequest, ctx: ExtensionCommandContext, ui: TowerCommandUi): Promise<void> {
    const workspace = await this.prepare(ui);
    if (workspace === undefined) return;
    this.activate(ctx);
    await this.handOver(request, ctx, ui, undefined, workspace.initializedBase);
  }

  async approve(ui: TowerCommandUi): Promise<void> {
    let objective: TowerObjective;
    try {
      objective = await approveTowerObjective(this.controller, 'human');
    } catch (error) {
      ui.error(missionApprovalFailed(errorText(error)));
      return;
    }
    this.closeDialog();
    ui.notice(missionApprovedTitle(objective), missionApprovedBody(objective, currentMilestone(objective)));
    this.continueMission('approve', ui);
    this.refresher.request();
  }

  async pause(reason: string, ui: TowerCommandUi): Promise<void> {
    try {
      const objective = await pauseTowerObjective(this.controller, reason);
      ui.notice(missionPausedTitle(objective), missionPausedBody(objective.pausedReason ?? reason));
    } catch (error) {
      ui.error(missionPauseFailed(errorText(error)));
    }
    this.refresher.request();
  }

  async resume(ui: TowerCommandUi): Promise<void> {
    let objective: TowerObjective;
    try {
      const outcome = await resumeTowerObjective(this.controller, () => this.hooks.objectiveSettings());
      if (outcome.status === 'missing') {
        ui.error(MISSION_NOTHING_TO_RESUME);
        return;
      }
      if (outcome.status === 'not-resumable') {
        ui.error(missionNotResumable(outcome.objective));
        return;
      }
      objective = outcome.objective;
    } catch (error) {
      ui.error(missionResumeFailed(errorText(error)));
      return;
    }
    ui.notice(missionResumedTitle(objective), missionResumedBody(describeLimits(objective.limits)));
    const exhausted = exhaustedBudgets(objective, Date.now());
    if (exhausted.length > 0) ui.warn(missionOverBudget(objective, exhausted));
    this.continueMission('resume', ui);
    this.refresher.request();
  }

  async agents(ui: TowerCommandUi): Promise<void> {
    try {
      ui.notice(MISSION_AGENTS_TITLE, await renderTowerTasks(this.controller, false));
    } catch (error) {
      ui.error(missionAgentsFailed(errorText(error)));
    }
  }

  async stop(ref: string, ui: TowerCommandUi): Promise<void> {
    const target = ref.trim();
    if (target.length === 0) {
      ui.error(MISSION_STOP_USAGE);
      return;
    }
    try {
      const outcome = await humanStopAgent(this.controller, target);
      switch (outcome.status) {
        case 'stopped': {
          const { name, agentId } = outcome.info;
          ui.notice(missionStoppedTitle(name), missionStoppedBody(name, agentId));
          break;
        }
        case 'not-running':
          ui.status(missionNotRunning(outcome.info.name));
          break;
        case 'unknown':
          ui.error(outcome.refusal);
          break;
      }
    } catch (error) {
      ui.error(missionStopFailed(target, errorText(error)));
    }
    this.refresher.request();
  }

  async exit(ui: TowerCommandUi): Promise<void> {
    const towerWasOn = this.controller.isActive;
    const missionWasOn = this.on;
    if (towerWasOn && !(await setTowerMode(this.controller, ui, false))) return;
    this.deactivate();
    if (!towerWasOn && !missionWasOn) {
      ui.status(MISSION_ALREADY_OFF);
      return;
    }
    ui.notice(MISSION_OFF_TITLE, MISSION_OFF_BODY);
  }

  refreshSoon(): void {
    if (this.on) this.refresher.request();
  }

  onTowerChange(change: TowerChange): void {
    if (change.kind === 'mode') {
      if (!change.active) this.deactivate();
      return;
    }
    this.refreshSoon();
  }

  onTowerCommand(args: string): void {
    const [head = '', next = ''] = args.trim().toLowerCase().split(/\s+/);
    if (head === 'objective' && next !== 'status' && this.phase !== 'idle') this.setPhase('idle');
    this.refreshSoon();
  }

  onToolResult(event: MissionToolResult): void {
    if (!this.on || event.isError || event.toolName !== 'TowerObjective') return;
    if (event.input['action'] !== 'request-approval') return;
    this.approvalRequested = true;
    this.refresher.request();
  }

  async onInput(event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult> {
    if (this.phase !== 'armed' || event.source === 'extension') return CONTINUE;
    const text = event.text.trim();
    if (text.length === 0 || text.startsWith('/')) return CONTINUE;
    if (!this.on || !this.controller.isActive) {
      this.setPhase('idle');
      return CONTINUE;
    }
    this.phase = 'planning';
    this.goal = event.text;
    this.controller.observe(ctx);
    await this.handOver(await intakeRequest(event.text, ctx.cwd), ctx, commandUi(ctx), event.images);
    return HANDLED;
  }

  onSessionStart(ctx: ExtensionContext): void {
    this.reset();
    if (latestMissionModeRecord(ctx.sessionManager.getBranch())?.active !== true) return;
    if (!this.controller.isActive) return;
    this.activate(ctx, false);
    this.refresher.request();
  }

  onSessionShutdown(): void {
    this.reset();
  }

  private async prepare(
    ui: TowerCommandUi,
  ): Promise<{ readonly store: TowerStore; readonly initializedBase?: string } | undefined> {
    let problem: string | undefined;
    try {
      problem = await this.workspaceProblem();
    } catch (error) {
      ui.error(missionFailure(errorText(error)));
      return undefined;
    }
    if (problem !== undefined) {
      ui.error(problem);
      return undefined;
    }
    if (!(await setTowerMode(this.controller, ui, true))) return undefined;
    try {
      return await ensureTowerWorkspace(this.controller);
    } catch (error) {
      ui.error(missionWorkspaceFailure(errorText(error)));
      return undefined;
    }
  }

  private async workspaceProblem(): Promise<string | undefined> {
    const store = this.controller.store();
    if ((await store.isInitialized()) || (await store.isStateLost())) return undefined;
    const root = this.controller.repoRoot;
    if (!(await isInsideRepo(root))) return missionNotARepository(root);
    if (!(await hasAnyCommit(root))) return MISSION_NO_COMMITS;
    if ((await tryGit(root, ['symbolic-ref', '--quiet', 'HEAD'])) === null) return MISSION_DETACHED_HEAD;
    return undefined;
  }

  private async handOver(
    request: ObjectiveHandOverRequest,
    ctx: ExtensionContext,
    ui: TowerCommandUi,
    images: InputImages | undefined,
    initializedBase?: string,
  ): Promise<void> {
    const goal = request.text ?? `@${request.file ?? ''}`;
    this.phase = 'planning';
    this.goal = goal;
    let handed = false;
    try {
      const outcome = await handOverObjective(this.controller, ctx, this.sender(images), request);
      if (!outcome.handed) {
        ui.error(missionOpenRefusal(outcome.open));
        return;
      }
      handed = true;
      const previous = outcome.current;
      if (previous !== undefined && isTerminalObjectiveStatus(previous.status)) this.hide(previous);
      this.phase = 'planning';
      this.goal = goal;
      ui.notice(MISSION_HANDED_TITLE, missionHandedBody(outcome.initializedBase ?? initializedBase));
    } catch (error) {
      ui.error(missionFailure(errorText(error)));
    } finally {
      if (!handed) {
        this.phase = 'idle';
        this.goal = undefined;
      }
      this.refresher.request();
    }
  }

  private sender(images: InputImages | undefined): TowerCommandDeps['sendUserMessage'] {
    return (text, options) => {
      if (images === undefined || images.length === 0) {
        this.pi.sendUserMessage(text, options);
        return;
      }
      this.pi.sendUserMessage([{ type: 'text', text }, ...images], options);
    };
  }

  private continueMission(reason: 'approve' | 'resume', ui: TowerCommandUi): void {
    const continued = continueTowerObjective(this.controller, this.hooks, reason, (message) => {
      ui.error(missionTickFailed(reason, message));
    });
    if (!continued) ui.status(MISSION_CONTINUES_LATER);
  }

  private activate(ctx: ExtensionContext, persist = true): void {
    if (!this.on) {
      this.on = true;
      this.observed = undefined;
      if (persist) this.persist(true);
    }
    if (!ctx.hasUI) return;
    this.refresher.start();
    this.watchKeys(ctx);
    this.watchPrompts(ctx);
  }

  private deactivate(): void {
    const wasOn = this.on;
    this.reset();
    this.clearUi();
    if (wasOn) this.persist(false);
  }

  private reset(): void {
    this.on = false;
    this.phase = 'idle';
    this.goal = undefined;
    this.hidden = undefined;
    this.observed = undefined;
    this.approvalRequested = false;
    this.offerFor = undefined;
    this.closeDialog();
    this.refresher.stop();
    this.unwatchKeys?.();
    this.unwatchKeys = undefined;
    this.unwatchPrompts?.();
    this.unwatchPrompts = undefined;
    this.lastInputAt = undefined;
    this.otherPromptOpen = false;
    this.ownPromptTitles.clear();
  }

  private watchKeys(ctx: ExtensionContext): void {
    if (this.unwatchKeys !== undefined || ctx.mode !== 'tui') return;
    this.unwatchKeys = listenToTerminal(ctx, () => {
      this.lastInputAt = this.timers.now();
      return undefined;
    });
  }

  private watchPrompts(ctx: ExtensionContext): void {
    if (this.unwatchPrompts !== undefined || ctx.mode !== 'tui') return;
    this.unwatchPrompts = listenToPrompts(this.pi, (event) => {
      this.onPrompt(event);
    });
  }

  private onPrompt(event: UIPromptEvent): void {
    if (!this.on) return;
    if (event.type === 'ui_prompt_start') {
      this.otherPromptOpen = !this.ownPrompt(event);
      return;
    }
    if (!this.otherPromptOpen) return;
    this.otherPromptOpen = false;
    this.refresher.request();
  }

  private ownPrompt(event: UIPromptStartEvent): boolean {
    return event.kind === 'select' && event.title !== undefined && this.ownPromptTitles.has(event.title);
  }

  private typedRecently(): boolean {
    return this.lastInputAt !== undefined && this.timers.now() - this.lastInputAt < MISSION_APPROVAL_QUIET_MS;
  }

  private setPhase(phase: MissionPhase): void {
    this.phase = phase;
    if (phase !== 'planning') this.goal = undefined;
    this.refreshSoon();
  }

  private hide(objective: TowerObjective): void {
    this.hidden = { id: objective.id, status: objective.status };
  }

  private visibleObjective(state: TowerState): TowerObjective | undefined {
    const objective = state.objective;
    if (objective === undefined) return undefined;
    if (handoverPending(state)) return undefined;
    const hidden = this.hidden;
    return hidden?.id === objective.id && hidden.status === objective.status ? undefined : objective;
  }

  private persist(active: boolean): void {
    try {
      this.pi.appendEntry(MISSION_MODE_ENTRY, { active });
    } catch (error) {
      this.controller.diagnostic(`mission mode could not be recorded in the session: ${errorText(error)}`);
    }
  }

  private async refresh(): Promise<void> {
    if (!this.on) return;
    let state: TowerState;
    try {
      state = await this.controller.store().load();
    } catch {
      return;
    }
    if (!this.on) return;
    const ctx = this.controller.context;
    const visible = this.visibleObjective(state);
    if (visible !== undefined && !isTerminalObjectiveStatus(visible.status) && this.phase === 'planning') {
      this.phase = 'idle';
      this.goal = undefined;
    }
    if (ctx === undefined || !ctx.hasUI) return;
    if (visible === undefined) {
      this.showWidget(ctx, undefined);
      this.showStatus(
        ctx,
        this.phase === 'armed'
          ? MISSION_STATUS_WAITING_FOR_GOAL
          : this.phase === 'planning' || handoverPending(state)
            ? MISSION_STATUS_PLANNING_GOAL
            : undefined,
      );
    } else {
      const input = this.panelInput(state, visible);
      this.showWidget(ctx, input);
      this.showStatus(ctx, renderMissionStatus(input));
    }
    this.observeApproval(ctx, state);
  }

  private observeApproval(ctx: ExtensionContext, state: TowerState): void {
    const objective = state.objective;
    const previous = this.observed;
    this.observed = objective === undefined ? null : { id: objective.id, status: objective.status };
    const requested = this.approvalRequested;
    this.approvalRequested = false;
    const dialog = this.dialog;
    if (dialog !== undefined && (objective?.id !== dialog.objectiveId || objective.status !== 'awaiting-approval')) {
      this.closeDialog();
    }
    if (objective?.status !== 'awaiting-approval') {
      this.offerFor = undefined;
      return;
    }
    const entered =
      previous !== undefined &&
      (previous === null || previous.id !== objective.id || previous.status !== 'awaiting-approval');
    if ((entered || requested) && this.canOffer(ctx, state, objective)) this.offerFor = objective.id;
    if (this.offerFor !== objective.id || !this.readyToOffer(ctx)) return;
    this.offerFor = undefined;
    this.closeDialog();
    this.offer(ctx, state, objective);
  }

  private readyToOffer(ctx: ExtensionContext): boolean {
    return idle(ctx) && !editorHoldsText(ctx) && !this.typedRecently() && !this.otherPromptOpen;
  }

  private canOffer(ctx: ExtensionContext, state: TowerState, objective: TowerObjective): boolean {
    if (!ctx.hasUI || !this.on || !this.controller.isActive) return false;
    if (state.objectiveMode === 'headless') return false;
    let autoApprove = false;
    try {
      autoApprove = this.hooks.objectiveSettings().autoApprove;
    } catch {
      autoApprove = false;
    }
    return !autoApprove || objective.approvalRequiresHuman === true;
  }

  private offer(ctx: ExtensionContext, state: TowerState, objective: TowerObjective): void {
    const dialog: ApprovalDialog = {
      objectiveId: objective.id,
      abort: new AbortController(),
      openedAt: this.timers.now(),
      unguard: undefined,
    };
    this.dialog = dialog;
    if (ctx.mode === 'tui') {
      dialog.unguard = listenToTerminal(ctx, (data) => this.guardDialog(ctx, dialog, data));
    }
    const features = objectiveMissions(state).filter((mission) => mission.status !== 'abandoned').length;
    const question = missionApprovalDialog(objective, objective.milestones.length, features);
    this.ownPromptTitles.add(question.title);
    void this.awaitApproval(ctx, dialog, question, objective);
  }

  private guardDialog(
    ctx: ExtensionContext,
    dialog: ApprovalDialog,
    data: string,
  ): ReturnType<TerminalInputHandler> {
    if (this.dialog !== dialog) return undefined;
    const typed = typedInput(data);
    if (typed === undefined) {
      const opening = this.timers.now() - dialog.openedAt < MISSION_APPROVAL_GRACE_MS;
      return opening && selectionKey(data) ? { consume: true } : undefined;
    }
    this.offerFor = dialog.objectiveId;
    this.closeDialog();
    this.appendToEditor(ctx, typed);
    return { consume: true };
  }

  private appendToEditor(ctx: ExtensionContext, typed: TypedInput): void {
    try {
      if (typed.kind === 'paste') {
        ctx.ui.pasteToEditor(typed.text);
        return;
      }
      ctx.ui.setEditorText(`${ctx.ui.getEditorText()}${typed.text}`);
    } catch (error) {
      this.controller.diagnostic(`typed input could not be moved to the editor: ${errorText(error)}`);
    }
  }

  private async awaitApproval(
    ctx: ExtensionContext,
    dialog: ApprovalDialog,
    question: MissionApprovalDialog,
    objective: TowerObjective,
  ): Promise<void> {
    const [, approveOption] = question.options;
    let choice: string | undefined;
    try {
      choice = await ctx.ui.select(question.title, [...question.options], { signal: dialog.abort.signal });
    } catch (error) {
      this.release(dialog);
      this.controller.diagnostic(`mission approval dialog failed: ${errorText(error)}`);
      return;
    }
    this.release(dialog);
    if (dialog.abort.signal.aborted) return;
    const ui = commandUi(ctx);
    try {
      if (choice === approveOption) {
        await this.approve(ui);
        return;
      }
      ui.status(missionKeepPlanning(objective));
    } catch (error) {
      this.controller.diagnostic(`mission approval failed: ${errorText(error)}`);
    }
  }

  private closeDialog(): void {
    const dialog = this.dialog;
    if (dialog === undefined) return;
    this.release(dialog);
    dialog.abort.abort();
  }

  private release(dialog: ApprovalDialog): void {
    if (this.dialog === dialog) this.dialog = undefined;
    const unguard = dialog.unguard;
    dialog.unguard = undefined;
    unguard?.();
  }

  private panelInput(state: TowerState, objective: TowerObjective): MissionPanelInput {
    const models = this.modelsView().resolved;
    return {
      objective,
      missions: state.missions,
      agents: liveRosterAgents(this.controller, state),
      ...(models === undefined ? {} : { models }),
      maxRunningAgents: this.maxRunningAgents(),
      nowMs: this.timers.now(),
    };
  }

  private controlView(state: TowerState, objective: TowerObjective): string {
    const nowMs = this.timers.now();
    return renderMissionControl({
      models: this.modelsView(),
      objective,
      statusMarkdown: objectiveStatusMarkdown(this.controller, { objective: this.hooks }, state, objective, nowMs),
    });
  }

  private modelsView(): MissionModelsView {
    const models = this.controller.models;
    if (models === undefined) return {};
    if (models.loadError !== undefined) return { loadError: models.loadError };
    const resolved = models.resolve(this.controller.primaryModel());
    return resolved === undefined ? {} : { resolved };
  }

  private maxRunningAgents(): number {
    return this.controller.models?.maxRunningAgents ?? TOWER_DEFAULT_MAX_RUNNING_AGENTS;
  }

  private showWidget(ctx: ExtensionContext, input: MissionPanelInput | undefined): void {
    const lines = input === undefined ? undefined : renderMissionPanel(input);
    const key = lines === undefined ? undefined : JSON.stringify(lines);
    if (key === this.shownLines) return;
    try {
      if (input !== undefined && ctx.mode === 'tui') {
        ctx.ui.setWidget(MISSION_WIDGET_KEY, () => missionPanelComponent(input), { placement: 'aboveEditor' });
      } else {
        ctx.ui.setWidget(MISSION_WIDGET_KEY, lines, { placement: 'aboveEditor' });
      }
      this.shownLines = key;
    } catch (error) {
      this.controller.diagnostic(`mission control panel could not be shown: ${errorText(error)}`);
    }
  }

  private showStatus(ctx: ExtensionContext, text: string | undefined): void {
    if (text === this.shownStatus) return;
    try {
      ctx.ui.setStatus(MISSION_STATUS_KEY, text);
      this.shownStatus = text;
    } catch (error) {
      this.controller.diagnostic(`mission status could not be shown: ${errorText(error)}`);
    }
  }

  private clearUi(): void {
    const ctx = this.controller.context;
    if (ctx === undefined) {
      this.shownLines = undefined;
      this.shownStatus = undefined;
      return;
    }
    this.showWidget(ctx, undefined);
    this.showStatus(ctx, undefined);
  }
}

export function latestMissionModeRecord(
  entries: readonly SessionEntryLike[],
): { readonly active: boolean } | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== 'custom' || entry.customType !== MISSION_MODE_ENTRY) continue;
    const data = entry.data;
    if (typeof data !== 'object' || data === null) continue;
    const active = (data as { readonly active?: unknown }).active;
    if (typeof active === 'boolean') return { active };
  }
  return undefined;
}

async function intakeRequest(text: string, cwd: string): Promise<ObjectiveHandOverRequest> {
  const trimmed = text.trim();
  if (trimmed.startsWith('@')) {
    const file = trimmed.slice(1).trim();
    if (file.length > 0 && (await isFile(resolve(cwd, file)))) return { mode: 'interactive', file };
  }
  return { mode: 'interactive', text };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function handoverPending(state: TowerState): boolean {
  if (state.objectiveMode === undefined || state.objectiveModeFor !== undefined) return false;
  return state.objective === undefined || isTerminalObjectiveStatus(state.objective.status);
}

function idle(ctx: ExtensionContext): boolean {
  try {
    return ctx.isIdle();
  } catch {
    return true;
  }
}

function listenToTerminal(ctx: ExtensionContext, handler: TerminalInputHandler): (() => void) | undefined {
  try {
    return ctx.ui.onTerminalInput(handler);
  } catch {
    return undefined;
  }
}

function listenToPrompts(
  pi: Pick<ExtensionAPI, 'on'>,
  handler: (event: UIPromptEvent) => void,
): (() => void) | undefined {
  const unsubscribers: unknown[] = [];
  const unsubscribe = (): void => {
    for (const off of unsubscribers.splice(0)) {
      if (typeof off === 'function') off();
    }
  };
  try {
    unsubscribers.push(pi.on('ui_prompt_start', handler));
    unsubscribers.push(pi.on('ui_prompt_end', handler));
    return unsubscribe;
  } catch {
    unsubscribe();
    return undefined;
  }
}

function editorHoldsText(ctx: ExtensionContext): boolean {
  try {
    return ctx.ui.getEditorText().trim().length > 0;
  } catch {
    return false;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
