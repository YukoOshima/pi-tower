import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TowerAgentRuntime } from '../../src/runtime/agentRuntime.ts';
import { TOWER_SPAWN_PAUSE_MS, TowerRateLimiter } from '../../src/runtime/rateLimit.ts';
import type { TowerAgentEvent, TowerAgentSpec, TowerRunStartResult } from '../../src/runtime/types.ts';
import { deferred, FakeSessionFactory, nextEvent, sequentialIds } from './fakeSession.ts';

function spec(overrides: Partial<TowerAgentSpec> = {}): TowerAgentSpec {
  return {
    name: 'agent-alpha',
    kind: 'worker',
    description: 'M1 agent-alpha: build it',
    cwd: '/repo',
    prompt: 'You are "agent-alpha", a tower worker.',
    ...overrides,
  };
}

function started(result: TowerRunStartResult): { agentId: string; taskId: string } {
  if (!result.ok) throw new Error(`expected the run to start: ${result.reason}`);
  return { agentId: result.agentId, taskId: result.taskId };
}

describe('TowerAgentRuntime', () => {
  let now: number;
  let factory: FakeSessionFactory;
  let limiter: TowerRateLimiter;
  let runtime: TowerAgentRuntime;
  let events: TowerAgentEvent[];

  beforeEach(() => {
    now = 1_000;
    factory = new FakeSessionFactory();
    limiter = new TowerRateLimiter({ now: () => now });
    runtime = new TowerAgentRuntime({
      sessionFactory: factory.create,
      limiter,
      now: () => now,
      createId: sequentialIds(),
      stopGraceMs: 50,
    });
    events = [];
    runtime.onEvent((event) => {
      events.push(event);
    });
  });

  afterEach(async () => {
    await runtime.disposeAll();
  });

  describe('spawn', () => {
    it('returns agent and task ids while the initial prompt runs detached', async () => {
      const { agentId, taskId } = started(await runtime.spawn(spec()));

      expect(agentId).toBe('agent-1');
      expect(taskId).toBe('task-1');
      expect(factory.requests).toEqual([{ agentId, spec: spec() }]);
      expect(factory.session(agentId).prompts).toEqual(['You are "agent-alpha", a tower worker.']);
      expect(runtime.get(agentId)).toEqual({
        agentId,
        taskId,
        name: 'agent-alpha',
        kind: 'worker',
        description: 'M1 agent-alpha: build it',
        cwd: '/repo',
        model: 'fake/fake-model',
        thinkingLevel: 'low',
        sessionId: agentId,
        sessionFile: undefined,
        status: 'running',
        runs: 1,
        createdAt: 1_000,
        startedAt: 1_000,
        endedAt: undefined,
        lastAssistantText: undefined,
        stopReason: undefined,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
      });
      expect(events).toEqual([
        { type: 'started', agentId, taskId, name: 'agent-alpha', resumed: false, at: 1_000 },
      ]);
      expect(runtime.activeAgentIds()).toEqual(new Set([agentId]));
      expect(limiter.snapshot().inflight).toBe(1);
    });

    it('settles to idle with the final assistant text, usage and end time', async () => {
      const { agentId, taskId } = started(await runtime.spawn(spec()));
      const session = factory.session(agentId);
      const finished = nextEvent(runtime, 'finished');

      session.reply('Looking around.', { input: 10, output: 5, totalTokens: 15, cost: { total: 0.25 } });
      session.reply('Mission complete.', { input: 20, output: 7, cacheRead: 3, totalTokens: 30, cost: { total: 0.5 } });
      now = 4_000;
      session.settle();

      expect(await finished).toEqual({
        type: 'finished',
        agentId,
        taskId,
        name: 'agent-alpha',
        status: 'idle',
        summary: 'Mission complete.',
        stopReason: undefined,
        undeliveredSteers: [],
        usage: { input: 30, output: 12, cacheRead: 3, cacheWrite: 0, totalTokens: 45, cost: 0.75 },
        at: 4_000,
      });
      expect(runtime.get(agentId)).toMatchObject({
        status: 'idle',
        endedAt: 4_000,
        lastAssistantText: 'Mission complete.',
        usage: { totalTokens: 45, cost: 0.75 },
      });
      expect(runtime.activeAgentIds()).toEqual(new Set());
      expect(limiter.snapshot().inflight).toBe(0);
    });

    it('fails the run when the last provider response is an error', async () => {
      const { agentId } = started(await runtime.spawn(spec()));
      const session = factory.session(agentId);
      const finished = nextEvent(runtime, 'finished');

      session.reply('Partial progress.');
      session.fail('500 internal server error');
      session.settle();

      expect(await finished).toMatchObject({
        status: 'failed',
        summary: 'Partial progress.',
        stopReason: '500 internal server error',
      });
      expect(runtime.get(agentId)).toMatchObject({ status: 'failed', stopReason: '500 internal server error' });
    });

    it('treats an error that a later response recovered from as a completed run', async () => {
      const { agentId } = started(await runtime.spawn(spec()));
      const session = factory.session(agentId);
      const finished = nextEvent(runtime, 'finished');

      session.fail('503 service unavailable');
      session.reply('Recovered after retry.');
      session.settle();

      expect(await finished).toMatchObject({ status: 'idle', summary: 'Recovered after retry.' });
    });

    it('fails the run when the prompt itself rejects', async () => {
      const { agentId } = started(await runtime.spawn(spec()));
      const finished = nextEvent(runtime, 'finished');

      factory.session(agentId).crash(new Error('No API key found for anthropic.'));

      expect(await finished).toMatchObject({ status: 'failed', stopReason: 'No API key found for anthropic.' });
      expect(limiter.snapshot().inflight).toBe(0);
    });

    it('reports a session-side abort as stopped with reason aborted', async () => {
      const { agentId } = started(await runtime.spawn(spec()));
      const finished = nextEvent(runtime, 'finished');

      factory.session(agentId).settle(true);

      expect(await finished).toMatchObject({ status: 'stopped', stopReason: 'aborted' });
    });

    it('refuses invalid specs without creating a session or holding a slot', async () => {
      for (const invalid of [
        spec({ name: '  ' }),
        spec({ cwd: '' }),
        spec({ prompt: ' \n ' }),
        spec({ timeoutMs: 0 }),
        spec({ timeoutMs: Number.NaN }),
      ]) {
        const result = await runtime.spawn(invalid);
        expect(result.ok).toBe(false);
      }
      expect(factory.requests).toHaveLength(0);
      expect(limiter.snapshot().inflight).toBe(0);
    });

    it('returns a spawn failure and releases the slot when the session factory throws', async () => {
      factory.failWith = new Error('unknown model "nope/missing"');

      const result = await runtime.spawn(spec());

      expect(result).toEqual({ ok: false, reason: 'tower spawn failed: unknown model "nope/missing"' });
      expect(limiter.snapshot().inflight).toBe(0);
      expect(runtime.list()).toEqual([]);
      expect(events).toEqual([]);
    });

    it('holds a limiter slot for the whole run, including session creation', async () => {
      const capped = new TowerAgentRuntime({
        sessionFactory: factory.create,
        limiter: new TowerRateLimiter({ now: () => now, maxRunningAgents: 1 }),
        createId: sequentialIds(),
      });
      let openGate: () => void = () => undefined;
      factory.gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      const first = capped.spawn(spec());

      const refused = await capped.spawn(spec({ name: 'agent-beta' }));
      expect(refused.ok).toBe(false);
      if (refused.ok) throw new Error('expected the second spawn to be refused');
      expect(refused.reason).toContain('tower concurrency budget exhausted (1/1');

      openGate();
      const { agentId } = started(await first);
      const finished = nextEvent(capped, 'finished');
      factory.session(agentId).settle();
      await finished;

      expect((await capped.spawn(spec({ name: 'agent-beta' }))).ok).toBe(true);
      await capped.disposeAll();
    });

    it('allocates ids before taking a slot, so a failing id allocation cannot leak one', async () => {
      let agents = 0;
      const colliding = new TowerAgentRuntime({
        sessionFactory: factory.create,
        limiter,
        createId: (prefix) => {
          if (prefix === 'task') return 'task-fixed';
          agents += 1;
          return `agent-${String(agents)}`;
        },
      });
      const { agentId } = started(await colliding.spawn(spec()));
      expect(limiter.snapshot().inflight).toBe(1);

      await expect(colliding.spawn(spec({ name: 'agent-beta' }))).rejects.toThrow(
        'could not allocate a unique tower task id',
      );
      expect(limiter.snapshot().inflight).toBe(1);
      const finished = nextEvent(colliding, 'finished');
      factory.session(agentId).settle();
      await finished;
      await expect(colliding.resume(agentId, 'continue')).rejects.toThrow(
        'could not allocate a unique tower task id',
      );
      expect(limiter.snapshot().inflight).toBe(0);
      await colliding.disposeAll();
    });

    it('releases the slot and disposes the session when shut down during creation', async () => {
      let openGate: () => void = () => undefined;
      factory.gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      const pending = runtime.spawn(spec());
      await runtime.disposeAll();
      openGate();

      const result = await pending;

      expect(result.ok).toBe(false);
      expect([...factory.sessions.values()].every((session) => session.disposed)).toBe(true);
      expect(limiter.snapshot().inflight).toBe(0);
    });
  });

  describe('steer', () => {
    it('delivers into a running session and reports steered', async () => {
      const { agentId } = started(await runtime.spawn(spec()));

      expect(await runtime.steer(agentId, '[tower inbox] new message from tower')).toBe('steered');
      expect(factory.session(agentId).steers).toEqual(['[tower inbox] new message from tower']);
    });

    it('reports idle without touching the session when no run is active', async () => {
      const { agentId } = started(await runtime.spawn(spec()));
      const session = factory.session(agentId);
      const finished = nextEvent(runtime, 'finished');
      session.settle();
      await finished;

      expect(await runtime.steer(agentId, 'late message')).toBe('idle');
      expect(session.steers).toEqual([]);
    });

    it('reports idle once the session settled even before the run is finalized', async () => {
      const { agentId } = started(await runtime.spawn(spec()));
      const session = factory.session(agentId);

      session.emit({ type: 'agent_settled', aborted: false });

      expect(runtime.get(agentId)?.status).toBe('running');
      expect(await runtime.steer(agentId, 'too late')).toBe('idle');
      expect(session.steers).toEqual([]);
    });

    it('reports missing for unknown agents', async () => {
      expect(await runtime.steer('agent-404', 'hello')).toBe('missing');
    });

    it('reports idle when the session stopped streaming before the run is finalized', async () => {
      const { agentId } = started(await runtime.spawn(spec()));
      const session = factory.session(agentId);

      session.isStreaming = false;

      expect(runtime.get(agentId)?.status).toBe('running');
      expect(await runtime.steer(agentId, 'nobody will read this')).toBe('idle');
      expect(session.steers).toEqual([]);
    });

    it('reports handled when an extension consumed the steered text', async () => {
      const { agentId } = started(await runtime.spawn(spec()));
      const session = factory.session(agentId);
      session.steerDisposition = 'handled';

      expect(await runtime.steer(agentId, 'intercepted')).toBe('handled');
      expect(session.queued).toEqual([]);
    });

    it('never throws: a session that refuses the text reports handled and a diagnostic', async () => {
      const diagnostics: string[] = [];
      const diagnosed = new TowerAgentRuntime({
        sessionFactory: factory.create,
        createId: sequentialIds(),
        onDiagnostic: (message) => {
          diagnostics.push(message);
        },
      });
      const { agentId } = started(await diagnosed.spawn(spec()));
      factory.session(agentId).steerError = new Error('Extension command "/deploy" cannot be queued.');

      expect(await diagnosed.steer(agentId, '/deploy now')).toBe('handled');
      expect(diagnostics).toEqual([
        `steering tower agent "agent-alpha" (${agentId}) failed: Extension command "/deploy" cannot be queued.`,
      ]);
      await diagnosed.disposeAll();
    });

    it('discards a steer that pi queued only after the run ended and reports idle', async () => {
      const { agentId } = started(await runtime.spawn(spec()));
      const session = factory.session(agentId);
      const gate = deferred();
      session.steerGate = gate.promise;
      const steering = runtime.steer(agentId, 'LATE directive');
      const finished = nextEvent(runtime, 'finished');
      session.settle();
      expect((await finished).undeliveredSteers).toEqual([]);

      gate.resolve();

      expect(await steering).toBe('idle');
      expect(session.queued).toEqual([]);
    });

    it('reports steers still queued when the run finalizes and never carries them into the next run', async () => {
      const { agentId, taskId } = started(await runtime.spawn(spec()));
      const session = factory.session(agentId);
      expect(await runtime.steer(agentId, 'STALE urgent directive')).toBe('steered');

      expect(await runtime.stop(agentId)).toBe('stopped');

      expect(events.at(-1)).toMatchObject({
        type: 'finished',
        taskId,
        status: 'stopped',
        undeliveredSteers: ['STALE urgent directive'],
      });
      expect(session.queued).toEqual([]);
      started(await runtime.resume(agentId, 'RESUME prompt'));
      expect(session.queued).toEqual([]);
      expect(session.delivered).toEqual([]);
    });

    it('does not report steers that reached the model as undelivered', async () => {
      const { agentId } = started(await runtime.spawn(spec()));
      const session = factory.session(agentId);
      expect(await runtime.steer(agentId, 'read your inbox')).toBe('steered');
      session.deliverQueued();
      const finished = nextEvent(runtime, 'finished');

      session.settle();

      expect((await finished).undeliveredSteers).toEqual([]);
      expect(session.delivered).toEqual(['read your inbox']);
    });

    it('moves other steers discarded by a late steer into the finished report', async () => {
      const { agentId } = started(await runtime.spawn(spec()));
      const session = factory.session(agentId);
      expect(await runtime.steer(agentId, 'EARLY steer')).toBe('steered');
      const gate = deferred();
      session.steerGate = gate.promise;
      const steering = runtime.steer(agentId, 'LATE steer');
      session.beginSettling();
      gate.resolve();

      expect(await steering).toBe('idle');
      const finished = nextEvent(runtime, 'finished');
      session.resolvePrompt();
      expect((await finished).undeliveredSteers).toEqual(['EARLY steer']);
    });

    it('accepts the current task id and treats an older task id as idle', async () => {
      const { agentId, taskId } = started(await runtime.spawn(spec()));
      const session = factory.session(agentId);
      expect(await runtime.steer(taskId, 'by task id')).toBe('steered');

      const finished = nextEvent(runtime, 'finished');
      session.settle();
      await finished;
      started(await runtime.resume(agentId, 'continue'));

      expect(await runtime.steer(taskId, 'stale task id')).toBe('idle');
      expect(session.steers).toEqual(['by task id']);
    });
  });

  describe('resume', () => {
    it('starts a new background run on the same session when idle', async () => {
      const first = started(await runtime.spawn(spec()));
      const session = factory.session(first.agentId);
      let finished = nextEvent(runtime, 'finished');
      session.reply('first answer', { totalTokens: 10 });
      session.settle();
      await finished;
      now = 9_000;

      const second = started(await runtime.resume(first.agentId, 'address the review findings'));

      expect(second.agentId).toBe(first.agentId);
      expect(second.taskId).not.toBe(first.taskId);
      expect(session.prompts).toEqual(['You are "agent-alpha", a tower worker.', 'address the review findings']);
      expect(events.at(-1)).toEqual({
        type: 'started',
        agentId: first.agentId,
        taskId: second.taskId,
        name: 'agent-alpha',
        resumed: true,
        at: 9_000,
      });
      expect(runtime.get(first.agentId)).toMatchObject({
        status: 'running',
        taskId: second.taskId,
        runs: 2,
        startedAt: 9_000,
        endedAt: undefined,
        stopReason: undefined,
      });

      finished = nextEvent(runtime, 'finished');
      session.reply('second answer', { totalTokens: 5 });
      session.settle();
      expect(await finished).toMatchObject({
        taskId: second.taskId,
        status: 'idle',
        summary: 'second answer',
        usage: { totalTokens: 5 },
      });
      expect(runtime.get(first.agentId)?.usage.totalTokens).toBe(15);
      expect(runtime.get(first.taskId)?.agentId).toBe(first.agentId);
    });

    it('refuses while the agent is running', async () => {
      const { agentId, taskId } = started(await runtime.spawn(spec()));

      const result = await runtime.resume(agentId, 'again');

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected resume to be refused');
      expect(result.reason).toContain(`is still running task ${taskId}`);
      expect(factory.session(agentId).prompts).toHaveLength(1);
    });

    it('refuses unknown agents and empty prompts', async () => {
      expect(await runtime.resume('agent-404', 'hello')).toEqual({
        ok: false,
        reason: 'unknown tower agent "agent-404"',
      });
      const { agentId } = started(await runtime.spawn(spec()));
      const finished = nextEvent(runtime, 'finished');
      factory.session(agentId).settle();
      await finished;

      expect((await runtime.resume(agentId, '   ')).ok).toBe(false);
    });

    it('resumes failed and stopped agents and clears the previous stop reason', async () => {
      const { agentId } = started(await runtime.spawn(spec()));
      await runtime.stop(agentId);
      expect(runtime.get(agentId)?.stopReason).toBe('user');

      started(await runtime.resume(agentId, 'pick it back up'));

      expect(runtime.get(agentId)).toMatchObject({ status: 'running', stopReason: undefined });
    });

    it('acquires a limiter slot for the resumed run', async () => {
      const { agentId } = started(await runtime.spawn(spec()));
      const finished = nextEvent(runtime, 'finished');
      factory.session(agentId).settle();
      await finished;
      limiter.reportRateLimited();

      const result = await runtime.resume(agentId, 'continue');

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected resume to be refused');
      expect(result.reason).toContain('new tower spawns paused');
      expect(limiter.snapshot().inflight).toBe(0);
    });

    it('waits for an in-flight steer so a late steer can never land in the resumed run', async () => {
      const { agentId } = started(await runtime.spawn(spec()));
      const session = factory.session(agentId);
      const gate = deferred();
      session.steerGate = gate.promise;
      let steerSettled = false;
      const steering = runtime.steer(agentId, 'SLOW directive').then((result) => {
        steerSettled = true;
        return result;
      });
      const finished = nextEvent(runtime, 'finished');
      session.settle();
      await finished;
      const atPrompt: Array<{ steerSettled: boolean; queued: string[] }> = [];
      const prompt = session.prompt.bind(session);
      session.prompt = (text) => {
        atPrompt.push({ steerSettled, queued: [...session.queued] });
        return prompt(text);
      };

      const resuming = runtime.resume(agentId, 'RESUME prompt');
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(session.prompts).toHaveLength(1);
      gate.resolve();

      expect(await steering).toBe('idle');
      expect((await resuming).ok).toBe(true);
      expect(atPrompt).toEqual([{ steerSettled: true, queued: [] }]);
      expect(session.prompts.at(-1)).toBe('RESUME prompt');
    });

    it('refuses to resume while a steer is still stuck in the session past the grace period', async () => {
      const { agentId } = started(await runtime.spawn(spec()));
      const session = factory.session(agentId);
      session.steerGate = new Promise<void>(() => undefined);
      void runtime.steer(agentId, 'STUCK directive');
      const finished = nextEvent(runtime, 'finished');
      session.settle();
      await finished;

      const result = await runtime.resume(agentId, 'RESUME prompt');

      expect(result).toEqual({
        ok: false,
        reason: `tower agent "agent-alpha" (${agentId}) is still processing a steered message — retry shortly`,
      });
      expect(session.prompts).toHaveLength(1);
      expect(limiter.snapshot().inflight).toBe(0);
    });
  });

  describe('stop', () => {
    it('aborts a running session and records the user stop reason', async () => {
      const { agentId, taskId } = started(await runtime.spawn(spec()));
      const session = factory.session(agentId);
      session.reply('half done');

      expect(await runtime.stop(agentId)).toBe('stopped');

      expect(session.abortCalls).toBe(1);
      expect(runtime.get(agentId)).toMatchObject({ status: 'stopped', stopReason: 'user' });
      expect(events.at(-1)).toMatchObject({
        type: 'finished',
        taskId,
        status: 'stopped',
        stopReason: 'user',
        summary: 'half done',
      });
      expect(limiter.snapshot().inflight).toBe(0);
    });

    it('records a custom stop reason', async () => {
      const { agentId } = started(await runtime.spawn(spec()));

      expect(await runtime.stop(agentId, 'mission abandoned')).toBe('stopped');

      expect(runtime.get(agentId)).toMatchObject({ status: 'stopped', stopReason: 'mission abandoned' });
    });

    it('reports idle for finished agents and missing for unknown ones', async () => {
      const { agentId } = started(await runtime.spawn(spec()));
      const finished = nextEvent(runtime, 'finished');
      factory.session(agentId).settle();
      await finished;

      expect(await runtime.stop(agentId)).toBe('idle');
      expect(await runtime.stop('agent-404')).toBe('missing');
      expect(factory.session(agentId).abortCalls).toBe(0);
    });

    it('finalizes the run after the grace period when the session ignores the abort', async () => {
      const { agentId } = started(await runtime.spawn(spec()));
      const session = factory.session(agentId);
      session.ignoreAbort = true;

      expect(await runtime.stop(agentId)).toBe('stopped');

      expect(runtime.get(agentId)?.status).toBe('stopped');
      expect(limiter.snapshot().inflight).toBe(0);
      const refused = await runtime.resume(agentId, 'continue');
      expect(refused.ok).toBe(false);
      if (refused.ok) throw new Error('expected resume to be refused');
      expect(refused.reason).toContain('still winding down');

      session.settle();
      await Promise.resolve();
      expect(events.filter((event) => event.type === 'finished')).toHaveLength(1);
      expect((await runtime.resume(agentId, 'continue')).ok).toBe(true);
    });

    it('keeps a run that is completing naturally idle instead of relabelling it stopped', async () => {
      const { agentId } = started(await runtime.spawn(spec()));
      const session = factory.session(agentId);
      session.reply('All done.');
      session.beginSettling();

      const stopping = runtime.stop(agentId);
      session.resolvePrompt();

      expect(await stopping).toBe('idle');
      expect(session.abortCalls).toBe(0);
      expect(runtime.get(agentId)).toMatchObject({ status: 'idle', stopReason: undefined });
      expect(events.at(-1)).toMatchObject({ type: 'finished', status: 'idle', summary: 'All done.' });
    });

    it('still stops a run whose natural completion does not finish within the grace period', async () => {
      const { agentId } = started(await runtime.spawn(spec()));
      const session = factory.session(agentId);
      session.beginSettling();

      expect(await runtime.stop(agentId)).toBe('stopped');

      expect(session.abortCalls).toBe(1);
      expect(runtime.get(agentId)).toMatchObject({ status: 'stopped', stopReason: 'user' });
    });

    it('stops a run that has not started streaming yet', async () => {
      factory.configure = (session) => {
        session.startsStreaming = false;
      };
      const { agentId } = started(await runtime.spawn(spec()));
      const session = factory.session(agentId);
      expect(session.isStreaming).toBe(false);

      expect(await runtime.stop(agentId)).toBe('stopped');

      expect(session.abortCalls).toBe(1);
      expect(runtime.get(agentId)).toMatchObject({ status: 'stopped', stopReason: 'user' });
    });
  });

  describe('timeouts', () => {
    it('aborts a run that exceeds its timeout and reports timed_out', async () => {
      const { agentId } = started(await runtime.spawn(spec({ timeoutMs: 20 })));
      const finished = nextEvent(runtime, 'finished');

      expect(await finished).toMatchObject({ status: 'timed_out', stopReason: 'timed out after 20ms' });
      expect(factory.session(agentId).abortCalls).toBe(1);
      expect(runtime.get(agentId)?.status).toBe('timed_out');
    });

    it('applies the runtime default timeout to resumed runs too', async () => {
      const timed = new TowerAgentRuntime({
        sessionFactory: factory.create,
        createId: sequentialIds(),
        timeoutMs: 20,
      });
      const { agentId } = started(await timed.spawn(spec()));
      await nextEvent(timed, 'finished');

      started(await timed.resume(agentId, 'continue'));

      expect(await nextEvent(timed, 'finished')).toMatchObject({ status: 'timed_out' });
      await timed.disposeAll();
    });

    it('does not time out a run that finished in time', async () => {
      const { agentId } = started(await runtime.spawn(spec({ timeoutMs: 30 })));
      const finished = nextEvent(runtime, 'finished');
      factory.session(agentId).settle();
      await finished;

      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(runtime.get(agentId)?.status).toBe('idle');
      expect(factory.session(agentId).abortCalls).toBe(0);
    });

    it('rejects invalid runtime durations', () => {
      expect(() => new TowerAgentRuntime({ sessionFactory: factory.create, timeoutMs: -1 })).toThrow(RangeError);
      expect(() => new TowerAgentRuntime({ sessionFactory: factory.create, stopGraceMs: 0 })).toThrow(RangeError);
    });
  });

  describe('rate limiting', () => {
    it('feeds provider 429s into the limiter and pauses new spawns', async () => {
      const first = started(await runtime.spawn(spec()));
      started(await runtime.spawn(spec({ name: 'agent-beta' })));

      factory.session(first.agentId).fail('429 Too Many Requests: rate limit exceeded');

      expect(events.at(-1)).toEqual({
        type: 'rate-limited',
        agentId: first.agentId,
        taskId: first.taskId,
        name: 'agent-alpha',
        message: '429 Too Many Requests: rate limit exceeded',
        at: 1_000,
      });
      expect(limiter.snapshot()).toEqual({ budget: 1, inflight: 2, blockedUntil: 1_000 + TOWER_SPAWN_PAUSE_MS });
      const refused = await runtime.spawn(spec({ name: 'agent-gamma' }));
      expect(refused.ok).toBe(false);
      if (refused.ok) throw new Error('expected the spawn to be refused');
      expect(refused.reason).toContain('new tower spawns paused');
    });

    it('reports successful responses so the pause lifts early', async () => {
      const { agentId, taskId } = started(await runtime.spawn(spec()));
      const session = factory.session(agentId);
      session.fail('rate_limit_error');
      expect(limiter.snapshot().blockedUntil).not.toBeNull();

      session.reply('back in business');

      expect(events.at(-1)).toEqual({
        type: 'request-succeeded',
        agentId,
        taskId,
        name: 'agent-alpha',
        at: 1_000,
      });
      expect(limiter.snapshot().blockedUntil).toBeNull();
    });

    it('does not treat other provider errors or aborted responses as rate limits or successes', async () => {
      const { agentId } = started(await runtime.spawn(spec()));
      const session = factory.session(agentId);

      session.fail('overloaded_error');
      session.emit({ type: 'message_end', message: fauxAssistantMessage('', { stopReason: 'aborted' }) });

      expect(events.map((event) => event.type)).toEqual(['started']);
      expect(limiter.snapshot().blockedUntil).toBeNull();
    });
  });

  describe('inspection', () => {
    it('snapshots streaming text, recent tool calls and usage without blocking', async () => {
      const { agentId } = started(await runtime.spawn(spec()));
      const session = factory.session(agentId);
      session.tool('call-1', 'bash', { command: 'npm test' }, false);
      now = 2_000;
      session.tool('call-2', 'read', { path: 'x'.repeat(500) });
      session.emit({
        type: 'tool_execution_start',
        toolCallId: 'call-2/1',
        toolName: 'grep',
        args: {},
        parentToolCallId: 'call-2',
      });
      session.stream('Working on the');

      const output = runtime.output(agentId);

      expect(output).toMatchObject({ status: 'running', streamingText: 'Working on the' });
      expect(output?.recentToolCalls).toEqual([
        { toolCallId: 'call-1', name: 'bash', args: '{"command":"npm test"}', startedAt: 1_000, endedAt: 1_000, isError: false },
        { toolCallId: 'call-2', name: 'read', args: `${`{"path":"${'x'.repeat(500)}"}`.slice(0, 200)}…`, startedAt: 2_000 },
      ]);

      session.reply('Working on the tests.', { totalTokens: 12 });
      expect(runtime.output(agentId)).toMatchObject({
        streamingText: undefined,
        lastAssistantText: 'Working on the tests.',
        usage: { totalTokens: 12 },
      });
    });

    it('keeps only the most recent tool calls', async () => {
      const { agentId } = started(await runtime.spawn(spec()));
      const session = factory.session(agentId);
      for (let index = 0; index < 25; index += 1) session.tool(`call-${String(index)}`, 'bash', {}, false);

      const calls = runtime.output(agentId)?.recentToolCalls ?? [];

      expect(calls).toHaveLength(20);
      expect(calls[0]?.toolCallId).toBe('call-5');
      expect(calls.at(-1)?.toolCallId).toBe('call-24');
    });

    it('lists all or only running agents and resolves task ids', async () => {
      const alpha = started(await runtime.spawn(spec()));
      const beta = started(await runtime.spawn(spec({ name: 'agent-beta' })));
      const finished = nextEvent(runtime, 'finished');
      factory.session(alpha.agentId).settle();
      await finished;

      expect(runtime.list().map((info) => [info.name, info.status])).toEqual([
        ['agent-alpha', 'idle'],
        ['agent-beta', 'running'],
      ]);
      expect(runtime.list(true).map((info) => info.agentId)).toEqual([beta.agentId]);
      expect(runtime.activeAgentIds()).toEqual(new Set([beta.agentId]));
      expect(runtime.get(beta.taskId)?.agentId).toBe(beta.agentId);
      expect(runtime.output(alpha.taskId)?.agentId).toBe(alpha.agentId);
      expect(runtime.get('agent-404')).toBeUndefined();
      expect(runtime.output('task-404')).toBeUndefined();
    });
  });

  describe('events', () => {
    it('isolates listener failures and supports unsubscribing', async () => {
      const failures: unknown[] = [];
      const isolated = new TowerAgentRuntime({
        sessionFactory: factory.create,
        createId: sequentialIds(),
        onListenerError: (error) => {
          failures.push(error);
        },
      });
      isolated.onEvent(() => {
        throw new Error('sync listener bug');
      });
      isolated.onEvent(async () => {
        throw new Error('async listener bug');
      });
      const seen: string[] = [];
      const unsubscribe = isolated.onEvent((event) => {
        seen.push(event.type);
      });

      const { agentId } = started(await isolated.spawn(spec()));
      unsubscribe();
      const finished = nextEvent(isolated, 'finished');
      factory.session(agentId).settle();
      await finished;
      await Promise.resolve();

      expect(seen).toEqual(['started']);
      expect(isolated.get(agentId)?.status).toBe('idle');
      expect(failures.map((error) => (error as Error).message)).toEqual([
        'sync listener bug',
        'async listener bug',
        'sync listener bug',
        'async listener bug',
      ]);
      await isolated.disposeAll();
    });
  });

  describe('disposal', () => {
    it('disposeAll stops running agents, disposes every session and refuses new work', async () => {
      const alpha = started(await runtime.spawn(spec()));
      const beta = started(await runtime.spawn(spec({ name: 'agent-beta' })));
      const finished = nextEvent(runtime, 'finished');
      factory.session(beta.agentId).settle();
      await finished;

      await runtime.disposeAll();

      expect(events.filter((event) => event.type === 'finished').map((event) => [event.agentId, event.status, event.stopReason])).toEqual([
        [beta.agentId, 'idle', undefined],
        [alpha.agentId, 'stopped', 'shutdown'],
      ]);
      expect(factory.session(alpha.agentId).disposed).toBe(true);
      expect(factory.session(beta.agentId).disposed).toBe(true);
      expect(factory.session(alpha.agentId).listenerCount).toBe(0);
      expect(runtime.list()).toEqual([]);
      expect(await runtime.spawn(spec())).toMatchObject({ ok: false });
      expect(await runtime.resume(alpha.agentId, 'continue')).toMatchObject({ ok: false });
      expect(limiter.snapshot().inflight).toBe(0);
    });

    it('dispose removes a single agent and stops it first when running', async () => {
      const alpha = started(await runtime.spawn(spec()));
      const beta = started(await runtime.spawn(spec({ name: 'agent-beta' })));

      expect(await runtime.dispose(alpha.agentId)).toBe(true);

      expect(runtime.get(alpha.agentId)).toBeUndefined();
      expect(runtime.get(alpha.taskId)).toBeUndefined();
      expect(factory.session(alpha.agentId).disposed).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: 'finished', agentId: alpha.agentId, stopReason: 'disposed' });
      expect(runtime.get(beta.agentId)?.status).toBe('running');
      expect(await runtime.dispose(alpha.agentId)).toBe(false);
    });
  });
});
