import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveTowerModels, type TowerConfig, type TowerConfigValue, type TowerModelSpec } from '../../src/config/index.ts';
import { MISSION_STATUS_KEY, MISSION_WIDGET_KEY } from '../../src/mission/constants.ts';
import { renderMissionPanel, renderMissionStatus, type MissionPanelInput } from '../../src/mission/panel.ts';
import {
  MISSION_ALREADY_OFF as PRODUCT_ALREADY_OFF,
  MISSION_CONTROL_TITLE,
  MISSION_GOAL_QUESTION,
  MISSION_HANDED_TITLE,
  MISSION_KEEP_PLANNING_OPTION,
  MISSION_MODE_TITLE,
  MISSION_OFF_TITLE,
  MISSION_STATUS_PLANNING_GOAL,
  MISSION_STATUS_WAITING_FOR_GOAL,
  missionApprovalDialog,
  missionApprovedTitle,
  missionKeepPlanning,
} from '../../src/mission/texts.ts';
import { renderMissionControl, renderMissionHeader } from '../../src/mission/views.ts';
import { buildObjectivePlanningPrompt } from '../../src/prompts/objectivePlanning.ts';
import type { TowerMilestone, TowerMission, TowerObjective, TowerRosterEntry, TowerState } from '../../src/protocol/index.ts';
import { autoTeardownNotice, completedNoticeText } from '../../src/tower/autopilot/texts.ts';
import {
  approvalDialogTitle,
  approvedNoticeStart,
  checkMissionHeader,
  checkModelRows,
  completionNoticeStart,
  KEEP_PLANNING_NOTICE,
  leftoverWorktrees,
  MISSION_ALREADY_OFF,
  MISSION_CONTROL_START,
  MISSION_GOAL_QUESTION_START,
  MISSION_HANDED_START,
  MISSION_HEADER_START,
  MISSION_INTERVIEW_ANSWERS,
  MISSION_KEY,
  MISSION_OFF_START,
  MISSION_PLANNING_HEADING,
  missionAcceptScript,
  missionGoal,
  missionModelRows,
  missionSetup,
  missionStatusPhase,
  panelLineMatches,
  panelModelsLine,
  panelRunningFeatures,
  panelStatus,
  teardownSection,
  type MissionAcceptRun,
} from './mission.ts';
import { TEXTKIT_FILES } from './objective.ts';
import { chooseOption } from './rpc.ts';
import { parseRoleModel, type RoleModel } from './settings.ts';
import { createRepo, git } from './workspace.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-tower-e2e-mission-'));
  dirs.push(dir);
  return dir;
}

const A = parseRoleModel('byteplus-gateway/claude-sonnet-5-5:low');
const B = parseRoleModel('byteplus-gateway/claude-haiku-5-5:low');
const C = parseRoleModel('byteplus-gateway/claude-opus-5-5:low');
const V = parseRoleModel('byteplus-gateway/claude-sonnet-5-5:high');
const SESSION = { provider: 'byteplus-gateway', modelId: 'claude-haiku-5-5', thinkingLevel: 'low' } as const;

function spec(role: RoleModel): TowerModelSpec {
  const [provider = '', modelId = ''] = role.model.split('/');
  return role.thinking === undefined ? { provider, modelId } : ({ provider, modelId, thinkingLevel: role.thinking } as TowerModelSpec);
}

function fromFile(role: RoleModel): TowerConfigValue<TowerModelSpec> {
  return { value: spec(role), source: { kind: 'file', scope: 'global', path: '/tmp/pi-tower-e2e-x/S18/tower.json' } };
}

function s18Models(validator?: RoleModel): ReturnType<typeof resolveTowerModels> {
  const config: TowerConfig = {
    roles: {
      orchestrator: fromFile(A),
      worker: { value: spec(B), source: { kind: 'flag', flag: 'tower-worker-model' } },
      reviewer: fromFile(C),
      ...(validator === undefined ? {} : { validator: fromFile(validator) }),
    },
    models: {},
    files: [],
  };
  return resolveTowerModels(config, SESSION);
}

function milestone(id: string, status: TowerMilestone['status'], order: number): TowerMilestone {
  return { id, title: 'Two commands', order, status, validation: { scrutiny: true, userTesting: false, commands: [] }, rounds: [] };
}

function objective(patch: Partial<TowerObjective> = {}): TowerObjective {
  return {
    id: 'O1',
    title: 'lower and chars commands',
    goal: 'Add two commands',
    definitionOfDone: ['both commands work'],
    acceptanceCommands: ['npm test'],
    status: 'executing',
    milestones: [milestone('MS1', 'active', 1)],
    limits: { maxValidationRounds: 3, maxFeatureAttempts: 3, maxCostUsd: 5, maxWallTimeMs: 30 * 60_000 },
    createdAt: '2026-11-10T10:00:00.000Z',
    startedAt: '2026-11-10T10:05:00.000Z',
    usage: { costUsd: 0.42 },
    notes: [],
    ...patch,
  };
}

function feature(id: string, title: string, status: TowerMission['status']): TowerMission {
  return { id, title, slug: title, kind: 'build', scope: [`src/commands/${title}.js`], branch: `feat/${title}`, worktree: `wt-${id.slice(1)}`, deps: [], status, tasks: [], notes: [], blockers: [], milestone: 'MS1' };
}

function worker(name: string, missionId: string): TowerRosterEntry {
  return { name, agentId: `agent-${name}`, kind: 'worker', missionId, spawnedAt: '2026-11-10T10:05:01.000Z' };
}

function panelInput(patch: Partial<MissionPanelInput> = {}): MissionPanelInput {
  return {
    objective: objective(),
    missions: [feature('M1', 'lower', 'active'), feature('M2', 'chars', 'active')],
    agents: [worker('ap-w-M1-1', 'M1'), worker('ap-w-M2-1', 'M2')],
    models: s18Models(),
    maxRunningAgents: 4,
    nowMs: Date.parse('2026-11-10T10:07:30.000Z'),
    ...patch,
  };
}

describe('the deterministic /mission output S18 expects', () => {
  it('names the same keys, titles and status texts as the product', () => {
    expect(MISSION_KEY).toBe(MISSION_STATUS_KEY);
    expect(MISSION_KEY).toBe(MISSION_WIDGET_KEY);
    expect(MISSION_HEADER_START).toBe(`${MISSION_MODE_TITLE}\n`);
    expect(MISSION_GOAL_QUESTION.startsWith(MISSION_GOAL_QUESTION_START)).toBe(true);
    expect(MISSION_HANDED_START).toBe(MISSION_HANDED_TITLE);
    expect(MISSION_OFF_START).toBe(`${MISSION_OFF_TITLE}\n`);
    expect(MISSION_ALREADY_OFF).toBe(PRODUCT_ALREADY_OFF);
    expect(missionStatusPhase(MISSION_STATUS_WAITING_FOR_GOAL)).toBe('waiting-for-goal');
    expect(missionStatusPhase(MISSION_STATUS_PLANNING_GOAL)).toBe('planning-goal');
  });

  it('reads the /mission header the product renders for the S18 configuration: the validator inherits the reviewer', () => {
    const setup = missionSetup({ orchestrator: A, worker: B, reviewer: C, validator: C });
    const header = `${MISSION_MODE_TITLE}\n${renderMissionHeader({ models: { resolved: s18Models() }, base: 'main', initialized: true, maxRunningAgents: 4 })}`;
    expect(missionModelRows(header).map(({ line: _line, ...row }) => row)).toEqual([
      { role: 'orchestrator', model: A.model, thinking: 'low', source: 'global tower.json' },
      { role: 'worker', model: B.model, thinking: 'low', source: '--tower-worker-model' },
      { role: 'reviewer', model: C.model, thinking: 'low', source: 'global tower.json' },
      { role: 'validator', note: 'same as reviewer' },
    ]);
    expect(checkMissionHeader(header, setup.header, 4)).toEqual(expect.objectContaining({ ok: true }));
    expect(checkMissionHeader(header, setup.header, 8).ok).toBe(false);
    expect(setup.towerConfig).toEqual(expect.objectContaining({ orchestrator: A.spec, reviewer: C.spec, maxRunningAgents: 4 }));
    expect(setup.towerConfig).not.toHaveProperty('worker');
    expect(setup.towerConfig).not.toHaveProperty('validator');
    expect(setup.extraArgs).toEqual(['--tower-worker-model', B.spec]);
  });

  it('reads an explicitly configured validator with its source, and reports a mismatch in the evidence', () => {
    const setup = missionSetup({ orchestrator: A, worker: B, reviewer: C, validator: V });
    const header = `${MISSION_MODE_TITLE}\n${renderMissionHeader({ models: { resolved: s18Models(V) }, base: 'main', initialized: false, maxRunningAgents: 4 })}`;
    expect(setup.towerConfig).toEqual(expect.objectContaining({ validator: V.spec }));
    expect(checkMissionHeader(header, setup.header, 4).ok).toBe(true);
    const inherited = missionSetup({ orchestrator: A, worker: B, reviewer: C, validator: C });
    const mismatch = checkModelRows(header, inherited.header);
    expect(mismatch.ok).toBe(false);
    expect(mismatch.evidence.at(-1)).toMatch(/— expected validator: same as reviewer$/);
  });

  it('reads the unindented model rows of Mission Control and keeps a missing model as a note', () => {
    const control = `${MISSION_CONTROL_TITLE}\n${renderMissionControl({ models: { resolved: s18Models() }, objective: objective(), statusMarkdown: '# Mission O1 — lower and chars commands' })}`;
    const setup = missionSetup({ orchestrator: A, worker: B, reviewer: C, validator: C });
    expect(control.startsWith(MISSION_CONTROL_START)).toBe(true);
    expect(checkModelRows(control, setup.header).ok).toBe(true);
    expect(control).toContain('\n## Commands\n/mission pause [reason]');
    const none = resolveTowerModels({ roles: {}, models: {}, files: [] }, undefined);
    const rows = missionModelRows(renderMissionHeader({ models: { resolved: none }, base: 'main', initialized: false, maxRunningAgents: 4 }));
    const orchestrator = rows.find((row) => row.role === 'orchestrator');
    expect(orchestrator?.model).toBeUndefined();
    expect(orchestrator?.note).toMatch(/^\(none\) — /);
  });

  it('reads the approval dialog the product offers; option 0 keeps planning', () => {
    const ready = missionApprovalDialog(objective({ status: 'awaiting-approval' }), 1, 2);
    expect(approvalDialogTitle(ready.title)).toEqual({ objective: 'O1', title: 'lower and chars commands', revised: false, milestones: 1, features: 2 });
    expect(chooseOption(0)({ id: 'x', method: 'select', title: ready.title, message: undefined, options: [...ready.options] })).toEqual({ value: MISSION_KEEP_PLANNING_OPTION });
    const revised = missionApprovalDialog(objective({ status: 'awaiting-approval', approvalReason: 'contract-changed' }), 2, 1);
    expect(approvalDialogTitle(revised.title)).toEqual(expect.objectContaining({ revised: true, milestones: 2, features: 1 }));
    expect(approvalDialogTitle('Stop the worker?')).toBeUndefined();
    expect(KEEP_PLANNING_NOTICE.test(missionKeepPlanning(objective({ status: 'awaiting-approval' })))).toBe(true);
    expect(`${missionApprovedTitle(objective())}\nbody`.startsWith(approvedNoticeStart('O1'))).toBe(true);
  });

  it('puts the goal verbatim into the planning prompt the intake hands over', () => {
    const goal = missionGoal('/tmp/pi-tower-e2e-x/S18/accept-s18.mjs');
    expect(goal).not.toContain('\n');
    expect(goal).toContain('`node /tmp/pi-tower-e2e-x/S18/accept-s18.mjs`');
    expect(goal).not.toContain('chars ab cd');
    expect(MISSION_INTERVIEW_ANSWERS).toContain('`node src/cli.js chars ab cd` prints `5`');
    expect(MISSION_INTERVIEW_ANSWERS).toContain('`node src/cli.js lower Hello WORLD` prints `hello world`');
    const prompt = buildObjectivePlanningPrompt({ mode: 'interactive', text: goal });
    expect(prompt.startsWith(MISSION_PLANNING_HEADING)).toBe(true);
    expect(prompt).toContain(`## Mission goal\n\n${goal}\n`);
  });
});

describe('the status line and the panel', () => {
  it('classifies the status line the product renders in every phase', () => {
    expect(missionStatusPhase(renderMissionStatus(panelInput({ objective: objective({ status: 'planning', startedAt: undefined }), agents: [] })))).toBe('planning');
    expect(missionStatusPhase(renderMissionStatus(panelInput({ objective: objective({ status: 'awaiting-approval', startedAt: undefined }), agents: [] })))).toBe('awaiting-approval');
    const executing = renderMissionStatus(panelInput());
    expect(executing).toBe('mission O1 executing · MS1 0/2 merged · 2 agents');
    expect(missionStatusPhase(executing)).toBe('executing');
    expect(missionStatusPhase(renderMissionStatus(panelInput({ objective: objective({ status: 'completed', milestones: [milestone('MS1', 'passed', 1)] }), agents: [] })))).toBe('completed');
    expect(missionStatusPhase(undefined)).toBe('cleared');
    expect(missionStatusPhase('tower: on')).toBe('other');
  });

  it('reads the headline status, the running features and the models line of the panel the product renders', () => {
    const setup = missionSetup({ orchestrator: A, worker: B, reviewer: C, validator: C });
    const lines = renderMissionPanel(panelInput());
    expect(panelStatus(lines)).toBe('executing');
    expect(panelRunningFeatures(lines)).toEqual([
      { feature: 'M1', worker: 'ap-w-M1-1' },
      { feature: 'M2', worker: 'ap-w-M2-1' },
    ]);
    expect(panelModelsLine(lines)).toBe(setup.panelModels);
    expect(panelLineMatches(panelModelsLine(lines), setup.panelModels)).toBe(true);
    const explicit = missionSetup({ orchestrator: A, worker: B, reviewer: C, validator: V });
    const models = panelModelsLine(renderMissionPanel(panelInput({ models: s18Models(V) })));
    expect(models).toBe(explicit.panelModels);
    expect(panelLineMatches(models, explicit.panelModels)).toBe(true);
    expect(panelLineMatches(models, setup.panelModels)).toBe(false);
    expect(panelLineMatches(undefined, setup.panelModels)).toBe(false);
    expect(panelStatus(renderMissionPanel(panelInput({ objective: objective({ status: 'awaiting-approval', startedAt: undefined }), agents: [], missions: [feature('M1', 'lower', 'planned')] })))).toBe('awaiting approval');
    const done = renderMissionPanel(panelInput({ objective: objective({ status: 'completed', completedAt: '2026-11-10T10:20:00.000Z', milestones: [milestone('MS1', 'passed', 1)] }), agents: [], missions: [feature('M1', 'lower', 'merged'), feature('M2', 'chars', 'merged')] }));
    expect(panelStatus(done)).toBe('completed');
    expect(panelRunningFeatures(done)).toEqual([]);
    expect(panelStatus(['agents: 0 workers'])).toBeUndefined();
  });

  it('reads a models line the panel splits over two rows, and still reads a single or a clipped row', () => {
    const explicit = missionSetup({ orchestrator: A, worker: B, reviewer: C, validator: V });
    const lines = renderMissionPanel(panelInput({ models: s18Models(V) }));
    expect(lines.filter((line) => line.startsWith('models: ') || line.startsWith(' '))).toEqual([
      'models: orchestrator claude-sonnet-5-5 · worker claude-haiku-5-5',
      '        reviewer claude-opus-5-5 · validator claude-sonnet-5-5',
    ]);
    expect(panelRunningFeatures(lines)).toEqual([
      { feature: 'M1', worker: 'ap-w-M1-1' },
      { feature: 'M2', worker: 'ap-w-M2-1' },
    ]);

    const clipped = `${explicit.panelModels.slice(0, 119)}…`;
    expect(panelModelsLine(['🔵 Mission O1 lower and chars commands', clipped, 'next: validation starts'])).toBe(clipped);
    expect(panelLineMatches(clipped, explicit.panelModels)).toBe(true);
  });

  it('expects the provider prefix where the panel shows it: the same model id from two providers', () => {
    const anthropic = parseRoleModel('anthropic/claude-sonnet-5-5:low');
    const setup = missionSetup({ orchestrator: anthropic, worker: B, reviewer: C, validator: V });
    const models = resolveTowerModels(
      {
        roles: {
          orchestrator: fromFile(anthropic),
          worker: { value: spec(B), source: { kind: 'flag', flag: 'tower-worker-model' } },
          reviewer: fromFile(C),
          validator: fromFile(V),
        },
        models: {},
        files: [],
      },
      SESSION,
    );

    expect(setup.panelModels).toBe(
      'models: orchestrator anthropic/claude-sonnet-5-5 · worker claude-haiku-5-5 · reviewer claude-opus-5-5 · validator byteplus-gateway/claude-sonnet-5-5',
    );
    expect(panelModelsLine(renderMissionPanel(panelInput({ models })))).toBe(setup.panelModels);
  });
});

describe('the completion notice', () => {
  it('starts with the mission and carries the automatic teardown section the autopilot appends', () => {
    const done = objective({ status: 'completed', completedAt: '2026-11-10T10:20:00.000Z', milestones: [{ ...milestone('MS1', 'passed', 1), validationCommit: 'abcdef1234567' }] });
    const state = { base: 'main', missions: [feature('M1', 'lower', 'merged'), feature('M2', 'chars', 'merged')], objective: done } as unknown as TowerState;
    const text = completedNoticeText({
      objective: done,
      state,
      baseTip: 'abcdef1234567',
      now: Date.parse('2026-11-10T10:20:00.000Z'),
      teardown: {
        lines: ['removed .tower/worktrees/wt-1', 'removed .tower/worktrees/wt-2', 'kept .tower/worktrees/val-ms1-scrutiny-r1 (validator ap-v-MS1-scrutiny-1 is finishing — its worktree is removed when it ends)'],
        removed: 2,
        kept: 1,
        finishing: 1,
        failed: 0,
      },
    });
    expect(text.startsWith(completionNoticeStart(done))).toBe(true);
    expect(teardownSection(text)).toEqual({
      summary: 'Automatic teardown: removed 2 worktree(s), kept 1.',
      counts: { removed: 2, kept: 1, failed: 0 },
      items: ['removed .tower/worktrees/wt-1', 'removed .tower/worktrees/wt-2', 'kept .tower/worktrees/val-ms1-scrutiny-r1 (validator ap-v-MS1-scrutiny-1 is finishing — its worktree is removed when it ends)'],
    });
  });

  it('reads failed removals, an empty teardown, a failed teardown and a notice without the section', () => {
    const failed = autoTeardownNotice({ lines: ['removed .tower/worktrees/wt-1', 'failed to remove .tower/worktrees/wt-2: locked'], removed: 1, kept: 0, finishing: 0, failed: 1 });
    expect(teardownSection(failed)?.counts).toEqual({ removed: 1, kept: 0, failed: 1 });
    expect(teardownSection(autoTeardownNotice({ lines: [], removed: 0, kept: 0, finishing: 0, failed: 0 }))).toEqual({ summary: 'Automatic teardown: no worktree was left to remove.', counts: undefined, items: [] });
    expect(teardownSection(autoTeardownNotice({ lines: [], removed: 0, kept: 0, finishing: 0, failed: 0, error: 'git exploded' }))?.counts).toBeUndefined();
    expect(teardownSection('Mission O1 "x" is complete: ...')).toBeUndefined();
  });
});

describe('leftoverWorktrees', () => {
  it('lists the registered worktrees besides the main checkout and the entries of .tower/worktrees', () => {
    const repo = createRepo(tempDir(), { 'README.md': '# unit\n', '.gitignore': '.tower/\n' });
    expect(leftoverWorktrees(repo)).toEqual({ registered: [], directories: [] });
    git(repo, ['worktree', 'add', '-q', '-b', 'feat/lower', join('.tower', 'worktrees', 'wt-1')]);
    const left = leftoverWorktrees(repo);
    expect(left.registered.map((path) => realpathSync(path))).toEqual([realpathSync(join(repo, '.tower', 'worktrees', 'wt-1'))]);
    expect(left.directories).toEqual(['wt-1']);
    git(repo, ['worktree', 'remove', join('.tower', 'worktrees', 'wt-1')]);
    expect(leftoverWorktrees(repo)).toEqual({ registered: [], directories: [] });
  });
});

describe('missionAcceptScript', () => {
  function checkout(dir: string, name: string, commands: Readonly<Record<string, string>>): string {
    const parent = join(dir, 'wt');
    mkdirSync(parent, { recursive: true });
    const repo = createRepo(parent, { ...TEXTKIT_FILES, ...commands });
    const target = join(parent, name);
    spawnSync('mv', [repo, target]);
    return target;
  }

  function run(script: string, cwd: string): number | null {
    return spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' }).status;
  }

  const LOWER = "export default function lower(args) {\n  return args.join(' ').toLowerCase();\n}\n";
  const CHARS = "export default function chars(args) {\n  return args.join(' ').length;\n}\n";

  it('verifies nothing outside the checkout of the tower commands validation', () => {
    const dir = tempDir();
    const runs = join(dir, 'runs.json');
    const script = join(dir, 'accept.mjs');
    writeFileSync(script, missionAcceptScript(runs));
    expect(run(script, checkout(dir, 'repo', {}))).toBe(0);
    expect(existsSync(runs)).toBe(false);
  });

  it('passes and records the run when both commands print the expected output, and fails when one is missing', () => {
    const dir = tempDir();
    const runs = join(dir, 'runs.json');
    const script = join(dir, 'accept.mjs');
    writeFileSync(script, missionAcceptScript(runs));
    const good = checkout(dir, 'val-ms1-commands-r1', { 'src/commands/lower.js': LOWER, 'src/commands/chars.js': CHARS });
    expect(run(script, good)).toBe(0);
    rmSync(join(dir, 'wt'), { recursive: true, force: true });
    const bad = checkout(dir, 'val-ms1-commands-r2', { 'src/commands/lower.js': LOWER });
    expect(run(script, bad)).toBe(1);
    const recorded = JSON.parse(readFileSync(runs, 'utf8')) as MissionAcceptRun[];
    expect(recorded.map(({ execution, lower, chars, pass }) => ({ execution, lower, chars, pass }))).toEqual([
      { execution: 1, lower: 'hello world', chars: '5', pass: true },
      { execution: 2, lower: 'hello world', chars: null, pass: false },
    ]);
    expect(recorded[1]?.commit).toBe(git(bad, ['rev-parse', 'HEAD']));
  });
});
