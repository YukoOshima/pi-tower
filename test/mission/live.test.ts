import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MISSION_MODE_ENTRY, MISSION_PANEL_MAX_LINES, MISSION_STATUS_KEY, MISSION_WIDGET_KEY } from '../../src/mission/constants.ts';
import { latestMissionModeRecord } from '../../src/mission/mode.ts';
import { STATE_FILE, type TowerState } from '../../src/protocol/index.ts';
import { handleTowerCommand } from '../../src/tower/command.ts';
import { TOWER_MODE_ENTRY } from '../../src/tower/constants.ts';
import { createRepo, removeDir, settle } from '../tower/fakes.ts';
import { SESSION_ID, awaitingApproval, missionHarness, recordingUi, type MissionHarness } from './fakes.ts';

const cleanups: string[] = [];

afterEach(async () => {
  for (const dir of cleanups.splice(0)) await removeDir(dir);
});

async function executingMission(h: MissionHarness): Promise<void> {
  await awaitingApproval(h.store);
  await h.store.approveObjective('human');
}

function missionWidgetCalls(h: MissionHarness): number {
  return h.ctx.widgetCalls.filter((call) => call.key === MISSION_WIDGET_KEY).length;
}

describe('Mission Control panel', () => {
  it('renders above the editor with at most ten lines and mirrors them in the footer status', async () => {
    const h = await missionHarness(cleanups);
    await executingMission(h);

    await h.run('');

    await vi.waitFor(() => {
      expect(h.ctx.widget()).toBeDefined();
    });
    const call = h.ctx.widgetCalls.find((entry) => entry.key === MISSION_WIDGET_KEY);
    expect(call?.placement).toBe('aboveEditor');
    const lines = h.ctx.widget() ?? [];
    expect(lines.length).toBeLessThanOrEqual(MISSION_PANEL_MAX_LINES);
    expect(lines[0]).toMatch(/^🔵 Mission O1 CSV and JSON export · executing · \d+s · \$0\.00$/);
    expect(lines[1]).toBe('🔵 MS1 Serializers (0/2 merged)   ⚪ MS2 CLI options');
    expect(lines).toContain('🟡 M1 CSV serializer — queued');
    expect(lines).toContain('agents: 0 workers · 0 reviewers · 0 validators running · limit 256');
    expect(lines).toContain('models: orchestrator session-model · worker session-model · reviewer session-model · validator = orchestrator');
    expect(lines.at(-1)).toBe('next: 2 features of MS1 in flight — validation starts once all are merged');
    expect(h.ctx.ui.statuses.get(MISSION_STATUS_KEY)).toBe('mission O1 executing · MS1 0/2 merged');
  });

  it('refreshes on tower state changes at most once per throttle window', async () => {
    const h = await missionHarness(cleanups, { throttleMs: 1_000 });
    await executingMission(h);
    await h.run('');
    await vi.waitFor(() => {
      expect(h.ctx.widget()?.[0]).toContain('executing');
    });
    await settle(10);
    const before = missionWidgetCalls(h);

    await h.store.pauseObjective('budget review');
    h.controller.noteStateChange('tool TowerObjective');
    h.controller.noteStateChange('autopilot tool TowerObjective');
    h.controller.noteStateChange('agent finished');
    await settle(10);
    expect(h.ctx.widget()?.[0]).toContain('executing');
    expect(missionWidgetCalls(h)).toBe(before);

    h.timers.advance(1_000);
    await vi.waitFor(() => {
      expect(h.ctx.widget()?.[0]).toContain('paused');
    });
    expect(missionWidgetCalls(h)).toBe(before + 1);
    expect(h.ctx.widget()?.at(-1)).toBe('next: paused (budget review) — /mission resume continues');
  });

  it('updates the elapsed time on the slow timer and skips identical renders', async () => {
    const h = await missionHarness(cleanups);
    await executingMission(h);
    await h.run('');
    await vi.waitFor(() => {
      expect(h.ctx.widget()).toBeDefined();
    });
    await settle(10);
    const first = h.ctx.widget()?.[0] ?? '';
    const calls = missionWidgetCalls(h);

    h.controller.noteStateChange('nothing changed');
    await settle(10);
    expect(missionWidgetCalls(h)).toBe(calls);

    h.timers.advance(5_000);
    await vi.waitFor(() => {
      expect(h.ctx.widget()?.[0]).not.toBe(first);
    });
    expect(missionWidgetCalls(h)).toBe(calls + 1);
  });

  it('clears the panel and the status on /mission exit and stops refreshing', async () => {
    const h = await missionHarness(cleanups);
    await executingMission(h);
    await h.run('');
    await vi.waitFor(() => {
      expect(h.ctx.widget()).toBeDefined();
    });

    await h.run('exit');

    expect(h.ctx.widget()).toBeUndefined();
    expect(h.ctx.ui.statuses.get(MISSION_STATUS_KEY)).toBeUndefined();
    expect(h.timers.activeIntervals).toBe(0);
    const calls = h.ctx.widgetCalls.length;
    h.controller.noteStateChange('after exit');
    h.timers.advance(10_000);
    await settle(10);
    expect(h.ctx.widgetCalls).toHaveLength(calls);
  });

  it('clears the panel and the status on /tower off', async () => {
    const h = await missionHarness(cleanups);
    await executingMission(h);
    await h.run('');
    await vi.waitFor(() => {
      expect(h.ctx.missionStatus()).toBeDefined();
    });

    const { ui, recorded } = recordingUi();
    await handleTowerCommand(h.controller, 'off', h.ctx.asCommandContext, { sendUserMessage: () => undefined }, ui);

    expect(recorded.notices).toEqual([{ title: 'Tower mode: OFF' }]);
    expect(h.ctx.widget()).toBeUndefined();
    expect(h.ctx.missionStatus()).toBeUndefined();
    expect(h.mission.active).toBe(false);
    expect(h.pi.appended.at(-1)).toEqual({ customType: MISSION_MODE_ENTRY, data: { active: false } });
  });

  it('leaves the UI untouched for /tower users who never entered mission mode', async () => {
    const h = await missionHarness(cleanups);
    await executingMission(h);
    const { ui } = recordingUi();
    const deps = { sendUserMessage: () => undefined };

    await handleTowerCommand(h.controller, 'on', h.ctx.asCommandContext, deps, ui);
    h.controller.noteStateChange('tool TowerPlan');
    await handleTowerCommand(h.controller, 'off', h.ctx.asCommandContext, deps, ui);
    await settle(10);

    expect(h.ctx.widgetCalls).toEqual([]);
    expect(h.ctx.statusCalls.filter((call) => call.key === MISSION_STATUS_KEY)).toEqual([]);
    expect(h.pi.appended.map((entry) => entry.customType)).toEqual([TOWER_MODE_ENTRY, TOWER_MODE_ENTRY]);
    expect(h.timers.activeIntervals).toBe(0);
  });

  it('keeps a just completed mission on the panel until the intake is armed for the next one', async () => {
    const h = await missionHarness(cleanups);
    await executingMission(h);
    await h.run('');
    await vi.waitFor(() => {
      expect(h.ctx.widget()).toBeDefined();
    });
    const file = join(h.repo, STATE_FILE);
    const state = JSON.parse(await readFile(file, 'utf8')) as TowerState;
    await writeFile(
      file,
      `${JSON.stringify({ ...state, objective: { ...state.objective, status: 'completed', completedAt: new Date().toISOString() } }, null, 2)}\n`,
    );
    h.controller.noteStateChange('completed');
    await vi.waitFor(() => {
      expect(h.ctx.widget()?.[0]).toContain('completed');
    });
    expect(h.ctx.widget()?.at(-1)).toBe('next: done — /mission starts a new mission');

    await h.run('');

    await vi.waitFor(() => {
      expect(h.ctx.widget()).toBeUndefined();
    });
    expect(h.ctx.missionStatus()).toBe('mission: waiting for your goal');
    expect(h.mission.intakeArmed).toBe(true);
  });

  it('hides a blocked mission once a new goal is handed over', async () => {
    const h = await missionHarness(cleanups);
    await executingMission(h);
    await h.run('');
    await vi.waitFor(() => {
      expect(h.ctx.widget()).toBeDefined();
    });
    await h.store.blockObjective('replaced by a new goal');
    h.controller.noteStateChange('blocked');
    await vi.waitFor(() => {
      expect(h.ctx.widget()?.[0]).toContain('blocked');
    });

    await h.run('A new goal for the next mission');

    await vi.waitFor(() => {
      expect(h.ctx.widget()).toBeUndefined();
    });
    expect(h.ctx.missionStatus()).toBe('mission: planning your goal');
  });
});

describe('mission mode on session start', () => {
  it('restores mission mode and the panel when tower mode is restored with it', async () => {
    const repo = await createRepo('mission-restore-');
    cleanups.push(repo);
    const first = await missionHarness(cleanups, { repo });
    await executingMission(first);
    await first.run('');
    await vi.waitFor(() => {
      expect(first.ctx.widget()).toBeDefined();
    });
    first.mission.onSessionShutdown();

    const entries = first.session.entries;
    expect(latestMissionModeRecord(entries)).toEqual({ active: true });
    const resumed = await missionHarness(cleanups, { repo, entries: [...entries] });

    expect(resumed.controller.isActive).toBe(true);
    expect(resumed.mission.active).toBe(true);
    await vi.waitFor(() => {
      expect(resumed.ctx.widget()?.[0]).toContain('Mission O1');
    });
  });

  it('stays off without a mission record, or when the tower was turned off', async () => {
    const repo = await createRepo('mission-restore-off-');
    cleanups.push(repo);
    const towerOnly = await missionHarness(cleanups, {
      repo,
      entries: [{ type: 'custom', id: 'e1', customType: TOWER_MODE_ENTRY, data: { active: true, sessionId: SESSION_ID } }],
    });
    expect(towerOnly.controller.isActive).toBe(true);
    expect(towerOnly.mission.active).toBe(false);
    await towerOnly.controller.exit();

    const exited = await missionHarness(cleanups, {
      repo,
      entries: [
        { type: 'custom', id: 'e1', customType: TOWER_MODE_ENTRY, data: { active: false } },
        { type: 'custom', id: 'e2', customType: MISSION_MODE_ENTRY, data: { active: true } },
      ],
    });
    expect(exited.mission.active).toBe(false);
    expect(latestMissionModeRecord([{ type: 'custom', customType: MISSION_MODE_ENTRY, data: { active: 'yes' } }])).toBeUndefined();
  });
});
