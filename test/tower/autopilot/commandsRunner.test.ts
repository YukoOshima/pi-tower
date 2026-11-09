import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TowerStore } from '../../../src/protocol/index.ts';
import {
  COMMAND_OUTPUT_TAIL_CHARS,
  commandsValidationReport,
  runCommandsValidation,
  runValidationCommands,
  validationCommandEnv,
} from '../../../src/tower/autopilot/commandsRunner.ts';
import { createRepo, createStore, git, isAlive, waitUntil } from './repo.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tower-commands-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function pidFrom(file: string): Promise<number> {
  return Number.parseInt((await readFile(join(dir, file), 'utf8')).trim(), 10);
}

describe('runValidationCommands', () => {
  it('runs every command sequentially with bash -c in the working directory', async () => {
    const run = await runValidationCommands({
      cwd: dir,
      commands: ['echo one > order.txt', 'echo two >> order.txt', 'cat order.txt && pwd'],
    });
    expect(run.passed).toBe(true);
    expect(run.aborted).toBe(false);
    expect(run.results.map((result) => result.exitCode)).toEqual([0, 0, 0]);
    expect(run.results[2]!.output).toBe(`one\ntwo\n${dir}\n`);
  });

  it('keeps running after a failure so one round reports every failing command', async () => {
    const run = await runValidationCommands({ cwd: dir, commands: ['echo boom >&2; exit 3', 'echo after'] });
    expect(run.passed).toBe(false);
    expect(run.results.map((result) => result.exitCode)).toEqual([3, 0]);
    expect(run.results[0]!.output).toBe('boom\n');
  });

  it('never gives a command a terminal and passes an explicit non-interactive environment', async () => {
    const run = await runValidationCommands({
      cwd: dir,
      commands: [
        'if (exec 3</dev/tty) 2>/dev/null; then echo has-tty; else echo no-tty; fi; [ -t 0 ] && echo stdin-tty || echo stdin-not-tty; [ -t 1 ] && echo stdout-tty || echo stdout-not-tty',
        'echo "CI=$CI TERM=$TERM PAGER=$PAGER EXTRA=$EXTRA"',
      ],
      env: { ...validationCommandEnv(), EXTRA: 'yes' },
    });
    expect(run.results[0]!.output).toBe('no-tty\nstdin-not-tty\nstdout-not-tty\n');
    expect(run.results[1]!.output).toBe('CI=1 TERM=dumb PAGER=cat EXTRA=yes\n');
  });

  it('keeps only the last 4000 characters of the output', async () => {
    const run = await runValidationCommands({
      cwd: dir,
      commands: ["head -c 20000 /dev/zero | tr '\\0' x; printf END"],
    });
    const [result] = run.results;
    expect(result!.output).toHaveLength(COMMAND_OUTPUT_TAIL_CHARS);
    expect(result!.output.endsWith('xEND')).toBe(true);
    expect(result!.truncated).toBe(true);
  });

  it('kills the whole process group when a command times out', async () => {
    const started = Date.now();
    const run = await runValidationCommands({
      cwd: dir,
      commands: ['sleep 30 & echo $! > child.pid; wait', 'echo next'],
      timeoutMs: 300,
      killGraceMs: 200,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(run.passed).toBe(false);
    expect(run.results[0]).toMatchObject({ timedOut: true, aborted: false });
    expect(run.results[1]).toMatchObject({ exitCode: 0, output: 'next\n' });
    const pid = await pidFrom('child.pid');
    expect(await waitUntil(() => !isAlive(pid))).toBe(true);
  });

  it('escalates to SIGKILL when the group ignores SIGTERM', async () => {
    const run = await runValidationCommands({
      cwd: dir,
      commands: ["trap '' TERM; echo $$ > shell.pid; while true; do sleep 0.05; done"],
      timeoutMs: 300,
      killGraceMs: 200,
    });
    expect(run.results[0]).toMatchObject({ timedOut: true });
    const pid = await pidFrom('shell.pid');
    expect(await waitUntil(() => !isAlive(pid))).toBe(true);
  });

  it('cleans up background processes a passing command leaves behind', async () => {
    const run = await runValidationCommands({ cwd: dir, commands: ['sleep 30 >/dev/null 2>&1 & echo $! > child.pid'] });
    expect(run.passed).toBe(true);
    const pid = await pidFrom('child.pid');
    expect(await waitUntil(() => !isAlive(pid))).toBe(true);
  });

  it('kills the running command on abort and skips the rest', async () => {
    const controller = new AbortController();
    const pending = runValidationCommands({
      cwd: dir,
      commands: ['echo $$ > shell.pid; sleep 30', 'echo never > never.txt'],
      signal: controller.signal,
      killGraceMs: 200,
    });
    await waitUntil(() => existsSync(join(dir, 'shell.pid')));
    controller.abort();
    const run = await pending;
    expect(run).toMatchObject({ passed: false, aborted: true });
    expect(run.results).toHaveLength(1);
    expect(run.results[0]!.aborted).toBe(true);
    expect(existsSync(join(dir, 'never.txt'))).toBe(false);
    const pid = await pidFrom('shell.pid');
    expect(await waitUntil(() => !isAlive(pid))).toBe(true);
  });

  it('runs nothing when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = await runValidationCommands({ cwd: dir, commands: ['echo never > never.txt'], signal: controller.signal });
    expect(run).toEqual({ passed: false, aborted: true, results: [] });
    expect(existsSync(join(dir, 'never.txt'))).toBe(false);
  });

  it('reports a command that cannot start as failed', async () => {
    const run = await runValidationCommands({ cwd: join(dir, 'missing'), commands: ['true'] });
    expect(run.passed).toBe(false);
    expect(run.results[0]!.error).toBeDefined();
  });
});

describe('commandsValidationReport', () => {
  it('turns failing commands into failures with an output excerpt and lists every command as a check', async () => {
    const run = await runValidationCommands({ cwd: dir, commands: ['echo fine', 'echo broken >&2; exit 2'] });
    const report = commandsValidationReport(run);
    expect(report.verdict).toBe('fail');
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatch(/^`echo broken >&2; exit 2` failed: exit code 2 after \d+\.\ds — last output:\nbroken$/);
    expect(report.checks).toEqual([
      expect.stringMatching(/^`echo fine` — passed \(exit code 0 after/),
      expect.stringMatching(/^`echo broken >&2; exit 2` — failed \(exit code 2 after/),
    ]);
    expect(report.evidence).toContain('```\nfine\n```');
    expect(report.evidence).toContain('```\nbroken\n```');
  });

  it('passes when every command exits 0', async () => {
    const report = commandsValidationReport(await runValidationCommands({ cwd: dir, commands: ['true'] }));
    expect(report).toMatchObject({ verdict: 'pass', failures: [] });
  });
});

describe('runCommandsValidation', () => {
  let repo: string;
  let store: TowerStore;

  beforeEach(async () => {
    repo = await createRepo('tower-commands-repo-');
    store = await createStore(repo);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function validatingMilestone(
    commands: string[],
    acceptanceCommands: string[] = [],
    afterApproval: () => Promise<void> = async () => undefined,
  ): Promise<string> {
    await store.draftObjective({
      title: 'Ship',
      goal: 'ship it',
      definitionOfDone: ['works'],
      acceptanceCommands,
      milestones: [{ title: 'Core', validation: { scrutiny: false, userTesting: false, commands } }],
    });
    await store.plan([{ title: 'Core feature', scope: ['src/core/**'], milestone: 'MS1' }]);
    await store.requestObjectiveApproval();
    await store.approveObjective('auto');
    await afterApproval();
    await store.updateMission('tower', 'M1', { status: 'abandoned' });
    const tip = await git(repo, 'rev-parse', 'main');
    await store.startMilestoneValidation('MS1', tip, {});
    return tip;
  }

  async function validationWorktrees(): Promise<string[]> {
    const list = await git(repo, 'worktree', 'list', '--porcelain');
    return list.split('\n').filter((line) => line.startsWith('worktree ') && line.includes('/val-'));
  }

  it('runs the milestone and acceptance commands at the validated commit, submits a tower round and removes the worktree', async () => {
    const tip = await validatingMilestone(['test -f README.md', 'git rev-parse HEAD'], ['echo accepted']);
    const outcome = await runCommandsValidation(store, { milestoneId: 'MS1', settings: {} });
    expect(outcome).toMatchObject({ status: 'submitted', commit: tip, worktree: 'val-ms1-commands-r1', contractRevision: 0 });
    if (outcome.status !== 'submitted') throw new Error('not submitted');
    expect(outcome.run.results.map((result) => result.command)).toEqual(['test -f README.md', 'git rev-parse HEAD', 'echo accepted']);
    expect(outcome.run.results[1]!.output.trim()).toBe(tip);
    expect(outcome.round).toMatchObject({ kind: 'commands', validator: 'tower', validatedCommit: tip, verdict: 'pass', round: 1 });
    const state = await store.load();
    expect(state.objective?.milestones[0]?.status).toBe('passed');
    expect(await validationWorktrees()).toEqual([]);
    const inbox = await store.readInbox('tower', 50);
    expect(inbox.find((item) => item.action === 'validation-result')).toMatchObject({ from: 'tower', subject: 'validation MS1 commands r1: pass' });
  });

  it('records a failing round with one failure per failing command', async () => {
    await validatingMilestone(['echo ok', 'echo nope >&2; exit 4']);
    const outcome = await runCommandsValidation(store, { milestoneId: 'MS1', settings: {} });
    if (outcome.status !== 'submitted') throw new Error('not submitted');
    expect(outcome.round.verdict).toBe('fail');
    expect(outcome.round.failures).toEqual([expect.stringMatching(/^`echo nope >&2; exit 4` failed: exit code 4 after .*\nnope$/)]);
    const state = await store.load();
    expect(state.objective?.milestones[0]?.status).toBe('failed');
    expect(await validationWorktrees()).toEqual([]);
  });

  it('stamps the round with the contract revision of the command list it ran', async () => {
    await validatingMilestone(['true'], [], async () => {
      await store.updateObjective({ milestones: [{ id: 'MS1', validation: { commands: ['true', 'echo second'] } }] });
      await store.approveObjective('human');
    });
    const outcome = await runCommandsValidation(store, { milestoneId: 'MS1', settings: {} });
    if (outcome.status !== 'submitted') throw new Error('not submitted');
    expect(outcome.contractRevision).toBe(1);
    expect(outcome.round.contractRevision).toBe(1);
    expect(outcome.run.results.map((result) => result.command)).toEqual(['true', 'echo second']);
  });

  it('submits nothing when aborted and still removes the worktree', async () => {
    await validatingMilestone(['sleep 30']);
    const controller = new AbortController();
    const pending = runCommandsValidation(store, { milestoneId: 'MS1', settings: {}, signal: controller.signal });
    await waitUntil(() => existsSync(join(repo, '.tower', 'worktrees', 'val-ms1-commands-r1')));
    setTimeout(() => {
      controller.abort();
    }, 100);
    const outcome = await pending;
    expect(outcome.status).toBe('aborted');
    const state = await store.load();
    expect(state.objective?.milestones[0]?.rounds).toEqual([]);
    expect(await validationWorktrees()).toEqual([]);
  });
});
