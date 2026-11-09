import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MISSION_HANDED_TITLE, missionHandedBody } from '../../src/mission/texts.ts';
import { buildObjectivePlanningPrompt } from '../../src/prompts/objectivePlanning.ts';
import { STATE_FILE, type TowerState } from '../../src/protocol/index.ts';
import { handleTowerCommand } from '../../src/tower/command.ts';
import { removeDir } from '../tower/fakes.ts';
import { awaitingApproval, missionHarness, plannedObjective, recordingUi } from './fakes.ts';

const cleanups: string[] = [];

afterEach(async () => {
  for (const dir of cleanups.splice(0)) await removeDir(dir);
});

async function readState(repo: string): Promise<TowerState> {
  return JSON.parse(await readFile(join(repo, STATE_FILE), 'utf8')) as TowerState;
}

const GOAL = 'Add a --format csv|json option to shop report   (keep the default output)';

describe('mission intake', () => {
  it('captures exactly the next plain message as the goal, with the effect of /tower objective in interactive mode', async () => {
    const h = await missionHarness(cleanups);
    await h.run('');
    expect(h.mission.intakeArmed).toBe(true);

    const captured = await h.input(GOAL);

    expect(captured).toEqual({ action: 'handled' });
    expect(h.pi.userMessages).toEqual([{ text: buildObjectivePlanningPrompt({ mode: 'interactive', text: GOAL }) }]);
    expect((await readState(h.repo)).objectiveMode).toBe('interactive');
    expect(h.ctx.ui.notices).toContainEqual({
      message: `${MISSION_HANDED_TITLE}\n${missionHandedBody(undefined)}`,
      level: 'info',
    });
    expect(h.mission.intakeArmed).toBe(false);

    expect(await h.input('Done means both formats work.')).toEqual({ action: 'continue' });
    expect(h.pi.userMessages).toHaveLength(1);
  });

  it('never captures slash commands, extension messages or empty input, and stays armed', async () => {
    const h = await missionHarness(cleanups);
    await h.run('');

    for (const text of ['/skill:review', '/my-template some args', '  /unknown', '   ']) {
      expect(await h.input(text), text).toEqual({ action: 'continue' });
    }
    expect(await h.input('a goal from another extension', { source: 'extension' })).toEqual({ action: 'continue' });
    expect(h.mission.intakeArmed).toBe(true);
    expect(h.pi.userMessages).toEqual([]);

    expect(await h.input('Ship the CSV export', { source: 'rpc' })).toEqual({ action: 'handled' });
    expect(h.pi.userMessages).toHaveLength(1);
  });

  it('queues the planning prompt behind a busy orchestrator and keeps attached images', async () => {
    const h = await missionHarness(cleanups);
    await h.run('');
    h.ctx.idle = false;
    const image = { type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' };

    await h.input('Make the report page look like this', { images: [image], streamingBehavior: 'steer' });

    expect(h.pi.userMessages).toEqual([
      {
        text: [
          { type: 'text', text: buildObjectivePlanningPrompt({ mode: 'interactive', text: 'Make the report page look like this' }) },
          image,
        ],
        options: { deliverAs: 'followUp' },
      },
    ]);
  });

  it('reads a lone @file reference as the goal file, and keeps any other @ text as the goal', async () => {
    const h = await missionHarness(cleanups);
    await writeFile(join(h.repo, 'goal.md'), 'Ship the CSV export.\n');
    await h.run('');

    await h.input('@goal.md');

    expect(h.pi.userMessages).toEqual([
      {
        text: buildObjectivePlanningPrompt({ mode: 'interactive', text: 'Ship the CSV export.\n', file: join(h.repo, 'goal.md') }),
      },
    ]);

    await h.run('exit');
    await h.run('');
    await h.input('@team please add a CSV export');
    expect(h.pi.userMessages[1]).toEqual({
      text: buildObjectivePlanningPrompt({ mode: 'interactive', text: '@team please add a CSV export' }),
    });
  });

  it('disarms on /mission exit and on /tower off', async () => {
    const h = await missionHarness(cleanups);
    await h.run('');
    await h.run('exit');
    expect(h.mission.intakeArmed).toBe(false);
    expect(await h.input(GOAL)).toEqual({ action: 'continue' });

    await h.run('');
    expect(h.mission.intakeArmed).toBe(true);
    const { ui } = recordingUi();
    await handleTowerCommand(h.controller, 'off', h.ctx.asCommandContext, { sendUserMessage: () => undefined }, ui);
    expect(h.mission.intakeArmed).toBe(false);
    expect(h.mission.active).toBe(false);
    expect(await h.input(GOAL)).toEqual({ action: 'continue' });
    expect(h.pi.userMessages).toEqual([]);
  });

  it('disarms when the goal is handed over with /tower objective instead', async () => {
    const h = await missionHarness(cleanups);
    await h.run('');

    h.mission.onTowerCommand('objective status');
    expect(h.mission.intakeArmed).toBe(true);
    h.mission.onTowerCommand('objective Ship the CSV export');
    expect(h.mission.intakeArmed).toBe(false);
  });

  it('reports a refused handover and swallows the message', async () => {
    const h = await missionHarness(cleanups);
    await h.run('');
    await awaitingApproval(h.store);

    expect(await h.input(GOAL)).toEqual({ action: 'handled' });

    expect(h.pi.userMessages).toEqual([]);
    expect(h.ctx.ui.notices.at(-1)).toEqual({
      message:
        'Mission O1 "CSV and JSON export" is awaiting-approval — a new mission starts only when none is open or the open one is still planning; approve its plan with /mission approve, or tell the orchestrator what to change.',
      level: 'error',
    });
  });

  it('does not re-arm while the orchestrator is still planning the handed goal, so answers reach it', async () => {
    const h = await missionHarness(cleanups);
    await h.run('');
    await h.input(GOAL);

    const shown = await h.run('');

    expect(shown.notices[0]?.title).toBe('Mission mode');
    expect(shown.notices[0]?.body).toContain(
      'The orchestrator is planning your goal: "Add a --format csv|json option to shop report (keep the default output)".',
    );
    expect(h.mission.intakeArmed).toBe(false);
    expect(await h.input('Out of scope: XML.')).toEqual({ action: 'continue' });

    await plannedObjective(h.store);
    expect((await h.run('')).notices[0]?.title).toBe('Mission Control');
  });
});
