import { resolve } from 'node:path';

import { MAX_DELAY_MS } from './timers.ts';

export interface HeadlessRunOptions {
  readonly objectiveFile: string;
  readonly autoApprove: boolean;
  readonly timeoutMs: number | undefined;
  readonly cwd: string;
  readonly piBin: string;
  readonly piArgs: readonly string[];
}

export type HeadlessArgs =
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'run'; readonly options: HeadlessRunOptions }
  | { readonly kind: 'error'; readonly message: string };

export const HEADLESS_USAGE = [
  'Usage: pi-tower run -f <objective.md> [--auto-approve] [--timeout <ms>] [--cwd <dir>] [--pi <path>] [-- <extra pi args>]',
  '       pi-tower --help | --version',
  '',
  'Runs a tower objective unattended: starts `pi --mode rpc` in <dir>, turns tower mode on, hands it the',
  'objective file (/tower objective --headless) and follows .tower/comms/state.json until the objective ends.',
  '',
  'Options:',
  '  -f, --file <path>   objective file (markdown); required',
  '  --auto-approve      approve the plan without a human (sends /tower approve --auto, recorded as an automatic approval)',
  '  --timeout <ms>      give up after this many milliseconds, at most 2147483647 (exit 2)',
  '  --cwd <dir>         repository to run in (default: the current directory)',
  '  --pi <path>         pi executable: a path, or a command looked up on PATH (default: pi)',
  '  -- <args>           everything after -- is passed to pi unchanged',
  '  -h, --help          show this help',
  '  --version           print the pi-tower version',
  '',
  'Relative paths are resolved against the current directory.',
  '',
  'Exit codes:',
  '  0  objective completed',
  '  1  objective blocked or paused, or pi exited after the run started',
  '  2  timeout',
  '  3  the plan needs approval (re-run with --auto-approve, or /tower approve in pi; a plan changed while',
  '     blocked or paused needs a human /tower approve)',
  '  4  usage or startup error',
  '  130 / 143  interrupted by SIGINT / SIGTERM (pi is stopped first)',
].join('\n');

const VALUE_OPTIONS: Readonly<Record<string, 'file' | 'timeout' | 'cwd' | 'pi'>> = {
  '-f': 'file',
  '--file': 'file',
  '--timeout': 'timeout',
  '--cwd': 'cwd',
  '--pi': 'pi',
};

function failure(message: string): HeadlessArgs {
  return { kind: 'error', message };
}

export function parseHeadlessArgs(argv: readonly string[], baseDir: string): HeadlessArgs {
  const split = argv.indexOf('--');
  const own = split === -1 ? argv : argv.slice(0, split);
  const piArgs = split === -1 ? [] : argv.slice(split + 1);
  if (own.includes('--help') || own.includes('-h')) return { kind: 'help' };
  if (own.includes('--version')) return { kind: 'version' };
  const [command, ...rest] = own;
  if (command === undefined) return failure('missing command — expected "run"');
  if (command !== 'run') {
    return failure(command.startsWith('-') ? `unknown option ${command} — options go after "run"` : `unknown command "${command}" — expected "run"`);
  }
  const values: Partial<Record<'file' | 'timeout' | 'cwd' | 'pi', string>> = {};
  let autoApprove = false;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? '';
    if (token === '--auto-approve') {
      if (autoApprove) return failure('--auto-approve is given twice');
      autoApprove = true;
      continue;
    }
    const equals = token.startsWith('--') ? token.indexOf('=') : -1;
    const name = equals === -1 ? token : token.slice(0, equals);
    const key = Object.hasOwn(VALUE_OPTIONS, name) ? VALUE_OPTIONS[name] : undefined;
    if (key === undefined) {
      return failure(token.startsWith('-') ? `unknown option ${name}` : `unexpected argument "${token}"`);
    }
    if (values[key] !== undefined) return failure(`${name} is given twice`);
    let value: string | undefined;
    if (equals === -1) {
      value = rest[index + 1];
      if (value !== undefined && value.startsWith('-')) value = undefined;
      if (value !== undefined) index += 1;
    } else {
      value = token.slice(equals + 1);
    }
    if (value === undefined || value.trim().length === 0) return failure(`${name} needs a value`);
    values[key] = value;
  }
  if (values.file === undefined) return failure('missing -f <objective file>');
  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    timeoutMs = /^\d+$/.test(values.timeout) ? Number(values.timeout) : Number.NaN;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      return failure(`--timeout must be a positive whole number of milliseconds, got "${values.timeout}"`);
    }
    if (timeoutMs > MAX_DELAY_MS) {
      return failure(`--timeout must be at most ${String(MAX_DELAY_MS)} milliseconds (about 24.8 days), got "${values.timeout}"`);
    }
  }
  return {
    kind: 'run',
    options: {
      objectiveFile: resolve(baseDir, values.file),
      autoApprove,
      timeoutMs,
      cwd: resolve(baseDir, values.cwd ?? '.'),
      piBin: values.pi === undefined ? 'pi' : /[\\/]/.test(values.pi) ? resolve(baseDir, values.pi) : values.pi,
      piArgs,
    },
  };
}
