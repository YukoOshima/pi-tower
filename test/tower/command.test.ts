import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TOWER_TEARDOWN_PROMPT } from '../../src/prompts/index.ts';
import { buildObjectivePlanningPrompt } from '../../src/prompts/objectivePlanning.ts';
import { renderObjectiveStatus } from '../../src/prompts/objectiveStatus.ts';
import { STATE_FILE, TowerStore, objectiveMissions, type TowerState } from '../../src/protocol/index.ts';
import {
  TOWER_COMMAND_USAGE,
  TOWER_OBJECTIVE_USAGE,
  commandUi,
  handleTowerCommand,
  towerCommandCompletions,
  type ObjectiveSettingsValues,
  type TowerCommandDeps,
  type TowerCommandUi,
  type TowerObjectiveCommandHooks,
} from '../../src/tower/command.ts';
import {
  HUMAN_STOP_REASON,
  TOWER_AGENT_NOTIFICATION_MESSAGE,
  TOWER_MODE_ENTRY,
  TOWER_MODE_TOOLS,
  TOWER_STATUS_KEY,
} from '../../src/tower/constants.ts';
import { TowerController } from '../../src/tower/controller.ts';
import {
  FakeContext,
  FakePi,
  FakeRuntime,
  FakeSessionManager,
  createRepo,
  git,
  removeDir,
  sentText,
  settle,
} from './fakes.ts';

const SESSION_ID = 'session-command';
const FOREIGN_PID = 515_151;

const cleanups: string[] = [];

afterEach(async () => {
  for (const dir of cleanups.splice(0)) await removeDir(dir);
});

interface Recorded {
  readonly notices: { readonly title: string; readonly body?: string }[];
  readonly statuses: string[];
  readonly warnings: string[];
  readonly errors: string[];
}

interface Harness {
  readonly repo: string;
  readonly ctx: FakeContext;
  readonly pi: FakePi;
  readonly runtime: FakeRuntime;
  readonly controller: TowerController;
  readonly modelsCalls: string[][];
  run(args: string, deps?: TowerCommandDeps): Promise<Recorded>;
}

function recordingUi(): { readonly ui: TowerCommandUi; readonly recorded: Recorded } {
  const recorded: Recorded = { notices: [], statuses: [], warnings: [], errors: [] };
  return {
    recorded,
    ui: {
      notice: (title, body) => {
        recorded.notices.push(body === undefined ? { title } : { title, body });
      },
      status: (text) => {
        recorded.statuses.push(text);
      },
      warn: (text) => {
        recorded.warnings.push(text);
      },
      error: (text) => {
        recorded.errors.push(text);
      },
    },
  };
}

async function harness(): Promise<Harness> {
  const repo = await createRepo('tower-command-');
  cleanups.push(repo);
  const session = new FakeSessionManager(SESSION_ID);
  const ctx = new FakeContext(repo, session);
  const pi = new FakePi();
  pi.session = session;
  pi.context = ctx;
  const runtime = new FakeRuntime();
  const controller = new TowerController({
    pi,
    createRuntime: () => runtime,
    isProcessAlive: (pid) => pid === process.pid || pid === FOREIGN_PID,
  });
  controller.observe(ctx.asContext);
  expect(controller.runtime).toBe(runtime);
  const modelsCalls: string[][] = [];
  const defaults: TowerCommandDeps = {
    sendUserMessage: (text, options) => {
      pi.sendUserMessage(text, options);
    },
    models: async (args, ui) => {
      modelsCalls.push([...args]);
      ui.notice('Tower models');
    },
  };
  return {
    repo,
    ctx,
    pi,
    runtime,
    controller,
    modelsCalls,
    async run(args, deps = defaults) {
      const { ui, recorded } = recordingUi();
      await handleTowerCommand(controller, args, ctx.asCommandContext, deps, ui);
      return recorded;
    },
  };
}

async function setOwner(repo: string, patch: Partial<Pick<TowerState, 'sessionId' | 'ownerPid'>>): Promise<void> {
  const file = join(repo, STATE_FILE);
  const state = JSON.parse(await readFile(file, 'utf8')) as TowerState;
  await writeFile(file, `${JSON.stringify({ ...state, ...patch }, null, 2)}\n`);
}

async function spawnReviewer(h: Harness, name: string): Promise<string> {
  const started = await h.runtime.spawn({
    name,
    kind: 'reviewer',
    description: `review ${name}`,
    cwd: h.repo,
    prompt: 'review it',
    model: 'prov/review-model',
    thinkingLevel: 'high',
  });
  if (!started.ok) throw new Error(started.reason);
  await new TowerStore(h.repo).registerAgent({
    name,
    agentId: started.agentId,
    sessionId: SESSION_ID,
    kind: 'reviewer',
    reviewTarget: 'main',
    model: 'prov/review-model',
    spawnedAt: new Date().toISOString(),
  });
  return started.agentId;
}

describe('/tower status', () => {
  it('reads tower status without args, without prompting or touching the mode', async () => {
    const h = await harness();

    const shown = await h.run('');

    expect(shown.notices).toEqual([{ title: 'Tower mode: OFF' }]);
    expect(shown.errors).toEqual([]);
    expect(h.controller.isActive).toBe(false);
    expect(h.pi.appended).toEqual([]);
    expect(h.pi.userMessages).toEqual([]);
  });

  it('reports active but uninitialized status without calling it OFF', async () => {
    const h = await harness();
    await h.run('on');

    const shown = await h.run('status');

    expect(shown.notices).toEqual([{ title: 'Tower mode: ON', body: 'Tower is not initialized.' }]);
    expect(h.pi.userMessages).toEqual([]);
  });

  it('lifts the first line of the rendered summary into the notice title', async () => {
    const h = await harness();
    const store = new TowerStore(h.repo);
    await store.init(SESSION_ID, 'main');
    await store.plan([{ title: 'Build engine', scope: ['src/engine/**'] }]);
    await h.run('on');

    const on = await h.run('status');

    expect(on.notices).toHaveLength(1);
    expect(on.notices[0]?.title).toBe('Tower status — ON');
    const body = on.notices[0]?.body ?? '';
    expect(body.split('\n')[0]).toMatch(/^Base: main \(mode: [a-z-]+\) · You are: /);
    expect(body).toContain('Missions:\n  M1 Build engine — planned · owner — · feat/build-engine');
    expect(body).toContain('Inbox: ');
    expect(body).toContain('Concurrency: ');

    await h.run('off');
    const off = await h.run('status');

    expect(off.notices[0]?.title).toBe('Tower mode: OFF');
    expect(off.notices[0]?.body).toContain('M1 Build engine');
    expect(h.pi.userMessages).toEqual([]);
  });

  it('shows status errors without a prompt fallback', async () => {
    const h = await harness();
    await new TowerStore(h.repo).init(SESSION_ID, 'main');
    await writeFile(join(h.repo, STATE_FILE), '{ corrupt');

    const shown = await h.run('status');

    expect(shown.notices).toEqual([]);
    expect(shown.errors).toHaveLength(1);
    expect(shown.errors[0]).toMatch(/^Failed to read tower status: /);
    expect(h.pi.userMessages).toEqual([]);
  });
});

describe('/tower teardown', () => {
  it('sends the teardown instruction without touching the mode, as a follow-up while the agent is busy', async () => {
    const h = await harness();

    await h.run('teardown');
    h.ctx.idle = false;
    await h.run('teardown');

    expect(h.pi.userMessages).toEqual([
      { text: TOWER_TEARDOWN_PROMPT },
      { text: TOWER_TEARDOWN_PROMPT, options: { deliverAs: 'followUp' } },
    ]);
    expect(h.controller.isActive).toBe(false);
    expect(h.pi.appended).toEqual([]);
  });
});

describe('/tower on, off and <base>', () => {
  it('turns tower mode on with an explicit on subcommand', async () => {
    const h = await harness();

    const on = await h.run('on');

    expect(on.notices).toEqual([{ title: 'Tower mode: ON' }]);
    expect(on.errors).toEqual([]);
    expect(h.controller.isActive).toBe(true);
    for (const name of TOWER_MODE_TOOLS) expect(h.pi.activeTools).toContain(name);
    expect(h.ctx.ui.statuses.get(TOWER_STATUS_KEY)).toBe('tower: on');
    expect(h.pi.userMessages).toEqual([]);
  });

  it('turns tower mode off with an explicit off subcommand and keeps the tower tools active', async () => {
    const h = await harness();
    await h.run('on');

    const off = await h.run('off');

    expect(off.notices).toEqual([{ title: 'Tower mode: OFF' }]);
    expect(h.controller.isActive).toBe(false);
    for (const name of TOWER_MODE_TOOLS) expect(h.pi.activeTools).toContain(name);
    expect(h.ctx.ui.statuses.get(TOWER_STATUS_KEY)).toBeUndefined();
    expect(h.pi.userMessages).toEqual([]);
  });

  it('reasserts the mode idempotently when tower mode is already on', async () => {
    const h = await harness();
    await h.run('on');

    const again = await h.run('on');

    expect(again.statuses).toEqual(['Tower mode is already on.']);
    expect(again.notices).toEqual([]);
    expect(h.pi.appended.filter((entry) => entry.customType === TOWER_MODE_ENTRY)).toHaveLength(1);
  });

  it('reasserts the mode idempotently when tower mode is already off', async () => {
    const h = await harness();

    const off = await h.run('OFF');

    expect(off.statuses).toEqual(['Tower mode is already off.']);
    expect(off.notices).toEqual([]);
    expect(h.pi.appended).toEqual([]);
  });

  it('turns tower mode on with a base branch', async () => {
    const h = await harness();

    const on = await h.run('develop');

    expect(on.notices).toEqual([{ title: 'Tower mode: ON (base: develop)' }]);
    expect(h.controller.isActive).toBe(true);
    expect(await git(h.repo, 'branch', '--show-current')).toBe('develop');
    expect((await new TowerStore(h.repo).load()).base).toBe('develop');
  });

  it('updates the base when tower mode is already on', async () => {
    const h = await harness();
    await git(h.repo, 'branch', 'develop');
    await h.run('main');

    const moved = await h.run('develop');

    expect(moved.notices).toEqual([{ title: 'Tower base: develop' }]);
    expect((await new TowerStore(h.repo).load()).base).toBe('develop');
  });

  it('does not show the base notice when enabling with a base fails', async () => {
    const h = await harness();

    const refused = await h.run('no..dots');

    expect(refused.notices).toEqual([]);
    expect(refused.errors).toHaveLength(1);
    expect(refused.errors[0]).toMatch(/^Failed to enable tower mode: /);
    expect(h.controller.isActive).toBe(false);
    expect(h.pi.userMessages).toEqual([]);
  });

  it('reports a failure when enabling tower mode fails', async () => {
    const h = await harness();
    await new TowerStore(h.repo).init(SESSION_ID, 'main');
    await writeFile(join(h.repo, STATE_FILE), '{ corrupt');

    const refused = await h.run('on');

    expect(refused.errors).toHaveLength(1);
    expect(refused.errors[0]).toMatch(/^Failed to enable tower mode: /);
    expect(refused.notices).toEqual([]);
    expect(h.controller.isActive).toBe(false);
  });

  it('reports a failure when disabling tower mode fails and leaves the mode on', async () => {
    const h = await harness();
    await h.run('on');
    h.pi.appendEntry = () => {
      throw new Error('denied');
    };

    const refused = await h.run('off');

    expect(refused.errors).toEqual(['Failed to disable tower mode: denied']);
    expect(refused.notices).toEqual([]);
    expect(h.controller.isActive).toBe(true);
    expect(h.ctx.ui.statuses.get(TOWER_STATUS_KEY)).toBe('tower: on');
  });

  it('does not show ON when another live session owns the workspace tower', async () => {
    const h = await harness();
    await new TowerStore(h.repo).init('session-other', 'main');
    await setOwner(h.repo, { ownerPid: FOREIGN_PID });

    const refused = await h.run('on');

    expect(refused.errors).toEqual([
      `Tower mode could not be enabled — another live session owns the workspace tower (session session-other, pid ${String(FOREIGN_PID)}).`,
    ]);
    expect(refused.notices).toEqual([]);
    expect(h.controller.isActive).toBe(false);
    expect(h.pi.activeTools).not.toContain('TowerInit');
  });
});

describe('/tower agents and /tower stop', () => {
  it('lists the tower agents with their model and thinking level', async () => {
    const h = await harness();
    await new TowerStore(h.repo).init(SESSION_ID, 'main');
    await h.run('on');

    const empty = await h.run('agents');
    expect(empty.notices).toEqual([
      { title: 'Tower agents', body: 'no tower agents in this session — spawn workers and reviewers with TowerSpawn' },
    ]);

    await spawnReviewer(h, 'rev-1');
    const listed = await h.run('agents');

    expect(listed.notices[0]?.title).toBe('Tower agents');
    const body = listed.notices[0]?.body ?? '';
    expect(body).toContain('1 tower agent(s) in this session:');
    expect(body).toContain('rev-1');
    expect(body).toContain('model: prov/review-model · thinking: high');
  });

  it('stops a running agent as a human stop, which the tower must never resume', async () => {
    const h = await harness();
    await new TowerStore(h.repo).init(SESSION_ID, 'main');
    await h.run('on');
    const agentId = await spawnReviewer(h, 'rev-1');

    const stopped = await h.run('stop rev-1');
    await settle();

    expect(h.runtime.stops).toEqual([{ id: agentId, reason: HUMAN_STOP_REASON }]);
    expect(stopped.notices).toEqual([
      {
        title: 'Stopped rev-1',
        body: `rev-1 (agent_id: ${agentId}) is stopped by you — dead by intent: the tower will not resume, reassign, or replace it unless you say so.`,
      },
    ]);
    const notification = h.pi.sentOfType(TOWER_AGENT_NOTIFICATION_MESSAGE).at(-1);
    expect(sentText(notification)).toContain('The human stopped this reviewer');
    await vi.waitFor(async () => {
      const state = await new TowerStore(h.repo).load();
      expect(state.roster.agents[0]).toMatchObject({ deathStatus: 'stopped', deathReason: HUMAN_STOP_REASON });
    });

    const again = await h.run(`stop ${agentId}`);
    expect(again.statuses).toEqual(['rev-1 is not running — nothing was stopped.']);
    expect(h.runtime.stops).toHaveLength(1);
  });

  it('requires an agent and refuses unknown agents with the known names', async () => {
    const h = await harness();
    await new TowerStore(h.repo).init(SESSION_ID, 'main');
    await h.run('on');
    await spawnReviewer(h, 'rev-1');

    expect((await h.run('stop')).errors).toEqual([
      'Usage: /tower stop <agent> — pass the roster name, agent id, or task id of a running agent',
    ]);
    expect((await h.run('stop ghost')).errors).toEqual(['unknown tower agent "ghost" — known agents: rev-1']);
    expect(h.runtime.stops).toEqual([]);
  });
});

describe('/tower models', () => {
  it('hands the remaining words to the models handler unchanged', async () => {
    const h = await harness();

    const shown = await h.run('models Worker prov/x:high --project');

    expect(h.modelsCalls).toEqual([['Worker', 'prov/x:high', '--project']]);
    expect(shown.notices).toEqual([{ title: 'Tower models' }]);
  });

  it('reports when model configuration is unavailable', async () => {
    const h = await harness();

    const shown = await h.run('models', { sendUserMessage: () => undefined });

    expect(shown.errors).toEqual(['Tower model configuration is not available in this build.']);
  });
});

describe('/tower help and typo safety', () => {
  it('shows the usage for /tower help', async () => {
    const h = await harness();

    const shown = await h.run('help');

    expect(shown.notices).toEqual([{ title: 'Tower command', body: TOWER_COMMAND_USAGE }]);
    expect(h.controller.isActive).toBe(false);
  });

  it.each([
    ['model', '/tower models'],
    ['config', '/tower models'],
    ['agent', '/tower agents'],
    ['task', '/tower agents (or /tower stop <agent>)'],
    ['tasks', '/tower agents (or /tower stop <agent>)'],
    ['list', '/tower agents'],
    ['start', '/tower on'],
  ])('refuses the near-miss "/tower %s" with a hint instead of creating a branch', async (word, suggestion) => {
    const h = await harness();

    const refused = await h.run(word);

    expect(refused.errors).toEqual([
      `Unknown /tower subcommand "${word}" — did you mean ${suggestion}? Run /tower help for usage; /tower <base-branch> starts the tower on a branch.`,
    ]);
    expect(await git(h.repo, 'branch', '--list', word)).toBe('');
    expect(h.controller.isActive).toBe(false);
    expect(h.ctx.confirms).toEqual([]);
  });

  it('re-anchors on a near-miss word only once it names an existing local branch', async () => {
    const h = await harness();
    await h.run('main');

    expect((await h.run('config')).errors).toEqual([
      'Unknown /tower subcommand "config" — did you mean /tower models? Run /tower help for usage; /tower <base-branch> starts the tower on a branch.',
    ]);
    expect((await new TowerStore(h.repo).load()).base).toBe('main');

    await git(h.repo, 'branch', 'config');
    const moved = await h.run('config');

    expect(moved.errors).toEqual([]);
    expect(moved.notices).toEqual([{ title: 'Tower base: config' }]);
    expect(h.ctx.confirms).toEqual([]);
    expect((await new TowerStore(h.repo).load()).base).toBe('config');
  });

  it('turns tower mode on from an existing local branch named like a near-miss', async () => {
    const h = await harness();
    await git(h.repo, 'branch', 'start');

    const on = await h.run('start');

    expect(on.errors).toEqual([]);
    expect(on.notices).toEqual([{ title: 'Tower mode: ON (base: start)' }]);
    expect((await new TowerStore(h.repo).load()).base).toBe('start');
    expect(h.ctx.confirms).toEqual([]);
  });

  it('refuses argument-less subcommands with trailing words, multi-word bases and a bare stop', async () => {
    const h = await harness();

    expect((await h.run('on now')).errors).toEqual(['/tower on takes no arguments — did you mean /tower on? Run /tower help for usage.']);
    expect((await h.run('off please')).errors).toEqual([
      '/tower off takes no arguments — did you mean /tower off? Run /tower help for usage.',
    ]);
    expect((await h.run('status all')).errors).toEqual([
      '/tower status takes no arguments — did you mean /tower status? Run /tower help for usage.',
    ]);
    expect((await h.run('my feature')).errors).toEqual([
      '"my feature" is not a branch name — /tower <base-branch> takes a single branch name. Run /tower help for usage.',
    ]);
    expect((await h.run('stop')).errors).toEqual([
      'Usage: /tower stop <agent> — pass the roster name, agent id, or task id of a running agent',
    ]);
    expect(h.controller.isActive).toBe(false);
    expect(await git(h.repo, 'branch', '--list')).toBe('* main');
  });

  it('asks before creating a new base branch when there is a UI and changes nothing when declined', async () => {
    const h = await harness();
    h.ctx.confirmAnswer = false;

    const declined = await h.run('develop');

    expect(h.ctx.confirms).toEqual([
      { title: 'Create branch "develop"?', message: expect.stringContaining('creates it from the current HEAD') as unknown as string },
    ]);
    expect(declined.statuses).toEqual(['Cancelled — branch "develop" was not created and tower mode is unchanged.']);
    expect(await git(h.repo, 'branch', '--list', 'develop')).toBe('');
    expect(h.controller.isActive).toBe(false);

    h.ctx.confirmAnswer = true;
    const accepted = await h.run('develop');

    expect(accepted.notices).toEqual([{ title: 'Tower mode: ON (base: develop)' }]);
    expect(h.ctx.confirms).toHaveLength(2);
  });

  it('does not ask for an existing branch, nor when there is no UI', async () => {
    const h = await harness();

    await h.run('main');
    expect(h.ctx.confirms).toEqual([]);

    h.ctx.hasUI = false;
    const headless = await h.run('integration');

    expect(h.ctx.confirms).toEqual([]);
    expect(headless.notices).toEqual([{ title: 'Tower base: integration' }]);
    expect((await new TowerStore(h.repo).load()).base).toBe('integration');
  });
});

describe('towerCommandCompletions', () => {
  const options = {
    agentNames: () => ['rev-1', 'worker-a'],
    modelTargets: () => ['orchestrator', 'worker', 'reviewer', 'primary', 'fast'],
  };

  it('completes the subcommands case-insensitively', () => {
    expect(towerCommandCompletions('')?.map((item) => item.value)).toEqual([
      'on',
      'off',
      'status',
      'teardown',
      'models',
      'agents',
      'stop',
      'objective',
      'approve',
      'pause',
      'resume',
      'help',
    ]);
    expect(towerCommandCompletions('st')?.map((item) => item.value)).toEqual(['status', 'stop']);
    expect(towerCommandCompletions('O')?.map((item) => item.value)).toEqual(['on', 'off', 'objective']);
    expect(towerCommandCompletions('zzz')).toBeNull();
  });

  it('completes agent names after stop', () => {
    expect(towerCommandCompletions('stop ', options)).toEqual([
      { value: 'stop rev-1', label: 'rev-1' },
      { value: 'stop worker-a', label: 'worker-a' },
    ]);
    expect(towerCommandCompletions('stop w', options)).toEqual([{ value: 'stop worker-a', label: 'worker-a' }]);
    expect(towerCommandCompletions('stop zz', options)).toBeNull();
  });

  it('completes model targets and the write options after models', () => {
    expect(towerCommandCompletions('models ', options)?.map((item) => item.label)).toEqual([
      'orchestrator',
      'worker',
      'reviewer',
      'primary',
      'fast',
    ]);
    expect(towerCommandCompletions('models f', options)).toEqual([{ value: 'models fast', label: 'fast' }]);
    expect(towerCommandCompletions('models worker ', options)).toEqual([
      { value: 'models worker --clear', label: '--clear' },
      { value: 'models worker --project', label: '--project' },
    ]);
    expect(towerCommandCompletions('models worker --clear --p', options)).toEqual([
      { value: 'models worker --clear --project', label: '--project' },
    ]);
    expect(towerCommandCompletions('models worker prov/x --project ', options)).toBeNull();
    expect(towerCommandCompletions('on ', options)).toBeNull();
  });
});

describe('commandUi', () => {
  it('notifies through the pi UI with matching levels', () => {
    const ctx = new FakeContext('/tmp', new FakeSessionManager('session-ui'));
    const ui = commandUi(ctx.asCommandContext);

    ui.notice('Tower mode: ON (base: develop)');
    ui.notice('Tower models', 'role  model');
    ui.status('Tower mode is already on.');
    ui.warn('worker is shadowed');
    ui.error('Failed to enable tower mode: denied');

    expect(ctx.ui.notices).toEqual([
      { message: 'Tower mode: ON (base: develop)', level: 'info' },
      { message: 'Tower models\nrole  model', level: 'info' },
      { message: 'Tower mode is already on.', level: 'info' },
      { message: 'worker is shadowed', level: 'warning' },
      { message: 'Failed to enable tower mode: denied', level: 'error' },
    ]);
  });

  it('prints to stdout, and errors to stderr, in print mode without a UI', () => {
    const ctx = new FakeContext('/tmp', new FakeSessionManager('session-print'));
    ctx.hasUI = false;
    ctx.mode = 'print';
    const ui = commandUi(ctx.asCommandContext);
    const written: string[] = [];
    const errored: string[] = [];
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      errored.push(String(chunk));
      return true;
    });
    try {
      ui.notice('Tower mode: OFF');
      ui.error('Failed to read tower status: boom');
    } finally {
      out.mockRestore();
      err.mockRestore();
    }

    expect(written).toContain('Tower mode: OFF\n');
    expect(errored).toContain('Failed to read tower status: boom\n');
    expect(written).not.toContain('Failed to read tower status: boom\n');
    expect(ctx.ui.notices).toEqual([]);
  });
});

interface FakeObjectiveHooks extends TowerObjectiveCommandHooks {
  readonly ticks: string[];
  settings: ObjectiveSettingsValues;
  tickError: Error | undefined;
}

function fakeObjectiveHooks(): FakeObjectiveHooks {
  const hooks: FakeObjectiveHooks = {
    ticks: [],
    settings: {
      autopilot: true,
      autoApprove: false,
      maxValidationRounds: 3,
      maxFeatureAttempts: 3,
      skipScrutiny: false,
      skipUserTesting: false,
    },
    tickError: undefined,
    async autopilotTick(reason) {
      hooks.ticks.push(reason);
      if (hooks.tickError !== undefined) throw hooks.tickError;
    },
    objectiveSettings: () => hooks.settings,
  };
  return hooks;
}

function objectiveDeps(h: Harness, hooks?: TowerObjectiveCommandHooks): TowerCommandDeps {
  return {
    sendUserMessage: (text, options) => {
      h.pi.sendUserMessage(text, options);
    },
    ...(hooks === undefined ? {} : { objective: hooks }),
  };
}

async function readTowerState(repo: string): Promise<TowerState> {
  return JSON.parse(await readFile(join(repo, STATE_FILE), 'utf8')) as TowerState;
}

async function plannedObjective(repo: string): Promise<TowerStore> {
  const store = new TowerStore(repo);
  await store.init(SESSION_ID, 'main');
  await store.draftObjective({
    title: 'Ship',
    goal: 'ship it',
    definitionOfDone: ['works'],
    milestones: [{ title: 'Core' }, { title: 'Polish' }],
  });
  await store.plan([{ title: 'Core work', scope: ['src/core/**'], milestone: 'MS1' }]);
  return store;
}

async function approvedObjective(repo: string): Promise<TowerStore> {
  const store = await plannedObjective(repo);
  await store.requestObjectiveApproval();
  await store.approveObjective('human');
  return store;
}

describe('/tower objective', () => {
  it('shows the usage for a missing or malformed objective before anything else', async () => {
    const h = await harness();

    for (const args of ['objective', 'objective   ', 'objective --headless', 'objective --verbose ship it', 'objective @', 'objective --headless @  ']) {
      expect((await h.run(args)).errors, args).toEqual([TOWER_OBJECTIVE_USAGE]);
    }
    expect(h.pi.userMessages).toEqual([]);
  });

  it('requires tower mode and changes nothing while it is off', async () => {
    const h = await harness();

    const refused = await h.run('objective Ship a CSV export');

    expect(refused.errors).toEqual([
      'Tower mode is off — turn it on with /tower on, then hand the objective over with /tower objective.',
    ]);
    expect(refused.notices).toEqual([]);
    expect(h.pi.userMessages).toEqual([]);
    expect(await new TowerStore(h.repo).isInitialized()).toBe(false);
  });

  it('initializes the workspace, records the interactive mode and hands the planning prompt over at once', async () => {
    const h = await harness();
    await h.run('on');

    const handed = await h.run('objective Ship a CSV export   with headers');

    expect(handed.errors).toEqual([]);
    expect(handed.notices).toEqual([
      {
        title: 'Objective handed to the tower',
        body: 'Initialized the tower workspace on base "main". The orchestrator plans it with you, then asks you to approve the plan with /tower approve.',
      },
    ]);
    expect(h.pi.userMessages).toEqual([
      { text: buildObjectivePlanningPrompt({ mode: 'interactive', text: 'Ship a CSV export   with headers' }) },
    ]);
    const state = await readTowerState(h.repo);
    expect(state).toMatchObject({ base: 'main', sessionId: SESSION_ID, objectiveMode: 'interactive' });
    expect(state.objective).toBeUndefined();
  });

  it('reads an @file whose path has spaces, plans headless, and queues behind a busy agent', async () => {
    const h = await harness();
    await new TowerStore(h.repo).init(SESSION_ID, 'main');
    await mkdir(join(h.repo, 'specs dir'));
    const file = join(h.repo, 'specs dir', 'objective file.md');
    await writeFile(file, '# CSV export\n\nUsers export reports as CSV.\n');
    await h.run('on');
    h.ctx.idle = false;

    const handed = await h.run(`Objective --Headless @${file}`);

    expect(handed.errors).toEqual([]);
    expect(handed.notices).toEqual([
      {
        title: 'Objective handed to the tower (headless)',
        body: 'The orchestrator plans it without asking questions, records its assumptions as notes, and requests approval.',
      },
    ]);
    expect(h.pi.userMessages).toEqual([
      {
        text: buildObjectivePlanningPrompt({ mode: 'headless', text: '# CSV export\n\nUsers export reports as CSV.\n', file }),
        options: { deliverAs: 'followUp' },
      },
    ]);
    expect((await readTowerState(h.repo)).objectiveMode).toBe('headless');

    h.ctx.idle = true;
    await h.run('objective @specs dir/objective file.md');
    expect(h.pi.userMessages[1]).toEqual({
      text: buildObjectivePlanningPrompt({ mode: 'interactive', text: '# CSV export\n\nUsers export reports as CSV.\n', file }),
    });
    expect((await readTowerState(h.repo)).objectiveMode).toBe('interactive');
  });

  it('reports an unreadable or empty objective file', async () => {
    const h = await harness();
    await h.run('on');
    await writeFile(join(h.repo, 'empty.md'), ' \n\n');

    const missing = await h.run('objective @missing.md');
    const empty = await h.run('objective --headless @empty.md');

    expect(missing.errors).toEqual([
      expect.stringMatching(/^\/tower objective failed: cannot read the objective file .*\/missing\.md: ENOENT/) as unknown as string,
    ]);
    expect(empty.errors).toEqual([`/tower objective failed: the objective file ${join(h.repo, 'empty.md')} is empty`]);
    expect(h.pi.userMessages).toEqual([]);
  });

  it('revises a planning objective and refuses an open one with guidance', async () => {
    const h = await harness();
    const store = await plannedObjective(h.repo);
    await h.run('on');

    const planning = await h.run('objective --headless Ship it, headless');
    expect(planning.errors).toEqual([]);
    expect(h.pi.userMessages).toEqual([
      {
        text: buildObjectivePlanningPrompt({
          mode: 'headless',
          text: 'Ship it, headless',
          current: { id: 'O1', title: 'Ship', status: 'planning' },
        }),
      },
    ]);

    const refusal = (status: string, next: string) =>
      `Objective O1 "Ship" is ${status} — /tower objective plans a new objective only when none is open or the open one is still planning. See it with /tower objective status; ${next}.`;
    await store.requestObjectiveApproval();
    expect((await h.run('objective again')).errors).toEqual([
      refusal('awaiting-approval', 'approve its plan with /tower approve, or ask the tower to change it'),
    ]);
    await store.approveObjective('auto');
    expect((await h.run('objective again')).errors).toEqual([
      refusal(
        'executing',
        'let the fleet finish it, ask the tower to block it, or wait until it completes or blocks — pausing does not help: a paused objective is refused too',
      ),
    ]);
    await store.pauseObjective('lunch');
    expect((await h.run('objective again')).errors).toEqual([
      refusal('paused', 'continue it with /tower resume, or ask the tower to block it first'),
    ]);
    expect(h.pi.userMessages).toHaveLength(1);
    expect((await readTowerState(h.repo)).objectiveMode).toBe('headless');

    await store.blockObjective('the human changed their mind');
    const blocked = await h.run('objective Something else');
    expect(blocked.errors).toEqual([]);
    expect(h.pi.userMessages[1]).toEqual({
      text: buildObjectivePlanningPrompt({
        mode: 'interactive',
        text: 'Something else',
        current: { id: 'O1', title: 'Ship', status: 'blocked' },
      }),
    });
  });

  it('refuses to initialize a lost state or a directory outside git', async () => {
    const h = await harness();
    await new TowerStore(h.repo).init(SESSION_ID, 'main');
    await h.run('on');
    await rm(join(h.repo, STATE_FILE));

    const lost = await h.run('objective Ship it');

    expect(lost.errors).toEqual([
      '/tower objective failed: tower state was lost — .tower/comms/state.json is missing while .tower/ still exists; check /tower status and let the tower recover it before handing over an objective',
    ]);
    expect(await new TowerStore(h.repo).isInitialized()).toBe(false);

    const plain = await mkdtemp(join(tmpdir(), 'tower-command-plain-'));
    cleanups.push(plain);
    const session = new FakeSessionManager(SESSION_ID);
    const ctx = new FakeContext(plain, session);
    const pi = new FakePi();
    pi.session = session;
    pi.context = ctx;
    const controller = new TowerController({ pi, createRuntime: () => new FakeRuntime() });
    controller.observe(ctx.asContext);
    const { ui, recorded } = recordingUi();
    const deps: TowerCommandDeps = { sendUserMessage: (text, options) => pi.sendUserMessage(text, options) };
    await handleTowerCommand(controller, 'on', ctx.asCommandContext, deps, ui);
    await handleTowerCommand(controller, 'objective Ship it', ctx.asCommandContext, deps, ui);

    expect(recorded.errors).toEqual([
      `/tower objective failed: ${plain} is not a git repository — the tower needs one: run git init and commit what should become the base (check for secrets and large files first), then retry`,
    ]);
    expect(pi.userMessages).toEqual([]);
    await expect(git(plain, 'status')).rejects.toThrow();
  });
});

describe('/tower objective status', () => {
  it('explains a missing workspace or objective without a model turn', async () => {
    const h = await harness();

    expect((await h.run('objective status')).statuses).toEqual([
      'There is no objective — the tower workspace is not initialized yet.',
    ]);
    await new TowerStore(h.repo).init(SESSION_ID, 'main');
    expect((await h.run('objective STATUS')).statuses).toEqual([
      'There is no objective — hand one to the tower with /tower objective <text | @file>.',
    ]);
    expect(h.pi.userMessages).toEqual([]);
  });

  it('renders the objective dashboard with the configured skipped kinds, even with tower mode off', async () => {
    const h = await harness();
    await approvedObjective(h.repo);
    const hooks = fakeObjectiveHooks();
    hooks.settings = { ...hooks.settings, skipUserTesting: true };
    const now = Date.parse('2026-11-09T12:00:00.000Z');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const shown = await h.run('objective status', objectiveDeps(h, hooks));
      const state = await readTowerState(h.repo);
      const [title = '', ...body] = renderObjectiveStatus({
        objective: state.objective!,
        features: objectiveMissions(state),
        agents: [],
        nowMs: now,
        skipKinds: ['user-testing'],
      }).split('\n');

      expect(shown.errors).toEqual([]);
      expect(shown.notices).toEqual([{ title: title.replace(/^# /, ''), body: body.join('\n') }]);
      expect(shown.notices[0]?.title).toBe('Objective O1 — Ship');
      expect(shown.notices[0]?.body).toContain('validation: scrutiny');
      expect(shown.notices[0]?.body).not.toContain('user-testing');
    } finally {
      clock.mockRestore();
    }
    expect(h.controller.isActive).toBe(false);
    expect(hooks.ticks).toEqual([]);
  });

  it('lists only live agents and reports a broken state as an error', async () => {
    const h = await harness();
    await approvedObjective(h.repo);
    await h.run('on');
    await spawnReviewer(h, 'rev-live');

    const shown = await h.run('objective status');
    expect(shown.notices[0]?.body).toContain('## Live agents (1)\n- rev-live — reviewer · main');

    await writeFile(join(h.repo, STATE_FILE), '{ corrupt');
    const broken = await h.run('objective status');
    expect(broken.notices).toEqual([]);
    expect(broken.errors).toEqual([expect.stringMatching(/^Failed to read the objective status: /) as unknown as string]);
  });
});

describe('/tower approve, pause and resume', () => {
  it('approves as the human, then ticks the autopilot without waiting for it', async () => {
    const h = await harness();
    const store = await plannedObjective(h.repo);
    await store.requestObjectiveApproval();
    await h.run('on');
    const hooks = fakeObjectiveHooks();

    const approved = await h.run('approve', objectiveDeps(h, hooks));

    expect(approved.errors).toEqual([]);
    expect(approved.notices).toEqual([
      {
        title: 'Objective O1 approved — executing',
        body: '"Ship" was approved by human. Milestone MS1 "Core" is active. Follow it with /tower objective status; /tower pause stops new work.',
      },
    ]);
    expect((await readTowerState(h.repo)).objective).toMatchObject({ status: 'executing', approvedBy: 'human' });
    await settle();
    expect(hooks.ticks).toEqual(['approve']);

    const again = await h.run('approve', objectiveDeps(h, hooks));
    expect(again.errors).toEqual([
      'Approval failed — objective O1 is executing — only an objective awaiting approval can be approved; the orchestrator requests approval first',
    ]);
    await settle();
    expect(hooks.ticks).toEqual(['approve']);
  });

  it('records an automatic approval with --auto, and refuses it after a contract change while paused', async () => {
    const h = await harness();
    const store = await plannedObjective(h.repo);
    await store.requestObjectiveApproval();
    await h.run('on');

    const auto = await h.run('approve --AUTO');
    expect(auto.notices[0]?.body).toMatch(/^"Ship" was approved by auto\. /);
    expect((await readTowerState(h.repo)).objective?.approvedBy).toBe('auto');

    await store.pauseObjective('rethink');
    await store.updateObjective({ definitionOfDone: ['works', 'documented'] });
    const refused = await h.run('approve --auto');
    expect(refused.errors).toEqual([
      'Approval failed — objective O1 changed its contract while it was blocked or paused, so only a human can approve it — auto-approval stays refused until a human approves [human-approval-required]',
    ]);
    expect((await h.run('approve')).notices[0]?.title).toBe('Objective O1 approved — executing');
    expect((await h.run('approve now')).errors).toEqual([
      "Usage: /tower approve [--auto] — approve the objective's plan; --auto records an automatic approval",
    ]);
  });

  async function headlessAwaitingApproval(h: Harness): Promise<TowerStore> {
    await h.run('on');
    await h.run('objective --headless Ship it');
    const store = new TowerStore(h.repo);
    await store.draftObjective({ title: 'Ship', goal: 'ship it', definitionOfDone: ['works'], milestones: [{ title: 'Core' }] });
    await store.plan([{ title: 'Core work', scope: ['src/core/**'], milestone: 'MS1' }]);
    await store.requestObjectiveApproval();
    return store;
  }

  it('keeps a headless objective headless through --auto and a tower restart, and a human resume makes it interactive', async () => {
    const h = await harness();
    const store = await headlessAwaitingApproval(h);

    expect((await h.run('approve --auto')).errors).toEqual([]);
    await h.run('off');
    await h.run('on');
    expect(await readTowerState(h.repo)).toMatchObject({ objectiveMode: 'headless', objectiveModeFor: 'O1' });

    await store.pauseObjective('budget: maxCostUsd reached');
    expect((await h.run('resume')).errors).toEqual([]);
    expect(await readTowerState(h.repo)).toMatchObject({
      objectiveMode: 'interactive',
      objectiveModeFor: 'O1',
      objective: { status: 'executing' },
    });
  });

  it('makes a headless objective interactive when the human approves it', async () => {
    const h = await harness();
    await headlessAwaitingApproval(h);

    const approved = await h.run('approve');

    expect(approved.errors).toEqual([]);
    expect(await readTowerState(h.repo)).toMatchObject({
      objectiveMode: 'interactive',
      objectiveModeFor: 'O1',
      objective: { status: 'executing', approvedBy: 'human' },
    });
  });

  it('does not hand headless to an objective drafted after a finished one without a fresh /tower objective', async () => {
    const h = await harness();
    const store = await headlessAwaitingApproval(h);
    await h.run('approve --auto');
    await store.blockObjective('cannot converge');

    await store.draftObjective({ title: 'Next', goal: 'next', definitionOfDone: ['done'], milestones: [{ title: 'Again' }] });

    const state = await readTowerState(h.repo);
    expect(state.objective?.id).toBe('O2');
    expect('objectiveMode' in state).toBe(false);
    expect('objectiveModeFor' in state).toBe(false);
  });

  it('leaves a workspace without an objective byte-identical when approve, pause and resume are refused', async () => {
    const h = await harness();
    await new TowerStore(h.repo).init(SESSION_ID, 'main');
    await h.run('on');
    const before = await readFile(join(h.repo, STATE_FILE), 'utf8');

    for (const args of ['approve', 'approve --auto', 'pause', 'resume']) {
      expect((await h.run(args)).errors, args).toHaveLength(1);
    }

    expect(await readFile(join(h.repo, STATE_FILE), 'utf8')).toBe(before);
    expect(before).not.toContain('objective');
  });

  it('reports a failing autopilot tick, skips the tick while tower mode is off, and works without hooks', async () => {
    const h = await harness();
    const store = await plannedObjective(h.repo);
    await store.requestObjectiveApproval();
    const hooks = fakeObjectiveHooks();

    const offline = await h.run('approve', objectiveDeps(h, hooks));
    expect(offline.notices).toHaveLength(1);
    expect(offline.statuses).toEqual(['Tower mode is off — the objective continues once you turn it on with /tower on.']);
    await settle();
    expect(hooks.ticks).toEqual([]);

    await h.run('on');
    await store.pauseObjective('p');
    hooks.tickError = new Error('runner exploded');
    const resumed = await h.run('resume', objectiveDeps(h, hooks));
    expect(resumed.notices[0]?.title).toBe('Objective O1 resumed — executing');
    await settle();
    expect(hooks.ticks).toEqual(['resume']);
    expect(resumed.errors).toEqual(['The autopilot tick after /tower resume failed: runner exploded']);

    await store.pauseObjective('p');
    const bare = await h.run('resume', objectiveDeps(h));
    expect(bare.errors).toEqual([]);
    expect(bare.notices[0]?.body).toBe(
      'Limits from the current objective settings: 3 failed validation rounds per kind · 3 attempts per feature · wall time unlimited · cost unlimited.',
    );
  });

  it('pauses an executing objective with an optional reason', async () => {
    const h = await harness();
    await approvedObjective(h.repo);

    const paused = await h.run('pause waiting for the  budget review');
    expect(paused.notices).toEqual([
      {
        title: 'Objective O1 paused',
        body: 'Reason: waiting for the  budget review. Running agents keep their current turn; nothing new starts until /tower resume.',
      },
    ]);
    expect((await h.run('pause')).errors).toEqual([
      'Pause failed — objective O1 is paused — only an executing objective can be paused',
    ]);
    await new TowerStore(h.repo).resumeObjective();
    expect((await h.run('pause')).notices[0]?.body).toBe(
      'Reason: paused on request. Running agents keep their current turn; nothing new starts until /tower resume.',
    );
  });

  it('refreshes the limits from the current settings before resuming, and warns about an exhausted budget', async () => {
    const h = await harness();
    const store = await approvedObjective(h.repo);
    await store.updateObjective({ limits: { maxWallTimeMs: 3_600_000, maxCostUsd: 5 } });
    await store.recordObjectiveUsage(20);
    await store.pauseObjective('budget: maxCostUsd reached');
    await h.run('on');
    const hooks = fakeObjectiveHooks();
    hooks.settings = { ...hooks.settings, maxValidationRounds: 5, maxFeatureAttempts: 4, maxCostUsd: 12.5 };

    const resumed = await h.run('resume', objectiveDeps(h, hooks));

    expect(resumed.errors).toEqual([]);
    expect(resumed.notices).toEqual([
      {
        title: 'Objective O1 resumed — executing',
        body: 'Limits from the current objective settings: 5 failed validation rounds per kind · 4 attempts per feature · wall time unlimited · cost $12.50.',
      },
    ]);
    expect(resumed.warnings).toEqual([
      'Objective O1 is over its cost limit ($20.00 of $12.50) — the autopilot pauses it again unless you raise the limit in the objective settings.',
    ]);
    expect((await readTowerState(h.repo)).objective?.limits).toEqual({
      maxValidationRounds: 5,
      maxFeatureAttempts: 4,
      maxCostUsd: 12.5,
    });
    await settle();
    expect(hooks.ticks).toEqual(['resume']);
  });

  it('refuses to resume an objective that is neither paused nor blocked, without touching its limits', async () => {
    const h = await harness();
    await new TowerStore(h.repo).init(SESSION_ID, 'main');
    expect((await h.run('resume')).errors).toEqual([
      'There is no objective to resume — hand one to the tower with /tower objective <text | @file>.',
    ]);
    await rm(join(h.repo, '.tower'), { recursive: true, force: true });
    await approvedObjective(h.repo);
    const before = await readFile(join(h.repo, STATE_FILE), 'utf8');
    const hooks = fakeObjectiveHooks();
    hooks.settings = { ...hooks.settings, maxValidationRounds: 9 };

    const refused = await h.run('resume', objectiveDeps(h, hooks));

    expect(refused.errors).toEqual([
      'Resume failed — objective O1 is executing; only a paused or blocked objective can be resumed.',
    ]);
    expect(await readFile(join(h.repo, STATE_FILE), 'utf8')).toBe(before);
    expect((await h.run('resume now')).errors).toEqual([
      '/tower resume takes no arguments — did you mean /tower resume? Run /tower help for usage.',
    ]);
    await settle();
    expect(hooks.ticks).toEqual([]);
  });

  it('reports every objective failure through ui.error instead of throwing', async () => {
    const h = await harness();
    await new TowerStore(h.repo).init(SESSION_ID, 'main');
    await h.run('on');
    await writeFile(join(h.repo, STATE_FILE), '{ corrupt');
    const hooks = fakeObjectiveHooks();
    hooks.objectiveSettings = () => {
      throw new Error('settings unavailable');
    };

    for (const [args, prefix] of [
      ['objective Ship it', '/tower objective failed: '],
      ['objective status', 'Failed to read the objective status: '],
      ['approve', 'Approval failed — '],
      ['approve --auto', 'Approval failed — '],
      ['pause now', 'Pause failed — '],
      ['resume', 'Resume failed — '],
    ] as const) {
      const shown = await h.run(args, objectiveDeps(h, hooks));
      expect(shown.errors, args).toEqual([expect.stringMatching(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`)) as unknown as string]);
    }
    expect(h.pi.userMessages).toEqual([]);
  });

  it('reports a failing settings hook through ui.error', async () => {
    const h = await harness();
    const store = await approvedObjective(h.repo);
    await store.pauseObjective('p');
    await h.run('on');
    const hooks = fakeObjectiveHooks();
    hooks.objectiveSettings = () => {
      throw new Error('settings unavailable');
    };

    expect((await h.run('objective status', objectiveDeps(h, hooks))).errors).toEqual([
      'Failed to read the objective status: settings unavailable',
    ]);
    expect((await h.run('resume', objectiveDeps(h, hooks))).errors).toEqual(['Resume failed — settings unavailable']);
    expect((await readTowerState(h.repo)).objective?.status).toBe('paused');
    await settle();
    expect(hooks.ticks).toEqual([]);
  });

  it('suggests the objective commands for near-miss words', async () => {
    const h = await harness();

    expect((await h.run('goal')).errors).toEqual([
      'Unknown /tower subcommand "goal" — did you mean /tower objective? Run /tower help for usage; /tower <base-branch> starts the tower on a branch.',
    ]);
    expect((await h.run('unpause')).errors[0]).toContain('did you mean /tower resume?');
    expect((await h.run('approval')).errors[0]).toContain('did you mean /tower approve?');
    expect(await git(h.repo, 'branch', '--list')).toBe('* main');
  });
});

describe('the headless runner command sequence', () => {
  it('accepts exactly what pi-tower run sends, without error notices', async () => {
    const h = await harness();
    const dir = join(h.repo, 'objective specs');
    await mkdir(dir);
    const file = join(dir, 'ship csv.md');
    await writeFile(file, 'Ship the CSV export.\n');
    const hooks = fakeObjectiveHooks();
    const deps = objectiveDeps(h, hooks);

    const on = await h.run('on', deps);
    const handed = await h.run(`objective --headless @${file}`, deps);
    const store = new TowerStore(h.repo);
    await store.draftObjective({ title: 'CSV', goal: 'Ship the CSV export.', definitionOfDone: ['csv works'], milestones: [{ title: 'Core' }] });
    await store.plan([{ title: 'CSV writer', scope: ['src/csv/**'], milestone: 'MS1' }]);
    await store.requestObjectiveApproval();
    const approved = await h.run('approve --auto', deps);

    for (const recorded of [on, handed, approved]) expect(recorded.errors).toEqual([]);
    expect(h.pi.userMessages.map((message) => message.text)).toEqual([
      buildObjectivePlanningPrompt({ mode: 'headless', text: 'Ship the CSV export.\n', file }),
    ]);
    expect(await readTowerState(h.repo)).toMatchObject({
      objectiveMode: 'headless',
      objective: { status: 'executing', approvedBy: 'auto' },
    });
    await settle();
    expect(hooks.ticks).toEqual(['approve']);
  });
});

describe('objective command completions and help', () => {
  it('completes the objective and approve arguments', () => {
    expect(towerCommandCompletions('objective ')).toEqual([
      { value: 'objective status', label: 'status' },
      { value: 'objective --headless', label: '--headless' },
    ]);
    expect(towerCommandCompletions('objective --h')).toEqual([{ value: 'objective --headless', label: '--headless' }]);
    expect(towerCommandCompletions('objective --headless ')).toBeNull();
    expect(towerCommandCompletions('approve ')).toEqual([{ value: 'approve --auto', label: '--auto' }]);
    expect(towerCommandCompletions('pause ')).toBeNull();
  });

  it('documents the objective commands in the usage', () => {
    for (const line of [
      '/tower objective [--headless] <text | @file> — ',
      '/tower objective status — show the objective dashboard',
      '/tower approve [--auto] — ',
      '/tower pause [reason] — ',
      '/tower resume — ',
    ]) {
      expect(TOWER_COMMAND_USAGE).toContain(line);
    }
    expect(TOWER_COMMAND_USAGE.split('\n').at(-1)).toBe('/tower help — show this help');
  });
});
