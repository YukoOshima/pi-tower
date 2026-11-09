import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ACTIVITY_LOG,
  STATE_FILE,
  TowerObjectiveCompletionError,
  TowerProtocolError,
  TowerStore,
} from '../../src/protocol/index.ts';
import type { TowerState } from '../../src/protocol/index.ts';

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
  repo = await mkdtemp(join(tmpdir(), 'tower-objective-test-'));
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

async function readState(): Promise<TowerState> {
  return JSON.parse(await readFile(store.abs(STATE_FILE), 'utf8')) as TowerState;
}

async function writeState(state: TowerState): Promise<void> {
  await writeFile(store.abs(STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

async function mutateState(fn: (state: TowerState) => void): Promise<void> {
  const state = await readState();
  fn(state);
  await writeState(state);
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

describe('objective lifecycle', () => {
  it('drafts a planning objective with pending milestones and logs it', async () => {
    const objective = await store.draftObjective({
      title: 'Ship',
      goal: 'ship it',
      milestones: [{ title: 'Core' }],
    });
    expect(objective).toMatchObject({ id: 'O1', status: 'planning' });
    const state = await readState();
    expect(state.objective?.milestones).toEqual([
      {
        id: 'MS1',
        title: 'Core',
        order: 1,
        validation: { scrutiny: true, userTesting: true, commands: [] },
        status: 'pending',
        rounds: [],
      },
    ]);
    expect(state.objectiveHistory).toBeUndefined();
    expect(await activityLog()).toMatch(/ tower objective\.draft id=O1 milestones=MS1 ref=\.tower\/comms\/MISSIONS\.md\n$/);
  });

  it('refuses a second draft while the objective is open and archives a terminal one', async () => {
    await store.draftObjective({ title: 'First', milestones: [{ title: 'A' }, { title: 'B' }] });
    await expect(store.draftObjective({ title: 'Second' })).rejects.toThrow(/O1 is still planning/);
    await store.blockObjective('the human changed their mind');
    const second = await store.draftObjective({ title: 'Second', milestones: [{ title: 'C' }] });
    expect(second.id).toBe('O2');
    expect(second.milestones.map((milestone) => milestone.id)).toEqual(['MS3']);
    const state = await readState();
    expect(state.objective?.id).toBe('O2');
    expect(state.objectiveHistory?.map((objective) => [objective.id, objective.status])).toEqual([['O1', 'blocked']]);
    expect(await activityLog()).toContain('objective.draft id=O2 milestones=MS3 archived=O1');
  });

  it('refuses every lifecycle step without an objective', async () => {
    for (const step of [
      () => store.updateObjective({ goal: 'x' }),
      () => store.requestObjectiveApproval(),
      () => store.approveObjective('human'),
      () => store.pauseObjective('x'),
      () => store.resumeObjective(),
      () => store.blockObjective('x'),
      () => store.completeObjective(),
    ]) {
      await expect(step()).rejects.toThrow(TowerProtocolError);
    }
  });

  it('checks the approval preconditions before requesting approval', async () => {
    await store.draftObjective({ title: 'Ship', milestones: [{ title: 'Core' }] });
    await expect(store.requestObjectiveApproval()).rejects.toThrow(
      /cannot request approval — the goal is empty; the definition of done has no items; the first milestone MS1 "Core" has no build feature/,
    );
    expect((await readState()).objective?.status).toBe('planning');
  });

  it('requests approval with a run estimate and lets only an awaiting objective be approved', async () => {
    await draftWithFeature();
    await expect(store.approveObjective('human')).rejects.toThrow(/only an objective awaiting approval/);
    const requested = await store.requestObjectiveApproval();
    expect(requested.objective.status).toBe('awaiting-approval');
    expect(requested.estimatedRuns).toBe(5);
    await expect(store.approveObjective('orchestrator' as 'human')).rejects.toThrow(/"human" or "auto"/);
    const approved = await store.approveObjective('auto');
    expect(approved).toMatchObject({ status: 'executing', approvedBy: 'auto' });
    expect(approved.startedAt).toBe(approved.approvedAt);
    expect(approved.milestones.map((milestone) => milestone.status)).toEqual(['active', 'pending']);
    expect(approved.milestones[0]!.startedAt).toBe(approved.approvedAt);
    const log = await activityLog();
    expect(log).toContain('objective.request-approval id=O1 estimated_runs=5');
    expect(log).toContain('objective.approve id=O1 by=auto activated=MS1');
  });

  it('re-requests approval after a contract change and keeps the first start time', async () => {
    await approvedObjective();
    const startedAt = (await readState()).objective!.startedAt;
    const appended = await store.updateObjective({ milestones: [{ title: 'Docs' }], notes: ['assumption'] });
    expect(appended.contractChanged).toBe(false);
    expect(appended.objective.status).toBe('executing');
    const changed = await store.updateObjective({ definitionOfDone: ['works', 'documented'] });
    expect(changed.objective).toMatchObject({ status: 'awaiting-approval', approvalReason: 'contract-changed' });
    expect(await activityLog()).toContain(
      'objective.update id=O1 changes=definitionOfDone status=awaiting-approval',
    );
    const reapproved = await store.approveObjective('human');
    expect(reapproved.startedAt).toBe(startedAt);
    expect(reapproved.approvalReason).toBeUndefined();
    expect(reapproved.milestones.map((milestone) => milestone.status)).toEqual(['active', 'pending', 'pending']);
  });

  it('skips writing an update that changes nothing', async () => {
    await draftWithFeature();
    const before = await readFile(store.abs(STATE_FILE), 'utf8');
    const result = await store.updateObjective({ goal: 'ship it' });
    expect(result.changes).toEqual([]);
    expect(await readFile(store.abs(STATE_FILE), 'utf8')).toBe(before);
  });

  it('pauses and resumes an executing objective and resets the stall counter', async () => {
    await approvedObjective();
    await expect(store.resumeObjective()).rejects.toThrow(/only a paused or blocked objective/);
    await mutateState((state) => {
      state.objective!.autopilot = { stallWakes: 2, wakeKeys: ['stalled:O1:1'], progressKey: 'k' };
    });
    const paused = await store.pauseObjective('budget: maxCostUsd reached');
    expect(paused).toMatchObject({ status: 'paused', pausedReason: 'budget: maxCostUsd reached' });
    await expect(store.pauseObjective('again')).rejects.toThrow(/only an executing objective can be paused/);
    const resumed = await store.resumeObjective();
    expect(resumed.status).toBe('executing');
    expect(resumed.pausedReason).toBeUndefined();
    expect(resumed.autopilot).toMatchObject({ stallWakes: 0, wakeKeys: ['stalled:O1:1'], progressKey: 'k' });
    expect(resumed.autopilot?.progressAt).toEqual(expect.any(String));
    const log = await activityLog();
    expect(log).toContain('objective.pause id=O1 reason=budget: maxCostUsd reached');
    expect(log).toContain('objective.resume id=O1 from=paused status=executing');
  });

  it('defaults a blank pause reason', async () => {
    await approvedObjective();
    expect((await store.pauseObjective('  ')).pausedReason).toBe('paused on request');
  });

  it('resumes a blocked objective by turning blocked milestones back into failed ones', async () => {
    await approvedObjective();
    await mutateState((state) => {
      state.objective!.milestones[0]!.status = 'blocked';
    });
    await expect(store.blockObjective(' ')).rejects.toThrow(/needs a reason/);
    const blocked = await store.blockObjective('MS1 scrutiny failed 3 rounds');
    expect(blocked).toMatchObject({ status: 'blocked', blockedReason: 'MS1 scrutiny failed 3 rounds' });
    await expect(store.blockObjective('again')).rejects.toThrow(/already blocked/);
    const resumed = await store.resumeObjective();
    expect(resumed.status).toBe('executing');
    expect(resumed.blockedReason).toBeUndefined();
    expect(resumed.milestones.map((milestone) => milestone.status)).toEqual(['failed', 'pending']);
    expect(await activityLog()).toContain('objective.resume id=O1 from=blocked status=executing reopened=MS1');
  });

  it('resumes an objective blocked before approval into planning', async () => {
    await draftWithFeature();
    await store.blockObjective('waiting for the human');
    expect((await store.resumeObjective()).status).toBe('planning');
  });

  it('refuses completion with the evaluateObjective block codes', async () => {
    await approvedObjective();
    const error = await store.completeObjective().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TowerObjectiveCompletionError);
    expect(error).toBeInstanceOf(TowerProtocolError);
    expect((error as TowerObjectiveCompletionError).blocks.map((block) => block.code)).toEqual([
      'milestone-not-passed',
      'milestone-not-passed',
      'open-feature',
    ]);
    expect((error as Error).message).toMatch(/^objective O1 cannot complete yet — milestone-not-passed: /);
    expect((await readState()).objective?.status).toBe('executing');
  });

  it('completes once every milestone passed on the current base tip', async () => {
    await approvedObjective();
    const tip = await git(repo, 'rev-parse', 'main');
    await mutateState((state) => {
      state.missions[0]!.status = 'merged';
      for (const milestone of state.objective!.milestones) {
        milestone.status = 'passed';
        milestone.validationCommit = tip;
        milestone.validation = { scrutiny: false, userTesting: false, commands: [] };
      }
    });
    expect((await store.objectiveEvaluation()).completion).toEqual({ ready: true, blocks: [] });
    await commitFile(repo, 'later.txt', 'later\n', 'base moved');
    await expect(store.completeObjective()).rejects.toThrow(/final-validation-stale/);
    const newTip = await git(repo, 'rev-parse', 'main');
    await mutateState((state) => {
      state.objective!.milestones[1]!.validationCommit = newTip;
    });
    const completed = await store.completeObjective();
    expect(completed.status).toBe('completed');
    expect(completed.completedAt).toEqual(expect.any(String));
    expect(await activityLog()).toContain(`objective.complete id=O1 base_tip=${newTip.slice(0, 7)}`);
    await expect(store.updateObjective({ notes: ['late'] })).rejects.toThrow(/completed/);
    await expect(store.blockObjective('late')).rejects.toThrow(/already completed/);
  });
});

describe('milestone progression and bookkeeping', () => {
  it('activates the current milestone only when it is pending and the objective executes', async () => {
    await draftWithFeature();
    await expect(store.activateNextMilestone()).rejects.toThrow(/O1 is planning — cannot activate a milestone/);
    await store.requestObjectiveApproval();
    await store.approveObjective('human');
    const before = await readFile(store.abs(STATE_FILE), 'utf8');
    expect(await store.activateNextMilestone()).toBeUndefined();
    expect(await readFile(store.abs(STATE_FILE), 'utf8')).toBe(before);
    await mutateState((state) => {
      state.objective!.milestones[0]!.status = 'passed';
    });
    const activated = await store.activateNextMilestone();
    expect(activated).toMatchObject({ id: 'MS2', status: 'active', startedAt: expect.any(String) });
    expect((await readState()).objective!.milestones[1]!.status).toBe('active');
    expect(await activityLog()).toContain('milestone.activate objective=O1 milestone=MS2');
  });

  it('starts a validation on a resolved commit once every feature of the milestone is closed', async () => {
    await approvedObjective();
    const tip = await git(repo, 'rev-parse', 'main');
    await expect(store.startMilestoneValidation('MS1', tip)).rejects.toThrow(/still has open features \(M1 planned\)/);
    await mutateState((state) => {
      state.missions[0]!.status = 'merged';
    });
    await expect(store.startMilestoneValidation('MS9', tip)).rejects.toThrow(/no milestone "MS9"/);
    await expect(store.startMilestoneValidation('MS2', tip)).rejects.toThrow(/MS2 is pending/);
    await expect(store.startMilestoneValidation('MS1', 'no-such-ref')).rejects.toThrow(/does not name a commit/);
    const started = await store.startMilestoneValidation('MS1', tip.slice(0, 8));
    expect(started.commit).toBe(tip);
    expect(started.requiredKinds).toEqual(['scrutiny', 'user-testing']);
    expect(started.milestone).toMatchObject({ status: 'validating', validationCommit: tip });
    expect((await readState()).objective!.milestones[0]).toMatchObject({ status: 'validating', validationCommit: tip });
    expect(await activityLog()).toContain(
      `milestone.validate objective=O1 milestone=MS1 commit=${tip.slice(0, 7)} kinds=scrutiny,user-testing status=validating`,
    );
  });

  it('passes a milestone immediately when no validation kind is required', async () => {
    await approvedObjective();
    const tip = await git(repo, 'rev-parse', 'main');
    await mutateState((state) => {
      state.missions[0]!.status = 'merged';
    });
    const started = await store.startMilestoneValidation('MS1', tip, { skipScrutiny: true, skipUserTesting: true });
    expect(started.requiredKinds).toEqual([]);
    expect(started.milestone).toMatchObject({ status: 'passed', validationCommit: tip, passedAt: expect.any(String) });
    expect(await activityLog()).toContain('kinds=none status=passed');
  });

  it('refuses to validate a later milestone before the earlier ones passed, or one without features', async () => {
    await approvedObjective();
    const tip = await git(repo, 'rev-parse', 'main');
    await mutateState((state) => {
      state.missions[0]!.status = 'merged';
      state.missions[0]!.milestone = 'MS2';
      state.objective!.milestones[1]!.status = 'active';
    });
    await expect(store.startMilestoneValidation('MS2', tip)).rejects.toThrow(/before MS1 passed/);
    await expect(store.startMilestoneValidation('MS1', tip)).rejects.toThrow(/MS1 has no features/);
  });

  it('records usage only while an objective exists', async () => {
    const before = await readFile(store.abs(STATE_FILE), 'utf8');
    expect(await store.recordObjectiveUsage(1.5)).toBeUndefined();
    expect(await readFile(store.abs(STATE_FILE), 'utf8')).toBe(before);
    await draftWithFeature();
    await expect(store.recordObjectiveUsage(-1)).rejects.toThrow(/non-negative cost/);
    await expect(store.recordObjectiveUsage(Number.NaN)).rejects.toThrow(/non-negative cost/);
    await store.recordObjectiveUsage(0.25);
    await store.recordObjectiveUsage(0.5);
    expect((await readState()).objective?.usage).toEqual({ costUsd: 0.75 });
  });

  it('patches the autopilot memory and deduplicates wake keys', async () => {
    await expect(store.updateObjectiveAutopilot({ stallWakes: 1 })).rejects.toThrow(/no objective/);
    await draftWithFeature();
    expect(await store.updateObjectiveAutopilot({ addWakeKeys: ['plan-milestone:MS1:0'] })).toEqual({
      stallWakes: 0,
      wakeKeys: ['plan-milestone:MS1:0'],
    });
    const patched = await store.updateObjectiveAutopilot({
      progressKey: 'abc',
      progressAt: '2026-03-03T00:00:00.000Z',
      stallWakes: 2,
      addWakeKeys: ['plan-milestone:MS1:0', 'stalled:O1:1'],
    });
    expect(patched).toEqual({
      stallWakes: 2,
      wakeKeys: ['plan-milestone:MS1:0', 'stalled:O1:1'],
      progressKey: 'abc',
      progressAt: '2026-03-03T00:00:00.000Z',
    });
    expect((await readState()).objective?.autopilot).toEqual(patched);
    await expect(store.updateObjectiveAutopilot({ stallWakes: -1 })).rejects.toThrow(/non-negative integer/);
  });
});
