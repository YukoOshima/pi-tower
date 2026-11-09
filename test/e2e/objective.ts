import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { frontmatter, logEntries, readJsonl, summarizeTranscript, towerState, validationFiles, type LogEntry, type ObjectiveRecord, type RosterEntry, type TowerState } from './evidence.ts';
import { clip, sleep, type PiRpc } from './rpc.ts';
import { recordAgentUsage, roleConfig, type ScenarioContext } from './scenario.ts';
import type { E2eSettings } from './settings.ts';
import { createRepo, git } from './workspace.ts';

export const TEXTKIT_FILES: Readonly<Record<string, string>> = {
  'package.json': `${JSON.stringify(
    {
      name: 'textkit',
      version: '1.0.0',
      private: true,
      type: 'module',
      description: 'A tiny text toolkit CLI',
      bin: { textkit: 'src/cli.js' },
      scripts: { test: 'node --test' },
    },
    null,
    2,
  )}\n`,
  'README.md': [
    '# textkit',
    '',
    'A tiny text toolkit CLI without dependencies: `node src/cli.js <command> [args...]` prints the result of one command.',
    '',
    'Each command is a module `src/commands/<name>.js` whose default export takes the argument list (an array of strings) and returns the text to print. The CLI finds commands by file name, so adding a command never touches `src/cli.js`.',
    '',
    'Tests use `node:test` and live in `test/<name>.test.js`; run them with `npm test`.',
    '',
  ].join('\n'),
  'src/cli.js': [
    '#!/usr/bin/env node',
    "import { existsSync } from 'node:fs';",
    "import { fileURLToPath } from 'node:url';",
    '',
    'const [name, ...args] = process.argv.slice(2);',
    'if (name === undefined || !/^[a-z][a-z0-9-]*$/.test(name)) {',
    "  console.error('usage: textkit <command> [args...]');",
    '  process.exit(2);',
    '}',
    'const module = new URL(`./commands/${name}.js`, import.meta.url);',
    'if (!existsSync(fileURLToPath(module))) {',
    '  console.error(`textkit: unknown command "${name}"`);',
    '  process.exit(2);',
    '}',
    'const { default: run } = await import(module.href);',
    'console.log(run(args));',
    '',
  ].join('\n'),
  'src/commands/upper.js': ['export default function upper(args) {', "  return args.join(' ').toUpperCase();", '}', ''].join('\n'),
  'test/upper.test.js': [
    "import assert from 'node:assert/strict';",
    "import { execFileSync } from 'node:child_process';",
    "import { test } from 'node:test';",
    '',
    "import upper from '../src/commands/upper.js';",
    '',
    "test('upper upper-cases its arguments', () => {",
    "  assert.equal(upper(['hello', 'world']), 'HELLO WORLD');",
    '});',
    '',
    "test('the CLI runs the upper command', () => {",
    "  const out = execFileSync(process.execPath, ['src/cli.js', 'upper', 'a', 'b'], { encoding: 'utf8' });",
    "  assert.equal(out.trim(), 'A B');",
    '});',
    '',
  ].join('\n'),
  '.gitignore': 'node_modules/\n',
};

export function createTextkitRepo(dir: string): string {
  return createRepo(dir, TEXTKIT_FILES);
}

export interface ObjectiveLimits {
  readonly maxCostUsd: number;
  readonly maxWallTimeMs: number;
  readonly skipScrutiny?: boolean;
  readonly skipUserTesting?: boolean;
}

export function objectiveConfig(settings: E2eSettings, limits: ObjectiveLimits): Record<string, unknown> {
  return roleConfig(settings, {
    validator: settings.validator.spec,
    maxRunningAgents: 4,
    objective: { maxValidationRounds: 3, maxFeatureAttempts: 3, ...limits },
  });
}

export function writeText(path: string, text: string): string {
  writeFileSync(path, text);
  return path;
}

export const OBJECTIVE_END = new Set(['completed', 'blocked', 'paused']);

export function objectiveOf(repo: string): ObjectiveRecord | undefined {
  return towerState(repo)?.objective;
}

function progressKey(state: TowerState | undefined): string {
  const objective = state?.objective;
  return JSON.stringify([
    objective?.status,
    objective?.milestones.map((milestone) => [milestone.id, milestone.status, milestone.rounds.length]),
    state?.missions.map((mission) => [mission.id, mission.status, mission.owner]),
    state?.roster.agents.length,
  ]);
}

export class ObjectiveTrace {
  readonly objective: string[] = [];
  readonly milestones = new Map<string, string[]>();
  readonly missions = new Map<string, string[]>();
  private readonly repo: string;
  private readonly timer: NodeJS.Timeout;

  constructor(repo: string) {
    this.repo = repo;
    this.sample();
    this.timer = setInterval(() => this.sample(), 1500);
    this.timer.unref();
  }

  sample(): void {
    let state: TowerState | undefined;
    try {
      state = towerState(this.repo);
    } catch {
      return;
    }
    const push = (list: string[], value: string | undefined): void => {
      if (value !== undefined && list.at(-1) !== value) list.push(value);
    };
    push(this.objective, state?.objective?.status);
    for (const milestone of state?.objective?.milestones ?? []) {
      const list = this.milestones.get(milestone.id) ?? [];
      push(list, milestone.status);
      this.milestones.set(milestone.id, list);
    }
    for (const mission of state?.missions ?? []) {
      const list = this.missions.get(mission.id) ?? [];
      push(list, mission.status);
      this.missions.set(mission.id, list);
    }
  }

  stop(): void {
    this.sample();
    clearInterval(this.timer);
  }

  lines(): string[] {
    return [
      `objective: ${this.objective.join(' → ') || '(never drafted)'}`,
      ...[...this.milestones].map(([id, list]) => `${id}: ${list.join(' → ')}`),
      ...[...this.missions].map(([id, list]) => `${id}: ${list.join(' → ')}`),
    ];
  }
}

export interface HumanScript {
  readonly reply: string;
  readonly maxReplies: number;
  replies: number;
}

export function humanScript(reply: string, maxReplies = 3): HumanScript {
  return { reply, maxReplies, replies: 0 };
}

function lastAssistantText(rpc: PiRpc, fromIndex: number): string {
  return rpc.assistantTurns(fromIndex).at(-1)?.text.trim() ?? '';
}

async function answerIfAsked(ctx: ScenarioContext, rpc: PiRpc, human: HumanScript, from: { index: number }): Promise<void> {
  if (rpc.running || human.replies >= human.maxReplies || Date.now() - rpc.lastEventAt < 20_000) return;
  const text = lastAssistantText(rpc, from.index);
  if (!/\?\s*(\*\*)?\s*$|\?\s*\n/.test(text.slice(-600))) return;
  human.replies += 1;
  from.index = rpc.events.length;
  ctx.report.note(`scripted human reply ${String(human.replies)} to the orchestrator's question "${clip(text.slice(-240), 240)}"`);
  await rpc.send({ type: 'prompt', message: human.reply, streamingBehavior: 'followUp' });
}

export interface WaitObjectiveOptions {
  readonly label: string;
  readonly timeoutMs: number;
  readonly rpc?: PiRpc;
  readonly human?: HumanScript;
  readonly failOnEnd?: boolean;
}

export async function waitForObjective(ctx: ScenarioContext, repo: string, done: (state: TowerState) => boolean, options: WaitObjectiveOptions): Promise<TowerState> {
  const deadline = Date.now() + options.timeoutMs;
  const from = { index: options.rpc?.events.length ?? 0 };
  let key = '';
  let changedAt = Date.now();
  for (;;) {
    const state = towerState(repo);
    if (state !== undefined && done(state)) return state;
    const objective = state?.objective;
    if (options.failOnEnd !== false && objective !== undefined && OBJECTIVE_END.has(objective.status)) {
      throw new Error(`objective ${objective.id} ended ${objective.status} while waiting for ${options.label}: ${objective.blockedReason ?? objective.pausedReason ?? 'completed'}`);
    }
    if (options.rpc?.exitCode !== undefined) throw new Error(`pi exited (${String(options.rpc.exitCode)}) while waiting for ${options.label}`);
    if (Date.now() > deadline) throw new Error(`timeout after ${String(options.timeoutMs)}ms waiting for ${options.label}`);
    const next = progressKey(state);
    if (next !== key) {
      key = next;
      changedAt = Date.now();
    }
    if (options.rpc !== undefined && options.human !== undefined && Date.now() - changedAt > 20_000) await answerIfAsked(ctx, options.rpc, options.human, from);
    await sleep(3000);
  }
}

export async function planToApproval(ctx: ScenarioContext, rpc: PiRpc, repo: string, human: HumanScript, timeoutMs = 12 * 60_000): Promise<TowerState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await rpc.waitIdle(Math.max(1000, deadline - Date.now()), 4000);
    const state = towerState(repo);
    if (state?.objective?.status === 'awaiting-approval') return state;
    if (Date.now() > deadline) throw new Error(`the orchestrator did not request approval within ${String(timeoutMs)}ms (objective ${String(state?.objective?.status)})`);
    if (human.replies >= human.maxReplies) throw new Error(`the orchestrator did not request approval after ${String(human.replies)} scripted human replies (objective ${String(state?.objective?.status)})`);
    human.replies += 1;
    ctx.report.note(`scripted human reply ${String(human.replies)} during planning (objective ${String(state?.objective?.status ?? 'not drafted')}): orchestrator said "${clip(lastAssistantText(rpc, 0).slice(-300), 300)}"`);
    await rpc.send({ type: 'prompt', message: human.reply, streamingBehavior: 'followUp' });
    await rpc.waitFor((event) => event.type === 'agent_start', 60_000, 'the orchestrator to take the scripted reply').catch(() => undefined);
  }
}

export function autopilotEntries(repo: string, action?: string): LogEntry[] {
  return logEntries(repo).filter((entry) => entry.actor === 'autopilot' && (action === undefined || entry.action === action));
}

export function validationFileFields(repo: string): { readonly name: string; readonly fields: Record<string, string>; readonly text: string }[] {
  return validationFiles(repo).map((file) => ({ name: file.name, fields: frontmatter(file.text), text: file.text }));
}

export function describeObjective(state: TowerState | undefined): string[] {
  const objective = state?.objective;
  if (objective === undefined) return ['no objective in state.json'];
  const lines = [
    `${objective.id} "${objective.title}" status=${objective.status} approvedBy=${String(objective.approvedBy)} startedAt=${String(objective.startedAt)} completedAt=${String(objective.completedAt)} usage=$${(objective.usage?.costUsd ?? 0).toFixed(4)} mode=${String(state?.objectiveMode)}`,
    `acceptance commands: ${objective.acceptanceCommands.join(' ; ') || '(none)'}`,
  ];
  for (const milestone of objective.milestones) {
    lines.push(`${milestone.id} "${milestone.title}" status=${milestone.status} validationCommit=${milestone.validationCommit?.slice(0, 7) ?? '-'}`);
    for (const round of milestone.rounds) {
      lines.push(`  ${round.kind} r${String(round.round)} ${round.verdict} by ${round.validator} on ${round.validatedCommit.slice(0, 7)} (${round.file})${round.failures.length > 0 ? ` — ${clip(round.failures.join(' | '), 220)}` : ''}`);
    }
  }
  for (const mission of state?.missions ?? []) {
    lines.push(`${mission.id} "${mission.title ?? ''}" milestone=${String(mission.milestone)} origin=${String(mission.origin)} attempts=${String(mission.attempts)} status=${mission.status} owner=${String(mission.owner)} branch=${mission.branch}`);
  }
  for (const agent of state?.roster.agents ?? []) {
    const extra = agent.kind === 'validator' ? ` milestone=${String(agent.milestoneId)} kind=${String(agent.validationKind)} round=${String(agent.validationRound)} commit=${String(agent.validatedCommit?.slice(0, 7))}` : ` mission=${String(agent.missionId ?? agent.reviewTarget)}`;
    lines.push(`roster ${agent.name} (${agent.kind})${extra} model=${String(agent.model)}${agent.diedAt === undefined ? '' : ` died=${agent.diedAt}`}`);
  }
  return lines;
}

export function sessionTranscripts(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    if (!existsSync(current)) return;
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.jsonl')) found.push(path);
    }
  };
  walk(dir);
  return found.sort();
}

export function recordObjectiveUsage(ctx: ScenarioContext, repo: string, sessionsDir: string, retired: readonly RosterEntry[] = []): void {
  for (const path of sessionTranscripts(sessionsDir)) ctx.report.addUsage('orchestrator session', summarizeTranscript(path).usage);
  recordAgentUsage(ctx, repo, retired);
  const objective = objectiveOf(repo);
  const total = ctx.report.totalUsage();
  ctx.report.note(
    `cost: transcripts total $${total.cost.toFixed(4)} (${String(total.total)} tokens); the objective's own accounting usage.costUsd=$${(objective?.usage?.costUsd ?? 0).toFixed(4)} of maxCostUsd=${String(objective?.limits.maxCostUsd ?? 'unset')}`,
  );
}

export function hashTree(dir: string): string {
  const hash = createHash('sha256');
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const stat = statSync(path);
      hash.update(`${relative(dir, path)}\0${stat.isDirectory() ? 'dir' : 'file'}\0`);
      if (stat.isDirectory()) walk(path);
      else hash.update(readFileSync(path));
    }
  };
  if (existsSync(dir)) walk(dir);
  return hash.digest('hex');
}

export interface ProcessInfo {
  readonly pid: number;
  readonly cwd: string;
  readonly command: string;
}

export function processesUnder(dir: string): ProcessInfo[] {
  const found: ProcessInfo[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const cwd = readlinkSync(`/proc/${name}/cwd`);
      const command = readFileSync(`/proc/${name}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
      if (cwd.startsWith(dir) || command.includes(dir)) found.push({ pid: Number(name), cwd, command });
    } catch {
      continue;
    }
  }
  return found;
}

export function killProcesses(processes: readonly ProcessInfo[]): void {
  for (const info of processes) {
    try {
      process.kill(info.pid, 'SIGKILL');
    } catch {
      continue;
    }
  }
}

export function transcriptOf(repo: string, agentId: string): string | undefined {
  const dir = join(repo, '.tower', 'agents');
  if (!existsSync(dir)) return undefined;
  const name = readdirSync(dir).find((file) => file.endsWith(`_${agentId}.jsonl`));
  return name === undefined ? undefined : join(dir, name);
}

export function toolCallCount(path: string | undefined): number {
  if (path === undefined) return 0;
  return readJsonl(path).filter((line) => line.type === 'message' && line.message?.role === 'assistant').flatMap((line) => (Array.isArray(line.message?.content) ? line.message.content : [])).filter((block: { type?: string }) => block?.type === 'toolCall').length;
}

export function isAncestor(repo: string, ancestor: string, descendant: string): boolean {
  try {
    git(repo, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}
