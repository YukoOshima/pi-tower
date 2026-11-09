import type { HeadlessRunOptions } from '../../src/headless/args.ts';
import type { PiCommandResult, PiEvent, PiExit, PiNotice, PiRpcOptions, PiUiResponse } from '../../src/headless/rpc.ts';
import type { HeadlessClock, HeadlessDeps, HeadlessPi, HeadlessSignal } from '../../src/headless/runner.ts';
import { parseHeadlessSnapshot, type HeadlessSnapshot } from '../../src/headless/state.ts';
import type { Json } from './harness.ts';

export function snapshot(objective: Json | undefined, missions: readonly Json[] = []): HeadlessSnapshot {
  return parseHeadlessSnapshot({ version: 1, missions, ...(objective === undefined ? {} : { objective }) });
}

export class VirtualClock implements HeadlessClock {
  current = 0;
  private timers: { readonly at: number; readonly resolve: () => void }[] = [];

  now(): number {
    return this.current;
  }

  sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = { at: this.current + ms, resolve };
      this.timers.push(timer);
      signal.addEventListener(
        'abort',
        () => {
          this.timers = this.timers.filter((candidate) => candidate !== timer);
          resolve();
        },
        { once: true },
      );
      setImmediate(() => {
        this.tick();
      });
    });
  }

  private tick(): void {
    const next = [...this.timers].sort((a, b) => a.at - b.at)[0];
    if (next === undefined) return;
    this.timers = this.timers.filter((candidate) => candidate !== next);
    this.current = Math.max(this.current, next.at);
    next.resolve();
  }
}

export interface StubReaction {
  readonly success?: boolean;
  readonly error?: string;
  readonly disposition?: string;
  readonly notices?: readonly PiNotice[];
  readonly effect?: (pi: StubPi) => void;
}

export class StubPi implements HeadlessPi {
  exit: PiExit | undefined;
  stderr = '';
  getState: PiEvent = { type: 'response', command: 'get_state', success: true, data: {} };
  readonly options: PiRpcOptions;
  readonly reactions: Record<string, StubReaction> = {};
  readonly commands: string[] = [];
  readonly responses: { readonly id: string; readonly response: PiUiResponse }[] = [];
  readonly killed: string[] = [];
  closed = false;
  terminated = false;
  private readonly listeners = new Set<(event: PiEvent) => void>();

  constructor(options: PiRpcOptions) {
    this.options = options;
  }

  stderrTail(): string {
    return this.stderr.trim();
  }

  async send(command: Readonly<Record<string, unknown>>): Promise<PiEvent> {
    if (this.exit !== undefined) throw new Error(`pi is gone (${this.exit.reason})`);
    if (command.type === 'get_state') return this.getState;
    return { type: 'response', command: String(command.type), success: true };
  }

  async command(text: string): Promise<PiCommandResult> {
    if (this.exit !== undefined) throw new Error(`pi is gone (${this.exit.reason})`);
    this.commands.push(text);
    const key = Object.keys(this.reactions).find((prefix) => text.startsWith(prefix));
    const reaction: StubReaction = key === undefined ? { disposition: 'started' } : (this.reactions[key] ?? {});
    reaction.effect?.(this);
    const success = reaction.success ?? true;
    return {
      success,
      disposition: success ? (reaction.disposition ?? 'handled') : undefined,
      error: success ? undefined : (reaction.error ?? 'rejected'),
      notices: reaction.notices ?? [],
    };
  }

  emit(event: PiEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  onEvent(listener: (event: PiEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  respond(id: string, response: PiUiResponse): void {
    this.responses.push({ id, response });
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.killed.push(signal);
  }

  die(code: number, stderr = ''): void {
    this.stderr += stderr;
    this.exit = { code, signal: null, reason: `exited with code ${String(code)}` };
  }

  async close(): Promise<PiExit | undefined> {
    this.closed = true;
    this.exit ??= { code: 0, signal: null, reason: 'exited with code 0' };
    return this.exit;
  }

  async terminate(): Promise<PiExit | undefined> {
    this.terminated = true;
    this.exit ??= { code: 143, signal: null, reason: 'exited with code 143' };
    return this.exit;
  }
}

export class StateScript {
  private current: HeadlessSnapshot | undefined;
  private readonly queue: (HeadlessSnapshot | Error)[] = [];
  reads = 0;
  onRead: ((reads: number) => void) | undefined;

  constructor(initial?: HeadlessSnapshot) {
    this.current = initial;
  }

  set(next: HeadlessSnapshot | undefined): void {
    this.current = next;
    this.queue.length = 0;
  }

  push(...next: (HeadlessSnapshot | Error)[]): void {
    this.queue.push(...next);
  }

  async read(): Promise<HeadlessSnapshot | undefined> {
    this.reads += 1;
    this.onRead?.(this.reads);
    const next = this.queue.shift();
    if (next instanceof Error) throw next;
    if (next !== undefined) this.current = next;
    return this.current;
  }
}

export interface StubRun {
  readonly clock: VirtualClock;
  readonly state: StateScript;
  readonly info: string[];
  readonly errors: string[];
  readonly pis: StubPi[];
  readonly deps: HeadlessDeps;
  pi(): StubPi;
  signal(signal: HeadlessSignal): void;
  signalHandlers(): number;
}

export function stubRun(configure: (pi: StubPi, state: StateScript) => void, overrides: Partial<HeadlessDeps> = {}): StubRun {
  const clock = new VirtualClock();
  const state = new StateScript();
  const info: string[] = [];
  const errors: string[] = [];
  const pis: StubPi[] = [];
  const handlers = new Set<(signal: HeadlessSignal) => void>();
  const deps: HeadlessDeps = {
    createPi: (options) => {
      const pi = new StubPi(options);
      configure(pi, state);
      pis.push(pi);
      return pi;
    },
    clock,
    readState: () => state.read(),
    output: { info: (line) => info.push(line), error: (line) => errors.push(line) },
    onSignal: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    pollMs: 1000,
    ...overrides,
  };
  return {
    clock,
    state,
    info,
    errors,
    pis,
    deps,
    pi: () => {
      const pi = pis[0];
      if (pi === undefined) throw new Error('pi was not created');
      return pi;
    },
    signal: (signal) => {
      for (const handler of [...handlers]) handler(signal);
    },
    signalHandlers: () => handlers.size,
  };
}

export function runOptions(extra: Partial<HeadlessRunOptions> = {}): HeadlessRunOptions {
  return {
    objectiveFile: '/work/objective.md',
    autoApprove: false,
    timeoutMs: undefined,
    cwd: '/work/repo',
    piBin: 'pi',
    piArgs: [],
    ...extra,
  };
}
