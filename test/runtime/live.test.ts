import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { TowerAgentRuntime } from '../../src/runtime/agentRuntime.ts';
import { createPiSessionFactory } from '../../src/runtime/sessionFactory.ts';
import { nextEvent } from './fakeSession.ts';

const LIVE = process.env.PI_TOWER_LIVE === '1';
const MODEL = process.env.PI_TOWER_LIVE_MODEL ?? 'byteplus-gateway/claude-haiku-5-5';
const REPLY_TOKEN = 'PI-TOWER-LIVE-OK';
const STEER_TOKEN = 'STEER-ACK-7731';
const RESUME_TOKEN = 'RESUME-ACK-2049';
const RUN_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 300_000;

describe.skipIf(!LIVE)(`live tower agent on ${MODEL}`, () => {
  it(
    'completes with the reply token on the bound model, round-trips a steer and resumes the conversation',
    async () => {
      const repoRoot = mkdtempSync(join(tmpdir(), 'pi-tower-live-'));
      const runtime = new TowerAgentRuntime({
        sessionFactory: createPiSessionFactory({ repoRoot }),
        timeoutMs: RUN_TIMEOUT_MS,
      });
      const log: string[] = [];
      runtime.onEvent((event) => {
        log.push(
          event.type === 'finished'
            ? `${event.type} ${event.status} tokens=${String(event.usage.totalTokens)}`
            : event.type,
        );
      });
      try {
        const startedAt = Date.now();
        let finished = nextEvent(runtime, 'finished');
        const spawned = await runtime.spawn({
          name: 'live-smoke',
          kind: 'worker',
          cwd: repoRoot,
          model: MODEL,
          thinkingLevel: 'off',
          prompt:
            'Step 1: run the bash command `sleep 6` exactly once. ' +
            `Step 2: when it has finished, reply with the token ${REPLY_TOKEN}. ` +
            'If you receive further instructions while you work, follow them as well.',
        });
        if (!spawned.ok) throw new Error(spawned.reason);
        const { agentId } = spawned;
        expect(runtime.get(agentId)?.model).toBe(MODEL);

        await vi.waitFor(
          () => {
            const output = runtime.output(agentId);
            const bashStarted = output?.recentToolCalls.some((call) => call.name === 'bash') ?? false;
            expect(bashStarted || output?.status !== 'running').toBe(true);
          },
          { timeout: RUN_TIMEOUT_MS, interval: 100 },
        );
        const midRun = runtime.output(agentId);
        expect(midRun?.status, `run ended before the steer: ${String(midRun?.lastAssistantText)}`).toBe('running');
        const steered = await runtime.steer(
          agentId,
          `Additional instruction from the tower: also include the token ${STEER_TOKEN} in your final reply.`,
        );
        expect(steered).toBe('steered');

        const first = await finished;
        log.push(`first summary: ${String(first.summary)}`);
        expect(first.status).toBe('idle');
        expect(first.summary).toContain(REPLY_TOKEN);
        expect(first.summary).toContain(STEER_TOKEN);
        expect(first.usage.totalTokens).toBeGreaterThan(0);

        finished = nextEvent(runtime, 'finished');
        const resumed = await runtime.resume(
          agentId,
          `Reply with the token you were first asked to reply with, followed by ${RESUME_TOKEN}. Do not run any tools.`,
        );
        if (!resumed.ok) throw new Error(resumed.reason);
        const second = await finished;
        log.push(`second summary: ${String(second.summary)}`);
        expect(second.status).toBe('idle');
        expect(second.summary).toContain(REPLY_TOKEN);
        expect(second.summary).toContain(RESUME_TOKEN);

        const info = runtime.get(agentId);
        expect(info).toMatchObject({ status: 'idle', runs: 2, model: MODEL });
        expect(dirname(info?.sessionFile ?? '')).toBe(join(repoRoot, '.tower', 'agents'));
        expect(existsSync(info?.sessionFile ?? '')).toBe(true);
        log.push(
          `agent=${agentId} model=${String(info?.model)} runs=${String(info?.runs)} ` +
            `tokens=${String(info?.usage.totalTokens)} cost=${String(info?.usage.cost)} ` +
            `elapsed=${String(Date.now() - startedAt)}ms`,
        );
      } finally {
        console.log(`[live smoke]\n${log.join('\n')}`);
        await runtime.disposeAll();
        rmSync(repoRoot, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
