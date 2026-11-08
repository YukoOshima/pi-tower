import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { COMMS_DIR, TOWER_ROOT, WORKTREES_DIR } from '../protocol/paths.ts';
import {
  parseShell,
  type ShellAndOr,
  type ShellCommand,
  type ShellPipeline,
  type ShellScript,
  type ShellWord,
} from './shellParser.ts';

export const TOWER_BASH_GUARD_PARSE_OPTIONS = { maxTokens: 10_000 } as const;

export async function towerWorkspaceOwned(stateFile: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(stateFile, 'utf8');
  } catch {
    return false;
  }
  try {
    const sessionId = (JSON.parse(raw) as { sessionId?: unknown }).sessionId;
    return typeof sessionId === 'string' && sessionId.length > 0;
  } catch {
    return true;
  }
}

export interface TowerBashGuardTarget {
  readonly command: string;
  readonly cwd: string;
  readonly mainCheckout: string;
  readonly home?: string;
}

interface TowerLayout {
  readonly mainCheckout: string;
  readonly towerRoot: string;
  readonly commsDir: string;
  readonly worktreesDir: string;
  readonly home: string;
}

type Cwd = string | undefined;

interface WalkResult {
  readonly veto?: string;
  readonly ok: readonly Cwd[];
  readonly fail: readonly Cwd[];
}

interface GuardState {
  gitRedirected: boolean;
  homeRedirected: boolean;
}

interface GuardContext {
  readonly layout: TowerLayout;
  readonly depth: number;
  readonly state: GuardState;
}

const MAX_NESTED_PARSE_DEPTH = 4;
const MAX_CWD_CANDIDATES = 32;

const GIT_KEYWORD = /\bgit\b/i;
const CLEAN_KEYWORD = /\bclean\b/i;
const RESET_KEYWORD = /\breset\b/i;
const RM_KEYWORD = /\brm\b/i;

export function commandNeedsTowerGuard(command: string): boolean {
  return mentionsGuardedKeyword(command) || mentionsGuardedKeyword(command.replaceAll(/\\\n|["'\\]/g, ''));
}

export function analyzeTowerBashCommand(target: TowerBashGuardTarget): string | undefined {
  if (!commandNeedsTowerGuard(target.command)) return undefined;
  const ctx: GuardContext = {
    layout: towerLayout(target.mainCheckout, target.home ?? homedir()),
    depth: 0,
    state: { gitRedirected: false, homeRedirected: false },
  };
  return analyzeSource(target.command, [resolve(target.cwd)], ctx).veto;
}

function mentionsGuardedKeyword(text: string): boolean {
  if (RM_KEYWORD.test(text)) return true;
  return GIT_KEYWORD.test(text) && (CLEAN_KEYWORD.test(text) || RESET_KEYWORD.test(text));
}

function towerLayout(mainCheckout: string, home: string): TowerLayout {
  const root = resolve(mainCheckout);
  return {
    mainCheckout: root,
    towerRoot: join(root, TOWER_ROOT),
    commsDir: join(root, COMMS_DIR),
    worktreesDir: join(root, WORKTREES_DIR),
    home: resolve(home),
  };
}

function analyzeSource(source: string, cwds: readonly Cwd[], ctx: GuardContext): WalkResult {
  const parsed = parseShell(source, TOWER_BASH_GUARD_PARSE_OPTIONS);
  return parsed.ok ? walkScript(parsed.script, cwds, ctx) : vetoed(UNANALYZABLE_VETO);
}

function walkScript(script: ShellScript, cwds: readonly Cwd[], ctx: GuardContext): WalkResult {
  let result: WalkResult = { ok: cwds, fail: [] };
  for (const statement of script.statements) {
    const input = result.ok;
    const outcome = walkAndOr(statement.body, input, ctx);
    if (outcome.veto !== undefined) return outcome;
    result = statement.background ? { ok: input, fail: [] } : outcome;
  }
  return result;
}

function walkAndOr(andOr: ShellAndOr, cwds: readonly Cwd[], ctx: GuardContext): WalkResult {
  let result = walkPipeline(andOr.first, cwds, ctx);
  for (const link of andOr.rest) {
    if (result.veto !== undefined) return result;
    if (link.operator === '&&') {
      const next = walkPipeline(link.pipeline, result.ok, ctx);
      result = { veto: next.veto, ok: next.ok, fail: union(result.fail, next.fail) };
    } else {
      const next = walkPipeline(link.pipeline, result.fail, ctx);
      result = { veto: next.veto, ok: union(result.ok, next.ok), fail: next.fail };
    }
  }
  return result;
}

function walkPipeline(pipeline: ShellPipeline, cwds: readonly Cwd[], ctx: GuardContext): WalkResult {
  const [only, ...others] = pipeline.commands;
  if (only !== undefined && others.length === 0) {
    const result = walkCommand(only, cwds, ctx);
    return pipeline.negated ? { veto: result.veto, ok: result.fail, fail: result.ok } : result;
  }
  for (const command of pipeline.commands) {
    const result = walkCommand(command, cwds, ctx);
    if (result.veto !== undefined) return result;
  }
  return passthrough(cwds);
}

const TEST_COMMANDS: ReadonlySet<string> = new Set(['[', '[[']);

function walkCommand(command: ShellCommand, cwds: readonly Cwd[], ctx: GuardContext): WalkResult {
  if (cwds.length === 0) return { ok: [], fail: [] };
  for (const assignment of command.assignments) noteAssignment(assignment.name, ctx.state);
  const [name, ...args] = command.words;
  if (name === undefined || TEST_COMMANDS.has(name.text)) return passthrough(cwds);
  if (name.value === undefined) return vetoed(UNANALYZABLE_VETO);
  return analyzeInvocation(normalizeCommandName(name.value), args, cwds, ctx);
}

function analyzeInvocation(
  name: string,
  args: readonly ShellWord[],
  cwds: readonly Cwd[],
  ctx: GuardContext,
): WalkResult {
  if (PRIVILEGE_WRAPPERS.has(name)) {
    return childFlow(analyzeWrapped(dropLeadingOptions(args, PRIVILEGE_OPTIONS), cwds, ctx), cwds);
  }
  if (LAUNCH_WRAPPERS.has(name)) {
    const result = analyzeWrapped(dropLaunchWrapperOperands(name, args, ctx.state), cwds, ctx);
    return CURRENT_SHELL_WRAPPERS.has(name) ? result : childFlow(result, cwds);
  }
  if (NESTED_SHELLS.has(name)) return analyzeNestedShell(args, cwds, ctx);
  if (name === 'eval') return analyzeEval(args, cwds, ctx);
  if (name === 'trap') return analyzeTrap(args, cwds, ctx);
  if (name === 'alias') return analyzeAlias(args, cwds);
  if (name === 'busybox') return analyzeBusybox(args, cwds, ctx);
  if (name === 'cd') return analyzeCd(args, cwds, homeOf(ctx));
  if (name === 'pushd') return analyzePushd(args, cwds, homeOf(ctx));
  if (name === 'popd') return analyzePopd(args, cwds);
  if (name === 'exit') return { ok: [], fail: [] };
  if (DECLARATION_BUILTINS.has(name)) return analyzeDeclaration(args, cwds, ctx.state);
  if (name === 'git') return analyzeGit(args, cwds, ctx);
  if (name === 'rm') return analyzeRm(args, cwds, ctx.layout, homeOf(ctx));
  return passthrough(cwds);
}

function homeOf(ctx: GuardContext): Cwd {
  return ctx.state.homeRedirected ? undefined : ctx.layout.home;
}

function noteAssignment(name: string, state: GuardState): void {
  if (GIT_REDIRECT_ENV.test(name)) state.gitRedirected = true;
  if (name === 'HOME') state.homeRedirected = true;
}

interface WrappedCommand {
  readonly rest: readonly ShellWord[];
  readonly chdir?: ShellWord;
  readonly unanalyzable?: boolean;
}

function analyzeWrapped(wrapped: WrappedCommand, cwds: readonly Cwd[], ctx: GuardContext): WalkResult {
  if (wrapped.unanalyzable === true) return vetoed(UNANALYZABLE_VETO);
  const [inner, ...rest] = wrapped.rest;
  if (inner === undefined) return passthrough(cwds);
  if (inner.value === undefined) return vetoed(UNANALYZABLE_VETO);
  const chdir = wrapped.chdir?.value;
  const home = homeOf(ctx);
  const innerCwds =
    wrapped.chdir === undefined
      ? cwds
      : candidates(cwds.map((cwd) => (chdir === undefined ? undefined : resolveOperand(cwd, chdir, home))));
  return analyzeInvocation(normalizeCommandName(inner.value), rest, innerCwds, ctx);
}

function analyzeNestedShell(args: readonly ShellWord[], cwds: readonly Cwd[], ctx: GuardContext): WalkResult {
  let command = false;
  let stdin = false;
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index]!.value;
    if (arg === undefined) return vetoed(UNANALYZABLE_VETO);
    if (arg === '--' || arg === '-') {
      index += 1;
      break;
    }
    if (arg.startsWith('--')) {
      if (SHELL_VALUE_OPTIONS.has(arg)) index += 1;
      continue;
    }
    if (!/^[-+][a-zA-Z]+$/.test(arg)) break;
    if (arg.startsWith('-') && arg.includes('c')) command = true;
    if (arg.startsWith('-') && arg.includes('s')) stdin = true;
    index += (arg.match(/[oO]/g) ?? []).length;
  }
  const operand = args[index];
  if (!command) {
    if (operand === undefined || stdin) return vetoed(UNANALYZABLE_VETO);
    const lateCommandFlag = args.slice(index + 1).some((word) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(word.value ?? ''));
    return lateCommandFlag ? vetoed(UNANALYZABLE_VETO) : passthrough(cwds);
  }
  if (operand === undefined) return passthrough(cwds);
  if (operand.value === undefined || ctx.depth >= MAX_NESTED_PARSE_DEPTH) return vetoed(UNANALYZABLE_VETO);
  return childFlow(analyzeSource(operand.value, cwds, { ...ctx, depth: ctx.depth + 1 }), cwds);
}

function analyzeEval(args: readonly ShellWord[], cwds: readonly Cwd[], ctx: GuardContext): WalkResult {
  const words = args[0]?.value === '--' ? args.slice(1) : args;
  if (words.length === 0) return passthrough(cwds);
  const values = words.map((word) => word.value);
  if (ctx.depth >= MAX_NESTED_PARSE_DEPTH || values.includes(undefined)) return vetoed(UNANALYZABLE_VETO);
  return analyzeSource(values.join(' '), cwds, { ...ctx, depth: ctx.depth + 1 });
}

function analyzeTrap(args: readonly ShellWord[], cwds: readonly Cwd[], ctx: GuardContext): WalkResult {
  let index = 0;
  while (index < args.length && TRAP_OPTIONS.has(args[index]!.value ?? '')) index += 1;
  const operands = args.slice(index);
  if (operands.length < 2) return passthrough(cwds);
  const action = operands[0]!.value;
  if (action === '' || action === '-') return passthrough(cwds);
  if (action === undefined || ctx.depth >= MAX_NESTED_PARSE_DEPTH) return vetoed(UNANALYZABLE_VETO);
  return childFlow(analyzeSource(action, [undefined], { ...ctx, depth: ctx.depth + 1 }), cwds);
}

function analyzeAlias(args: readonly ShellWord[], cwds: readonly Cwd[]): WalkResult {
  const defines = args.some((word) => word.value === undefined || word.value.includes('='));
  return defines ? vetoed(UNANALYZABLE_VETO) : passthrough(cwds);
}

function analyzeBusybox(args: readonly ShellWord[], cwds: readonly Cwd[], ctx: GuardContext): WalkResult {
  const applet = args[0];
  if (applet === undefined) return passthrough(cwds);
  if (applet.value === undefined) return vetoed(UNANALYZABLE_VETO);
  if (applet.value.startsWith('-')) return passthrough(cwds);
  return childFlow(analyzeInvocation(normalizeCommandName(applet.value), args.slice(1), cwds, ctx), cwds);
}

function analyzeCd(args: readonly ShellWord[], cwds: readonly Cwd[], home: Cwd): WalkResult {
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index]!.value;
    if (arg === '--') {
      index += 1;
      break;
    }
    if (arg === undefined || !/^-[LPe@]+$/.test(arg)) break;
  }
  const operands = args.slice(index);
  if (operands.length === 0) return { ok: [home], fail: cwds };
  const dir = operands.length === 1 ? operands[0]!.value : undefined;
  if (dir === undefined || dir === '-') return { ok: [undefined], fail: cwds };
  if (dir === '') return passthrough(cwds);
  return { ok: candidates(cwds.map((cwd) => resolveOperand(cwd, dir, home))), fail: cwds };
}

function analyzePushd(args: readonly ShellWord[], cwds: readonly Cwd[], home: Cwd): WalkResult {
  const operands = args[0]?.value === '--' ? args.slice(1) : args;
  if (operands.some((word) => word.value === '-n')) return passthrough(cwds);
  const dir = operands.length === 1 ? operands[0]!.value : undefined;
  if (dir === undefined || /^[+-]\d*$/.test(dir)) return { ok: [undefined], fail: cwds };
  return { ok: candidates(cwds.map((cwd) => resolveOperand(cwd, dir, home))), fail: cwds };
}

function analyzePopd(args: readonly ShellWord[], cwds: readonly Cwd[]): WalkResult {
  return args.some((word) => word.value === '-n') ? passthrough(cwds) : { ok: [undefined], fail: cwds };
}

function analyzeDeclaration(args: readonly ShellWord[], cwds: readonly Cwd[], state: GuardState): WalkResult {
  for (const word of args) {
    const name = /^([A-Za-z_][A-Za-z0-9_]*)(?:\+?=|$)/.exec(word.value ?? word.text)?.[1];
    if (name !== undefined) noteAssignment(name, state);
  }
  return passthrough(cwds);
}

function analyzeGit(args: readonly ShellWord[], cwds: readonly Cwd[], ctx: GuardContext): WalkResult {
  const chdirs: Cwd[] = [];
  let redirected = false;
  let subcommand: string | undefined;
  let subargs: readonly ShellWord[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!.value;
    if (arg === undefined) return vetoed(UNANALYZABLE_VETO);
    if (arg === '-C' || GIT_REDIRECT_OPTIONS.has(arg) || GIT_VALUE_OPTIONS.has(arg)) {
      const value = args[i + 1];
      if (value === undefined) return passthrough(cwds);
      if (arg === '-C') chdirs.push(value.value);
      if (GIT_REDIRECT_OPTIONS.has(arg)) redirected = true;
      i += 1;
      continue;
    }
    if (GIT_REDIRECT_PREFIXES.some((prefix) => arg.startsWith(prefix))) redirected = true;
    if (arg.startsWith('-')) continue;
    subcommand = arg.toLowerCase();
    subargs = args.slice(i + 1);
    break;
  }
  if (subcommand !== 'clean' && subcommand !== 'reset') return passthrough(cwds);
  const clean = subcommand === 'clean';
  const gitRedirected = redirected || ctx.state.gitRedirected;
  const home = homeOf(ctx);
  const vetoes = cwds.map((cwd) => {
    const gitCwd = chdirs.reduce<Cwd>(
      (current, dir) => (dir === undefined ? undefined : resolveOperand(current, dir, home)),
      cwd,
    );
    return clean
      ? analyzeGitClean(subargs, gitCwd, gitRedirected, ctx.layout, home)
      : analyzeGitReset(subargs, gitCwd, gitRedirected, ctx.layout);
  });
  return vetoOutcome(vetoes, cwds);
}

function analyzeGitClean(
  args: readonly ShellWord[],
  gitCwd: Cwd,
  redirected: boolean,
  layout: TowerLayout,
  home: Cwd,
): string | undefined {
  let forceCount = 0;
  let ignored = false;
  let dryRun = false;
  let interactive = false;
  const pathspecs: string[] = [];
  let optionsEnded = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!.value;
    if (arg === undefined) return UNANALYZABLE_VETO;
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith('--')) {
      if (isLongOption(arg, '--force')) forceCount += 1;
      if (isLongOption(arg, '--dry-run')) dryRun = true;
      if (isLongOption(arg, '--no-dry-run')) dryRun = false;
      if (isLongOption(arg, '--interactive')) interactive = true;
      if (isLongOption(arg, '--no-interactive')) interactive = false;
      if (isLongOption(arg, '--exclude')) i += 1;
      continue;
    }
    if (!optionsEnded && /^-[a-zA-Z]+$/.test(arg)) {
      const excludeAt = arg.indexOf('e');
      const cluster = excludeAt === -1 ? arg : arg.slice(0, excludeAt);
      forceCount += (cluster.match(/f/g) ?? []).length;
      if (cluster.includes('n')) dryRun = true;
      if (cluster.includes('i')) interactive = true;
      if (cluster.includes('x') || cluster.includes('X')) ignored = true;
      if (excludeAt === arg.length - 1) i += 1;
      continue;
    }
    if (arg.length > 0) pathspecs.push(arg);
  }
  if (dryRun || interactive) return undefined;
  if (redirected) return UNANALYZABLE_VETO;
  if (forceCount === 0 || !ignored) return undefined;
  if (gitCwd === undefined) return UNANALYZABLE_VETO;
  if (pathspecs.length === 0) {
    return isWithinOrEqual(layout.commsDir, gitCwd) ? GIT_CLEAN_VETO : undefined;
  }
  const gitCwdSlotDepth = slotDepth(gitCwd, layout.worktreesDir);
  for (const spec of pathspecs) {
    const abs = spec.startsWith(':') ? undefined : resolveOperand(gitCwd, spec, home);
    if (abs === undefined) return UNANALYZABLE_VETO;
    if (gitCwdSlotDepth !== undefined && gitCwdSlotDepth >= 1) {
      const specSlotDepth = slotDepth(abs, layout.worktreesDir);
      if (specSlotDepth !== undefined && specSlotDepth >= 1) continue;
    }
    if (operandBucket(abs, layout) !== undefined) return GIT_CLEAN_VETO;
  }
  return undefined;
}

function analyzeGitReset(
  args: readonly ShellWord[],
  gitCwd: Cwd,
  redirected: boolean,
  layout: TowerLayout,
): string | undefined {
  let hard = false;
  let dynamic = false;
  for (const word of args) {
    if (word.value === undefined) dynamic = true;
    else if (isLongOption(word.value, '--hard')) hard = true;
  }
  if (!hard && !dynamic) return undefined;
  if (redirected || gitCwd === undefined) return UNANALYZABLE_VETO;
  if (!isWithinOrEqual(gitCwd, layout.mainCheckout)) return undefined;
  if (isWithinOrEqual(gitCwd, layout.worktreesDir) && !pathsEqual(gitCwd, layout.worktreesDir)) {
    return undefined;
  }
  return hard ? GIT_RESET_VETO : UNANALYZABLE_VETO;
}

function analyzeRm(args: readonly ShellWord[], cwds: readonly Cwd[], layout: TowerLayout, home: Cwd): WalkResult {
  let recursive = false;
  let dynamic = false;
  const operands: string[] = [];
  let optionsEnded = false;
  for (const word of args) {
    const arg = word.value;
    if (arg === undefined) {
      dynamic = true;
      continue;
    }
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith('--')) {
      if (isLongOption(arg, '--recursive')) recursive = true;
      continue;
    }
    if (!optionsEnded && /^-[a-zA-Z]+$/.test(arg)) {
      if (/[rR]/.test(arg)) recursive = true;
      continue;
    }
    if (arg.length > 0) operands.push(arg);
  }
  const vetoes = cwds.map((cwd) => {
    let unresolved = dynamic;
    for (const operand of operands) {
      const abs = resolveOperand(cwd, operand, home);
      if (abs === undefined) {
        unresolved = true;
        continue;
      }
      const bucket = operandBucket(abs, layout);
      if (bucket === 'comms') return rmVeto(operand);
      if ((bucket === 'tower-ancestor' || bucket === 'protected-interior') && recursive) return rmVeto(operand);
    }
    return unresolved ? UNANALYZABLE_VETO : undefined;
  });
  return vetoOutcome(vetoes, cwds);
}

type OperandBucket = 'comms' | 'tower-ancestor' | 'protected-interior' | undefined;

function operandBucket(abs: string, layout: TowerLayout): OperandBucket {
  if (isWithinOrEqual(abs, layout.commsDir)) return 'comms';
  if (isWithinOrEqual(layout.towerRoot, abs)) return 'tower-ancestor';
  if (!isWithinOrEqual(abs, layout.towerRoot)) return undefined;
  const depth = slotDepth(abs, layout.worktreesDir);
  return depth !== undefined && depth >= 2 ? undefined : 'protected-interior';
}

function isWithinOrEqual(candidate: string, base: string): boolean {
  const rel = relative(base, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function pathsEqual(a: string, b: string): boolean {
  return relative(a, b) === '';
}

function slotDepth(path: string, worktreesDir: string): number | undefined {
  const rel = relative(worktreesDir, path);
  if (rel === '') return 0;
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).length;
}

function resolveOperand(cwd: Cwd, operand: string, home: Cwd): Cwd {
  if (operand === '~') return home;
  if (operand.startsWith('~/') || operand.startsWith(`~${sep}`)) {
    return home === undefined ? undefined : resolve(home, operand.slice(2));
  }
  if (isAbsolute(operand)) return resolve(operand);
  return cwd === undefined ? undefined : resolve(cwd, operand);
}

function isLongOption(arg: string, option: string): boolean {
  return arg.length >= 3 && !arg.includes('=') && option.startsWith(arg);
}

function normalizeCommandName(raw: string): string {
  let name = raw;
  const separator = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (separator >= 0) name = name.slice(separator + 1);
  name = name.toLowerCase();
  if (name.endsWith('.exe')) name = name.slice(0, -'.exe'.length);
  return name;
}

function candidates(cwds: readonly Cwd[]): readonly Cwd[] {
  const unique = [...new Set(cwds)];
  return unique.length > MAX_CWD_CANDIDATES ? [undefined] : unique;
}

function union(a: readonly Cwd[], b: readonly Cwd[]): readonly Cwd[] {
  return candidates([...a, ...b]);
}

function passthrough(cwds: readonly Cwd[]): WalkResult {
  return { ok: cwds, fail: cwds };
}

function vetoed(veto: string): WalkResult {
  return { veto, ok: [], fail: [] };
}

function childFlow(result: WalkResult, cwds: readonly Cwd[]): WalkResult {
  return result.veto === undefined ? passthrough(cwds) : result;
}

function vetoOutcome(vetoes: readonly (string | undefined)[], cwds: readonly Cwd[]): WalkResult {
  const veto =
    vetoes.find((candidate) => candidate !== undefined && candidate !== UNANALYZABLE_VETO) ??
    vetoes.find((candidate) => candidate !== undefined);
  return veto === undefined ? passthrough(cwds) : vetoed(veto);
}

const PRIVILEGE_WRAPPERS: ReadonlySet<string> = new Set(['sudo', 'doas']);

const PRIVILEGE_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-u',
  '--user',
  '-g',
  '--group',
  '-h',
  '--host',
  '-p',
  '--prompt',
  '-C',
  '--close-from',
  '-T',
  '--command-timeout',
  '-U',
  '--other-user',
  '-r',
  '--role',
  '-t',
  '--type',
]);

const LAUNCH_WRAPPERS: ReadonlySet<string> = new Set([
  'env',
  'command',
  'exec',
  'nohup',
  'builtin',
  'nice',
  'time',
]);

const CURRENT_SHELL_WRAPPERS: ReadonlySet<string> = new Set(['command', 'builtin', 'time']);

const WRAPPER_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-u',
  '--unset',
  '-C',
  '--chdir',
  '-S',
  '--split-string',
  '-a',
  '-n',
  '--adjustment',
  '-o',
  '--output',
  '-f',
  '--format',
]);

interface WrapperOptions {
  readonly values: ReadonlySet<string>;
  readonly chdir?: ReadonlySet<string>;
  readonly split?: ReadonlySet<string>;
}

const PRIVILEGE_OPTIONS: WrapperOptions = {
  values: PRIVILEGE_VALUE_OPTIONS,
  chdir: new Set(['-D', '--chdir']),
};

const LAUNCH_OPTIONS: WrapperOptions = { values: WRAPPER_VALUE_OPTIONS };

const ENV_OPTIONS: WrapperOptions = {
  values: WRAPPER_VALUE_OPTIONS,
  chdir: new Set(['-C', '--chdir']),
  split: new Set(['-S', '--split-string']),
};

const NESTED_SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'ash']);

const SHELL_VALUE_OPTIONS: ReadonlySet<string> = new Set(['--rcfile', '--init-file', '--emulate']);

const DECLARATION_BUILTINS: ReadonlySet<string> = new Set(['export', 'declare', 'typeset', 'readonly', 'local']);

const TRAP_OPTIONS: ReadonlySet<string> = new Set(['-l', '-p', '--']);

const GIT_REDIRECT_OPTIONS: ReadonlySet<string> = new Set(['-c', '--config-env', '--git-dir', '--work-tree']);

const GIT_REDIRECT_PREFIXES: readonly string[] = ['--config-env=', '--git-dir=', '--work-tree='];

const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '--namespace',
  '--super-prefix',
  '--attr-source',
  '--shallow-file',
]);

const GIT_REDIRECT_ENV = /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG\w*)$/;

const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;

function dropLeadingOptions(args: readonly ShellWord[], options: WrapperOptions): WrappedCommand {
  let chdir: ShellWord | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!.value;
    if (arg === undefined || arg === '-' || !arg.startsWith('-')) return { rest: args.slice(i), chdir };
    if (arg === '--') return { rest: args.slice(i + 1), chdir };
    if (options.split?.has(arg) === true || attachedValue(arg, options.split) !== undefined) {
      return { rest: [], unanalyzable: true };
    }
    if (options.chdir?.has(arg) === true) {
      chdir = args[i + 1];
      i += 1;
      continue;
    }
    const attachedDir = attachedValue(arg, options.chdir);
    if (attachedDir !== undefined) {
      chdir = { text: arg, value: attachedDir };
      continue;
    }
    if (!arg.includes('=') && options.values.has(arg)) i += 1;
  }
  return { rest: [], chdir };
}

function attachedValue(arg: string, names: ReadonlySet<string> | undefined): string | undefined {
  for (const name of names ?? []) {
    if (name.startsWith('--')) {
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    } else if (arg.length > name.length && arg.startsWith(name)) {
      return arg.slice(name.length);
    }
  }
  return undefined;
}

function dropLaunchWrapperOperands(name: string, args: readonly ShellWord[], state: GuardState): WrappedCommand {
  const wrapped = dropLeadingOptions(args, name === 'env' ? ENV_OPTIONS : LAUNCH_OPTIONS);
  if (name !== 'env' || wrapped.unanalyzable === true) return wrapped;
  let i = wrapped.rest[0]?.value === '-' ? 1 : 0;
  for (; i < wrapped.rest.length; i += 1) {
    const word = wrapped.rest[i]!;
    const variable = ENV_ASSIGNMENT.exec(word.value ?? word.text)?.[1];
    if (variable === undefined) break;
    noteAssignment(variable, state);
  }
  return { ...wrapped, rest: wrapped.rest.slice(i) };
}

const TOWER_GUARD_ESCAPE =
  'to retire the tower workspace deliberately, turn tower mode off and remove .tower/comms manually in a terminal — this guard only intercepts agent Bash calls.';

const GIT_CLEAN_VETO =
  '`git clean` with force and -x/-X is not allowed when its scope covers the tower main checkout — ' +
  'it would delete .tower/comms, the tower protocol state, which git does not track and cannot restore. ' +
  'Run the clean inside your own tower worktree or a temporary `git worktree add` checkout instead; ' +
  TOWER_GUARD_ESCAPE;

const GIT_RESET_VETO =
  '`git reset --hard` is not allowed in the tower main checkout — ' +
  'it would silently discard base-checkout work the tower fleet depends on. ' +
  'Run it inside your own tower worktree or a temporary worktree instead; ' +
  TOWER_GUARD_ESCAPE;

const UNANALYZABLE_VETO =
  'this Bash command mentions git clean / git reset / rm and the tower guard could not parse it safely, ' +
  'so it is blocked conservatively — a misread command could delete .tower/comms, the tower protocol state. ' +
  'Split it into simpler commands or run it inside your tower worktree.';

function rmVeto(operand: string): string {
  return (
    `\`rm\` is not allowed on tower protocol paths ("${operand}") — ` +
    '.tower/comms holds the tower protocol state and deleting it orphans the fleet. ' +
    'Remove paths inside your own worktree instead; ' +
    TOWER_GUARD_ESCAPE
  );
}
