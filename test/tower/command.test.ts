import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TOWER_TEARDOWN_PROMPT } from '../../src/prompts/index.ts';
import { STATE_FILE, TowerStore, type TowerState } from '../../src/protocol/index.ts';
import {
  TOWER_COMMAND_USAGE,
  commandUi,
  handleTowerCommand,
  towerCommandCompletions,
  type TowerCommandDeps,
  type TowerCommandUi,
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
      'help',
    ]);
    expect(towerCommandCompletions('st')?.map((item) => item.value)).toEqual(['status', 'stop']);
    expect(towerCommandCompletions('O')?.map((item) => item.value)).toEqual(['on', 'off']);
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
