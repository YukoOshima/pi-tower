import { TOWER_MAIN_AGENT_ONLY, TOWER_MERGE_DESCRIPTION } from '../../prompts/index.ts';
import { isObjectiveOpen } from '../../protocol/index.ts';
import {
  isMainAgent,
  runTowerTool,
  type TowerCaller,
  type TowerTool,
  type TowerToolHost,
} from '../support.ts';
import { TowerMergeToolInputSchema } from './merge.ts';

export function createTowerMergeTool(
  host: TowerToolHost,
  caller: TowerCaller,
): TowerTool<typeof TowerMergeToolInputSchema> {
  return {
    name: 'TowerMerge',
    label: 'Tower Merge',
    description: TOWER_MERGE_DESCRIPTION,
    parameters: TowerMergeToolInputSchema,
    async run(args) {
      if (!isMainAgent(caller)) return { isError: true, output: TOWER_MAIN_AGENT_ONLY };
      return runTowerTool(async () => {
        const store = host.store();
        const result = await host.withBranchLease(args.branch, () =>
          store.merge(args.branch, { activeAgentIds: () => host.activeAgentIds() }),
        );
        const { status, mergeCommit, conflictsWith, evaluatedBranchTip, currentBranchTip } = result;
        if (status === 'advanced') {
          if (result.noop === true) {
            return {
              isError: true,
              output: `SURVEY NOT CLOSED: ${args.branch} advanced from the evaluated zero-diff tip ${evaluatedBranchTip} to ${currentBranchTip} before the mission could be closed — no git merge was performed and the mission was not marked merged; re-evaluate the new tip`,
            };
          }
          return {
            isError: true,
            output: [
              `PARTIAL MERGE: only the evaluated commit ${evaluatedBranchTip} of ${args.branch} was merged (merge commit ${mergeCommit}).`,
              `${args.branch} advanced during the merge to ${currentBranchTip}; that newer tip and any commits after ${evaluatedBranchTip} were NOT merged.`,
              'The mission was not marked merged. Review the new exact tip, then retry TowerMerge; do not treat the partial merge as a completed mission merge.',
            ].join('\n'),
          };
        }
        const after = await store.load();
        const allClosed =
          after.missions.length > 0 &&
          after.missions.every(
            (mission) => mission.status === 'merged' || mission.status === 'abandoned',
          );
        const teardownHint =
          after.objective !== undefined && isObjectiveOpen(after.objective)
            ? `Every mission is now merged or abandoned, but objective ${after.objective.id} is still ${after.objective.status} — validation, later milestones, or fix features follow; do not run TowerTeardown until the objective completes.`
            : 'Every mission is now merged or abandoned — ready for TowerTeardown (branches and .tower/comms/ are kept; dirty worktrees are protected).';
        if (status === 'noop') {
          return {
            output: [
              `${args.branch} is a read-only survey with a zero-diff branch — mission marked merged, no git merge needed.`,
              allClosed ? teardownHint : 'Continue with the remaining missions in Dependency Flow order.',
            ].join('\n'),
          };
        }
        const lines = [
          `merged ${args.branch} (merge commit ${mergeCommit.slice(0, 7)})`,
          `full commit: ${mergeCommit}`,
        ];
        if (conflictsWith.length > 0) {
          lines.push(
            '',
            'These unmerged branches changed the same files and now likely conflict with the base:',
            ...conflictsWith.map((conflict) => `- ${conflict.branch}: ${conflict.files.join(', ')}`),
            'For each affected mission, follow the next structured refusal: TowerRebase while its worker is idle (or ask the worker to rebase mid-turn). Conflict-free rebase preserves review binding; real conflicts must be resolved before another merge.',
          );
        } else if (allClosed) {
          lines.push(`The mission is now marked merged. ${teardownHint}`);
        } else {
          lines.push(
            'The mission is now marked merged. Continue with the remaining missions in Dependency Flow order.',
          );
        }
        return { output: lines.join('\n') };
      });
    },
  };
}
