import { join } from 'node:path';

import {
  WORKTREES_DIR,
  isOpenMission,
  type TowerMission,
  type TowerRosterEntry,
  type TowerStore,
} from '../../protocol/index.ts';

const EXCLUDED_LINE = /^kept (.+) \(excluded\)$/;

export interface AutopilotTeardownOutcome {
  /** The teardown report without the worktrees that were already gone; a kept open mission names its status. */
  readonly lines: readonly string[];
  readonly removed: number;
  readonly kept: number;
  readonly failed: number;
  /** The teardown itself failed; worktrees it had not reached yet are untouched. */
  readonly error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function failedTeardown(error: string): AutopilotTeardownOutcome {
  return { lines: [], removed: 0, kept: 0, failed: 0, error };
}

/**
 * The TowerTeardown of a completed objective, never forced: it removes the worktrees of merged and
 * abandoned missions and the validation worktrees, and keeps the worktrees of live agents, those with
 * uncommitted changes and those of missions still open. Branches and .tower/comms/ always stay.
 * Never rejects: a failure comes back as the outcome's error.
 */
export async function autoTeardown(
  store: TowerStore,
  isLive: (entry: TowerRosterEntry) => boolean,
): Promise<AutopilotTeardownOutcome> {
  try {
    const state = await store.load();
    const open = state.missions.filter(isOpenMission);
    const report = await store.teardown({
      exclude: open.map((mission) => mission.worktree),
      liveAgentIds: new Set(state.roster.agents.filter(isLive).map((entry) => entry.agentId)),
    });
    return summarize(report, open);
  } catch (error) {
    return failedTeardown(errorMessage(error));
  }
}

function summarize(report: readonly string[], open: readonly TowerMission[]): AutopilotTeardownOutcome {
  const openByPath = new Map(open.map((mission) => [join(WORKTREES_DIR, mission.worktree), mission]));
  const lines: string[] = [];
  let removed = 0;
  let kept = 0;
  let failed = 0;
  for (const line of report) {
    if (line.startsWith('already removed ')) continue;
    if (line.startsWith('removed ')) removed += 1;
    else if (line.startsWith('kept ')) kept += 1;
    else if (line.startsWith('failed to remove ')) failed += 1;
    const path = EXCLUDED_LINE.exec(line)?.[1];
    const mission = path === undefined ? undefined : openByPath.get(path);
    lines.push(path === undefined || mission === undefined ? line : `kept ${path} (mission ${mission.id} is still ${mission.status})`);
  }
  return { lines, removed, kept, failed };
}
