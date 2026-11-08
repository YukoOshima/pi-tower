import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENTS_DIR,
  MAIN_AGENT_ID,
  STATE_FILE,
  TOWER_NAME,
  TowerStore,
  fallbackIdentityArgs,
  isOpenMission,
  mergeNoFf,
  parseFrontmatter,
  scopeMatches,
} from '../../src/protocol/index.ts';
import type { TowerRosterEntry, TowerState } from '../../src/protocol/index.ts';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function commitFile(
  cwd: string,
  rel: string,
  content: string,
  message: string,
): Promise<void> {
  const abs = join(cwd, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
  await git(cwd, 'add', rel);
  await git(cwd, 'commit', '-m', message);
}

let repo: string;
let store: TowerStore;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'pi-tower-store-test-'));
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.email', 'tower-test@example.com');
  await git(repo, 'config', 'user.name', 'Tower Test');
  await commitFile(repo, 'README.md', '# fixture\n', 'initial');
  store = new TowerStore(repo);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(repo, { recursive: true, force: true });
});

function rosterEntry(
  partial: Partial<TowerRosterEntry> & Pick<TowerRosterEntry, 'name' | 'kind'>,
): TowerRosterEntry {
  return {
    agentId: `agent-${partial.name}`,
    spawnedAt: new Date(Date.now() - 60_000).toISOString(),
    ...partial,
  };
}

describe('pi protocol surface', () => {
  it('exposes the pi constants and helpers next to the upstream surface', async () => {
    expect(MAIN_AGENT_ID).toBe('main');
    expect(AGENTS_DIR).toBe('.tower/agents');
    expect(isOpenMission({ status: 'completed' })).toBe(true);
    expect(isOpenMission({ status: 'merged' })).toBe(false);
    expect(isOpenMission({ status: 'abandoned' })).toBe(false);
    expect(scopeMatches('src/protocol/store.ts', 'src/protocol/**')).toBe(true);
    expect(scopeMatches('src/config/models.ts', 'src/protocol/**')).toBe(false);

    await store.init();
    expect(store.resolveCallerName(await store.load(), MAIN_AGENT_ID)).toBe(TOWER_NAME);
  });
});

describe('owner process tracking', () => {
  it('reports no owner before the tower is initialized', async () => {
    expect(await store.owner()).toBeUndefined();
  });

  it('does not stamp an owner process for a session-less init', async () => {
    await store.init();
    expect(await store.owner()).toEqual({ sessionId: undefined, pid: undefined });
  });

  it('records the owner process on init, re-stamps it on adopt, and clears it on release', async () => {
    await store.init('session-a');
    expect((await store.load()).ownerPid).toBe(process.pid);
    expect(await store.owner()).toEqual({ sessionId: 'session-a', pid: process.pid });

    const file = store.abs(STATE_FILE);
    const state = JSON.parse(await readFile(file, 'utf8')) as TowerState;
    state.ownerPid = process.pid + 1;
    await writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
    expect(await store.adopt('session-a')).toEqual([]);
    expect(await store.owner()).toEqual({ sessionId: 'session-a', pid: process.pid });

    await store.adopt('session-b');
    expect(await store.owner()).toEqual({ sessionId: 'session-b', pid: process.pid });

    await store.release('session-a');
    expect(await store.owner()).toEqual({ sessionId: 'session-b', pid: process.pid });
    await store.release('session-b');
    expect(await store.owner()).toEqual({ sessionId: undefined, pid: undefined });
    expect((await store.load()).ownerPid).toBeUndefined();
  });
});

describe('roster runtime fields', () => {
  it('patches model and agent session file on the latest roster entry for an agent id', async () => {
    await store.init('session-a');
    await store.registerAgent(
      rosterEntry({
        name: 'w1',
        kind: 'worker',
        agentId: 'agent-1',
        model: 'p/worker',
        cwd: '/wt-1',
      }),
    );

    await store.updateAgentRuntime('agent-1', { agentSessionFile: '/sessions/w1.jsonl' });
    await store.updateAgentRuntime('agent-1', { model: 'p/worker-2' });
    await store.updateAgentRuntime('agent-unknown', { model: 'p/ignored' });

    const agents = (await store.load()).roster.agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      name: 'w1',
      model: 'p/worker-2',
      cwd: '/wt-1',
      agentSessionFile: '/sessions/w1.jsonl',
    });
  });
});

describe('inbox extensions', () => {
  it('counts unread messages without acknowledging them', async () => {
    await store.init('session-a');
    await store.registerAgent(rosterEntry({ name: 'w1', kind: 'worker' }));
    await store.send(TOWER_NAME, { to: 'w1', subject: 'one', body: 'first' });
    await store.send(TOWER_NAME, { to: 'all', subject: 'two', body: 'second' });

    expect(await store.countUnreadInbox('w1')).toBe(2);
    expect(await store.countUnreadInbox('w1')).toBe(2);
    const [latest] = await store.readUnreadInbox('w1', 1);
    expect(await store.ackInbox('w1', [latest!.messageId])).toBe(1);
    expect(await store.countUnreadInbox('w1')).toBe(1);
  });

  it('collapses multi-line headers into one frontmatter line instead of rejecting the message', async () => {
    await store.init('session-a');
    await store.registerAgent(rosterEntry({ name: 'w1', kind: 'worker' }));

    const sent = await store.sendDetailed(TOWER_NAME, {
      to: 'w1',
      subject: 'line one\nline two',
      body: 'body\nkeeps its lines',
      scope: 'M1\n',
      action: 'note\r\nthis',
      consentRef: '  ref\tone  ',
    });

    expect(sent.item.subject).toBe('line one line two');
    const { fields, body } = parseFrontmatter(await readFile(store.abs(sent.item.file), 'utf8'));
    expect(fields).toMatchObject({
      subject: 'line one line two',
      scope: 'M1',
      action: 'note this',
      consent_ref: 'ref one',
    });
    expect(body).toBe('body\nkeeps its lines');
    const [listed] = await store.readUnreadInbox('w1', 5);
    expect(listed).toMatchObject({
      subject: 'line one line two',
      scope: 'M1',
      action: 'note this',
    });
  });
});

describe('activity log', () => {
  it('keeps every entry on one line when detail values carry whitespace runs', async () => {
    await store.init();
    await store.appendLog(
      TOWER_NAME,
      'probe',
      { reason: 'first line\nsecond line\tend' },
      'ref/x.md',
    );

    const [last] = await store.recentLog(1);
    expect(last).toMatch(/ tower probe reason=first line second line end ref=ref\/x\.md$/);
  });
});

describe('git exclude', () => {
  it('writes the .tower/ exclude into the common git dir when the tower runs inside a linked worktree', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'pi-tower-linked-'));
    const linked = join(parent, 'linked');
    await git(repo, 'worktree', 'add', linked, '-b', 'linked-checkout');
    try {
      await new TowerStore(linked).init();

      const exclude = await readFile(join(repo, '.git/info/exclude'), 'utf8');
      expect(exclude.split('\n').map((line) => line.trim())).toContain('.tower/');
      expect(await git(linked, 'status', '--porcelain')).toBe('');
    } finally {
      await git(repo, 'worktree', 'remove', '--force', linked).catch(() => {});
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe('fallback git identity', () => {
  it('uses the configured identity when git has one', async () => {
    expect(await fallbackIdentityArgs(repo)).toEqual([]);
  });

  it('commits, snapshots base WIP, and merges as Pi Tower when git has no identity', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pi-tower-noident-'));
    const globalConfig = join(home, 'gitconfig');
    await writeFile(globalConfig, '[user]\n\tuseConfigOnly = true\n');
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    for (const name of [
      'EMAIL',
      'GIT_AUTHOR_NAME',
      'GIT_AUTHOR_EMAIL',
      'GIT_COMMITTER_NAME',
      'GIT_COMMITTER_EMAIL',
    ]) {
      vi.stubEnv(name, undefined);
    }
    const piTower = 'Pi Tower <pi-tower@localhost>';
    try {
      const dir = join(home, 'project');
      await mkdir(dir);
      await writeFile(join(dir, 'app.ts'), 'export {}\n');

      const fresh = new TowerStore(dir);
      await fresh.init('session-a');
      expect(await fallbackIdentityArgs(dir)).toEqual([
        '-c',
        'user.name=Pi Tower',
        '-c',
        'user.email=pi-tower@localhost',
      ]);
      expect(await git(dir, 'log', '-1', '--format=%an <%ae>|%cn <%ce>')).toBe(
        `${piTower}|${piTower}`,
      );

      const [mission] = await fresh.plan([{ title: 'feature x', scope: ['src/x/**'] }]);
      await writeFile(join(dir, 'wip.txt'), 'wip\n');
      const { spawnBase } = await fresh.addWorktree(
        mission!.worktree,
        mission!.branch,
        (await fresh.load()).base,
      );
      expect(spawnBase).toBeDefined();
      expect(await git(dir, 'log', '-1', '--format=%an <%ae>', spawnBase!)).toBe(piTower);

      const worktree = fresh.abs(join('.tower/worktrees', mission!.worktree));
      await mkdir(join(worktree, 'src/x'), { recursive: true });
      await writeFile(join(worktree, 'src/x/x.ts'), 'x\n');
      await git(worktree, 'add', 'src/x/x.ts');
      await git(
        worktree,
        '-c',
        'user.name=Worker',
        '-c',
        'user.email=worker@example.com',
        'commit',
        '-m',
        'x',
      );
      await rm(join(dir, 'wip.txt'));

      const mergeCommit = await mergeNoFf(
        dir,
        mission!.branch,
        `Merge branch '${mission!.branch}'`,
      );
      expect(await git(dir, 'log', '-1', '--format=%an <%ae>', mergeCommit)).toBe(piTower);
      expect((await stat(join(dir, 'src/x/x.ts'))).isFile()).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('state lock holder liveness', () => {
  type LockDriver = {
    reapStaleStateLock(lockPath: string): Promise<boolean>;
    stateLockHolderIsDead(pid: number): Promise<boolean>;
  };

  it('treats only a vanished holder as dead — a live holder that cannot be signalled keeps its lock', async () => {
    await store.init();
    const driver = store as unknown as LockDriver;
    expect(await driver.stateLockHolderIsDead(999999)).toBe(true);
    expect(await driver.stateLockHolderIsDead(process.pid)).toBe(false);
    expect(await driver.stateLockHolderIsDead(1)).toBe(false);

    const lockPath = `${store.abs(STATE_FILE)}.lock`;
    await writeFile(lockPath, 'pid=1 since=2026-09-26T00:00:00.000Z token=foreign');
    try {
      expect(await driver.reapStaleStateLock(lockPath)).toBe(false);
      expect(await readFile(lockPath, 'utf8')).toContain('token=foreign');
    } finally {
      await rm(lockPath, { force: true });
    }
  });
});
