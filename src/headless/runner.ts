import { fileURLToPath } from 'node:url';

import { TOWER_HUMAN_APPROVAL_MARKER } from '../protocol/objective.ts';
import { piRunArgs, type HeadlessRunOptions } from './args.ts';
import { TOWER_MODELS_COMMAND, towerModelLines } from './models.ts';
import { isCommandError, noticeOf, PI_DIALOG_METHODS, recordField, stringField, type PiCommandResult, type PiEvent, type PiExit, type PiRpcOptions, type PiUiResponse } from './rpc.ts';
import type { HeadlessFeature, HeadlessMilestone, HeadlessObjective, HeadlessSnapshot } from './state.ts';

export const HEADLESS_EXIT = {
  completed: 0,
  stopped: 1,
  timeout: 2,
  approval: 3,
  startup: 4,
  sigint: 130,
  sigterm: 143,
} as const;

export const AUTO_APPROVE_COMMAND = '/tower approve --auto';

export type HeadlessSignal = 'SIGINT' | 'SIGTERM';

export interface HeadlessPi {
  readonly exit: PiExit | undefined;
  stderrTail(lines?: number): string;
  send(command: Readonly<Record<string, unknown>>, timeoutMs?: number): Promise<PiEvent>;
  command(text: string, timeoutMs?: number): Promise<PiCommandResult>;
  onEvent(listener: (event: PiEvent) => void): () => void;
  respond(id: string, response: PiUiResponse): void;
  kill(signal?: NodeJS.Signals): void;
  close(graceMs?: number): Promise<PiExit | undefined>;
  terminate(graceMs?: number): Promise<PiExit | undefined>;
}

export interface HeadlessClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface HeadlessOutput {
  info(line: string): void;
  error(line: string): void;
}

export interface HeadlessDeps {
  readonly createPi: (options: PiRpcOptions) => HeadlessPi;
  readonly clock: HeadlessClock;
  readonly readState: (cwd: string) => Promise<HeadlessSnapshot | undefined>;
  readonly output: HeadlessOutput;
  readonly onSignal: (handler: (signal: HeadlessSignal) => void) => () => void;
  readonly pollMs?: number;
  readonly startupTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly closeGraceMs?: number;
}

const ADOPTABLE = new Set(['awaiting-approval', 'executing', 'paused']);
const TERMINAL = new Set(['completed', 'blocked']);
const PAST_APPROVAL = new Set(['executing', 'paused', 'completed', 'blocked']);
const FINISHED_FEATURES = new Set(['merged', 'abandoned']);
const DEFAULT_POLL_MS = 1000;
const APPROVAL_GRACE_POLLS = 2;
const EXTENSION_ENTRY = fileURLToPath(new URL('../index.ts', import.meta.url));
const EXTENSION_HINT = `is the pi-tower extension loaded? Install it as a pi package or pass -- -e ${EXTENSION_ENTRY}`;

class HeadlessExit extends Error {
  readonly code: number;
  readonly refusal: readonly string[] | undefined;

  constructor(code: number, message: string, refusal?: readonly string[]) {
    super(message);
    this.code = code;
    this.refusal = refusal;
  }
}

type Interrupt = { readonly kind: 'signal'; readonly signal: HeadlessSignal } | { readonly kind: 'timeout' };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function oneLine(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ');
}

function indent(text: string, prefix = '  '): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${String(Math.floor(minutes / 60))}h${String(minutes % 60).padStart(2, '0')}m`;
}

function validationKinds(milestone: HeadlessMilestone, final: boolean, acceptance: readonly string[]): string {
  const commands = [...milestone.commands, ...(final ? acceptance : [])];
  const kinds = [
    ...(milestone.scrutiny ? ['scrutiny'] : []),
    ...(milestone.userTesting ? ['user-testing'] : []),
    ...(commands.length > 0 ? [`commands (${commands.join('; ')})`] : []),
  ];
  return kinds.length > 0 ? kinds.join(', ') : 'none';
}

export function objectiveFeatures(objective: HeadlessObjective, features: readonly HeadlessFeature[]): HeadlessFeature[] {
  const milestones = new Set(objective.milestones.map((milestone) => milestone.id));
  return features.filter((feature) => feature.milestone !== undefined && milestones.has(feature.milestone));
}

export function renderPlan(objective: HeadlessObjective, features: readonly HeadlessFeature[]): string {
  const attached = objectiveFeatures(objective, features);
  const lines = [`Plan for ${objective.id} "${objective.title}" (${objective.status}):`, `  goal: ${objective.goal}`];
  if (objective.approvalReason !== undefined) lines.push(`  approval reason: ${objective.approvalReason}`);
  lines.push('  definition of done:', ...objective.definitionOfDone.map((item) => `    - ${item}`));
  if (objective.acceptanceCommands.length > 0) lines.push('  acceptance commands:', ...objective.acceptanceCommands.map((item) => `    - ${item}`));
  lines.push('  milestones:');
  objective.milestones.forEach((milestone, index) => {
    const final = index === objective.milestones.length - 1;
    lines.push(`    ${milestone.id} ${milestone.title} — validation: ${validationKinds(milestone, final, objective.acceptanceCommands)}`);
    if (milestone.description !== undefined) lines.push(indent(milestone.description, '      '));
    if (milestone.qaInstructions !== undefined) lines.push(indent(`QA: ${milestone.qaInstructions}`, '      '));
    const planned = attached.filter((feature) => feature.milestone === milestone.id);
    if (planned.length === 0) lines.push('      (no features planned yet)');
    for (const feature of planned) lines.push(`      - ${feature.id} ${feature.title}${feature.origin === 'fix' ? ' (fix)' : ''}`);
  });
  if (objective.notes.length > 0) lines.push('  notes:', ...objective.notes.map((note) => `    - ${note}`));
  lines.push(`  estimated runs: ${String(attached.length + 2 * objective.milestones.length)} (features + 2 × milestones)`);
  return lines.join('\n');
}

export function progressLine(objective: HeadlessObjective, features: readonly HeadlessFeature[]): string {
  const parts = [`${objective.id} ${objective.status}`];
  if (objective.milestones.length > 0) parts.push(objective.milestones.map((milestone) => `${milestone.id} ${milestone.status}`).join(' · '));
  const attached = objectiveFeatures(objective, features);
  if (attached.length > 0) {
    const finished = attached.filter((feature) => FINISHED_FEATURES.has(feature.status)).length;
    parts.push(`features ${String(finished)}/${String(attached.length)} done`);
  }
  return parts.join(' — ');
}

function progressKey(objective: HeadlessObjective): string {
  return [objective.id, objective.status, ...objective.milestones.map((milestone) => `${milestone.id}:${milestone.status}`)].join('|');
}

class HeadlessRun {
  private readonly options: HeadlessRunOptions;
  private readonly deps: HeadlessDeps;
  private readonly startedAt: number;
  private readonly stop = new AbortController();
  private readonly interrupted: Promise<void>;
  private wake: () => void = () => undefined;
  private interrupt: Interrupt | undefined;
  private pi: HeadlessPi | undefined;
  private stopping: Promise<PiExit | undefined> | undefined;
  private started = false;
  private leftover: HeadlessObjective | undefined;
  private current: HeadlessObjective | undefined;
  private lastKey: string | undefined;
  private waitingNoted = false;
  private stateError: string | undefined;
  private commandsInFlight = 0;
  private approvalSince: number | undefined;

  constructor(options: HeadlessRunOptions, deps: HeadlessDeps) {
    this.options = options;
    this.deps = deps;
    this.startedAt = deps.clock.now();
    this.interrupted = new Promise((resolve) => {
      this.wake = resolve;
    });
  }

  async execute(): Promise<number> {
    const offSignal = this.deps.onSignal((signal) => {
      this.onInterrupt({ kind: 'signal', signal });
    });
    if (this.options.timeoutMs !== undefined) {
      void this.deps.clock.sleep(this.options.timeoutMs, this.stop.signal).then(() => {
        if (!this.stop.signal.aborted) this.onInterrupt({ kind: 'timeout' });
      });
    }
    let result: HeadlessExit;
    try {
      result = await this.drive();
    } catch (error) {
      result = error instanceof HeadlessExit ? error : new HeadlessExit(this.started ? HEADLESS_EXIT.stopped : HEADLESS_EXIT.startup, errorText(error));
    }
    if (this.interrupt !== undefined) result = this.interruptExit();
    try {
      if (this.pi !== undefined) await (this.stopping ?? this.pi.close(this.deps.closeGraceMs ?? 10_000));
    } finally {
      offSignal();
      this.stop.abort();
    }
    if (result.code === HEADLESS_EXIT.completed) this.line(result.message);
    else this.fail(result.message);
    return result.code;
  }

  private line(text: string): void {
    this.deps.output.info(`[pi-tower +${formatElapsed(this.deps.clock.now() - this.startedAt)}] ${text}`);
  }

  private fail(text: string): void {
    this.deps.output.error(`[pi-tower +${formatElapsed(this.deps.clock.now() - this.startedAt)}] ${text}`);
  }

  private onInterrupt(interrupt: Interrupt): void {
    if (this.interrupt !== undefined) {
      if (interrupt.kind === 'signal' && this.interrupt.kind === 'signal') {
        this.fail(`received ${interrupt.signal} again — killing pi`);
        this.pi?.kill('SIGKILL');
      }
      return;
    }
    this.interrupt = interrupt;
    if (interrupt.kind === 'signal') {
      this.fail(`received ${interrupt.signal} — stopping pi`);
      if (this.pi !== undefined) this.stopping = this.pi.terminate(this.deps.closeGraceMs ?? 10_000);
    }
    this.stop.abort();
    this.wake();
  }

  private objectiveSuffix(): string {
    const objective = this.current;
    return objective === undefined ? '' : ` (objective ${objective.id} was ${objective.status})`;
  }

  private interruptExit(): HeadlessExit {
    if (this.interrupt?.kind === 'signal') {
      const code = this.interrupt.signal === 'SIGINT' ? HEADLESS_EXIT.sigint : HEADLESS_EXIT.sigterm;
      return new HeadlessExit(code, `interrupted by ${this.interrupt.signal}; pi was stopped${this.objectiveSuffix()}`);
    }
    return new HeadlessExit(HEADLESS_EXIT.timeout, `timed out after ${String(this.options.timeoutMs)}ms${this.objectiveSuffix()}`);
  }

  private failure(code: number, message: string, refusal?: readonly string[]): HeadlessExit {
    const tail = this.pi?.stderrTail() ?? '';
    return new HeadlessExit(code, tail.length > 0 ? `${message}\npi stderr (last lines):\n${indent(tail)}` : message, refusal);
  }

  private async guard<T>(promise: Promise<T>): Promise<T> {
    promise.catch(() => undefined);
    const outcome = await Promise.race([promise.then((value) => ({ value })), this.interrupted.then(() => undefined)]);
    if (outcome === undefined) throw this.interruptExit();
    return outcome.value;
  }

  private async drive(): Promise<HeadlessExit> {
    let pi: HeadlessPi;
    try {
      pi = this.deps.createPi({ piBin: this.options.piBin, cwd: this.options.cwd, args: piRunArgs(this.options) });
    } catch (error) {
      throw new HeadlessExit(HEADLESS_EXIT.startup, `could not start pi (${this.options.piBin}): ${errorText(error)}`);
    }
    this.pi = pi;
    if (this.interrupt?.kind === 'signal') this.stopping = pi.terminate(this.deps.closeGraceMs ?? 10_000);
    pi.onEvent((event) => {
      this.onPiEvent(pi, event);
    });
    this.line(`started pi (${this.options.piBin} --mode rpc) in ${this.options.cwd}`);
    await this.handshake(pi);
    await this.checkTowerCommand(pi);
    await this.towerCommand(pi, '/tower on', HEADLESS_EXIT.startup);
    await this.showModels(pi);
    const baseline = (await this.snapshot())?.objective;
    if (baseline !== undefined && ADOPTABLE.has(baseline.status)) {
      this.line(`continuing existing objective ${baseline.id} "${baseline.title}" (status ${baseline.status}) — the -f file is not re-sent`);
    } else {
      if (baseline !== undefined && TERMINAL.has(baseline.status)) this.leftover = baseline;
      await this.towerCommand(pi, `/tower objective --headless @${this.options.objectiveFile}`, HEADLESS_EXIT.startup);
      this.line(`objective handed to the orchestrator: ${this.options.objectiveFile}`);
    }
    this.started = true;
    return this.follow(pi);
  }

  private async handshake(pi: HeadlessPi): Promise<void> {
    let state: PiEvent;
    try {
      state = await this.guard(pi.send({ type: 'get_state' }, this.deps.startupTimeoutMs ?? 60_000));
    } catch (error) {
      if (error instanceof HeadlessExit) throw error;
      const message = errorText(error);
      const hint = message.includes('ENOENT') ? ' — is pi installed? Point --pi at the pi executable' : '';
      throw this.failure(HEADLESS_EXIT.startup, `pi did not start (${this.options.piBin}): ${message}${hint}`);
    }
    if (state.success !== true) {
      throw this.failure(HEADLESS_EXIT.startup, `pi did not start: ${stringField(state, 'error') ?? 'get_state failed'}`);
    }
  }

  private async checkTowerCommand(pi: HeadlessPi): Promise<void> {
    let response: PiEvent;
    try {
      response = await this.guard(pi.send({ type: 'get_commands' }, this.deps.commandTimeoutMs ?? 60_000));
    } catch (error) {
      if (error instanceof HeadlessExit) throw error;
      throw this.failure(HEADLESS_EXIT.startup, `pi did not answer get_commands: ${errorText(error)}`);
    }
    const listed = recordField(response, 'data')?.commands;
    if (response.success !== true || !Array.isArray(listed)) {
      this.line(`pi cannot list its commands (${stringField(response, 'error') ?? 'no command list'}) — checking how it handles /tower on instead`);
      return;
    }
    const names = listed
      .map((entry: unknown) => (typeof entry === 'object' && entry !== null ? (entry as Readonly<Record<string, unknown>>) : {}))
      .filter((entry) => entry.source === undefined || entry.source === 'extension')
      .map((entry) => (typeof entry.name === 'string' ? entry.name : ''));
    if (names.includes('tower')) return;
    const duplicates = names.filter((name) => /^tower:\d+$/.test(name));
    if (duplicates.length > 0) {
      throw this.failure(
        HEADLESS_EXIT.startup,
        `the pi-tower extension is loaded more than once, so pi renamed its commands to ${duplicates.map((name) => `/${name}`).join(', ')} and /tower is ambiguous — load it only once (drop -e when pi-tower is also installed as a pi package)`,
      );
    }
    throw this.failure(HEADLESS_EXIT.startup, `pi has no /tower command — ${EXTENSION_HINT}`);
  }

  private async sendCommand(pi: HeadlessPi, text: string): Promise<PiCommandResult> {
    if (this.interrupt !== undefined) throw this.interruptExit();
    this.line(`> ${text}`);
    this.commandsInFlight += 1;
    try {
      return await this.guard(pi.command(text, this.deps.commandTimeoutMs ?? 60_000));
    } finally {
      this.commandsInFlight -= 1;
    }
  }

  private async towerCommand(pi: HeadlessPi, text: string, code: number): Promise<PiCommandResult> {
    let result: PiCommandResult;
    try {
      result = await this.sendCommand(pi, text);
    } catch (error) {
      if (error instanceof HeadlessExit) throw error;
      throw this.failure(code, `${text} failed: ${errorText(error)}`);
    }
    if (!result.success) throw this.failure(code, `pi rejected ${text}: ${result.error ?? 'no reason given'}`);
    if (result.disposition !== 'handled') {
      throw this.failure(
        code,
        `pi did not run ${text} as a pi-tower command (the prompt was ${result.disposition ?? 'not handled'}) — ${EXTENSION_HINT}`,
      );
    }
    const errors = result.notices.filter((notice) => notice.level === 'error').map((notice) => notice.text);
    if (errors.length > 0) throw this.failure(code, `${text} failed: ${errors.join(' | ')}`, errors);
    for (const notice of result.notices) {
      if (notice.level === 'info') this.line(`pi: ${notice.text.split('\n')[0] ?? ''}`);
      else this.fail(`pi ${notice.level}: ${notice.text}`);
    }
    return result;
  }

  private async showModels(pi: HeadlessPi): Promise<void> {
    let result: PiCommandResult;
    try {
      result = await this.sendCommand(pi, TOWER_MODELS_COMMAND);
    } catch (error) {
      if (error instanceof HeadlessExit) throw error;
      this.modelsUnavailable(`${TOWER_MODELS_COMMAND} failed: ${errorText(error)}`);
      return;
    }
    if (!result.success) {
      this.modelsUnavailable(`pi rejected ${TOWER_MODELS_COMMAND}: ${result.error ?? 'no reason given'}`);
      return;
    }
    if (result.disposition !== 'handled') {
      this.modelsUnavailable(`pi did not run ${TOWER_MODELS_COMMAND} as a pi-tower command (the prompt was ${result.disposition ?? 'not handled'})`);
      return;
    }
    const errors = result.notices.filter((notice) => notice.level === 'error').map((notice) => notice.text);
    if (errors.length > 0) {
      this.modelsUnavailable(`${TOWER_MODELS_COMMAND} failed: ${errors.join(' | ')}`);
      return;
    }
    for (const notice of result.notices) {
      if (notice.level !== 'info') this.fail(`pi ${notice.level}: ${notice.text}`);
    }
    const replies = result.notices.filter((notice) => notice.level === 'info').map((notice) => notice.text);
    const lines = replies.map((reply) => towerModelLines(reply)).find((described) => described !== undefined);
    if (lines === undefined) {
      this.modelsUnavailable(replies.length === 0 ? `${TOWER_MODELS_COMMAND} gave no reply` : `the ${TOWER_MODELS_COMMAND} reply has no model table: ${replies.join(' ')}`);
      return;
    }
    for (const line of lines) this.line(line);
  }

  private modelsUnavailable(reason: string): void {
    this.line(`role models unavailable (${oneLine(reason)}) — continuing`);
  }

  private onPiEvent(pi: HeadlessPi, event: PiEvent): void {
    if (event.type === 'extension_ui_request' && PI_DIALOG_METHODS.includes(String(event.method))) {
      pi.respond(String(event.id), { cancelled: true });
      this.line(`cancelled a pi ${String(event.method)} dialog nobody can answer headless: ${stringField(event, 'title') ?? ''}`);
      return;
    }
    if (event.type === 'extension_error') {
      if (!(isCommandError(event) && this.commandsInFlight > 0)) this.fail(`pi extension error: ${String(event.error)}`);
      return;
    }
    const notice = noticeOf(event);
    if (notice !== undefined && notice.level !== 'info' && this.commandsInFlight === 0) this.fail(`pi ${notice.level}: ${notice.text}`);
  }

  private async snapshot(): Promise<HeadlessSnapshot | undefined> {
    try {
      const snapshot = await this.deps.readState(this.options.cwd);
      this.stateError = undefined;
      return snapshot;
    } catch (error) {
      const message = errorText(error);
      if (this.stateError !== message) this.fail(`cannot read .tower/comms/state.json (will retry): ${message}`);
      this.stateError = message;
      return undefined;
    }
  }

  private isLeftover(objective: HeadlessObjective): boolean {
    const leftover = this.leftover;
    return leftover !== undefined && objective.id === leftover.id && objective.createdAt === leftover.createdAt;
  }

  private async follow(pi: HeadlessPi): Promise<HeadlessExit> {
    let rereadNow = false;
    for (;;) {
      const rereading: boolean = rereadNow;
      rereadNow = false;
      const snapshot = await this.snapshot();
      const objective = snapshot?.objective;
      if (objective !== undefined && !this.isLeftover(objective)) {
        this.current = objective;
        const key = progressKey(objective);
        if (key !== this.lastKey) {
          this.lastKey = key;
          this.line(progressLine(objective, snapshot?.features ?? []));
        }
        const verdict = await this.react(pi, objective, snapshot?.features ?? []);
        if (verdict === 'approved') rereadNow = !rereading;
        else if (verdict !== undefined) return verdict;
      } else if (!this.waitingNoted) {
        this.waitingNoted = true;
        this.line('waiting for the orchestrator to draft the objective');
      }
      if (pi.exit !== undefined) {
        const what = this.current === undefined ? 'before the objective was drafted' : `before objective ${this.current.id} finished (it was ${this.current.status})`;
        throw this.failure(HEADLESS_EXIT.stopped, `pi exited (${pi.exit.reason}) ${what}`);
      }
      if (rereadNow) {
        if (this.interrupt !== undefined) throw this.interruptExit();
        continue;
      }
      await this.deps.clock.sleep(this.pollMs(), this.stop.signal);
      if (this.interrupt !== undefined) throw this.interruptExit();
    }
  }

  private async react(pi: HeadlessPi, objective: HeadlessObjective, features: readonly HeadlessFeature[]): Promise<HeadlessExit | 'approved' | undefined> {
    if (objective.status !== 'awaiting-approval' && this.approvalSince !== undefined) {
      this.approvalSince = undefined;
      this.line(`objective ${objective.id} moved on to ${objective.status} while waiting for its approval — following it`);
    }
    switch (objective.status) {
      case 'completed':
        return new HeadlessExit(HEADLESS_EXIT.completed, `objective ${objective.id} "${objective.title}" completed`);
      case 'blocked':
        throw new HeadlessExit(HEADLESS_EXIT.stopped, `objective ${objective.id} is blocked: ${objective.blockedReason ?? 'no reason recorded'}`);
      case 'paused':
        throw new HeadlessExit(
          HEADLESS_EXIT.stopped,
          `objective ${objective.id} is paused: ${objective.pausedReason ?? 'no reason recorded'} — resume it with /tower resume in pi, then re-run pi-tower run to follow it`,
        );
      case 'awaiting-approval':
        if (!this.options.autoApprove) return this.awaitApproval(objective, features);
        this.deps.output.info(renderPlan(objective, features));
        await this.approve(pi, objective);
        return 'approved';
      default:
        return undefined;
    }
  }

  private awaitApproval(objective: HeadlessObjective, features: readonly HeadlessFeature[]): undefined {
    const now = this.deps.clock.now();
    if (this.approvalSince === undefined) {
      this.approvalSince = now;
      this.deps.output.info(renderPlan(objective, features));
    }
    if (now - this.approvalSince < APPROVAL_GRACE_POLLS * this.pollMs()) return undefined;
    throw new HeadlessExit(
      HEADLESS_EXIT.approval,
      `objective ${objective.id} needs approval — re-run with --auto-approve to approve and continue it, or run /tower approve in pi`,
    );
  }

  private async approve(pi: HeadlessPi, objective: HeadlessObjective): Promise<void> {
    try {
      await this.towerCommand(pi, AUTO_APPROVE_COMMAND, HEADLESS_EXIT.stopped);
    } catch (error) {
      const refusal = error instanceof HeadlessExit ? error.refusal : undefined;
      if (refusal === undefined) throw error;
      const latest = (await this.snapshot())?.objective;
      if (latest?.id === objective.id && PAST_APPROVAL.has(latest.status)) {
        this.line(`objective ${objective.id} moved on to ${latest.status} meanwhile, so pi refused ${AUTO_APPROVE_COMMAND} — following it`);
        return;
      }
      if (!refusal.some((text) => text.includes(TOWER_HUMAN_APPROVAL_MARKER))) throw error;
      this.fail(`pi refused ${AUTO_APPROVE_COMMAND}: ${refusal.join(' | ')}`);
      throw new HeadlessExit(HEADLESS_EXIT.approval, `objective ${objective.id} needs approval — a human must approve: run /tower approve in pi`);
    }
    this.line(`auto-approved the plan of ${objective.id} (--auto-approve)`);
  }

  private pollMs(): number {
    return this.deps.pollMs ?? DEFAULT_POLL_MS;
  }
}

export function runHeadless(options: HeadlessRunOptions, deps: HeadlessDeps): Promise<number> {
  return new HeadlessRun(options, deps).execute();
}
