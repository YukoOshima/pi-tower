import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MISSION_MODE_ENTRY, MISSION_STATUS_KEY } from '../../src/mission/constants.ts';
import { missionCommandCompletions } from '../../src/mission/command.ts';
import {
  MISSION_COMMAND_USAGE,
  MISSION_DETACHED_HEAD,
  MISSION_FILE_USAGE,
  MISSION_GOAL_QUESTION,
  MISSION_HANDED_TITLE,
  MISSION_MODELS_TEXTS,
  MISSION_NO_COMMITS,
  MISSION_STOP_USAGE,
  MISSION_SUBCOMMANDS,
  missionHandedBody,
  missionNotARepository,
  missionPlanningLine,
} from '../../src/mission/texts.ts';
import { buildObjectivePlanningPrompt } from '../../src/prompts/objectivePlanning.ts';
import { STATE_FILE, TowerStore, type TowerState } from '../../src/protocol/index.ts';
import { handleTowerCommand } from '../../src/tower/command.ts';
import { HUMAN_STOP_REASON, TOWER_MODE_ENTRY, TOWER_STATUS_KEY } from '../../src/tower/constants.ts';
import { createRepo, git, removeDir, settle } from '../tower/fakes.ts';
import {
  FOREIGN_PID,
  SESSION_ID,
  awaitingApproval,
  missionHarness,
  plannedObjective,
  recordingUi,
} from './fakes.ts';

const cleanups: string[] = [];

afterEach(async () => {
  for (const dir of cleanups.splice(0)) await removeDir(dir);
});

async function readState(repo: string): Promise<TowerState> {
  return JSON.parse(await readFile(join(repo, STATE_FILE), 'utf8')) as TowerState;
}

describe('/mission completions', () => {
  const options = {
    agentNames: () => ['rev-1', 'worker-a'],
    modelTargets: () => ['orchestrator', 'worker', 'reviewer', 'validator', 'primary'],
  };

  it('completes the subcommands, the agents after stop and the model targets after models', () => {
    expect(missionCommandCompletions('')?.map((item) => item.value)).toEqual([
      'approve',
      'pause',
      'resume',
      'models',
      'agents',
      'stop',
      'exit',
      'off',
      'help',
    ]);
    expect(missionCommandCompletions('a')?.map((item) => item.value)).toEqual(['approve', 'agents']);
    expect(missionCommandCompletions('EX')).toEqual([
      { value: 'exit', label: 'exit', description: MISSION_SUBCOMMANDS.find((item) => item.value === 'exit')?.description },
    ]);
    expect(missionCommandCompletions('stop w', options)).toEqual([{ value: 'stop worker-a', label: 'worker-a' }]);
    expect(missionCommandCompletions('models v', options)).toEqual([{ value: 'models validator', label: 'validator' }]);
    expect(missionCommandCompletions('models worker ', options)?.map((item) => item.label)).toEqual(['--clear', '--project']);
  });

  it('offers nothing for free goal text', () => {
    expect(missionCommandCompletions('zzz')).toBeNull();
    expect(missionCommandCompletions('add a csv export ')).toBeNull();
    expect(missionCommandCompletions('pause ')).toBeNull();
  });
});

describe('/mission entry', () => {
  it('turns tower mode on, switches to the orchestrator model, initializes the workspace on the current branch and arms the intake', async () => {
    const h = await missionHarness(cleanups, { global: { orchestrator: 'prov/orch-model:high', reviewer: 'prov/review-model' } });
    const orchestrator = h.ctx.modelRegistry.add('prov', 'orch-model');
    await git(h.repo, 'checkout', '-q', '-b', 'develop');

    const shown = await h.run('');

    expect(shown.errors).toEqual([]);
    expect(h.controller.isActive).toBe(true);
    expect(h.pi.modelChanges).toEqual([orchestrator]);
    expect(h.pi.thinkingLevel).toBe('high');
    expect(h.ctx.ui.statuses.get(TOWER_STATUS_KEY)).toBe('tower: on');
    expect((await readState(h.repo)).base).toBe('develop');
    expect(shown.notices).toHaveLength(1);
    expect(shown.notices[0]?.title).toBe('Mission mode');
    expect(shown.notices[0]?.body?.split('\n')).toEqual([
      '  Orchestrator  prov/orch-model · high  (global tower.json)',
      '  Worker        prov/orch-model · high  (same as orchestrator)',
      '  Reviewer      prov/review-model       (global tower.json)',
      '  Validator     same as reviewer',
      '  Base branch   develop (tower workspace initialized now) · features run in parallel (up to 256 agents)',
      '  Change a model with /mission models <role> <provider/model[:thinking]>',
      MISSION_GOAL_QUESTION,
    ]);
    expect(h.mission.active).toBe(true);
    expect(h.mission.intakeArmed).toBe(true);
    expect(h.pi.appended.map((entry) => entry.customType)).toEqual([TOWER_MODE_ENTRY, MISSION_MODE_ENTRY]);
    expect(h.pi.userMessages).toEqual([]);
    await vi.waitFor(() => {
      expect(h.ctx.ui.statuses.get(MISSION_STATUS_KEY)).toBe('mission: waiting for your goal');
    });
  });

  it('shows the configured parallelism limit and does not re-initialize an existing workspace', async () => {
    const h = await missionHarness(cleanups, { global: { maxRunningAgents: 6 } });
    await new TowerStore(h.repo).init(SESSION_ID, 'main');

    const shown = await h.run('');

    expect(shown.notices[0]?.body).toContain('  Base branch   main · features run in parallel (up to 6 agents)');
  });

  it('refuses like /tower on when another live session owns the workspace, and changes nothing', async () => {
    const h = await missionHarness(cleanups);
    await new TowerStore(h.repo).init('session-other', 'main');
    const file = join(h.repo, STATE_FILE);
    const state = JSON.parse(await readFile(file, 'utf8')) as TowerState;
    await writeFile(file, `${JSON.stringify({ ...state, ownerPid: FOREIGN_PID }, null, 2)}\n`);

    const refused = await h.run('');

    expect(refused.errors).toEqual([
      `Tower mode could not be enabled — another live session owns the workspace tower (session session-other, pid ${String(FOREIGN_PID)}).`,
    ]);
    expect(refused.notices).toEqual([]);
    expect(h.controller.isActive).toBe(false);
    expect(h.mission.active).toBe(false);
  });

  it('points a detached HEAD to /tower <base-branch> and leaves tower mode off', async () => {
    const h = await missionHarness(cleanups);
    await git(h.repo, 'checkout', '-q', '--detach');

    const refused = await h.run('');

    expect(refused.errors).toEqual([MISSION_DETACHED_HEAD]);
    expect(MISSION_DETACHED_HEAD).toContain('/tower <base-branch>');
    expect(h.controller.isActive).toBe(false);
    expect(await new TowerStore(h.repo).isInitialized()).toBe(false);
  });

  it('refuses a directory outside git and a repository without commits', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'mission-plain-'));
    cleanups.push(plain);
    const outside = await missionHarness(cleanups, { repo: plain });
    expect((await outside.run('')).errors).toEqual([missionNotARepository(plain)]);
    expect(outside.controller.isActive).toBe(false);

    const empty = await mkdtemp(join(tmpdir(), 'mission-empty-'));
    cleanups.push(empty);
    await git(empty, 'init', '-q', '-b', 'main');
    const unborn = await missionHarness(cleanups, { repo: empty });
    expect((await unborn.run('')).errors).toEqual([MISSION_NO_COMMITS]);
  });

  it('shows Mission Control instead of arming the intake while an objective is open', async () => {
    const h = await missionHarness(cleanups);
    await awaitingApproval(h.store);

    const shown = await h.run('');

    expect(shown.errors).toEqual([]);
    expect(shown.notices).toHaveLength(1);
    expect(shown.notices[0]?.title).toBe('Mission Control');
    const body = shown.notices[0]?.body ?? '';
    expect(body.startsWith('## Models\nOrchestrator  prov/session-model · medium  (session model)')).toBe(true);
    expect(body).toMatch(/\n# (Objective|Mission) O1 — CSV and JSON export\n/);
    expect(body).toMatch(/\n## [^\n]*agents/i);
    expect(body).toContain('## Commands\n/mission approve — approve the plan and start the mission');
    expect(h.mission.active).toBe(true);
    expect(h.mission.intakeArmed).toBe(false);
  });

  it('shows Mission Control for a blocked objective too', async () => {
    const h = await missionHarness(cleanups);
    await plannedObjective(h.store);
    await h.store.blockObjective('waiting for credentials');

    const shown = await h.run('');

    expect(shown.notices[0]?.title).toBe('Mission Control');
    expect(shown.notices[0]?.body).toContain('/mission <goal> — start a new mission instead');
    expect(h.mission.intakeArmed).toBe(false);
  });

  it('arms the intake for a new mission after a completed one and mentions it', async () => {
    const h = await missionHarness(cleanups);
    await plannedObjective(h.store);
    const file = join(h.repo, STATE_FILE);
    const state = JSON.parse(await readFile(file, 'utf8')) as TowerState;
    await writeFile(
      file,
      `${JSON.stringify({ ...state, objective: { ...state.objective, status: 'completed', completedAt: new Date().toISOString() } }, null, 2)}\n`,
    );

    const shown = await h.run('');

    expect(shown.notices[0]?.title).toBe('Mission mode');
    expect(shown.notices[0]?.body).toContain('Previous mission O1 "CSV and JSON export" is completed — your goal starts a new one.');
    expect(h.mission.intakeArmed).toBe(true);
  });

  it('does not re-arm after /tower objective handed a goal over that is not drafted yet', async () => {
    const h = await missionHarness(cleanups);
    await h.run('');
    expect(h.mission.intakeArmed).toBe(true);
    const { ui, recorded } = recordingUi();
    const deps = { sendUserMessage: (text: string) => h.pi.sendUserMessage(text) };
    await handleTowerCommand(h.controller, 'objective Ship a CSV export', h.ctx.asCommandContext, deps, ui);
    h.mission.onTowerCommand('objective Ship a CSV export');
    expect(recorded.errors).toEqual([]);

    const shown = await h.run('');

    expect(shown.notices[0]?.title).toBe('Mission mode');
    expect(shown.notices[0]?.body).toContain(missionPlanningLine(undefined));
    expect(h.mission.intakeArmed).toBe(false);
    expect(await h.input('CSV only, no JSON')).toEqual({ action: 'continue' });
    expect(h.pi.userMessages).toHaveLength(1);
    await vi.waitFor(() => {
      expect(h.ctx.missionStatus()).toBe('mission: planning your goal');
    });

    await plannedObjective(h.store);
    expect((await h.run('')).notices[0]?.title).toBe('Mission Control');
  });

  it('shows the planning view for a /tower objective handover made before mission mode', async () => {
    const h = await missionHarness(cleanups);
    const { ui } = recordingUi();
    const deps = { sendUserMessage: (text: string) => h.pi.sendUserMessage(text) };
    await handleTowerCommand(h.controller, 'on', h.ctx.asCommandContext, deps, ui);
    await handleTowerCommand(h.controller, 'objective Ship a CSV export', h.ctx.asCommandContext, deps, ui);

    const shown = await h.run('');

    expect(shown.notices[0]?.body).toContain(missionPlanningLine(undefined));
    expect(h.mission.intakeArmed).toBe(false);
  });
});

describe('/mission <goal> and @file', () => {
  it('enters mission mode and hands the goal over exactly like /tower objective in interactive mode', async () => {
    const h = await missionHarness(cleanups);

    const handed = await h.run('Add a --format csv|json option to shop report');

    expect(handed.errors).toEqual([]);
    expect(handed.notices).toEqual([{ title: MISSION_HANDED_TITLE, body: missionHandedBody('main') }]);
    expect(h.pi.userMessages).toEqual([
      { text: buildObjectivePlanningPrompt({ mode: 'interactive', text: 'Add a --format csv|json option to shop report' }) },
    ]);
    expect(await readState(h.repo)).toMatchObject({ base: 'main', objectiveMode: 'interactive' });
    expect(h.controller.isActive).toBe(true);
    expect(h.mission.active).toBe(true);
    expect(h.mission.intakeArmed).toBe(false);
  });

  it('reads @file goals and queues behind a busy orchestrator', async () => {
    const h = await missionHarness(cleanups);
    await writeFile(join(h.repo, 'goal.md'), '# CSV export\n\nUsers export reports as CSV.\n');
    h.ctx.idle = false;

    const handed = await h.run('@goal.md');

    expect(handed.errors).toEqual([]);
    expect(h.pi.userMessages).toEqual([
      {
        text: buildObjectivePlanningPrompt({
          mode: 'interactive',
          text: '# CSV export\n\nUsers export reports as CSV.\n',
          file: join(h.repo, 'goal.md'),
        }),
        options: { deliverAs: 'followUp' },
      },
    ]);
    expect((await h.run('@')).errors).toEqual([MISSION_FILE_USAGE]);
    expect((await h.run('@missing.md')).errors[0]).toMatch(/^\/mission failed: cannot read the objective file .*missing\.md/);
  });

  it('refuses a new goal while an objective is open, with the next step', async () => {
    const h = await missionHarness(cleanups);
    await awaitingApproval(h.store);

    const refused = await h.run('Something else entirely');

    expect(refused.errors).toEqual([
      'Mission O1 "CSV and JSON export" is awaiting-approval — a new mission starts only when none is open or the open one is still planning; approve its plan with /mission approve, or tell the orchestrator what to change.',
    ]);
    expect(h.pi.userMessages).toEqual([]);
  });

  it('treats a one-word near miss as a typo instead of a goal', async () => {
    const h = await missionHarness(cleanups);

    const refused = await h.run('status');

    expect(refused.errors[0]).toMatch(/^Unknown \/mission subcommand "status" — did you mean \/mission \(it shows Mission Control\)\?/);
    expect(h.controller.isActive).toBe(false);
    expect(h.pi.userMessages).toEqual([]);
  });
});

describe('/mission subcommands', () => {
  it('approves as the human and ticks the autopilot like /tower approve', async () => {
    const h = await missionHarness(cleanups);
    await awaitingApproval(h.store);
    await h.run('');

    const approved = await h.run('approve');

    expect(approved.errors).toEqual([]);
    expect(approved.notices).toEqual([
      {
        title: 'Mission O1 approved — executing',
        body: '"CSV and JSON export" starts now: milestone MS1 "Serializers" is active and its features run in parallel. Mission Control above the editor follows it; /mission shows the details and /mission pause stops new work.',
      },
    ]);
    expect(await readState(h.repo)).toMatchObject({ objective: { status: 'executing', approvedBy: 'human' } });
    await settle();
    expect(h.hooks.ticks).toEqual(['approve']);
    expect((await h.run('approve')).errors[0]).toMatch(/^Approval failed — objective O1 is executing/);
  });

  it('pauses with a reason and resumes with the current settings', async () => {
    const h = await missionHarness(cleanups);
    await awaitingApproval(h.store);
    await h.store.approveObjective('human');
    await h.run('');
    h.hooks.settings = { ...h.hooks.settings, maxValidationRounds: 5 };

    const paused = await h.run('pause waiting for the  budget review');
    expect(paused.notices).toEqual([
      {
        title: 'Mission O1 paused',
        body: 'Reason: waiting for the  budget review. Running agents finish their current turn; nothing new starts until /mission resume.',
      },
    ]);
    expect((await h.run('pause')).errors).toEqual(['Pause failed — objective O1 is paused — only an executing objective can be paused']);

    const resumed = await h.run('resume');
    expect(resumed.notices).toEqual([
      {
        title: 'Mission O1 resumed — executing',
        body: 'Limits from the current settings: 5 failed validation rounds per kind · 3 attempts per feature · wall time unlimited · cost unlimited.',
      },
    ]);
    expect((await readState(h.repo)).objective?.limits.maxValidationRounds).toBe(5);
    await settle();
    expect(h.hooks.ticks).toEqual(['resume']);
    expect((await h.run('resume')).errors).toEqual([
      'Resume failed — mission O1 is executing; only a paused or blocked mission can be resumed.',
    ]);
  });

  it('shows and sets the models with the mission texts', async () => {
    const h = await missionHarness(cleanups);

    const shown = await h.run('models');
    expect(shown.notices[0]?.title).toBe(MISSION_MODELS_TEXTS.title);
    expect(shown.notices[0]?.body).toMatch(/^role\s+model\s+thinking\s+source/);

    const set = await h.run('models worker prov/fast-model:low');
    expect(set.errors).toEqual([]);
    expect(set.notices[0]?.body).toContain(`Set worker = prov/fast-model:low in ${join(h.agentDir, 'tower.json')}.`);
    expect((await h.run('models worker')).errors).toEqual([MISSION_MODELS_TEXTS.usage]);
  });

  it('lists the agents and stops one as a human stop', async () => {
    const h = await missionHarness(cleanups);
    await h.run('');
    expect((await h.run('agents')).notices).toEqual([
      { title: 'Mission agents', body: 'no tower agents in this session — spawn workers and reviewers with TowerSpawn' },
    ]);
    const started = await h.runtime.spawn({ name: 'rev-1', kind: 'reviewer', description: 'review', cwd: h.repo, prompt: 'go' });
    if (!started.ok) throw new Error(started.reason);
    await h.store.registerAgent({
      name: 'rev-1',
      agentId: started.agentId,
      sessionId: SESSION_ID,
      kind: 'reviewer',
      reviewTarget: 'main',
      spawnedAt: new Date().toISOString(),
    });

    const stopped = await h.run('stop rev-1');

    expect(stopped.notices).toEqual([
      {
        title: 'Stopped rev-1',
        body: `rev-1 (agent_id: ${started.agentId}) is stopped by you — dead by intent: the orchestrator will not resume, reassign or replace it unless you say so.`,
      },
    ]);
    expect(h.runtime.stops).toEqual([{ id: started.agentId, reason: HUMAN_STOP_REASON }]);
    expect((await h.run('stop rev-1')).statuses).toEqual(['rev-1 is not running — nothing was stopped.']);
    expect((await h.run('stop')).errors).toEqual([MISSION_STOP_USAGE]);
    expect((await h.run('stop ghost')).errors).toEqual(['unknown tower agent "ghost" — known agents: rev-1']);
  });

  it('exits like /tower off, clearing the mission status, and says when it is already off', async () => {
    const h = await missionHarness(cleanups);
    await h.run('');
    await vi.waitFor(() => {
      expect(h.ctx.missionStatus()).toBe('mission: waiting for your goal');
    });

    const exited = await h.run('exit');

    expect(exited.notices).toEqual([
      {
        title: 'Mission mode: OFF',
        body: 'Tower mode is off as well; running agents keep running and .tower/ stays on disk. /mission enters mission mode again.',
      },
    ]);
    expect(h.controller.isActive).toBe(false);
    expect(h.mission.active).toBe(false);
    expect(h.mission.intakeArmed).toBe(false);
    expect(h.ctx.ui.statuses.get(TOWER_STATUS_KEY)).toBeUndefined();
    expect(h.ctx.missionStatus()).toBeUndefined();
    expect(h.pi.appended.at(-1)).toEqual({ customType: MISSION_MODE_ENTRY, data: { active: false } });
    expect((await h.run('off')).statuses).toEqual(['Mission mode is already off.']);
  });

  it('shows the usage for help', async () => {
    const h = await missionHarness(cleanups);

    expect((await h.run('help')).notices).toEqual([{ title: 'Mission command', body: MISSION_COMMAND_USAGE }]);
    for (const line of ['/mission approve', '/mission pause [reason]', '/mission resume', '/mission models', '/mission agents', '/mission stop <agent>', '/mission exit']) {
      expect(MISSION_COMMAND_USAGE).toContain(line);
    }
    expect(h.controller.isActive).toBe(false);
  });

  it('does not touch the workspace for subcommands that only read', async () => {
    const repo = await createRepo('mission-read-');
    cleanups.push(repo);
    const h = await missionHarness(cleanups, { repo });

    await h.run('help');
    await h.run('agents');

    expect(await new TowerStore(repo).isInitialized()).toBe(false);
    expect(h.pi.appended).toEqual([]);
  });
});
