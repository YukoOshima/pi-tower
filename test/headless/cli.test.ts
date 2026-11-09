import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { HEADLESS_USAGE } from '../../src/headless/args.ts';
import type { FakeCommand, FakeScenario } from './fakePi.ts';
import { CHECKOUT, createWorld, feature, isAlive, milestone, objective, type FakeWorld, type Json } from './harness.ts';

const BIN = join(CHECKOUT, 'bin', 'pi-tower.js');
const VERSION = (JSON.parse(readFileSync(join(CHECKOUT, 'package.json'), 'utf8')) as { version: string }).version;
const FEATURES = [feature('M1', 'MS1'), feature('M2', 'MS2')];

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface CliRun {
  readonly pid: number | undefined;
  readonly done: Promise<CliResult>;
  stdout(): string;
  kill(signal: NodeJS.Signals): void;
}

const worlds: FakeWorld[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const world of worlds.splice(0)) world.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function startCli(args: readonly string[], options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly bin?: string } = {}): CliRun {
  const child = spawn(process.execPath, [options.bin ?? BIN, ...args], { cwd: options.cwd ?? CHECKOUT, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  return {
    pid: child.pid,
    done: new Promise((resolve) => {
      child.on('close', (code) => {
        resolve({ code, stdout, stderr });
      });
    }),
    stdout: () => stdout,
    kill: (signal) => {
      child.kill(signal);
    },
  };
}

function cli(args: readonly string[], options: Parameters<typeof startCli>[1] = {}): Promise<CliResult> {
  return startCli(args, options).done;
}

function world(): FakeWorld {
  const created = createWorld();
  worlds.push(created);
  return created;
}

function homeEnv(fake: FakeWorld): NodeJS.ProcessEnv {
  const home = join(fake.dir, 'home');
  mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.PI_CODING_AGENT_DIR;
  return env;
}

function runArgs(fake: FakeWorld, scenario: FakeScenario, extra: readonly string[] = []): string[] {
  return ['run', '-f', fake.objectiveFile, '--cwd', fake.repo, '--pi', fake.piBin, ...extra, '--', ...fake.scenario(scenario)];
}

function stage(status: string, ms1: string, ms2: string, extra: Json = {}): Json {
  return objective(status, { milestones: [milestone('MS1', ms1, 1), milestone('MS2', ms2, 2)], ...extra });
}

const TOWER_ON: FakeCommand = { match: '/tower on', before: [{ missions: [] }, { notify: { text: 'Tower mode: ON' } }] };

const DRAFT: FakeCommand = {
  match: '/tower objective --headless @',
  after: [
    { delayMs: 50, objective: stage('planning', 'pending', 'pending') },
    { delayMs: 100, missions: FEATURES, objective: stage('awaiting-approval', 'pending', 'pending') },
  ],
};

function approve(...after: Json[]): FakeCommand {
  return {
    match: '/tower approve',
    before: [{ objective: stage('executing', 'active', 'pending') }],
    after: after.map((next) => ({ delayMs: 100, objective: next })),
  };
}

async function waitUntil(check: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function fakePid(fake: FakeWorld): number {
  const start = fake.log().find((entry) => entry.kind === 'start');
  return Number(start?.pid);
}

describe('pi-tower CLI (bin/pi-tower.js)', () => {
  it('prints the usage with --help and the package version with --version', async () => {
    const help = await cli(['--help']);
    expect(help).toEqual({ code: 0, stdout: `${HEADLESS_USAGE}\n`, stderr: '' });
    expect(await cli(['--version'])).toEqual({ code: 0, stdout: `${VERSION}\n`, stderr: '' });
  });

  it('exits 4 with a clear message on usage errors and unusable inputs', async () => {
    expect(await cli(['run', '--timeout', 'soon', '-f', 'x.md'])).toEqual({
      code: 4,
      stdout: '',
      stderr: 'pi-tower: --timeout must be a positive whole number of milliseconds, got "soon"\nRun pi-tower --help for usage.\n',
    });
    const fake = world();
    expect(await cli(['run', '-f', join(fake.dir, 'missing.md'), '--cwd', fake.repo])).toMatchObject({ code: 4, stderr: `pi-tower: objective file ${join(fake.dir, 'missing.md')} does not exist\n` });
    expect(await cli(['run', '-f', fake.objectiveFile, '--cwd', join(fake.dir, 'nowhere')])).toMatchObject({ code: 4, stderr: `pi-tower: --cwd ${join(fake.dir, 'nowhere')} does not exist\n` });
    writeFileSync(join(fake.dir, 'empty.md'), '  \n');
    expect(await cli(['run', '-f', 'empty.md', '--cwd', 'repo'], { cwd: fake.dir })).toMatchObject({ code: 4, stderr: `pi-tower: objective file ${join(fake.dir, 'empty.md')} is empty\n` });
  });

  it('runs an objective to completion with --auto-approve (exit 0) without touching ~/.pi', { timeout: 20_000 }, async () => {
    const fake = world();
    const env = homeEnv(fake);
    const result = await cli(runArgs(fake, { commands: [TOWER_ON, DRAFT, approve(stage('executing', 'passed', 'active'), stage('completed', 'passed', 'passed'))] }, ['--auto-approve', '--timeout', '15000']), { env });
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Plan for O1 "Ship the widget" (awaiting-approval):');
    expect(result.stdout).toMatch(/\] auto-approved the plan of O1 \(--auto-approve\)\n/);
    expect(result.stdout).toMatch(/\] O1 completed — MS1 passed · MS2 passed — features 0\/2 done\n/);
    expect(result.stdout).toMatch(/\] objective O1 "Ship the widget" completed\n$/);
    expect(fake.commands()).toEqual(['/tower on', `/tower objective --headless @${fake.objectiveFile}`, '/tower approve']);
    const start = fake.log().find((entry) => entry.kind === 'start');
    expect(start?.argv).toEqual(['--mode', 'rpc', ...fake.scenario({ commands: [] })]);
    expect(start?.cwd).toBe(fake.repo);
    expect(fake.log().some((entry) => entry.kind === 'stdin-end')).toBe(true);
    expect(existsSync(join(String(env.HOME), '.pi'))).toBe(false);
  });

  it('prints the plan and exits 3 when approval is missing', { timeout: 20_000 }, async () => {
    const fake = world();
    const result = await cli(runArgs(fake, { commands: [TOWER_ON, DRAFT, approve(stage('completed', 'passed', 'passed'))] }));
    expect(result.code).toBe(3);
    expect(result.stdout).toContain('  estimated runs: 6 (features + 2 × milestones)');
    expect(result.stderr).toMatch(/objective O1 needs approval — re-run with --auto-approve/);
    expect(fake.commands()).toEqual(['/tower on', `/tower objective --headless @${fake.objectiveFile}`]);
    expect(fake.state()?.objective).toMatchObject({ status: 'awaiting-approval' });
  });

  it('continues the open objective on a re-run with --auto-approve', { timeout: 20_000 }, async () => {
    const fake = world();
    fake.writeState({ version: 1, missions: FEATURES, objective: stage('awaiting-approval', 'pending', 'pending') });
    const result = await cli(runArgs(fake, { commands: [TOWER_ON, DRAFT, approve(stage('completed', 'passed', 'passed'))] }, ['--auto-approve']));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('continuing existing objective O1 "Ship the widget" (status awaiting-approval) — the -f file is not re-sent');
    expect(fake.commands()).toEqual(['/tower on', '/tower approve']);
  });

  it.each([
    ['blocked', stage('blocked', 'blocked', 'pending', { blockedReason: 'MS1 scrutiny failed 3 rounds' }), 'objective O1 is blocked: MS1 scrutiny failed 3 rounds'],
    ['paused', stage('paused', 'active', 'pending', { pausedReason: 'maxWallTimeMs reached' }), 'objective O1 is paused: maxWallTimeMs reached — resume it with /tower resume'],
  ])('exits 1 when the objective ends %s', { timeout: 20_000 }, async (_status, terminal, message) => {
    const fake = world();
    const result = await cli(runArgs(fake, { commands: [TOWER_ON, DRAFT, approve(terminal)] }, ['--auto-approve']));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it('exits 1 with the pi stderr tail when pi crashes after the run started', { timeout: 20_000 }, async () => {
    const fake = world();
    const crash: FakeCommand = { match: '/tower approve', before: [{ objective: stage('executing', 'active', 'pending') }], after: [{ delayMs: 100, stderr: 'FATAL: worker pool exploded\n', exit: 9 }] };
    const result = await cli(runArgs(fake, { commands: [TOWER_ON, DRAFT, crash] }, ['--auto-approve']));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('pi exited (exited with code 9) before objective O1 finished (it was executing)');
    expect(result.stderr).toContain('  FATAL: worker pool exploded');
  });

  it('exits 2 when the timeout elapses', { timeout: 20_000 }, async () => {
    const fake = world();
    const result = await cli(runArgs(fake, { commands: [TOWER_ON, DRAFT, approve()] }, ['--auto-approve', '--timeout', '2500']));
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/timed out after 2500ms \(objective O1 was executing\)\n$/);
    expect(isAlive(fakePid(fake))).toBe(false);
  });

  it.each([
    ['the pi-tower extension is not loaded', { commands: [] }, 'pi did not run /tower on as a pi-tower command (the prompt was started)'],
    ['pi crashes during startup', { stderr: 'Error: cannot find module x\n', startupExit: 1 }, 'pi did not start (FAKE_PI): pi is gone (exited with code 1)'],
    ['/tower on fails', { commands: [{ match: '/tower on', before: [{ notify: { level: 'error', text: 'Tower mode could not be enabled — not a git repository.' } }] }] }, '/tower on failed: Tower mode could not be enabled — not a git repository.'],
  ] as const)('exits 4 when %s', { timeout: 20_000 }, async (_label, scenario, message) => {
    const fake = world();
    const result = await cli(runArgs(fake, scenario));
    expect(result.code).toBe(4);
    expect(result.stderr).toContain(message.replace('FAKE_PI', fake.piBin));
  });

  it('exits 4 when the pi executable does not exist', async () => {
    const fake = world();
    const result = await cli(['run', '-f', fake.objectiveFile, '--cwd', fake.repo, '--pi', join(fake.dir, 'no-such-pi')]);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain(`pi did not start (${join(fake.dir, 'no-such-pi')}): pi is gone (spawn ${join(fake.dir, 'no-such-pi')} ENOENT) — is pi installed? Point --pi at the pi executable`);
  });

  it.each([
    ['SIGTERM', 143],
    ['SIGINT', 130],
  ] as const)('kills the pi child and exits %s → %i on a signal', { timeout: 20_000 }, async (signal, expected) => {
    const fake = world();
    const run = startCli(runArgs(fake, { commands: [TOWER_ON, DRAFT, approve()] }, ['--auto-approve']));
    await waitUntil(() => run.stdout().includes('] O1 executing'), 'the runner to see the objective executing');
    const pid = fakePid(fake);
    expect(isAlive(pid)).toBe(true);
    run.kill(signal);
    const result = await run.done;
    expect(result.code).toBe(expected);
    expect(result.stderr).toContain(`received ${signal} — stopping pi`);
    expect(result.stderr).toContain(`interrupted by ${signal}; pi was stopped (objective O1 was executing)`);
    expect(fake.log().some((entry) => entry.kind === 'signal' && entry.signal === 'SIGTERM')).toBe(true);
    expect(isAlive(pid)).toBe(false);
  });

  it('runs from an installed copy under node_modules, where Node refuses to strip types natively', { timeout: 20_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-tower-installed-'));
    dirs.push(root);
    const installed = join(root, 'node_modules', 'pi-tower');
    for (const entry of ['bin', 'src', 'package.json']) cpSync(join(CHECKOUT, entry), join(installed, entry), { recursive: true });
    const bin = join(installed, 'bin', 'pi-tower.js');
    expect(await cli(['--version'], { bin, cwd: root })).toEqual({ code: 0, stdout: `${VERSION}\n`, stderr: '' });
    const fake = world();
    const result = await cli(runArgs(fake, { commands: [TOWER_ON, DRAFT, approve(stage('completed', 'passed', 'passed'))] }, ['--auto-approve']), { bin, cwd: root });
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  });
});
