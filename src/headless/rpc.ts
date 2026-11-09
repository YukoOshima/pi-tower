import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type PiEvent = { readonly type: string } & Readonly<Record<string, unknown>>;

export interface PiNotice {
  readonly level: string;
  readonly text: string;
}

export interface PiCommandResult {
  readonly success: boolean;
  readonly disposition: string | undefined;
  readonly error: string | undefined;
  readonly notices: readonly PiNotice[];
}

export interface PiExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly reason: string;
}

export interface PiRpcOptions {
  readonly piBin: string;
  readonly cwd: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

export type PiUiResponse = { readonly cancelled: true } | { readonly confirmed: boolean } | { readonly value: string };

export class PiRpcError extends Error {}

export class PiTimeoutError extends PiRpcError {}

export const PI_DIALOG_METHODS: readonly string[] = ['select', 'confirm', 'input', 'editor'];

const STDERR_LIMIT = 64 * 1024;

interface Pending {
  readonly resolve: (event: PiEvent) => void;
  readonly reject: (error: Error) => void;
}

export function stringField(record: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

export function recordField(record: Readonly<Record<string, unknown>> | undefined, key: string): Readonly<Record<string, unknown>> | undefined {
  const value = record?.[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function noticeOf(event: PiEvent): PiNotice | undefined {
  if (event.type !== 'extension_ui_request' || event.method !== 'notify') return undefined;
  return { level: stringField(event, 'notifyType') ?? 'info', text: stringField(event, 'message') ?? '' };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PiRpcClient {
  readonly options: PiRpcOptions;
  stderr = '';
  running = false;
  lastEventAt = Date.now();
  exit: PiExit | undefined;
  readonly exited: Promise<PiExit>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(event: PiEvent) => void>();
  private readonly goneListeners = new Set<(exit: PiExit) => void>();
  private buffer = '';
  private counter = 0;
  private resolveExited: (exit: PiExit) => void = () => undefined;

  constructor(options: PiRpcOptions) {
    this.options = options;
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
    this.child = spawn(options.piBin, ['--mode', 'rpc', ...(options.args ?? [])], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.on('exit', (code, signal) => {
      this.markGone({ code, signal, reason: signal === null ? `exited with code ${String(code)}` : `killed by ${signal}` });
    });
    this.child.on('error', (error) => {
      this.markGone({ code: null, signal: null, reason: error.message });
    });
    this.child.stdin.on('error', (error) => {
      this.markGone({ code: null, signal: null, reason: `stdin ${error.message}` });
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-STDERR_LIMIT);
    });
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let index: number;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).replace(/\r$/, '');
        this.buffer = this.buffer.slice(index + 1);
        if (line.trim().length === 0) continue;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof event === 'object' && event !== null && typeof (event as { type?: unknown }).type === 'string') {
          this.dispatch(event as PiEvent);
        }
      }
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  stderrTail(lines = 15): string {
    return this.stderr.trim().split('\n').slice(-lines).join('\n');
  }

  onEvent(listener: (event: PiEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private markGone(exit: PiExit): void {
    const first = this.exit === undefined;
    if (first || exit.code !== null || exit.signal !== null) this.exit = exit;
    this.running = false;
    if (!first) return;
    this.resolveExited(exit);
    const error = new PiRpcError(`pi is gone (${exit.reason})`);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const listener of [...this.goneListeners]) listener(exit);
    this.goneListeners.clear();
  }

  private dispatch(event: PiEvent): void {
    this.lastEventAt = Date.now();
    if (event.type === 'response' && typeof event.id === 'string' && this.pending.has(event.id)) {
      const pending = this.pending.get(event.id);
      this.pending.delete(event.id);
      pending?.resolve(event);
      return;
    }
    if (event.type === 'agent_start') this.running = true;
    if (event.type === 'agent_settled') this.running = false;
    for (const listener of [...this.listeners]) listener(event);
  }

  private write(record: Readonly<Record<string, unknown>>): boolean {
    if (this.exit !== undefined || this.child.stdin.destroyed || this.child.stdin.writableEnded) return false;
    try {
      this.child.stdin.write(`${JSON.stringify(record)}\n`);
      return true;
    } catch (error) {
      this.markGone({ code: null, signal: null, reason: `stdin write failed: ${error instanceof Error ? error.message : String(error)}` });
      return false;
    }
  }

  send(command: Readonly<Record<string, unknown>>, timeoutMs = 30_000): Promise<PiEvent> {
    const id = `req-${String(++this.counter)}`;
    if (this.exit !== undefined) return Promise.reject(new PiRpcError(`pi is gone (${this.exit.reason}) — cannot send ${String(command.type)}`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PiTimeoutError(`timeout after ${String(timeoutMs)}ms waiting for the ${String(command.type)} response`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      if (!this.write({ ...command, id })) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new PiRpcError(`pi is gone (${this.exit?.reason ?? 'stdin closed'}) — cannot send ${String(command.type)}`));
      }
    });
  }

  respond(id: string, response: PiUiResponse): void {
    this.write({ type: 'extension_ui_response', id, ...response });
  }

  waitFor(match: (event: PiEvent) => boolean, timeoutMs: number, label: string): Promise<PiEvent> {
    if (this.exit !== undefined) return Promise.reject(new PiRpcError(`pi is gone (${this.exit.reason}) — not waiting for ${label}`));
    return new Promise((resolve, reject) => {
      const gone = (exit: PiExit): void => {
        finish(new PiRpcError(`pi is gone (${exit.reason}) while waiting for ${label}`));
      };
      const finish = (error: Error | undefined, event?: PiEvent): void => {
        clearTimeout(timer);
        unsubscribe();
        this.goneListeners.delete(gone);
        if (error !== undefined) reject(error);
        else if (event !== undefined) resolve(event);
      };
      const unsubscribe = this.onEvent((event) => {
        if (match(event)) finish(undefined, event);
      });
      const timer = setTimeout(() => {
        finish(new PiTimeoutError(`timeout after ${String(timeoutMs)}ms waiting for ${label}`));
      }, timeoutMs);
      this.goneListeners.add(gone);
    });
  }

  async waitIdle(timeoutMs: number, quietMs = 1500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.exit !== undefined) throw new PiRpcError(`pi is gone (${this.exit.reason}) while waiting for the session to go idle`);
      if (!this.running) {
        let restarted = false;
        const unsubscribe = this.onEvent((event) => {
          if (event.type === 'agent_start') restarted = true;
        });
        await delay(quietMs);
        unsubscribe();
        if (!this.running && !restarted && this.exit === undefined) return;
      }
      if (Date.now() > deadline) throw new PiTimeoutError(`timeout after ${String(timeoutMs)}ms waiting for the session to go idle`);
      await delay(250);
    }
  }

  async command(text: string, timeoutMs = 30_000): Promise<PiCommandResult> {
    const notices: PiNotice[] = [];
    const unsubscribe = this.onEvent((event) => {
      const notice = noticeOf(event);
      if (notice !== undefined) notices.push(notice);
    });
    try {
      const response = await this.send({ type: 'prompt', message: text }, timeoutMs);
      const success = response.success === true;
      return {
        success,
        disposition: stringField(recordField(response, 'data'), 'disposition'),
        error: success ? undefined : (stringField(response, 'error') ?? 'pi rejected the command'),
        notices,
      };
    } finally {
      unsubscribe();
    }
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.exit !== undefined) return;
    try {
      this.child.kill(signal);
    } catch {
      return;
    }
  }

  private async exitWithin(ms: number): Promise<boolean> {
    if (this.exit !== undefined) return true;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    const result = await Promise.race([this.exited.then(() => true as const), timedOut]);
    clearTimeout(timer);
    return result;
  }

  private release(): void {
    if (this.exit === undefined) return;
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }

  async terminate(graceMs = 5_000): Promise<PiExit | undefined> {
    if (this.exit === undefined) {
      this.kill('SIGTERM');
      if (!(await this.exitWithin(graceMs))) {
        this.kill('SIGKILL');
        await this.exitWithin(5_000);
      }
    }
    this.release();
    return this.exit;
  }

  async close(graceMs = 10_000): Promise<PiExit | undefined> {
    if (this.exit === undefined) {
      try {
        this.child.stdin.end();
      } catch {
        return this.terminate(graceMs);
      }
      if (!(await this.exitWithin(graceMs))) return this.terminate(graceMs);
    }
    this.release();
    return this.exit;
  }
}
