import { spawn, type ChildProcess } from 'node:child_process';

import {
  contractRevisionOf,
  findMilestone,
  validationCommands,
  type TowerValidationSettings,
} from '../../protocol/objective.ts';
import { TOWER_NAME } from '../../protocol/paths.ts';
import type { TowerStore } from '../../protocol/store.ts';
import type { TowerValidationRound } from '../../protocol/types.ts';

export const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60_000;
export const COMMAND_OUTPUT_TAIL_CHARS = 4000;
export const COMMAND_FAILURE_EXCERPT_CHARS = 1000;
export const COMMAND_KILL_GRACE_MS = 5_000;

export interface ValidationCommandResult {
  readonly command: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly durationMs: number;
  readonly output: string;
  readonly truncated: boolean;
  readonly error?: string;
}

export interface ValidationCommandsRun {
  readonly passed: boolean;
  readonly aborted: boolean;
  readonly results: readonly ValidationCommandResult[];
}

export interface RunValidationCommandsOptions {
  readonly cwd: string;
  readonly commands: readonly string[];
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}

export function validationCommandEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    CI: '1',
    TERM: 'dumb',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
  };
}

export function commandPassed(result: ValidationCommandResult): boolean {
  return result.exitCode === 0 && !result.timedOut && !result.aborted && result.error === undefined;
}

export async function runValidationCommands(
  options: RunValidationCommandsOptions,
): Promise<ValidationCommandsRun> {
  const results: ValidationCommandResult[] = [];
  for (const command of options.commands) {
    if (options.signal?.aborted === true) break;
    results.push(await runValidationCommand(command, options));
  }
  const aborted = options.signal?.aborted === true || results.some((result) => result.aborted);
  return {
    passed: !aborted && results.length === options.commands.length && results.every(commandPassed),
    aborted,
    results,
  };
}

interface OutputTail {
  push(chunk: string): void;
  text(): string;
  truncated(): boolean;
}

function outputTail(limit: number): OutputTail {
  let buffer = '';
  let dropped = false;
  return {
    push(chunk) {
      buffer += chunk;
      if (buffer.length > limit * 2) {
        buffer = buffer.slice(-limit);
        dropped = true;
      }
    },
    text: () => buffer.slice(-limit),
    truncated: () => dropped || buffer.length > limit,
  };
}

function runValidationCommand(
  command: string,
  options: RunValidationCommandsOptions,
): Promise<ValidationCommandResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const graceMs = options.killGraceMs ?? COMMAND_KILL_GRACE_MS;
  const tail = outputTail(COMMAND_OUTPUT_TAIL_CHARS);
  return new Promise((resolve) => {
    let child: ChildProcess;
    let timedOut = false;
    let aborted = false;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let error: string | undefined;
    let settled = false;
    const timers: NodeJS.Timeout[] = [];
    const later = (callback: () => void, ms: number): void => {
      const timer = setTimeout(callback, ms);
      timer.unref();
      timers.push(timer);
    };
    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        return;
      }
    };
    let terminating = false;
    const terminate = (): void => {
      killGroup('SIGTERM');
      if (terminating) return;
      terminating = true;
      later(() => {
        killGroup('SIGKILL');
      }, graceMs);
    };
    const onAbort = (): void => {
      aborted = true;
      terminate();
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        command,
        exitCode,
        signal: exitSignal,
        timedOut,
        aborted,
        durationMs: now() - started,
        output: tail.text(),
        truncated: tail.truncated(),
        ...(error === undefined ? {} : { error }),
      });
    };
    try {
      child = spawn('bash', ['-c', command], {
        cwd: options.cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: options.env ?? validationCommandEnv(),
      });
    } catch (spawnError) {
      error = spawnError instanceof Error ? spawnError.message : String(spawnError);
      settled = true;
      resolve({
        command,
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: false,
        durationMs: now() - started,
        output: '',
        truncated: false,
        error,
      });
      return;
    }
    later(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
    if (options.signal?.aborted === true) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => {
        tail.push(chunk);
      });
    }
    child.on('error', (spawnError) => {
      error = spawnError.message;
      finish();
    });
    child.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      killGroup('SIGKILL');
      later(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }, graceMs);
    });
    child.on('close', finish);
  });
}

export interface CommandsValidationReport {
  readonly verdict: 'pass' | 'fail';
  readonly failures: readonly string[];
  readonly checks: readonly string[];
  readonly evidence: string;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function describeCommandOutcome(result: ValidationCommandResult): string {
  if (result.error !== undefined) return `could not run: ${result.error}`;
  if (result.aborted) return `aborted after ${seconds(result.durationMs)}`;
  if (result.timedOut) return `timed out after ${seconds(result.durationMs)}`;
  if (result.exitCode !== null) return `exit code ${String(result.exitCode)} after ${seconds(result.durationMs)}`;
  return `killed by ${result.signal ?? 'a signal'} after ${seconds(result.durationMs)}`;
}

function excerpt(output: string, limit: number): string {
  const trimmed = output.trimEnd();
  if (trimmed.length === 0) return '(no output)';
  return trimmed.length > limit ? `…${trimmed.slice(-limit)}` : trimmed;
}

export function commandsValidationReport(run: ValidationCommandsRun): CommandsValidationReport {
  const failures = run.results
    .filter((result) => !commandPassed(result))
    .map(
      (result) =>
        `\`${result.command}\` failed: ${describeCommandOutcome(result)} — last output:\n${excerpt(result.output, COMMAND_FAILURE_EXCERPT_CHARS)}`,
    );
  const checks = run.results.map(
    (result) => `\`${result.command}\` — ${commandPassed(result) ? 'passed' : 'failed'} (${describeCommandOutcome(result)})`,
  );
  const evidence = run.results
    .map(
      (result) =>
        `### \`${result.command}\` — ${describeCommandOutcome(result)}\n\n${result.truncated ? `(last ${String(COMMAND_OUTPUT_TAIL_CHARS)} characters)\n` : ''}\`\`\`\n${result.output.trimEnd()}\n\`\`\``,
    )
    .join('\n\n');
  return { verdict: failures.length === 0 && run.passed ? 'pass' : 'fail', failures, checks, evidence };
}

export interface CommandsValidationRequest {
  readonly milestoneId: string;
  readonly settings: TowerValidationSettings;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export type CommandsValidationOutcome = (
  | {
      readonly status: 'submitted';
      readonly contractRevision: number;
      readonly run: ValidationCommandsRun;
      readonly round: TowerValidationRound;
    }
  | { readonly status: 'aborted' }
  | { readonly status: 'skipped'; readonly reason: string }
) & { readonly worktree: string; readonly commit: string; readonly cleanupError?: string };

type CommandsValidationResult =
  | Omit<Extract<CommandsValidationOutcome, { status: 'submitted' }>, 'worktree' | 'commit' | 'cleanupError'>
  | { readonly status: 'aborted' }
  | { readonly status: 'skipped'; readonly reason: string };

export async function runCommandsValidation(
  store: TowerStore,
  request: CommandsValidationRequest,
): Promise<CommandsValidationOutcome> {
  const prepared = await store.prepareValidationWorktree(request.milestoneId, 'commands');
  const { worktree, commit } = prepared;
  let result: CommandsValidationResult | undefined;
  let failure: unknown;
  try {
    result = await validateInWorktree(store, request, prepared);
  } catch (error) {
    failure = error;
  }
  let cleanupError: string | undefined;
  try {
    await store.removeValidationWorktree(worktree);
  } catch (error) {
    cleanupError = `removing validation worktree ${worktree} failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (result === undefined) throw failure;
  return { ...result, worktree, commit, ...(cleanupError === undefined ? {} : { cleanupError }) };
}

async function validateInWorktree(
  store: TowerStore,
  request: CommandsValidationRequest,
  prepared: { readonly path: string; readonly commit: string },
): Promise<CommandsValidationResult> {
  const state = await store.load();
  const objective = state.objective;
  const milestone = findMilestone(objective, request.milestoneId);
  if (objective === undefined || milestone === undefined) {
    return { status: 'skipped', reason: `milestone ${request.milestoneId} no longer exists` };
  }
  const commands = validationCommands(objective, milestone);
  const contractRevision = contractRevisionOf(objective);
  if (commands.length === 0) {
    return { status: 'skipped', reason: `milestone ${milestone.id} has no validation commands` };
  }
  const run = await runValidationCommands({
    cwd: prepared.path,
    commands,
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.env === undefined ? {} : { env: request.env }),
  });
  if (run.aborted) return { status: 'aborted' };
  const report = commandsValidationReport(run);
  const submitted = await store.submitValidation(
    TOWER_NAME,
    {
      milestone: milestone.id,
      kind: 'commands',
      verdict: report.verdict,
      failures: report.failures,
      checks: report.checks,
      evidence: report.evidence,
      validatedCommit: prepared.commit,
      contractRevision,
    },
    request.settings,
  );
  return { status: 'submitted', contractRevision, run, round: submitted.round };
}
