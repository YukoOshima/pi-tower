import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ExtensionSelectorComponent, initTheme } from '@earendil-works/pi-coding-agent';
import { isKittyProtocolActive, setKittyProtocolActive } from '@earendil-works/pi-tui';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { MISSION_APPROVAL_GRACE_MS, MISSION_APPROVAL_QUIET_MS } from '../../src/mission/constants.ts';
import {
  MISSION_APPROVE_OPTION,
  MISSION_APPROVE_REVISED_OPTION,
  MISSION_KEEP_PLANNING_OPTION,
} from '../../src/mission/texts.ts';
import { STATE_FILE, type TowerState } from '../../src/protocol/index.ts';
import { handleTowerCommand } from '../../src/tower/command.ts';
import { removeDir, settle } from '../tower/fakes.ts';
import { missionHarness, plannedObjective, recordingUi, type MissionHarness, type SelectCall } from './fakes.ts';

const DOWN = '\x1b[B';
const UP = '\x1b[A';
const ENTER = '\r';
const LF = '\n';
const ESC = '\x1b';

const SELECTOR_KEYS: readonly (readonly [string, string])[] = [
  ['↓', DOWN],
  ['↓ (SS3)', '\x1bOB'],
  ['↓ (CSI 1;1)', '\x1b[1;1B'],
  ['↑', UP],
  ['↑ (SS3)', '\x1bOA'],
  ['Enter', ENTER],
  ['LF', LF],
  ['Enter (Kitty)', '\x1b[13u'],
  ['keypad Enter', '\x1bOM'],
];

const cleanups: string[] = [];

beforeAll(() => {
  initTheme();
});

afterEach(async () => {
  for (const dir of cleanups.splice(0)) await removeDir(dir);
});

async function readState(repo: string): Promise<TowerState> {
  return JSON.parse(await readFile(join(repo, STATE_FILE), 'utf8')) as TowerState;
}

function requestApproval(h: MissionHarness): void {
  h.mission.onToolResult({ toolName: 'TowerObjective', input: { action: 'request-approval' }, isError: false });
  h.controller.noteTowerToolResult('TowerObjective', false);
}

async function awaitingMission(h: MissionHarness): Promise<SelectCall> {
  await h.run('');
  await h.input('Add a --format csv|json option to shop report');
  await plannedObjective(h.store);
  await h.store.requestObjectiveApproval();
  requestApproval(h);
  return openDialog(h, 0);
}

async function openDialog(h: MissionHarness, before: number): Promise<SelectCall> {
  await vi.waitFor(() => {
    expect(h.ctx.selects.length).toBeGreaterThan(before);
    expect(h.mission.approvalOpen).toBe(true);
  });
  const dialog = h.ctx.selects.at(-1)!;
  expect(dialog.options[0]).toBe(MISSION_KEEP_PLANNING_OPTION);
  return dialog;
}

async function reopen(h: MissionHarness): Promise<SelectCall> {
  const before = h.ctx.selects.length;
  h.ctx.editorText = '';
  h.timers.advance(MISSION_APPROVAL_QUIET_MS + 1);
  await h.store.requestObjectiveApproval();
  requestApproval(h);
  return openDialog(h, before);
}

function promptHandlers(h: MissionHarness): number[] {
  return [h.pi.handlerCount('ui_prompt_start'), h.pi.handlerCount('ui_prompt_end')];
}

function realSelector(h: MissionHarness): void {
  h.ctx.selectorFactory = (title, options, done) =>
    new ExtensionSelectorComponent(title, [...options], (option) => done(option), () => done(undefined));
}

async function expectAwaitingApproval(h: MissionHarness, label?: string): Promise<void> {
  await settle(10);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const objective = (await readState(h.repo)).objective;
  expect(objective?.status, label).toBe('awaiting-approval');
  expect(objective?.approvedBy, label).toBeUndefined();
  expect(h.hooks.ticks, label).toEqual([]);
}

describe('approval dialog keyboard guard (TUI)', () => {
  it('moves a typed j into the editor, closes the dialog through its signal and leaves the plan awaiting approval', async () => {
    const h = await missionHarness(cleanups);
    const received: string[] = [];
    h.ctx.selectorFactory = () => ({ handleInput: (data) => received.push(data) });
    const dialog = await awaitingMission(h);
    expect(h.ctx.terminalListeners.size).toBe(2);

    h.ctx.type('j');

    expect(received).toEqual([]);
    expect(dialog.signal?.aborted).toBe(true);
    expect(h.mission.approvalOpen).toBe(false);
    expect(h.ctx.editorText).toBe('j');
    expect(h.ctx.terminalListeners.size).toBe(1);
    await expectAwaitingApproval(h);
    expect(h.ctx.ui.notices.filter((notice) => notice.message.includes('still awaits your approval'))).toEqual([]);

    h.ctx.typeEach('ust a question');
    expect(h.ctx.editorText).toBe('just a question');
  });

  it('keeps every character of input-method text and of a paste', async () => {
    const h = await missionHarness(cleanups);
    h.ctx.selectorFactory = () => ({ handleInput: () => undefined });
    await awaitingMission(h);

    h.ctx.typeEach('请把M3拆成两个功能');

    expect(h.ctx.editorText).toBe('请把M3拆成两个功能');
    expect(h.mission.approvalOpen).toBe(false);

    await reopen(h);
    h.ctx.type('\x1b[200~please split M3\x1b[201~');
    expect(h.ctx.editorText).toBe('please split M3');
    expect(h.mission.approvalOpen).toBe(false);
    await expectAwaitingApproval(h);
  });

  it('lets arrows, Enter and Esc through to the dialog once the grace period is over', async () => {
    const h = await missionHarness(cleanups);
    const received: string[] = [];
    h.ctx.selectorFactory = () => ({ handleInput: (data) => received.push(data) });
    await awaitingMission(h);
    h.timers.advance(MISSION_APPROVAL_GRACE_MS);

    for (const key of [DOWN, UP, '\x1b[1;1B', ENTER, ESC]) h.ctx.type(key);

    expect(received).toEqual([DOWN, UP, '\x1b[1;1B', ENTER, ESC]);
    expect(h.mission.approvalOpen).toBe(true);
    expect(h.ctx.editorText).toBe('');
  });

  it('swallows every key that moves or confirms the selection during the first 500 ms after the dialog opens', async () => {
    const h = await missionHarness(cleanups);
    const received: string[] = [];
    h.ctx.selectorFactory = () => ({ handleInput: (data) => received.push(data) });
    const dialog = await awaitingMission(h);

    for (const [, key] of SELECTOR_KEYS) h.ctx.type(key);
    h.timers.advance(MISSION_APPROVAL_GRACE_MS - 1);
    for (const [, key] of SELECTOR_KEYS) h.ctx.type(key);

    expect(received).toEqual([]);
    expect(h.mission.approvalOpen).toBe(true);
    expect(dialog.signal?.aborted).toBe(false);
    expect(h.ctx.editorText).toBe('');
    expect(h.ctx.submitted).toEqual([]);
    expect(h.ctx.terminalListeners.size).toBe(2);

    h.timers.advance(1);
    for (const [, key] of SELECTOR_KEYS) h.ctx.type(key);
    expect(received).toEqual(SELECTOR_KEYS.map(([, key]) => key));
  });

  it('keeps typed text, j and k included, on the editor path and lets Esc through during the grace period', async () => {
    const h = await missionHarness(cleanups);
    const received: string[] = [];
    h.ctx.selectorFactory = () => ({ handleInput: (data) => received.push(data) });
    const dialog = await awaitingMission(h);

    h.ctx.type(ESC);
    expect(received).toEqual([ESC]);

    h.ctx.type('k');
    expect(dialog.signal?.aborted).toBe(true);
    expect(h.mission.approvalOpen).toBe(false);
    expect(h.ctx.editorText).toBe('k');
    expect(received).toEqual([ESC]);
    await expectAwaitingApproval(h);
  });

  it('offers the plan again once the typed feedback has left the editor and the keyboard is quiet', async () => {
    const h = await missionHarness(cleanups);
    h.ctx.selectorFactory = () => ({ handleInput: () => undefined });
    await awaitingMission(h);
    h.ctx.typeEach('why three milestones?');
    h.ctx.type(ENTER);
    expect(h.ctx.submitted).toEqual(['why three milestones?']);

    h.mission.refreshSoon();
    await settle(10);
    expect(h.ctx.selects).toHaveLength(1);

    h.timers.advance(5_000);
    await openDialog(h, 1);
  });

  it('waits for two quiet seconds after the last keystroke, then the tick offers the plan', async () => {
    const h = await missionHarness(cleanups);
    await h.run('');
    await h.input('Add a --format csv|json option to shop report');
    await plannedObjective(h.store);
    h.controller.noteStateChange('drafted');
    await settle(10);

    h.ctx.type(DOWN);
    await h.store.requestObjectiveApproval();
    requestApproval(h);
    await vi.waitFor(() => {
      expect(h.ctx.widget()?.[0]).toContain('awaiting approval');
    });
    await settle(10);
    expect(h.ctx.selects).toEqual([]);

    h.timers.advance(MISSION_APPROVAL_QUIET_MS - 500);
    h.mission.refreshSoon();
    await settle(10);
    expect(h.ctx.selects).toEqual([]);

    h.timers.advance(5_000);
    await openDialog(h, 0);
  });

  it('removes its listeners when the dialog closes, on /mission exit and on shutdown, and adds none without the TUI', async () => {
    const h = await missionHarness(cleanups);
    const dialog = await awaitingMission(h);
    expect(h.ctx.terminalListeners.size).toBe(2);
    expect(promptHandlers(h)).toEqual([1, 1]);
    dialog.answer(MISSION_KEEP_PLANNING_OPTION);
    await vi.waitFor(() => {
      expect(h.ctx.terminalListeners.size).toBe(1);
    });
    await reopen(h);
    expect(h.ctx.terminalListeners.size).toBe(2);
    expect(promptHandlers(h)).toEqual([1, 1]);

    await h.run('exit');
    expect(h.ctx.terminalListeners.size).toBe(0);
    expect(promptHandlers(h)).toEqual([0, 0]);
    await h.run('');
    await h.run('');
    expect(promptHandlers(h)).toEqual([1, 1]);
    const { ui } = recordingUi();
    await handleTowerCommand(h.controller, 'off', h.ctx.asCommandContext, { sendUserMessage: () => undefined }, ui);
    expect(promptHandlers(h)).toEqual([0, 0]);

    const shutdown = await missionHarness(cleanups);
    const open = await awaitingMission(shutdown);
    shutdown.mission.onSessionShutdown();
    expect(shutdown.ctx.terminalListeners.size).toBe(0);
    expect(promptHandlers(shutdown)).toEqual([0, 0]);
    expect(open.signal?.aborted).toBe(true);

    const rpc = await missionHarness(cleanups);
    rpc.ctx.mode = 'rpc';
    await awaitingMission(rpc);
    expect(rpc.ctx.terminalListeners.size).toBe(0);
    expect(promptHandlers(rpc)).toEqual([0, 0]);
  });
});

describe("the reviewer's key table against pi's ExtensionSelectorComponent", () => {
  const TYPED_LINES: readonly (readonly [string, readonly string[]])[] = [
    ['Enter alone', [ENTER]],
    ['ok⏎', [...'ok', ENTER]],
    ['please keep M3⏎', [...'please keep M3', ENTER]],
    ['Esc', [ESC]],
    ['CJK text from an input method', [...'请调整一下计划', ENTER]],
    ['please adjust the plan⏎', [...'please adjust the plan', ENTER]],
    ['just ship it⏎', [...'just ship it', ENTER]],
    ['jjj⏎', [...'jjj', ENTER]],
  ];

  const SUBMITTED = ['ok', 'please keep M3', '请调整一下计划', 'please adjust the plan', 'just ship it', 'jjj'];

  async function expectApproved(h: MissionHarness): Promise<void> {
    await vi.waitFor(() => {
      expect(h.hooks.ticks).toEqual(['approve']);
    });
    expect((await readState(h.repo)).objective).toMatchObject({ status: 'executing', approvedBy: 'human' });
  }

  async function runTable(h: MissionHarness, approveOption: string): Promise<void> {
    for (const [name, keys] of TYPED_LINES) {
      const dialog = await reopen(h);
      h.timers.advance(MISSION_APPROVAL_GRACE_MS);
      expect(dialog.options, name).toEqual([MISSION_KEEP_PLANNING_OPTION, approveOption]);
      for (const key of keys) h.ctx.type(key);
      await expectAwaitingApproval(h, name);
      expect(h.mission.approvalOpen, name).toBe(false);
    }

    await reopen(h);
    h.timers.advance(MISSION_APPROVAL_GRACE_MS);
    h.ctx.type(DOWN);
    h.ctx.type(ENTER);
    await expectApproved(h);
  }

  it('no typed line approves a fresh plan; only a deliberate ↓ then Enter does', async () => {
    const h = await missionHarness(cleanups, { tickMs: 3_600_000 });
    realSelector(h);
    await awaitingMission(h);
    h.ctx.selects.at(-1)?.answer(undefined);

    await runTable(h, MISSION_APPROVE_OPTION);

    expect(h.ctx.submitted).toEqual(SUBMITTED);
  });

  it('a ↓⏎ inside the grace period cannot approve and leaves the dialog open; ↓⏎ after it approves', async () => {
    const h = await missionHarness(cleanups, { tickMs: 3_600_000 });
    realSelector(h);
    await awaitingMission(h);

    h.ctx.type(DOWN);
    h.ctx.type(ENTER);
    h.timers.advance(MISSION_APPROVAL_GRACE_MS - 1);
    h.ctx.type(DOWN);
    h.ctx.type(LF);
    await expectAwaitingApproval(h);
    expect(h.mission.approvalOpen).toBe(true);
    expect(h.ctx.dialogFocused).toBe(true);

    h.timers.advance(1);
    h.ctx.type(DOWN);
    h.ctx.type(ENTER);
    await expectApproved(h);
    expect(h.mission.approvalOpen).toBe(false);
  });

  it('swallows a bare LF in the grace period also under the Kitty keyboard protocol, where only the selector treats it as Enter', async () => {
    const kitty = isKittyProtocolActive();
    setKittyProtocolActive(true);
    try {
      const h = await missionHarness(cleanups, { tickMs: 3_600_000 });
      realSelector(h);
      await awaitingMission(h);

      h.ctx.type(DOWN);
      h.ctx.type(LF);
      await expectAwaitingApproval(h);
      expect(h.mission.approvalOpen).toBe(true);

      h.timers.advance(MISSION_APPROVAL_GRACE_MS);
      h.ctx.type(DOWN);
      h.ctx.type(LF);
      await expectApproved(h);
    } finally {
      setKittyProtocolActive(kitty);
    }
  });

  it('a ↓ swallowed in the grace period does not move the selection, so Enter afterwards keeps planning', async () => {
    const h = await missionHarness(cleanups, { tickMs: 3_600_000 });
    realSelector(h);
    await awaitingMission(h);

    h.ctx.type(DOWN);
    h.timers.advance(MISSION_APPROVAL_GRACE_MS);
    h.ctx.type(ENTER);

    await vi.waitFor(() => {
      expect(h.ctx.ui.notices.at(-1)?.message).toContain('Mission O1 still awaits your approval');
    });
    expect(h.mission.approvalOpen).toBe(false);
    await expectAwaitingApproval(h);
  });

  it('inside the grace period every typed line still reaches the editor, and nothing approves', async () => {
    const h = await missionHarness(cleanups, { tickMs: 3_600_000 });
    realSelector(h);
    await awaitingMission(h);
    h.ctx.selects.at(-1)?.answer(undefined);

    for (const [name, keys] of TYPED_LINES) {
      await reopen(h);
      for (const key of keys) h.ctx.type(key);
      await expectAwaitingApproval(h, name);
      expect(h.mission.approvalOpen, name).toBe(name === 'Enter alone');
    }

    expect(h.ctx.submitted).toEqual(SUBMITTED);
  });

  it('no typed line approves a revised plan; only a deliberate ↓ then Enter does', async () => {
    const h = await missionHarness(cleanups, { tickMs: 3_600_000 });
    realSelector(h);
    await awaitingMission(h);
    h.ctx.selects.at(-1)?.answer(undefined);
    await h.store.approveObjective('human');
    await h.store.updateObjective({ definitionOfDone: ['both formats work', 'the README documents --format'] });
    h.hooks.ticks.length = 0;

    await runTable(h, MISSION_APPROVE_REVISED_OPTION);
  });
});
