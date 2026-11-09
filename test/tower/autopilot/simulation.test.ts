import { readFile, rm } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ACTIVITY_LOG, type TowerStore } from '../../../src/protocol/index.ts';
import { AutopilotRunner } from '../../../src/tower/autopilot/runner.ts';
import { validationSettings } from '../../../src/tower/autopilot/snapshot.ts';
import { FakeTimers, FakeTower, RecordingLog, SIM_SETTINGS, type SimScript } from './harness.ts';
import { createRepo, createStore, git } from './repo.ts';

const SCRIPT: SimScript = {
  work(title, turn) {
    switch (title) {
      case 'Core A':
        return { file: 'core/a/value.txt', content: 'draft\n' };
      case 'Core B':
        return { file: 'core/b/value.txt', content: turn === 1 ? 'b\n' : 'b final\n' };
      case 'Fix core A readiness':
        return { file: 'core/a/value.txt', content: 'ready\n' };
      case 'Polish':
        return { file: 'polish/done.txt', content: 'done\n' };
      default:
        return undefined;
    }
  },
  review(missionId, reviewNumber) {
    return missionId === 'M2' && reviewNumber === 1 ? 'p1-1items' : 'clean';
  },
  validate() {
    return 'pass';
  },
  orchestrate(text) {
    if (text.startsWith('validation-failed:') && text.includes('MS1')) {
      return [{ title: 'Fix core A readiness', scope: ['core/a/**'], milestone: 'MS1', origin: 'fix', tasks: ['mark core a ready'] }];
    }
    if (text.startsWith('plan-milestone:') && text.includes('MS2')) {
      return [{ title: 'Polish', scope: ['polish/**'], milestone: 'MS2', tasks: ['polish it'] }];
    }
    return undefined;
  },
};

describe('a full simulated objective on a real repository', () => {
  let repo: string;
  let store: TowerStore;

  beforeEach(async () => {
    repo = await createRepo('tower-simulation-');
    store = await createStore(repo);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('runs two milestones with parallel features, fails a commands validation, plans a fix, re-validates and completes', async () => {
    await store.draftObjective({
      title: 'Ship the core',
      goal: 'core values ready and polished',
      definitionOfDone: ['core a is ready', 'core b exists', 'polish is done'],
      acceptanceCommands: ['test -f polish/done.txt'],
      milestones: [
        {
          title: 'Core',
          validation: {
            scrutiny: true,
            userTesting: false,
            commands: ['test -f core/a/value.txt', 'test -f core/b/value.txt', 'grep -q ready core/a/value.txt'],
          },
        },
        { title: 'Polish', validation: { scrutiny: true, userTesting: true } },
      ],
    });
    await store.plan(
      [
        { title: 'Core A', scope: ['core/a/**'], milestone: 'MS1', tasks: ['write core a'] },
        { title: 'Core B', scope: ['core/b/**'], milestone: 'MS1', tasks: ['write core b'] },
      ],
      validationSettings(SIM_SETTINGS),
    );
    await store.requestObjectiveApproval();

    const tower = new FakeTower(store, SCRIPT);
    const timers = new FakeTimers();
    const log = new RecordingLog();
    const runner = new AutopilotRunner({ observations: tower, effects: tower, timers, log });
    runner.start();
    expect(timers.intervalMs).toBe(60_000);

    await runner.tick('restore');
    await runner.whenIdle();
    expect(tower.notices).toHaveLength(1);
    expect(tower.notices[0]!.text).toContain('is ready for your approval');
    await runner.tick('again');
    await runner.whenIdle();
    expect(tower.notices).toHaveLength(1);

    await store.approveObjective('human');
    const parallel: string[][] = [];
    let maxRunning = 0;
    for (let round = 0; round < 40; round += 1) {
      await runner.tick(`round-${String(round)}`);
      await runner.whenIdle();
      maxRunning = Math.max(maxRunning, tower.runningCount());
      parallel.push(
        [...tower.agents.values()]
          .filter((agent) => agent.kind === 'worker' && agent.status === 'running')
          .map((agent) => agent.name)
          .sort(),
      );
      if ((await store.load()).objective?.status === 'completed') break;
      await tower.actAll();
      tower.clock += 60_000;
    }
    const noticesAtCompletion = tower.notices.length;
    await runner.tick('after-completion');
    await runner.whenIdle();
    expect(tower.notices).toHaveLength(noticesAtCompletion);
    runner.stop();
    await runner.whenIdle();

    const state = await store.load();
    const objective = state.objective!;
    expect(tower.unexpected).toEqual([]);
    expect(log.warnings).toEqual([]);
    expect(objective.status).toBe('completed');
    expect(state.missions.map((mission) => [mission.id, mission.status, mission.origin])).toEqual([
      ['M1', 'merged', 'plan'],
      ['M2', 'merged', 'plan'],
      ['M3', 'merged', 'fix'],
      ['M4', 'merged', 'plan'],
    ]);

    expect(parallel).toContainEqual(['ap-w-M1-1', 'ap-w-M2-1']);
    expect(maxRunning).toBeLessThanOrEqual(SIM_SETTINGS.maxRunningAgents);

    const [core, polish] = objective.milestones;
    expect(core!.rounds.map((round) => `${round.kind}-r${String(round.round)}:${round.verdict}:${round.validator}`)).toEqual([
      'commands-r1:fail:tower',
      'scrutiny-r1:pass:ap-v-MS1-scrutiny-1',
      'commands-r2:pass:tower',
      'scrutiny-r2:pass:ap-v-MS1-scrutiny-2',
    ]);
    expect(core!.rounds[0]!.failures).toEqual([expect.stringMatching(/^`grep -q ready core\/a\/value.txt` failed: exit code 1/)]);
    expect(core!.status).toBe('passed');
    expect(polish!.status).toBe('passed');
    expect(polish!.rounds.map((round) => `${round.kind}:${round.verdict}`).sort()).toEqual([
      'commands:pass',
      'scrutiny:pass',
      'user-testing:pass',
    ]);
    const baseTip = await git(repo, 'rev-parse', 'main');
    expect(polish!.validationCommit).toBe(baseTip);
    expect(polish!.rounds.every((round) => round.validatedCommit === baseTip)).toBe(true);

    expect(tower.calls.filter((call) => call.startsWith('spawnWorker')).map((call) => call.split(' ').slice(1).join(' '))).toEqual([
      'M1 ap-w-M1-1',
      'M2 ap-w-M2-1',
      'M3 ap-w-M3-1',
      'M4 ap-w-M4-1',
    ]);
    expect(tower.calls.filter((call) => call.startsWith('spawnReviewer')).map((call) => call.split(' ')[2])).toEqual([
      'ap-r-M1-1',
      'ap-r-M2-1',
      'ap-r-M2-2',
      'ap-r-M3-1',
      'ap-r-M4-1',
    ]);
    expect(tower.calls).toContain('resumeWorker ap-w-M2-1 review-findings');
    expect(tower.calls).toContain('rebase M2');
    expect(tower.calls.filter((call) => call.startsWith('respawnWorker'))).toEqual([]);
    expect(tower.wakes.map((text) => text.split(':')[0])).toEqual(['validation-failed', 'plan-milestone']);
    expect(tower.wakes[0]).toContain('grep -q ready core/a/value.txt');
    expect(tower.notices.at(-1)).toMatchObject({ level: 'info' });
    expect(tower.notices.at(-1)!.text).toContain('is complete');

    expect(await git(repo, 'show', 'main:core/a/value.txt')).toBe('ready');
    const worktrees = await git(repo, 'worktree', 'list', '--porcelain');
    expect(worktrees).not.toContain('/val-');
    expect(worktrees).not.toContain('/.tower/worktrees/');
    expect((await git(repo, 'branch', '--format=%(refname:short)')).split('\n')).toEqual(
      expect.arrayContaining(state.missions.map((mission) => mission.branch)),
    );
    expect(tower.notices.at(-1)!.text.split('\n\n').at(-1)).toBe(
      ['Automatic teardown: removed 4 worktree(s), kept 0.', ...state.missions.map((mission) => `- removed .tower/worktrees/${mission.worktree}`)].join('\n'),
    );
    const activity = await readFile(store.abs(ACTIVITY_LOG), 'utf8');
    expect(activity).toMatch(/ autopilot teardown objective=O1 result=done removed=4 kept=0\n/);
    expect(activity).toMatch(/ autopilot spawn-worker mission=M1 result=launched detail=name=ap-w-M1-1\n/);
    expect(activity).toMatch(/ autopilot commands milestone=MS1 commit=\w{7} result=submitted round=1 verdict=fail revision=0\n/);
    expect(activity).toMatch(/ autopilot complete-objective objective=O1 result=done detail=objective=O1\n/);
    expect(objective.autopilot?.wakeKeys).toEqual(
      expect.arrayContaining([
        'validation-failed:MS1:commands-r1',
        expect.stringMatching(/^resume-review-findings:M2:/),
        'completed-notice:O1',
      ]),
    );
  }, 60_000);
});
