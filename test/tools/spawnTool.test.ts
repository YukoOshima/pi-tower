import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TOWER_MAIN_AGENT_ONLY, TOWER_MODE_USER_ENABLED_ONLY } from '../../src/prompts/index.ts';
import {
  MAIN_AGENT_ID,
  STATE_FILE,
  TowerProtocolError,
  TowerStore,
  type TowerState,
} from '../../src/protocol/index.ts';
import type { TowerSpawnToolInput } from '../../src/tools/spawn/spawn.ts';
import { createTowerSpawnTool } from '../../src/tools/spawn/spawnTool.ts';
import { TestHost, createRepo, git, removeDir } from '../tower/fakes.ts';

let repo: string;
let store: TowerStore;
let host: TestHost;

beforeEach(async () => {
  repo = await createRepo('tower-spawn-test-');
  store = new TowerStore(repo);
  await store.init('session-spawn-test');
  await store.plan([{ title: 'Build gemm', scope: ['src/**'] }]);
  host = new TestHost(repo);
  host.sessionId = 'session-spawn-test';
});

afterEach(async () => {
  await removeDir(repo);
});

const WORKER_ARGS: TowerSpawnToolInput = { name: 'agent-build', kind: 'worker', mission_id: 'M1' };

function execute(args: TowerSpawnToolInput, agentId = MAIN_AGENT_ID, modelLines?: string) {
  return createTowerSpawnTool(host, { agentId }, modelLines).run(args, { toolCallId: 'call_spawn' });
}

function lastPrompt(): string {
  return host.launches.at(-1)?.prompt ?? '';
}

async function expectNoWorkerSpawnSideEffects(): Promise<void> {
  expect(host.launches).toEqual([]);
  const state = await store.load();
  expect(state.roster.agents).toEqual([]);
  const mission = state.missions.find((candidate) => candidate.id === 'M1');
  expect(mission?.status).toBe('planned');
  expect(mission?.owner).toBeUndefined();
  await expect(git(repo, 'rev-parse', '--verify', 'refs/heads/feat/build-gemm')).rejects.toThrow();
}

describe('TowerSpawnTool', () => {
  it('suffixes the description with the configured model lines', () => {
    const plain = createTowerSpawnTool(host, { agentId: MAIN_AGENT_ID });
    const withModels = createTowerSpawnTool(
      host,
      { agentId: MAIN_AGENT_ID },
      'Available models (pass via model):\n- worker [worker default]: fake/cheap',
    );

    expect(plain.description).not.toContain('Available models');
    expect(withModels.description).toContain('Available models (pass via model):');
    expect(withModels.description.startsWith(plain.description)).toBe(true);
  });

  it('refuses when tower mode is not active', async () => {
    host.active = false;

    const result = await execute(WORKER_ARGS);

    expect(result).toEqual({ output: TOWER_MODE_USER_ENABLED_ONLY, isError: true });
    await expectNoWorkerSpawnSideEffects();
  });

  it('requires mission_id for workers and review_target for reviewers before any work', async () => {
    expect(await execute({ name: 'agent-build', kind: 'worker' })).toEqual({
      output: 'worker spawns require mission_id',
      isError: true,
    });
    expect(await execute({ name: 'reviewer-a', kind: 'reviewer', review_target: '  ' })).toEqual({
      output: 'reviewer spawns require review_target',
      isError: true,
    });
    await expectNoWorkerSpawnSideEffects();
  });

  it('respects a branch lease before worktree or agent side effects', async () => {
    let release!: () => void;
    const held = host.withBranchLease('feat/build-gemm', () => new Promise<void>((resolve) => { release = resolve; }));

    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBe(true);
    expect(result.output).toContain('is leased by another tower merge/rebase');
    await expectNoWorkerSpawnSideEffects();
    release();
    await held;
  });

  it.each(['merged', 'abandoned'] as const)(
    'refuses a %s mission before any worktree, agent, or roster side effect',
    async (status) => {
      const state = await store.load();
      state.missions.find((mission) => mission.id === 'M1')!.status = status;
      await writeFile(store.abs(STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);

      const result = await execute(WORKER_ARGS);

      expect(result.isError).toBe(true);
      expect(result.output).toContain(`mission M1 is ${status}`);
      expect(result.output).toContain('terminal missions cannot spawn workers');
      expect(host.launches).toEqual([]);
      await expect(git(repo, 'rev-parse', '--verify', 'refs/heads/feat/build-gemm')).rejects.toThrow();
    },
  );

  it('rejects unknown missions with the known ids', async () => {
    const result = await execute({ name: 'agent-x', kind: 'worker', mission_id: 'M9' });

    expect(result).toEqual({ output: 'unknown mission "M9" — known missions: M1', isError: true });
  });

  it('records the death of a worker whose run ended before roster registration finished', async () => {
    host.runtime.finishOnSpawn = { status: 'failed', stopReason: 'provider blew up' };

    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBeFalsy();
    const entry = (await store.load()).roster.agents.find((agent) => agent.name === 'agent-build');
    expect(entry?.deathStatus).toBe('failed');
    expect(entry?.deathReason).toBe('provider blew up');
  });

  it('does not treat a run that finished idle before registration as a death', async () => {
    host.runtime.finishOnSpawn = { status: 'idle' };

    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBeFalsy();
    expect((await store.load()).roster.agents[0]?.diedAt).toBeUndefined();
  });

  it('rejects non-main callers with the main-agent-only error before any work', async () => {
    const result = await execute(WORKER_ARGS, 'agent-w1');

    expect(result).toEqual({ output: TOWER_MAIN_AGENT_ONLY, isError: true });
    await expectNoWorkerSpawnSideEffects();
  });

  it('surfaces the rate-limit reason as an error result and leaves the mission unclaimed', async () => {
    host.runtime.gate = { ok: false, reason: 'provider rate limit hit — new tower spawns paused for ~60s.' };

    const result = await execute(WORKER_ARGS);

    expect(result).toEqual({ output: 'provider rate limit hit — new tower spawns paused for ~60s.', isError: true });
    const mission = (await store.load()).missions.find((m) => m.id === 'M1');
    expect(mission?.status).toBe('planned');
    expect(mission?.owner).toBeUndefined();
  });

  it('leaves the mission untouched when the launch fails', async () => {
    host.runtime.failSpawn = 'provider unavailable';

    const result = await execute(WORKER_ARGS);

    expect(result).toEqual({ output: 'tower spawn failed: provider unavailable', isError: true });
    const state = await store.load();
    expect(state.missions[0]?.status).toBe('planned');
    expect(state.missions[0]?.owner).toBeUndefined();
    expect(state.roster.agents).toHaveLength(0);
  });

  it('aborts the launched run without a partial roster or mission claim when spawn persistence fails', async () => {
    const forced = vi
      .spyOn(TowerStore.prototype, 'registerSpawnedAgent')
      .mockRejectedValueOnce(new TowerProtocolError('forced post-launch failure'));
    try {
      const result = await execute(WORKER_ARGS);

      expect(result.isError).toBe(true);
      expect(result.output).toContain('forced post-launch failure');
      expect(host.aborted).toEqual(['agent-1']);
      expect(host.registered).toEqual([]);
      expect(host.runtime.get('agent-1')).toBeUndefined();
      const state = await store.load();
      expect(state.roster.agents).toEqual([]);
      expect(state.missions[0]?.status).toBe('planned');
      expect(state.missions[0]?.owner).toBeUndefined();
    } finally {
      forced.mockRestore();
    }
  });

  it('spawns a detached worker in its worktree, registers the roster entry with the model, and logs it', async () => {
    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBeUndefined();
    const worktreeAbs = join(repo, '.tower/worktrees/wt-1');
    expect(result.output).toContain('agent_id: agent-1');
    expect(result.output).toContain('task_id: task-1');
    expect(result.output).toContain('status: running');
    expect(result.output).toContain('model: fake/default-model (thinking medium)');
    expect(result.output).toContain(`worktree: ${worktreeAbs}`);
    expect(result.output).toContain('diagnose first: check why it died');
    expect(result.output).toContain('lost contact, timeout, OOM');
    expect(result.output).toContain('TowerResume(agent="agent-build", prompt="...")');
    expect(result.output).not.toContain('Agent(resume=');

    expect(host.launches[0]).toMatchObject({
      name: 'agent-build',
      kind: 'worker',
      description: 'M1 agent-build: Build gemm',
      cwd: worktreeAbs,
    });
    expect(host.launches[0]?.prompt).toContain(worktreeAbs);
    expect(host.registered).toEqual(['agent-1']);

    const state = await store.load();
    expect(state.roster.agents.find((agent) => agent.name === 'agent-build')).toMatchObject({
      agentId: 'agent-1',
      sessionId: 'session-spawn-test',
      kind: 'worker',
      missionId: 'M1',
      worktree: 'wt-1',
      branch: 'feat/build-gemm',
      model: 'fake/default-model',
      cwd: worktreeAbs,
    });
    const mission = state.missions.find((m) => m.id === 'M1');
    expect(mission?.status).toBe('active');
    expect(mission?.owner).toBe('agent-build');
    const log = await readFile(join(repo, '.tower/comms/log/activity.log'), 'utf8');
    expect(log).toMatch(/ tower spawn name=agent-build kind=worker agent=agent-1 mission=M1 model=fake\/default-model thinking=medium /);
  });

  it('binds the resolved spawn model and reports it in the output and the activity log', async () => {
    host.spawnModel = { ok: true, binding: { choice: 'worker', model: 'cheap/fast', thinkingLevel: 'low' } };

    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBeUndefined();
    expect(host.launches[0]?.binding).toEqual({ choice: 'worker', model: 'cheap/fast', thinkingLevel: 'low' });
    expect(result.output).toContain('model: cheap/fast (thinking low)');
    expect((await store.load()).roster.agents[0]?.model).toBe('cheap/fast');
    const log = await readFile(join(repo, '.tower/comms/log/activity.log'), 'utf8');
    expect(log).toContain('model=cheap/fast thinking=low');
  });

  it('refuses the spawn before any side effect when the model cannot be resolved', async () => {
    host.spawnModel = { ok: false, error: 'Invalid model "smart" — available models: orchestrator, primary, worker, reviewer' };

    const result = await execute({ ...WORKER_ARGS, model: 'smart' });

    expect(result).toEqual({
      output: 'Invalid model "smart" — available models: orchestrator, primary, worker, reviewer',
      isError: true,
    });
    await expectNoWorkerSpawnSideEffects();
  });

  it('registers a reviewer in the main checkout without a worktree', async () => {
    const result = await execute({ name: 'reviewer-a', kind: 'reviewer', review_target: 'feat/build-gemm' });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('review_target: feat/build-gemm');
    expect(result.output).toContain('A reviewer is one-shot');
    expect(host.launches[0]).toMatchObject({ kind: 'reviewer', cwd: repo, description: 'M1 review: feat/build-gemm' });
    const entry = (await store.load()).roster.agents.find((agent) => agent.name === 'reviewer-a');
    expect(entry).toMatchObject({ agentId: 'agent-1', kind: 'reviewer', reviewTarget: 'feat/build-gemm', reviewMissionId: 'M1' });
    expect(entry?.worktree).toBeUndefined();
  });

  it('describes the reviewer task with the reviewer name when the branch owns no mission', async () => {
    const result = await execute({ name: 'reviewer-b', kind: 'reviewer', review_target: 'feat/orphan-branch' });

    expect(result.isError).toBeUndefined();
    expect(host.launches[0]?.description).toBe('review reviewer-b: feat/orphan-branch');
  });

  it('refuses a duplicate worker name and points at TowerResume', async () => {
    const launched = await host.runtime.spawn({ name: 'agent-build', cwd: repo, prompt: 'x' });
    if (!launched.ok) throw new Error('spawn failed');
    await store.registerAgent({ name: 'agent-build', agentId: launched.agentId, sessionId: 'session-spawn-test', kind: 'worker', missionId: 'M1', spawnedAt: new Date().toISOString() });

    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBe(true);
    expect(result.output).toContain('already registered');
    expect(result.output).toContain('TowerResume(agent="agent-build", prompt="...")');
    expect(host.launches).toEqual([]);
  });

  it('refuses a duplicate whose run is not in this process and asks for a new name', async () => {
    await store.registerAgent({ name: 'agent-build', agentId: 'agent-old', sessionId: 'session-spawn-test', kind: 'worker', missionId: 'M1', spawnedAt: new Date().toISOString() });

    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBe(true);
    expect(result.output).toContain('not running in this process');
    expect(result.output).toContain('the tower restarted');
    expect(result.output).toContain('pick a new name');
    expect(result.output).not.toContain('TowerResume');
  });

  it('does not recommend resuming a duplicate reviewer', async () => {
    const launched = await host.runtime.spawn({ name: 'reviewer-a', cwd: repo, prompt: 'x' });
    if (!launched.ok) throw new Error('spawn failed');
    await store.registerAgent({ name: 'reviewer-a', agentId: launched.agentId, sessionId: 'session-spawn-test', kind: 'reviewer', reviewTarget: 'feat/build-gemm', spawnedAt: new Date().toISOString() });

    const result = await execute({ name: 'reviewer-a', kind: 'reviewer', review_target: 'feat/build-gemm' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('a reviewer is one-shot');
    expect(result.output).toContain('spawn a fresh reviewer with a new name');
    expect(result.output).not.toContain('TowerResume');
  });

  it('refuses reserved and whitespace-padded names before any side effects', async () => {
    const reserved = await execute({ ...WORKER_ARGS, name: 'tower' });
    expect(reserved.isError).toBe(true);
    expect(reserved.output).toContain('reserved');

    const padded = await execute({ ...WORKER_ARGS, name: ' agent-build ' });
    expect(padded.isError).toBe(true);
    expect(padded.output).toContain('whitespace');
    await expectNoWorkerSpawnSideEffects();
  });

  it('aborts the spawn when the mission branch appeared in git after planning', async () => {
    await git(repo, 'branch', 'feat/build-gemm');

    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBe(true);
    expect(result.output).toContain('not owned by any tower mission');
    expect(result.output).not.toContain('worktree setup warning');
    expect(host.launches).toEqual([]);
    expect((await store.load()).missions[0]?.owner).toBeUndefined();
  });

  it('snapshots base WIP into the worker branch and records the spawn base', async () => {
    await writeFile(join(repo, 'wip.ts'), 'export const wip = 1;\n');

    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('base snapshot:');
    expect(await readFile(join(repo, '.tower/worktrees/wt-1', 'wip.ts'), 'utf8')).toBe('export const wip = 1;\n');
    expect(lastPrompt()).toContain('snapshot commit');
    expect((await store.load()).missions[0]?.spawnBase).toBeDefined();
  });

  it('bases the reviewer prompt on the base branch once a rebase drops the snapshot', async () => {
    await writeFile(join(repo, 'wip.ts'), 'export const wip = 1;\n');
    expect((await execute(WORKER_ARGS)).isError).toBeUndefined();
    const snapshot = (await store.load()).missions[0]?.spawnBase;
    const worktreeAbs = join(repo, '.tower/worktrees/wt-1');
    await git(repo, 'add', 'wip.ts');
    await git(repo, 'commit', '-m', 'commit my wip');
    await git(worktreeAbs, 'rebase', 'main');
    await expect(git(worktreeAbs, 'merge-base', '--is-ancestor', snapshot!, 'feat/build-gemm')).rejects.toThrow();

    const result = await execute({ name: 'reviewer-a', kind: 'reviewer', review_target: 'feat/build-gemm' });

    expect(result.isError).toBeUndefined();
    expect(lastPrompt()).toContain('against base "main"');
  });

  it('records no spawn base when the base checkout is clean', async () => {
    const result = await execute(WORKER_ARGS);

    expect(result.output).not.toContain('base snapshot:');
    expect((await store.load()).missions[0]?.spawnBase).toBeUndefined();
  });

  it('briefs the worker with its worktree as cwd, the mission context and the completion protocol', async () => {
    const [docs] = await store.plan([
      { title: 'Docs polish', scope: ['docs/**'], tasks: ['rewrite the intro'], context: 'Keep the tone friendly. Do not document internals.' },
    ]);

    const result = await execute({ name: 'agent-docs', kind: 'worker', mission_id: docs!.id, instructions: 'Use British spelling.' });

    expect(result.isError).toBeUndefined();
    const prompt = lastPrompt();
    expect(prompt).toContain("## Context — the user's own words, verbatim");
    expect(prompt).toContain('Keep the tone friendly. Do not document internals.');
    expect(prompt).toContain('Ambiguity is escalated, not guessed');
    expect(prompt).toContain('subject="clarify-request"');
    expect(prompt).toContain('Your working directory is this worktree');
    expect(prompt).toContain(`Re-read your mission too (TowerMission(id="${docs!.id}") with no patch fields)`);
    expect(prompt).toContain('Call TowerComplete(report=what you changed and why');
    expect(prompt).toContain('# Additional instructions from the tower\nUse British spelling.');
  });

  it('briefs the survey worker to read the inbox before completing', async () => {
    const [survey] = await store.plan([{ title: 'Scan apis', scope: ['src/**'], kind: 'survey' }]);

    const result = await execute({ name: 'agent-scan', kind: 'worker', mission_id: survey!.id });

    expect(result.isError).toBeUndefined();
    expect(lastPrompt()).toContain('# When the survey is done');
    expect(lastPrompt()).toContain('Call TowerComplete(report=the full survey result)');
  });

  it('briefs the reviewer with the mission text and the worker self-report', async () => {
    const [docs] = await store.plan([
      { title: 'Docs polish', scope: ['docs/**'], tasks: ['rewrite the intro'], context: 'Keep the tone friendly. Do not document internals.' },
    ]);
    expect((await execute({ name: 'agent-docs', kind: 'worker', mission_id: docs!.id })).isError).toBeUndefined();
    await store.send('agent-docs', { to: 'tower', subject: 'review-request', body: 'Rewrote the intro; tone kept friendly, internals left out.' });

    const result = await execute({ name: 'reviewer-a', kind: 'reviewer', review_target: docs!.branch });

    expect(result.isError).toBeUndefined();
    const prompt = lastPrompt();
    expect(prompt).toContain('# Mission under review');
    expect(prompt).toContain('# Mission M2: Docs polish');
    expect(prompt).toContain('- [ ] rewrite the intro');
    expect(prompt).toContain("# The author's own account");
    expect(prompt).toContain('Rewrote the intro; tone kept friendly, internals left out.');
    expect(prompt).toContain('1. Intent');
    expect(prompt).toContain(`Work read-only in the main checkout (${repo})`);
  });

  it('falls back to the generic checklist when the review target owns no mission', async () => {
    const result = await execute({ name: 'reviewer-a', kind: 'reviewer', review_target: 'feat/orphan-branch' });

    expect(result.isError).toBeUndefined();
    expect(lastPrompt()).not.toContain('# Mission under review');
    expect(lastPrompt()).toContain('1. Security\n2. Data integrity');
  });

  it('briefs the reviewer with the live mission when a closed mission shares the branch', async () => {
    const stale = (await store.load()).missions.find((m) => m.id === 'M1')!;
    await store.updateMission('tower', 'M1', { status: 'abandoned' });
    const file = store.abs(STATE_FILE);
    const state = JSON.parse(await readFile(file, 'utf8')) as TowerState;
    state.missions.push({
      ...stale,
      id: 'M2',
      title: 'Build gemm respin',
      slug: 'build-gemm-respin',
      worktree: 'wt-2',
      status: 'completed',
      owner: 'agent-build',
      tasks: [{ text: 'redo the kernel', done: false }],
      notes: [],
      blockers: [],
    });
    await writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
    await store.updateMission('tower', 'M2', { note: 'replanned after M1 was abandoned' });

    const result = await execute({ name: 'reviewer-a', kind: 'reviewer', review_target: stale.branch });

    expect(result.isError).toBeUndefined();
    expect(lastPrompt()).toContain('# Mission M2: Build gemm respin');
    expect(lastPrompt()).not.toContain('# Mission M1: Build gemm');
  });

  it('briefs a respawned worker with the latest review round and the predecessor review-request', async () => {
    expect((await execute(WORKER_ARGS)).isError).toBeUndefined();
    await store.send('agent-build', { to: 'tower', subject: 'review-request', body: 'Built the kernel; all tasks ticked.' });
    await store.registerAgent({ name: 'rev', kind: 'reviewer', agentId: 'agent-rev', reviewTarget: 'feat/build-gemm', reviewMissionId: 'M1', spawnedAt: new Date().toISOString() });
    await store.submitReview('rev', { target: 'feat/build-gemm', status: 'p1-2items', merge: 'fix-then-merge', findings: 'the kernel leaks memory', decision: 'fix the leak first' });

    const result = await execute({ name: 'agent-build-2', kind: 'worker', mission_id: 'M1' });

    expect(result.isError).toBeUndefined();
    const prompt = lastPrompt();
    expect(prompt).toContain('# Previous work on this branch');
    expect(prompt).toContain('Latest review — round 1 by rev: p1-2items, merge verdict "fix-then-merge"');
    expect(prompt).toContain('the kernel leaks memory');
    expect(prompt).toContain("The previous worker's review-request to the tower");
    expect(prompt).toContain('Built the kernel; all tasks ticked.');
  });

  it('omits the history section for a first-time worker spawn', async () => {
    expect((await execute(WORKER_ARGS)).isError).toBeUndefined();

    expect(lastPrompt()).not.toContain('# Previous work on this branch');
  });

  it('briefs the reviewer with the branch review history, capped to the latest rounds', async () => {
    expect((await execute(WORKER_ARGS)).isError).toBeUndefined();
    for (let round = 1; round <= 6; round += 1) {
      const name = `rev-${String(round)}`;
      await store.registerAgent({ name, kind: 'reviewer', agentId: `agent-${name}`, reviewTarget: 'feat/build-gemm', reviewMissionId: 'M1', spawnedAt: new Date().toISOString() });
      await store.submitReview(name, { target: 'feat/build-gemm', status: 'p2-1items', merge: 'fix-then-merge', findings: `finding ${String(round)}`, decision: 'small fix needed' });
    }

    const result = await execute({ name: 'reviewer-a', kind: 'reviewer', review_target: 'feat/build-gemm' });

    expect(result.isError).toBeUndefined();
    const prompt = lastPrompt();
    expect(prompt).toContain('# Review history on this branch');
    expect(prompt).toContain('(1 earlier round(s) omitted');
    expect(prompt).toContain('Round 1 by rev-6: p2-1items, merge verdict "fix-then-merge"');
    expect(prompt).toContain('finding 6');
    expect(prompt).not.toContain('finding 1\n');
  });

  it('omits the review history section for the first review round', async () => {
    expect((await execute(WORKER_ARGS)).isError).toBeUndefined();

    const result = await execute({ name: 'reviewer-a', kind: 'reviewer', review_target: 'feat/build-gemm' });

    expect(result.isError).toBeUndefined();
    expect(lastPrompt()).not.toContain('# Review history on this branch');
  });
});
