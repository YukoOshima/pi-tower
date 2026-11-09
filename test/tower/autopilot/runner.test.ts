import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { digest } from '../../../src/autopilot/index.ts';
import {
  ACTIVITY_LOG,
  type TowerObjectiveLimitsInput,
  type TowerState,
  type TowerStore,
} from '../../../src/protocol/index.ts';
import type {
  CommandsValidationOutcome,
  CommandsValidationRequest,
} from '../../../src/tower/autopilot/commandsRunner.ts';
import {
  reviewerAgentName,
  validatorAgentName,
  workerAgentName,
} from '../../../src/tower/autopilot/executor.ts';
import { AutopilotRunner } from '../../../src/tower/autopilot/runner.ts';
import { validationSettings } from '../../../src/tower/autopilot/snapshot.ts';
import type { AutopilotRuntimeSettings, EffectResult } from '../../../src/tower/autopilot/types.ts';
import { FakeTimers, FakeTower, RecordingLog, SIM_SETTINGS, T0, type SimScript } from './harness.ts';
import { createRepo, createStore, git, isAlive, waitUntil } from './repo.ts';

const QUIET: SimScript = {
  work: (title) => ({ file: `${title.toLowerCase().replaceAll(' ', '-')}/value.txt`, content: 'value\n' }),
  review: () => 'clean',
  validate: () => 'pass',
  orchestrate: () => [],
};

let repo: string;
let store: TowerStore;

beforeEach(async () => {
  repo = await createRepo('tower-runner-');
  store = await createStore(repo);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function draft(
  options: {
    readonly commands?: string[];
    readonly scrutiny?: boolean;
    readonly limits?: TowerObjectiveLimitsInput;
    readonly request?: boolean;
    readonly features?: readonly string[];
  } = {},
): Promise<void> {
  await store.draftObjective({
    title: 'Ship',
    goal: 'ship it',
    definitionOfDone: ['works'],
    milestones: [
      {
        title: 'Core',
        validation: { scrutiny: options.scrutiny ?? false, userTesting: false, commands: options.commands ?? [] },
      },
    ],
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  await store.plan(
    (options.features ?? ['a']).map((name) => ({
      title: `Core ${name.toUpperCase()}`,
      scope: [`core/${name}/**`],
      milestone: 'MS1',
      tasks: ['write it'],
    })),
    validationSettings(SIM_SETTINGS),
  );
  if (options.request !== false) await store.requestObjectiveApproval();
}

function setup(settings: Partial<AutopilotRuntimeSettings> = {}, start = true, script: SimScript = QUIET) {
  const tower = new FakeTower(store, script, settings);
  const timers = new FakeTimers();
  const log = new RecordingLog();
  const runner = new AutopilotRunner({ observations: tower, effects: tower, timers, log });
  if (start) runner.start();
  let loads = 0;
  const storeOf = tower.store.bind(tower);
  tower.store = () => {
    loads += 1;
    return storeOf();
  };
  return { tower, timers, log, runner, loads: () => loads };
}

async function settle(runner: AutopilotRunner, reason = 'test'): Promise<void> {
  await runner.tick(reason);
  await runner.whenIdle();
}

async function objectiveOf(): Promise<NonNullable<TowerState['objective']>> {
  return (await store.load()).objective!;
}

describe('AutopilotRunner lifecycle', () => {
  it('ignores ticks before start and after stop, and arms the watchdog at watchdogIntervalMs', async () => {
    await draft();
    const { runner, timers, loads } = setup({ watchdogIntervalMs: 12_345 }, false);
    await settle(runner);
    expect(loads()).toBe(0);
    runner.start();
    expect(loads()).toBe(1);
    expect(timers.intervalMs).toBe(12_345);
    timers.fire();
    await runner.whenIdle();
    expect(loads()).toBe(2);
    runner.stop();
    expect(timers.cleared).toBe(1);
    timers.fire();
    await settle(runner);
    expect(loads()).toBe(2);
  });

  it('serializes ticks and coalesces the ones that arrive while a tick runs', async () => {
    await draft();
    await store.approveObjective('human');
    const { runner, loads } = setup();
    const ticks = [runner.tick('a'), runner.tick('b'), runner.tick('c')];
    await Promise.all(ticks);
    await runner.whenIdle();
    expect(loads()).toBe(2);
  });

  it('never ticks on its own writes', async () => {
    await draft();
    await store.approveObjective('human');
    const { runner, tower, loads } = setup();
    await settle(runner);
    expect(tower.calls).toEqual(['spawnWorker M1 ap-w-M1-1']);
    await runner.whenIdle();
    expect(loads()).toBe(1);
    const memory = (await objectiveOf()).autopilot;
    expect(memory).toMatchObject({ stallWakes: 0, progressAt: new Date(T0).toISOString() });
    expect(memory?.progressKey).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('awaiting approval', () => {
  it('notifies the human once per approval request when autoApprove is off', async () => {
    await draft();
    const { runner, tower } = setup();
    await settle(runner);
    await settle(runner);
    expect(tower.notices).toHaveLength(1);
    expect(tower.notices[0]).toMatchObject({ level: 'info' });
    expect(tower.notices[0]!.text).toContain('Objective O1 "Ship" is ready for your approval.');
    expect((await objectiveOf()).autopilot?.wakeKeys).toEqual([expect.stringMatching(/^approval:O1:[0-9a-f]{16}$/)]);
    expect((await objectiveOf()).status).toBe('awaiting-approval');
    await store.updateObjective({ notes: ['assume the default port'] });
    await settle(runner);
    expect(tower.notices).toHaveLength(2);
    expect(tower.notices[1]!.text).toContain('assume the default port');
    const activity = await readFile(store.abs(ACTIVITY_LOG), 'utf8');
    expect(activity).toMatch(/ autopilot notify-human objective=O1 reason=approval\n/);
  });

  it('approves automatically with autoApprove and starts executing in the same tick', async () => {
    await draft();
    const { runner, tower } = setup({ autoApprove: true });
    await settle(runner);
    expect(await objectiveOf()).toMatchObject({ status: 'executing', approvedBy: 'auto' });
    expect(tower.notices[0]!.text).toContain('was approved automatically');
    expect(tower.calls).toContain('spawnWorker M1 ap-w-M1-1');
  });

  it('notifies the human once when the store refuses the automatic approval', async () => {
    await draft();
    await store.updateMission('tower', 'M1', { status: 'abandoned' });
    const { runner, tower } = setup({ autoApprove: true });
    await settle(runner);
    await settle(runner);
    expect((await objectiveOf()).status).toBe('awaiting-approval');
    expect(tower.notices).toHaveLength(1);
    expect(tower.notices[0]).toMatchObject({ level: 'warning' });
    expect(tower.notices[0]!.text).toMatch(/^Automatic approval of objective O1 "Ship" was refused: objective O1 cannot be approved — the first milestone MS1/);
  });
});

describe('contract revisions and human-only approval', () => {
  it('a contract change while blocked refuses the automatic approval and notifies the human once', async () => {
    await draft();
    await store.approveObjective('human');
    await store.blockObjective('waiting for the human');
    await store.updateObjective({ definitionOfDone: ['works', 'and is documented'] });
    const { runner, tower } = setup({ autoApprove: true });
    await settle(runner);
    await settle(runner);
    const objective = await objectiveOf();
    expect(objective).toMatchObject({ status: 'awaiting-approval', approvalRequiresHuman: true });
    expect(tower.notices).toHaveLength(1);
    expect(tower.notices[0]).toMatchObject({ level: 'warning' });
    expect(tower.notices[0]!.text).toContain('only a human can approve it');
    expect(tower.notices[0]!.text).toContain('The contract changed after approval');
    expect(tower.calls.filter((call) => call.startsWith('spawnWorker'))).toEqual([]);
    await store.approveObjective('human');
    await settle(runner);
    expect(tower.calls).toContain('spawnWorker M1 ap-w-M1-1');
  });

  it('validators briefed under a changed contract state its revision and their rounds decide the milestone', async () => {
    await draft({ scrutiny: true });
    await store.approveObjective('human');
    await store.updateObjective({ acceptanceCommands: ['test -f README.md'] });
    await store.approveObjective('human');
    await store.updateMission('tower', 'M1', { status: 'abandoned' });
    const { runner, tower } = setup();
    await settle(runner);
    const validator = (await store.load()).roster.agents.find((entry) => entry.kind === 'validator');
    expect(validator).toMatchObject({ name: 'ap-v-MS1-scrutiny-1', contractRevision: 1 });
    await tower.actAll();
    await settle(runner);
    const objective = await objectiveOf();
    expect(objective.contractRevision).toBe(1);
    expect(objective.milestones[0]!.rounds.map((round) => [round.kind, round.verdict, round.contractRevision])).toEqual([
      ['commands', 'pass', 1],
      ['scrutiny', 'pass', 1],
    ]);
    expect(objective.status).toBe('completed');
    expect(tower.notices.at(-1)!.text).toContain('is complete');
  });
});

describe('headless planning', () => {
  it('wakes a quiet headless planner once per planning progress key', async () => {
    await draft({ request: false });
    const { runner, tower } = setup();
    tower.headlessMode = true;
    await settle(runner);
    tower.clock += 179_999;
    await settle(runner);
    expect(tower.wakes).toEqual([]);
    tower.clock += 1;
    await settle(runner);
    expect(tower.wakes).toHaveLength(1);
    expect(tower.wakes[0]).toMatch(/^planning-stalled: objective O1 "Ship" has been planning for 3m 00s/);
    tower.busy = false;
    tower.clock += 600_000;
    await settle(runner);
    expect(tower.wakes).toHaveLength(1);
    await store.updateObjective({ notes: ['assumption'] });
    await settle(runner);
    tower.clock += 180_000;
    await settle(runner);
    expect(tower.wakes).toHaveLength(2);
  });

  it('a busy orchestrator restarts the planning clock and an interactive planner is never woken', async () => {
    await draft({ request: false });
    const { runner, tower } = setup();
    tower.headlessMode = true;
    await settle(runner);
    tower.clock += 170_000;
    tower.busy = true;
    await settle(runner);
    tower.busy = false;
    tower.clock += 170_000;
    await settle(runner);
    expect(tower.wakes).toEqual([]);
    tower.headlessMode = false;
    tower.clock += 999_999;
    await settle(runner);
    await settle(runner);
    expect(tower.wakes).toEqual([]);
  });
});

describe('executing', () => {
  it('records usage deltas from the moment the objective was first seen', async () => {
    await draft();
    const { runner, tower } = setup();
    tower.cost = 2;
    await settle(runner);
    await store.approveObjective('human');
    tower.cost = 3.5;
    await settle(runner);
    expect((await objectiveOf()).usage?.costUsd).toBeCloseTo(1.5);
    tower.cost = 4;
    await settle(runner);
    expect((await objectiveOf()).usage?.costUsd).toBeCloseTo(2);
  });

  it('pauses the objective at its cost budget and tells the human', async () => {
    await draft({ limits: { maxCostUsd: 1 } });
    const { runner, tower } = setup();
    await settle(runner);
    await store.approveObjective('human');
    tower.cost = 1.25;
    await settle(runner);
    const objective = await objectiveOf();
    expect(objective.status).toBe('paused');
    expect(objective.pausedReason).toMatch(/^max-cost: cost \$1\.25 reached the \$1 limit/);
    expect(tower.notices.at(-1)).toMatchObject({ level: 'warning' });
    expect(tower.notices.at(-1)!.text).toMatch(/^Objective O1 "Ship" is paused: its cost budget is used up — \$1\.25 spent of \$1\.00/);
    expect(tower.calls.filter((call) => call.startsWith('spawnWorker'))).toEqual([]);
  });

  it('respawns a dead worker as the next attempt with the previous outcome as the reason', async () => {
    await draft();
    await store.approveObjective('human');
    const { runner, tower } = setup();
    await settle(runner);
    const first = tower.agents.get('agent-ap-w-M1-1')!;
    first.status = 'failed';
    first.stopReason = 'provider crashed';
    await settle(runner);
    expect(tower.calls[1]).toBe(
      'respawnWorker M1 ap-w-M1-2 autopilot respawn, attempt 2 of 3: worker ap-w-M1-1 ended (failed: provider crashed) — continue mission M1 on its existing branch feat/core-a from where the history shows it stopped.',
    );
  });

  it('wakes the orchestrator with the M13 text when a feature used all its attempts', async () => {
    await draft({ limits: { maxFeatureAttempts: 1 } });
    await store.approveObjective('human');
    const { runner, tower } = setup();
    await settle(runner);
    tower.agents.get('agent-ap-w-M1-1')!.status = 'timeout';
    await settle(runner);
    expect(tower.wakes).toHaveLength(1);
    expect(tower.wakes[0]).toMatch(/^feature-attempts-exhausted: feature M1 "Core A" \(milestone MS1, branch feat\/core-a\) used 1 of 1 worker attempts/);
    expect(tower.wakes[0]).toContain('Last outcome: worker ap-w-M1-1 ended (timeout).');
    await settle(runner);
    expect(tower.wakes).toHaveLength(1);
    expect((await objectiveOf()).autopilot?.wakeKeys).toContain('feature-attempts-exhausted:M1:1');
  });

  it('resumes a worker that stopped silently to continue, then wakes the orchestrator once with its last message', async () => {
    await draft();
    await store.approveObjective('human');
    const question = 'Should core A store the value as JSON?\nI stop here until someone decides.';
    const { runner, tower } = setup({}, true, { ...QUIET, stopsSilently: () => question });
    const prompts: string[] = [];
    const resume = tower.resumeWorker.bind(tower);
    tower.resumeWorker = async (name, prompt) => {
      prompts.push(prompt);
      return resume(name, prompt);
    };
    await settle(runner);
    await tower.actAll();
    await settle(runner);
    expect(tower.calls).toEqual(['spawnWorker M1 ap-w-M1-1', 'resumeWorker ap-w-M1-1 continue']);
    expect(prompts[0]).toMatch(/^continue: your mission M1 "Core A" \(branch feat\/core-a\) is still active, but your last turn ended without TowerComplete, a blocker or a message/);
    expect(prompts[0]).toContain('finish with TowerComplete(report)');
    expect(prompts[0]).toContain('TowerMission(id="M1", blocker="...")');
    expect(prompts[0]).toContain('TowerSend(to="tower", subject="clarify-request"');
    expect(tower.wakes).toEqual([]);

    await tower.actAll();
    await settle(runner);
    expect(tower.wakes).toHaveLength(1);
    expect(tower.wakes[0]).toMatch(
      /^worker-idle: worker ap-w-M1-1 on feature M1 "Core A" \(milestone MS1, branch feat\/core-a\) went idle without TowerComplete, a blocker or a message, and the feature is still active\. The autopilot already resumed it once on this tip/,
    );
    expect(tower.wakes[0]).toContain('Its last message:\n> Should core A store the value as JSON?\n> I stop here until someone decides.');
    expect(tower.wakes[0]).toContain('TowerSend(to="ap-w-M1-1", ...) and resume it with TowerResume(agent="ap-w-M1-1", prompt="...")');
    expect(tower.wakes[0]).toContain('TowerSpawn(kind="worker", mission_id="M1")');
    expect(tower.wakes[0]).toContain('TowerObjective(action="block", reason)');

    await tower.actAll();
    await settle(runner);
    await settle(runner);
    expect(tower.calls.filter((call) => call.startsWith('resumeWorker'))).toHaveLength(1);
    expect(tower.wakes).toHaveLength(1);
    const tip = await git(repo, 'rev-parse', 'feat/core-a');
    expect((await objectiveOf()).autopilot?.wakeKeys).toEqual(
      expect.arrayContaining([`resume-continue:M1:${tip}`, `worker-idle:M1:${tip}`]),
    );
    const activity = await readFile(store.abs(ACTIVITY_LOG), 'utf8');
    expect(activity).toMatch(/ autopilot resume-worker mission=M1 worker=ap-w-M1-1 reason=continue name=ap-w-M1-1 result=started\n/);
    expect(activity).toMatch(/ autopilot wake-orchestrator reason=worker-idle subject=M1 result=done detail=key=worker-idle:M1:\w+\n/);
  });

  it('with the autopilot off wakes the orchestrator once and never resumes the worker itself', async () => {
    await draft();
    await store.approveObjective('human');
    const { runner, tower } = setup({ autopilot: false }, true, { ...QUIET, stopsSilently: () => '' });
    await tower.spawnWorker('M1', 'core-a-worker');
    await tower.actAll();
    await settle(runner);
    await settle(runner);
    expect(tower.calls).toEqual(['spawnWorker M1 core-a-worker', 'wake worker-idle']);
    expect(tower.wakes[0]).toContain('went idle without TowerComplete, a blocker or a message, and the feature is still active. With the autopilot off, nobody resumes it unless you do.');
    expect(tower.wakes[0]).toContain('Its last message is not available here — read it with TowerTaskOutput(agent="core-a-worker").');
  });

  it('repeats no action while its launch is pending and reports the launch as live', async () => {
    await draft();
    await store.approveObjective('human');
    const { runner, tower } = setup();
    let release: (result: EffectResult) => void = () => undefined;
    const spawn = tower.spawnWorker.bind(tower);
    tower.spawnWorker = async (missionId, name) => {
      tower.calls.push(`held ${missionId} ${name}`);
      const result = await new Promise<EffectResult>((resolve) => {
        release = resolve;
      });
      return result.ok ? spawn(missionId, name) : result;
    };
    await runner.tick('first');
    expect(runner.pendingWork()).toEqual({ agents: ['ap-w-M1-1'], validators: [] });
    await runner.tick('second');
    expect(tower.calls).toEqual(['held M1 ap-w-M1-1']);
    release({ ok: true });
    await runner.whenIdle();
    expect(runner.pendingWork()).toEqual({ agents: [], validators: [] });
    expect(tower.agents.get('agent-ap-w-M1-1')?.status).toBe('running');
  });

  it('wakes the orchestrator once with the exact error after three consecutive refusals', async () => {
    await draft();
    await store.approveObjective('human');
    const { runner, tower } = setup();
    const error = 'tower concurrency budget exhausted (4/4 agents running). Wait for a running agent to complete, then retry.';
    tower.refuse.set('spawnWorker', error);
    for (let tick = 0; tick < 6; tick += 1) {
      await settle(runner);
      tower.clock += 10_000;
    }
    const refused = tower.wakes.filter((text) => text.startsWith('autopilot-refused:'));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain('`spawn-worker` for mission M1 on 3 consecutive ticks');
    expect(refused[0]).toContain(`> ${error}`);
    expect(refused[0]).toContain('Remedy: a concurrency budget or provider rate limit clears by itself');
    expect((await objectiveOf()).autopilot?.wakeKeys).toContainEqual(expect.stringMatching(/^refused:spawn-worker:M1:[0-9a-f]{16}$/));
  });

  it('a refusal streak resets when the action is no longer decided', async () => {
    await draft();
    await store.approveObjective('human');
    const { runner, tower } = setup();
    const refusedWakes = (): string[] => tower.wakes.filter((text) => text.startsWith('autopilot-refused:'));
    tower.refuse.set('spawnWorker', 'no slot');
    await settle(runner);
    await settle(runner);
    await store.updateMission('tower', 'M1', { status: 'paused' });
    await settle(runner);
    await store.updateMission('tower', 'M1', { status: 'planned' });
    await settle(runner);
    await settle(runner);
    expect(tower.calls.filter((call) => call.startsWith('spawnWorker'))).toHaveLength(4);
    expect(refusedWakes()).toEqual([]);
    await settle(runner);
    expect(refusedWakes()).toHaveLength(1);
  });

  it('a commands run failing before it records a round counts toward the refused-action wake', async () => {
    await draft({ commands: ['true'] });
    await store.approveObjective('human');
    await store.updateMission('tower', 'M1', { status: 'abandoned' });
    const { runner, tower } = setup();
    const error = `fatal: '${repo}/.tower/worktrees/val-ms1-commands-r1' is a missing but already registered worktree; use 'add -f' to override, or 'prune' or 'remove' to clear`;
    let prepares = 0;
    store.prepareValidationWorktree = async () => {
      prepares += 1;
      throw new Error(error);
    };
    const refused = (): string[] => tower.wakes.filter((text) => text.startsWith('autopilot-refused:'));
    await settle(runner);
    tower.clock += 10_000;
    await settle(runner);
    tower.clock += 10_000;
    expect(refused()).toEqual([]);
    await settle(runner);
    expect(prepares).toBe(3);
    expect(refused()).toHaveLength(1);
    expect(refused()[0]).toContain('`start-validation` for milestone MS1 on 3 consecutive ticks');
    expect(refused()[0]).toContain(`> ${error}`);
    expect(refused()[0]).toContain('git worktree prune');
    tower.clock += 10_000;
    await settle(runner);
    await settle(runner);
    expect(prepares).toBe(5);
    expect(refused()).toHaveLength(1);
    expect((await objectiveOf()).autopilot?.wakeKeys).toContainEqual(
      expect.stringMatching(/^refused:start-validation:MS1:[0-9a-f]{40}:commands:[0-9a-f]{16}$/),
    );
    const activity = await readFile(store.abs(ACTIVITY_LOG), 'utf8');
    expect(activity).toMatch(/ autopilot commands milestone=MS1 commit=\w{7} result=failed error=fatal: /);
  });

  it('a refused validator launch wakes as soon as its third refusal settles', async () => {
    await draft({ scrutiny: true });
    await store.approveObjective('human');
    await store.updateMission('tower', 'M1', { status: 'abandoned' });
    const { runner, tower } = setup();
    tower.refuse.set('spawnValidator', 'validator model not configured');
    for (let tick = 0; tick < 3; tick += 1) {
      await settle(runner);
      tower.clock += 10_000;
    }
    const refused = tower.wakes.filter((text) => text.startsWith('autopilot-refused:'));
    expect(tower.calls.filter((call) => call.startsWith('spawnValidator'))).toHaveLength(3);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain('> validator model not configured');
  });

  it('wakes on a stall and blocks the objective after maxStallWakes', async () => {
    await draft();
    await store.approveObjective('human');
    const { runner, tower } = setup();
    tower.refuse.set('spawnWorker', 'no slot');
    for (let tick = 0; tick < 14 && (await objectiveOf()).status === 'executing'; tick += 1) {
      await settle(runner);
      tower.busy = false;
      tower.clock += 60_000;
    }
    const stalls = tower.wakes.filter((text) => text.startsWith('stalled:'));
    expect(stalls).toHaveLength(3);
    expect(stalls[0]).toMatch(/^stalled: objective O1 "Ship" has made no progress for 3m 00s — no agent is running and nothing changed \(stall wake 1 of 3\)/);
    const objective = await objectiveOf();
    expect(objective.status).toBe('blocked');
    expect(objective.blockedReason).toMatch(/^the autopilot saw no progress after 3 stall wake\(s\)/);
    expect(tower.notices.at(-1)).toMatchObject({ level: 'error' });
    expect(tower.notices.at(-1)!.text).toMatch(/^Objective O1 "Ship" is blocked: the autopilot saw no progress/);
    await settle(runner);
    await settle(runner);
    expect(tower.notices.filter((notice) => notice.level === 'error')).toHaveLength(1);
    expect(objective.autopilot?.wakeKeys).toContain(`blocked-notice:O1:${digest(objective.blockedReason!)}`);
  });

  it('stop aborts an in-flight commands run, kills its process group and removes its worktree', async () => {
    const pidFile = join(repo, 'commands.pid');
    await draft({ commands: [`echo $$ > ${pidFile}; sleep 30`] });
    await store.approveObjective('human');
    await store.updateMission('tower', 'M1', { status: 'abandoned' });
    const { runner } = setup();
    await runner.tick('validate');
    expect(runner.pendingWork().validators).toEqual([expect.objectContaining({ milestone: 'MS1', kind: 'commands' })]);
    expect(await waitUntil(() => existsSync(pidFile), 10_000)).toBe(true);
    const pid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10);
    runner.stop();
    await runner.whenIdle();
    expect(await waitUntil(() => !isAlive(pid))).toBe(true);
    const milestone = (await objectiveOf()).milestones[0]!;
    expect(milestone).toMatchObject({ status: 'validating', rounds: [] });
    expect(existsSync(join(repo, '.tower', 'worktrees', 'val-ms1-commands-r1'))).toBe(false);
    expect(runner.pendingWork().validators).toEqual([]);
  });
});

describe('terminal objectives the runner did not end itself', () => {
  it('notifies the human once when the orchestrator blocks the objective', async () => {
    await draft();
    await store.approveObjective('human');
    await store.blockObjective('the human must choose the database');
    const { runner, tower } = setup();
    await settle(runner);
    await settle(runner);
    expect(tower.notices).toHaveLength(1);
    expect(tower.notices[0]).toMatchObject({ level: 'error' });
    expect(tower.notices[0]!.text).toMatch(/^Objective O1 "Ship" is blocked: the human must choose the database\./);
    expect((await objectiveOf()).autopilot?.wakeKeys).toEqual([expect.stringMatching(/^blocked-notice:O1:[0-9a-f]{16}$/)]);
    const activity = await readFile(store.abs(ACTIVITY_LOG), 'utf8');
    expect(activity).toMatch(/ autopilot notify-human objective=O1 reason=blocked\n/);
  });

  it('notifies the human once when a validation round blocks the objective in the store', async () => {
    await draft({ commands: ['echo broken; exit 3'], limits: { maxValidationRounds: 1 } });
    await store.approveObjective('human');
    await store.updateMission('tower', 'M1', { status: 'abandoned' });
    const { runner, tower } = setup();
    await settle(runner);
    const blocked = await objectiveOf();
    expect(blocked.status).toBe('blocked');
    expect(tower.notices).toEqual([]);
    await settle(runner);
    await settle(runner);
    expect(tower.notices).toHaveLength(1);
    const notice = tower.notices[0]!;
    expect(notice.level).toBe('error');
    expect(notice.text).toContain(`Objective O1 "Ship" is blocked: ${blocked.blockedReason!}`);
    expect(notice.text).toContain('Milestone MS1 "Core" is blocked.');
    expect(notice.text).toMatch(/Latest failures:\n1\. `echo broken; exit 3` failed: exit code 3/);
  });

  it('notifies a completion reached without the runner once', async () => {
    await draft();
    await store.approveObjective('human');
    await store.updateMission('tower', 'M1', { status: 'abandoned' });
    const settings = validationSettings(SIM_SETTINGS);
    await store.startMilestoneValidation('MS1', await git(repo, 'rev-parse', 'main'), settings);
    await store.completeObjective(settings);
    const { runner, tower } = setup();
    await settle(runner);
    await settle(runner);
    expect(tower.notices).toHaveLength(1);
    expect(tower.notices[0]).toMatchObject({ level: 'info' });
    expect(tower.notices[0]!.text).toMatch(/^Objective O1 "Ship" is complete: every milestone passed validation/);
    expect((await objectiveOf()).autopilot?.wakeKeys).toEqual(['completed-notice:O1']);
  });

  it('a stopped runner sends no notice', async () => {
    await draft();
    await store.approveObjective('human');
    await store.blockObjective('waiting on the human');
    const { runner, tower } = setup({}, false);
    await settle(runner);
    expect(tower.notices).toEqual([]);
  });
});

describe('orphan commands-validation worktrees', () => {
  const worktree = (name: string): string => join(repo, '.tower', 'worktrees', name);
  const registered = (): Promise<string> => git(repo, 'worktree', 'list', '--porcelain');

  async function validating(options: { readonly scrutiny?: boolean } = {}): Promise<void> {
    await draft({ commands: ['true'], ...options });
    await store.approveObjective('human');
    await store.updateMission('tower', 'M1', { status: 'abandoned' });
    await store.startMilestoneValidation('MS1', await git(repo, 'rev-parse', 'main'), validationSettings(SIM_SETTINGS));
  }

  it('start() removes the registered commands worktrees a dead process left and keeps every other worktree', async () => {
    await validating({ scrutiny: true });
    await store.prepareValidationWorktree('MS1', 'commands');
    await store.prepareValidationWorktree('MS1', 'scrutiny');
    await mkdir(worktree('val-ms1-commands-r7'), { recursive: true });
    const { runner, log } = setup();
    await runner.whenIdle();
    expect(await registered()).not.toContain('/val-ms1-commands-r1');
    expect(existsSync(worktree('val-ms1-commands-r1'))).toBe(false);
    expect(await registered()).toContain('/val-ms1-scrutiny-r1');
    expect(existsSync(worktree('val-ms1-commands-r7'))).toBe(true);
    expect(log.warnings).toEqual([]);
    const activity = await readFile(store.abs(ACTIVITY_LOG), 'utf8');
    expect(activity).toMatch(/ tower worktree\.remove worktree=val-ms1-commands-r1\n/);
  });

  it('a commands run decided right after start() waits for the sweep, so a run that died leaves nothing behind', async () => {
    await validating();
    await store.prepareValidationWorktree('MS1', 'commands');
    const events: string[] = [];
    let preparing: () => void = () => undefined;
    const prepared = new Promise<void>((resolve) => {
      preparing = resolve;
    });
    const remove = store.removeValidationWorktree.bind(store);
    store.removeValidationWorktree = async (name) => {
      await Promise.race([prepared, new Promise((resolve) => setTimeout(resolve, 300))]);
      const removed = await remove(name);
      events.push(`removed ${name}`);
      return removed;
    };
    const prepare = store.prepareValidationWorktree.bind(store);
    store.prepareValidationWorktree = async (milestoneId, kind) => {
      events.push(`prepare ${kind}`);
      preparing();
      return prepare(milestoneId, kind);
    };
    const { runner, log } = setup();
    await settle(runner, 'restart');
    expect(events).toEqual(['removed val-ms1-commands-r1', 'prepare commands', 'removed val-ms1-commands-r1']);
    const milestone = (await objectiveOf()).milestones[0]!;
    expect(milestone.rounds.map((round) => `${round.kind}-r${String(round.round)}:${round.verdict}`)).toEqual(['commands-r1:pass']);
    expect(await registered()).not.toContain('/val-');
    expect(log.warnings).toEqual([]);
  });

  it('start() keeps the worktree of a commands run still live in this process', async () => {
    await draft({ commands: ['true'] });
    await store.approveObjective('human');
    await store.updateMission('tower', 'M1', { status: 'abandoned' });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runCommands = async (target: TowerStore, request: CommandsValidationRequest): Promise<CommandsValidationOutcome> => {
      const prepared = await target.prepareValidationWorktree(request.milestoneId, 'commands');
      await held;
      await target.removeValidationWorktree(prepared.worktree);
      return { status: 'aborted', worktree: prepared.worktree, commit: prepared.commit };
    };
    const tower = new FakeTower(store, QUIET);
    const runner = new AutopilotRunner({ observations: tower, effects: tower, timers: new FakeTimers(), log: new RecordingLog(), runCommands });
    runner.start();
    await runner.tick('validate');
    expect(await waitUntil(() => existsSync(worktree('val-ms1-commands-r1')), 10_000)).toBe(true);
    await git(repo, 'worktree', 'add', '--detach', worktree('val-ms9-commands-r1'), 'main');
    runner.stop();
    runner.start();
    expect(await waitUntil(() => !existsSync(worktree('val-ms9-commands-r1')), 10_000)).toBe(true);
    expect(existsSync(worktree('val-ms1-commands-r1'))).toBe(true);
    release();
    await runner.whenIdle();
    expect(await registered()).not.toContain('/val-');
    runner.stop();
  });

  it('start() survives a store it cannot open', () => {
    const { runner, tower, log } = setup({}, false);
    tower.store = () => {
      throw new Error('no tower workspace');
    };
    expect(() => {
      runner.start();
    }).not.toThrow();
    expect(runner.started).toBe(true);
    expect(log.warnings).toEqual([
      'tower autopilot could not look for orphan commands-validation worktrees {"error":"no tower workspace"}',
    ]);
    runner.stop();
  });
});

describe('stop during a tick', () => {
  it('stop() inside startMilestoneValidation starts no commands process and no validator', async () => {
    const pidFile = join(repo, 'commands.pid');
    await draft({ scrutiny: true, commands: [`echo $$ > ${pidFile}; sleep 30`] });
    await store.approveObjective('human');
    await store.updateMission('tower', 'M1', { status: 'abandoned' });
    const { runner, tower } = setup();
    const start = store.startMilestoneValidation.bind(store);
    store.startMilestoneValidation = async (milestoneId, commit, settings) => {
      runner.stop();
      return start(milestoneId, commit, settings);
    };
    const began = Date.now();
    await runner.tick('validate');
    await runner.whenIdle();
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(runner.pendingWork()).toEqual({ agents: [], validators: [] });
    expect(tower.calls.filter((call) => call.startsWith('spawnValidator'))).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(existsSync(pidFile)).toBe(false);
    expect(existsSync(join(repo, '.tower', 'worktrees', 'val-ms1-commands-r1'))).toBe(false);
    expect(existsSync(join(repo, '.tower', 'worktrees', 'val-ms1-scrutiny-r1'))).toBe(false);
  });

  it('stop() during a tick launches no further agent and records no progress', async () => {
    await draft({ features: ['a', 'b'] });
    await store.approveObjective('human');
    const { runner, tower } = setup();
    const spawn = tower.spawnWorker.bind(tower);
    tower.spawnWorker = async (missionId, name) => {
      runner.stop();
      return spawn(missionId, name);
    };
    await runner.tick('first');
    await runner.whenIdle();
    expect(tower.calls).toEqual(['spawnWorker M1 ap-w-M1-1']);
    expect((await objectiveOf()).autopilot).toBeUndefined();
    await settle(runner);
    expect(tower.calls).toEqual(['spawnWorker M1 ap-w-M1-1']);
  });
});

describe('agent names', () => {
  const state = (names: string[]): TowerState => ({
    version: 1,
    base: 'main',
    mode: 'branch',
    createdAt: new Date(T0).toISOString(),
    roster: {
      agents: names.map((name) => ({
        name,
        agentId: `id-${name}`,
        kind: name.startsWith('ap-r') ? 'reviewer' : name.startsWith('ap-v') ? 'validator' : 'worker',
        spawnedAt: new Date(T0).toISOString(),
        ...(name.startsWith('ap-r') ? { reviewTarget: 'feat/core-a', reviewMissionId: 'M1' } : {}),
        ...(name.startsWith('ap-v') ? { milestoneId: 'MS1', validationKind: 'scrutiny' as const, validatedCommit: 'c' } : {}),
      })),
    },
    missions: [],
  });
  const mission = {
    id: 'M1',
    title: 'Core A',
    slug: 'core-a',
    kind: 'build' as const,
    scope: ['core/a/**'],
    branch: 'feat/core-a',
    worktree: 'wt-1',
    deps: [],
    status: 'active' as const,
    tasks: [],
    notes: [],
    blockers: [],
  };

  it('are deterministic and skip names already taken', () => {
    expect(workerAgentName(state([]), 'M7', 2)).toBe('ap-w-M7-2');
    expect(workerAgentName(state(['ap-w-M7-2']), 'M7', 2)).toBe('ap-w-M7-3');
    expect(workerAgentName(state([]), 'M7', 2, new Set(['ap-w-M7-2']))).toBe('ap-w-M7-3');
    expect(reviewerAgentName(state(['ap-r-M1-1', 'ap-r-M1-2']), mission, [])).toBe('ap-r-M1-3');
    expect(
      reviewerAgentName(state([]), mission, [
        { reviewer: 'ap-r-M1-1', target: 'feat/core-a', round: 1, status: 'clean', merge: 'merge', reviewedCommit: 'c', date: 'd', file: 'f', mtimeMs: 0 },
      ]),
    ).toBe('ap-r-M1-2');
    const milestone = {
      id: 'MS2',
      title: 'Polish',
      order: 2,
      validation: { scrutiny: true, userTesting: true, commands: [] },
      status: 'validating' as const,
      rounds: [{ round: 1, kind: 'scrutiny' as const, validator: 'ap-v-MS2-scrutiny-1', validatedCommit: 'c', verdict: 'pass' as const, failures: [], file: 'f', date: 'd' }],
    };
    expect(validatorAgentName(state([]), milestone, 'scrutiny')).toBe('ap-v-MS2-scrutiny-2');
    expect(validatorAgentName(state([]), milestone, 'user-testing')).toBe('ap-v-MS2-user-testing-1');
  });
});
