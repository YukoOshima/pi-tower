import { join } from 'node:path';

import { realpathOr } from './objective.ts';
import { listFiles, tryGit } from './workspace.ts';

export type MissionRole = 'orchestrator' | 'worker' | 'reviewer' | 'validator';

export const MISSION_ROLES: readonly MissionRole[] = ['orchestrator', 'worker', 'reviewer', 'validator'];

const ROLE_BY_LABEL: Readonly<Record<string, MissionRole>> = { Orchestrator: 'orchestrator', Worker: 'worker', Reviewer: 'reviewer', Validator: 'validator' };
const MODEL_ROW = /^\s*(Orchestrator|Worker|Reviewer|Validator) {2,}(\S.*)$/;
const MODEL_VALUE = /^(\S+)(?: · (\S+))?\s+\((.+)\)$/;

export interface MissionModel {
  readonly role: MissionRole;
  readonly model?: string;
  readonly thinking?: string;
  readonly source?: string;
  readonly note?: string;
}

export interface MissionModelRow extends MissionModel {
  readonly line: string;
}

export function missionModelRows(text: string): MissionModelRow[] {
  const rows: MissionModelRow[] = [];
  for (const line of text.split('\n')) {
    const match = MODEL_ROW.exec(line);
    const role = match === null ? undefined : ROLE_BY_LABEL[match[1] ?? ''];
    if (match === null || role === undefined || rows.some((row) => row.role === role)) continue;
    const value = (match[2] ?? '').trim();
    const parsed = MODEL_VALUE.exec(value);
    if (parsed === null) {
      rows.push({ role, note: value, line });
      continue;
    }
    rows.push({ role, model: parsed[1] ?? '', ...(parsed[2] === undefined ? {} : { thinking: parsed[2] }), source: parsed[3] ?? '', line });
  }
  return rows;
}

export function modelRowMatches(row: MissionModel | undefined, expected: MissionModel): boolean {
  return row !== undefined && row.role === expected.role && row.model === expected.model && row.thinking === expected.thinking && row.source === expected.source && row.note === expected.note;
}

export function describeMissionModel(row: MissionModel): string {
  if (row.model === undefined) return `${row.role}: ${row.note ?? '(nothing)'}`;
  return `${row.role}: ${row.model}${row.thinking === undefined ? '' : ` · ${row.thinking}`} (${row.source ?? '?'})`;
}

export interface ApprovalDialogTitle {
  readonly objective: string;
  readonly title: string;
  readonly revised: boolean;
  readonly milestones: number;
  readonly features: number;
}

const APPROVAL_TITLE = /^Mission (O\d+) "(.*)" — plan (ready|revised) \((\d+) milestones? · (\d+) features?\)\. Approve (?:it|the revised plan)\?$/;

export function approvalDialogTitle(text: string): ApprovalDialogTitle | undefined {
  const match = APPROVAL_TITLE.exec(text);
  if (match === null) return undefined;
  return { objective: match[1] ?? '', title: match[2] ?? '', revised: match[3] === 'revised', milestones: Number(match[4]), features: Number(match[5]) };
}

const PANEL_HEADLINE = /^\S+ Mission O\d+ /;
const PANEL_STATUS = / · (planning|awaiting approval|executing|paused|blocked|completed)(?: · |$)/;
const RUNNING_FEATURE = /^\S+ (M\d+) .+ — worker (\S+) running(?: · .*)?$/;

export function panelStatus(lines: readonly string[]): string | undefined {
  const headline = lines[0] ?? '';
  return PANEL_HEADLINE.test(headline) ? PANEL_STATUS.exec(headline)?.[1] : undefined;
}

export function panelRunningFeatures(lines: readonly string[]): { readonly feature: string; readonly worker: string }[] {
  return lines.flatMap((line) => {
    const match = RUNNING_FEATURE.exec(line);
    return match === null ? [] : [{ feature: match[1] ?? '', worker: match[2] ?? '' }];
  });
}

export function panelModelsLine(lines: readonly string[]): string | undefined {
  return lines.find((line) => line.startsWith('models: '));
}

export interface TeardownSection {
  readonly summary: string;
  readonly counts: { readonly removed: number; readonly kept: number; readonly failed: number } | undefined;
  readonly items: readonly string[];
}

const TEARDOWN_COUNTS = /^Automatic teardown: removed (\d+) worktree\(s\), kept (\d+)(?:, failed to remove (\d+))?\.$/;

export function teardownSection(text: string): TeardownSection | undefined {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith('Automatic teardown'));
  if (start < 0) return undefined;
  const summary = lines[start] ?? '';
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('- ')) break;
    items.push(line.slice(2));
  }
  const match = TEARDOWN_COUNTS.exec(summary);
  return { summary, counts: match === null ? undefined : { removed: Number(match[1]), kept: Number(match[2]), failed: Number(match[3] ?? 0) }, items };
}

export interface LeftoverWorktrees {
  readonly registered: readonly string[];
  readonly directories: readonly string[];
}

export function leftoverWorktrees(repo: string): LeftoverWorktrees {
  const main = realpathOr(repo);
  const listing = tryGit(repo, ['worktree', 'list', '--porcelain']) ?? '';
  const registered = listing
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .filter((path) => realpathOr(path) !== main);
  return { registered, directories: listFiles(join(repo, '.tower', 'worktrees')) };
}

export interface MissionAcceptRun {
  readonly execution: number;
  readonly cwd: string;
  readonly commit: string;
  readonly lower: string | null;
  readonly chars: string | null;
  readonly pass: boolean;
  readonly at: string;
}

export function missionAcceptScript(runsFile: string): string {
  return [
    "import { execFileSync } from 'node:child_process';",
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "import { basename } from 'node:path';",
    '',
    `const RUNS = ${JSON.stringify(runsFile)};`,
    'const cwd = process.cwd();',
    'if (!/^val-.*commands/.test(basename(cwd))) {',
    "  console.log('acceptance check: nothing to verify here — it checks the checkout of the tower commands validation');",
    '  process.exit(0);',
    '}',
    'const cli = (args) => {',
    '  try {',
    "    return execFileSync(process.execPath, ['src/cli.js', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();",
    '  } catch {',
    '    return null;',
    '  }',
    '};',
    "const lower = cli(['lower', 'Hello', 'WORLD']);",
    "const chars = cli(['chars', 'ab', 'cd']);",
    "let commit = 'unknown';",
    'try {',
    "  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();",
    '} catch {}',
    "const pass = lower === 'hello world' && chars === '5';",
    "const runs = existsSync(RUNS) ? JSON.parse(readFileSync(RUNS, 'utf8')) : [];",
    'runs.push({ execution: runs.length + 1, cwd, commit, lower, chars, pass, at: new Date().toISOString() });',
    "writeFileSync(RUNS, `${JSON.stringify(runs, null, 2)}\\n`);",
    'if (pass) {',
    "  console.log('acceptance check passed: lower and chars print the expected output');",
    '  process.exit(0);',
    '}',
    'console.error(`ACCEPTANCE FAILED: node src/cli.js lower Hello WORLD printed ${JSON.stringify(lower)} (expected "hello world"); node src/cli.js chars ab cd printed ${JSON.stringify(chars)} (expected "5")`);',
    'process.exit(1);',
    '',
  ].join('\n');
}
