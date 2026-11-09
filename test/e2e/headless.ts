import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { logEntries, towerState } from './evidence.ts';
import { leftoverWorktrees } from './mission.ts';
import {
  autopilotEntries,
  checkAutopilotPromptness,
  checkRosterModels,
  createTextkitRepo,
  describeObjective,
  hashTree,
  killProcesses,
  processesUnder,
  recordObjectiveUsage,
  requiredValidationKinds,
  writeText,
  type ObjectiveLimits,
  type ProcessScan,
} from './objective.ts';
import { clip, sleep } from './rpc.ts';
import type { ScenarioContext, ScenarioDefinition } from './scenario.ts';
import type { E2eSettings, RoleModel, ScenarioId } from './settings.ts';
import { git, isolatedPi } from './workspace.ts';

export const HEADLESS_LIMITS: ObjectiveLimits = { maxCostUsd: 4, maxWallTimeMs: 25 * 60_000, skipUserTesting: true };
const RUN_TIMEOUT_MS = 30 * 60_000;

export const HEADLESS_OBJECTIVE = [
  '# textkit: reverse command',
  '',
  '## Goal',
  'Add a `reverse` command to the textkit CLI in this repository (read README.md first): it prints its arguments joined by single spaces, with the characters in reverse order. `node src/cli.js reverse abc def` prints `fed cba`.',
  '',
  '## Plan',
  'One milestone with one build feature that adds `src/commands/reverse.js` and `test/reverse.test.js` (node:test). No other changes, no dependencies.',
  '',
  '## Definition of done',
  '- `node src/cli.js reverse abc def` prints `fed cba`',
  '- `npm test` passes',
  '',
  '## Validation',
  'Scrutiny on, user testing off. `acceptance_commands` are exactly `npm test` and `node src/cli.js reverse abc def | grep -qx "fed cba"` — the repository has no dependencies, so they need no install step.',
  '',
].join('\n');

export type HeadlessRole = 'orchestrator' | 'worker' | 'reviewer' | 'validator';

export const HEADLESS_ROLES: readonly HeadlessRole[] = ['orchestrator', 'worker', 'reviewer', 'validator'];

export const HAND_OVER_COMMAND = '> /tower objective --headless @';

export interface HeadlessRoleModel {
  readonly index: number;
  readonly role: HeadlessRole;
  readonly model: string;
  readonly thinking: string | undefined;
  readonly source: string | undefined;
  readonly line: string;
}

const ROLE_MODEL_LINE = /^\[pi-tower \+[^\]]*\] (orchestrator|worker|reviewer|validator) model: (.+)$/;

export function headlessRoleModels(lines: readonly string[]): HeadlessRoleModel[] {
  return lines.flatMap((line, index): HeadlessRoleModel[] => {
    const match = ROLE_MODEL_LINE.exec(line);
    if (match === null) return [];
    const [model = '', ...details] = (match[2] ?? '').split(' · ');
    const fields = new Map(
      details.map((detail): [string, string] => {
        const colon = detail.indexOf(': ');
        return colon < 0 ? [detail, ''] : [detail.slice(0, colon), detail.slice(colon + 2)];
      }),
    );
    return [{ index, role: match[1] as HeadlessRole, model, thinking: fields.get('thinking'), source: fields.get('source'), line }];
  });
}

export function expectedThinking(role: RoleModel): string {
  return role.thinking === undefined ? 'pi default' : `${role.thinking} (configured)`;
}

export interface RoleModelLineCheck {
  readonly ok: boolean;
  readonly evidence: readonly string[];
}

export function checkRoleModelLines(lines: readonly string[], expected: (role: HeadlessRole) => { readonly model: RoleModel; readonly source: string }): RoleModelLineCheck {
  const handOver = lines.findIndex((line) => line.includes(HAND_OVER_COMMAND));
  const printed = headlessRoleModels(lines);
  const rows = HEADLESS_ROLES.map((role) => {
    const { model, source } = expected(role);
    const row = printed.find((candidate) => candidate.role === role);
    const want = `${role} model: ${model.model} · thinking: ${expectedThinking(model)} · source: ${source}`;
    if (row === undefined) return { ok: false, line: `(no ${role} model line; expected "${want}")` };
    const ok = row.model === model.model && row.thinking === expectedThinking(model) && row.source === source && handOver >= 0 && row.index < handOver;
    return { ok, line: ok ? row.line : `${row.line} — expected "${want}" before the hand-over` };
  });
  return {
    ok: handOver >= 0 && rows.every((row) => row.ok),
    evidence: [...rows.map((row) => clip(row.line, 320)), handOver < 0 ? '(no hand-over line)' : `hand-over: ${clip(lines[handOver] ?? '', 200)}`],
  };
}

export interface HeadlessVariant {
  readonly id: ScenarioId;
  readonly title: string;
  readonly command: string;
  readonly sources: string;
  readonly cliArgs: (objectiveFile: string, settings: E2eSettings) => readonly string[];
  readonly towerConfig: (settings: E2eSettings) => Record<string, unknown>;
  readonly modelSource: (role: HeadlessRole, configPath: string) => string;
}

interface HeadlessExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

function nonEmptyLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim().length > 0);
}

async function runVariant(ctx: ScenarioContext, variant: HeadlessVariant): Promise<void> {
  const { settings, report, dir } = ctx;
  const repo = createTextkitRepo(dir);
  const objectiveFile = writeText(join(dir, 'objective.md'), HEADLESS_OBJECTIVE);
  const pi = isolatedPi(settings, dir, variant.towerConfig(settings), settings.session.spec);
  const configPath = join(dir, 'tower.json');
  const agentDirBefore = hashTree(settings.agentDir);
  const bin = join(settings.checkout, 'bin', 'pi-tower.js');
  const args = [bin, ...variant.cliArgs(objectiveFile, settings), '--timeout', String(RUN_TIMEOUT_MS), '--cwd', repo, '--pi', settings.piBin, '--', ...pi.args];
  const logFile = join(dir, 'headless.log');
  appendFileSync(logFile, `$ node ${args.join(' ')}\n`);
  report.note(`pi-tower ${args.slice(1).join(' ')}`);
  const started = Date.now();
  const child = ctx.root.trackChild(spawn(process.execPath, args, { cwd: dir, env: pi.env, stdio: ['ignore', 'pipe', 'pipe'] }));
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    appendFileSync(logFile, chunk);
    if (settings.verbose) process.stdout.write(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
    appendFileSync(logFile, chunk);
    if (settings.verbose) process.stderr.write(chunk);
  });
  const result = await new Promise<HeadlessExit>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.on('error', (error) => resolve({ code: null, signal: null, stdout, stderr: `${stderr}\n${error.message}` }));
  });
  report.note(`${variant.command} exited with ${String(result.code ?? result.signal)} after ${String(Math.round((Date.now() - started) / 1000))}s`);
  let scan: ProcessScan | undefined;
  try {
    const state = towerState(repo);
    const objective = state?.objective;
    const out = nonEmptyLines(result.stdout);
    const lines = [...out, ...nonEmptyLines(result.stderr)];
    report.check(
      `${variant.command} exits 0 once the objective completed`,
      result.code === 0 && lines.some((line) => /objective O\d+ ".*" completed$/.test(line)),
      [`exit ${String(result.code ?? result.signal)}`, ...lines.filter((line) => line.startsWith('[pi-tower')).slice(-14).map((line) => clip(line, 300))],
    );
    const roleLines = checkRoleModelLines(out, (role) => ({ model: settings[role], source: variant.modelSource(role, configPath) }));
    const warnings = lines.filter((line) => line.includes('model warning:'));
    report.check(
      `the runner prints the model of every role (${variant.sources}) before it hands the objective over, without a model warning`,
      roleLines.ok && warnings.length === 0,
      [...roleLines.evidence, ...warnings.map((line) => clip(line, 300))],
    );
    const sent = ['> /tower on', HAND_OVER_COMMAND, '> /tower approve --auto'].map((command) => lines.findIndex((line) => line.includes(command)));
    report.check(
      'the runner hands the objective over headless and approves it automatically after printing the plan',
      sent.every((index, position) => index >= 0 && (position === 0 || index > (sent[position - 1] ?? -1))) && lines.some((line) => line.startsWith('Plan for O')),
      sent.map((index) => (index < 0 ? '(command not sent)' : clip(lines[index] ?? '', 200))),
    );
    const entries = logEntries(repo);
    const approve = entries.find((entry) => entry.action === 'objective.approve');
    const drafted = entries.find((entry) => entry.action === 'objective.draft' && entry.fields.id === objective?.id);
    const released = entries.find((entry) => entry.action === 'objective.mode' && entry.fields.objective === objective?.id && entry.fields.mode === 'none');
    const final = objective?.milestones.at(-1);
    const mainTip = git(repo, ['rev-parse', 'main']);
    report.check(
      'the objective completed, approved automatically, in headless mode from draft to completion, its final milestone passed on the base tip',
      objective?.status === 'completed' &&
        objective.approvedBy === 'auto' &&
        approve?.fields.by === 'auto' &&
        drafted?.fields.mode === 'headless' &&
        released?.fields.from === 'headless' &&
        objective.milestones.every((milestone) => milestone.status === 'passed') &&
        final?.validationCommit === mainTip &&
        (final?.rounds.some((round) => round.verdict === 'pass') ?? false),
      [...describeObjective(state), drafted?.line ?? '(no objective.draft line)', released?.line ?? '(no objective.mode release line)'],
    );
    const merged = (state?.missions ?? []).filter((mission) => mission.milestone !== undefined);
    report.check(
      'the autopilot drove the feature through an independent review and merge',
      merged.length > 0 && merged.every((mission) => mission.status === 'merged') && autopilotEntries(repo, 'spawn-reviewer').length > 0 && autopilotEntries(repo, 'merge').some((entry) => entry.fields.result === 'done'),
      autopilotEntries(repo).map((entry) => entry.line),
    );
    const scrutiny = objective !== undefined && objective.milestones.some((milestone) => requiredValidationKinds(objective, milestone, HEADLESS_LIMITS).includes('scrutiny'));
    checkRosterModels(ctx, state, { worker: settings.worker, reviewer: settings.reviewer, validator: settings.validator }, scrutiny);
    const reversed = (() => {
      try {
        return git(repo, ['show', 'main:src/commands/reverse.js']).length > 0;
      } catch {
        return false;
      }
    })();
    report.check('main carries the reverse command', reversed, git(repo, ['log', '--oneline', '-6', 'main']));
    checkAutopilotPromptness(ctx, repo);
    const agentDirAfter = hashTree(settings.agentDir);
    report.check(`${settings.agentDir} is unchanged (sha256 over every file before/after)`, agentDirBefore === agentDirAfter, `before ${agentDirBefore.slice(0, 16)}… after ${agentDirAfter.slice(0, 16)}…`);
    await sleep(3000);
    const left = leftoverWorktrees(repo);
    report.note(`worktrees left after the run: registered ${left.registered.join(', ') || '(none)'}; .tower/worktrees ${left.directories.join(', ') || '(empty)'}`);
    scan = processesUnder(dir);
    if (scan.applicable) {
      report.check(
        'no pi or agent process is left behind',
        scan.processes.length === 0,
        scan.processes.length === 0
          ? `no process has its cwd or command line under ${dir} (checked ${scan.method})`
          : [...scan.processes.map((info) => `pid ${String(info.pid)} cwd ${info.cwd}: ${clip(info.command, 200)}`), `(checked ${scan.method})`],
      );
    } else {
      report.note(`the leftover-process check is not applicable on this host: ${scan.method}`);
    }
  } finally {
    killProcesses((scan ?? processesUnder(dir)).processes);
    recordObjectiveUsage(ctx, repo, pi.sessions);
  }
}

export function headlessScenario(variant: HeadlessVariant): ScenarioDefinition {
  return {
    id: variant.id,
    title: variant.title,
    mandatory: true,
    timeoutMs: RUN_TIMEOUT_MS + 10 * 60_000,
    run: (ctx) => runVariant(ctx, variant),
  };
}
