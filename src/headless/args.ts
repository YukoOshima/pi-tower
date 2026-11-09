import { resolve } from 'node:path';

import { TOWER_MODEL_FLAGS } from '../config/load.ts';
import { MODEL_REF_FORMAT, parseModelRef, TOWER_ROLES } from '../config/modelRef.ts';
import type { TowerRole } from '../config/types.ts';
import { MAX_DELAY_MS } from './timers.ts';

export type HeadlessModels = Readonly<Partial<Record<TowerRole, string>>>;

export interface HeadlessRunOptions {
  readonly objectiveFile: string;
  readonly autoApprove: boolean;
  readonly timeoutMs: number | undefined;
  readonly cwd: string;
  readonly piBin: string;
  readonly piArgs: readonly string[];
  readonly models: HeadlessModels;
}

export type HeadlessArgs =
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'run'; readonly options: HeadlessRunOptions }
  | { readonly kind: 'error'; readonly message: string };

export const HEADLESS_SYNOPSIS = [
  'Usage: pi-tower run -f <objective.md> [--auto-approve] [--timeout <ms>] [--cwd <dir>] [--pi <path>]',
  '                    [--orchestrator-model <ref>] [--worker-model <ref>] [--reviewer-model <ref>]',
  '                    [--validator-model <ref>] [-- <extra pi args>]',
  '       pi-tower exec --mission -f <mission.md> [run options]',
  '       pi-tower --help | --version',
].join('\n');

export const HEADLESS_USAGE = [
  HEADLESS_SYNOPSIS,
  '',
  'Runs a tower objective unattended: starts `pi --mode rpc` in <dir>, turns tower mode on, prints the model of every',
  'role (/tower models) and warns about each model problem it reports, hands pi the objective file',
  '(/tower objective --headless) and follows .tower/comms/state.json until the objective ends.',
  '`pi-tower exec --mission -f <file>` is Droid\'s spelling of `pi-tower run -f <file>`.',
  '',
  'Options:',
  '  -f, --file <path>           objective file (markdown); required',
  '  --auto-approve              approve the plan without a human (sends /tower approve --auto, recorded as an automatic approval)',
  '  --timeout <ms>              give up after this many milliseconds, at most 2147483647 (exit 2)',
  '  --cwd <dir>                 repository to run in (default: the current directory)',
  '  --pi <path>                 pi executable: a path, or a command looked up on PATH (default: pi)',
  `  --orchestrator-model <ref>  model of the orchestrator; <ref> is ${MODEL_REF_FORMAT},`,
  '                              e.g. anthropic/claude-sonnet-4-5:high',
  '  --worker-model <ref>        model of the workers',
  '  --reviewer-model <ref>      model of the reviewers',
  '  --validator-model <ref>     model of the validators',
  '  --mission                   required by exec; run accepts it and ignores it',
  '  -- <args>                   everything after -- is passed to pi unchanged',
  '  -h, --help                  show this help',
  '  --version                   print the pi-tower version',
  '',
  'Relative paths are resolved against the current directory.',
  '',
  'Each --<role>-model reaches pi as --tower-<role>-model, which takes precedence over PI_TOWER_<ROLE>_MODEL and',
  'tower.json. It comes after the extra pi args, so it wins over a --tower-<role>-model given after --. A role',
  'without such a flag keeps its configured model.',
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

type ValueKey = 'file' | 'timeout' | 'cwd' | 'pi' | TowerRole;

const VALUE_OPTIONS: Readonly<Record<string, ValueKey>> = {
  '-f': 'file',
  '--file': 'file',
  '--timeout': 'timeout',
  '--cwd': 'cwd',
  '--pi': 'pi',
  ...Object.fromEntries(TOWER_ROLES.map((role) => [modelOption(role), role])),
};

const SWITCHES: readonly string[] = ['--auto-approve', '--mission'];

const COMMANDS = '"run" or "exec --mission"';

const EXEC_HINT = 'exec needs --mission (pi-tower only runs missions) — use pi-tower exec --mission -f <mission.md>, the same as pi-tower run -f <mission.md>';

function modelOption(role: TowerRole): string {
  return `--${role}-model`;
}

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
  if (command === undefined) return failure(`missing command — expected ${COMMANDS}`);
  if (command !== 'run' && command !== 'exec') {
    return failure(command.startsWith('-') ? `unknown option ${command} — options go after ${COMMANDS}` : `unknown command "${command}" — expected ${COMMANDS}`);
  }
  if (command === 'exec' && !rest.some((token) => token === '--mission' || token.startsWith('--mission='))) return failure(EXEC_HINT);
  const values: Partial<Record<ValueKey, string>> = {};
  const switches = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? '';
    const equals = token.startsWith('--') ? token.indexOf('=') : -1;
    const name = equals === -1 ? token : token.slice(0, equals);
    if (SWITCHES.includes(name)) {
      if (equals !== -1) return failure(`${name} takes no value`);
      if (switches.has(name)) return failure(`${name} is given twice`);
      switches.add(name);
      continue;
    }
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
  const models: Partial<Record<TowerRole, string>> = {};
  for (const role of TOWER_ROLES) {
    const ref = values[role]?.trim();
    if (ref === undefined) continue;
    const parsed = parseModelRef(ref);
    if (!parsed.ok) return failure(`${modelOption(role)} ${parsed.error}`);
    models[role] = ref;
  }
  return {
    kind: 'run',
    options: {
      objectiveFile: resolve(baseDir, values.file),
      autoApprove: switches.has('--auto-approve'),
      timeoutMs,
      cwd: resolve(baseDir, values.cwd ?? '.'),
      piBin: values.pi === undefined ? 'pi' : /[\\/]/.test(values.pi) ? resolve(baseDir, values.pi) : values.pi,
      piArgs,
      models,
    },
  };
}

export function piRunArgs(options: Pick<HeadlessRunOptions, 'piArgs' | 'models'>): string[] {
  const flags = TOWER_ROLES.flatMap((role) => {
    const ref = options.models[role];
    return ref === undefined ? [] : [`--${TOWER_MODEL_FLAGS[role]}=${ref}`];
  });
  const end = options.piArgs.indexOf('--');
  if (end === -1) return [...options.piArgs, ...flags];
  return [...options.piArgs.slice(0, end), ...flags, ...options.piArgs.slice(end)];
}
