import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ACTIVITY_LOG,
  MISSIONS_INDEX,
  STATE_FILE,
  TowerStore,
  canPlanObjective,
} from '../../src/protocol/index.ts';
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

describe('approval after a contract change while blocked or paused', () => {
  async function missionsIndex(): Promise<string> {
    return readFile(store.abs(MISSIONS_INDEX), 'utf8');
  }

  it('refuses auto-approval after a change while paused until a human approves', async () => {
    await approvedObjective();
    await store.pauseObjective('the human wants to rethink');
    const changed = await store.updateObjective({ definitionOfDone: ['works', 'documented'] });
    expect(changed.objective).toMatchObject({
      status: 'awaiting-approval',
      approvalReason: 'contract-changed',
      approvalRequiresHuman: true,
    });
    expect(changed.objective.pausedReason).toBeUndefined();
    expect(await activityLog()).toContain(
      'objective.update id=O1 changes=definitionOfDone status=awaiting-approval approval=human',
    );
    expect(await missionsIndex()).toContain(
      'Status: awaiting-approval · approval: contract-changed · only a human can approve\n',
    );

    const before = await rawState();
    await expect(store.approveObjective('auto')).rejects.toThrow(
      /objective O1 changed its contract while it was blocked or paused, so only a human can approve it — auto-approval stays refused until a human approves/,
    );
    expect(await rawState()).toBe(before);

    const approved = await store.approveObjective('human');
    expect(approved).toMatchObject({ status: 'executing', approvedBy: 'human' });
    expect('approvalRequiresHuman' in (await readState()).objective!).toBe(false);
    expect(await missionsIndex()).not.toContain('only a human can approve');

    await store.updateObjective({ acceptanceCommands: ['npm test'] });
    expect((await readState()).objective).toMatchObject({ status: 'awaiting-approval' });
    expect('approvalRequiresHuman' in (await readState()).objective!).toBe(false);
    expect((await store.approveObjective('auto')).approvedBy).toBe('auto');
  });

  it('keeps requiring a human after a change while blocked, through further changes, a block and a resume', async () => {
    await approvedObjective();
    await store.blockObjective('MS1 cannot converge');
    await store.updateObjective({ goal: 'ship it properly' });
    await store.updateObjective({ definitionOfDone: ['works', 'tested'] });
    expect((await readState()).objective).toMatchObject({ status: 'awaiting-approval', approvalRequiresHuman: true });
    await store.blockObjective('waiting for the human');
    expect((await store.resumeObjective()).status).toBe('planning');
    await store.requestObjectiveApproval();
    await expect(store.approveObjective('auto')).rejects.toThrow(/only a human can approve it/);
    expect((await store.approveObjective('human')).status).toBe('executing');
  });

  it('never requires a human for a change while executing or planning, or before the first approval', async () => {
    await draftWithFeature();
    await store.updateObjective({ goal: 'ship it now' });
    await store.blockObjective('paused planning');
    await store.updateObjective({ definitionOfDone: ['works', 'fast'] });
    expect((await readState()).objective).toMatchObject({ status: 'blocked' });
    await store.resumeObjective();
    await store.requestObjectiveApproval();
    expect((await store.approveObjective('auto')).status).toBe('executing');
    await store.updateObjective({ definitionOfDone: ['works'] });
    expect((await store.approveObjective('auto')).status).toBe('executing');
    expect(await rawState()).not.toContain('approvalRequiresHuman');
  });
});

describe('contract revisions on roster entries and validation results', () => {
  function validator(name: string, commit: string, extra: Readonly<Record<string, unknown>> = {}) {
    return {
      name,
      agentId: `agent-${name}`,
      kind: 'validator' as const,
      milestoneId: 'MS1',
      validationKind: 'scrutiny' as const,
      validatedCommit: commit,
      spawnedAt: SPAWNED_AT,
      ...extra,
    };
  }

  it('requires the briefed revision from both registration paths once the contract changed', async () => {
    const tip = await validatingMilestone();
    await store.updateObjective({ definitionOfDone: ['works', 'documented'] });
    await store.approveObjective('human');
    const before = await rawState();
    const missing =
      /validator "v-1" must state the contract revision it was briefed under \(contractRevision\) — objective O1 is at revision 1, and a round is stamped with the contract its validator checked/;
    await expect(store.registerAgent(validator('v-1', tip))).rejects.toThrow(missing);
    await expect(store.registerSpawnedAgent(validator('v-1', tip))).rejects.toThrow(missing);
    await expect(store.registerSpawnedAgent(validator('v-1', tip, { contractRevision: 2 }))).rejects.toThrow(
      /briefed under contract revision 2, but objective O1 is at revision 1/,
    );
    expect(await rawState()).toBe(before);

    await store.registerSpawnedAgent(validator('v-1', tip, { contractRevision: 1 }));
    expect((await readState()).roster.agents.at(-1)).toMatchObject({ name: 'v-1', contractRevision: 1 });
  });

  it('type-checks a given revision even before the contract changed, and omits revision 0', async () => {
    const tip = await validatingMilestone();
    const before = await rawState();
    for (const [bad, shown] of [
      ['0', '"0"'],
      [1.5, '1.5'],
      [-1, '-1'],
      [null, 'null'],
    ] as const) {
      await expect(store.registerAgent(validator('v-bad', tip, { contractRevision: bad }))).rejects.toThrow(
        `validator "v-bad" contractRevision must be the non-negative integer revision it was briefed under, got ${shown}`,
      );
    }
    expect(await rawState()).toBe(before);

    await store.registerAgent(validator('v-zero', tip, { contractRevision: 0 }));
    await store.registerAgent({ ...validator('v-none', tip), validationKind: 'user-testing' });
    expect(await rawState()).not.toContain('contractRevision');
  });

  it('never keeps a revision on worker or reviewer entries', async () => {
    await draftWithFeature();
    await store.updateObjective({ goal: 'ship it twice' });
    await store.registerSpawnedAgent(
      { name: 'w-1', agentId: 'agent-w-1', kind: 'worker', missionId: 'M1', contractRevision: 1, spawnedAt: SPAWNED_AT },
      { id: 'M1', owner: 'w-1' },
    );
    await store.registerAgent({ name: 'w-2', agentId: 'agent-w-2', kind: 'worker', missionId: 'M1', contractRevision: 1, spawnedAt: SPAWNED_AT });
    await store.registerAgent({ name: 'r-1', agentId: 'agent-r-1', kind: 'reviewer', reviewTarget: 'feat/core-feature', contractRevision: 1, spawnedAt: SPAWNED_AT });
    const state = await readState();
    expect(state.objective!.contractRevision).toBe(1);
    expect(state.roster.agents.map((agent) => [agent.name, 'contractRevision' in agent])).toEqual([
      ['w-1', false],
      ['w-2', false],
      ['r-1', false],
    ]);
  });

  it('says a round stamped under an older revision does not decide the milestone', async () => {
    const tip = await validatingMilestone();
    await registerValidator('v-old', 'scrutiny', tip);
    await registerValidator('v-old-qa', 'user-testing', tip);
    await store.updateObjective({ definitionOfDone: ['works', 'documented'] });
    const stale =
      'This round was recorded but does not decide the milestone: it checked contract revision 0, and objective O1 is now at revision 1 — only a round under the current contract counts.';

    const passed = await report('v-old', 'scrutiny', 'pass');
    expect(passed.milestone.status).toBe('validating');
    expect(passed.message?.item.body).toContain(stale);

    const failed = await report('v-old-qa', 'user-testing', 'fail');
    expect(failed.milestone.status).toBe('validating');
    expect(failed.message?.item.body).toContain(`${stale}\n\nFailures:\n- user-testing broke`);
    expect(failed.message?.item.subject).toBe('validation MS1 user-testing r1: fail (1 failure)');

    await store.approveObjective('human');
    await registerValidator('v-new', 'scrutiny', tip, 1);
    const current = await report('v-new', 'scrutiny', 'pass');
    expect(current.message?.item.body).not.toContain('does not decide the milestone');
  });

  it('tells the worker to finish with TowerComplete after a rebase conflict', async () => {
    const [mission] = await store.plan([{ title: 'Shared work', scope: ['src/x/**'] }]);
    await store.addWorktree(mission!.worktree, mission!.branch, 'main');
    const worktree = store.abs(join('.tower/worktrees', mission!.worktree));
    await commitFile(worktree, 'src/x/shared.ts', 'from branch\n', 'branch work');
    await store.updateMission('tower', mission!.id, { status: 'completed' }, { silent: true });
    await commitFile(repo, 'src/x/shared.ts', 'from base\n', 'base touches the same file');

    expect((await store.rebaseMission('tower', mission!.id)).status).toBe('conflict');

    const blocker = (await readState()).missions[0]!.blockers.join('\n');
    expect(blocker).toMatch(/^tower rebase onto main conflicted in: src\/x\/shared\.ts — /);
    expect(blocker).toContain(
      'Re-run your tests, then clear this blocker (TowerMission clear_blockers) and finish with TowerComplete, which requests the fresh review — a worker-run rebase is not covered by the clean-rebase waiver',
    );
    expect(blocker).not.toContain('TowerSend');
  });
});

describe('refreshing objective limits', () => {
  it('clears an optional limit given as null and keeps one left out', async () => {
    await approvedObjective();
    await store.updateObjective({ limits: { maxWallTimeMs: 60_000, maxCostUsd: 5 } });
    const kept = await store.updateObjective({ limits: { maxValidationRounds: 4 } });
    expect(kept.objective.limits).toEqual({
      maxValidationRounds: 4,
      maxFeatureAttempts: 3,
      maxWallTimeMs: 60_000,
      maxCostUsd: 5,
    });

    const cleared = await store.updateObjective({ limits: { maxWallTimeMs: null, maxCostUsd: null } });
    expect(cleared.changes).toEqual(['limits']);
    expect(cleared.objective.limits).toEqual({ maxValidationRounds: 4, maxFeatureAttempts: 3 });
    expect(cleared.objective.status).toBe('executing');
    expect((await readState()).objective!.limits).toEqual({ maxValidationRounds: 4, maxFeatureAttempts: 3 });

    const before = await rawState();
    expect((await store.updateObjective({ limits: { maxCostUsd: null } })).changes).toEqual([]);
    expect(await rawState()).toBe(before);
    await expect(store.updateObjective({ limits: { maxCostUsd: 0 } })).rejects.toThrow(
      /maxCostUsd must be a positive number, got 0/,
    );
  });
});
