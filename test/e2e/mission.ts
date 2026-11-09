import { join } from 'node:path';

import { objectiveSettingsConfig, realpathOr, type ObjectiveLimits } from './objective.ts';
import type { E2eSettings, RoleModel } from './settings.ts';
import { listFiles, tryGit } from './workspace.ts';

export type MissionRole = 'orchestrator' | 'worker' | 'reviewer' | 'validator';

export const MISSION_KEY = 'mission';
export const MISSION_HEADER_START = 'Mission mode\n';
export const MISSION_CONTROL_START = 'Mission Control\n## Models\n';
export const MISSION_GOAL_QUESTION_START = 'What do you want to build?';
export const MISSION_HANDED_START = 'Mission goal handed to the orchestrator';
export const MISSION_PLANNING_HEADING = '# New mission — plan it with the human';
export const MISSION_OFF_START = 'Mission mode: OFF\n';
export const MISSION_ALREADY_OFF = 'Mission mode is already off.';
export const MISSION_STATUS_WAITING = 'mission: waiting for your goal';
export const MISSION_STATUS_PLANNING_GOAL = 'mission: planning your goal';
export const KEEP_PLANNING_NOTICE = /^Mission O\d+ still awaits your approval/;

export function approvedNoticeStart(objectiveId: string): string {
  return `Mission ${objectiveId} approved — executing\n`;
}

export function completionNoticeStart(objective: { readonly id: string; readonly title: string }): string {
  return `Mission ${objective.id} "${objective.title}" is complete:`;
}

export type MissionStatusPhase = 'waiting-for-goal' | 'planning-goal' | 'planning' | 'awaiting-approval' | 'executing' | 'paused' | 'blocked' | 'completed' | 'cleared' | 'other';

const STATUS_PHASE = /^mission O\d+ (planning|awaiting approval|executing|paused|blocked|completed)(?: · |$)/;

export function missionStatusPhase(text: string | undefined): MissionStatusPhase {
  if (text === undefined) return 'cleared';
  if (text === MISSION_STATUS_WAITING) return 'waiting-for-goal';
  if (text === MISSION_STATUS_PLANNING_GOAL) return 'planning-goal';
  const phase = STATUS_PHASE.exec(text)?.[1];
  return phase === undefined ? 'other' : (phase.replace(' ', '-') as MissionStatusPhase);
}

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

export interface MissionHeader {
  readonly rows: readonly MissionModelRow[];
  readonly base: string | undefined;
  readonly question: string;
}

export function missionHeader(text: string): MissionHeader {
  const lines = text.split('\n');
  const base = lines.map((line) => /^\s+Base branch +(\S.*)$/.exec(line)?.[1]).find((value) => value !== undefined);
  return { rows: missionModelRows(text), base, question: lines.at(-1) ?? '' };
}

export function modelRowMatches(row: MissionModel | undefined, expected: MissionModel): boolean {
  return row !== undefined && row.role === expected.role && row.model === expected.model && row.thinking === expected.thinking && row.source === expected.source && row.note === expected.note;
}

export function describeMissionModel(row: MissionModel): string {
  if (row.model === undefined) return `${row.role}: ${row.note ?? '(nothing)'}`;
  return `${row.role}: ${row.model}${row.thinking === undefined ? '' : ` · ${row.thinking}`} (${row.source ?? '?'})`;
}

export interface TextCheck {
  readonly ok: boolean;
  readonly evidence: readonly string[];
}

export function checkModelRows(text: string, expected: readonly MissionModel[]): TextCheck {
  const rows = missionModelRows(text);
  const lines = expected.map((want) => {
    const row = rows.find((candidate) => candidate.role === want.role);
    const ok = modelRowMatches(row, want);
    return { ok, line: `${row?.line.trim() ?? `(no ${want.role} row)`}${ok ? '' : ` — expected ${describeMissionModel(want)}`}` };
  });
  return { ok: lines.every((line) => line.ok), evidence: lines.map((line) => line.line) };
}

export function checkMissionHeader(text: string, expected: readonly MissionModel[], maxRunningAgents: number): TextCheck {
  const header = missionHeader(text);
  const rows = checkModelRows(text, expected);
  const base = header.base;
  const baseOk = base !== undefined && /^main\b/.test(base) && base.endsWith(`features run in parallel (up to ${String(maxRunningAgents)} agents)`);
  return {
    ok: text.startsWith(MISSION_HEADER_START) && rows.ok && baseOk && header.question.startsWith(MISSION_GOAL_QUESTION_START),
    evidence: [...rows.evidence, `Base branch: ${base ?? '(missing)'}`, header.question],
  };
}

export const MISSION_LIMITS: ObjectiveLimits = { maxCostUsd: 5, maxWallTimeMs: 30 * 60_000, skipUserTesting: true };

export function missionGoal(script: string): string {
  return [
    'Add two commands to the textkit CLI in this repository: `lower`, which prints its arguments in lower case, and `chars`, which prints how many characters its arguments have.',
    `The acceptance commands are exactly \`npm test\` and \`node ${script}\`.`,
    'Before you draft anything, ask me at least one question about the details and wait for my answer.',
  ].join(' ');
}

export const MISSION_INTERVIEW_ANSWERS = [
  'My answers: both commands work on their arguments joined by single spaces.',
  '`node src/cli.js lower Hello WORLD` prints `hello world`, and `chars` counts the characters of the joined text, spaces included, so `node src/cli.js chars ab cd` prints `5`.',
  'The two commands are independent of each other, and each one gets its own node:test test file. It is small, so one milestone is enough.',
  'Out of scope: any other command and any change to src/cli.js, README.md and package.json; no dependencies.',
  'A user runs the commands from a shell exactly like my examples, and the acceptance commands stay exactly the two I gave.',
  'No more questions from me — decide anything else yourself, then draft the mission, plan its features and request my approval.',
].join(' ');

export interface MissionSetup {
  readonly towerConfig: Record<string, unknown>;
  readonly extraArgs: readonly string[];
  readonly header: readonly MissionModel[];
  readonly panelModels: string;
}

function modelId(role: RoleModel): string {
  return role.model.slice(role.model.indexOf('/') + 1);
}

function panelModel(role: RoleModel, roles: readonly RoleModel[]): string {
  const shared = roles.some((other) => modelId(other) === modelId(role) && other.model !== role.model);
  return shared ? role.model : modelId(role);
}

function configured(role: MissionRole, model: RoleModel, source: string): MissionModel {
  return { role, model: model.model, ...(model.thinking === undefined ? {} : { thinking: model.thinking }), source };
}

export function missionSetup(settings: Pick<E2eSettings, 'orchestrator' | 'worker' | 'reviewer' | 'validator'>): MissionSetup {
  const { orchestrator: A, worker: B, reviewer: C, validator: V } = settings;
  const inherited = V.spec === C.spec;
  const roles = [A, B, C, V];
  return {
    towerConfig: { orchestrator: A.spec, reviewer: C.spec, ...(inherited ? {} : { validator: V.spec }), ...objectiveSettingsConfig(MISSION_LIMITS) },
    extraArgs: ['--tower-worker-model', B.spec],
    header: [
      configured('orchestrator', A, 'global tower.json'),
      configured('worker', B, '--tower-worker-model'),
      configured('reviewer', C, 'global tower.json'),
      inherited ? { role: 'validator', note: 'same as reviewer' } : configured('validator', V, 'global tower.json'),
    ],
    panelModels: `models: orchestrator ${panelModel(A, roles)} · worker ${panelModel(B, roles)} · reviewer ${panelModel(C, roles)} · validator ${inherited ? '= reviewer' : panelModel(V, roles)}`,
  };
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
  const start = lines.findIndex((line) => line.startsWith('models: '));
  if (start === -1) return undefined;
  const rows = [lines[start] ?? ''];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith(' ')) break;
    rows.push(line.trim());
  }
  return rows.join(' · ');
}

export function panelLineMatches(line: string | undefined, expected: string): boolean {
  if (line === undefined) return false;
  return line === expected || (line.endsWith('…') && line.length > 1 && expected.startsWith(line.slice(0, -1)));
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
