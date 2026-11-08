import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  TOWER_MAIN_AGENT_ONLY,
  resumeHumanStoppedRefusal,
  resumeLeasedRefusal,
  resumeRetiredRefusal,
  resumeReviewerRefusal,
  resumeRunningRefusal,
} from '../../src/prompts/index.ts';
import { MAIN_AGENT_ID, TowerStore } from '../../src/protocol/index.ts';
import { createTowerResumeTool, resumeRestartedRefusal } from '../../src/tools/resume/resumeTool.ts';
import { createTowerTaskOutputTool } from '../../src/tools/taskOutput/taskOutputTool.ts';
import { createTowerTasksTool } from '../../src/tools/tasks/tasksTool.ts';
import { createTowerTaskStopTool, towerTaskStopReason } from '../../src/tools/taskStop/taskStopTool.ts';
import { HUMAN_STOP_REASON } from '../../src/tower/constants.ts';
import { TestHost, createRepo, removeDir } from '../tower/fakes.ts';

let repo: string;
let store: TowerStore;
let host: TestHost;

beforeEach(async () => {
  repo = await createRepo('tower-agent-tools-');
  store = new TowerStore(repo);
  await store.init('session-test');
  await store.plan([{ title: 'Build gemm', scope: ['src/**'] }]);
  host = new TestHost(repo);
});

afterEach(async () => {
  await removeDir(repo);
});

async function spawnRegistered(
  name: string,
  kind: 'worker' | 'reviewer' = 'worker',
  options: { readonly sessionId?: string } = {},
): Promise<string> {
  const launched = await host.runtime.spawn({ name, kind, cwd: repo, prompt: 'work', description: `M1 ${name}: Build gemm` });
  if (!launched.ok) throw new Error(launched.reason);
  await store.registerSpawnedAgent(
    {
      name,
      agentId: launched.agentId,
      sessionId: options.sessionId ?? 'session-test',
      kind,
      ...(kind === 'worker'
        ? { missionId: 'M1', branch: 'feat/build-gemm', worktree: 'wt-1' }
        : { reviewTarget: 'feat/build-gemm', reviewMissionId: 'M1' }),
      spawnedAt: new Date().toISOString(),
    },
    kind === 'worker' ? { id: 'M1', owner: name } : undefined,
  );
  return launched.agentId;
}

function resume(agent: string, prompt = 'Pick up where you left off.', agentId = MAIN_AGENT_ID) {
  return createTowerResumeTool(host, { agentId }).run({ agent, prompt }, { toolCallId: 'call_resume' });
}

describe('TowerResume', () => {
  it('rejects non-main callers', async () => {
    expect(await resume('agent-build', 'x', 'agent-w1')).toEqual({ isError: true, output: TOWER_MAIN_AGENT_ONLY });
  });

  it('resumes an idle worker by roster name in the background, even with tower mode off', async () => {
    const agentId = await spawnRegistered('agent-build');
    host.runtime.finish(agentId, 'idle', { summary: 'first pass done' });
    host.active = false;

    const result = await resume('agent-build', 'Address the review findings.');

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('name: agent-build');
    expect(result.output).toContain(`agent_id: ${agentId}`);
    expect(result.output).toContain('task_id: task-2');
    expect(result.output).toContain('status: running (resumed in the background');
    expect(result.output).toContain('model: fake/default-model · thinking: medium');
    expect(host.runtime.promptsOf(agentId).at(-1)).toBe('Address the review findings.');
  });

  it('resumes by agent id too', async () => {
    const agentId = await spawnRegistered('agent-build');
    host.runtime.finish(agentId, 'failed', { stopReason: 'lost contact' });

    const result = await resume(agentId);

    expect(result.isError).toBeFalsy();
    expect(host.runtime.get(agentId)?.status).toBe('running');
  });

  it('refuses a running agent and points at TowerSend', async () => {
    await spawnRegistered('agent-build');

    expect(await resume('agent-build')).toEqual({ output: resumeRunningRefusal('agent-build'), isError: true });
  });

  it('refuses while the branch is leased by a merge or rebase', async () => {
    const agentId = await spawnRegistered('agent-build');
    host.runtime.finish(agentId);
    let release!: () => void;
    const held = host.withBranchLease('feat/build-gemm', () => new Promise<void>((resolve) => { release = resolve; }));

    const result = await resume('agent-build');

    expect(result).toEqual({ output: resumeLeasedRefusal('agent-build', 'feat/build-gemm'), isError: true });
    expect(host.runtime.resumes).toEqual([]);
    release();
    await held;
  });

  it('refuses reviewers, which are one-shot', async () => {
    const agentId = await spawnRegistered('reviewer-a', 'reviewer');
    host.runtime.finish(agentId);

    expect(await resume('reviewer-a')).toEqual({ output: resumeReviewerRefusal('reviewer-a'), isError: true });
  });

  it('refuses an agent the human stopped, whether the stop came from the roster or the runtime', async () => {
    const agentId = await spawnRegistered('agent-build');
    await host.runtime.stop(agentId, HUMAN_STOP_REASON);

    expect(await resume('agent-build')).toEqual({ output: resumeHumanStoppedRefusal('agent-build'), isError: true });

    await store.markAgentDied(agentId, 'stopped', HUMAN_STOP_REASON);
    expect(await resume(agentId)).toEqual({ output: resumeHumanStoppedRefusal('agent-build'), isError: true });
  });

  it('refuses a human-stopped reviewer as dead by intent rather than suggesting a replacement', async () => {
    const agentId = await spawnRegistered('reviewer-a', 'reviewer');
    await host.runtime.stop(agentId, HUMAN_STOP_REASON);

    expect(await resume('reviewer-a')).toEqual({ output: resumeHumanStoppedRefusal('reviewer-a'), isError: true });
  });

  it('refuses entries retired by a previous session', async () => {
    const agentId = await spawnRegistered('agent-build', 'worker', { sessionId: 'session-old' });
    host.runtime.finish(agentId);
    host.noteRetiredAgents(['agent-gone']);

    expect(await resume('agent-build')).toEqual({ output: resumeRetiredRefusal('agent-build'), isError: true });
    expect(await resume('agent-gone')).toEqual({ output: resumeRetiredRefusal('agent-gone'), isError: true });
  });

  it('refuses a same-session roster agent whose run is not in this process (tower restart)', async () => {
    await store.registerAgent({ name: 'agent-build', agentId: 'agent-old', sessionId: 'session-test', kind: 'worker', missionId: 'M1', spawnedAt: new Date().toISOString() });

    const result = await resume('agent-build');

    expect(result).toEqual({ output: resumeRestartedRefusal('agent-build'), isError: true });
    expect(result.output).toContain('the tower restarted');
    expect(result.output).toContain('spawn a fresh worker for its mission under a new name');
  });

  it('lists the known agents for an unknown reference and rejects an empty prompt', async () => {
    await spawnRegistered('agent-build');

    const unknown = await resume('agent-x');
    expect(unknown.isError).toBe(true);
    expect(unknown.output).toBe('unknown tower agent "agent-x" — known agents: agent-build');

    const empty = await resume('agent-build', '   ');
    expect(empty).toEqual({ output: 'resume prompt must not be empty — no agent was started', isError: true });
  });

  it('surfaces a runtime refusal verbatim', async () => {
    const agentId = await spawnRegistered('agent-build');
    host.runtime.finish(agentId);
    host.runtime.resumeRefusal = 'tower agent "agent-build" is still processing a steered message — retry shortly';

    expect(await resume('agent-build')).toEqual({
      output: 'tower agent "agent-build" is still processing a steered message — retry shortly',
      isError: true,
    });
  });
});

describe('TowerTasks', () => {
  function tasks(activeOnly?: boolean) {
    return createTowerTasksTool(host, { agentId: MAIN_AGENT_ID }).run(
      activeOnly === undefined ? {} : { active_only: activeOnly },
      { toolCallId: 'call_tasks' },
    );
  }

  it('reports when no agent is running', async () => {
    expect((await tasks()).output).toBe(
      'no running tower agents in this session — pass active_only=false to include finished runs',
    );
  });

  it('lists running agents with ids, model, thinking level and assignment', async () => {
    const agentId = await spawnRegistered('agent-build');
    await spawnRegistered('reviewer-a', 'reviewer');

    const result = await tasks();

    expect(result.output).toContain('2 tower agent(s) running:');
    expect(result.output).toContain(`- agent-build (worker) — status: running, agent_id: ${agentId}, task_id: task-1, model: fake/default-model · thinking: medium, mission M1, runs: 1`);
    expect(result.output).toContain('- reviewer-a (reviewer) — status: running');
    expect(result.output).toContain('reviewing feat/build-gemm');
  });

  it('includes finished runs, human stops and timeouts with active_only=false', async () => {
    const done = await spawnRegistered('agent-done');
    const stopped = await spawnRegistered('agent-stopped');
    const timed = await spawnRegistered('agent-timed');
    host.runtime.finish(done);
    await host.runtime.stop(stopped, HUMAN_STOP_REASON);
    host.runtime.finish(timed, 'timed_out', { stopReason: 'timed out after 2h' });

    expect((await tasks()).output).toContain('no running tower agents');
    const all = await tasks(false);

    expect(all.output).toContain('3 tower agent(s) in this session:');
    expect(all.output).toContain('- agent-done (worker) — status: completed');
    expect(all.output).toContain('- agent-stopped (worker) — status: stopped by the human,');
    expect(all.output).toContain('- agent-timed (worker) — status: timed out (timed out after 2h)');
  });
});

describe('TowerTaskOutput', () => {
  function output(agent: string) {
    return createTowerTaskOutputTool(host, { agentId: MAIN_AGENT_ID }).run({ agent }, { toolCallId: 'call_output' });
  }

  it('renders status, model, tool calls and the final message by name or task id', async () => {
    const agentId = await spawnRegistered('agent-build');
    host.runtime.addToolCall(agentId, { toolCallId: 'c1', name: 'bash', args: '{"command":"npm test"}', startedAt: 1, endedAt: 2, isError: false });
    host.runtime.finish(agentId, 'idle', { summary: 'All tests pass.' });

    const byName = await output('agent-build');
    const byTask = await output('task-1');

    expect(byName.isError).toBeFalsy();
    expect(byName.output).toContain('name: agent-build');
    expect(byName.output).toContain('status: completed');
    expect(byName.output).toContain('model: fake/default-model · thinking: medium');
    expect(byName.output).toContain('- bash {"command":"npm test"} — ok');
    expect(byName.output).toContain('final message:\nAll tests pass.');
    expect(byTask.output).toBe(byName.output.replace(/wall time: .*/, byTask.output.match(/wall time: .*/)?.[0] ?? ''));
  });

  it('explains when a roster agent has no run in this process and lists known agents otherwise', async () => {
    await store.registerAgent({ name: 'agent-old', agentId: 'agent-old', sessionId: 'session-test', kind: 'worker', spawnedAt: new Date().toISOString() });

    const missing = await output('agent-old');
    expect(missing.isError).toBe(true);
    expect(missing.output).toContain('has no run in this process');

    const unknown = await output('agent-x');
    expect(unknown.output).toContain('unknown tower agent "agent-x" — known agents: agent-old');
  });
});

describe('TowerTaskStop', () => {
  function stop(agent: string, reason?: string) {
    return createTowerTaskStopTool(host, { agentId: MAIN_AGENT_ID }).run(
      reason === undefined ? { agent } : { agent, reason },
      { toolCallId: 'call_stop' },
    );
  }

  it('stops a running agent with an explicit tower reason, never the human marker', async () => {
    const agentId = await spawnRegistered('agent-build');

    const result = await stop('agent-build', 'user');

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('stopped tower agent "agent-build"');
    expect(result.output).toContain('TowerResume(agent="agent-build", prompt="...")');
    expect(host.runtime.stops).toEqual([{ id: agentId, reason: 'stopped by the tower: user' }]);
    expect(host.runtime.get(agentId)?.stopReason).not.toBe(HUMAN_STOP_REASON);
  });

  it('records a default tower reason and tells reviewers apart', async () => {
    const reviewerId = await spawnRegistered('reviewer-a', 'reviewer');

    const result = await stop(reviewerId);

    expect(host.runtime.stops).toEqual([{ id: reviewerId, reason: towerTaskStopReason(undefined) }]);
    expect(towerTaskStopReason(undefined)).toBe('stopped by the tower');
    expect(result.output).toContain('A reviewer is one-shot');
  });

  it('returns the current status for a finished agent and refuses unknown agents', async () => {
    const agentId = await spawnRegistered('agent-build');
    host.runtime.finish(agentId);

    const finished = await stop('agent-build');
    expect(finished.isError).toBeFalsy();
    expect(finished.output).toContain('is not running — its last run ended with status: completed; nothing was stopped');

    const unknown = await stop('agent-x');
    expect(unknown.isError).toBe(true);
    expect(unknown.output).toContain('unknown tower agent "agent-x"');
  });
});
