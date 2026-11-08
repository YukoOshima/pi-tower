import { TOWER_MAIN_AGENT_ONLY, TOWER_REBASE_DESCRIPTION } from '../../prompts/index.ts';
import { TOWER_NAME } from '../../protocol/index.ts';
import {
  isMainAgent,
  runTowerTool,
  type TowerCaller,
  type TowerTool,
  type TowerToolHost,
} from '../support.ts';
import { TowerRebaseToolInputSchema } from './rebase.ts';

export function createTowerRebaseTool(
  host: TowerToolHost,
  caller: TowerCaller,
): TowerTool<typeof TowerRebaseToolInputSchema> {
  return {
    name: 'TowerRebase',
    label: 'Tower Rebase',
    description: TOWER_REBASE_DESCRIPTION,
    parameters: TowerRebaseToolInputSchema,
    async run(args) {
      if (!isMainAgent(caller)) return { isError: true, output: TOWER_MAIN_AGENT_ONLY };
      return runTowerTool(async () => {
        const store = host.store();
        const state = await store.load();
        const mission = state.missions.find((candidate) => candidate.id === args.mission.trim());
        if (mission === undefined) {
          return {
            isError: true,
            output: `unknown mission "${args.mission}" — known: ${state.missions.map((candidate) => candidate.id).join(', ') || '(none)'}`,
          };
        }
        const result = await host.withBranchLease(mission.branch, () =>
          store.rebaseMission(TOWER_NAME, mission.id, {
            activeAgentIds: () => host.activeAgentIds(),
          }),
        );
        if (result.status === 'up-to-date') {
          return {
            output: `mission ${mission.id} (${mission.branch}) is already up to date with base "${state.base}" — retry TowerMerge; if it was refused for another reason, that refusal tells you what is missing`,
          };
        }
        if (result.status === 'conflict') {
          return {
            output: [
              `rebase of mission ${mission.id} (${mission.branch}) onto "${state.base}" conflicted and was aborted — the mission is marked blocked.`,
              `conflicted files: ${result.files?.join(', ') || '(none reported)'}`,
              `resume the worker with TowerResume (it always runs in the background) so it resolves the conflicts in its worktree and requests a fresh review.`,
            ].join('\n'),
          };
        }
        return {
          output: [
            `rebased mission ${mission.id} (${mission.branch}) onto "${state.base}": ${result.fromCommit!.slice(0, 7)} → ${result.toCommit!.slice(0, 7)}.`,
            'The pre-rebase review keeps its exact-tip binding, but merge approval still requires a clean review with merge verdict "merge" — retry TowerMerge.',
          ].join('\n'),
        };
      });
    },
  };
}
