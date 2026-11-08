import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync } from 'node:fs';

export type PiEvent = { readonly type: string } & Record<string, any>;

export interface PiNotice {
  readonly index: number;
  readonly level: string;
  readonly text: string;
}

export interface PiToolRun {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly output: string;
  readonly isError: boolean;
  readonly index: number;
}

export interface PiAssistantTurn {
  readonly index: number;
  readonly provider: string | undefined;
  readonly model: string | undefined;
  readonly text: string;
  readonly stopReason: string | undefined;
  readonly errorMessage: string | undefined;
}

export interface PiCommandResult {
  readonly disposition: string | undefined;
  readonly error: string | undefined;
  readonly notices: readonly PiNotice[];
  readonly text: string;
}

export interface PiRpcOptions {
  readonly label: string;
  readonly piBin: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly logFile: string;
  readonly echo: boolean;
}

interface Waiter {
  readonly match: (event: PiEvent) => boolean;
  readonly resolve: (event: PiEvent) => void;
}

export class PiTimeoutError extends Error {}

const started = Date.now();

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

export function clip(text: string, max = 240): string {
  const flat = text.replaceAll('\n', ' ⏎ ');
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PiRpc {
  readonly events: PiEvent[] = [];
  readonly options: PiRpcOptions;
  stderr = '';
  running = false;
  exitCode: number | null | undefined;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, (event: PiEvent) => void>();
  private waiters: Waiter[] = [];
  private buffer = '';
  private counter = 0;
  private readonly exited: Promise<number | null>;

  constructor(options: PiRpcOptions) {
    this.options = options;
    this.child = spawn(options.piBin, ['--mode', 'rpc', ...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.log(`spawn pi ${options.args.join(' ')} (cwd ${options.cwd}, pid ${String(this.child.pid)})`);
    this.exited = new Promise((resolve) => {
      this.child.on('exit', (code) => {
        this.exitCode = code;
        this.log(`pi exited: ${String(code)}`);
        resolve(code);
      });
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString('utf8');
    });
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let index: number;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).replace(/\r$/, '');
        this.buffer = this.buffer.slice(index + 1);
        if (line.trim().length === 0) continue;
        let event: PiEvent;
        try {
          event = JSON.parse(line) as PiEvent;
        } catch {
          continue;
        }
        this.onEvent(event);
      }
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  log(text: string): void {
    const line = `${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s [${this.options.label}] ${text}`;
    appendFileSync(this.options.logFile, `${line}\n`);
    if (this.options.echo) console.log(line);
  }

  private onEvent(event: PiEvent): void {
    if (event.type === 'message_update') return;
    if (event.type === 'response' && typeof event.id === 'string' && this.pending.has(event.id)) {
      const resolve = this.pending.get(event.id);
      this.pending.delete(event.id);
      this.events.push(event);
      resolve?.(event);
      return;
    }
    this.events.push(event);
    this.describe(event);
    if (event.type === 'agent_start') this.running = true;
    if (event.type === 'agent_settled') this.running = false;
    if (event.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(String(event.method))) {
      this.log(`auto-cancel dialog ${String(event.method)}: ${clip(String(event.title ?? event.message ?? ''))}`);
      this.write({ type: 'extension_ui_response', id: event.id, cancelled: true });
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.match(event)) {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        waiter.resolve(event);
      }
    }
  }

  private describe(event: PiEvent): void {
    switch (event.type) {
      case 'extension_ui_request':
        if (event.method === 'notify') this.log(`[notify:${String(event.notifyType ?? 'info')}] ${clip(String(event.message), 1200)}`);
        else if (event.method === 'setStatus') this.log(`[status ${String(event.statusKey)}] ${String(event.statusText ?? '(cleared)')}`);
        return;
      case 'tool_execution_start':
        this.log(`[tool ▶] ${String(event.toolName)} ${clip(JSON.stringify(event.args ?? {}), 400)}`);
        return;
      case 'tool_execution_end':
        this.log(`[tool ■] ${String(event.toolName)}${event.isError === true ? ' (error)' : ''}: ${clip(textOf(event.result?.content), 600)}`);
        return;
      case 'message_end': {
        const message = event.message ?? {};
        if (message.role === 'assistant') {
          const text = textOf(message.content);
          this.log(`[assistant ${String(message.provider)}/${String(message.model)}] ${clip(text, 400)}`);
          if (message.stopReason === 'error') this.log(`[assistant error] ${clip(String(message.errorMessage), 400)}`);
        } else if (message.role === 'custom') {
          this.log(`[custom ${String(message.customType)}] ${clip(textOf(message.content), 600)}`);
        } else if (message.role === 'user') {
          this.log(`[user] ${clip(textOf(message.content), 300)}`);
        }
        return;
      }
      case 'agent_settled':
        this.log(`[agent_settled] aborted=${String(event.aborted)}`);
        return;
      case 'auto_retry_start':
      case 'auto_retry_end':
        this.log(`[${event.type}] ${clip(JSON.stringify(event), 300)}`);
        return;
      default:
        return;
    }
  }

  private write(record: Record<string, unknown>): void {
    if (this.exitCode !== undefined) return;
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  send(command: Record<string, unknown>, timeoutMs = 30_000): Promise<PiEvent> {
    const id = `req-${String(++this.counter)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PiTimeoutError(`[${this.options.label}] timeout waiting for ${String(command.type)} response`));
      }, timeoutMs);
      this.pending.set(id, (event) => {
        clearTimeout(timer);
        resolve(event);
      });
      this.write({ id, ...command });
    });
  }

  waitFor(match: (event: PiEvent) => boolean, timeoutMs: number, label: string, fromIndex = this.events.length): Promise<PiEvent> {
    const seen = this.events.slice(fromIndex).find(match);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        match,
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        reject(new PiTimeoutError(`[${this.options.label}] timeout after ${String(timeoutMs)}ms waiting for ${label}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async waitUntil(check: () => boolean | Promise<boolean>, timeoutMs: number, label: string, pollMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (this.exitCode !== undefined) throw new Error(`[${this.options.label}] pi exited (${String(this.exitCode)}) while waiting for ${label}`);
      if (Date.now() > deadline) throw new PiTimeoutError(`[${this.options.label}] timeout after ${String(timeoutMs)}ms waiting for ${label}`);
      await sleep(pollMs);
    }
  }

  async waitIdle(timeoutMs: number, quietMs = 1500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!this.running) {
        const mark = this.events.length;
        await sleep(quietMs);
        if (!this.running && !this.events.slice(mark).some((event) => event.type === 'agent_start')) return;
      }
      if (Date.now() > deadline) throw new PiTimeoutError(`[${this.options.label}] timeout after ${String(timeoutMs)}ms waiting for the session to go idle`);
      await sleep(500);
    }
  }

  async command(text: string, settleMs = 400): Promise<PiCommandResult> {
    this.log(`> ${text}`);
    const mark = this.events.length;
    const response = await this.send({ type: 'prompt', message: text });
    await sleep(settleMs);
    const notices = this.noticesSince(mark);
    if (response.success !== true) this.log(`[response error] ${String(response.error)}`);
    return {
      disposition: response.data?.disposition as string | undefined,
      error: response.success === true ? undefined : String(response.error),
      notices,
      text: notices.map((notice) => notice.text).join('\n'),
    };
  }

  async prompt(text: string, timeoutMs: number): Promise<{ readonly from: number; readonly to: number }> {
    await this.waitIdle(timeoutMs);
    this.log(`> (prompt) ${clip(text, 300)}`);
    const from = this.events.length;
    const settled = this.waitFor((event) => event.type === 'agent_settled', timeoutMs, `settle after prompt "${clip(text, 60)}"`, from);
    const response = await this.send({ type: 'prompt', message: text, streamingBehavior: 'followUp' });
    if (response.success !== true) throw new Error(`[${this.options.label}] prompt refused: ${String(response.error)}`);
    await settled;
    return { from, to: this.events.length };
  }

  noticesSince(fromIndex: number): PiNotice[] {
    const notices: PiNotice[] = [];
    this.events.forEach((event, index) => {
      if (index < fromIndex || event.type !== 'extension_ui_request' || event.method !== 'notify') return;
      notices.push({ index, level: String(event.notifyType ?? 'info'), text: String(event.message ?? '') });
    });
    return notices;
  }

  toolRuns(fromIndex = 0, toIndex = this.events.length): PiToolRun[] {
    const starts = new Map<string, Record<string, unknown>>();
    const runs: PiToolRun[] = [];
    this.events.forEach((event, index) => {
      if (index < fromIndex || index >= toIndex) return;
      if (event.type === 'tool_execution_start') starts.set(String(event.toolCallId), (event.args ?? {}) as Record<string, unknown>);
      if (event.type === 'tool_execution_end') {
        runs.push({
          toolCallId: String(event.toolCallId),
          toolName: String(event.toolName),
          args: starts.get(String(event.toolCallId)) ?? {},
          output: textOf(event.result?.content),
          isError: event.isError === true,
          index,
        });
      }
    });
    return runs;
  }

  assistantTurns(fromIndex = 0, toIndex = this.events.length): PiAssistantTurn[] {
    const turns: PiAssistantTurn[] = [];
    this.events.forEach((event, index) => {
      if (index < fromIndex || index >= toIndex || event.type !== 'message_end' || event.message?.role !== 'assistant') return;
      const message = event.message;
      turns.push({
        index,
        provider: message.provider as string | undefined,
        model: message.model as string | undefined,
        text: textOf(message.content),
        stopReason: message.stopReason as string | undefined,
        errorMessage: message.errorMessage as string | undefined,
      });
    });
    return turns;
  }

  customMessages(customType: string, fromIndex = 0): { readonly index: number; readonly text: string }[] {
    const found: { index: number; text: string }[] = [];
    this.events.forEach((event, index) => {
      if (index < fromIndex || event.type !== 'message_end' || event.message?.role !== 'custom') return;
      if (event.message.customType === customType) found.push({ index, text: textOf(event.message.content) });
    });
    return found;
  }

  statusTexts(key: string): (string | undefined)[] {
    return this.events
      .filter((event) => event.type === 'extension_ui_request' && event.method === 'setStatus' && event.statusKey === key)
      .map((event) => event.statusText as string | undefined);
  }

  async close(graceMs = 20_000): Promise<void> {
    if (this.exitCode !== undefined) return;
    try {
      if (this.running) await this.send({ type: 'abort' }, 10_000).catch(() => undefined);
      this.child.stdin.end();
    } catch {
      // the process may already be gone
    }
    const code = await Promise.race([this.exited, sleep(graceMs).then(() => 'timeout' as const)]);
    if (code === 'timeout') {
      this.log('pi did not exit in time — SIGKILL');
      this.child.kill('SIGKILL');
      await Promise.race([this.exited, sleep(5000)]);
    }
    const tail = this.stderr.trim().split('\n').slice(-15).join('\n');
    if (tail.length > 0) this.log(`stderr tail:\n${tail}`);
  }

  kill(): void {
    if (this.exitCode === undefined) this.child.kill('SIGKILL');
  }
}
