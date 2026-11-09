import {
  TOWER_MAIN_AGENT_ONLY,
  TOWER_MODE_USER_ENABLED_ONLY,
  TOWER_PLAN_DESCRIPTION,
} from '../../prompts/index.ts';
import { currentMilestone, type TowerMission, type TowerObjective } from '../../protocol/index.ts';
import {
  isMainAgent,
  objectiveSettingsOf,
  runTowerTool,
  validationSettingsOf,
  type TowerCaller,
  type TowerObjectiveSettingsView,
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
        const settings = objectiveSettingsOf(host);
        const missions = await store.plan(args.missions, validationSettingsOf(settings));
        if (missions.some((mission) => mission.milestone !== undefined)) {
          return { output: renderFeaturePlan(missions, (await store.load()).objective, settings) };
        }
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

function renderFeaturePlan(
  missions: readonly TowerMission[],
  objective: TowerObjective | undefined,
  settings: TowerObjectiveSettingsView,
): string {
  const rows = missions.map(
    (m) =>
      `| ${m.id} | ${m.title} | ${m.kind} | ${m.milestone ?? '—'} | ${m.origin ?? '—'} | ${m.branch} | ${m.worktree} | ${m.scope.join(', ')} |`,
  );
  const current = objective === undefined ? undefined : currentMilestone(objective);
  const start = settings.autopilot
    ? 'The autopilot spawns a worker for each feature of the current milestone as soon as its deps are merged or abandoned, then drives review, rebase, and merge through the same gates'
    : 'The autopilot is off: once the objective is executing, TowerSpawn one worker per feature of the current milestone as soon as its deps are merged or abandoned, plus reviewers for the branches';
  const waiting =
    objective?.status === 'planning' || objective?.status === 'awaiting-approval'
      ? ` Nothing starts before the human approves objective ${objective.id}: finish the plan, then TowerObjective(action="request-approval").`
      : '';
  return [
    `planned ${String(missions.length)} mission(s):`,
    '',
    '| ID | Mission | Kind | Milestone | Origin | Branch | Worktree | Scope |',
    '| -- | ------- | ---- | --------- | ------ | ------ | -------- | ----- |',
    ...rows,
    '',
    `Next: ${start}${current === undefined ? '' : ` (current milestone: ${current.id})`}; features of later milestones wait until their milestone becomes current.${waiting}`,
  ].join('\n');
}
