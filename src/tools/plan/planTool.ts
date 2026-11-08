import {
  TOWER_MAIN_AGENT_ONLY,
  TOWER_MODE_USER_ENABLED_ONLY,
  TOWER_PLAN_DESCRIPTION,
} from '../../prompts/index.ts';
import {
  isMainAgent,
  runTowerTool,
  type TowerCaller,
  type TowerTool,
  type TowerToolHost,
} from '../support.ts';
import { TowerPlanToolInputSchema } from './plan.ts';

export function createTowerPlanTool(
  host: TowerToolHost,
  caller: TowerCaller,
): TowerTool<typeof TowerPlanToolInputSchema> {
  return {
    name: 'TowerPlan',
    label: 'Tower Plan',
    description: TOWER_PLAN_DESCRIPTION,
    parameters: TowerPlanToolInputSchema,
    async run(args) {
      if (!isMainAgent(caller)) return { isError: true, output: TOWER_MAIN_AGENT_ONLY };
      return runTowerTool(async () => {
        if (!host.isActive) return { output: TOWER_MODE_USER_ENABLED_ONLY, isError: true };
        const store = host.store();
        const missions = await store.plan(args.missions);
        const rows = missions.map(
          (m) =>
            `| ${m.id} | ${m.title} | ${m.kind} | ${m.branch} | ${m.worktree} | ${m.scope.join(', ')} |`,
        );
        return {
          output: [
            `planned ${String(missions.length)} mission(s):`,
            '',
            '| ID | Mission | Kind | Branch | Worktree | Scope |',
            '| -- | ------- | ---- | ------ | -------- | ----- |',
            ...rows,
            '',
            'Next: TowerSpawn one worker per mission (workers get their worktree path and mission briefing automatically), plus reviewers for the branches. Survey missions need no reviewer — they close with a zero-diff TowerMerge.',
          ].join('\n'),
        };
      });
    },
  };
}
