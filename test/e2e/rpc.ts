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

export type PiDialogAnswer = { readonly cancelled: true } | { readonly value: string } | { readonly confirmed: boolean };

export interface PiDialogRequest {
  readonly id: string;
  readonly method: string;
  readonly title: string;
  readonly message: string | undefined;
  readonly options: readonly string[];
}

export interface PiDialog extends PiDialogRequest {
  readonly index: number;
  readonly answer: PiDialogAnswer;
}

export type PiDialogResponder = (request: PiDialogRequest) => PiDialogAnswer | undefined;

export interface PiStatusUpdate {
  readonly index: number;
  readonly text: string | undefined;
}

export interface PiWidgetUpdate {
  readonly index: number;
  readonly lines: readonly string[] | undefined;
  readonly plain: boolean;
  readonly placement: string | undefined;
}

export const DIALOG_METHODS: readonly string[] = ['select', 'confirm', 'input', 'editor'];

export const CANCEL_DIALOG: PiDialogAnswer = { cancelled: true };

export function dialogRequestOf(event: PiEvent): PiDialogRequest | undefined {
  if (event.type !== 'extension_ui_request' || !DIALOG_METHODS.includes(String(event.method))) return undefined;
  return {
    id: String(event.id),
    method: String(event.method),
    title: typeof event.title === 'string' ? event.title : '',
    message: typeof event.message === 'string' ? event.message : undefined,
    options: Array.isArray(event.options) ? event.options.map(String) : [],
  };
}

export function describeDialogAnswer(answer: PiDialogAnswer): string {
  if ('value' in answer) return `chose "${answer.value}"`;
  if ('confirmed' in answer) return answer.confirmed ? 'confirmed' : 'declined';
  return 'cancelled';
}

export function chooseOption(position: number, applies: (request: PiDialogRequest) => boolean = () => true): PiDialogResponder {
  return (request) => {
    if (request.method !== 'select' || !applies(request)) return undefined;
    const option = request.options[position];
    return option === undefined ? undefined : { value: option };
  };
}

interface Waiter {
  readonly match: (event: PiEvent) => boolean;
  readonly resolve: (event: PiEvent) => void;
  readonly reject: (error: Error) => void;
}

interface Pending {
  readonly resolve: (event: PiEvent) => void;
  readonly reject: (error: Error) => void;
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
  readonly dialogs: PiDialog[] = [];
  readonly options: PiRpcOptions;
  dialogResponder: PiDialogResponder | undefined;
  stderr = '';
  running = false;
  lastEventAt = Date.now();
  exitCode: number | null | undefined;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private waiters: Waiter[] = [];
  private buffer = '';
  private counter = 0;
  private readonly exited: Promise<number | null>;
  private resolveExited: (code: number | null) => void = () => undefined;

  constructor(options: PiRpcOptions) {
    this.options = options;
    this.child = spawn(options.piBin, ['--mode', 'rpc', ...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.log(`spawn pi ${options.args.join(' ')} (cwd ${options.cwd}, pid ${String(this.child.pid)})`);
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
    this.child.on('exit', (code) => {
      this.log(`pi exited: ${String(code)}`);
      this.markGone(code, `exited with ${String(code)}`);
    });
    this.child.on('error', (error) => {
      this.log(`pi process error: ${error.message}`);
      this.markGone(null, error.message);
    });
    this.child.stdin.on('error', (error) => {
      this.log(`pi stdin error: ${error.message}`);
      this.markGone(null, `stdin ${error.message}`);
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

  private markGone(code: number | null, reason: string): void {
    const first = this.exitCode === undefined;
    if (first || code !== null) this.exitCode = code;
    this.running = false;
    this.resolveExited(code);
    if (!first) return;
    const error = new Error(`[${this.options.label}] pi is gone (${reason})`);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  log(text: string): void {
    const line = `${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s [${this.options.label}] ${text}`;
    appendFileSync(this.options.logFile, `${line}\n`);
    if (this.options.echo) console.log(line);
  }

  private onEvent(event: PiEvent): void {
    this.lastEventAt = Date.now();
    if (event.type === 'message_update') return;
    if (event.type === 'response' && typeof event.id === 'string' && this.pending.has(event.id)) {
      const pending = this.pending.get(event.id);
      this.pending.delete(event.id);
      this.events.push(event);
      pending?.resolve(event);
      return;
    }
    this.events.push(event);
    this.describe(event);
    if (event.type === 'agent_start') this.running = true;
    if (event.type === 'agent_settled') this.running = false;
    const dialog = dialogRequestOf(event);
    if (dialog !== undefined) this.answerDialog(dialog, this.events.length - 1);
    for (const waiter of [...this.waiters]) {
      if (waiter.match(event)) {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        waiter.resolve(event);
      }
    }
  }

  private answerDialog(request: PiDialogRequest, index: number): void {
    let answer = CANCEL_DIALOG;
    try {
      answer = this.dialogResponder?.(request) ?? CANCEL_DIALOG;
    } catch (error) {
      this.log(`dialog responder failed (${error instanceof Error ? error.message : String(error)}) — cancelling`);
    }
    this.dialogs.push({ ...request, index, answer });
    const options = request.options.length === 0 ? '' : ` options [${request.options.map((option) => `"${option}"`).join(', ')}]`;
    this.log(`dialog ${request.method}: ${clip(request.title.length > 0 ? request.title : (request.message ?? ''))}${options} — ${describeDialogAnswer(answer)}`);
    this.write({ type: 'extension_ui_response', id: request.id, ...answer });
  }

  private describe(event: PiEvent): void {
    switch (event.type) {
      case 'extension_ui_request':
        if (event.method === 'notify') this.log(`[notify:${String(event.notifyType ?? 'info')}] ${clip(String(event.message), 1200)}`);
        else if (event.method === 'setStatus') this.log(`[status ${String(event.statusKey)}] ${String(event.statusText ?? '(cleared)')}`);
        else if (event.method === 'setWidget') this.log(`[widget ${String(event.widgetKey)}] ${Array.isArray(event.widgetLines) ? clip(event.widgetLines.map(String).join(' ⏎ '), 900) : '(cleared)'}`);
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
    if (this.exitCode !== undefined || this.child.stdin.destroyed) return;
    try {
      this.child.stdin.write(`${JSON.stringify(record)}\n`);
    } catch (error) {
      this.markGone(null, `stdin write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  send(command: Record<string, unknown>, timeoutMs = 30_000): Promise<PiEvent> {
    const id = `req-${String(++this.counter)}`;
    if (this.exitCode !== undefined) return Promise.reject(new Error(`[${this.options.label}] pi is gone — cannot send ${String(command.type)}`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PiTimeoutError(`[${this.options.label}] timeout waiting for ${String(command.type)} response`));
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
      this.write({ id, ...command });
    });
  }

  waitFor(match: (event: PiEvent) => boolean, timeoutMs: number, label: string, fromIndex = this.events.length): Promise<PiEvent> {
    const seen = this.events.slice(fromIndex).find(match);
    if (seen !== undefined) return Promise.resolve(seen);
    if (this.exitCode !== undefined) return Promise.reject(new Error(`[${this.options.label}] pi is gone — not waiting for ${label}`));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        match,
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
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
    return this.statusUpdates(key).map((update) => update.text);
  }

  statusUpdates(key: string, fromIndex = 0): PiStatusUpdate[] {
    return this.events.flatMap((event, index): PiStatusUpdate[] => {
      if (index < fromIndex || event.type !== 'extension_ui_request' || event.method !== 'setStatus' || event.statusKey !== key) return [];
      return [{ index, text: typeof event.statusText === 'string' ? event.statusText : undefined }];
    });
  }

  widgetUpdates(key: string, fromIndex = 0): PiWidgetUpdate[] {
    return this.events.flatMap((event, index): PiWidgetUpdate[] => {
      if (index < fromIndex || event.type !== 'extension_ui_request' || event.method !== 'setWidget' || event.widgetKey !== key) return [];
      const raw: unknown = event.widgetLines;
      const lines = Array.isArray(raw) && raw.every((line) => typeof line === 'string') ? (raw as string[]) : undefined;
      return [{ index, lines, plain: raw === undefined || lines !== undefined, placement: typeof event.widgetPlacement === 'string' ? event.widgetPlacement : undefined }];
    });
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
