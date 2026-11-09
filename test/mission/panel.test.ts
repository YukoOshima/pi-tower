import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';

import {
  resolveTowerModels,
  TOWER_ROLES,
  type TowerConfig,
  type TowerConfigValue,
  type TowerModelSpec,
  type TowerResolvedModels,
  type TowerRole,
} from '../../src/config/index.ts';
import { MISSION_PANEL_LINE_MAX_CHARS, MISSION_PANEL_MAX_LINES } from '../../src/mission/constants.ts';
import {
  missionPanelComponent,
  renderMissionPanel,
  renderMissionStatus,
  type MissionPanelInput,
} from '../../src/mission/panel.ts';
import { MissionRefresher } from '../../src/mission/refresher.ts';
import type {
  TowerMilestone,
  TowerMission,
  TowerMissionStatus,
  TowerObjective,
  TowerRosterEntry,
} from '../../src/protocol/index.ts';
import { ManualTimers } from './fakes.ts';

const STARTED = Date.parse('2026-11-09T10:00:00.000Z');
const NOW = STARTED + 12 * 60_000 + 4_000;

function milestone(id: string, title: string, status: TowerMilestone['status'], order: number): TowerMilestone {
  return {
    id,
    title,
    order,
    status,
    validation: { scrutiny: true, userTesting: false, commands: [] },
    rounds: [],
  };
}

function objective(patch: Partial<TowerObjective> = {}): TowerObjective {
  return {
    id: 'O1',
    title: 'CSV and JSON export',
    goal: 'Add a --format csv|json option to shop report',
    definitionOfDone: ['both formats work'],
    acceptanceCommands: [],
    status: 'executing',
    milestones: [milestone('MS1', 'Serializers', 'passed', 1), milestone('MS2', 'CLI options', 'active', 2)],
    limits: { maxValidationRounds: 3, maxFeatureAttempts: 3, maxCostUsd: 5 },
    createdAt: '2026-11-09T09:30:00.000Z',
    startedAt: new Date(STARTED).toISOString(),
    usage: { costUsd: 1.82 },
    notes: [],
    ...patch,
  };
}

function feature(id: string, title: string, status: TowerMissionStatus, patch: Partial<TowerMission> = {}): TowerMission {
  const slug = title.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-');
  return {
    id,
    title,
    slug,
    kind: 'build',
    scope: [`src/${slug}/**`],
    branch: `feat/${slug}`,
    worktree: `wt-${id}`,
    deps: [],
    status,
    tasks: [],
    notes: [],
    blockers: [],
    milestone: 'MS2',
    ...patch,
  };
}

function agent(name: string, kind: TowerRosterEntry['kind'], patch: Partial<TowerRosterEntry> = {}): TowerRosterEntry {
  return { name, agentId: `agent-${name}`, kind, spawnedAt: '2026-11-09T10:01:00.000Z', ...patch };
}

const MODELS = resolveTowerModels(
  {
    roles: {
      orchestrator: {
        value: { provider: 'anthropic', modelId: 'claude-opus-5-5', thinkingLevel: 'high' },
        source: { kind: 'file', scope: 'global', path: '/a/tower.json' },
      },
      worker: { value: { provider: 'anthropic', modelId: 'claude-sonnet-5-5' }, source: { kind: 'file', scope: 'global', path: '/a/tower.json' } },
      reviewer: { value: { provider: 'openai', modelId: 'gpt-5.5' }, source: { kind: 'file', scope: 'global', path: '/a/tower.json' } },
    },
    models: {},
    files: [],
  } satisfies TowerConfig,
  undefined,
);

function configuredModels(refs: Readonly<Partial<Record<TowerRole, string>>>): TowerResolvedModels {
  const roles: Partial<Record<TowerRole, TowerConfigValue<TowerModelSpec>>> = {};
  for (const role of TOWER_ROLES) {
    const ref = refs[role];
    if (ref === undefined) continue;
    const slash = ref.indexOf('/');
    roles[role] = {
      value: { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) },
      source: { kind: 'file', scope: 'global', path: '/a/tower.json' },
    };
  }
  return resolveTowerModels({ roles, models: {}, files: [] }, undefined);
}

const GATEWAY_MODELS = configuredModels({
  orchestrator: 'byteplus-gateway/claude-opus-5-5',
  worker: 'byteplus-gateway/claude-sonnet-5-5',
  reviewer: 'byteplus-gateway/claude-sonnet-5-5',
  validator: 'byteplus-gateway/claude-sonnet-5-5',
});

function modelsSection(rows: readonly string[]): string[] {
  const start = rows.findIndex((row) => row.trimStart().startsWith('models: '));
  const end = rows.findIndex((row) => row.trimStart().startsWith('next: '));
  return start === -1 || end === -1 ? [] : rows.slice(start, end);
}

function input(patch: Partial<MissionPanelInput> = {}): MissionPanelInput {
  return {
    objective: objective(),
    missions: [
      feature('M3', 'JSON serializer', 'merged', { milestone: 'MS1' }),
      feature('M4', '--format option', 'active'),
      feature('M5', 'README', 'completed'),
      feature('M6', 'tests', 'merged'),
      feature('M7', 'Shell completion', 'planned', { deps: ['M4'] }),
    ],
    agents: [agent('w-m4', 'worker', { missionId: 'M4' }), agent('rev-m5', 'reviewer', { reviewMissionId: 'M5' })],
    models: MODELS,
    maxRunningAgents: 256,
    nowMs: NOW,
    ...patch,
  };
}

describe('renderMissionPanel', () => {
  it('shows the mission, the milestone strip, the current features with their agents, the agents, the models and the next step', () => {
    expect(renderMissionPanel(input())).toEqual([
      '🔵 Mission O1 CSV and JSON export · executing · 12m 04s · $1.82 of $5.00',
      '✅ MS1 Serializers   🔵 MS2 CLI options (1/4 merged)',
      '🔵 M4 --format option — worker w-m4 running',
      '🟢 M5 README — in review · rev-m5',
      '🟡 M7 Shell completion — waits for M4',
      '✅ M6 tests — merged',
      'agents: 1 worker · 1 reviewer · 0 validators running · limit 256',
      'models: orchestrator claude-opus-5-5 · worker claude-sonnet-5-5 · reviewer gpt-5.5 · validator = reviewer',
      'next: 3 features of MS2 in flight — validation starts once all are merged',
    ]);
  });

  it('never exceeds ten lines and points to /mission for the features it cannot show', () => {
    const missions = Array.from({ length: 12 }, (_, index) => feature(`M${String(index + 10)}`, `Feature ${String(index)}`, 'active'));

    const lines = renderMissionPanel(input({ missions }));

    expect(lines).toHaveLength(MISSION_PANEL_MAX_LINES);
    expect(lines[6]).toBe('… 8 more features — /mission shows all');
    expect(lines.at(-1)).toBe('next: 12 features of MS2 in flight — validation starts once all are merged');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(120);
  });

  it('shows a planning mission as not started, with its budget, and leaves the models line out without models', () => {
    const planning = objective({
      status: 'planning',
      startedAt: undefined,
      usage: undefined,
      milestones: [milestone('MS1', 'Serializers', 'pending', 1)],
    });

    const lines = renderMissionPanel(input({ objective: planning, missions: [], agents: [], models: undefined }));

    expect(lines).toEqual([
      '📝 Mission O1 CSV and JSON export · planning · not started · budget $5.00',
      '⚪ MS1 Serializers',
      'no features planned for MS1 yet',
      'agents: 0 workers · 0 reviewers · 0 validators running · limit 256',
      "next: answer the orchestrator's questions — it drafts the mission and proposes a plan",
    ]);
  });

  it('asks for the approval while awaiting it and shows the elapsed time of a completed mission', () => {
    const awaiting = objective({ status: 'awaiting-approval', startedAt: undefined, limits: { maxValidationRounds: 3, maxFeatureAttempts: 3 } });
    expect(renderMissionPanel(input({ objective: awaiting })).at(0)).toBe('✋ Mission O1 CSV and JSON export · awaiting approval · not started');
    expect(renderMissionPanel(input({ objective: awaiting })).at(-1)).toBe(
      'next: approve with /mission approve, or tell the orchestrator what to change',
    );

    const completed = objective({
      status: 'completed',
      completedAt: new Date(STARTED + 3_600_000 + 120_000).toISOString(),
      milestones: [milestone('MS1', 'Serializers', 'passed', 1), milestone('MS2', 'CLI options', 'passed', 2)],
    });
    const lines = renderMissionPanel(input({ objective: completed, agents: [] }));
    expect(lines[0]).toBe('✅ Mission O1 CSV and JSON export · completed · 1h 02m · $1.82 of $5.00');
    expect(lines[1]).toBe('✅ MS1 Serializers   ✅ MS2 CLI options');
    expect(lines.at(-1)).toBe('next: done — /mission starts a new mission');
    expect(lines).toHaveLength(5);
  });

  it('explains paused, blocked and validating missions in the next step', () => {
    expect(renderMissionPanel(input({ objective: objective({ status: 'paused', pausedReason: 'budget review' }) })).at(-1)).toBe(
      'next: paused (budget review) — /mission resume continues',
    );
    expect(renderMissionPanel(input({ objective: objective({ status: 'blocked', blockedReason: 'needs a key' }) })).at(-1)).toBe(
      'next: blocked (needs a key) — /mission resume, or a new goal with /mission <goal>',
    );
    const validating = objective({
      milestones: [milestone('MS1', 'Serializers', 'passed', 1), milestone('MS2', 'CLI options', 'validating', 2)],
    });
    expect(renderMissionPanel(input({ objective: validating })).at(-1)).toBe('next: validating MS2');
  });

  it('windows a long milestone strip around the current milestone', () => {
    const many = objective({
      milestones: Array.from({ length: 8 }, (_, index) =>
        milestone(`MS${String(index + 1)}`, `Step ${String(index + 1)}`, index < 4 ? 'passed' : index === 4 ? 'active' : 'pending', index + 1),
      ),
    });

    const strip = renderMissionPanel(input({ objective: many, missions: [] }))[1] ?? '';

    expect(strip.startsWith('… 3 earlier   ✅ MS4 Step 4   🔵 MS5 Step 5')).toBe(true);
    expect(strip.endsWith('⚪ MS8 Step 8')).toBe(true);
  });

  it('shows the last milestones of a long strip once every milestone passed', () => {
    const done = objective({
      status: 'completed',
      completedAt: new Date(STARTED + 600_000).toISOString(),
      milestones: Array.from({ length: 8 }, (_, index) =>
        milestone(`MS${String(index + 1)}`, `Step ${String(index + 1)}`, 'passed', index + 1),
      ),
    });

    const strip = renderMissionPanel(input({ objective: done, missions: [] }))[1];

    expect(strip).toBe('… 3 earlier   ✅ MS4 Step 4   ✅ MS5 Step 5   ✅ MS6 Step 6   ✅ MS7 Step 7   ✅ MS8 Step 8');
  });

  it('renders the TUI panel one row per line, cut to the terminal width', () => {
    const lines = renderMissionPanel(input());

    const narrow = missionPanelComponent(input()).render(30);
    const wide = missionPanelComponent(input()).render(400);

    expect(narrow.length).toBeLessThanOrEqual(MISSION_PANEL_MAX_LINES);
    for (const row of narrow) {
      expect(row.startsWith(' ')).toBe(true);
      expect(visibleWidth(row)).toBeLessThanOrEqual(29);
    }
    expect(wide).toEqual(lines.map((line) => ` ${line}`));
  });

  it('mirrors the panel in one footer status line', () => {
    expect(renderMissionStatus(input())).toBe('mission O1 executing · MS2 1/4 merged · 2 agents');
    expect(renderMissionStatus(input({ objective: objective({ status: 'completed' }), agents: [] }))).toBe(
      'mission O1 completed',
    );
  });
});

describe('the models line of the panel', () => {
  it('keeps every role of an explicit validator with long model ids by putting two roles per line', () => {
    const oneLine =
      'models: orchestrator claude-opus-5-5 · worker claude-sonnet-5-5 · reviewer claude-sonnet-5-5 · validator claude-sonnet-5-5';
    expect(oneLine.length).toBeGreaterThan(MISSION_PANEL_LINE_MAX_CHARS);

    const lines = renderMissionPanel(input({ models: GATEWAY_MODELS }));

    expect(modelsSection(lines)).toEqual([
      'models: orchestrator claude-opus-5-5 · worker claude-sonnet-5-5',
      '        reviewer claude-sonnet-5-5 · validator claude-sonnet-5-5',
    ]);
    expect(lines).toHaveLength(MISSION_PANEL_MAX_LINES);
    expect(lines.slice(2, 6)).toEqual([
      '🔵 M4 --format option — worker w-m4 running',
      '🟢 M5 README — in review · rev-m5',
      '🟡 M7 Shell completion — waits for M4',
      '✅ M6 tests — merged',
    ]);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(MISSION_PANEL_LINE_MAX_CHARS);
  });

  it('gives the features one line less, never more than ten lines in total', () => {
    const missions = Array.from({ length: 12 }, (_, index) => feature(`M${String(index + 10)}`, `Feature ${String(index)}`, 'active'));

    const lines = renderMissionPanel(input({ missions, models: GATEWAY_MODELS }));

    expect(lines).toHaveLength(MISSION_PANEL_MAX_LINES);
    expect(lines[5]).toBe('… 9 more features — /mission shows all');
    expect(modelsSection(lines)).toHaveLength(2);
    expect(lines.at(-1)).toBe('next: 12 features of MS2 in flight — validation starts once all are merged');
  });

  it('names the provider only where the same model id comes from two providers', () => {
    const mixed = configuredModels({
      orchestrator: 'anthropic/claude-opus-5-5',
      worker: 'anthropic/claude-sonnet-5-5',
      reviewer: 'byteplus-gateway/claude-sonnet-5-5',
    });

    expect(modelsSection(renderMissionPanel(input({ models: mixed })))).toEqual([
      'models: orchestrator claude-opus-5-5 · worker anthropic/claude-sonnet-5-5',
      '        reviewer byteplus-gateway/claude-sonnet-5-5 · validator = reviewer',
    ]);
  });

  it('lays the models out for the terminal width in the TUI and never drops a role', () => {
    const panel = missionPanelComponent(input({ models: GATEWAY_MODELS }));

    expect(modelsSection(panel.render(80))).toEqual([
      ' models: orchestrator claude-opus-5-5 · worker claude-sonnet-5-5',
      '         reviewer claude-sonnet-5-5 · validator claude-sonnet-5-5',
    ]);
    const rows = panel.render(60);
    expect(modelsSection(rows)).toEqual([
      ' models: orchestrator claude-opus-5-5',
      '         worker claude-sonnet-5-5',
      '         reviewer claude-sonnet-5-5',
      '         validator claude-sonnet-5-5',
    ]);
    expect(rows).toHaveLength(MISSION_PANEL_MAX_LINES);
    expect(rows).toContain(' … 3 more features — /mission shows all');
    expect(modelsSection(panel.render(30))).toEqual([
      ' models: orchestrator claude…',
      '         worker claude-sonne…',
      '         reviewer claude-son…',
      '         validator claude-so…',
    ]);

    for (const width of [24, 30, 40, 60, 66, 80, 100, 122, 200]) {
      const rendered = panel.render(width);
      expect(rendered.length, `width ${String(width)}`).toBeLessThanOrEqual(MISSION_PANEL_MAX_LINES);
      for (const row of rendered) expect(visibleWidth(row), `width ${String(width)}`).toBeLessThanOrEqual(width - 1);
      const section = modelsSection(rendered).join('\n');
      for (const role of TOWER_ROLES) expect(section, `width ${String(width)}`).toContain(` ${role} `);
    }
  });
});

describe('MissionRefresher', () => {
  function refresher(timers: ManualTimers, options: { readonly fail?: boolean } = {}) {
    const runs: number[] = [];
    const errors: unknown[] = [];
    let release: (() => void) | undefined;
    let hold = false;
    const instance = new MissionRefresher({
      refresh: async () => {
        runs.push(timers.now());
        if (options.fail === true) throw new Error('boom');
        if (hold) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      },
      timers,
      throttleMs: 1_000,
      tickMs: 5_000,
      onError: (error) => errors.push(error),
    });
    return {
      instance,
      runs,
      errors,
      hold: () => {
        hold = true;
      },
      release: () => {
        hold = false;
        release?.();
      },
    };
  }

  async function flush(): Promise<void> {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  }

  it('runs the first request at once and throttles the rest into one trailing refresh per second', async () => {
    const timers = new ManualTimers(0);
    const { instance, runs } = refresher(timers);
    instance.start();

    instance.request();
    await flush();
    for (let index = 0; index < 5; index += 1) instance.request();
    await flush();
    expect(runs).toEqual([0]);
    expect(timers.pendingTimeouts).toBe(1);

    timers.advance(999);
    await flush();
    expect(runs).toEqual([0]);
    timers.advance(1);
    await flush();
    expect(runs).toEqual([0, 1_000]);
  });

  it('refreshes again after an in-flight refresh when a change arrived meanwhile', async () => {
    const timers = new ManualTimers(0);
    const control = refresher(timers);
    control.instance.start();
    control.hold();
    control.instance.request();
    await flush();
    control.instance.request();
    control.instance.request();
    expect(control.runs).toEqual([0]);

    timers.advance(2_000);
    control.release();
    await flush();
    expect(control.runs).toEqual([0, 2_000]);
  });

  it('refreshes on the slow tick for the elapsed time, and stops cleanly', async () => {
    const timers = new ManualTimers(0);
    const { instance, runs } = refresher(timers);
    instance.start();
    expect(timers.activeIntervals).toBe(1);

    timers.advance(5_000);
    await flush();
    timers.advance(5_000);
    await flush();
    expect(runs).toEqual([5_000, 10_000]);

    instance.request();
    instance.stop();
    expect(timers.activeIntervals).toBe(0);
    expect(timers.pendingTimeouts).toBe(0);
    instance.request();
    timers.advance(20_000);
    await flush();
    expect(runs).toEqual([5_000, 10_000]);
    expect(instance.started).toBe(false);
  });

  it('reports a failing refresh and keeps refreshing', async () => {
    const timers = new ManualTimers(0);
    const { instance, runs, errors } = refresher(timers, { fail: true });
    instance.start();

    instance.request();
    await flush();
    timers.advance(1_000);
    instance.request();
    await flush();

    expect(runs).toEqual([0, 1_000]);
    expect(errors).toHaveLength(2);
  });
});
