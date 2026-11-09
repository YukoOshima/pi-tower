import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FakeAction {
  readonly delayMs?: number;
  readonly objective?: Record<string, unknown> | null;
  readonly missions?: readonly Record<string, unknown>[];
  readonly emit?: readonly Record<string, unknown>[];
  readonly notify?: { readonly level?: string; readonly text: string };
  readonly dialog?: { readonly method: string; readonly title: string };
  readonly stderr?: string;
  readonly split?: { readonly stream: 'stdout' | 'stderr'; readonly text: string };
  readonly exit?: number;
}

export interface FakeCommand {
  readonly match: string;
  readonly disposition?: string;
  readonly error?: string;
  readonly before?: readonly FakeAction[];
  readonly after?: readonly FakeAction[];
}

export interface FakeScenario {
  readonly stderr?: string;
  readonly startupExit?: number;
  readonly ignoreSigterm?: boolean;
  readonly spawnChild?: boolean;
  readonly registered?: readonly string[];
  readonly noGetCommands?: boolean;
  readonly silent?: readonly string[];
  readonly commands?: readonly FakeCommand[];
}

type Json = Record<string, unknown>;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const scenarioPath = option('--scenario');
const logPath = option('--log');
const scenario: FakeScenario = scenarioPath === undefined ? {} : (JSON.parse(readFileSync(scenarioPath, 'utf8')) as FakeScenario);
const statePath = join(process.cwd(), '.tower', 'comms', 'state.json');
let dialogs = 0;

function log(entry: Json): void {
  if (logPath !== undefined) appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function emit(record: Json): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeSplit(stream: 'stdout' | 'stderr', text: string): Promise<void> {
  const line = stream === 'stdout' ? `${JSON.stringify({ type: 'extension_ui_request', id: 'split', method: 'notify', message: text, notifyType: 'info' })}\n` : text;
  const bytes = Buffer.from(line, 'utf8');
  const cut = bytes.findIndex((byte) => byte >= 0x80) + 1;
  const target = stream === 'stdout' ? process.stdout : process.stderr;
  target.write(bytes.subarray(0, cut));
  await sleep(50);
  target.write(bytes.subarray(cut));
}

function writeState(patch: Json): void {
  mkdirSync(join(process.cwd(), '.tower', 'comms'), { recursive: true });
  const current = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, 'utf8')) as Json) : { version: 1, base: 'main', missions: [] };
  const next: Json = { ...current, ...patch };
  if (patch.objective === null) delete next.objective;
  const tmp = `${statePath}.tmp-${String(process.pid)}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, statePath);
}

async function perform(actions: readonly FakeAction[] | undefined): Promise<void> {
  for (const action of actions ?? []) {
    if (action.delayMs !== undefined) await sleep(action.delayMs);
    if (action.objective !== undefined) writeState({ objective: action.objective });
    if (action.missions !== undefined) writeState({ missions: action.missions });
    for (const record of action.emit ?? []) emit(record);
    if (action.notify !== undefined) {
      emit({ type: 'extension_ui_request', id: `notify-${String(Date.now())}`, method: 'notify', message: action.notify.text, notifyType: action.notify.level ?? 'info' });
    }
    if (action.dialog !== undefined) {
      dialogs += 1;
      emit({ type: 'extension_ui_request', id: `dialog-${String(dialogs)}`, method: action.dialog.method, title: action.dialog.title });
    }
    if (action.stderr !== undefined) process.stderr.write(action.stderr);
    if (action.split !== undefined) await writeSplit(action.split.stream, action.split.text);
    if (action.exit !== undefined) {
      log({ kind: 'exit', code: action.exit });
      process.exit(action.exit);
    }
  }
}

async function onPrompt(id: unknown, message: string): Promise<void> {
  const command = (scenario.commands ?? []).find((candidate) => message.startsWith(candidate.match));
  if (command === undefined) {
    emit({ id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
    emit({ type: 'agent_start' });
    await sleep(20);
    emit({ type: 'agent_settled', aborted: false });
    return;
  }
  await perform(command.before);
  if (command.error !== undefined) {
    emit({ id, type: 'response', command: 'prompt', success: false, error: command.error });
    return;
  }
  emit({ id, type: 'response', command: 'prompt', success: true, data: { disposition: command.disposition ?? 'handled' } });
  void perform(command.after);
}

function onRecord(record: Json): void {
  log({ kind: record.type === 'extension_ui_response' ? 'ui-response' : 'command', record });
  const type = String(record.type);
  if ((scenario.silent ?? []).includes(type)) return;
  switch (type) {
    case 'get_state':
      emit({ id: record.id, type: 'response', command: 'get_state', success: true, data: { model: { provider: 'fake', id: 'fake-model' }, isStreaming: false } });
      return;
    case 'get_commands':
      if (scenario.noGetCommands === true) {
        emit({ id: record.id, type: 'response', command: type, success: false, error: `Unknown command: ${type}` });
        return;
      }
      emit({
        id: record.id,
        type: 'response',
        command: type,
        success: true,
        data: { commands: (scenario.registered ?? ['tower']).map((name) => ({ name, source: 'extension' })) },
      });
      return;
    case 'prompt':
      void onPrompt(record.id, String(record.message));
      return;
    case 'abort':
      emit({ id: record.id, type: 'response', command: 'abort', success: true });
      return;
    case 'extension_ui_response':
      return;
    default:
      emit({ id: record.id, type: 'response', command: type, success: false, error: `Unknown command: ${type}` });
  }
}

log({ kind: 'start', argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid });
if (scenario.stderr !== undefined) process.stderr.write(scenario.stderr);
if (scenario.startupExit !== undefined) {
  log({ kind: 'exit', code: scenario.startupExit });
  process.exit(scenario.startupExit);
}
process.on('SIGTERM', () => {
  log({ kind: 'signal', signal: 'SIGTERM' });
  if (scenario.ignoreSigterm !== true) process.exit(143);
});
if (scenario.ignoreSigterm === true) setInterval(() => undefined, 1000);
if (scenario.spawnChild === true) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 60000)'], { stdio: 'ignore' });
  child.unref();
  log({ kind: 'child', pid: child.pid });
}

let buffer = '';
process.stdin.on('data', (chunk: Buffer) => {
  buffer += chunk.toString('utf8');
  let index: number;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length > 0) onRecord(JSON.parse(line) as Json);
  }
});
process.stdin.on('end', () => {
  log({ kind: 'stdin-end' });
  if (scenario.ignoreSigterm !== true) process.exit(0);
});
