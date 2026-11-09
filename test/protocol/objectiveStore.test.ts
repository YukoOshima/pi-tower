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
  parseFrontmatter,
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

describe('plan with milestones', () => {
  it('plans exactly as before without an objective', async () => {
    const [mission] = await store.plan([{ title: 'Plain work', scope: ['src/plain/**'] }]);
    expect(Object.keys(mission!)).toEqual([
      'id',
      'title',
      'slug',
      'kind',
      'scope',
      'branch',
      'worktree',
      'deps',
      'status',
      'context',
      'tasks',
      'notes',
      'blockers',
    ]);
    const raw = await readFile(store.abs(STATE_FILE), 'utf8');
    expect(raw).not.toMatch(/milestone|origin|attempts|objective/);
    expect(await activityLog()).toMatch(/ tower plan missions=M1 ref=\.tower\/comms\/MISSIONS\.md\n$/);
    await expect(store.plan([{ title: 'Other', scope: ['src/other/**'], milestone: 'MS1' }])).rejects.toThrow(
      /names milestone "MS1" but there is no objective/,
    );
    await expect(store.plan([{ title: 'Other', scope: ['src/other/**'], origin: 'fix' }])).rejects.toThrow(
      /without a milestone/,
    );
  });

  it('requires an existing milestone for build missions while the objective is open', async () => {
    await store.draftObjective({ title: 'Ship', milestones: [{ title: 'Core' }, { title: 'Polish' }] });
    await expect(store.plan([{ title: 'Loose work', scope: ['src/loose/**'] }])).rejects.toThrow(
      /O1 is planning — build mission "Loose work" must name the milestone it belongs to \(milestones: MS1 pending, MS2 pending\)/,
    );
    await expect(store.plan([{ title: 'Lost work', scope: ['src/lost/**'], milestone: 'MS9' }])).rejects.toThrow(
      /has no milestone "MS9"/,
    );
    await expect(
      store.plan([{ title: 'Odd work', scope: ['src/odd/**'], milestone: 'MS1', origin: 'other' as 'fix' }]),
    ).rejects.toThrow(/origin must be plan \| fix/);
    const [survey] = await store.plan([{ title: 'Look around', scope: ['src/**'], kind: 'survey' }]);
    expect(survey!.milestone).toBeUndefined();
    const [core, polish] = await store.plan([
      { title: 'Core work', scope: ['src/core/**'], milestone: 'MS1' },
      { title: 'Polish work', scope: ['src/polish/**'], milestone: ' MS2 ', origin: 'fix' },
    ]);
    expect(core).toMatchObject({ milestone: 'MS1', origin: 'plan' });
    expect(polish).toMatchObject({ milestone: 'MS2', origin: 'fix' });
    expect(Object.keys(core!).slice(-3)).toEqual(['blockers', 'milestone', 'origin']);
    expect(await activityLog()).toContain('plan missions=M2,M3 milestones=MS1,MS2 ref=');
  });

  it('refuses a passed milestone with guidance towards the current one', async () => {
    await store.draftObjective({ title: 'Ship', milestones: [{ title: 'Core' }, { title: 'Polish' }] });
    await mutateState((state) => {
      state.objective!.milestones[0]!.status = 'passed';
    });
    await expect(store.plan([{ title: 'Late work', scope: ['src/late/**'], milestone: 'MS1' }])).rejects.toThrow(
      /milestone MS1 "Core" already passed validation — plan "Late work" into the current milestone MS2 "Polish"/,
    );
  });

  it('reactivates a failed, validating or blocked milestone and defaults the origin to fix', async () => {
    await store.draftObjective({
      title: 'Ship',
      milestones: [{ title: 'Core' }, { title: 'Polish' }, { title: 'Docs' }],
    });
    await mutateState((state) => {
      state.objective!.milestones[0]!.status = 'failed';
      state.objective!.milestones[1]!.status = 'validating';
      state.objective!.milestones[2]!.status = 'blocked';
    });
    const planned = await store.plan([
      { title: 'Fix core', scope: ['src/core/**'], milestone: 'MS1' },
      { title: 'Fix polish', scope: ['src/polish/**'], milestone: 'MS2', origin: 'plan' },
      { title: 'Fix docs', scope: ['docs/**'], milestone: 'MS3' },
    ]);
    expect(planned.map((mission) => mission.origin)).toEqual(['fix', 'plan', 'fix']);
    const state = await readState();
    expect(state.objective!.milestones.map((milestone) => milestone.status)).toEqual(['active', 'active', 'active']);
    expect(await activityLog()).toContain('milestones=MS1,MS2,MS3 reactivated=MS1,MS2,MS3');
  });

  it('leaves milestones untouched when the plan is refused', async () => {
    await store.draftObjective({ title: 'Ship', milestones: [{ title: 'Core' }] });
    await store.plan([{ title: 'Core work', scope: ['src/core/**'], milestone: 'MS1' }]);
    await mutateState((state) => {
      state.objective!.milestones[0]!.status = 'failed';
    });
    await expect(
      store.plan([
        { title: 'Fix core', scope: ['src/fix/**'], milestone: 'MS1' },
        { title: 'Bad dep', scope: ['src/bad/**'], milestone: 'MS1', deps: ['M42'] },
      ]),
    ).rejects.toThrow(/unknown mission "M42"/);
    expect((await readState()).objective!.milestones[0]!.status).toBe('failed');
  });

  it('plans without milestones again once the objective is blocked, and refuses a completed objective', async () => {
    await store.draftObjective({ title: 'Ship', milestones: [{ title: 'Core' }] });
    await store.blockObjective('cannot converge');
    const [loose] = await store.plan([{ title: 'Loose work', scope: ['src/loose/**'] }]);
    expect(loose!.milestone).toBeUndefined();
    const [fix] = await store.plan([{ title: 'Fix core', scope: ['src/core/**'], milestone: 'MS1' }]);
    expect(fix).toMatchObject({ milestone: 'MS1', origin: 'plan' });
    await mutateState((state) => {
      state.objective!.status = 'completed';
    });
    await expect(store.plan([{ title: 'After', scope: ['src/after/**'], milestone: 'MS1' }])).rejects.toThrow(
      /O1 is completed/,
    );
  });
});

describe('roster with objectives', () => {
  const spawnedAt = '2026-04-04T00:00:00.000Z';

  it('registers a validator only for a milestone of the open objective', async () => {
    const validator = {
      name: 'val-ms1-scrutiny-r1',
      agentId: 'agent-val-1',
      kind: 'validator' as const,
      spawnedAt,
    };
    await expect(store.registerAgent(validator)).rejects.toThrow(/needs a milestone and a validation kind/);
    await expect(
      store.registerAgent({ ...validator, milestoneId: 'MS1', validationKind: 'scrutiny' }),
    ).rejects.toThrow(/there is no open objective$/);
    await store.draftObjective({ title: 'Ship', milestones: [{ title: 'Core' }] });
    await expect(
      store.registerAgent({ ...validator, milestoneId: 'MS1', validationKind: 'lint' as 'scrutiny' }),
    ).rejects.toThrow(/validation kind must be scrutiny \| user-testing \| commands, got "lint"/);
    await expect(
      store.registerAgent({ ...validator, milestoneId: 'MS7', validationKind: 'scrutiny' }),
    ).rejects.toThrow(/names milestone "MS7", which objective O1 does not have/);
    const tip = await git(repo, 'rev-parse', 'main');
    await store.registerAgent({
      ...validator,
      milestoneId: 'MS1',
      validationKind: 'scrutiny',
      validationRound: 1,
      validatedCommit: tip,
      worktree: 'val-ms1-scrutiny-r1',
    });
    expect((await readState()).roster.agents).toEqual([
      {
        ...validator,
        milestoneId: 'MS1',
        validationKind: 'scrutiny',
        validationRound: 1,
        validatedCommit: tip,
        worktree: 'val-ms1-scrutiny-r1',
        lastInboxReadAt: spawnedAt,
      },
    ]);
    await store.blockObjective('stop');
    await expect(
      store.registerAgent({ ...validator, name: 'val-2', agentId: 'agent-val-2', milestoneId: 'MS1', validationKind: 'user-testing' }),
    ).rejects.toThrow(/no open objective \(objective O1 is blocked\)/);
  });

  it('counts worker spawns as mission attempts only while an objective exists', async () => {
    const [plain] = await store.plan([{ title: 'Plain work', scope: ['src/plain/**'] }]);
    await store.registerSpawnedAgent(
      { name: 'w-plain', agentId: 'agent-plain', kind: 'worker', missionId: plain!.id, spawnedAt },
      { id: plain!.id, owner: 'w-plain' },
    );
    expect(await readFile(store.abs(STATE_FILE), 'utf8')).not.toContain('attempts');
    await store.draftObjective({ title: 'Ship', milestones: [{ title: 'Core' }] });
    const [core] = await store.plan([{ title: 'Core work', scope: ['src/core/**'], milestone: 'MS1' }]);
    await store.registerSpawnedAgent(
      { name: 'w-core-1', agentId: 'agent-core-1', kind: 'worker', missionId: core!.id, spawnedAt },
      { id: core!.id, owner: 'w-core-1' },
    );
    await store.registerAgent({ name: 'w-core-2', agentId: 'agent-core-2', kind: 'worker', missionId: core!.id, spawnedAt });
    await store.registerAgent({ name: 'r-core', agentId: 'agent-r', kind: 'reviewer', reviewTarget: core!.branch, spawnedAt });
    const state = await readState();
    expect(state.missions.find((mission) => mission.id === core!.id)?.attempts).toBe(2);
    expect(state.missions.find((mission) => mission.id === plain!.id)?.attempts).toBeUndefined();
  });
});

async function validatingMilestone(): Promise<string> {
  await approvedObjective();
  await mutateState((state) => {
    state.missions[0]!.status = 'merged';
  });
  const tip = await git(repo, 'rev-parse', 'main');
  await store.startMilestoneValidation('MS1', tip);
  return tip;
}

describe('validation worktrees', () => {
  it('prepares detached worktrees at the validation commit with per-kind round names', async () => {
    await approvedObjective();
    await expect(store.prepareValidationWorktree('MS1', 'scrutiny')).rejects.toThrow(/MS1 is active, not validating/);
    await expect(store.prepareValidationWorktree('MS1', 'lint' as 'scrutiny')).rejects.toThrow(/validation kind must be/);
    await mutateState((state) => {
      state.missions[0]!.status = 'merged';
    });
    const tip = await git(repo, 'rev-parse', 'main');
    await store.startMilestoneValidation('MS1', tip);
    await commitFile(repo, 'moved.txt', 'moved\n', 'base moved after validation started');

    const first = await store.prepareValidationWorktree('MS1', 'scrutiny');
    expect(first).toEqual({
      worktree: 'val-ms1-scrutiny-r1',
      path: store.abs('.tower/worktrees/val-ms1-scrutiny-r1'),
      commit: tip,
      round: 1,
    });
    expect(await git(first.path, 'rev-parse', 'HEAD')).toBe(tip);
    await expect(git(first.path, 'symbolic-ref', '-q', 'HEAD')).rejects.toThrow();
    expect((await store.prepareValidationWorktree('MS1', 'scrutiny')).worktree).toBe('val-ms1-scrutiny-r2');
    expect((await store.prepareValidationWorktree('MS1', 'user-testing')).worktree).toBe('val-ms1-user-testing-r1');
    expect(await activityLog()).toContain(
      `worktree.add worktree=val-ms1-scrutiny-r1 milestone=MS1 kind=scrutiny commit=${tip.slice(0, 7)}`,
    );
  });

  it('removes only validation worktrees', async () => {
    await validatingMilestone();
    const prepared = await store.prepareValidationWorktree('MS1', 'scrutiny');
    await expect(store.removeValidationWorktree('wt-1')).rejects.toThrow(/not a validation worktree/);
    await expect(store.removeValidationWorktree(join(repo, 'elsewhere', prepared.worktree))).rejects.toThrow(
      /not a validation worktree/,
    );
    expect(await store.removeValidationWorktree(`.tower/worktrees/${prepared.worktree}/`)).toBe(true);
    expect(await git(repo, 'worktree', 'list')).not.toContain(prepared.worktree);
    expect(await store.removeValidationWorktree(prepared.worktree)).toBe(false);
    const again = await store.prepareValidationWorktree('MS1', 'scrutiny');
    expect(await store.removeValidationWorktree(again.path)).toBe(true);
    expect(await activityLog()).toContain('worktree.remove worktree=val-ms1-scrutiny-r1');
  });

  it('tears validation worktrees down with the live-agent and dirty protections', async () => {
    await validatingMilestone();
    const live = await store.prepareValidationWorktree('MS1', 'scrutiny');
    const dirty = await store.prepareValidationWorktree('MS1', 'user-testing');
    const idle = await store.prepareValidationWorktree('MS1', 'commands');
    await writeFile(join(dirty.path, 'scratch.txt'), 'scratch\n');
    await store.registerAgent({
      name: 'val-scrutiny',
      agentId: 'agent-val-scrutiny',
      kind: 'validator',
      milestoneId: 'MS1',
      validationKind: 'scrutiny',
      worktree: live.worktree,
      spawnedAt: '2026-04-04T00:00:00.000Z',
    });
    const liveAgentIds = new Set(['agent-val-scrutiny']);
    expect(await store.teardown({ dryRun: true, liveAgentIds })).toEqual([
      'already removed .tower/worktrees/wt-1',
      'would remove .tower/worktrees/val-ms1-commands-r1',
      'would keep .tower/worktrees/val-ms1-scrutiny-r1 (live agent: val-scrutiny)',
      'would keep .tower/worktrees/val-ms1-user-testing-r1 (uncommitted changes — rerun with force to remove)',
    ]);
    expect(await store.teardown({ liveAgentIds })).toEqual([
      'already removed .tower/worktrees/wt-1',
      'removed .tower/worktrees/val-ms1-commands-r1',
      'kept .tower/worktrees/val-ms1-scrutiny-r1 (live agent: val-scrutiny)',
      'kept .tower/worktrees/val-ms1-user-testing-r1 (uncommitted changes — rerun with force to remove)',
    ]);
    expect(await store.teardown({ force: true, exclude: [live.worktree] })).toEqual([
      'already removed .tower/worktrees/wt-1',
      'kept .tower/worktrees/val-ms1-scrutiny-r1 (excluded)',
      'removed .tower/worktrees/val-ms1-user-testing-r1',
    ]);
    const worktrees = await git(repo, 'worktree', 'list');
    expect(worktrees).toContain(live.worktree);
    expect(worktrees).not.toContain(dirty.worktree);
    expect(worktrees).not.toContain(idle.worktree);
  });
});

describe('submitValidation', () => {
  async function registerValidator(
    name: string,
    kind: 'scrutiny' | 'user-testing' | 'commands',
    validatedCommit?: string,
  ): Promise<void> {
    await store.registerAgent({
      name,
      agentId: `agent-${name}`,
      kind: 'validator',
      milestoneId: 'MS1',
      validationKind: kind,
      validationRound: 1,
      ...(validatedCommit === undefined ? {} : { validatedCommit }),
      spawnedAt: '2026-04-04T00:00:00.000Z',
    });
  }

  it('authorizes only the registered validator, or the tower for commands', async () => {
    const tip = await validatingMilestone();
    await registerValidator('val-scrutiny', 'scrutiny', tip);
    await store.registerAgent({ name: 'w-1', agentId: 'agent-w-1', kind: 'worker', missionId: 'M1', spawnedAt: '2026-04-04T00:00:00.000Z' });
    const pass = { milestone: 'MS1', kind: 'scrutiny' as const, verdict: 'pass' as const };
    await expect(store.submitValidation('stranger', pass)).rejects.toThrow(/not the validator registered for MS1 scrutiny/);
    await expect(store.submitValidation('w-1', pass)).rejects.toThrow(/not the validator registered/);
    await expect(store.submitValidation('val-scrutiny', { ...pass, kind: 'user-testing' })).rejects.toThrow(
      /not the validator registered for MS1 user-testing/,
    );
    await expect(store.submitValidation('tower', pass)).rejects.toThrow(/tower records only the mechanical commands/);
    await expect(store.submitValidation('tower', { ...pass, kind: 'commands' })).rejects.toThrow(/must state the commit/);
    await expect(store.submitValidation('val-scrutiny', { ...pass, validatedCommit: 'f'.repeat(40) })).rejects.toThrow(
      /was checked out at/,
    );
    await expect(store.submitValidation('val-scrutiny', { ...pass, milestone: 'MS9' })).rejects.toThrow(/no milestone "MS9"/);
    await expect(store.submitValidation('val-scrutiny', { ...pass, verdict: 'meh' as 'pass' })).rejects.toThrow(
      /verdict must be pass \| fail/,
    );
    await expect(store.submitValidation('val-scrutiny', { ...pass, kind: 'lint' as 'scrutiny' })).rejects.toThrow(
      /kind must be scrutiny/,
    );
    await expect(store.submitValidation('val-scrutiny', { ...pass, verdict: 'fail', failures: [' '] })).rejects.toThrow(
      /must list at least one failure/,
    );
    await expect(store.submitValidation('val-scrutiny', { ...pass, failures: ['x'] })).rejects.toThrow(/lists no failures/);
    expect((await readState()).objective!.milestones[0]!.rounds).toEqual([]);
  });

  it('stores the report, appends the round, notifies the tower and passes the milestone once every kind passed', async () => {
    const tip = await validatingMilestone();
    await registerValidator('val-scrutiny', 'scrutiny', tip);
    await registerValidator('val-qa', 'user-testing', tip);
    const first = await store.submitValidation('val-scrutiny', {
      milestone: 'MS1',
      kind: 'scrutiny',
      verdict: 'pass',
      checks: ['npm test green', ' '],
      evidence: 'diff reviewed against the tasks',
    });
    expect(first.round).toEqual({
      round: 1,
      kind: 'scrutiny',
      validator: 'val-scrutiny',
      validatedCommit: tip,
      verdict: 'pass',
      failures: [],
      file: '.tower/comms/validations/validation-ms1-scrutiny-val-scrutiny-r1.md',
      date: expect.any(String),
    });
    expect(first.milestone.status).toBe('validating');
    expect(first.notificationError).toBeUndefined();
    const document = parseFrontmatter(await readFile(store.abs(first.round.file), 'utf8'));
    expect(document.fields).toEqual({
      milestone: 'MS1',
      kind: 'scrutiny',
      validator: 'val-scrutiny',
      round: '1',
      verdict: 'pass',
      validatedCommit: tip,
      date: first.round.date,
    });
    expect(document.body).toBe(
      '## Failures\n\n- (none)\n\n## Checks\n\n- [x] npm test green\n\n## Evidence\n\ndiff reviewed against the tasks',
    );
    expect(first.message?.item).toMatchObject({
      from: 'val-scrutiny',
      to: 'tower',
      subject: 'validation MS1 scrutiny r1: pass',
      scope: 'MS1',
      action: 'validation-result',
    });
    expect(first.message?.item.body).toContain('Milestone MS1 is now validating.');
    expect(await activityLog()).toContain(
      `val-scrutiny validation.submit milestone=MS1 kind=scrutiny round=1 verdict=pass commit=${tip.slice(0, 7)} status=validating ref=${first.round.file}`,
    );
    await expect(
      store.submitValidation('val-scrutiny', { milestone: 'MS1', kind: 'scrutiny', verdict: 'pass' }),
    ).rejects.toThrow(/already reported its MS1 scrutiny round/);

    const second = await store.submitValidation('val-qa', { milestone: 'MS1', kind: 'user-testing', verdict: 'pass' });
    expect(second.milestone).toMatchObject({ status: 'passed', passedAt: second.round.date });
    const state = await readState();
    expect(state.objective!.milestones[0]!.rounds.map((round) => [round.kind, round.round, round.verdict])).toEqual([
      ['scrutiny', 1, 'pass'],
      ['user-testing', 1, 'pass'],
    ]);
    const unread = await store.readUnreadInbox('tower', 10);
    expect(unread.map((item) => item.subject)).toEqual(
      expect.arrayContaining(['validation MS1 scrutiny r1: pass', 'validation MS1 user-testing r1: pass']),
    );
  });

  it('fails the milestone on a failing round and lists the failures', async () => {
    const tip = await validatingMilestone();
    await registerValidator('val-scrutiny', 'scrutiny', tip);
    const result = await store.submitValidation('val-scrutiny', {
      milestone: 'MS1',
      kind: 'scrutiny',
      verdict: 'fail',
      failures: ['tests fail on empty input', 'task 2 not implemented'],
    });
    expect(result.milestone.status).toBe('failed');
    expect(result.objective.status).toBe('executing');
    expect(result.message?.item.subject).toBe('validation MS1 scrutiny r1: fail (2 failures)');
    expect(result.message?.item.body).toContain('- tests fail on empty input\n- task 2 not implemented');
    expect(await readFile(store.abs(result.round.file), 'utf8')).toContain(
      '## Failures\n\n- tests fail on empty input\n- task 2 not implemented',
    );
  });

  it('blocks the milestone and the objective when failed rounds reach maxValidationRounds', async () => {
    const tip = await validatingMilestone();
    await mutateState((state) => {
      state.objective!.limits.maxValidationRounds = 2;
    });
    await registerValidator('val-a', 'user-testing', tip);
    await registerValidator('val-b', 'user-testing', tip);
    const failing = { milestone: 'MS1', kind: 'user-testing' as const, verdict: 'fail' as const, failures: ['crash'] };
    expect((await store.submitValidation('val-a', failing)).milestone.status).toBe('failed');
    const result = await store.submitValidation('val-b', failing);
    expect(result.round.round).toBe(2);
    expect(result.milestone.status).toBe('blocked');
    expect(result.objective).toMatchObject({
      status: 'blocked',
      blockedReason: 'milestone MS1 "Core" failed user-testing validation 2 times — maxValidationRounds is 2',
    });
    expect(result.message?.item.body).toContain('Objective O1 is now blocked');
    expect(await activityLog()).toContain('status=blocked objective=blocked');
  });

  it('records the tower commands round on an explicit commit', async () => {
    const tip = await validatingMilestone();
    await mutateState((state) => {
      state.objective!.milestones[0]!.validation = { scrutiny: false, userTesting: false, commands: ['npm test'] };
    });
    const result = await store.submitValidation(
      'tower',
      { milestone: 'MS1', kind: 'commands', verdict: 'pass', checks: ['npm test (exit 0)'], validatedCommit: tip.slice(0, 9) },
      { skipUserTesting: true },
    );
    expect(result.round).toMatchObject({ validator: 'tower', validatedCommit: tip, round: 1 });
    expect(result.round.file).toBe('.tower/comms/validations/validation-ms1-commands-tower-r1.md');
    expect(result.milestone.status).toBe('passed');
    expect(result.message?.item).toMatchObject({ from: 'tower', to: 'tower', action: 'validation-result' });
  });

  it('records a round stamped on another commit without letting it decide the milestone', async () => {
    const tip = await validatingMilestone();
    await commitFile(repo, 'next.txt', 'next\n', 'next');
    const next = await git(repo, 'rev-parse', 'main');
    await store.startMilestoneValidation('MS1', next);
    await registerValidator('val-old', 'scrutiny', tip);
    const result = await store.submitValidation('val-old', {
      milestone: 'MS1',
      kind: 'scrutiny',
      verdict: 'fail',
      failures: ['old failure'],
    });
    expect(result.round.validatedCommit).toBe(tip);
    expect(result.milestone.status).toBe('validating');
    expect(result.message?.item.body).toContain(
      `This round was recorded but does not decide the milestone: it was validating and validates ${next.slice(0, 7)}.`,
    );
  });

  it('refuses validations for a pending milestone or a completed objective', async () => {
    await approvedObjective();
    await expect(
      store.submitValidation('tower', { milestone: 'MS2', kind: 'commands', verdict: 'pass', validatedCommit: 'HEAD' }),
    ).rejects.toThrow(/MS2 is pending/);
    await mutateState((state) => {
      state.objective!.status = 'completed';
    });
    await expect(
      store.submitValidation('tower', { milestone: 'MS1', kind: 'commands', verdict: 'pass', validatedCommit: 'HEAD' }),
    ).rejects.toThrow(/validations are closed/);
  });
});

describe('MISSIONS.md and mission files', () => {
  async function missionsIndex(): Promise<string> {
    return readFile(store.abs('.tower/comms/MISSIONS.md'), 'utf8');
  }

  async function missionFile(name: string): Promise<string> {
    return readFile(store.abs(`.tower/comms/missions/${name}`), 'utf8');
  }

  it('renders exactly the v0.1 layout without an objective', async () => {
    await store.plan([{ title: 'Plain work', scope: ['src/plain/**'] }]);
    await store.registerSpawnedAgent(
      { name: 'w-plain', agentId: 'agent-plain', kind: 'worker', missionId: 'M1', spawnedAt: '2026-04-04T00:00:00.000Z' },
      { id: 'M1', owner: 'w-plain' },
    );
    expect(await missionsIndex()).toBe(
      [
        '# MISSIONS',
        '',
        '<!-- Generated by tower tools from state.json — do not edit by hand. -->',
        '',
        '| ID | Mission | Branch | Worktree | Status | Owner |',
        '| -- | ------- | ------ | -------- | ------ | ----- |',
        '| M1 | Plain work | feat/plain-work | wt-1 | 🔵 | w-plain |',
        '',
        'Status: 🟡 planned · 🔵 active · 🟢 completed · 🔴 blocked · ⏸️ paused · ✅ merged · 🚫 abandoned',
        'Mode: branch — Base: main',
        '',
        '## Dependency Flow',
        '(none)',
        '',
        '## Scope Map',
        '- M1: src/plain/**',
        '',
      ].join('\n'),
    );
    expect(await missionFile('M1-plain-work.md')).toBe(
      [
        '# Mission M1: Plain work',
        '',
        '<!-- Generated by tower tools from state.json — update via the TowerMission tool. -->',
        '',
        '| Branch | Worktree | Status | Scope | Owner |',
        '| ------ | -------- | ------ | ----- | ----- |',
        '| feat/plain-work | wt-1 | 🔵 | src/plain/** | w-plain |',
        '',
        '## Tasks',
        '- [ ] (no tasks recorded)',
        '',
        '## Dependencies',
        '(none)',
        '',
        '## Blockers',
        '- (none)',
        '',
        '## Notes',
        '- (none)',
        '',
      ].join('\n'),
    );
  });

  it('renders the objective section and the feature fields once an objective exists', async () => {
    await store.draftObjective({
      title: 'Ship',
      goal: 'ship it',
      definitionOfDone: ['works', 'documented'],
      acceptanceCommands: ['npm test'],
      milestones: [{ title: 'Core' }, { title: 'Polish', validation: { userTesting: false } }],
    });
    expect(await missionsIndex()).toContain(
      [
        '<!-- Generated by tower tools from state.json — do not edit by hand. -->',
        '',
        '## Objective O1: Ship',
        '',
        'Status: planning',
        'Goal: ship it',
        '',
        '### Definition of Done',
        '- works',
        '- documented',
        '',
        '### Acceptance Commands',
        '- `npm test`',
        '',
        '### Milestones',
        '',
        '| ID | Milestone | Status | Features | Latest rounds |',
        '| -- | --------- | ------ | -------- | ------------- |',
        '| MS1 | Core | pending | — | — |',
        '| MS2 | Polish | pending | — | — |',
        '',
        '| ID | Mission | Branch | Worktree | Status | Owner |',
      ].join('\n'),
    );
    await store.plan([{ title: 'Core work', scope: ['src/core/**'], milestone: 'MS1' }]);
    await store.requestObjectiveApproval();
    await store.approveObjective('human');
    await store.registerSpawnedAgent(
      { name: 'w-core', agentId: 'agent-core', kind: 'worker', missionId: 'M1', spawnedAt: '2026-04-04T00:00:00.000Z' },
      { id: 'M1', owner: 'w-core' },
    );
    await mutateState((state) => {
      state.missions[0]!.status = 'merged';
    });
    const tip = await git(repo, 'rev-parse', 'main');
    await store.startMilestoneValidation('MS1', tip);
    await store.registerAgent({
      name: 'val-scrutiny',
      agentId: 'agent-val-scrutiny',
      kind: 'validator',
      milestoneId: 'MS1',
      validationKind: 'scrutiny',
      validatedCommit: tip,
      spawnedAt: '2026-04-04T00:00:00.000Z',
    });
    await store.submitValidation('val-scrutiny', {
      milestone: 'MS1',
      kind: 'scrutiny',
      verdict: 'fail',
      failures: ['missing tests'],
    });
    const index = await missionsIndex();
    expect(index).toContain('Status: executing · approved by human\n');
    expect(index).toContain(`| MS1 | Core | failed @ ${tip.slice(0, 7)} | M1 ✅ | scrutiny r1 fail |`);
    expect(index).toContain('| MS2 | Polish | pending | — | — |');
    expect(index).toContain('| M1 | Core work | feat/core-work | wt-1 | ✅ | w-core |');
    expect(await missionFile('M1-core-work.md')).toContain(
      '| feat/core-work | wt-1 | 🔵 | src/core/** | w-core |\n\nMilestone: MS1 · Origin: plan · Attempts: 1\n\n## Tasks',
    );
    await store.blockObjective('needs a human decision');
    expect(await missionsIndex()).toContain('Status: blocked · approved by human · blocked: needs a human decision\n');
  });
});

describe('workspace-unique milestone ids', () => {
  for (const ending of ['blocked', 'completed'] as const) {
    it(`continues numbering after a ${ending} objective and never inherits its features`, async () => {
      await store.draftObjective({
        title: 'First',
        goal: 'g1',
        definitionOfDone: ['d1'],
        milestones: [{ title: 'A' }, { title: 'B' }, { title: 'C' }],
      });
      await store.plan([{ title: 'Old work', scope: ['src/old/**'], milestone: 'MS1' }]);
      if (ending === 'blocked') {
        await store.blockObjective('replaced by a new objective');
      } else {
        await mutateState((state) => {
          state.objective!.status = 'completed';
        });
      }
      const second = await store.draftObjective({
        title: 'Second',
        goal: 'g2',
        definitionOfDone: ['d2'],
        milestones: [{ title: 'D' }, { title: 'E' }],
      });
      expect(second).toMatchObject({ id: 'O2' });
      expect(second.milestones.map((milestone) => milestone.id)).toEqual(['MS4', 'MS5']);
      await expect(
        store.plan([{ title: 'Misfiled work', scope: ['src/misfiled/**'], milestone: 'MS1' }]),
      ).rejects.toThrow(/objective O2 has no milestone "MS1" \(milestones: MS4 pending, MS5 pending\)/);
      const evaluation = await store.objectiveEvaluation();
      expect(evaluation.milestones.map((milestone) => [milestone.id, milestone.features])).toEqual([
        ['MS4', []],
        ['MS5', []],
      ]);
      expect(evaluation.completion.blocks.map((block) => block.code)).not.toContain('open-feature');
      await expect(store.requestObjectiveApproval()).rejects.toThrow(/first milestone MS4 "D" has no build feature/);
      const appended = await store.updateObjective({ milestones: [{ title: 'F' }] });
      expect(appended.objective.milestones.map((milestone) => milestone.id)).toEqual(['MS4', 'MS5', 'MS6']);
      expect((await readState()).objectiveHistory?.map((objective) => objective.id)).toEqual(['O1']);
    });
  }
});

describe('re-validating the final milestone', () => {
  const skipAll = { skipScrutiny: true, skipUserTesting: true };

  async function passedFinalMilestone(): Promise<string> {
    await approvedObjective();
    const tip = await git(repo, 'rev-parse', 'main');
    await mutateState((state) => {
      state.missions[0]!.status = 'merged';
    });
    await store.startMilestoneValidation('MS1', tip, skipAll);
    await store.activateNextMilestone();
    const [polish] = await store.plan([{ title: 'Polish work', scope: ['src/polish/**'], milestone: 'MS2' }]);
    await mutateState((state) => {
      state.missions.find((mission) => mission.id === polish!.id)!.status = 'merged';
    });
    const final = await store.startMilestoneValidation('MS2', tip, skipAll);
    expect(final.milestone.status).toBe('passed');
    return tip;
  }

  it('refuses a passed non-final milestone and a final one that is still current', async () => {
    const tip = await passedFinalMilestone();
    await expect(store.startMilestoneValidation('MS1', tip, skipAll)).rejects.toThrow(
      /milestone MS1 already passed — only the final milestone is validated again/,
    );
    await expect(store.startMilestoneValidation('MS2', tip, skipAll)).rejects.toThrow(
      new RegExp(`final milestone MS2 already passed on ${tip.slice(0, 7)}`),
    );
    expect((await store.objectiveEvaluation(skipAll)).completion.ready).toBe(true);
  });

  it('validates a stale final milestone again and completes only once it passes on the current tip', async () => {
    await passedFinalMilestone();
    await commitFile(repo, 'later.txt', 'later\n', 'base moved after the final pass');
    const newTip = await git(repo, 'rev-parse', 'main');
    const stale = await store.completeObjective(skipAll).catch((caught: unknown) => caught);
    expect((stale as TowerObjectiveCompletionError).blocks.map((block) => block.code)).toEqual([
      'final-validation-stale',
    ]);

    const again = await store.startMilestoneValidation('MS2', newTip);
    expect(again.requiredKinds).toEqual(['scrutiny', 'user-testing']);
    expect(again.milestone).toMatchObject({ status: 'validating', validationCommit: newTip });
    expect(again.milestone.passedAt).toBeUndefined();
    const waiting = await store.completeObjective().catch((caught: unknown) => caught);
    expect((waiting as TowerObjectiveCompletionError).blocks.map((block) => block.code)).toEqual([
      'milestone-not-passed',
    ]);

    for (const kind of ['scrutiny', 'user-testing'] as const) {
      await store.registerAgent({
        name: `val-final-${kind}`,
        agentId: `agent-final-${kind}`,
        kind: 'validator',
        milestoneId: 'MS2',
        validationKind: kind,
        validatedCommit: newTip,
        spawnedAt: '2026-04-04T00:00:00.000Z',
      });
      await store.submitValidation(`val-final-${kind}`, { milestone: 'MS2', kind, verdict: 'pass' });
    }
    const completed = await store.completeObjective();
    expect(completed.status).toBe('completed');
    expect(completed.milestones[1]).toMatchObject({ status: 'passed', validationCommit: newTip });
  });

  it('validates a final milestone again on the same commit when its pass no longer covers the required kinds', async () => {
    const tip = await passedFinalMilestone();
    const again = await store.startMilestoneValidation('MS2', tip);
    expect(again.milestone).toMatchObject({ status: 'validating', validationCommit: tip });
    expect(again.requiredKinds).toEqual(['scrutiny', 'user-testing']);
  });
});
