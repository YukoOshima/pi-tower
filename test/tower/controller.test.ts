import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type {
  AfterProviderResponseEvent,
  AgentSettledEvent,
  BeforeAgentStartEvent,
  SessionStartEvent,
  ToolCallEvent,
} from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TOWER_MODE_EXIT_REMINDER,
  TOWER_MODE_FULL_REMINDER,
  TOWER_MODE_SPARSE_REMINDER,
  subagentToolDenied,
  todoToolDenied,
} from '../../src/prompts/index.ts';
import { STATE_FILE, TowerStore, type TowerState } from '../../src/protocol/index.ts';
import { ORCHESTRATOR_CALLER } from '../../src/tools/support.ts';
import { createTowerTaskStopTool } from '../../src/tools/taskStop/taskStopTool.ts';
import {
  HUMAN_STOP_REASON,
  TOWER_AGENT_NOTIFICATION_MESSAGE,
  TOWER_INBOX_WAKE_MESSAGE,
  TOWER_MODE_ENTRY,
  TOWER_MODE_TOOLS,
  TOWER_REMINDER_MESSAGE,
  TOWER_STATUS_KEY,
} from '../../src/tower/constants.ts';
import { TowerController, towerEnterFailureMessage, type TowerLog } from '../../src/tower/controller.ts';
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

const FOREIGN_PID = 424_242;
const DEAD_PID = 434_343;

interface Harness {
  readonly repo: string;
  readonly session: FakeSessionManager;
  readonly ctx: FakeContext;
  readonly pi: FakePi;
  readonly runtime: FakeRuntime;
  readonly controller: TowerController;
  readonly infos: { readonly message: string; readonly payload?: unknown }[];
}

const alive = new Set<number>();
const cleanups: string[] = [];

beforeEach(() => {
  alive.clear();
  alive.add(process.pid);
  alive.add(FOREIGN_PID);
});

afterEach(async () => {
  for (const dir of cleanups.splice(0)) await removeDir(dir);
});

async function harness(
  options: { readonly repo?: string; readonly sessionId?: string; readonly entries?: FakeSessionManager['entries'] } = {},
): Promise<Harness> {
  const repo = options.repo ?? (await createRepo('tower-controller-'));
  if (options.repo === undefined) cleanups.push(repo);
  const session = new FakeSessionManager(options.sessionId ?? 'session-main', options.entries ?? []);
  const ctx = new FakeContext(repo, session);
  const pi = new FakePi();
  pi.session = session;
  const runtime = new FakeRuntime();
  const infos: { message: string; payload?: unknown }[] = [];
  const log: TowerLog = {
    info: (message, payload) => {
      infos.push({ message, payload });
    },
    warn: (message, payload) => {
      infos.push({ message, payload });
    },
  };
  const controller = new TowerController({
    pi,
    createRuntime: () => runtime,
    isProcessAlive: (pid) => alive.has(pid),
    log,
  });
  controller.observe(ctx.asContext);
  expect(controller.runtime).toBe(runtime);
  return { repo, session, ctx, pi, runtime, controller, infos };
}

async function setOwner(repo: string, patch: Partial<Pick<TowerState, 'sessionId' | 'ownerPid'>>): Promise<void> {
  const file = join(repo, STATE_FILE);
  const state = JSON.parse(await readFile(file, 'utf8')) as TowerState;
  await writeFile(file, `${JSON.stringify({ ...state, ...patch }, null, 2)}\n`);
}

function modeRecords(pi: FakePi): unknown[] {
  return pi.appended.filter((entry) => entry.customType === TOWER_MODE_ENTRY).map((entry) => entry.data);
}

function startEvent(reason: SessionStartEvent['reason'] = 'resume'): SessionStartEvent {
  return { type: 'session_start', reason };
}

function beforeStart(messageType: 'user' | 'custom' = 'user'): BeforeAgentStartEvent {
  return { type: 'before_agent_start', messageType, prompt: 'go', systemPrompt: '', systemPromptOptions: {} } as unknown as BeforeAgentStartEvent;
}

function toolCall(toolName: string): ToolCallEvent {
  return { type: 'tool_call', toolCallId: `call_${toolName}`, toolName, input: {} } as ToolCallEvent;
}

const settled: AgentSettledEvent = { type: 'agent_settled', aborted: false };

describe('tower mode enter / exit', () => {
  it('toggles the mode, the footer status and the persisted mode record', async () => {
    const h = await harness();

    expect(h.controller.isActive).toBe(false);
    await expect(h.controller.enter()).resolves.toEqual({ entered: true });
    expect(h.controller.isActive).toBe(true);
    expect(h.ctx.ui.statuses.get(TOWER_STATUS_KEY)).toBe('tower: on');
    await h.controller.exit();
    expect(h.controller.isActive).toBe(false);
    expect(h.ctx.ui.statuses.get(TOWER_STATUS_KEY)).toBeUndefined();

    expect(modeRecords(h.pi)).toEqual([
      { active: true, sessionId: 'session-main', pid: process.pid },
      { active: false },
    ]);
  });

  it('is idempotent while already in that state', async () => {
    const h = await harness();

    await h.controller.exit();
    await h.controller.enter();
    await h.controller.enter();

    expect(h.controller.isActive).toBe(true);
    expect(modeRecords(h.pi)).toHaveLength(1);
  });

  it('offers non-waiting branch leases and always releases them', async () => {
    const h = await harness();
    let release!: () => void;
    const running = h.controller.withBranchLease('feat/leased', () => new Promise<void>((resolve) => { release = resolve; }));

    expect(h.controller.isBranchLeased('feat/leased')).toBe(true);
    await expect(h.controller.withBranchLease('feat/leased', () => Promise.resolve())).rejects.toThrow(/not waiting/);
    await h.controller.withBranchLease('feat/other', () => Promise.resolve());
    release();
    await running;
    expect(h.controller.isBranchLeased('feat/leased')).toBe(false);
    await expect(h.controller.withBranchLease('feat/leased', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(h.controller.isBranchLeased('feat/leased')).toBe(false);
  });

  it('activates the tower tool set on enter and keeps it on exit', async () => {
    const h = await harness();

    await h.controller.enter();
    expect(h.pi.activeTools).toEqual(['read', 'bash', 'edit', 'write', ...TOWER_MODE_TOOLS]);
    await h.controller.exit();
    expect(h.pi.activeTools).toEqual(['read', 'bash', 'edit', 'write', ...TOWER_MODE_TOOLS]);
  });

  it('re-adds the tower tools before a run when something removed them while active', async () => {
    const h = await harness();
    await h.controller.enter();
    h.pi.activeTools = ['bash'];

    h.controller.onBeforeAgentStart(beforeStart(), h.ctx.asContext);

    expect(h.pi.activeTools).toEqual(['bash', ...TOWER_MODE_TOOLS]);
  });
});

describe('enter(base)', () => {
  it('prepares the workspace base and records the session owner', async () => {
    const h = await harness();
    await git(h.repo, 'branch', 'develop');

    await h.controller.enter('develop');

    expect(h.controller.isActive).toBe(true);
    const state = await new TowerStore(h.repo).load();
    expect(state.base).toBe('develop');
    expect(state.sessionId).toBe('session-main');
    expect(state.ownerPid).toBe(process.pid);
  });

  it('creates the branch from HEAD, switches to it, and initializes a fresh tower', async () => {
    const h = await harness();

    await h.controller.enter('integration');

    expect(await git(h.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('integration');
    expect(await git(h.repo, 'rev-parse', 'integration')).toBe(await git(h.repo, 'rev-parse', 'main'));
    expect((await new TowerStore(h.repo).load()).base).toBe('integration');
  });

  it('rejects an invalid branch name and does not activate', async () => {
    const h = await harness();

    await expect(h.controller.enter('no..dots')).rejects.toThrow('git checkout -b no..dots failed');

    expect(h.controller.isActive).toBe(false);
    expect(h.pi.activeTools).not.toContain('TowerInit');
    expect(await new TowerStore(h.repo).isInitialized()).toBe(false);
  });

  it('rebases an already-initialized workspace, creating the branch and committing dirty WIP', async () => {
    const h = await harness();
    const store = new TowerStore(h.repo);
    await store.init('session-previous', 'main');
    await writeFile(join(h.repo, 'README.md'), '# dirty wip\n');

    await h.controller.enter('add-new-feature');

    expect(await git(h.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('add-new-feature');
    expect(await git(h.repo, 'status', '--porcelain')).toBe('');
    expect(await git(h.repo, 'show', 'add-new-feature:README.md')).toBe('# dirty wip');
    expect((await store.load()).base).toBe('add-new-feature');
  });

  it('re-anchors the workspace while missions are open', async () => {
    const h = await harness();
    await git(h.repo, 'branch', 'develop');
    const store = new TowerStore(h.repo);
    await store.init('session-previous', 'main');
    await store.plan([{ title: 'engine', scope: ['src/engine/**'] }]);

    await h.controller.enter('develop');

    const state = await store.load();
    expect(state.base).toBe('develop');
    expect(state.missions).toHaveLength(1);
  });

  it('refuses a checkout with unmerged paths', async () => {
    const h = await harness();
    await git(h.repo, 'checkout', '-b', 'side');
    await writeFile(join(h.repo, 'README.md'), '# side\n');
    await git(h.repo, 'commit', '-am', 'side');
    await git(h.repo, 'checkout', 'main');
    await writeFile(join(h.repo, 'README.md'), '# main\n');
    await git(h.repo, 'commit', '-am', 'main');
    await git(h.repo, 'merge', 'side').catch(() => undefined);

    await expect(h.controller.enter('integration')).rejects.toThrow('unmerged paths');

    expect(h.controller.isActive).toBe(false);
    expect(await git(h.repo, 'branch', '--list', 'integration')).toBe('');
  });

  it('re-enter while active only prepares the base again and writes no new mode record', async () => {
    const h = await harness();
    await git(h.repo, 'branch', 'develop');

    await h.controller.enter();
    await h.controller.enter('develop');
    await h.controller.enter();

    expect((await new TowerStore(h.repo).load()).base).toBe('develop');
    expect(modeRecords(h.pi)).toHaveLength(1);
  });

  it('bootstraps a non-git directory before preparing the requested base', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tower-enter-nogit-'));
    cleanups.push(dir);
    await writeFile(join(dir, 'notes.md'), '# scratch\n');
    const h = await harness({ repo: dir });

    await expect(h.controller.enter('tower-base')).resolves.toEqual({ entered: true });

    expect(await git(dir, 'log', '-1', '--format=%s')).toBe('tower: snapshot of uncommitted base checkout changes (base tower-base)');
    expect(await git(dir, 'symbolic-ref', '--short', 'HEAD')).toBe('tower-base');
  });
});

describe('single-tower ownership', () => {
  it('refuses while another live pi process owns the workspace and names its session and pid', async () => {
    const h = await harness({ sessionId: 'session-fork' });
    const store = new TowerStore(h.repo);
    await store.init('session-original');
    await setOwner(h.repo, { ownerPid: FOREIGN_PID });

    const result = await h.controller.enter();

    expect(result).toEqual({ entered: false, reason: 'owned-by-live-session', owner: 'session-original', pid: FOREIGN_PID });
    if (!result.entered) {
      expect(towerEnterFailureMessage(result)).toBe(`another live session owns the workspace tower (session session-original, pid ${String(FOREIGN_PID)})`);
    }
    expect(h.controller.isActive).toBe(false);
    expect(h.pi.activeTools).not.toContain('TowerInit');
  });

  it('rejects a non-owner re-anchor while a live owner holds the workspace and leaves the store untouched', async () => {
    const h = await harness({ sessionId: 'session-fork' });
    await git(h.repo, 'branch', 'develop');
    const store = new TowerStore(h.repo);
    await store.init('session-original', 'main');
    await setOwner(h.repo, { ownerPid: FOREIGN_PID });

    expect(await h.controller.enter('develop')).toMatchObject({ entered: false, reason: 'owned-by-live-session' });

    const state = await store.load();
    expect(state.base).toBe('main');
    expect(state.sessionId).toBe('session-original');
  });

  it('lets the owning session re-anchor the workspace base', async () => {
    const h = await harness();
    await git(h.repo, 'branch', 'develop');
    const store = new TowerStore(h.repo);
    await store.init('session-main', 'main');

    await h.controller.enter('develop');

    expect((await store.load()).base).toBe('develop');
  });

  it('takes over a dead owner process and retires its roster without TowerInit', async () => {
    const h = await harness({ sessionId: 'session-fork' });
    const store = new TowerStore(h.repo);
    await store.init('session-original');
    await store.registerAgent({ name: 'worker-stale', agentId: 'agent-0', sessionId: 'session-original', kind: 'worker', spawnedAt: new Date().toISOString() });
    await setOwner(h.repo, { ownerPid: DEAD_PID });

    await h.controller.enter();

    expect(h.controller.isActive).toBe(true);
    const state = await store.load();
    expect(state.sessionId).toBe('session-fork');
    expect(state.ownerPid).toBe(process.pid);
    expect(state.roster.agents).toEqual([]);
    expect(h.controller.isRetiredAgent('worker-stale')).toBe(true);
    const log = await store.recentLog(5);
    expect(log.some((line) => line.includes(' adopt ') && line.includes('session=session-fork'))).toBe(true);
  });

  it('treats a replaced session of this same process as dead and takes it over', async () => {
    const h = await harness({ sessionId: 'session-new' });
    const store = new TowerStore(h.repo);
    await store.init('session-old');

    await expect(h.controller.enter()).resolves.toEqual({ entered: true });

    expect((await store.load()).sessionId).toBe('session-new');
  });

  it('refuses to activate when the roster adoption cannot be persisted or the state is unreadable', async () => {
    const corrupted = await harness({ sessionId: 'session-fork' });
    await new TowerStore(corrupted.repo).init('session-original');
    await writeFile(join(corrupted.repo, STATE_FILE), '{corrupted\n');

    await expect(corrupted.controller.enter()).rejects.toThrow(/failed to adopt the tower workspace roster/);
    expect(corrupted.controller.isActive).toBe(false);
    expect(corrupted.pi.activeTools).not.toContain('TowerInit');

    const unreadable = await harness({ sessionId: 'session-fork' });
    await new TowerStore(unreadable.repo).init('session-original');
    await rm(join(unreadable.repo, STATE_FILE), { force: true });
    await mkdir(join(unreadable.repo, STATE_FILE));

    await expect(unreadable.controller.enter()).rejects.toThrow(/failed to adopt the tower workspace roster/);
    expect(unreadable.controller.isActive).toBe(false);
  });

  it('exit releases ownership recorded under this session and keeps a foreign one', async () => {
    const h = await harness();
    const store = new TowerStore(h.repo);
    await store.init('session-main');

    await h.controller.enter();
    await h.controller.exit();
    expect((await store.load()).sessionId).toBeUndefined();
    expect((await store.recentLog(5)).some((line) => line.includes(' release ') && line.includes('session=session-main'))).toBe(true);

    await h.controller.enter();
    await store.adopt('session-third');
    await h.controller.exit();
    expect((await store.load()).sessionId).toBe('session-third');
  });

  it('awaits an in-flight release before adopting again', async () => {
    const h = await harness();
    await new TowerStore(h.repo).init('session-main');
    await h.controller.enter();
    let releaseResolve!: () => void;
    const original = TowerStore.prototype.release;
    const releaseSpy = vi.spyOn(TowerStore.prototype, 'release').mockImplementation(async function (this: TowerStore, sessionId) {
      await new Promise<void>((resolve) => { releaseResolve = resolve; });
      return original.call(this, sessionId);
    });
    const adoptSpy = vi.spyOn(TowerStore.prototype, 'adopt');
    try {
      const exiting = h.controller.exit();
      await vi.waitFor(() => expect(releaseSpy).toHaveBeenCalled());
      const entering = h.controller.enter();
      await delay(20);
      expect(adoptSpy).not.toHaveBeenCalled();
      releaseResolve();
      await exiting;
      await entering;
      expect(adoptSpy).toHaveBeenCalledTimes(1);
      expect(h.controller.isActive).toBe(true);
    } finally {
      releaseSpy.mockRestore();
      adoptSpy.mockRestore();
    }
  });

  it('reports no-session when it was never bound to a pi session', async () => {
    const controller = new TowerController({ pi: new FakePi() });

    await expect(controller.enter()).resolves.toEqual({ entered: false, reason: 'no-session' });
  });
});

describe('restore on session_start', () => {
  const activeRecord = (sessionId: string, pid: number) => ({
    type: 'custom',
    id: 'mode-1',
    customType: TOWER_MODE_ENTRY,
    data: { active: true, sessionId, pid },
  });

  it('restores the mode, tools and footer for the owning session and refreshes the owner pid', async () => {
    const repo = await createRepo('tower-restore-');
    cleanups.push(repo);
    const store = new TowerStore(repo);
    await store.init('session-main');
    await setOwner(repo, { ownerPid: DEAD_PID });
    const h = await harness({ repo, entries: [activeRecord('session-main', DEAD_PID)] });

    await h.controller.onSessionStart(startEvent(), h.ctx.asContext);

    expect(h.controller.isActive).toBe(true);
    expect(h.pi.activeTools).toEqual(expect.arrayContaining([...TOWER_MODE_TOOLS]));
    expect(h.ctx.ui.statuses.get(TOWER_STATUS_KEY)).toBe('tower: on');
    expect((await store.load()).ownerPid).toBe(process.pid);
    expect(modeRecords(h.pi)).toEqual([{ active: true, sessionId: 'session-main', pid: process.pid }]);
  });

  it('exits a replayed tower mode when another live process owns the store (fork)', async () => {
    const repo = await createRepo('tower-restore-fork-');
    cleanups.push(repo);
    const store = new TowerStore(repo);
    await store.init('session-original');
    await setOwner(repo, { ownerPid: FOREIGN_PID });
    const h = await harness({ repo, sessionId: 'session-fork', entries: [activeRecord('session-original', FOREIGN_PID)] });

    await h.controller.onSessionStart(startEvent('fork'), h.ctx.asContext);

    expect(h.controller.isActive).toBe(false);
    expect(h.pi.activeTools).not.toContain('TowerInit');
    expect(modeRecords(h.pi)).toEqual([{ active: false }]);
    expect(h.ctx.ui.notices.at(-1)?.message).toContain('Tower mode: OFF — another live session owns the workspace tower (session session-original');
    expect((await store.load()).sessionId).toBe('session-original');
  });

  it('keeps a replayed mode and adopts the workspace when the owner is gone', async () => {
    const repo = await createRepo('tower-restore-stale-');
    cleanups.push(repo);
    const store = new TowerStore(repo);
    await store.init('session-original');
    await store.registerAgent({ name: 'worker-stale', agentId: 'agent-0', sessionId: 'session-original', kind: 'worker', spawnedAt: new Date().toISOString() });
    await setOwner(repo, { ownerPid: DEAD_PID });
    const h = await harness({ repo, sessionId: 'session-fork', entries: [activeRecord('session-original', DEAD_PID)] });

    await h.controller.onSessionStart(startEvent('fork'), h.ctx.asContext);

    expect(h.controller.isActive).toBe(true);
    const state = await store.load();
    expect(state.sessionId).toBe('session-fork');
    expect(state.roster.agents).toEqual([]);
  });

  it('takes over an in-process fork whose original session was replaced', async () => {
    const repo = await createRepo('tower-restore-inproc-');
    cleanups.push(repo);
    const store = new TowerStore(repo);
    await store.init('session-original');
    const h = await harness({ repo, sessionId: 'session-fork', entries: [activeRecord('session-original', process.pid)] });

    await h.controller.onSessionStart(startEvent('fork'), h.ctx.asContext);

    expect(h.controller.isActive).toBe(true);
    expect((await store.load()).sessionId).toBe('session-fork');
  });

  it('deactivates a replayed tower mode when the stale-owner adoption fails', async () => {
    const repo = await createRepo('tower-restore-adopt-fail-');
    cleanups.push(repo);
    const store = new TowerStore(repo);
    await store.init('session-original');
    await setOwner(repo, { ownerPid: DEAD_PID });
    const h = await harness({ repo, sessionId: 'session-fork', entries: [activeRecord('session-original', DEAD_PID)] });
    const adoptSpy = vi.spyOn(TowerStore.prototype, 'adopt').mockRejectedValue(new Error('EACCES: permission denied'));
    try {
      await h.controller.onSessionStart(startEvent('fork'), h.ctx.asContext);

      expect(h.controller.isActive).toBe(false);
      expect(modeRecords(h.pi)).toEqual([{ active: false }]);
      expect((await store.load()).sessionId).toBe('session-original');
    } finally {
      adoptSpy.mockRestore();
    }
  });

  it('exits without a store when the enter record belongs to another live session', async () => {
    const h = await harness({ sessionId: 'session-fork', entries: [activeRecord('session-original', FOREIGN_PID)] });

    await h.controller.onSessionStart(startEvent('fork'), h.ctx.asContext);

    expect(h.controller.isActive).toBe(false);
    expect(modeRecords(h.pi)).toEqual([{ active: false }]);
  });

  it('restores a pre-init tower mode on the owning session even without a store', async () => {
    const h = await harness({ entries: [activeRecord('session-main', process.pid)] });

    await h.controller.onSessionStart(startEvent(), h.ctx.asContext);

    expect(h.controller.isActive).toBe(true);
    expect(h.pi.activeTools).toEqual(expect.arrayContaining([...TOWER_MODE_TOOLS]));
    expect(modeRecords(h.pi)).toEqual([]);
  });

  it('does nothing without an active mode record', async () => {
    const h = await harness({ entries: [{ type: 'custom', id: 'mode-1', customType: TOWER_MODE_ENTRY, data: { active: false } }] });

    await h.controller.onSessionStart(startEvent(), h.ctx.asContext);

    expect(h.controller.isActive).toBe(false);
    expect(h.pi.activeTools).not.toContain('TowerInit');
  });
});

describe('roster death marks', () => {
  async function activeWithAgent(): Promise<Harness & { readonly agentId: string; readonly store: TowerStore }> {
    const h = await harness();
    const store = new TowerStore(h.repo);
    await store.init('session-main');
    await h.controller.enter();
    const launched = await h.runtime.spawn({ name: 'w1', kind: 'worker', cwd: h.repo, prompt: 'go' });
    if (!launched.ok) throw new Error('spawn failed');
    await store.registerAgent({ name: 'w1', kind: 'worker', agentId: launched.agentId, sessionId: 'session-main', missionId: 'M1', spawnedAt: new Date().toISOString() });
    return { ...h, agentId: launched.agentId, store };
  }

  it('records a death from a non-completed finished run', async () => {
    const h = await activeWithAgent();

    h.runtime.finish(h.agentId, 'failed', { stopReason: 'provider blew up' });

    await vi.waitFor(async () => {
      expect((await h.store.load()).roster.agents[0]?.deathStatus).toBe('failed');
    });
    expect((await h.store.load()).roster.agents[0]?.deathReason).toBe('provider blew up');
    const activity = await readFile(join(h.repo, '.tower/comms/log/activity.log'), 'utf8');
    expect(activity).toContain(' died ');
    expect(activity).toContain('session=session-main');
    expect(h.infos.find((entry) => entry.message === 'tower: marking roster agent died')?.payload).toMatchObject({
      agentId: h.agentId,
      status: 'failed',
      stopReason: 'provider blew up',
      sessionId: 'session-main',
      pid: process.pid,
    });
  });

  it('never treats an idle completion as a death', async () => {
    const h = await activeWithAgent();
    const markSpy = vi.spyOn(TowerStore.prototype, 'markAgentDied');
    try {
      h.runtime.finish(h.agentId, 'idle', { summary: 'done' });
      await settle();
      expect(markSpy).not.toHaveBeenCalled();
    } finally {
      markSpy.mockRestore();
    }
  });

  it('clears the death mark when the agent starts again', async () => {
    const h = await activeWithAgent();
    h.runtime.finish(h.agentId, 'failed', { stopReason: 'lost contact' });
    await vi.waitFor(async () => {
      expect((await h.store.load()).roster.agents[0]?.diedAt).toBeDefined();
    });

    await h.runtime.resume(h.agentId, 'retry');

    await vi.waitFor(async () => {
      expect((await h.store.load()).roster.agents[0]?.diedAt).toBeUndefined();
    });
    expect(await readFile(join(h.repo, '.tower/comms/log/activity.log'), 'utf8')).toContain('revived');
  });

  it('does not record or clear deaths while tower mode is inactive', async () => {
    const h = await activeWithAgent();
    await h.controller.exit();
    const markSpy = vi.spyOn(TowerStore.prototype, 'markAgentDied');
    const clearSpy = vi.spyOn(TowerStore.prototype, 'clearAgentDied');
    try {
      h.runtime.finish(h.agentId, 'failed', { stopReason: 'boom' });
      await h.runtime.resume(h.agentId, 'retry');
      await settle();
      expect(markSpy).not.toHaveBeenCalled();
      expect(clearSpy).not.toHaveBeenCalled();
    } finally {
      markSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  it('leaves the roster untouched when another session owns the tower store', async () => {
    const h = await activeWithAgent();
    await setOwner(h.repo, { sessionId: 'session-other' });

    h.runtime.finish(h.agentId, 'failed', { stopReason: 'provider blew up' });

    await vi.waitFor(() => {
      expect(h.infos.some((entry) => entry.message.includes('skipping roster agent death mark'))).toBe(true);
    });
    expect((await h.store.load()).roster.agents[0]?.diedAt).toBeUndefined();
    expect(h.infos.find((entry) => entry.message.includes('skipping'))?.payload).toMatchObject({ owner: 'session-other', sessionId: 'session-main' });
  });
});

describe('tower-mode tool vetoes', () => {
  it('vetoes exactly the todo-like and subagent-like tools while active', async () => {
    const h = await harness();
    await h.controller.enter();

    for (const name of ['todo', 'todo_write', 'TodoWrite', 'TodoList']) {
      expect(await h.controller.onToolCall(toolCall(name), h.ctx.asContext)).toEqual({ block: true, reason: todoToolDenied(name) });
    }
    for (const name of ['subagent', 'AgentSwarm']) {
      expect(await h.controller.onToolCall(toolCall(name), h.ctx.asContext)).toEqual({ block: true, reason: subagentToolDenied(name) });
    }
    for (const name of ['bash', 'AskUserQuestion', 'TowerTasks', 'todos', 'Agent']) {
      expect(await h.controller.onToolCall(toolCall(name), h.ctx.asContext)).toBeUndefined();
    }
  });

  it('abstains while tower mode is inactive', async () => {
    const h = await harness();

    expect(await h.controller.onToolCall(toolCall('TodoList'), h.ctx.asContext)).toBeUndefined();
    expect(await h.controller.onToolCall(toolCall('subagent'), h.ctx.asContext)).toBeUndefined();
  });

  it('runs the bash guard on main-session bash calls exactly while the workspace is owned, in or out of tower mode', async () => {
    const h = await harness();
    const bash = (command: string): ToolCallEvent =>
      ({ type: 'tool_call', toolCallId: 'call_bash', toolName: 'bash', input: { command } }) as ToolCallEvent;

    expect(await h.controller.onToolCall(bash('rm -rf .tower/comms'), h.ctx.asContext)).toBeUndefined();

    await new TowerStore(h.repo).init('session-main');
    const blocked = await h.controller.onToolCall(bash('rm -rf .tower/comms'), h.ctx.asContext);
    expect(blocked).toMatchObject({ block: true });
    expect(blocked?.reason).toContain('`rm` is not allowed on tower protocol paths');
    expect(await h.controller.onToolCall(bash('git clean -fdx'), h.ctx.asContext)).toMatchObject({ block: true });

    await h.controller.enter();
    expect(await h.controller.onToolCall(bash('rm -rf .tower/comms'), h.ctx.asContext)).toMatchObject({ block: true });
    expect(await h.controller.onToolCall(bash('ls -la .tower && git status'), h.ctx.asContext)).toBeUndefined();

    await h.controller.exit();
    expect((await new TowerStore(h.repo).load()).sessionId).toBeUndefined();
    expect(await h.controller.onToolCall(bash('rm -rf .tower/comms'), h.ctx.asContext)).toBeUndefined();
  });
});

describe('inbox wakes', () => {
  async function activeHarness(): Promise<Harness> {
    const h = await harness();
    await new TowerStore(h.repo).init('session-main');
    await h.controller.enter();
    return h;
  }

  function wakes(h: Harness) {
    return h.pi.sentOfType(TOWER_INBOX_WAKE_MESSAGE);
  }

  it('wakes the orchestrator once when a worker messages the tower, without acknowledging it', async () => {
    const h = await activeHarness();

    h.controller.publishInboxSent({ from: 'w1', to: 'tower', subject: 'need wider scope' });
    await vi.waitFor(() => expect(wakes(h)).toHaveLength(1));

    const [wake] = wakes(h);
    expect(wake?.options).toEqual({ triggerTurn: true, deliverAs: 'followUp' });
    expect(wake?.message.display).toBe(true);
    const text = sentText(wake);
    expect(text).toContain('1 new tower inbox message');
    expect(text).toContain('- w1: "need wider scope"');
    expect(text).toContain('this wake does not acknowledge them');
    expect((await new TowerStore(h.repo).load()).inboxAckIds).toBeUndefined();
  });

  it('warns in the wake text when the tower state was recovered after a loss', async () => {
    const h = await activeHarness();
    await setOwner(h.repo, {});
    const file = join(h.repo, STATE_FILE);
    const state = JSON.parse(await readFile(file, 'utf8')) as TowerState;
    await writeFile(file, JSON.stringify({ ...state, recoveredAt: '2026-10-03T00:00:00.000Z' }));

    h.controller.publishInboxSent({ from: 'w1', to: 'tower', subject: 'after loss' });
    await vi.waitFor(() => expect(wakes(h)).toHaveLength(1));

    expect(sentText(wakes(h)[0])).toContain('recovered after a loss at 2026-10-03T00:00:00.000Z');
  });

  it('coalesces a burst of inbox messages into a single wake naming the latest', async () => {
    const h = await activeHarness();

    h.controller.publishInboxSent({ from: 'w1', to: 'tower', subject: 'one' });
    h.controller.publishInboxSent({ from: 'w2', to: 'all', subject: 'two' });
    h.controller.publishInboxSent({ from: 'w1', to: 'tower', subject: 'three' });
    await vi.waitFor(() => expect(wakes(h)).toHaveLength(1));
    await settle();

    expect(wakes(h)).toHaveLength(1);
    expect(sentText(wakes(h)[0])).toContain('3 new tower inbox messages');
    expect(sentText(wakes(h)[0])).toContain('three');
  });

  it('queues consecutive legacy events with the same sender and subject independently', async () => {
    const h = await activeHarness();

    h.controller.publishInboxSent({ from: 'w1', to: 'tower', subject: 'same legacy subject' });
    h.controller.publishInboxSent({ from: 'w1', to: 'tower', subject: 'same legacy subject' });
    await vi.waitFor(() => expect(wakes(h)).toHaveLength(1));

    expect(sentText(wakes(h)[0])).toContain('2 new tower inbox messages');
    expect(sentText(wakes(h)[0]).match(/- w1: "same legacy subject"/g)).toHaveLength(2);
  });

  it('holds messages while the orchestrator is busy and delivers exactly one follow-up wake after the run', async () => {
    const h = await activeHarness();
    h.controller.publishInboxSent({ from: 'w1', to: 'tower', subject: 'first' });
    await vi.waitFor(() => expect(wakes(h)).toHaveLength(1));

    h.ctx.idle = false;
    h.controller.publishInboxSent({ from: 'w2', to: 'tower', subject: 'second' });
    h.controller.publishInboxSent({ from: 'w2', to: 'all', subject: 'third' });
    await settle();
    expect(wakes(h)).toHaveLength(1);

    h.ctx.idle = true;
    h.controller.onAgentSettled(settled, h.ctx.asContext);
    await vi.waitFor(() => expect(wakes(h)).toHaveLength(2));
    expect(sentText(wakes(h)[1])).toContain('2 new tower inbox messages');
    expect(sentText(wakes(h)[1])).toContain('third');
  });

  it('deduplicates a burst and bounds references while preserving the omitted count', async () => {
    const h = await activeHarness();

    for (let index = 1; index <= 8; index += 1) {
      h.controller.publishInboxSent({ from: 'w1', to: 'tower', subject: `subject-${String(index)}`, messageId: `msg-${String(index)}` });
    }
    h.controller.publishInboxSent({ from: 'w1', to: 'tower', subject: 'duplicate', messageId: 'msg-1' });
    await vi.waitFor(() => expect(wakes(h)).toHaveLength(1));

    const text = sentText(wakes(h)[0]);
    expect(text).toContain('8 new tower inbox messages');
    expect(text).toContain('omitted=2');
    expect(text).not.toContain('messageId=msg-1,');
    expect(text).not.toContain('messageId=msg-2)');
    expect(text).toContain('messageId=msg-3');
    expect(text).toContain('messageId=msg-8');
  });

  it('still wakes with references when gate observation fails, and digests missing missions', async () => {
    const h = await activeHarness();
    const gate = vi.spyOn(TowerStore.prototype, 'missionGate').mockRejectedValue(new Error('git exploded'));
    await new TowerStore(h.repo).plan([{ title: 'engine', scope: ['src/engine/**'] }]);
    try {
      h.controller.publishInboxSent({ from: 'w1', to: 'tower', subject: 'needs review', messageId: 'msg-observation', missionId: 'M1' });
      h.controller.publishInboxSent({ from: 'w1', to: 'tower', subject: 'other', messageId: 'msg-other', missionId: 'M9' });
      await vi.waitFor(() => expect(wakes(h)).toHaveLength(1));
    } finally {
      gate.mockRestore();
    }

    const text = sentText(wakes(h)[0]);
    expect(text).toContain('messageId=msg-observation');
    expect(text).toContain('Gate digest:');
    expect(text).toContain('- M1: gate=unavailable');
    expect(text).toContain('- M9: gate=mission-missing');
  });

  it('computes each related mission gate once in parallel with the runtime activity', async () => {
    const h = await activeHarness();
    await new TowerStore(h.repo).plan([
      { title: 'first mission', scope: ['src/first/**'] },
      { title: 'second mission', scope: ['src/second/**'] },
    ]);
    const original = TowerStore.prototype.missionGate;
    let active = 0;
    let maximum = 0;
    const gate = vi.spyOn(TowerStore.prototype, 'missionGate').mockImplementation(async function (this: TowerStore, state, mission, runtime) {
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        await delay(5);
        return await original.call(this, state, mission, runtime);
      } finally {
        active -= 1;
      }
    });
    try {
      h.controller.publishInboxSent({ from: 'w1', to: 'tower', subject: 'first update', messageId: 'm1', missionId: 'M1' });
      h.controller.publishInboxSent({ from: 'w1', to: 'tower', subject: 'second update', messageId: 'm2', missionId: 'M1' });
      h.controller.publishInboxSent({ from: 'w2', to: 'all', subject: 'third update', messageId: 'm3', missionId: 'M2' });
      await vi.waitFor(() => expect(wakes(h)).toHaveLength(1));

      const text = sentText(wakes(h)[0]);
      expect(text).toContain('M1: gate=BLOCKED reasons=not-completed');
      expect(text).toContain('M2: gate=BLOCKED reasons=not-completed');
      expect(gate.mock.calls.filter(([, mission]) => mission.id === 'M1')).toHaveLength(1);
      expect(gate.mock.calls.filter(([, mission]) => mission.id === 'M2')).toHaveLength(1);
      expect(gate.mock.calls[0]?.[2]?.activeAgentIds).toEqual(new Set());
      expect(maximum).toBe(2);
    } finally {
      gate.mockRestore();
    }
  });

  it('does not deliver a stale flush after exit and re-entry while gate evaluation is deferred', async () => {
    const h = await activeHarness();
    await new TowerStore(h.repo).plan([{ title: 'deferred mission', scope: ['src/deferred/**'] }]);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const gate = vi.spyOn(TowerStore.prototype, 'missionGate').mockImplementationOnce(async () => {
      await pending;
      return { ready: false, noop: false, blocks: [], observations: {} } as never;
    });
    try {
      h.controller.publishInboxSent({ from: 'w1', to: 'tower', subject: 'old flush', messageId: 'msg-old-flush', missionId: 'M1' });
      await vi.waitFor(() => expect(gate).toHaveBeenCalled());

      await h.controller.exit();
      await h.controller.enter();
      release();
      await settle();
      expect(wakes(h)).toEqual([]);

      h.controller.publishInboxSent({ from: 'w1', to: 'tower', subject: 'new flush', messageId: 'msg-new-flush' });
      await vi.waitFor(() => expect(wakes(h)).toHaveLength(1));
      expect(sentText(wakes(h)[0])).toContain('messageId=msg-new-flush');
      expect(sentText(wakes(h)[0])).not.toContain('messageId=msg-old-flush');
    } finally {
      release();
      gate.mockRestore();
    }
  });

  it('ignores direct messages and messages from the tower itself, and never wakes while inactive', async () => {
    const h = await activeHarness();
    h.controller.publishInboxSent({ from: 'w1', to: 'w2', subject: 'direct' });
    h.controller.publishInboxSent({ from: 'tower', to: 'all', subject: 'self broadcast' });
    await settle();
    expect(wakes(h)).toEqual([]);

    await h.controller.exit();
    h.controller.publishInboxSent({ from: 'w1', to: 'tower', subject: 'hello' });
    await settle();
    expect(wakes(h)).toEqual([]);
  });

  it('drops a queued wake when tower mode exits before it is delivered', async () => {
    const h = await activeHarness();
    h.ctx.idle = false;
    h.controller.publishInboxSent({ from: 'w1', to: 'tower', subject: 'need wider scope' });
    await settle();

    await h.controller.exit();
    h.ctx.idle = true;
    h.controller.onAgentSettled(settled, h.ctx.asContext);
    await settle();

    expect(wakes(h)).toEqual([]);
  });

  it('truncates a very long subject in the wake preview', async () => {
    const h = await activeHarness();

    h.controller.publishInboxSent({ from: 'w1', to: 'tower', subject: 'x'.repeat(500) });
    await vi.waitFor(() => expect(wakes(h)).toHaveLength(1));

    expect(sentText(wakes(h)[0])).not.toContain('x'.repeat(500));
    expect(sentText(wakes(h)[0])).toContain(`${'x'.repeat(120)}…`);
  });

  it('requeues the batch when delivery fails and retries after the next settle', async () => {
    const h = await activeHarness();
    h.pi.sendFailure = new Error('session is busy');

    h.controller.publishInboxSent({ from: 'w1', to: 'tower', subject: 'retry me', messageId: 'msg-retry' });
    await settle();
    expect(wakes(h)).toEqual([]);

    h.controller.onAgentSettled(settled, h.ctx.asContext);
    await vi.waitFor(() => expect(wakes(h)).toHaveLength(1));
    expect(sentText(wakes(h)[0])).toContain('messageId=msg-retry');
  });
});

describe('tower-mode reminders', () => {
  async function inject(h: Harness, messageType: 'user' | 'custom' = 'user') {
    const result = await h.controller.onBeforeAgentStart(beforeStart(messageType), h.ctx.asContext);
    if (result?.message !== undefined) {
      h.session.append({ type: 'custom_message', customType: result.message.customType, content: result.message.content, display: result.message.display, details: result.message.details });
    }
    return result?.message;
  }

  it('injects the full reminder as a hidden persisted message once tower mode is on', async () => {
    const h = await harness();
    expect(await inject(h)).toBeUndefined();

    await h.controller.enter();
    const message = await inject(h);

    expect(message).toEqual({ customType: TOWER_REMINDER_MESSAGE, content: TOWER_MODE_FULL_REMINDER, display: false, details: { kind: 'full' } });
  });

  it('follows the sparse and full refresh cadence and refreshes on new human input', async () => {
    const h = await harness();
    await h.controller.enter();
    expect((await inject(h))?.details).toEqual({ kind: 'full' });

    h.session.appendMessage('assistant');
    expect(await inject(h, 'custom')).toBeUndefined();
    h.session.appendMessage('assistant');
    expect((await inject(h, 'custom'))?.content).toBe(TOWER_MODE_SPARSE_REMINDER);

    for (let index = 0; index < 5; index += 1) h.session.appendMessage('assistant');
    expect((await inject(h, 'custom'))?.content).toBe(TOWER_MODE_FULL_REMINDER);

    h.session.appendMessage('assistant');
    expect((await inject(h, 'user'))?.content).toBe(TOWER_MODE_FULL_REMINDER);
  });

  it('does not refresh the full reminder for injected custom messages', async () => {
    const h = await harness();
    await h.controller.enter();
    await inject(h);
    h.session.appendMessage('assistant');
    h.session.append({ type: 'custom_message', customType: TOWER_INBOX_WAKE_MESSAGE, content: 'wake', display: true });

    expect(await inject(h, 'custom')).toBeUndefined();
  });

  it('injects the exit reminder once after tower mode turns off and the full one on re-entry', async () => {
    const h = await harness();
    await h.controller.enter();
    await inject(h);
    await h.controller.exit();

    expect((await inject(h))?.content).toBe(TOWER_MODE_EXIT_REMINDER);
    expect(await inject(h)).toBeUndefined();

    await h.controller.enter();
    expect((await inject(h))?.content).toBe(TOWER_MODE_FULL_REMINDER);
  });

  it('re-arms the full reminder after a compaction drops the last one from the context', async () => {
    const h = await harness();
    await h.controller.enter();
    await inject(h);
    h.session.appendMessage('assistant');
    expect(await inject(h, 'custom')).toBeUndefined();

    h.session.compact();

    expect((await inject(h, 'custom'))?.content).toBe(TOWER_MODE_FULL_REMINDER);
  });
});

describe('background agent notifications', () => {
  async function withAgent(kind: 'worker' | 'reviewer' = 'worker') {
    const h = await harness();
    await new TowerStore(h.repo).init('session-main');
    await h.controller.enter();
    const launched = await h.runtime.spawn({ name: kind === 'worker' ? 'agent-build' : 'reviewer-a', kind, cwd: h.repo, prompt: 'go', description: kind === 'worker' ? 'M1 agent-build: Build gemm' : 'M1 review: feat/build-gemm' });
    if (!launched.ok) throw new Error('spawn failed');
    return { ...h, agentId: launched.agentId };
  }

  function notifications(h: Harness) {
    return h.pi.sentOfType(TOWER_AGENT_NOTIFICATION_MESSAGE);
  }

  it('notifies a completion with the final message, as a follow-up that triggers a turn', async () => {
    const h = await withAgent();

    h.runtime.finish(h.agentId, 'idle', { summary: 'Shipped the kernel.' });

    const [note] = notifications(h);
    expect(note?.options).toEqual({ triggerTurn: true, deliverAs: 'followUp' });
    const text = sentText(note);
    expect(text).toContain(`<notification id="task:task-1:completed"`);
    expect(text).toContain('Title: Background worker completed');
    expect(text).toContain('M1 agent-build: Build gemm completed.');
    expect(text).toContain('Shipped the kernel.');
  });

  it('notifies a failure with TowerResume recovery guidance', async () => {
    const h = await withAgent();

    h.runtime.finish(h.agentId, 'failed', { stopReason: 'provider blew up' });

    const text = sentText(notifications(h)[0]);
    expect(text).toContain('Severity: warning');
    expect(text).toContain('M1 agent-build: Build gemm failed. Reason: provider blew up');
    expect(text).toContain('TowerResume(agent="agent-build"');
  });

  it('marks human stops as dead by intent and tower stops as intentional', async () => {
    const human = await withAgent();
    await human.controller.humanStop(human.agentId);
    expect(sentText(notifications(human)[0])).toContain('was stopped by user.');
    expect(sentText(notifications(human)[0])).toContain('dead by intent');

    const tower = await withAgent();
    await tower.controller.stopAgent(tower.agentId, 'stopped by the tower: redirect');
    expect(sentText(notifications(tower)[0])).toContain('The tower stopped this worker on purpose with TowerTaskStop');
    expect(sentText(notifications(tower)[0])).not.toContain('dead by intent');
  });

  it('delivers notifications even with tower mode off', async () => {
    const h = await withAgent();
    await h.controller.exit();

    h.runtime.finish(h.agentId, 'timed_out', { stopReason: 'timed out after 2h' });

    expect(sentText(notifications(h)[0])).toContain('M1 agent-build: Build gemm timed out.');
  });

  it('surfaces steers that never reached the agent before its run ended', async () => {
    const h = await withAgent();

    h.runtime.finish(h.agentId, 'idle', { undeliveredSteers: ['[tower inbox] new message from tower: "rebase now"'] });

    const text = sentText(notifications(h)[0]);
    expect(text).toContain('Undelivered steers: 1 steered message(s) never reached agent-build');
    expect(text).toContain('rebase now');
    expect(text).toContain('they sit only in its inbox');
  });

  it('disposes a reviewer session after it finishes but keeps its output for TowerTaskOutput', async () => {
    const h = await withAgent('reviewer');

    h.runtime.finish(h.agentId, 'idle', { summary: 'Review submitted: clean.' });
    await vi.waitFor(() => expect(h.runtime.disposed).toEqual([h.agentId]));

    expect(h.controller.agentOutput(h.agentId)?.lastAssistantText).toBe('Review submitted: clean.');
    expect(h.controller.listAgents(false).map((agent) => agent.agentId)).toContain(h.agentId);
    expect(h.controller.listAgents(true)).toEqual([]);
  });

  it('keeps a winding-down reviewer visible to the merge gate until it settles, then disposes it', async () => {
    const h = await withAgent('reviewer');

    h.runtime.finish(h.agentId, 'stopped', { stopReason: 'stopped by the tower', windingDown: true });
    await settle();

    expect(h.runtime.disposed).toEqual([]);
    expect(h.controller.activeAgentIds().has(h.agentId)).toBe(true);

    h.runtime.settle(h.agentId);
    await vi.waitFor(() => expect(h.runtime.disposed).toEqual([h.agentId]), { timeout: 3_000 });
    expect(h.controller.agentOutput(h.agentId)?.windingDown).toBe(false);
  });

  it('reports a disposed reviewer to TowerTaskStop as not running rather than unknown', async () => {
    const h = await withAgent('reviewer');
    h.runtime.finish(h.agentId, 'idle', { summary: 'Review submitted: clean.' });
    await vi.waitFor(() => expect(h.runtime.disposed).toEqual([h.agentId]));

    const result = await createTowerTaskStopTool(h.controller, ORCHESTRATOR_CALLER).run(
      { agent: h.agentId },
      { toolCallId: 'call_stop' },
    );

    expect(result).toEqual({
      output: `tower agent "reviewer-a" (agent_id: ${h.agentId}) is not running — its last run ended with status: completed; nothing was stopped`,
    });
    expect(h.runtime.stops).toEqual([]);
  });

  it('sends no notification for a launch that was aborted after a persistence failure', async () => {
    const h = await withAgent();

    await h.controller.abortAgent(h.agentId);

    expect(notifications(h)).toEqual([]);
    expect(h.runtime.disposed).toEqual([h.agentId]);
  });
});

describe('agent registration gate', () => {
  it("holds a new agent's tower tool calls until its roster entry is registered or its spawn is aborted", async () => {
    const h = await harness();
    h.controller.expectAgentRegistration('agent-new');
    let released = false;
    const waiting = h.controller.agentRegistration('agent-new').then(() => {
      released = true;
    });
    await settle();
    expect(released).toBe(false);

    h.controller.agentRegistered('agent-new');
    await waiting;
    expect(released).toBe(true);

    h.controller.expectAgentRegistration('agent-aborted');
    const aborted = h.controller.agentRegistration('agent-aborted');
    await h.controller.abortAgent('agent-aborted');
    await expect(aborted).resolves.toBeUndefined();
    await expect(h.controller.agentRegistration('agent-resumed')).resolves.toBeUndefined();
  });
});

describe('session shutdown and provider rate limits', () => {
  it('stops every agent, records shutdown deaths, keeps ownership and sends no notifications', async () => {
    const h = await harness();
    const store = new TowerStore(h.repo);
    await store.init('session-main');
    await h.controller.enter();
    const launched = await h.runtime.spawn({ name: 'w1', kind: 'worker', cwd: h.repo, prompt: 'go' });
    if (!launched.ok) throw new Error('spawn failed');
    await store.registerAgent({ name: 'w1', kind: 'worker', agentId: launched.agentId, sessionId: 'session-main', spawnedAt: new Date().toISOString() });

    await h.controller.onSessionShutdown();

    expect(h.runtime.disposedAll).toBe('shutdown');
    const state = await store.load();
    expect(state.roster.agents[0]).toMatchObject({ deathStatus: 'stopped', deathReason: 'shutdown' });
    expect(state.sessionId).toBe('session-main');
    expect(h.pi.sentOfType(TOWER_AGENT_NOTIFICATION_MESSAGE)).toEqual([]);
  });

  it('feeds the orchestrator 429s into the spawn limiter', async () => {
    const h = await harness();

    h.controller.onAfterProviderResponse({ type: 'after_provider_response', status: 200, headers: {} } as AfterProviderResponseEvent);
    h.controller.onAfterProviderResponse({ type: 'after_provider_response', status: 429, headers: {} } as AfterProviderResponseEvent);

    expect(h.runtime.rateLimited).toBe(1);
    expect(h.runtime.successes).toBe(0);
  });

  it('uses the human stop marker only for /tower stop', async () => {
    const h = await harness();
    const launched = await h.runtime.spawn({ name: 'w1', kind: 'worker', cwd: h.repo, prompt: 'go' });
    if (!launched.ok) throw new Error('spawn failed');

    await h.controller.humanStop('w1');
    expect(h.runtime.stops).toEqual([]);
    await h.controller.humanStop(launched.agentId);
    expect(h.runtime.stops).toEqual([{ id: launched.agentId, reason: HUMAN_STOP_REASON }]);
  });
});
