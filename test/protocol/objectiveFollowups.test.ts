import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ACTIVITY_LOG, STATE_FILE, TowerStore, canPlanObjective } from '../../src/protocol/index.ts';
import type { TowerObjective, TowerState } from '../../src/protocol/index.ts';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function commitFile(cwd: string, rel: string, content: string, message: string): Promise<void> {
  const abs = join(cwd, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
  await git(cwd, 'add', rel);
  await git(cwd, 'commit', '-m', message);
}

let repo: string;
let store: TowerStore;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'tower-objective-followups-'));
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'tower-test@example.com');
  await git(repo, 'config', 'user.name', 'Tower Test');
  await commitFile(repo, 'README.md', '# fixture\n', 'initial');
  store = new TowerStore(repo);
  await store.init();
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function rawState(): Promise<string> {
  return readFile(store.abs(STATE_FILE), 'utf8');
}

async function readState(): Promise<TowerState> {
  return JSON.parse(await rawState()) as TowerState;
}

async function mutateState(fn: (state: TowerState) => void): Promise<void> {
  const state = await readState();
  fn(state);
  await writeFile(store.abs(STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

async function activityLog(): Promise<string> {
  return readFile(store.abs(ACTIVITY_LOG), 'utf8');
}

async function draftWithFeature(): Promise<void> {
  await store.plan([{ title: 'Core feature', scope: ['src/core/**'] }]);
  await store.draftObjective({
    title: 'Ship',
    goal: 'ship it',
    definitionOfDone: ['works'],
    milestones: [{ title: 'Core' }, { title: 'Polish' }],
  });
  await mutateState((state) => {
    state.missions[0]!.milestone = 'MS1';
  });
}

async function approvedObjective(): Promise<void> {
  await draftWithFeature();
  await store.requestObjectiveApproval();
  await store.approveObjective('human');
}

describe('objective mode', () => {
  it('is never written until it is set, then persists without rewriting an unchanged mode', async () => {
    await draftWithFeature();
    await store.updateMission('tower', 'M1', { note: 'v0.1 style bookkeeping' });
    expect(await rawState()).not.toContain('objectiveMode');

    await store.setObjectiveMode('headless');
    expect((await readState()).objectiveMode).toBe('headless');
    expect(await activityLog()).toMatch(/ tower objective\.mode mode=headless\n$/);

    const before = await rawState();
    await store.setObjectiveMode('headless');
    expect(await rawState()).toBe(before);

    await store.setObjectiveMode('interactive');
    expect((await readState()).objectiveMode).toBe('interactive');
    expect(await activityLog()).toMatch(/ tower objective\.mode mode=interactive from=headless\n$/);
  });

  it('refuses an unknown mode', async () => {
    const before = await rawState();
    await expect(store.setObjectiveMode('batch' as 'headless')).rejects.toThrow(
      /objective mode must be interactive \| headless, got "batch"/,
    );
    expect(await rawState()).toBe(before);
  });

  it('changes only while no objective is open or the open one is still planning', async () => {
    await store.setObjectiveMode('interactive');
    await draftWithFeature();
    await store.setObjectiveMode('headless');
    await store.requestObjectiveApproval();
    const before = await rawState();
    await expect(store.setObjectiveMode('interactive')).rejects.toThrow(
      /objective O1 is awaiting-approval — the objective mode is chosen while an objective is planned/,
    );
    await store.approveObjective('human');
    await expect(store.setObjectiveMode('interactive')).rejects.toThrow(/objective O1 is executing/);
    await store.pauseObjective('lunch');
    await expect(store.setObjectiveMode('interactive')).rejects.toThrow(/objective O1 is paused/);
    expect((await readState()).objectiveMode).toBe('headless');
    await store.blockObjective('the human changed their mind');
    await store.setObjectiveMode('interactive');
    expect((await readState()).objectiveMode).toBe('interactive');
    expect(before).toContain('"objectiveMode": "headless"');
  });

  it('is written by no other objective step', async () => {
    await approvedObjective();
    await store.updateObjective({ notes: ['n'], limits: { maxCostUsd: 3 } });
    await store.pauseObjective('p');
    await store.resumeObjective();
    await store.blockObjective('b');
    expect(await rawState()).not.toContain('objectiveMode');
  });

  it('shares the planning rule through canPlanObjective', () => {
    const objective = (status: TowerObjective['status']) => ({ status }) as TowerObjective;
    expect(canPlanObjective(undefined)).toBe(true);
    expect(
      (['planning', 'awaiting-approval', 'executing', 'paused', 'completed', 'blocked'] as const).map((status) =>
        canPlanObjective(objective(status)),
      ),
    ).toEqual([true, false, false, false, true, true]);
  });
});

const SPAWNED_AT = '2026-11-09T00:00:00.000Z';

async function registerValidator(
  name: string,
  kind: 'scrutiny' | 'user-testing',
  commit: string,
  contractRevision?: number,
): Promise<void> {
  await store.registerAgent({
    name,
    agentId: `agent-${name}`,
    kind: 'validator',
    milestoneId: 'MS1',
    validationKind: kind,
    validatedCommit: commit,
    ...(contractRevision === undefined ? {} : { contractRevision }),
    spawnedAt: SPAWNED_AT,
  });
}

async function report(name: string, kind: 'scrutiny' | 'user-testing', verdict: 'pass' | 'fail') {
  return store.submitValidation(name, {
    milestone: 'MS1',
    kind,
    verdict,
    ...(verdict === 'fail' ? { failures: [`${kind} broke`] } : {}),
  });
}

async function validatingMilestone(): Promise<string> {
  await approvedObjective();
  await mutateState((state) => {
    state.missions[0]!.status = 'merged';
  });
  const tip = await git(repo, 'rev-parse', 'main');
  await store.startMilestoneValidation('MS1', tip);
  return tip;
}

describe('starting a validation whose required kinds already passed', () => {
  it('passes a failed milestone at once when the kind that failed is no longer required', async () => {
    const tip = await validatingMilestone();
    await registerValidator('v-scrutiny', 'scrutiny', tip);
    expect((await report('v-scrutiny', 'scrutiny', 'pass')).milestone.status).toBe('validating');
    await registerValidator('v-qa', 'user-testing', tip);
    expect((await report('v-qa', 'user-testing', 'fail')).milestone.status).toBe('failed');
    await expect(store.startMilestoneValidation('MS1', tip)).rejects.toThrow(/already failed user-testing r1/);

    const started = await store.startMilestoneValidation('MS1', tip, { skipUserTesting: true });

    expect(started.requiredKinds).toEqual(['scrutiny']);
    expect(started.milestone).toMatchObject({ status: 'passed', validationCommit: tip, passedAt: expect.any(String) });
    expect((await readState()).objective!.milestones[0]).toMatchObject({ status: 'passed', validationCommit: tip });
    expect(await activityLog()).toContain(
      `milestone.validate objective=O1 milestone=MS1 commit=${tip.slice(0, 7)} kinds=scrutiny status=passed`,
    );
    expect(await store.activateNextMilestone()).toMatchObject({ id: 'MS2', status: 'active' });
  });

  it('re-derives a validating milestone whose remaining kind passed when the other is switched off', async () => {
    const tip = await validatingMilestone();
    await registerValidator('v-scrutiny', 'scrutiny', tip);
    await report('v-scrutiny', 'scrutiny', 'pass');

    const restarted = await store.startMilestoneValidation('MS1', tip);
    expect(restarted.milestone.status).toBe('validating');

    const derived = await store.startMilestoneValidation('MS1', tip, { skipUserTesting: true });
    expect(derived.milestone.status).toBe('passed');
  });

  it('does not count passes stamped on another commit or under an older contract revision', async () => {
    const tip = await validatingMilestone();
    await registerValidator('v-scrutiny', 'scrutiny', tip);
    await report('v-scrutiny', 'scrutiny', 'pass');
    await store.updateObjective({ definitionOfDone: ['works', 'documented'] });
    await store.approveObjective('human');

    const sameTip = await store.startMilestoneValidation('MS1', tip, { skipUserTesting: true });
    expect(sameTip.milestone.status).toBe('validating');

    await commitFile(repo, 'next.txt', 'next\n', 'base moved');
    const next = await git(repo, 'rev-parse', 'main');
    await registerValidator('v-scrutiny-2', 'scrutiny', tip, 1);
    await report('v-scrutiny-2', 'scrutiny', 'pass');
    const moved = await store.startMilestoneValidation('MS1', next, { skipUserTesting: true });
    expect(moved.milestone).toMatchObject({ status: 'validating', validationCommit: next });
  });
});
