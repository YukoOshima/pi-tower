import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkAutopilotPromptness, processesUnder, validationStarts } from './objective.ts';
import { ScenarioReport, type CheckResult } from './report.ts';
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
    expect(check?.evidence).toEqual(['MS1 on (no commit field): UNMEASURED start at 2026-11-09T09:37:32.853Z — the commit does not resolve in the repository']);
  });

  it('leaves a start on a commit that no merge produced out of the measurement, but needs at least one measured start', () => {
    const repo = unitRepo();
    const initial = git(repo, ['rev-parse', 'HEAD']).slice(0, 7);
    writeActivityLog(repo, [startLine('2026-11-09T09:30:00.000Z', 'MS1', initial)]);
    expect(promptness(repo)).toEqual(expect.objectContaining({ ok: false, evidence: [`MS1 on ${initial}: no merge produced this commit`] }));
    const merged = mergeFeature(repo, 'feat/a');
    writeActivityLog(repo, [startLine('2026-11-09T09:30:00.000Z', 'MS1', initial), mergeLine('2026-11-09T09:37:32.844Z', 'feat/a', merged), startLine('2026-11-09T09:37:33.000Z', 'MS2', merged.slice(0, 7))]);
    expect(promptness(repo)?.ok).toBe(true);
  });

  it('fails when nothing started a validation', () => {
    const repo = unitRepo();
    writeActivityLog(repo, [mergeLine('2026-11-09T09:37:32.844Z', 'feat/a', mergeFeature(repo, 'feat/a'))]);
    expect(promptness(repo)).toEqual(expect.objectContaining({ ok: false, evidence: ['(no autopilot start-validation line)'] }));
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
