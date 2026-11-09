import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MilestoneRecord, MissionRecord, ObjectiveRecord, RosterEntry, TowerState } from './evidence.ts';
import {
  checkAutopilotPromptness,
  checkRosterModels,
  concurrentFeatures,
  describeWindow,
  featureWorkerWindows,
  processesUnder,
  requiredValidationKinds,
  validationStarts,
  waitForAutopilotEntry,
  type FeatureWindow,
} from './objective.ts';
import { ScenarioReport, type CheckResult } from './report.ts';
import { parseRoleModel } from './settings.ts';
import { createRepo, git } from './workspace.ts';

const HAS_PS = spawnSync('ps', ['-ww', '-axo', 'pid=,command='], { stdio: 'ignore' }).status === 0;
const HAS_LSOF = spawnSync('lsof', ['-v'], { stdio: 'ignore' }).error === undefined;

const dirs: string[] = [];
const children: ChildProcess[] = [];

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-tower-e2e-unit-'));
  dirs.push(dir);
  return dir;
}

function unitRepo(): string {
  return createRepo(tempDir(), { 'README.md': '# unit\n', '.gitignore': '.tower/\n' });
}

function mergeFeature(repo: string, branch: string): string {
  git(repo, ['checkout', '-q', '-b', branch]);
  writeFileSync(join(repo, `${branch.replaceAll('/', '-')}.txt`), `${branch}\n`);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', `add ${branch}`]);
  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['merge', '-q', '--no-ff', '--no-edit', '-m', `Merge branch '${branch}'`, branch]);
  return git(repo, ['rev-parse', 'HEAD']);
}

function writeActivityLog(repo: string, lines: readonly string[]): void {
  const dir = join(repo, '.tower', 'comms', 'log');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'activity.log'), `${lines.join('\n')}\n`);
}

function mergeLine(at: string, branch: string, commit: string): string {
  return `${at} tower merge branch=${branch} base=main merge_commit=${commit.slice(0, 7)}`;
}

function startLine(at: string, milestone: string, commit: string): string {
  return `${at} autopilot start-validation milestone=${milestone} commit=${commit} kinds=scrutiny,commands result=done detail=status=validating commit=${commit} kinds=scrutiny=ap-v-${milestone}-scrutiny-1,commands`;
}

function promptness(repo: string): CheckResult | undefined {
  const report = new ScenarioReport('S0', 'unit', false);
  checkAutopilotPromptness({ report }, repo);
  return report.checks.find((check) => check.name.startsWith('every milestone validation starts within 15s'));
}

describe('checkAutopilotPromptness', () => {
  it('passes when every start is measured against the merge that produced its commit and starts within 15 s', () => {
    const repo = unitRepo();
    const first = mergeFeature(repo, 'feat/a');
    const second = mergeFeature(repo, 'feat/b');
    writeActivityLog(repo, [
      mergeLine('2026-11-09T09:37:32.844Z', 'feat/a', first),
      startLine('2026-11-09T09:37:32.853Z', 'MS1', first.slice(0, 7)),
      mergeLine('2026-11-09T09:39:00.000Z', 'feat/b', second),
      startLine('2026-11-09T09:39:14.900Z', 'MS2', second.slice(0, 7)),
    ]);
    const check = promptness(repo);
    expect(check?.ok).toBe(true);
    expect(check?.evidence).toEqual([
      `MS1 on ${first.slice(0, 7)}: merge 2026-11-09T09:37:32.844Z → start 2026-11-09T09:37:32.853Z (0.0s)`,
      `MS2 on ${second.slice(0, 7)}: merge 2026-11-09T09:39:00.000Z → start 2026-11-09T09:39:14.900Z (14.9s)`,
    ]);
  });

  it('fails and names the start when its commit is a merge commit without a tower merge line to measure against', () => {
    const repo = unitRepo();
    const first = mergeFeature(repo, 'feat/a');
    const second = mergeFeature(repo, 'feat/b');
    writeActivityLog(repo, [mergeLine('2026-11-09T09:37:32.844Z', 'feat/a', first), startLine('2026-11-09T09:37:32.853Z', 'MS1', first.slice(0, 7)), startLine('2026-11-09T09:39:14.900Z', 'MS2', second.slice(0, 7))]);
    const check = promptness(repo);
    expect(check?.ok).toBe(false);
    expect(check?.evidence).toEqual([
      `MS1 on ${first.slice(0, 7)}: merge 2026-11-09T09:37:32.844Z → start 2026-11-09T09:37:32.853Z (0.0s)`,
      `MS2 on ${second.slice(0, 7)}: UNMEASURED start at 2026-11-09T09:39:14.900Z — it is a merge commit, but no "tower merge ... merge_commit=${second.slice(0, 7)}" line precedes the start`,
    ]);
  });

  it('fails instead of passing vacuously when the start names its commit in a form that matches no merge_commit', () => {
    const repo = unitRepo();
    const merged = mergeFeature(repo, 'feat/a');
    writeActivityLog(repo, [mergeLine('2026-11-09T09:37:32.844Z', 'feat/a', merged), startLine('2026-11-09T09:37:32.853Z', 'MS1', merged)]);
    expect(validationStarts(repo)).toEqual([expect.objectContaining({ milestone: 'MS1', commit: merged, latencyMs: undefined, unmeasured: true })]);
    expect(promptness(repo)?.ok).toBe(false);
  });

  it('fails when the start has no commit at all', () => {
    const repo = unitRepo();
    const merged = mergeFeature(repo, 'feat/a');
    writeActivityLog(repo, [mergeLine('2026-11-09T09:37:32.844Z', 'feat/a', merged), '2026-11-09T09:37:32.853Z autopilot start-validation milestone=MS1 result=done detail=status=validating']);
    const check = promptness(repo);
    expect(check?.ok).toBe(false);
    expect(check?.evidence).toEqual(['MS1 on (no commit field): UNMEASURED start at 2026-11-09T09:37:32.853Z — the commit does not resolve in the repository', '(no start could be measured)']);
  });

  it('leaves a start on a commit that no merge produced out of the measurement, but needs at least one measured start', () => {
    const repo = unitRepo();
    const initial = git(repo, ['rev-parse', 'HEAD']).slice(0, 7);
    writeActivityLog(repo, [startLine('2026-11-09T09:30:00.000Z', 'MS1', initial)]);
    expect(promptness(repo)).toEqual(expect.objectContaining({ ok: false, evidence: [`MS1 on ${initial}: no merge produced this commit`, '(no start could be measured)'] }));
    const merged = mergeFeature(repo, 'feat/a');
    writeActivityLog(repo, [startLine('2026-11-09T09:30:00.000Z', 'MS1', initial), mergeLine('2026-11-09T09:37:32.844Z', 'feat/a', merged), startLine('2026-11-09T09:37:33.000Z', 'MS2', merged.slice(0, 7))]);
    expect(promptness(repo)?.ok).toBe(true);
  });

  it('fails when nothing started a validation', () => {
    const repo = unitRepo();
    writeActivityLog(repo, [mergeLine('2026-11-09T09:37:32.844Z', 'feat/a', mergeFeature(repo, 'feat/a'))]);
    expect(promptness(repo)).toEqual(expect.objectContaining({ ok: false, evidence: ['(no autopilot start-validation line)', '(no start could be measured)'] }));
  });
});

function fakeProcfs(root: string, processes: readonly { readonly pid: string; readonly cwd: string; readonly argv: readonly string[] }[]): string {
  const proc = join(root, 'proc');
  for (const entry of processes) {
    mkdirSync(join(proc, entry.pid), { recursive: true });
    symlinkSync(entry.cwd, join(proc, entry.pid, 'cwd'));
    writeFileSync(join(proc, entry.pid, 'cmdline'), `${entry.argv.join('\0')}\0`);
  }
  mkdirSync(join(proc, 'sys'), { recursive: true });
  return proc;
}

function fakeCommand(root: string, name: string, output: readonly string[]): string {
  const path = join(root, name);
  writeFileSync(path, `#!/bin/sh\ncat <<'EOF'\n${output.join('\n')}\nEOF\n`);
  chmodSync(path, 0o755);
  return path;
}

function idle(options: { readonly cwd?: string; readonly args?: readonly string[] }): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...(options.args ?? [])], { cwd: options.cwd, stdio: 'ignore' });
  children.push(child);
  return child;
}

describe('processesUnder', () => {
  it('reads the working directory and command line of every process from procfs, skipping its own process', () => {
    const root = tempDir();
    const dir = join(root, 'S16');
    const proc = fakeProcfs(root, [
      { pid: String(process.pid), cwd: dir, argv: ['node', 'vitest', dir] },
      { pid: '101', cwd: join(dir, 'repo'), argv: ['node', 'cli.js'] },
      { pid: '102', cwd: '/elsewhere', argv: ['pi', '--session-dir', join(dir, 'sessions')] },
      { pid: '103', cwd: '/elsewhere', argv: ['sleep', '300'] },
    ]);
    const scan = processesUnder(dir, { procRoot: proc, ps: join(root, 'no-ps') });
    expect(scan.applicable).toBe(true);
    expect(scan.method).toBe(`the working directory and command line of every process in ${proc}`);
    expect([...scan.processes].sort((a, b) => a.pid - b.pid)).toEqual([
      { pid: 101, cwd: join(dir, 'repo'), command: 'node cli.js' },
      { pid: 102, cwd: '/elsewhere', command: `pi --session-dir ${join(dir, 'sessions')}` },
    ]);
  });

  it('matches the real path of a symlinked run dir as well, since procfs reports working directories with symlinks resolved', () => {
    const root = tempDir();
    mkdirSync(join(root, 'real', 'S16'), { recursive: true });
    symlinkSync(join(root, 'real'), join(root, 'link'));
    const dir = join(root, 'link', 'S16');
    const resolved = realpathSync(dir);
    const proc = fakeProcfs(root, [
      { pid: String(process.pid), cwd: resolved, argv: ['node', 'vitest', dir] },
      { pid: '101', cwd: join(resolved, 'repo'), argv: ['node', 'cli.js'] },
      { pid: '102', cwd: '/elsewhere', argv: ['pi', '--session-dir', join(dir, 'sessions')] },
      { pid: '103', cwd: '/elsewhere', argv: ['pi', '--session-dir', join(resolved, 'sessions')] },
      { pid: '104', cwd: '/elsewhere', argv: ['sleep', '300'] },
    ]);
    const scan = processesUnder(dir, { procRoot: proc, ps: join(root, 'no-ps') });
    expect(scan.method).toBe(`the working directory and command line of every process in ${proc}`);
    expect([...scan.processes].sort((a, b) => a.pid - b.pid)).toEqual([
      { pid: 101, cwd: join(resolved, 'repo'), command: 'node cli.js' },
      { pid: 102, cwd: '/elsewhere', command: `pi --session-dir ${join(dir, 'sessions')}` },
      { pid: 103, cwd: '/elsewhere', command: `pi --session-dir ${join(resolved, 'sessions')}` },
    ]);
  });

  it('falls back to ps for command lines and lsof for working directories when procfs is unavailable', () => {
    const root = tempDir();
    const dir = join(root, 'S16');
    const worktree = join(dir, 'repo', '.tower', 'worktrees', 'val-ms1-commands-r1');
    const ps = fakeCommand(root, 'ps', [`  ${String(process.pid)} node vitest ${dir}`, `  101 node /x/bin/pi-tower.js run --cwd ${join(dir, 'repo')}`, '  102 bash -c npm test', '  103 sleep 300']);
    const lsof = fakeCommand(root, 'lsof', ['p101', 'fcwd', 'n/home/user', 'p102', 'fcwd', `n${worktree}`, 'p103', 'fcwd', 'n/data/elsewhere']);
    const scan = processesUnder(dir, { procRoot: join(root, 'no-proc'), ps, lsof });
    expect(scan).toEqual({
      applicable: true,
      method: `the command line of every process (${ps}) and the working directories ${lsof} reported for 3 processes`,
      processes: [
        { pid: 101, cwd: '/home/user', command: `node /x/bin/pi-tower.js run --cwd ${join(dir, 'repo')}` },
        { pid: 102, cwd: worktree, command: 'bash -c npm test' },
      ],
    });
  });

  it('matches command lines only, and says so, when lsof is not available either', () => {
    const root = tempDir();
    const dir = join(root, 'S16');
    const ps = fakeCommand(root, 'ps', [`  101 node /x/bin/pi-tower.js run --cwd ${join(dir, 'repo')}`, '  102 bash -c npm test']);
    const lsof = join(root, 'no-lsof');
    const scan = processesUnder(dir, { procRoot: join(root, 'no-proc'), ps, lsof });
    expect(scan).toEqual({
      applicable: true,
      method: `the command line of every process (${ps}); ${lsof} is not available, so working directories were not checked`,
      processes: [{ pid: 101, cwd: '?', command: `node /x/bin/pi-tower.js run --cwd ${join(dir, 'repo')}` }],
    });
  });

  it('reports the check as not applicable instead of throwing when there is neither procfs nor ps', () => {
    const root = tempDir();
    const procRoot = join(root, 'no-proc');
    const ps = join(root, 'no-ps');
    const scan = processesUnder(join(root, 'S16'), { procRoot, ps });
    expect(scan.applicable).toBe(false);
    expect(scan.processes).toEqual([]);
    expect(scan.method).toContain(`no usable ${procRoot}, and \`${ps} -ww -axo pid=,command=\` failed (`);
  });

  it.skipIf(!existsSync('/proc/self/cwd'))('finds a live process by its working directory through /proc', () => {
    const dir = tempDir();
    const child = idle({ cwd: dir });
    const scan = processesUnder(dir);
    expect(scan.method).toBe('the working directory and command line of every process in /proc');
    expect(scan.processes.map((info) => info.pid)).toContain(child.pid);
  });

  it.skipIf(!HAS_PS)('finds a live process by its command line through the real ps when procfs is unavailable', () => {
    const dir = tempDir();
    const child = idle({ args: [dir] });
    const scan = processesUnder(dir, { procRoot: join(dir, 'no-proc'), lsof: join(dir, 'no-lsof') });
    expect(scan.applicable).toBe(true);
    expect(scan.processes.map((info) => info.pid)).toContain(child.pid);
  });

  it.skipIf(!HAS_PS || !HAS_LSOF)('finds a live process by its working directory through the real lsof when procfs is unavailable', () => {
    const dir = tempDir();
    const child = idle({ cwd: dir });
    const scan = processesUnder(dir, { procRoot: join(dir, 'no-proc') });
    expect(scan.method).toMatch(/^the command line of every process \(ps\) and the working directories lsof reported for \d+ processes$/);
    expect(scan.processes.map((info) => info.pid)).toContain(child.pid);
  });
});

describe('waitForAutopilotEntry', () => {
  it('waits for an autopilot action that is logged after the state already changed, and gives up after the timeout', async () => {
    const repo = unitRepo();
    writeActivityLog(repo, ['2026-11-09T17:03:35.721Z tower objective.complete id=O1 base_tip=2aea10e']);
    setTimeout(() => {
      writeActivityLog(repo, ['2026-11-09T17:03:35.721Z tower objective.complete id=O1 base_tip=2aea10e', '2026-11-09T17:03:36.109Z autopilot complete-objective objective=O1 result=done detail=objective=O1']);
    }, 150);
    expect((await waitForAutopilotEntry(repo, 'complete-objective', 5000, 20))?.fields).toEqual({ objective: 'O1', result: 'done', detail: 'objective=O1' });
    expect(await waitForAutopilotEntry(repo, 'block-objective', 100, 20)).toBeUndefined();
  });
});

function window(feature: string, milestone: string, worker: string, from: string, to: string): FeatureWindow {
  return { feature, milestone, worker, firstAt: Date.parse(from), lastAt: Date.parse(to) };
}

describe('concurrentFeatures', () => {
  it('pairs the workers of different features of one milestone whose transcripts overlap, with the overlap', () => {
    const a = window('M1', 'MS1', 'ap-w-M1-1', '2026-11-10T10:00:00.000Z', '2026-11-10T10:02:00.000Z');
    const b = window('M2', 'MS1', 'ap-w-M2-1', '2026-11-10T10:00:30.000Z', '2026-11-10T10:03:00.000Z');
    expect(concurrentFeatures([a, b])).toEqual([{ a, b, overlapMs: 90_000 }]);
    expect(describeWindow(a)).toBe('ap-w-M1-1 (M1, MS1): 2026-11-10T10:00:00.000Z → 2026-11-10T10:02:00.000Z');
  });

  it('never pairs two workers of one feature, features of different milestones, or windows that only touch', () => {
    const first = window('M1', 'MS1', 'ap-w-M1-1', '2026-11-10T10:00:00.000Z', '2026-11-10T10:02:00.000Z');
    const respawn = window('M1', 'MS1', 'ap-w-M1-2', '2026-11-10T10:01:00.000Z', '2026-11-10T10:04:00.000Z');
    const otherMilestone = window('M3', 'MS2', 'ap-w-M3-1', '2026-11-10T10:00:10.000Z', '2026-11-10T10:01:00.000Z');
    const touching = window('M2', 'MS1', 'ap-w-M2-1', '2026-11-10T10:04:00.000Z', '2026-11-10T10:05:00.000Z');
    expect(concurrentFeatures([first, respawn, otherMilestone, touching])).toEqual([]);
  });
});

function transcript(repo: string, agentId: string, timestamps: readonly string[]): void {
  const dir = join(repo, '.tower', 'agents');
  mkdirSync(dir, { recursive: true });
  const lines = timestamps.map((timestamp, index) => JSON.stringify(index === 0 ? { type: 'session', timestamp, cwd: repo } : { type: 'message', timestamp, message: { role: 'assistant', content: [] } }));
  writeFileSync(join(dir, `${timestamps[0]?.replaceAll(':', '-') ?? 'x'}_${agentId}.jsonl`), `${lines.join('\n')}\n`);
}

function mission(id: string, milestone: string): MissionRecord {
  return { id, status: 'merged', branch: `feat/${id}`, worktree: `wt-${id}`, milestone };
}

function rosterWorker(name: string, missionId: string, model = 'byteplus-gateway/claude-haiku-5-5'): RosterEntry {
  return { name, agentId: `agent-${name}`, kind: 'worker', missionId, model };
}

describe('featureWorkerWindows', () => {
  it('reads the time window of every worker of the given features from its transcript', () => {
    const repo = tempDir();
    transcript(repo, 'agent-w1', ['2026-11-10T10:00:00.000Z', '2026-11-10T10:01:00.000Z', '2026-11-10T10:02:00.000Z']);
    transcript(repo, 'agent-w2', ['2026-11-10T10:00:30.000Z', '2026-11-10T10:03:00.000Z']);
    transcript(repo, 'agent-w3', ['2026-11-10T10:10:00.000Z', '2026-11-10T10:11:00.000Z']);
    const state = { base: 'main', roster: { agents: [rosterWorker('w1', 'M1'), rosterWorker('w2', 'M2'), rosterWorker('w3', 'M3'), rosterWorker('w4', 'M1')] }, missions: [] } as TowerState;
    const windows = featureWorkerWindows(repo, state, [mission('M1', 'MS1'), mission('M2', 'MS1')]);
    expect(windows).toEqual([
      { feature: 'M1', milestone: 'MS1', worker: 'w1', firstAt: Date.parse('2026-11-10T10:00:00.000Z'), lastAt: Date.parse('2026-11-10T10:02:00.000Z') },
      { feature: 'M2', milestone: 'MS1', worker: 'w2', firstAt: Date.parse('2026-11-10T10:00:30.000Z'), lastAt: Date.parse('2026-11-10T10:03:00.000Z') },
    ]);
    expect(concurrentFeatures(windows).map((pair) => pair.overlapMs)).toEqual([90_000]);
  });
});

function milestoneRecord(id: string, order: number, validation: MilestoneRecord['validation']): MilestoneRecord {
  return { id, title: id, order, status: 'active', rounds: [], ...(validation === undefined ? {} : { validation }) };
}

describe('requiredValidationKinds', () => {
  const objective = (milestones: readonly MilestoneRecord[], acceptanceCommands: readonly string[] = []): ObjectiveRecord => ({
    id: 'O1',
    title: 'x',
    status: 'executing',
    definitionOfDone: [],
    acceptanceCommands,
    milestones,
    limits: { maxValidationRounds: 3, maxFeatureAttempts: 3 },
    notes: [],
  });

  it('adds the acceptance commands to the final milestone only, and drops the kinds the settings skip', () => {
    const first = milestoneRecord('MS1', 1, { scrutiny: true, userTesting: true, commands: [] });
    const last = milestoneRecord('MS2', 2, { scrutiny: true, userTesting: false, commands: [] });
    const both = objective([last, first], ['npm test']);
    expect(requiredValidationKinds(both, first)).toEqual(['scrutiny', 'user-testing']);
    expect(requiredValidationKinds(both, first, { skipUserTesting: true })).toEqual(['scrutiny']);
    expect(requiredValidationKinds(both, last)).toEqual(['scrutiny', 'commands']);
    expect(requiredValidationKinds(both, last, { skipScrutiny: true })).toEqual(['commands']);
    expect(requiredValidationKinds(objective([milestoneRecord('MS1', 1, { scrutiny: false, userTesting: false, commands: ['npm run lint'] })]), milestoneRecord('MS1', 1, { scrutiny: false, userTesting: false, commands: ['npm run lint'] }))).toEqual(['commands']);
  });
});

describe('checkRosterModels', () => {
  const expected = {
    worker: parseRoleModel('byteplus-gateway/claude-haiku-5-5:low'),
    reviewer: parseRoleModel('byteplus-gateway/claude-opus-5-5:low'),
    validator: parseRoleModel('byteplus-gateway/claude-opus-5-5:low'),
  };

  function rosterCheck(agents: readonly RosterEntry[], requireValidator: boolean): CheckResult | undefined {
    const report = new ScenarioReport('S0', 'unit', false);
    checkRosterModels({ report }, { base: 'main', roster: { agents }, missions: [] }, expected, requireValidator);
    return report.checks[0];
  }

  const reviewer: RosterEntry = { name: 'ap-r-M1-1', agentId: 'agent-r', kind: 'reviewer', model: 'byteplus-gateway/claude-opus-5-5' };
  const validator: RosterEntry = { name: 'ap-v-MS1-scrutiny-1', agentId: 'agent-v', kind: 'validator', model: 'byteplus-gateway/claude-opus-5-5' };

  it('passes when every worker, reviewer and validator runs on its role model', () => {
    expect(rosterCheck([rosterWorker('w1', 'M1'), reviewer, validator], true)?.ok).toBe(true);
    expect(rosterCheck([rosterWorker('w1', 'M1'), reviewer], false)?.ok).toBe(true);
  });

  it('fails on an agent on another model, a missing role, or a required validator that never ran', () => {
    const wrong = rosterCheck([rosterWorker('w1', 'M1', 'byteplus-gateway/claude-opus-5-5'), reviewer, validator], true);
    expect(wrong?.ok).toBe(false);
    expect(wrong?.evidence[0]).toBe('w1 (worker) model=byteplus-gateway/claude-opus-5-5 — WRONG');
    expect(rosterCheck([reviewer, validator], true)?.ok).toBe(false);
    expect(rosterCheck([rosterWorker('w1', 'M1'), reviewer], true)?.ok).toBe(false);
  });
});
