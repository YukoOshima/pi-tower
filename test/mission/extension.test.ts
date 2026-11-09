import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import towerExtension from '../../src/index.ts';
import { MISSION_COMMAND, MISSION_COMMAND_ALIAS } from '../../src/mission/constants.ts';
import {
  MISSION_APPROVE_OPTION,
  MISSION_COMMAND_DESCRIPTION,
  MISSION_COMMAND_USAGE,
  MISSION_KEEP_PLANNING_OPTION,
  MISSIONS_COMMAND_DESCRIPTION,
} from '../../src/mission/texts.ts';
import { buildObjectivePlanningPrompt } from '../../src/prompts/objectivePlanning.ts';
import { TowerStore } from '../../src/protocol/index.ts';
import { TOWER_COMMAND } from '../../src/tower/constants.ts';
import { FakeSessionManager, createRepo, removeDir, settle } from '../tower/fakes.ts';
import { MissionContext, plannedObjective } from './fakes.ts';

type Handler = (event: unknown, ctx: unknown) => unknown;

interface RecordedCommand {
  readonly description?: string;
  getArgumentCompletions?(prefix: string): unknown;
  handler(args: string, ctx: unknown): Promise<void>;
}

class RecordingPi {
  readonly commands = new Map<string, RecordedCommand>();
  readonly handlers = new Map<string, Handler[]>();
  readonly userMessages: { readonly text: unknown; readonly options?: unknown }[] = [];
  session: FakeSessionManager | undefined;
  activeTools: string[] = ['read', 'bash', 'edit', 'write'];

  registerTool(): void {
    return;
  }

  registerFlag(): void {
    return;
  }

  registerCommand(name: string, options: RecordedCommand): void {
    this.commands.set(name, options);
  }

  on(event: string, handler: Handler): () => void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return () => {
      this.handlers.set(
        event,
        (this.handlers.get(event) ?? []).filter((entry) => entry !== handler),
      );
    };
  }

  getFlag(): undefined {
    return undefined;
  }

  getActiveTools(): string[] {
    return [...this.activeTools];
  }

  setActiveTools(names: string[]): void {
    this.activeTools = [...names];
  }

  appendEntry(customType: string, data?: unknown): void {
    this.session?.append({ type: 'custom', customType, data });
  }

  sendMessage(): void {
    return;
  }

  sendUserMessage(text: unknown, options?: unknown): void {
    this.userMessages.push(options === undefined ? { text } : { text, options });
  }

  getThinkingLevel(): string {
    return 'medium';
  }

  setThinkingLevel(): void {
    return;
  }

  async setModel(): Promise<boolean> {
    return true;
  }

  async emit(event: string, payload: unknown, ctx: unknown): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of this.handlers.get(event) ?? []) results.push(await handler(payload, ctx));
    return results;
  }

  command(name: string): RecordedCommand {
    const command = this.commands.get(name);
    if (command === undefined) throw new Error(`/${name} is not registered`);
    return command;
  }

  get api(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }
}

const cleanups: string[] = [];

beforeEach(async () => {
  const agentDir = await mkdtemp(join(tmpdir(), 'mission-extension-agent-'));
  cleanups.push(agentDir);
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of cleanups.splice(0)) await removeDir(dir);
});

async function started(): Promise<{ readonly pi: RecordingPi; readonly ctx: MissionContext; readonly repo: string }> {
  const repo = await createRepo('mission-extension-');
  cleanups.push(repo);
  const session = new FakeSessionManager('session-extension');
  const ctx = new MissionContext(repo, session);
  ctx.model = ctx.modelRegistry.add('prov', 'session-model');
  const pi = new RecordingPi();
  pi.session = session;
  towerExtension(pi.api);
  await pi.emit('session_start', { type: 'session_start', reason: 'startup' }, ctx);
  return { pi, ctx, repo };
}

describe('/mission in the extension', () => {
  it('registers /mission and its /missions alias next to /tower, with completions', async () => {
    const { pi, ctx } = await started();

    expect([...pi.commands.keys()]).toEqual([TOWER_COMMAND, MISSION_COMMAND, MISSION_COMMAND_ALIAS]);
    expect(pi.command(MISSION_COMMAND).description).toBe(MISSION_COMMAND_DESCRIPTION);
    expect(pi.command(MISSION_COMMAND_ALIAS).description).toBe(MISSIONS_COMMAND_DESCRIPTION);
    expect(pi.command(MISSION_COMMAND_ALIAS).getArgumentCompletions?.('ap')).toEqual([
      { value: 'approve', label: 'approve', description: 'Approve the plan and start the mission' },
    ]);

    await pi.command(MISSION_COMMAND_ALIAS).handler('help', ctx);
    expect(ctx.ui.notices.at(-1)).toEqual({ message: `Mission command\n${MISSION_COMMAND_USAGE}`, level: 'info' });

    await pi.emit('session_shutdown', { type: 'session_shutdown' }, ctx);
  });

  it('captures the goal through the input hook after /missions and lets later messages through', async () => {
    const { pi, ctx } = await started();

    await pi.command(MISSION_COMMAND_ALIAS).handler('', ctx);
    expect(ctx.ui.notices.at(-1)?.message.startsWith('Mission mode\n')).toBe(true);

    const skipped = await pi.emit('input', { type: 'input', text: '/skill:plan', source: 'interactive' }, ctx);
    const captured = await pi.emit('input', { type: 'input', text: 'Ship a CSV export', source: 'interactive' }, ctx);
    const later = await pi.emit('input', { type: 'input', text: 'CSV only, no JSON', source: 'interactive' }, ctx);

    expect(skipped).toEqual([{ action: 'continue' }]);
    expect(captured).toEqual([{ action: 'handled' }]);
    expect(later).toEqual([{ action: 'continue' }]);
    expect(pi.userMessages).toEqual([{ text: buildObjectivePlanningPrompt({ mode: 'interactive', text: 'Ship a CSV export' }) }]);

    await pi.command(MISSION_COMMAND).handler('exit', ctx);
    await pi.emit('session_shutdown', { type: 'session_shutdown' }, ctx);
  });

  it('disarms the intake when /tower objective hands the goal over', async () => {
    const { pi, ctx } = await started();
    await pi.command(MISSION_COMMAND).handler('', ctx);

    await pi.command(TOWER_COMMAND).handler('objective Ship a CSV export', ctx);
    const answer = await pi.emit('input', { type: 'input', text: 'Out of scope: JSON', source: 'interactive' }, ctx);

    expect(answer).toEqual([{ action: 'continue' }]);
    expect(pi.userMessages).toHaveLength(1);
    await pi.emit('session_shutdown', { type: 'session_shutdown' }, ctx);
  });

  it('offers the approval dialog when the orchestrator requests approval', async () => {
    const { pi, ctx, repo } = await started();
    await pi.command(MISSION_COMMAND).handler('', ctx);
    await pi.emit('input', { type: 'input', text: 'Ship a CSV export', source: 'interactive' }, ctx);
    const store = new TowerStore(repo);
    await plannedObjective(store);
    await store.requestObjectiveApproval();

    await pi.emit(
      'tool_result',
      {
        type: 'tool_result',
        toolName: 'TowerObjective',
        toolCallId: 'call_request',
        input: { action: 'request-approval' },
        content: [],
        isError: false,
        details: undefined,
      },
      ctx,
    );

    await vi.waitFor(
      () => {
        expect(ctx.selects).toHaveLength(1);
      },
      { timeout: 5_000 },
    );
    ctx.selects[0]?.answer(MISSION_APPROVE_OPTION);
    await vi.waitFor(async () => {
      expect((await store.load()).objective?.status).toBe('executing');
    });
    await vi.waitFor(() => {
      expect(ctx.ui.notices.some((notice) => notice.message.startsWith('Mission O1 approved'))).toBe(true);
    });

    await pi.command(MISSION_COMMAND).handler('exit', ctx);
    await pi.emit('session_shutdown', { type: 'session_shutdown' }, ctx);
  });

  it('holds the approval dialog back while another extension prompt is open, listening only while mission mode is on', async () => {
    const { pi, ctx, repo } = await started();
    expect(pi.handlers.has('ui_prompt_start')).toBe(false);

    await pi.command(MISSION_COMMAND).handler('', ctx);
    expect(pi.handlers.get('ui_prompt_start')).toHaveLength(1);
    expect(pi.handlers.get('ui_prompt_end')).toHaveLength(1);
    await pi.emit('input', { type: 'input', text: 'Ship a CSV export', source: 'interactive' }, ctx);
    const store = new TowerStore(repo);
    await plannedObjective(store);
    await store.requestObjectiveApproval();
    const prompt = { reason: 'ui_prompt', kind: 'input', title: 'API key for another extension' } as const;
    await pi.emit('ui_prompt_start', { type: 'ui_prompt_start', ...prompt }, ctx);

    await pi.emit(
      'tool_result',
      {
        type: 'tool_result',
        toolName: 'TowerObjective',
        toolCallId: 'call_request',
        input: { action: 'request-approval' },
        content: [],
        isError: false,
        details: undefined,
      },
      ctx,
    );
    await vi.waitFor(
      () => {
        expect(ctx.widget()?.[0]).toContain('awaiting approval');
      },
      { timeout: 5_000 },
    );
    await settle(10);
    expect(ctx.selects).toEqual([]);

    await pi.emit('ui_prompt_end', { type: 'ui_prompt_end', ...prompt }, ctx);
    await vi.waitFor(
      () => {
        expect(ctx.selects).toHaveLength(1);
      },
      { timeout: 5_000 },
    );
    ctx.selects[0]?.answer(MISSION_KEEP_PLANNING_OPTION);

    await pi.command(MISSION_COMMAND).handler('exit', ctx);
    expect(pi.handlers.get('ui_prompt_start')).toEqual([]);
    expect(pi.handlers.get('ui_prompt_end')).toEqual([]);
    await pi.emit('session_shutdown', { type: 'session_shutdown' }, ctx);
  });
});
