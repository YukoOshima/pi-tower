import {
  TOWER_INIT_DESCRIPTION,
  TOWER_MAIN_AGENT_ONLY,
  TOWER_MODE_USER_ENABLED_ONLY,
} from '../../prompts/index.ts';
import { TowerProtocolError, type TowerReanchorMissionDigest } from '../../protocol/index.ts';
import {
  isMainAgent,
  runTowerTool,
  type TowerCaller,
  type TowerTool,
  type TowerToolHost,
} from '../support.ts';
import { TowerInitToolInputSchema } from './init.ts';

export function createTowerInitTool(
  host: TowerToolHost,
  caller: TowerCaller,
): TowerTool<typeof TowerInitToolInputSchema> {
  return {
    name: 'TowerInit',
    label: 'Tower Init',
    description: TOWER_INIT_DESCRIPTION,
    parameters: TowerInitToolInputSchema,
    async run(args) {
      if (!isMainAgent(caller)) return { isError: true, output: TOWER_MAIN_AGENT_ONLY };
      if (!host.isActive) return { isError: true, output: TOWER_MODE_USER_ENABLED_ONLY };
      return runTowerTool(async () => {
        const store = host.store();
        const prior = await store.load().then(
          (state) => ({ sessionId: state.sessionId, pid: state.ownerPid }),
          () => undefined,
        );
        if (
          prior?.sessionId !== undefined &&
          prior.sessionId !== host.sessionId &&
          host.isOwnerLive(prior)
        ) {
          throw new TowerProtocolError(
            `tower workspace is owned by a live session (${ownerLabel(prior.sessionId, prior.pid)}) — adopting it would retire that session's roster. Use the tower from that session, or close it first.`,
          );
        }
        const result = await store.init(host.sessionId, args.base);
        host.noteRetiredAgents(result.retiredAgents);
        return {
          output: [
            result.created
              ? 'tower workspace initialized'
              : 'tower workspace already initialized — existing state preserved',
            `base branch: ${result.base}`,
            ...(result.rebasedFrom !== undefined
              ? [
                  `base re-anchored from "${result.rebasedFrom}" to "${result.base}" — open missions now evaluate against "${result.base}"`,
                ]
              : []),
            ...(result.rebaseDigest?.missions.map(reanchorMissionLine) ?? []),
            ...(result.checkout !== result.base
              ? [
                  result.checkout === 'HEAD'
                    ? `note: the main checkout is in a detached HEAD state — merges stay blocked until the base is checked out (git checkout ${result.base})`
                    : `note: the main checkout is on "${result.checkout}", not base "${result.base}" — merges stay blocked until it is switched over (git checkout ${result.base})`,
                ]
              : []),
            'workspace: .tower/ (comms under .tower/comms/, worktrees under .tower/worktrees/)',
            ...(result.openMissions.length > 0
              ? [
                  `carried-over open missions: ${result.openMissions.join(', ')} — their scopes are still reserved. Continue them (TowerSpawn fresh workers), or — when they belong to an unrelated earlier task — abandon them first (TowerMission status=abandoned) so a new plan can use those files.`,
                ]
              : []),
            ...(result.retiredAgents.length > 0
              ? [
                  `adopted from a previous session — retired its stale roster entries: ${result.retiredAgents.join(', ')}. ` +
                    'Their agents belong to the dead session and cannot be resumed; missions and worktrees are preserved — TowerSpawn fresh workers to continue them.',
                ]
              : []),
            '',
            'Tower mode is active and the tower tool set is enabled.',
            'Next: split the work with TowerPlan (one mission per disjoint file scope), then TowerSpawn a worker per mission. Assign independent reviewers for their branches, and merge with TowerMerge only after a clean review with merge verdict "merge".',
          ].join('\n'),
        };
      });
    },
  };
}

export function ownerLabel(sessionId: string, pid: number | undefined): string {
  return pid === undefined ? sessionId : `${sessionId}, pid ${String(pid)}`;
}

function reanchorMissionLine(mission: TowerReanchorMissionDigest): string {
  const prefix = `mission ${mission.id} (${mission.branch}): ${mission.relation}`;
  switch (mission.relation) {
    case 'up-to-date':
      return `${prefix} — the branch already contains the new base tip; no rebase is required by this re-anchor`;
    case 'stale':
      return `${prefix} — the new base is not an ancestor of this branch tip; run TowerRebase(mission="${mission.id}") before merging`;
    case 'no-branch':
      return `${prefix} — no branch exists yet; spawn first, then evaluate its relation before merging`;
  }
}
