import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { decideAutopilot } from '../../../src/autopilot/index.ts';
import {
  ACTIVITY_LOG,
  STATE_FILE,
  WORKTREES_DIR,
  type TowerMission,
  type TowerState,
  type TowerStore,
} from '../../../src/protocol/index.ts';
import { executeAutopilotAction, type AutopilotExecution } from '../../../src/tower/autopilot/executor.ts';
import { AutopilotRunner } from '../../../src/tower/autopilot/runner.ts';
import { buildAutopilotSnapshot, observeAutopilotWorld, validationSettings } from '../../../src/tower/autopilot/snapshot.ts';
import { autoTeardown, failedTeardown, type AutopilotTeardownOutcome } from '../../../src/tower/autopilot/teardown.ts';
import { autoTeardownNotice, completedNoticeText } from '../../../src/tower/autopilot/texts.ts';
import type { AutopilotRuntimeSettings } from '../../../src/tower/autopilot/types.ts';
import { FakeTimers, FakeTower, RecordingLog, SIM_SETTINGS, T0, type SimScript } from './harness.ts';
import { createRepo, createStore, git } from './repo.ts';

const SCRIPT: SimScript = {
  work: (title) => ({ file: `core/${title.split(' ')[1]!.toLowerCase()}/value.txt`, content: 'value\n' }),
  review: () => 'clean',
  validate: () => 'pass',
  orchestrate: () => [],
};

const COMPLETE = /^(Objective|Mission) O1 "Ship" is complete: every milestone passed validation/;

let repo: string;
let store: TowerStore;

beforeEach(async () => {
  repo = await createRepo('tower-teardown-');
  store = await createStore(repo);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

function worktreeOf(mission: Pick<TowerMission, 'worktree'>): string {
  return store.abs(join(WORKTREES_DIR, mission.worktree));
}

async function mutateState(mutate: (state: TowerState) => void): Promise<void> {
  const file = store.abs(STATE_FILE);
  const state = JSON.parse(await readFile(file, 'utf8')) as TowerState;
  mutate(state);
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
}

async function activity(): Promise<string> {
  return readFile(store.abs(ACTIVITY_LOG), 'utf8');
}

async function branches(): Promise<string[]> {
  return (await git(repo, 'branch', '--format=%(refname:short)')).split('\n');
}

/** One milestone without validation kinds and its only feature abandoned after its worktree was created. */
async function objectiveWithAbandonedFeature(): Promise<TowerMission> {
  await store.draftObjective({
    title: 'Ship',
    goal: 'ship it',
    definitionOfDone: ['works'],
    milestones: [{ title: 'Core', validation: { scrutiny: false, userTesting: false, commands: [] } }],
  });
  const [feature] = await store.plan(
    [{ title: 'Core A', scope: ['core/a/**'], milestone: 'MS1', tasks: ['write it'] }],
    validationSettings(SIM_SETTINGS),
  );
  await store.requestObjectiveApproval();
  await store.approveObjective('human');
  await store.addWorktree(feature!.worktree, feature!.branch, (await store.load()).base);
  await store.updateMission('tower', feature!.id, { status: 'abandoned' });
  return feature!;
}

async function readyToComplete(): Promise<TowerMission> {
  const feature = await objectiveWithAbandonedFeature();
  await store.startMilestoneValidation('MS1', await git(repo, 'rev-parse', 'main'), validationSettings(SIM_SETTINGS));
  return feature;
}

describe('autoTeardown', () => {
  it('removes merged, abandoned and validation worktrees, keeps live, dirty and open ones, and never forces', async () => {
    const missions = await store.plan(
      ['merged', 'abandoned', 'dirty', 'live', 'open', 'never'].map((name) => ({ title: `feature ${name}`, scope: [`src/${name}/**`] })),
    );
    const [merged, abandoned, dirty, live, open, never] = missions;
    const base = (await store.load()).base;
    for (const mission of [merged!, abandoned!, dirty!, live!, open!]) await store.addWorktree(mission.worktree, mission.branch, base);
    await git(repo, 'worktree', 'add', '--detach', store.abs(join(WORKTREES_DIR, 'val-ms1-scrutiny-r1')), 'main');
    const statuses: Record<string, TowerMission['status']> = {
      [merged!.id]: 'merged',
      [abandoned!.id]: 'abandoned',
      [dirty!.id]: 'merged',
      [live!.id]: 'merged',
      [open!.id]: 'active',
      [never!.id]: 'abandoned',
    };
    await mutateState((state) => {
      for (const mission of state.missions) mission.status = statuses[mission.id] ?? mission.status;
    });
    const spawnedAt = new Date().toISOString();
    await store.registerAgent({ name: 'w-idle', agentId: 'agent-idle', kind: 'worker', worktree: merged!.worktree, spawnedAt });
    await store.registerAgent({ name: 'w-live', agentId: 'agent-live', kind: 'worker', worktree: live!.worktree, spawnedAt });
    await writeFile(join(worktreeOf(dirty!), 'notes.txt'), 'work in progress\n');

    const outcome = await autoTeardown(store, (entry) => entry.name === 'w-live');

    expect(outcome).toEqual({
      lines: [
        `removed .tower/worktrees/${merged!.worktree}`,
        `removed .tower/worktrees/${abandoned!.worktree}`,
        `kept .tower/worktrees/${dirty!.worktree} (uncommitted changes — rerun with force to remove)`,
        `kept .tower/worktrees/${live!.worktree} (live agent: w-live)`,
        `kept .tower/worktrees/${open!.worktree} (mission ${open!.id} is still active)`,
        'removed .tower/worktrees/val-ms1-scrutiny-r1',
      ],
      removed: 3,
      kept: 3,
      failed: 0,
    });
    expect([merged, abandoned].map((mission) => existsSync(worktreeOf(mission!)))).toEqual([false, false]);
    expect([dirty, live, open].map((mission) => existsSync(worktreeOf(mission!)))).toEqual([true, true, true]);
    expect(await readFile(join(worktreeOf(dirty!), 'notes.txt'), 'utf8')).toBe('work in progress\n');
    expect(await branches()).toEqual(expect.arrayContaining([merged, abandoned, dirty, live, open].map((mission) => mission!.branch)));
    expect(existsSync(store.abs(STATE_FILE))).toBe(true);
    const log = await activity();
    expect(log).toMatch(new RegExp(` tower worktree\\.keep worktree=${dirty!.worktree} reason=uncommitted-changes\\n`));
    expect(log).toMatch(new RegExp(` tower worktree\\.keep worktree=${open!.worktree} reason=excluded\\n`));
    expect(log).toMatch(/ tower teardown\n/);
    expect(log).not.toContain('force=yes');
  });

  it('counts a worktree git refuses to remove as failed', async () => {
    const [mission] = await store.plan([{ title: 'feature locked', scope: ['src/locked/**'] }]);
    await store.addWorktree(mission!.worktree, mission!.branch, (await store.load()).base);
    await mutateState((state) => {
      state.missions[0]!.status = 'merged';
    });
    await git(repo, 'worktree', 'lock', worktreeOf(mission!));

    const outcome = await autoTeardown(store, () => false);

    expect(outcome).toMatchObject({ removed: 0, kept: 0, failed: 1 });
    expect(outcome.lines).toEqual([expect.stringMatching(new RegExp(`^failed to remove \\.tower/worktrees/${mission!.worktree}: `))]);
    expect(outcome.error).toBeUndefined();
  });

  it('turns a teardown that throws into an outcome with the error instead of rejecting', async () => {
    store.teardown = () => Promise.reject(new Error('disk full'));

    await expect(autoTeardown(store, () => false)).resolves.toEqual(failedTeardown('disk full'));
    expect(failedTeardown('disk full')).toEqual({ lines: [], removed: 0, kept: 0, failed: 0, error: 'disk full' });
  });
});

describe('the teardown section of the completion notice', () => {
  const outcome = (overrides: Partial<AutopilotTeardownOutcome>): AutopilotTeardownOutcome => ({
    lines: [],
    removed: 0,
    kept: 0,
    failed: 0,
    ...overrides,
  });

  it('lists what was removed and kept, and says how a kept worktree goes', () => {
    expect(
      autoTeardownNotice(
        outcome({
          lines: [
            'removed .tower/worktrees/wt-1',
            'removed .tower/worktrees/val-ms1-scrutiny-r1',
            'kept .tower/worktrees/wt-2 (live agent: ap-w-M2-1)',
          ],
          removed: 2,
          kept: 1,
        }),
      ),
    ).toBe(
      [
        'Automatic teardown: removed 2 worktree(s), kept 1.',
        '- removed .tower/worktrees/wt-1',
        '- removed .tower/worktrees/val-ms1-scrutiny-r1',
        '- kept .tower/worktrees/wt-2 (live agent: ap-w-M2-1)',
        'A kept or failed worktree stays until a later /tower teardown removes it.',
      ].join('\n'),
    );
  });

  it('adds no hint when everything was removed, and counts failed removals', () => {
    expect(autoTeardownNotice(outcome({ lines: ['removed .tower/worktrees/wt-1'], removed: 1 }))).toBe(
      'Automatic teardown: removed 1 worktree(s), kept 0.\n- removed .tower/worktrees/wt-1',
    );
    expect(
      autoTeardownNotice(outcome({ lines: ['failed to remove .tower/worktrees/wt-3: locked'], failed: 1 })).split('\n')[0],
    ).toBe('Automatic teardown: removed 0 worktree(s), kept 0, failed to remove 1.');
  });

  it('says so when no worktree was left', () => {
    expect(autoTeardownNotice(outcome({}))).toBe('Automatic teardown: no worktree was left to remove.');
  });

  it('reports a failed teardown on one line and keeps the completion', () => {
    expect(autoTeardownNotice(failedTeardown('git worktree list failed:\n  index locked.'))).toBe(
      'Automatic teardown failed: git worktree list failed: index locked. The completion is not affected; run /tower teardown to remove the remaining worktrees.',
    );
  });

  it('is appended to the completion notice only when there is an outcome', async () => {
    await readyToComplete();
    await store.completeObjective(validationSettings(SIM_SETTINGS));
    const state = await store.load();
    const input = { objective: state.objective!, state, baseTip: await git(repo, 'rev-parse', 'main'), now: T0 };
    const teardown = outcome({ lines: ['removed .tower/worktrees/wt-1'], removed: 1 });
    expect(completedNoticeText(input)).toMatch(COMPLETE);
    expect(completedNoticeText(input)).not.toContain('Automatic teardown');
    expect(completedNoticeText({ ...input, teardown })).toBe(`${completedNoticeText(input)}\n\n${autoTeardownNotice(teardown)}`);
  });
});

describe('the completion decision and its execution', () => {
  const REMOVED: AutopilotTeardownOutcome = { lines: ['removed .tower/worktrees/wt-1'], removed: 1, kept: 0, failed: 0 };
  const DONE = { status: 'done', detail: 'objective=O1', wakeKey: 'completed-notice:O1', followUp: true };

  async function decided(
    settings: Partial<AutopilotRuntimeSettings>,
    teardown: () => Promise<AutopilotTeardownOutcome> = async () => REMOVED,
  ) {
    await readyToComplete();
    const tower = new FakeTower(store, SCRIPT, settings);
    const world = await observeAutopilotWorld({ store, observations: tower, state: await store.load() });
    const snapshot = buildAutopilotSnapshot(world);
    const decision = decideAutopilot(snapshot);
    const teardowns: string[] = [];
    const execution: AutopilotExecution = {
      store,
      effects: tower,
      world,
      snapshot,
      decision,
      reserved: new Set(),
      launch: () => {
        throw new Error('the completion launches no agent');
      },
      runCommands: () => {
        throw new Error('the completion runs no commands');
      },
      teardown: async (objectiveId) => {
        teardowns.push(`${objectiveId} ${(await store.load()).objective!.status}`);
        return teardown();
      },
    };
    const run = async () => {
      const outcome = await executeAutopilotAction(execution, decision.actions[0]!);
      const state = await store.load();
      return { outcome, state, expected: { objective: state.objective!, state, baseTip: world.baseTip, now: world.now } };
    };
    return { tower, decision, teardowns, run };
  }

  it('decides the completion with the teardown and tears down once the objective is completed', async () => {
    const { decision, tower, teardowns, run } = await decided({});
    expect(decision.actions).toEqual([{ type: 'complete-objective', objective: 'O1', teardown: true }]);

    const { outcome, state, expected } = await run();

    expect(outcome).toEqual(DONE);
    expect(state.objective!.status).toBe('completed');
    expect(teardowns).toEqual(['O1 completed']);
    expect(tower.notices).toEqual([{ level: 'info', text: completedNoticeText({ ...expected, teardown: REMOVED }) }]);
    expect(tower.notices[0]!.text).toMatch(COMPLETE);
  });

  it('decides the teardown in manual mode too, because the completion is always automatic', async () => {
    const { decision, teardowns, run } = await decided({ autopilot: false });
    expect(decision.actions).toEqual([{ type: 'complete-objective', objective: 'O1', teardown: true }]);

    expect((await run()).outcome).toEqual(DONE);
    expect(teardowns).toEqual(['O1 completed']);
  });

  it('with autoTeardown off neither tears down nor changes the notice', async () => {
    const { decision, tower, teardowns, run } = await decided({ autoTeardown: false });
    expect(decision.actions).toEqual([{ type: 'complete-objective', objective: 'O1', teardown: false }]);

    const { outcome, expected } = await run();

    expect(outcome).toEqual(DONE);
    expect(teardowns).toEqual([]);
    expect(tower.notices).toEqual([{ level: 'info', text: completedNoticeText(expected) }]);
    expect(tower.notices[0]!.text).not.toContain('Automatic teardown');
  });

  it('a teardown that throws never fails the completion and is reported to the human', async () => {
    const { tower, run } = await decided({}, () => Promise.reject(new Error('disk full')));

    const { outcome, state } = await run();

    expect(outcome).toEqual(DONE);
    expect(state.objective!.status).toBe('completed');
    expect(tower.notices).toHaveLength(1);
    expect(tower.notices[0]!.text).toMatch(COMPLETE);
    expect(tower.notices[0]!.text).toMatch(
      /\n\nAutomatic teardown failed: disk full\. The completion is not affected; run \/tower teardown to remove the remaining worktrees\.$/,
    );
  });

  it('a teardown that reports an error is shown to the human the same way', async () => {
    const { tower, run } = await decided({}, async () => failedTeardown('git worktree list failed'));

    expect((await run()).outcome).toEqual(DONE);
    expect(tower.notices[0]!.text).toContain('\n\nAutomatic teardown failed: git worktree list failed. The completion is not affected;');
  });
});

describe('the autopilot runner tears down on completion', () => {
  function setup(settings: Partial<AutopilotRuntimeSettings> = {}) {
    const tower = new FakeTower(store, SCRIPT, settings);
    const log = new RecordingLog();
    const runner = new AutopilotRunner({ observations: tower, effects: tower, timers: new FakeTimers(), log });
    runner.start();
    return { tower, log, runner };
  }

  async function settle(runner: AutopilotRunner): Promise<void> {
    await runner.tick('test');
    await runner.whenIdle();
  }

  function count(text: string, pattern: RegExp): number {
    return text.split('\n').filter((line) => pattern.test(line)).length;
  }

  it('drives three parallel features to completion, removes the finished worktrees and keeps a dirty and a live one', async () => {
    await store.draftObjective({
      title: 'Ship',
      goal: 'ship it',
      definitionOfDone: ['works'],
      milestones: [{ title: 'Core', validation: { scrutiny: true, userTesting: false, commands: [] } }],
    });
    await store.plan(
      ['a', 'b', 'c'].map((name) => ({ title: `Core ${name.toUpperCase()}`, scope: [`core/${name}/**`], milestone: 'MS1', tasks: ['write it'] })),
      validationSettings(SIM_SETTINGS),
    );
    await store.requestObjectiveApproval();
    await store.approveObjective('human');
    const [a, b, c] = (await store.load()).missions;
    const { tower, log, runner } = setup();

    let validated = false;
    for (let round = 0; round < 30; round += 1) {
      await settle(runner);
      if ((await store.load()).objective!.status === 'completed') break;
      await tower.actAll();
      if (!validated && [...tower.agents.values()].some((agent) => agent.kind === 'validator' && agent.status === 'completed')) {
        validated = true;
        await writeFile(join(worktreeOf(b!), 'notes.txt'), 'work in progress\n');
        tower.agents.get('agent-ap-w-M3-1')!.status = 'running';
      }
      tower.clock += 60_000;
    }
    await settle(runner);
    runner.stop();
    await runner.whenIdle();

    const state = await store.load();
    expect(validated).toBe(true);
    expect(state.objective!.status).toBe('completed');
    expect(state.missions.map((mission) => mission.status)).toEqual(['merged', 'merged', 'merged']);
    expect(existsSync(worktreeOf(a!))).toBe(false);
    expect([b, c].map((mission) => existsSync(worktreeOf(mission!)))).toEqual([true, true]);
    expect(await git(repo, 'worktree', 'list', '--porcelain')).not.toContain('/val-');
    expect(await branches()).toEqual(expect.arrayContaining([a!.branch, b!.branch, c!.branch]));
    expect(existsSync(store.abs(STATE_FILE))).toBe(true);
    expect(log.warnings).toEqual([]);

    const completion = tower.notices.filter((notice) => COMPLETE.test(notice.text));
    expect(completion).toHaveLength(1);
    expect(completion[0]!.level).toBe('info');
    expect(completion[0]!.text.split('\n\n').at(-1)).toBe(
      [
        'Automatic teardown: removed 1 worktree(s), kept 2.',
        `- removed .tower/worktrees/${a!.worktree}`,
        `- kept .tower/worktrees/${b!.worktree} (uncommitted changes — rerun with force to remove)`,
        `- kept .tower/worktrees/${c!.worktree} (live agent: ap-w-M3-1)`,
        'A kept or failed worktree stays until a later /tower teardown removes it.',
      ].join('\n'),
    );

    const trail = await activity();
    expect(trail).toMatch(new RegExp(` tower worktree\\.remove worktree=${a!.worktree}\\n`));
    expect(trail).toMatch(new RegExp(` tower worktree\\.keep worktree=${b!.worktree} reason=uncommitted-changes\\n`));
    expect(trail).toMatch(new RegExp(` tower worktree\\.keep worktree=${c!.worktree} reason=live-agent agent=ap-w-M3-1\\n`));
    expect(trail).toMatch(/ autopilot teardown objective=O1 result=done removed=1 kept=2\n[^\n]* autopilot complete-objective objective=O1 result=done detail=objective=O1\n/);
    expect(count(trail, / autopilot teardown /)).toBe(1);
  }, 60_000);

  it('a teardown that fails leaves the objective completed, logs the error and tells the human', async () => {
    const feature = await objectiveWithAbandonedFeature();
    store.teardown = () => Promise.reject(new Error('disk full'));
    const { tower, log, runner } = setup();

    await settle(runner);
    await settle(runner);

    expect((await store.load()).objective!.status).toBe('completed');
    expect(existsSync(worktreeOf(feature))).toBe(true);
    expect(tower.notices).toHaveLength(1);
    expect(tower.notices[0]!.text).toMatch(COMPLETE);
    expect(tower.notices[0]!.text.split('\n\n').at(-1)).toBe(
      'Automatic teardown failed: disk full. The completion is not affected; run /tower teardown to remove the remaining worktrees.',
    );
    expect(log.warnings).toEqual([
      'tower autopilot could not tear down the worktrees of the completed objective {"objective":"O1","error":"disk full"}',
    ]);
    const trail = await activity();
    expect(trail).toMatch(/ autopilot teardown objective=O1 result=failed error=disk full\n/);
    expect(trail).toMatch(/ autopilot complete-objective objective=O1 result=done detail=objective=O1\n/);
    expect((await store.load()).objective!.autopilot?.wakeKeys).toContain('completed-notice:O1');
  });

  it('with autoTeardown off the completion leaves every worktree and the notice as before', async () => {
    const feature = await objectiveWithAbandonedFeature();
    const { tower, runner } = setup({ autoTeardown: false });

    await settle(runner);

    const state = await store.load();
    expect(state.objective!.status).toBe('completed');
    expect(existsSync(worktreeOf(feature))).toBe(true);
    expect(tower.notices).toEqual([
      {
        level: 'info',
        text: completedNoticeText({ objective: state.objective!, state, baseTip: await git(repo, 'rev-parse', 'main'), now: T0 }),
      },
    ]);
    const trail = await activity();
    expect(trail).not.toContain(' autopilot teardown ');
    expect(trail).not.toMatch(/ tower (teardown|worktree\.remove)/);
  });

  it('with the autopilot off the completion still tears down', async () => {
    const feature = await objectiveWithAbandonedFeature();
    const { tower, runner } = setup({ autopilot: false });

    await settle(runner);

    expect((await store.load()).objective!.status).toBe('completed');
    expect(existsSync(worktreeOf(feature))).toBe(false);
    expect(tower.calls.filter((call) => !call.startsWith('notify'))).toEqual([]);
    expect(tower.notices.at(-1)!.text.split('\n\n').at(-1)).toBe(
      `Automatic teardown: removed 1 worktree(s), kept 0.\n- removed .tower/worktrees/${feature.worktree}`,
    );
    expect(await activity()).toMatch(/ autopilot teardown objective=O1 result=done removed=1 kept=0\n/);
  });

  it('a completion the runner never announced is torn down once, with its notice', async () => {
    const feature = await readyToComplete();
    await store.completeObjective(validationSettings(SIM_SETTINGS));
    const { tower, runner } = setup();

    await settle(runner);
    await settle(runner);

    expect(existsSync(worktreeOf(feature))).toBe(false);
    expect(tower.notices).toHaveLength(1);
    expect(tower.notices[0]!.text).toMatch(COMPLETE);
    expect(tower.notices[0]!.text.split('\n\n').at(-1)).toBe(
      `Automatic teardown: removed 1 worktree(s), kept 0.\n- removed .tower/worktrees/${feature.worktree}`,
    );
    expect(count(await activity(), / autopilot teardown /)).toBe(1);
  });
});
