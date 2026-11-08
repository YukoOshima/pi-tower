import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TOWER_MAIN_AGENT_ONLY,
  TOWER_MODE_USER_ENABLED_ONLY,
  sendDeferredNote,
  sendHandledNote,
  sendUnreachableNote,
} from '../../src/prompts/index.ts';
import { MAIN_AGENT_ID, TOWER_GIT_CONCURRENCY, TowerStore } from '../../src/protocol/index.ts';
import { createTowerCompleteTool } from '../../src/tools/complete/completeTool.ts';
import { createTowerFindingTool } from '../../src/tools/finding/findingTool.ts';
import { createTowerInboxTool } from '../../src/tools/inbox/inboxTool.ts';
import { createTowerInitTool } from '../../src/tools/init/initTool.ts';
import { createTowerMergeTool } from '../../src/tools/merge/mergeTool.ts';
import { createTowerMissionTool } from '../../src/tools/mission/missionTool.ts';
import { createTowerPlanTool } from '../../src/tools/plan/planTool.ts';
import { createTowerRebaseTool } from '../../src/tools/rebase/rebaseTool.ts';
import { createTowerReviewTool } from '../../src/tools/review/reviewTool.ts';
import { createTowerSendTool } from '../../src/tools/send/sendTool.ts';
import { readTowerStatus, readTowerStatusSummary } from '../../src/tools/status/statusReader.ts';
import { createTowerStatusTool } from '../../src/tools/status/statusTool.ts';
import type { TowerCaller, TowerTool } from '../../src/tools/support.ts';
import { createTowerTeardownTool } from '../../src/tools/teardown/teardownTool.ts';
import { HUMAN_STOP_REASON } from '../../src/tower/constants.ts';
import { TestHost, commitFile, createRepo, git, removeDir } from '../tower/fakes.ts';

let repo: string;
let host: TestHost;
let currentAgentId: string;

beforeEach(async () => {
  repo = await createRepo('tower-tools-test-');
  host = new TestHost(repo);
  host.active = false;
  currentAgentId = MAIN_AGENT_ID;
});

afterEach(async () => {
  await removeDir(repo);
});

function caller(): TowerCaller {
  return { agentId: currentAgentId };
}

type Factory<T extends TowerTool> = (h: TestHost, c: TowerCaller) => T;

async function run<T extends TowerTool>(factory: Factory<T>, args: Parameters<T['run']>[0]) {
  return factory(host, caller()).run(args, { toolCallId: 'call_1' });
}

async function initViaTool() {
  host.active = true;
  const result = await run(createTowerInitTool, {});
  expect(result.isError).toBeFalsy();
  return result;
}

function readStatus() {
  return readTowerStatus({
    active: host.active,
    store: new TowerStore(repo),
    agentId: currentAgentId,
    activeAgentIds: () => host.activeAgentIds(),
    concurrency: () => host.rateLimitSnapshot(),
  });
}

function readStatusSummary() {
  return readTowerStatusSummary({
    active: host.active,
    store: new TowerStore(repo),
    agentId: currentAgentId,
    activeAgentIds: () => host.activeAgentIds(),
    concurrency: () => host.rateLimitSnapshot(),
  });
}

async function runningAgent(name: string): Promise<string> {
  const launched = await host.runtime.spawn({ name, cwd: repo, prompt: 'work' });
  if (!launched.ok) throw new Error(launched.reason);
  return launched.agentId;
}

describe('TowerInitTool', () => {
  it('refuses when tower mode is inactive — only the user can enable it', async () => {
    const result = await run(createTowerInitTool, {});

    expect(result.isError).toBe(true);
    expect(result.output).toBe(TOWER_MODE_USER_ENABLED_ONLY);
    expect(await stat(join(repo, '.tower')).catch(() => undefined)).toBeUndefined();
  });

  it('creates .tower when tower mode is active', async () => {
    host.active = true;

    const result = await run(createTowerInitTool, {});

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('tower workspace initialized');
    expect(result.output).toContain('base branch: main');
    expect((await stat(join(repo, '.tower/comms'))).isDirectory()).toBe(true);
    expect((await new TowerStore(repo).load()).ownerPid).toBe(process.pid);
  });

  it('accepts an explicit base branch and notes the checkout mismatch', async () => {
    await git(repo, 'branch', 'develop');
    host.active = true;

    const result = await run(createTowerInitTool, { base: 'develop' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('base branch: develop');
    expect(result.output).toContain('the main checkout is on "main", not base "develop"');
    expect((await new TowerStore(repo).load()).base).toBe('develop');
  });

  it('re-anchors the base when re-initializing with a different one', async () => {
    await git(repo, 'branch', 'develop');
    await initViaTool();

    const second = await run(createTowerInitTool, { base: 'develop' });

    expect(second.isError).toBeFalsy();
    expect(second.output).toContain('base re-anchored from "main" to "develop"');
    expect((await new TowerStore(repo).load()).base).toBe('develop');
  });

  it('prints the real re-anchor relation for every open mission', async () => {
    await initViaTool();
    const store = new TowerStore(repo);
    const [current, stale, planned] = await store.plan([
      { title: 'current work', scope: ['src/current/**'] },
      { title: 'stale work', scope: ['src/stale/**'] },
      { title: 'planned work', scope: ['src/planned/**'] },
    ]);
    const state = await store.load();
    await store.addWorktree(current!.worktree, current!.branch, state.base);
    await store.addWorktree(stale!.worktree, stale!.branch, state.base);
    await commitFile(join(repo, '.tower/worktrees', current!.worktree), 'src/current/current.ts', 'current\n', 'current work');
    await commitFile(join(repo, '.tower/worktrees', stale!.worktree), 'src/stale/stale.ts', 'stale\n', 'stale work');
    await git(repo, 'branch', '-f', 'develop', current!.branch);

    const result = await run(createTowerInitTool, { base: 'develop' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain(`mission ${current!.id} (${current!.branch}): up-to-date`);
    expect(result.output).toContain(`mission ${stale!.id} (${stale!.branch}): stale`);
    expect(result.output).toContain(`TowerRebase(mission="${stale!.id}")`);
    expect(result.output).toContain(`mission ${planned!.id} (${planned!.branch}): no-branch`);
  });

  it('rejects a base that is not a local branch', async () => {
    host.active = true;

    const result = await run(createTowerInitTool, { base: 'origin/main' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('does not exist as a local branch');
  });

  it('is idempotent — a second run reports already-initialized and keeps state', async () => {
    await initViaTool();
    await run(createTowerPlanTool, { missions: [{ title: 'kept mission', scope: ['src/kept/**'] }] });

    const second = await run(createTowerInitTool, {});

    expect(second.isError).toBeFalsy();
    expect(second.output).toContain('tower workspace already initialized');
    expect((await new TowerStore(repo).load()).missions).toHaveLength(1);
  });

  it('adopting from a previous session retires its roster and says so', async () => {
    await initViaTool();
    const store = new TowerStore(repo);
    await store.registerAgent({
      name: 'agent-build',
      agentId: 'agent-0',
      sessionId: 'session-test',
      kind: 'worker',
      spawnedAt: new Date().toISOString(),
    });
    host.sessionId = 'session-next';

    const second = await run(createTowerInitTool, {});

    expect(second.isError).toBeFalsy();
    expect(second.output).toContain('retired its stale roster entries: agent-build');
    const state = await store.load();
    expect(state.sessionId).toBe('session-next');
    expect(state.roster.agents).toEqual([]);
    expect(host.isRetiredAgent('agent-build')).toBe(true);
  });

  it('refuses to adopt while the owning session is live', async () => {
    await initViaTool();
    host.liveOwners.add('session-test');
    host.sessionId = 'session-next';

    const result = await run(createTowerInitTool, {});

    expect(result.isError).toBe(true);
    expect(result.output).toContain(`owned by a live session (session-test, pid ${String(process.pid)})`);
    expect((await new TowerStore(repo).load()).sessionId).toBe('session-test');
  });

  it('adopts once the owning session released ownership, even while it is still live', async () => {
    await initViaTool();
    host.liveOwners.add('session-test');
    host.sessionId = 'session-next';

    const blocked = await run(createTowerInitTool, {});
    expect(blocked.isError).toBe(true);

    await new TowerStore(repo).release('session-test');

    const adopted = await run(createTowerInitTool, {});
    expect(adopted.isError).toBeFalsy();
    expect(adopted.output).toContain('tower workspace already initialized');
    expect((await new TowerStore(repo).load()).sessionId).toBe('session-next');
  });
});

describe('TowerPlanTool', () => {
  it('refuses when tower mode is inactive', async () => {
    const result = await run(createTowerPlanTool, {
      missions: [{ title: 'engine', scope: ['src/engine/**'] }],
    });

    expect(result.isError).toBe(true);
    expect(result.output).toBe(TOWER_MODE_USER_ENABLED_ONLY);
  });

  it('plans missions on a real repo once tower mode is active', async () => {
    await initViaTool();

    const result = await run(createTowerPlanTool, {
      missions: [
        { title: 'Build engine', scope: ['src/engine/**'], tasks: ['scaffold'] },
        { title: 'Build UI', scope: ['src/ui/**'], deps: ['M1'] },
      ],
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('planned 2 mission(s):');
    expect(result.output).toContain('| M1 | Build engine | build | feat/build-engine | wt-1 | src/engine/** |');
    expect(result.output).toContain('| M2 | Build UI | build | feat/build-ui | wt-2 | src/ui/** |');
  });

  it('passes mission context through to the stored mission', async () => {
    await initViaTool();

    const result = await run(createTowerPlanTool, {
      missions: [
        { title: 'Build engine', scope: ['src/engine/**'], tasks: ['scaffold'], context: 'Ship it as a single binary.' },
      ],
    });

    expect(result.isError).toBeFalsy();
    expect((await new TowerStore(repo).load()).missions[0]?.context).toBe('Ship it as a single binary.');
  });

  it('rejects a re-planned title whose slugged branch is already taken, guiding a title change', async () => {
    await initViaTool();
    await run(createTowerPlanTool, { missions: [{ title: 'Build engine', scope: ['src/engine/**'] }] });

    const result = await run(createTowerPlanTool, {
      missions: [{ title: 'build engine', scope: ['src/engine-v2/**'] }],
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('feat/build-engine');
    expect(result.output).toContain('already used by M1');
    expect(result.output).toContain('change the title');
    expect((await new TowerStore(repo).load()).missions).toHaveLength(1);
  });

  it('rejects the slug of an abandoned mission too', async () => {
    await initViaTool();
    await run(createTowerPlanTool, { missions: [{ title: 'Build engine', scope: ['src/engine/**'] }] });
    await new TowerStore(repo).updateMission('tower', 'M1', { status: 'abandoned' });

    const result = await run(createTowerPlanTool, {
      missions: [{ title: 'Build engine', scope: ['src/web/**'] }],
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('already used by M1 (abandoned)');
  });

  it('rejects a non-ASCII mission title and tells the tower to re-plan in English', async () => {
    await initViaTool();

    const result = await run(createTowerPlanTool, {
      missions: [{ title: 'Исправить ошибку входа', scope: ['src/x/**'] }],
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('contains non-ASCII characters');
    expect((await new TowerStore(repo).load()).missions).toHaveLength(0);
  });
});

describe('TowerTeardownTool', () => {
  it('tears down the workspace and keeps tower mode active', async () => {
    await initViaTool();

    const result = await run(createTowerTeardownTool, {});

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('tower teardown:');
    expect(result.output).toContain('Tower mode stays active');
    expect(host.active).toBe(true);
  });

  it('refuses to tear down while the owning session is live, and tears down once released', async () => {
    await initViaTool();
    host.liveOwners.add('session-test');
    host.sessionId = 'session-next';

    const blocked = await run(createTowerTeardownTool, {});
    expect(blocked.isError).toBe(true);
    expect(blocked.output).toContain('dismantle that session');
    expect((await new TowerStore(repo).load()).sessionId).toBe('session-test');

    await new TowerStore(repo).release('session-test');
    const result = await run(createTowerTeardownTool, {});
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('tower teardown:');
  });

  it('keeps worktrees whose roster agent has a running task, even with force', async () => {
    await initViaTool();
    await run(createTowerPlanTool, { missions: [{ title: 'Build engine', scope: ['src/engine/**'] }] });
    const store = new TowerStore(repo);
    const state = await store.load();
    const mission = state.missions[0]!;
    await store.addWorktree(mission.worktree, mission.branch, state.base);
    const agentId = await runningAgent('w1');
    await store.registerAgent({
      name: 'w1',
      kind: 'worker',
      agentId,
      worktree: mission.worktree,
      spawnedAt: new Date().toISOString(),
    });

    const result = await run(createTowerTeardownTool, { force: true });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain(`kept .tower/worktrees/${mission.worktree} (live agent: w1)`);
    expect((await stat(join(repo, '.tower/worktrees', mission.worktree))).isDirectory()).toBe(true);

    host.runtime.finish(agentId);
    const settled = await run(createTowerTeardownTool, {});
    expect(settled.output).toContain(`removed .tower/worktrees/${mission.worktree}`);
  });

  it('dry run reports the decisions and changes nothing; exclude keeps worktrees', async () => {
    await initViaTool();
    await run(createTowerPlanTool, { missions: [{ title: 'Build engine', scope: ['src/engine/**'] }] });
    const store = new TowerStore(repo);
    const state = await store.load();
    const mission = state.missions[0]!;
    await store.addWorktree(mission.worktree, mission.branch, state.base);

    const dry = await run(createTowerTeardownTool, { dry_run: true });
    expect(dry.output).toContain('tower teardown (dry run');
    expect(dry.output).toContain(`would remove .tower/worktrees/${mission.worktree}`);

    const excluded = await run(createTowerTeardownTool, { exclude: [mission.worktree] });
    expect(excluded.output).toContain(`kept .tower/worktrees/${mission.worktree} (excluded)`);
    expect((await stat(join(repo, '.tower/worktrees', mission.worktree))).isDirectory()).toBe(true);
  });
});

describe('TowerSendTool + TowerInboxTool', () => {
  beforeEach(async () => {
    await initViaTool();
    const store = new TowerStore(repo);
    await store.registerAgent({ name: 'w1', kind: 'worker', agentId: 'agent-w1', spawnedAt: '2026-09-20T00:00:00.000Z' });
    await store.registerAgent({ name: 'w2', kind: 'worker', agentId: 'agent-w2', spawnedAt: '2026-09-20T00:00:00.000Z' });
  });

  it('worker inbox shows only own and broadcast messages; the tower sees everything', async () => {
    await run(createTowerSendTool, { to: 'w1', subject: 'for w1', body: 'a' });
    await run(createTowerSendTool, { to: 'w2', subject: 'for w2', body: 'b' });
    await run(createTowerSendTool, { to: 'all', subject: 'broadcast', body: 'c' });

    currentAgentId = 'agent-w1';
    const w1Inbox = await run(createTowerInboxTool, {});
    expect(w1Inbox.isError).toBeFalsy();
    expect(w1Inbox.output).toContain('2 message(s) for w1');
    expect(w1Inbox.output).toContain('subject: for w1');
    expect(w1Inbox.output).toContain('subject: broadcast');
    expect(w1Inbox.output).not.toContain('subject: for w2');
    expect(w1Inbox.output).toContain('0 unread message(s) remaining');

    currentAgentId = 'agent-w1';
    await run(createTowerSendTool, { to: 'tower', subject: 'report', body: 'd' });

    currentAgentId = MAIN_AGENT_ID;
    const towerInbox = await run(createTowerInboxTool, {});
    expect(towerInbox.output).toContain('4 message(s) for tower');
    for (const subject of ['for w1', 'for w2', 'broadcast', 'report']) {
      expect(towerInbox.output).toContain(`subject: ${subject}`);
    }
  });

  it('publishes the inbox wake signal only for worker messages to the tower or all', async () => {
    currentAgentId = 'agent-w1';
    await run(createTowerSendTool, { to: 'tower', subject: 'need wider scope', body: 'x' });
    await run(createTowerSendTool, { to: 'all', subject: 'fyi fleet', body: 'x' });
    await run(createTowerSendTool, { to: 'w2', subject: 'side channel', body: 'x' });
    currentAgentId = MAIN_AGENT_ID;
    await run(createTowerSendTool, { to: 'all', subject: 'tower broadcast', body: 'x' });

    expect(host.published.map(({ from, to, subject }) => ({ from, to, subject }))).toEqual([
      { from: 'w1', to: 'tower', subject: 'need wider scope' },
      { from: 'w1', to: 'all', subject: 'fyi fleet' },
    ]);
    const [first] = host.published;
    expect(first?.messageId).toBeTruthy();
    const raw = await readFile(join(repo, first!.file!), 'utf8');
    expect(raw).toContain(first!.messageId!);
  });

  it('reads and stamps the mailbox of the latest registration when the agent id collides with a stale roster entry', async () => {
    const file = join(repo, '.tower/comms/state.json');
    const state = JSON.parse(await readFile(file, 'utf8')) as { roster: { agents: Record<string, unknown>[] } };
    state.roster.agents.unshift({
      name: 'w-stale',
      kind: 'worker',
      agentId: 'agent-w1',
      sessionId: 'session-old',
      spawnedAt: '2026-09-13T08:00:00.000Z',
    });
    await writeFile(file, `${JSON.stringify(state, null, 2)}\n`);

    await run(createTowerSendTool, { to: 'w1', subject: 'for current w1', body: 'a' });
    await run(createTowerSendTool, { to: 'w-stale', subject: 'for stale identity', body: 'b' });

    currentAgentId = 'agent-w1';
    const inbox = await run(createTowerInboxTool, {});
    expect(inbox.output).toContain('message(s) for w1');
    expect(inbox.output).toContain('subject: for current w1');
    expect(inbox.output).not.toContain('subject: for stale identity');
  });

  it('maps a TowerProtocolError (unknown recipient) to an isError result', async () => {
    const result = await run(createTowerSendTool, { to: 'ghost', subject: 'hi', body: 'x' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('unknown recipient "ghost"');
    expect(result.output).toContain('known: tower, all, w1, w2');
  });

  it('tells the tower how its message reaches the agent for every undelivered steer outcome', async () => {
    const store = new TowerStore(repo);
    const register = async (name: string): Promise<string> => {
      const agentId = await runningAgent(name);
      await store.registerAgent({ name, kind: 'worker', agentId, spawnedAt: new Date().toISOString() });
      return agentId;
    };
    const send = (to: string) => run(createTowerSendTool, { to, subject: `for ${to}`, body: 'x' });

    const unknown = await send('w1');
    expect(unknown.isError).toBeFalsy();
    expect(unknown.output).toContain(sendUnreachableNote('w1', 'worker'));

    host.runtime.finish(await register('w4'), 'idle');
    const finished = await send('w4');
    expect(finished.output).toContain('w4 has no running task');
    expect(finished.output).toContain('TowerResume(agent="w4", prompt="...")');

    host.runtime.finish(await register('w5'), 'stopped', { stopReason: 'stopped by the tower', windingDown: true });
    expect((await send('w5')).output).toContain(sendDeferredNote('w5', true));

    await register('w6');
    host.runtime.steerResult = 'idle';
    expect((await send('w6')).output).toContain(sendDeferredNote('w6', false));

    host.runtime.steerResult = 'handled';
    const handled = await send('w6');
    expect(handled.output).toContain(sendHandledNote('w6'));
    expect(handled.output).not.toContain('steered into its running turn');
  });

  it('skips the delivery note for broadcasts and for sends from workers', async () => {
    const broadcast = await run(createTowerSendTool, { to: 'all', subject: 'b', body: 'x' });
    expect(broadcast.output).not.toContain('has no running task');

    currentAgentId = 'agent-w1';
    const fromWorker = await run(createTowerSendTool, { to: 'w2', subject: 'b', body: 'x' });
    expect(fromWorker.output).not.toContain('has no running task');
  });

  it('acks only returned unread pages, so completion waits for every page', async () => {
    const store = new TowerStore(repo);
    await run(createTowerPlanTool, { missions: [{ title: 'Build engine', scope: ['src/engine/**'] }] });
    await git(repo, 'checkout', '-b', 'feat/build-engine');
    await commitFile(repo, 'src/engine/engine.ts', 'export const engine = 1;\n', 'engine work');
    await git(repo, 'checkout', 'main');
    await store.registerAgent({
      name: 'w3',
      kind: 'worker',
      agentId: 'agent-w3',
      missionId: 'M1',
      branch: 'feat/build-engine',
      spawnedAt: '2026-09-20T00:00:00.000Z',
    });
    await store.updateMission('tower', 'M1', { status: 'active', owner: 'w3' }, { silent: true });
    for (const subject of ['requirement change', 'test update', 'final note']) {
      const sent = await run(createTowerSendTool, { to: 'w3', subject, body: 'incorporate this' });
      expect(sent.isError).toBeFalsy();
    }
    const inboxDir = join(repo, '.tower/comms/inbox');
    for (const file of await readdir(inboxDir)) {
      const path = join(inboxDir, file);
      const text = await readFile(path, 'utf8');
      await writeFile(path, text.replace(/^sent_at:.*$/m, 'sent_at: 2026-09-21T00:00:00.000Z'));
    }

    currentAgentId = 'agent-w3';
    const refused = await run(createTowerMissionTool, { id: 'M1', status: 'completed' });
    expect(refused.isError).toBe(true);
    expect(refused.output).toContain('3 unread inbox message(s) for w3');

    const firstPage = await run(createTowerInboxTool, { limit: 2 });
    expect(firstPage.output).toContain('2 message(s) for w3');
    expect(firstPage.output).toContain('1 unread message(s) remaining');

    const lastPage = await run(createTowerInboxTool, { limit: 2 });
    expect(lastPage.output).toContain('1 message(s) for w3');
    expect(lastPage.output).toContain('0 unread message(s) remaining');

    const accepted = await run(createTowerMissionTool, { id: 'M1', status: 'completed' });
    expect(accepted.isError).toBeFalsy();
    expect(accepted.output).toContain('status: completed');
  });

  it('include_read returns history without acknowledging items outside the returned page', async () => {
    for (const subject of ['one', 'two', 'three']) {
      await run(createTowerSendTool, { to: 'w1', subject, body: subject });
    }
    currentAgentId = 'agent-w1';

    const firstPage = await run(createTowerInboxTool, { limit: 2 });
    expect(firstPage.output).toContain('1 unread message(s) remaining');
    const history = await run(createTowerInboxTool, { limit: 2, include_read: true });
    expect(history.output).toContain('2 message(s) for w1');
    expect(history.output).toContain('1 unread message(s) remaining');

    const lastPage = await run(createTowerInboxTool, {});
    expect(lastPage.output).toContain('1 message(s) for w1');
    expect(lastPage.output).toContain('0 unread message(s) remaining');
    const emptyPage = await run(createTowerInboxTool, {});
    expect(emptyPage.output).toBe('inbox empty for w1; 0 unread message(s) remaining');
  });

  it('steers a message into a running agent so it lands at the next step boundary', async () => {
    const store = new TowerStore(repo);
    const agentId = await runningAgent('w4');
    await store.registerAgent({ name: 'w4', kind: 'worker', agentId, spawnedAt: new Date().toISOString() });

    const result = await run(createTowerSendTool, { to: 'w4', subject: 'rebase now', body: 'rebase onto latest main' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('steered into its running turn');
    expect(result.output).not.toContain('has no running task');
    expect(host.runtime.steers).toHaveLength(1);
    expect(host.runtime.steers[0]?.text).toContain('new message from tower: "rebase now"');
    expect(host.runtime.steers[0]?.text).toContain('TowerInbox');
  });

  it('steers worker-to-worker sends into the sibling run', async () => {
    const store = new TowerStore(repo);
    const agentId = await runningAgent('w5');
    await store.registerAgent({ name: 'w5', kind: 'worker', agentId, spawnedAt: new Date().toISOString() });
    currentAgentId = 'agent-w1';

    const result = await run(createTowerSendTool, { to: 'w5', subject: 'contract', body: 'x' });

    expect(result.output).toContain('steered into its running turn');
    expect(host.runtime.steers[0]?.text).toContain('new message from w1');
  });
});

describe('TowerFindingTool', () => {
  it('files a finding for a worker and tells it the tower routes it', async () => {
    await initViaTool();
    await new TowerStore(repo).registerAgent({ name: 'w1', kind: 'worker', agentId: 'agent-w1', spawnedAt: new Date().toISOString() });
    currentAgentId = 'agent-w1';

    const result = await run(createTowerFindingTool, {
      type: 'bug',
      title: 'Leaky cache',
      severity: 'high',
      summary: 'cache never evicts',
      details: 'repro steps',
      suggested_fix: 'add LRU',
    });

    expect(result.isError).toBeFalsy();
    expect(result.output).toMatch(/^finding filed: \.tower\/comms\/findings\//);
    expect(result.output).toContain('do not fix out-of-scope issues yourself');
  });

  it('refuses non-participants', async () => {
    await initViaTool();
    currentAgentId = 'agent-stranger';

    const result = await run(createTowerFindingTool, {
      type: 'idea',
      title: 'x',
      summary: 'x',
      details: 'x',
      suggested_fix: 'x',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('is not a tower participant');
  });
});

describe('TowerStatusTool', () => {
  it('keeps active independent from the initialized dashboard data', async () => {
    expect(await readStatus()).toEqual({ active: false, initialized: false, stateLost: false });
    host.active = true;
    expect(await readStatus()).toEqual({ active: true, initialized: false, stateLost: false });

    await run(createTowerInitTool, {});
    const activeStatus = await readStatus();
    expect(activeStatus).toMatchObject({ active: true, initialized: true });

    host.active = false;
    const inactiveStatus = await readStatus();
    expect(inactiveStatus).toEqual({ ...activeStatus, active: false });
    expect(inactiveStatus).toMatchObject({
      initialized: true,
      state: { base: 'main', mode: 'branch', missions: [], roster: { agents: [] } },
      caller: 'tower',
      gate: [],
      inbox: { count: 0 },
      concurrency: { budget: 2, inflight: 0, blockedUntil: null },
    });
  });

  it('renders the dashboard including the rate-limiter concurrency section', async () => {
    await initViaTool();

    const result = await run(createTowerStatusTool, {});

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('# Tower status — base: main (mode: branch), you are: tower');
    expect(result.output).toContain('(no missions planned — use TowerPlan)');
    expect(result.output).toContain('budget: 2 agent(s) · inflight: 0 · spawns open');
    expect(result.output).toContain(' tower init');
  });

  it('renders a non-finite budget as unlimited and a spawn pause', async () => {
    await initViaTool();
    host.runtime.snapshotValue = { budget: Number.POSITIVE_INFINITY, inflight: 0, blockedUntil: null };

    const dashboard = await run(createTowerStatusTool, {});
    const summary = await readStatusSummary();
    expect(dashboard.output).toContain('budget: unlimited agent(s) · inflight: 0 · spawns open');
    expect(summary).toContain('Concurrency: budget: unlimited agent(s) · inflight: 0 · spawns open');

    host.runtime.snapshotValue = { budget: 3, inflight: 1, blockedUntil: Date.now() + 30_000 };
    const paused = await run(createTowerStatusTool, {});
    expect(paused.output).toContain('budget: 3 agent(s) · inflight: 1 · spawns PAUSED for ~');
  });

  it('keeps the Markdown dashboard available to tower workers even with the mode off', async () => {
    await initViaTool();
    await new TowerStore(repo).registerAgent({ name: 'w1', kind: 'worker', agentId: 'agent-w1', spawnedAt: new Date().toISOString() });
    host.active = false;
    currentAgentId = 'agent-w1';

    const result = await run(createTowerStatusTool, {});

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('# Tower status — base: main (mode: branch), you are: w1');
  });

  async function deadOwner(status: string, reason: string, agentId = 'agent-w1') {
    await initViaTool();
    await run(createTowerPlanTool, { missions: [{ title: 'engine', scope: ['src/engine/**'] }] });
    const store = new TowerStore(repo);
    await store.registerAgent({ name: 'w1', kind: 'worker', agentId, missionId: 'M1', model: 'fake/worker-model', spawnedAt: new Date().toISOString() });
    await store.updateMission('tower', 'M1', { status: 'active', owner: 'w1' }, { silent: true });
    await store.markAgentDied(agentId, status, reason);
  }

  it('marks dead roster agents and points a revive at TowerResume', async () => {
    const agentId = await runningAgent('w1');
    host.runtime.finish(agentId, 'failed', { stopReason: 'provider blew up' });
    await deadOwner('failed', 'provider blew up', agentId);

    const result = await run(createTowerStatusTool, {});

    expect(result.output).toContain(`w1 (worker) — agent ${agentId}, mission M1`);
    expect(result.output).toContain('model fake/worker-model');
    expect(result.output).toContain('💀 failed');
    expect(result.output).toContain('## Dead workers');
    expect(result.output).toContain('M1 owner w1 died (failed)');
    expect(result.output).toContain('lost contact, timeout, OOM');
    expect(result.output).toMatch(/died \(failed\) — diagnose first[\s\S]*TowerResume\(agent="w1", prompt="\.\.\."\)/);
    expect(result.output).toContain('systematic cause');
    expect(result.output).not.toContain('Agent(resume=');
  });

  it('tells the tower a dead worker from a restarted tower cannot be resumed', async () => {
    await deadOwner('failed', 'provider blew up', 'agent-gone');

    const result = await run(createTowerStatusTool, {});

    expect(result.output).toContain('M1 owner w1 died (failed)');
    expect(result.output).toContain('the tower restarted');
    expect(result.output).not.toContain('Resume with TowerResume');
  });

  it('shows a user-stopped roster agent without the recovery hint', async () => {
    await deadOwner('stopped', HUMAN_STOP_REASON);

    const result = await run(createTowerStatusTool, {});

    expect(result.output).toContain('💀 stopped');
    expect(result.output).toContain('M1 owner w1 was stopped by the user (stopped)');
    expect(result.output).toContain('dead by intent');
    expect(result.output).not.toContain('diagnose first');
    expect(result.output).not.toContain('TowerResume');
  });

  it('flags planned missions without a spawned worker in an Awaiting spawn section', async () => {
    await initViaTool();
    await run(createTowerPlanTool, {
      missions: [
        { title: 'Build engine', scope: ['src/engine/**'] },
        { title: 'Build UI', scope: ['src/ui/**'] },
      ],
    });
    const store = new TowerStore(repo);
    await store.updateMission('tower', 'M2', { status: 'active', owner: 'w-ui' }, { silent: true });

    const result = await run(createTowerStatusTool, {});

    expect(result.output).toContain('## Awaiting spawn');
    expect(result.output).toContain('M1 (feat/build-engine) — planned but no worker spawned yet');
    expect(result.output).toContain('TowerSpawn(kind="worker", mission_id="M1"');
    expect(result.output).not.toContain('M2 (feat/build-ui) — planned but no worker spawned yet');
  });

  it('uses the merge evaluator for clean-rebase waivers and marks worker runtime unknown off-main', async () => {
    await initViaTool();
    await run(createTowerPlanTool, { missions: [{ title: 'Build engine', scope: ['src/engine/**'] }] });
    const store = new TowerStore(repo);
    const state = await store.load();
    const mission = state.missions[0]!;
    await store.addWorktree(mission.worktree, mission.branch, state.base);
    await commitFile(join(repo, '.tower/worktrees', mission.worktree), 'src/engine/engine.ts', 'export const engine = 1;\n', 'engine work');
    await store.updateMission('tower', mission.id, { status: 'completed' }, { silent: true });
    const agentId = await runningAgent('w1');
    host.runtime.finish(agentId);
    await store.registerAgent({ name: 'w1', kind: 'worker', agentId, missionId: mission.id, worktree: mission.worktree, branch: mission.branch, spawnedAt: new Date().toISOString() });
    await store.registerAgent({ name: 'r1', kind: 'reviewer', agentId: 'agent-r1', reviewTarget: mission.branch, reviewMissionId: mission.id, spawnedAt: new Date().toISOString() });
    await store.submitReview('r1', { target: mission.branch, status: 'clean', merge: 'merge', findings: 'none', decision: 'ok' });
    await commitFile(repo, 'docs/readme.md', 'docs\n', 'base moves on');
    await store.rebaseMission('tower', mission.id, { activeAgentIds: new Set() });

    const mainStatus = await run(createTowerStatusTool, {});
    expect(mainStatus.output).toContain('READY reasons=none');
    expect(mainStatus.output).toContain('binding=clean-rebase-waived');

    await host.runtime.resume(agentId, 'keep going');
    const busyStatus = await run(createTowerStatusTool, {});
    expect(busyStatus.output).toContain('BLOCKED reasons=worker-busy');

    currentAgentId = agentId;
    const workerStatus = await run(createTowerStatusTool, {});
    expect(workerStatus.output).toContain('BLOCKED reasons=worker-unknown');
    expect(workerStatus.output).toContain('unknown is not idle');
  });

  it('computes independent mission gates with bounded parallelism and stable mission order', async () => {
    await initViaTool();
    await run(createTowerPlanTool, {
      missions: Array.from({ length: 6 }, (_, index) => ({ title: `Mission ${String(index)}`, scope: [`src/m${String(index)}/**`] })),
    });
    let active = 0;
    let maximum = 0;
    const gate = vi.spyOn(TowerStore.prototype, 'missionGate').mockImplementation(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await delay(5);
      active -= 1;
      return { ready: false, noop: false, blocks: [{ reason: 'not-completed', message: 'blocked' }], observations: {} } as never;
    });
    try {
      const status = await readStatus();
      if (!status.initialized) throw new Error('expected initialized status');
      expect(status.gate.map((mission) => mission.missionId)).toEqual(['M1', 'M2', 'M3', 'M4', 'M5', 'M6']);
      expect(maximum).toBe(TOWER_GIT_CONCURRENCY);
    } finally {
      gate.mockRestore();
    }
  });
});

describe('readTowerStatusSummary', () => {
  it('renders the uninitialized states as one- and two-line text', async () => {
    expect(await readStatusSummary()).toBe('Tower mode: OFF');
    host.active = true;
    expect(await readStatusSummary()).toBe('Tower mode: ON\nTower is not initialized.');
  });

  it('renders the initialized dashboard as compact text with a state headline', async () => {
    await initViaTool();
    await run(createTowerPlanTool, { missions: [{ title: 'Build engine', scope: ['src/engine/**'] }] });
    const store = new TowerStore(repo);
    await store.registerAgent({ name: 'w1', kind: 'worker', agentId: 'agent-w1', missionId: 'M1', branch: 'feat/build-engine', worktree: 'build-engine', spawnedAt: new Date().toISOString() });
    await store.updateMission('tower', 'M1', { status: 'active', owner: 'w1' }, { silent: true });

    const summary = await readStatusSummary();

    const [headline, ...bodyLines] = summary.split('\n');
    expect(headline).toBe('Tower status — ON');
    const body = bodyLines.join('\n');
    expect(body).toContain('Base: main (mode: branch) · You are: tower');
    expect(body).toContain('Missions:\n  M1 Build engine — active · owner w1 · feat/build-engine');
    expect(body).toContain('Roster:\n  w1 (worker) — mission M1 · agent-w1');
    expect(body).toContain('Review gate:\n  M1 feat/build-engine — BLOCKED: not-completed');
    expect(body).toContain('Inbox: 0 message(s)');
    expect(body).toContain('Concurrency: budget: 2 agent(s) · inflight: 0 · spawns open');
    expect(body).toContain('Recent activity:');
    expect(body).toContain(' tower init');

    host.active = false;
    const inactive = await readStatusSummary();
    const [inactiveHeadline, ...inactiveBody] = inactive.split('\n');
    expect(inactiveHeadline).toBe('Tower mode: OFF');
    expect(inactiveBody.join('\n')).toBe(body);
  });
});

describe('TowerCompleteTool', () => {
  async function setupCompletable(kind: 'build' | 'survey' = 'build') {
    await initViaTool();
    const store = new TowerStore(repo);
    const [mission] = await store.plan([{ title: kind === 'survey' ? 'Survey engine' : 'Build engine', scope: ['src/engine/**'], kind }]);
    const state = await store.load();
    await store.addWorktree(mission!.worktree, mission!.branch, state.base);
    if (kind === 'build') {
      await commitFile(join(repo, '.tower/worktrees', mission!.worktree), 'src/engine/engine.ts', 'export const engine = 1;\n', 'engine work');
    }
    await store.registerAgent({ name: 'w1', kind: 'worker', agentId: 'agent-w1', missionId: mission!.id, worktree: mission!.worktree, branch: mission!.branch, spawnedAt: '2026-01-01T00:00:00.000Z' });
    await store.updateMission('tower', mission!.id, { status: 'active', owner: 'w1' }, { silent: true });
    currentAgentId = 'agent-w1';
    return { store, mission: mission! };
  }

  it('completes a build mission, stores one review-request and wakes the tower', async () => {
    const { store } = await setupCompletable();

    const result = await run(createTowerCompleteTool, { report: 'implemented the engine' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('mission M1 persisted as completed');
    expect(result.output).toContain('review-request notification:');
    expect(result.output).toContain('notification: stored once');
    expect((await store.load()).missions[0]?.status).toBe('completed');
    const notification = (await store.readInbox('tower', 20)).find((item) => item.subject === 'review-request');
    expect(notification).toMatchObject({ from: 'w1', to: 'tower', body: 'implemented the engine', scope: 'M1', action: 'complete' });
    expect(host.published).toEqual([expect.objectContaining({ from: 'w1', to: 'tower', subject: 'review-request', missionId: 'M1' })]);
  });

  it('completes a zero-diff survey with survey-summary', async () => {
    const { store } = await setupCompletable('survey');

    const result = await run(createTowerCompleteTool, { report: 'survey findings' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('survey-summary notification:');
    expect((await store.readInbox('tower', 20)).find((item) => item.subject === 'survey-summary')).toMatchObject({ body: 'survey findings', scope: 'M1', action: 'complete' });
  });

  it('rejects an empty report before touching the store', async () => {
    await setupCompletable();

    const result = await run(createTowerCompleteTool, { report: '   ' });

    expect(result).toEqual({ output: 'report must not be empty', isError: true });
  });

  it('rejects the tower and reviewers without writing a completion notification', async () => {
    const { store } = await setupCompletable();
    currentAgentId = MAIN_AGENT_ID;
    const towerResult = await run(createTowerCompleteTool, { report: 'not mine' });
    expect(towerResult.isError).toBe(true);
    expect(towerResult.output).toContain('only the worker');

    await store.registerAgent({ name: 'r1', kind: 'reviewer', agentId: 'agent-r1', reviewTarget: 'feat/build-engine', reviewMissionId: 'M1', spawnedAt: new Date().toISOString() });
    currentAgentId = 'agent-r1';
    const reviewerResult = await run(createTowerCompleteTool, { report: 'not mine either' });
    expect(reviewerResult.isError).toBe(true);
    expect((await store.readInbox('tower', 20)).some((item) => item.action === 'complete')).toBe(false);
  });

  it('fails unread completion checks and blockers before writing a notification', async () => {
    const { store } = await setupCompletable();
    await store.send('tower', { to: 'w1', subject: 'requirement change', body: 'read me' });

    const unread = await run(createTowerCompleteTool, { report: 'premature completion' });
    expect(unread.isError).toBe(true);
    expect(unread.output).toContain('unread inbox message');

    await store.ackInbox('w1', (await store.readUnreadInbox('w1', 20)).map((item) => item.messageId));
    await store.updateMission('tower', 'M1', { blocker: 'still blocked' });
    const blocked = await run(createTowerCompleteTool, { report: 'blocked completion' });
    expect(blocked.isError).toBe(true);
    expect(blocked.output).toContain('blocker(s) remain');
    expect((await store.readInbox('tower', 20)).some((item) => item.action === 'complete')).toBe(false);
  });

  it('rejects a non-zero survey branch during completion without a summary', async () => {
    const { store, mission } = await setupCompletable('survey');
    await commitFile(join(repo, '.tower/worktrees', mission.worktree), 'src/engine/notes.ts', 'not allowed\n', 'survey edit');

    const result = await run(createTowerCompleteTool, { report: 'survey with edits' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('read-only survey');
    expect((await store.readInbox('tower', 20)).some((item) => item.action === 'complete')).toBe(false);
  });

  it('reports persisted completion on notification failure and reuses the message on retry', async () => {
    const { store } = await setupCompletable();
    const failure = vi
      .spyOn(TowerStore.prototype, 'appendLog')
      .mockImplementationOnce(async () => {})
      .mockRejectedValueOnce(new Error('forced notification write failure'));
    try {
      const first = await run(createTowerCompleteTool, { report: 'retry report' });
      expect(first.isError).toBe(true);
      expect(first.output).toContain('mission M1 persisted as completed');
      expect(first.output).toContain('activity log error');
      failure.mockRestore();

      const second = await run(createTowerCompleteTool, { report: 'retry report' });
      expect(second.isError).toBeFalsy();
      expect(second.output).toContain('reused the stored message');
      expect((await store.readInbox('tower', 20)).filter((item) => item.action === 'complete')).toHaveLength(1);
    } finally {
      failure.mockRestore();
    }
  });

  it('redelivers the wake for a reused completion message after an initial publish failure', async () => {
    const { store } = await setupCompletable();
    host.publishFailure = new Error('forced publish failure');

    await expect(run(createTowerCompleteTool, { report: 'completed after publish failure' })).rejects.toThrow('forced publish failure');
    expect((await store.load()).missions[0]?.status).toBe('completed');

    const retry = await run(createTowerCompleteTool, { report: 'completed after publish failure' });

    expect(retry.isError).toBeFalsy();
    expect(retry.output).toContain('reused the stored message');
    expect(host.published).toEqual([expect.objectContaining({ from: 'w1', to: 'tower', subject: 'review-request' })]);
  });
});

describe('TowerReviewTool', () => {
  async function setupReviewableBranch(
    options: { readonly withOwner?: boolean; readonly ownerAgentId?: string } = {},
  ) {
    await initViaTool();
    await run(createTowerPlanTool, { missions: [{ title: 'Build engine', scope: ['src/engine/**'] }] });
    await git(repo, 'branch', 'feat/build-engine');
    const store = new TowerStore(repo);
    if (options.withOwner !== false) {
      await store.registerAgent({ name: 'w1', kind: 'worker', agentId: options.ownerAgentId ?? 'agent-w1', missionId: 'M1', spawnedAt: new Date().toISOString() });
      await store.updateMission('tower', 'M1', { status: 'active', owner: 'w1' }, { silent: true });
    }
    await store.registerAgent({ name: 'r1', kind: 'reviewer', agentId: 'agent-r1', reviewTarget: 'feat/build-engine', reviewMissionId: 'M1', spawnedAt: new Date().toISOString() });
    currentAgentId = 'agent-r1';
    return store;
  }

  it('routes a non-clean verdict at the owning worker, steering it when running', async () => {
    const ownerId = await runningAgent('w1');
    const store = await setupReviewableBranch({ ownerAgentId: ownerId });

    const result = await run(createTowerReviewTool, { target: 'feat/build-engine', status: 'p1-2items', merge: 'hold', findings: 'broken error handling', decision: 'needs rework' });

    expect(result.isError).toBeFalsy();
    const review = await store.latestReview('feat/build-engine');
    expect(result.output).toContain(`review submitted: ${review!.file}`);
    expect(result.output).toContain('notified: w1, tower');
    expect(result.output).toContain('the author must fix and re-review');
    expect(result.output).toContain('w1 is mid-turn');
    expect(host.runtime.steers).toHaveLength(1);
    expect(host.runtime.steers[0]?.text).toContain('review-result');
    expect(host.published).toEqual([expect.objectContaining({ from: 'r1', to: 'tower', subject: 'review-result' })]);
  });

  it('reports a clean verdict as merge-ready for TowerMerge', async () => {
    await setupReviewableBranch();

    const result = await run(createTowerReviewTool, { target: 'feat/build-engine', status: 'clean', merge: 'merge', findings: 'none', decision: 'looks good' });

    expect(result.output).toContain('next: feat/build-engine is merge-ready');
    expect(result.output).toContain('notified: tower');
  });

  it('does not call clean hold or fix-then-merge reviews merge-ready', async () => {
    await setupReviewableBranch();

    const hold = await run(createTowerReviewTool, { target: 'feat/build-engine', status: 'clean', merge: 'hold', findings: 'none', decision: 'wait' });
    expect(hold.output).not.toContain('merge-ready');
    expect(hold.output).toContain('blocked by the latest review\'s "hold" verdict');

    const fix = await run(createTowerReviewTool, { target: 'feat/build-engine', status: 'clean', merge: 'fix-then-merge', findings: 'none', decision: 'after fixes' });
    expect(fix.output).not.toContain('merge-ready');
    expect(fix.output).toContain('"fix-then-merge" is not approval');
  });

  it('routes a non-clean verdict through the tower when no worker owns the branch', async () => {
    await setupReviewableBranch({ withOwner: false });

    const result = await run(createTowerReviewTool, { target: 'feat/build-engine', status: 'p2-1items', merge: 'fix-then-merge', findings: 'minor cleanup', decision: 'rework needed' });

    expect(result.output).toContain('notified: tower');
    expect(result.output).toContain('the author must fix and re-review');
  });
});

describe('TowerMergeTool', () => {
  async function setupMergeableBranch() {
    await initViaTool();
    await run(createTowerPlanTool, { missions: [{ title: 'Build engine', scope: ['src/engine/**'] }] });
    await git(repo, 'checkout', '-b', 'feat/build-engine');
    await commitFile(repo, 'src/engine/engine.ts', 'export const engine = 1;\n', 'engine work');
    await git(repo, 'checkout', 'main');
    const store = new TowerStore(repo);
    await store.updateMission('tower', 'M1', { status: 'completed' }, { silent: true });
    await store.submitReview('tower', { target: 'feat/build-engine', status: 'clean', merge: 'merge', findings: 'none', decision: 'ok' });
    return store;
  }

  it('points at TowerTeardown when the merge closes the last open mission', async () => {
    await setupMergeableBranch();

    const result = await run(createTowerMergeTool, { branch: 'feat/build-engine' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('merged feat/build-engine');
    expect(result.output).toContain('ready for TowerTeardown');
  });

  it('works with tower mode off and points at the remaining missions', async () => {
    await setupMergeableBranch();
    await run(createTowerPlanTool, { missions: [{ title: 'Build UI', scope: ['src/ui/**'] }] });
    host.active = false;

    const result = await run(createTowerMergeTool, { branch: 'feat/build-engine' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('Continue with the remaining missions in Dependency Flow order');
  });

  it('refuses while the branch is leased', async () => {
    await setupMergeableBranch();
    let release!: () => void;
    const held = host.withBranchLease('feat/build-engine', () => new Promise<void>((resolve) => { release = resolve; }));

    const result = await run(createTowerMergeTool, { branch: 'feat/build-engine' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('is leased by another tower merge/rebase');
    release();
    await held;
  });

  it('points at TowerTeardown when a survey noop-merge closes the last mission', async () => {
    await initViaTool();
    await run(createTowerPlanTool, { missions: [{ title: 'Survey engine', scope: ['src/engine/**'], kind: 'survey' }] });
    await git(repo, 'branch', 'feat/survey-engine');
    await new TowerStore(repo).updateMission('tower', 'M1', { status: 'completed' }, { silent: true });

    const result = await run(createTowerMergeTool, { branch: 'feat/survey-engine' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('read-only survey');
    expect(result.output).toContain('ready for TowerTeardown');
  });
});

describe('TowerRebaseTool', () => {
  async function setupRebasableMission() {
    await initViaTool();
    const store = new TowerStore(repo);
    const [mission] = await store.plan([{ title: 'Build engine', scope: ['src/engine/**'] }]);
    const state = await store.load();
    await store.addWorktree(mission!.worktree, mission!.branch, state.base);
    await commitFile(join(repo, '.tower/worktrees', mission!.worktree), 'src/engine/engine.ts', 'export const engine = 1;\n', 'engine work');
    return { store, mission: mission! };
  }

  it('rebases a stale branch and preserves review binding without changing merge approval', async () => {
    const { mission } = await setupRebasableMission();
    await commitFile(repo, 'docs/readme.md', 'docs\n', 'base moves on');

    const result = await run(createTowerRebaseTool, { mission: mission.id });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain(`rebased mission ${mission.id}`);
    expect(result.output).toContain('keeps its exact-tip binding');
  });

  it('reports up-to-date branches without touching them', async () => {
    const { mission } = await setupRebasableMission();

    const result = await run(createTowerRebaseTool, { mission: mission.id });

    expect(result.output).toContain('already up to date');
  });

  it('refuses while the worker is mid-turn', async () => {
    const { store, mission } = await setupRebasableMission();
    const agentId = await runningAgent('w1');
    await store.registerAgent({ name: 'w1', kind: 'worker', agentId, missionId: mission.id, spawnedAt: new Date().toISOString() });
    await commitFile(repo, 'docs/readme.md', 'docs\n', 'base moves on');

    const result = await run(createTowerRebaseTool, { mission: mission.id });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('mid-turn');
  });

  it('reports a conflicting rebase, marks the mission blocked and points at TowerResume', async () => {
    const { store, mission } = await setupRebasableMission();
    await commitFile(repo, 'src/engine/engine.ts', 'export const engine = 2;\n', 'base conflicts');

    const result = await run(createTowerRebaseTool, { mission: mission.id });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('conflicted and was aborted');
    expect(result.output).toContain('src/engine/engine.ts');
    expect(result.output).toContain('TowerResume');
    expect((await store.load()).missions[0]?.status).toBe('blocked');
  });

  it('reports unknown missions with the known ids', async () => {
    await setupRebasableMission();

    const result = await run(createTowerRebaseTool, { mission: 'M9' });

    expect(result).toEqual({ isError: true, output: 'unknown mission "M9" — known: M1' });
  });
});

describe('tower state loss degradation', () => {
  async function destroyComms(): Promise<void> {
    await rm(join(repo, '.tower/comms'), { recursive: true, force: true });
  }

  it('TowerStatus returns a state-lost report, and keeps not-initialized for a fresh repo', async () => {
    host.active = true;
    const fresh = await run(createTowerStatusTool, {});
    expect(fresh.isError).toBe(true);
    expect(fresh.output).toContain('tower is not initialized in this repository');

    await initViaTool();
    await destroyComms();

    expect(await readStatus()).toEqual({ active: true, initialized: false, stateLost: true });
    const result = await run(createTowerStatusTool, {});
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('# Tower status — STATE LOST');
    expect(await readStatusSummary()).toContain('Tower state was lost');
  });

  it('TowerSend recovers a minimal state and a lost worker becomes a placeholder', async () => {
    await initViaTool();
    await new TowerStore(repo).registerAgent({ name: 'w1', kind: 'worker', agentId: 'agent-w1', spawnedAt: '2026-09-20T00:00:00.000Z' });
    await destroyComms();

    currentAgentId = 'agent-w1';
    const result = await run(createTowerSendTool, { to: 'tower', subject: 'accident report', body: 'comms was deleted' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('placeholder "agent-w1"');
    const state = await new TowerStore(repo).load();
    expect(state.recoveredAt).toBeTruthy();

    const status = await run(createTowerStatusTool, {});
    expect(status.output).toContain('## ⚠️ State recovered after a loss');
    expect(await readStatusSummary()).toContain('⚠️ State recovered at');
  });

  it('TowerComplete degrades explicitly and merge/rebase fail with a state-lost error', async () => {
    await initViaTool();
    const store = new TowerStore(repo);
    await store.plan([{ title: 'Build engine', scope: ['src/engine/**'] }]);
    await store.registerAgent({ name: 'w1', kind: 'worker', agentId: 'agent-w1', missionId: 'M1', spawnedAt: new Date().toISOString() });
    await destroyComms();

    const merge = await run(createTowerMergeTool, { branch: 'feat/x' });
    expect(merge.isError).toBe(true);
    expect(merge.output).toContain('tower state was lost');
    const rebase = await run(createTowerRebaseTool, { mission: 'M1' });
    expect(rebase.output).toContain('tower state was lost');

    currentAgentId = 'agent-w1';
    const result = await run(createTowerCompleteTool, { report: 'done: implemented engine' });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('no mission was marked completed');
    expect(result.output).toContain('completion-report-state-lost');
  });
});

describe('orchestration tools for non-main callers', () => {
  it('rejects every orchestration tool at execution time before any work', async () => {
    currentAgentId = 'agent-w1';
    host.active = true;
    const results = await Promise.all([
      run(createTowerInitTool, {}),
      run(createTowerPlanTool, { missions: [{ title: 'x', scope: ['x/**'] }] }),
      run(createTowerMergeTool, { branch: 'tower/x' }),
      run(createTowerRebaseTool, { mission: 'M1' }),
      run(createTowerTeardownTool, {}),
    ]);
    for (const result of results) {
      expect(result).toEqual({ isError: true, output: TOWER_MAIN_AGENT_ONLY });
    }
    expect(await stat(join(repo, '.tower')).catch(() => undefined)).toBeUndefined();
  });
});
