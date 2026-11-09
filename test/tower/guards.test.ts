import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionAPI, ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { VALIDATOR_WRITE_VETO, writeGuardVeto } from '../../src/guards/index.ts';
import { TowerStore, WORKTREES_DIR } from '../../src/protocol/index.ts';
import {
  TOWER_AGENT_GUARDS_EXTENSION,
  towerAgentGuards,
  towerBashGuard,
  towerWriteGuard,
  type TowerAgentGuardTarget,
} from '../../src/tower/guards.ts';
import { createRepo, git, removeDir } from './fakes.ts';

let repo: string;
let store: TowerStore;
let worktree: string;

beforeEach(async () => {
  repo = await createRepo('tower-guards-');
  store = new TowerStore(repo);
  worktree = store.abs(join(WORKTREES_DIR, 'wt-1'));
  await git(repo, 'worktree', 'add', '-q', '-b', 'feat/wt-1', worktree);
});

afterEach(async () => {
  await removeDir(repo);
});

function bash(command: string): ToolCallEvent {
  return { type: 'tool_call', toolCallId: 'call_bash', toolName: 'bash', input: { command } } as ToolCallEvent;
}

function write(path: string): ToolCallEvent {
  return { type: 'tool_call', toolCallId: 'call_write', toolName: 'write', input: { path, content: 'x' } } as ToolCallEvent;
}

function edit(path: string): ToolCallEvent {
  return {
    type: 'tool_call',
    toolCallId: 'call_edit',
    toolName: 'edit',
    input: { path, edits: [{ oldText: 'a', newText: 'b' }] },
  } as ToolCallEvent;
}

function worker(overrides: Partial<TowerAgentGuardTarget> = {}): TowerAgentGuardTarget {
  return { agentId: 'agent-w1', kind: 'worker', cwd: worktree, repoRoot: () => repo, ...overrides };
}

async function registerWorker(agentId: string, slot: string): Promise<void> {
  await store.registerAgent({
    name: `name-${agentId}`,
    agentId,
    kind: 'worker',
    missionId: 'M1',
    worktree: slot,
    spawnedAt: new Date().toISOString(),
  });
}

describe('towerBashGuard', () => {
  it('leaves bash alone until the workspace is owned', async () => {
    expect(await towerBashGuard(bash('rm -rf .tower/comms'), repo)).toBeUndefined();

    await store.init('session-guard');

    expect(await towerBashGuard(bash('rm -rf .tower/comms'), repo)).toMatchObject({ block: true });
  });

  it('vetoes commands that would destroy the tower state from the main checkout and from a worktree', async () => {
    await store.init('session-guard');

    const clean = await towerBashGuard(bash('git clean -fdx'), repo);
    expect(clean?.reason).toMatch(/^`git clean` with force and -x\/-X is not allowed/);
    const reset = await towerBashGuard(bash('git reset --hard'), repo);
    expect(reset?.reason).toMatch(/^`git reset --hard` is not allowed in the tower main checkout/);
    const rm = await towerBashGuard(bash('rm -rf .tower'), repo);
    expect(rm?.reason).toContain('is not allowed on tower protocol paths');

    expect(await towerBashGuard(bash('git clean -fdx'), worktree)).toBeUndefined();
    expect(await towerBashGuard(bash(`git -C ${repo} reset --hard`), worktree)).toMatchObject({ block: true });
    expect(await towerBashGuard(bash(`rm -rf ${join(repo, '.tower', 'comms')}`), worktree)).toMatchObject({
      block: true,
    });
  });

  it('ignores other tools and harmless commands', async () => {
    await store.init('session-guard');

    expect(await towerBashGuard(bash('ls -la .tower && git status'), repo)).toBeUndefined();
    expect(await towerBashGuard(write(join(repo, '.tower', 'comms', 'state.json')), repo)).toBeUndefined();
  });
});

describe('towerWriteGuard', () => {
  beforeEach(async () => {
    await store.init('session-guard');
    await registerWorker('agent-w1', 'wt-1');
  });

  it('lets a worker write and edit inside its own worktree', async () => {
    expect(await towerWriteGuard(write('src/a.ts'), worktree, worker())).toBeUndefined();
    expect(await towerWriteGuard(edit(join(worktree, 'deep', 'b.ts')), worktree, worker())).toBeUndefined();
  });

  it('vetoes writes and edits that escape the worktree with the guard text', async () => {
    expect(await towerWriteGuard(write('../../../README.md'), worktree, worker())).toEqual({
      block: true,
      reason: writeGuardVeto(worktree, [join(repo, 'README.md')]),
    });
    expect(await towerWriteGuard(edit(join(repo, 'src', 'main.ts')), worktree, worker())).toMatchObject({
      block: true,
    });
    expect(await towerWriteGuard(write('/tmp/elsewhere.txt'), worktree, worker())).toMatchObject({ block: true });
  });

  it('reads the worktree from the roster, falls back to the spawn cwd before registration, and skips reviewers', async () => {
    await registerWorker('agent-w2', 'wt-2');
    const wt2 = store.abs(join(WORKTREES_DIR, 'wt-2'));
    expect(await towerWriteGuard(write(join(worktree, 'a.ts')), worktree, worker({ agentId: 'agent-w2' }))).toEqual({
      block: true,
      reason: writeGuardVeto(wt2, [join(worktree, 'a.ts')]),
    });

    const unregistered = worker({ agentId: 'agent-new' });
    expect(await towerWriteGuard(write('src/a.ts'), worktree, unregistered)).toBeUndefined();
    expect(await towerWriteGuard(write('../../../README.md'), worktree, unregistered)).toMatchObject({ block: true });

    expect(
      await towerWriteGuard(write('../../../README.md'), repo, worker({ kind: 'reviewer', cwd: repo })),
    ).toBeUndefined();
  });

  it('keeps validators read-only even inside their own validation worktree', async () => {
    const validationWorktree = store.abs(join(WORKTREES_DIR, 'val-ms1-scrutiny-r1'));
    const validator = worker({ agentId: 'agent-v1', kind: 'validator', cwd: validationWorktree });

    expect(await towerWriteGuard(write('src/a.ts'), validationWorktree, validator)).toEqual({
      block: true,
      reason: VALIDATOR_WRITE_VETO,
    });
    expect(await towerWriteGuard(edit(join(validationWorktree, 'b.ts')), validationWorktree, validator)).toEqual({
      block: true,
      reason: VALIDATOR_WRITE_VETO,
    });
    expect(await towerWriteGuard(bash('npm test'), validationWorktree, validator)).toBeUndefined();
  });
});

describe('towerAgentGuards', () => {
  it('is a hidden inline extension whose tool_call handler applies both guards', async () => {
    await store.init('session-guard');
    await registerWorker('agent-w1', 'wt-1');
    const extension = towerAgentGuards(worker());
    if (typeof extension === 'function') throw new Error('expected a named inline extension');
    expect(extension).toMatchObject({ name: TOWER_AGENT_GUARDS_EXTENSION, hidden: true });
    const handlers = new Map<string, (event: ToolCallEvent, ctx: { readonly cwd: string }) => unknown>();
    await extension.factory({
      on: (event: string, handler: (event: ToolCallEvent, ctx: { readonly cwd: string }) => unknown) => {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI);
    const onToolCall = handlers.get('tool_call');
    if (onToolCall === undefined) throw new Error('no tool_call handler');

    expect(await onToolCall(bash(`rm -rf ${join(repo, '.tower', 'comms')}`), { cwd: worktree })).toMatchObject({
      block: true,
    });
    expect(await onToolCall(write('../../../README.md'), { cwd: worktree })).toMatchObject({ block: true });
    expect(await onToolCall(write('notes.md'), { cwd: worktree })).toBeUndefined();
    expect([...handlers.keys()]).toEqual(['tool_call']);
  });
});

describe('guard roots an agent cannot rewrite', () => {
  const ESCAPES = ['rm -rf ../../comms', 'cd ../../.. && git clean -fdx', 'git -C ../../.. reset --hard'];

  type ToolCallHandler = (event: ToolCallEvent, ctx: { readonly cwd: string }) => Promise<unknown>;

  async function toolCallHandler(target: TowerAgentGuardTarget): Promise<ToolCallHandler> {
    const extension = towerAgentGuards(target);
    if (typeof extension === 'function') throw new Error('expected a named inline extension');
    let onToolCall: ToolCallHandler | undefined;
    await extension.factory({
      on: (event: string, handler: ToolCallHandler) => {
        if (event === 'tool_call') onToolCall = handler;
      },
    } as unknown as ExtensionAPI);
    if (onToolCall === undefined) throw new Error('no tool_call handler');
    return onToolCall;
  }

  it.each(['intact', 'deleted', 'replaced by git init'] as const)(
    'keeps vetoing escapes to the main checkout when the worktree .git link is %s',
    async (link) => {
      await store.init('session-guard');
      await registerWorker('agent-w1', 'wt-1');
      const bound = await toolCallHandler(worker());
      const unbound = await toolCallHandler(
        worker({
          repoRoot: () => {
            throw new Error('the tower is not bound to a pi session yet');
          },
        }),
      );
      if (link !== 'intact') await rm(join(worktree, '.git'));
      if (link === 'replaced by git init') await git(worktree, 'init', '-q');

      for (const command of ESCAPES) {
        expect(await bound(bash(command), { cwd: worktree }), command).toMatchObject({ block: true });
        expect(await unbound(bash(command), { cwd: worktree }), command).toMatchObject({ block: true });
        expect(await towerBashGuard(bash(command), worktree), command).toMatchObject({ block: true });
      }
      expect(await bound(write('../../../README.md'), { cwd: worktree })).toMatchObject({ block: true });
    },
  );

  it('guards a session in a repository nested under a worktree for the outer workspace too, without blocking work inside it', async () => {
    await store.init('session-guard');
    const nested = join(worktree, 'tmp', 'repo');
    await mkdir(nested, { recursive: true });
    await git(nested, 'init', '-q');

    expect(await towerBashGuard(bash('rm -rf ../../../../comms'), nested)).toMatchObject({ block: true });
    expect(await towerBashGuard(bash(`git -C ${repo} reset --hard`), nested)).toMatchObject({ block: true });
    expect(await towerBashGuard(bash('rm -rf build && git clean -fdx && git reset --hard'), nested)).toBeUndefined();
  });
});
