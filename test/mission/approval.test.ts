import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MISSION_APPROVE_OPTION,
  MISSION_APPROVE_REVISED_OPTION,
  MISSION_KEEP_PLANNING_OPTION,
} from '../../src/mission/texts.ts';
import { STATE_FILE, type TowerState } from '../../src/protocol/index.ts';
import { handleTowerCommand } from '../../src/tower/command.ts';
import { removeDir, settle } from '../tower/fakes.ts';
import {
  awaitingApproval,
  missionHarness,
  plannedObjective,
  recordingUi,
  type MissionHarness,
  type MissionHarnessOptions,
} from './fakes.ts';

const cleanups: string[] = [];
const harnesses: MissionHarness[] = [];

async function harness(options: MissionHarnessOptions = {}): Promise<MissionHarness> {
  const created = await missionHarness(cleanups, options);
  harnesses.push(created);
  return created;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    for (const select of h.ctx.selects) {
      expect(select.options[0], select.title).toBe(MISSION_KEEP_PLANNING_OPTION);
      expect([MISSION_APPROVE_OPTION, MISSION_APPROVE_REVISED_OPTION]).not.toContain(select.options[0]);
    }
  }
  for (const dir of cleanups.splice(0)) await removeDir(dir);
});

async function readState(repo: string): Promise<TowerState> {
  return JSON.parse(await readFile(join(repo, STATE_FILE), 'utf8')) as TowerState;
}

async function planningMission(h: MissionHarness): Promise<void> {
  await h.run('');
  await h.input('Add a --format csv|json option to shop report');
  await plannedObjective(h.store);
  h.controller.noteStateChange('drafted');
  await vi.waitFor(() => {
    expect(h.ctx.widget()?.[0]).toContain('planning');
  });
}

async function requestApproval(h: MissionHarness): Promise<void> {
  await h.store.requestObjectiveApproval();
  h.mission.onToolResult({ toolName: 'TowerObjective', input: { action: 'request-approval' }, isError: false });
  h.controller.noteTowerToolResult('TowerObjective', false);
}

describe('mission approval dialog', () => {
  it('offers to approve once the plan awaits approval, and approving does what /mission approve does', async () => {
    const h = await harness();
    await planningMission(h);

    await requestApproval(h);

    await vi.waitFor(() => {
      expect(h.ctx.selects).toHaveLength(1);
    });
    const dialog = h.ctx.selects[0]!;
    expect(dialog.title).toBe('Mission O1 "CSV and JSON export" — plan ready (2 milestones · 2 features). Approve it?');
    expect(dialog.options).toEqual([MISSION_KEEP_PLANNING_OPTION, MISSION_APPROVE_OPTION]);
    expect(dialog.signal?.aborted).toBe(false);
    expect(h.mission.approvalOpen).toBe(true);

    dialog.answer(MISSION_APPROVE_OPTION);

    await vi.waitFor(async () => {
      expect((await readState(h.repo)).objective).toMatchObject({ status: 'executing', approvedBy: 'human' });
    });
    await settle();
    expect(h.hooks.ticks).toEqual(['approve']);
    expect(h.ctx.ui.notices.map((notice) => notice.message.split('\n')[0])).toContain('Mission O1 approved — executing');
    expect(h.mission.approvalOpen).toBe(false);
  });

  it('keeps planning on "Keep planning" or a dismissal and tells the human what to do next', async () => {
    const h = await harness();
    await planningMission(h);
    await requestApproval(h);
    await vi.waitFor(() => {
      expect(h.ctx.selects).toHaveLength(1);
    });

    h.ctx.selects[0]!.answer(MISSION_KEEP_PLANNING_OPTION);

    const advice = {
      message:
        'Mission O1 still awaits your approval — tell the orchestrator what to change in plain language, or run /mission approve when the plan looks right.',
      level: 'info',
    };
    await vi.waitFor(() => {
      expect(h.ctx.ui.notices.at(-1)).toEqual(advice);
    });
    expect((await readState(h.repo)).objective?.status).toBe('awaiting-approval');

    await requestApproval(h);
    await vi.waitFor(() => {
      expect(h.ctx.selects).toHaveLength(2);
    });
    h.ctx.selects[1]!.answer(undefined);
    await vi.waitFor(() => {
      expect(h.ctx.ui.notices.filter((notice) => notice.message === advice.message)).toHaveLength(2);
    });
    expect((await readState(h.repo)).objective?.status).toBe('awaiting-approval');
    expect(h.hooks.ticks).toEqual([]);
  });

  it('dismisses the dialog through its signal when the objective leaves awaiting-approval another way', async () => {
    const h = await harness();
    await planningMission(h);
    await requestApproval(h);
    await vi.waitFor(() => {
      expect(h.ctx.selects).toHaveLength(1);
    });
    const notices = h.ctx.ui.notices.length;

    const { ui, recorded } = recordingUi();
    await handleTowerCommand(h.controller, 'approve', h.ctx.asCommandContext, { sendUserMessage: () => undefined }, ui);
    h.mission.onTowerCommand('approve');

    expect(recorded.notices[0]?.title).toMatch(/O1 approved — executing$/);
    await vi.waitFor(() => {
      expect(h.ctx.selects[0]?.signal?.aborted).toBe(true);
    });
    await settle();
    expect(h.mission.approvalOpen).toBe(false);
    expect(h.ctx.ui.notices.slice(notices).filter((notice) => notice.message.includes('still awaits your approval'))).toEqual([]);
  });

  it('closes the dialog when mission mode is left', async () => {
    const h = await harness();
    await planningMission(h);
    await requestApproval(h);
    await vi.waitFor(() => {
      expect(h.ctx.selects).toHaveLength(1);
    });

    await h.run('exit');

    expect(h.ctx.selects[0]?.signal?.aborted).toBe(true);
    expect(h.mission.approvalOpen).toBe(false);
  });

  it('waits until the orchestrator has finished presenting the plan', async () => {
    const h = await harness();
    await planningMission(h);
    h.ctx.idle = false;

    await requestApproval(h);
    await settle(10);
    expect(h.ctx.selects).toEqual([]);

    h.ctx.idle = true;
    h.mission.refreshSoon();
    await vi.waitFor(() => {
      expect(h.ctx.selects).toHaveLength(1);
    });
  });

  it('replaces an open dialog when the orchestrator requests approval for a revised plan', async () => {
    const h = await harness();
    await planningMission(h);
    await requestApproval(h);
    await vi.waitFor(() => {
      expect(h.ctx.selects).toHaveLength(1);
    });

    await h.store.plan([{ title: 'Docs', scope: ['docs/**'], milestone: 'MS1' }]);
    await requestApproval(h);

    await vi.waitFor(() => {
      expect(h.ctx.selects).toHaveLength(2);
    });
    expect(h.ctx.selects[0]?.signal?.aborted).toBe(true);
    expect(h.ctx.selects[1]?.title).toBe('Mission O1 "CSV and JSON export" — plan ready (2 milestones · 3 features). Approve it?');
  });

  it('puts the non-approving choice first, so Enter on a fresh dialog leaves the plan awaiting approval', async () => {
    const h = await harness();
    await planningMission(h);
    await requestApproval(h);
    await vi.waitFor(() => {
      expect(h.ctx.selects).toHaveLength(1);
    });
    const dialog = h.ctx.selects[0]!;
    expect(dialog.options[0]).toBe(MISSION_KEEP_PLANNING_OPTION);

    dialog.answer(dialog.options[0]);

    await vi.waitFor(() => {
      expect(h.ctx.ui.notices.at(-1)?.message).toContain('Mission O1 still awaits your approval');
    });
    await settle();
    expect((await readState(h.repo)).objective).toMatchObject({ status: 'awaiting-approval' });
    expect((await readState(h.repo)).objective?.approvedBy).toBeUndefined();
    expect(h.hooks.ticks).toEqual([]);
  });

  it('waits while the editor holds text and offers on the next refresh once it is cleared', async () => {
    const h = await harness();
    await planningMission(h);
    h.ctx.editorText = 'please split M3 into two features';

    await requestApproval(h);
    await vi.waitFor(() => {
      expect(h.ctx.widget()?.[0]).toContain('awaiting approval');
    });
    await settle(10);
    h.mission.refreshSoon();
    await settle(10);
    expect(h.ctx.selects).toEqual([]);

    h.ctx.editorText = '   ';
    h.timers.advance(5_000);
    await vi.waitFor(() => {
      expect(h.ctx.selects).toHaveLength(1);
    });
    expect(h.ctx.selects[0]?.options).toEqual([MISSION_KEEP_PLANNING_OPTION, MISSION_APPROVE_OPTION]);
  });

  it('asks to approve the revised plan after a contract change', async () => {
    const h = await harness();
    await planningMission(h);
    await h.store.requestObjectiveApproval();
    await h.store.approveObjective('human');
    h.controller.noteStateChange('approved');
    await vi.waitFor(() => {
      expect(h.ctx.widget()?.[0]).toContain('executing');
    });

    await h.store.updateObjective({ definitionOfDone: ['both formats work', 'the README documents --format'] });
    h.controller.noteTowerToolResult('TowerObjective', false);

    await vi.waitFor(() => {
      expect(h.ctx.selects).toHaveLength(1);
    });
    const dialog = h.ctx.selects[0]!;
    expect(dialog.title).toBe(
      'Mission O1 "CSV and JSON export" — plan revised (2 milestones · 2 features). Approve the revised plan?',
    );
    expect(dialog.options).toEqual([MISSION_KEEP_PLANNING_OPTION, MISSION_APPROVE_REVISED_OPTION]);

    dialog.answer(MISSION_APPROVE_REVISED_OPTION);
    await vi.waitFor(async () => {
      expect((await readState(h.repo)).objective).toMatchObject({ status: 'executing', approvedBy: 'human' });
    });
  });

  it('is not offered for an approval that was already pending when mission mode started, until it is requested again', async () => {
    const h = await harness();
    await awaitingApproval(h.store);

    await h.run('');
    await vi.waitFor(() => {
      expect(h.ctx.widget()?.[0]).toContain('awaiting approval');
    });
    await settle(10);
    expect(h.ctx.selects).toEqual([]);

    await requestApproval(h);
    await vi.waitFor(() => {
      expect(h.ctx.selects).toHaveLength(1);
    });
  });

  it('is never shown for a headless objective, with autoApprove, or without a UI', async () => {
    const headless = await harness();
    await headless.store.init('session-mission', 'main');
    await headless.store.setObjectiveMode('headless');
    await headless.run('');
    await plannedObjective(headless.store);
    headless.controller.noteStateChange('drafted');
    await vi.waitFor(() => {
      expect(headless.ctx.widget()?.[0]).toContain('planning');
    });
    await requestApproval(headless);
    await vi.waitFor(() => {
      expect(headless.ctx.widget()?.[0]).toContain('awaiting approval');
    });
    await settle(10);
    expect(headless.ctx.selects).toEqual([]);

    const auto = await harness();
    auto.hooks.settings = { ...auto.hooks.settings, autoApprove: true };
    await planningMission(auto);
    await requestApproval(auto);
    await vi.waitFor(() => {
      expect(auto.ctx.widget()?.[0]).toContain('awaiting approval');
    });
    await settle(10);
    expect(auto.ctx.selects).toEqual([]);

    const blind = await harness();
    blind.ctx.hasUI = false;
    await blind.run('');
    await blind.input('Add a CSV export');
    await plannedObjective(blind.store);
    await requestApproval(blind);
    await settle(10);
    expect(blind.ctx.selects).toEqual([]);
    expect(blind.ctx.widgetCalls).toEqual([]);
    expect(blind.timers.activeIntervals).toBe(0);
    expect(blind.mission.refreshing).toBe(false);
  });

  it('never blocks a command or a refresh while the dialog waits for an answer', async () => {
    const h = await harness();
    await planningMission(h);
    await requestApproval(h);
    await vi.waitFor(() => {
      expect(h.ctx.selects).toHaveLength(1);
    });

    const agents = await h.run('agents');
    h.controller.noteStateChange('later');
    await settle(10);

    expect(agents.notices[0]?.title).toBe('Mission agents');
    expect(h.ctx.selects).toHaveLength(1);
    expect(h.mission.approvalOpen).toBe(true);
  });

  it('reports a failing dialog without a notice', async () => {
    const h = await harness();
    await planningMission(h);
    h.ctx.selectFailure = new Error('dialog unavailable');
    const notices = h.ctx.ui.notices.length;

    await requestApproval(h);
    await settle(10);

    expect(h.mission.approvalOpen).toBe(false);
    expect(h.ctx.ui.notices.slice(notices)).toEqual([]);
    expect((await readState(h.repo)).objective?.status).toBe('awaiting-approval');
  });
});
