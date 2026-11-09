import { join } from 'node:path';

import {
  WORKTREES_DIR,
  isOpenMission,
  type TowerMission,
  type TowerRosterEntry,
  type TowerStore,
} from '../../protocol/index.ts';

const EXCLUDED_LINE = /^kept (.+) \(excluded\)$/;
const LIVE_AGENT_LINE = /^kept (.+) \(live agent: (.+)\)$/;

export interface AutopilotTeardownOutcome {
  /**
   * The teardown report without the worktrees that were already gone; a kept open mission names its
   * status, and a kept validation worktree names the validator still finishing in it.
   */
  readonly lines: readonly string[];
  readonly removed: number;
  readonly kept: number;
  /** Kept worktrees of validators still finishing: the tower removes each one when its validator ends. */
  readonly finishing: number;
  readonly failed: number;
  /** The teardown itself failed; worktrees it had not reached yet are untouched. */
  readonly error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function failedTeardown(error: string): AutopilotTeardownOutcome {
  return { lines: [], removed: 0, kept: 0, finishing: 0, failed: 0, error };
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
    const validators = new Set(state.roster.agents.filter((entry) => entry.kind === 'validator').map((entry) => entry.name));
    return summarize(report, open, validators);
  } catch (error) {
    return failedTeardown(errorMessage(error));
  }
}

function summarize(
  report: readonly string[],
  open: readonly TowerMission[],
  validators: ReadonlySet<string>,
): AutopilotTeardownOutcome {
  const openByPath = new Map(open.map((mission) => [join(WORKTREES_DIR, mission.worktree), mission]));
  const lines: string[] = [];
  let removed = 0;
  let kept = 0;
  let finishing = 0;
  let failed = 0;
  for (const line of report) {
    if (line.startsWith('already removed ')) continue;
    if (line.startsWith('removed ')) removed += 1;
    else if (line.startsWith('kept ')) kept += 1;
    else if (line.startsWith('failed to remove ')) failed += 1;
    const transient = finishingValidator(line, validators);
    if (transient !== undefined) finishing += 1;
    lines.push(transient ?? openMission(line, openByPath) ?? line);
  }
  return { lines, removed, kept, finishing, failed };
}

function finishingValidator(line: string, validators: ReadonlySet<string>): string | undefined {
  const match = LIVE_AGENT_LINE.exec(line);
  if (match === null || !validators.has(match[2]!)) return undefined;
  return `kept ${match[1]!} (validator ${match[2]!} is finishing — its worktree is removed when it ends)`;
}

function openMission(line: string, openByPath: ReadonlyMap<string, TowerMission>): string | undefined {
  const path = EXCLUDED_LINE.exec(line)?.[1];
  const mission = path === undefined ? undefined : openByPath.get(path);
  return path === undefined || mission === undefined ? undefined : `kept ${path} (mission ${mission.id} is still ${mission.status})`;
}
