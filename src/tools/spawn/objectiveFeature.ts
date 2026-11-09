import {
  currentMilestone,
  findMilestone,
  type TowerMission,
  type TowerState,
} from '../../protocol/index.ts';

const NOTHING_CREATED = 'no worktree or agent was created';

function because(reason: string | undefined): string {
  const trimmed = reason?.trim();
  return trimmed === undefined || trimmed.length === 0 ? '' : ` (${trimmed})`;
}

export function objectiveFeatureSpawnRefusal(
  state: TowerState,
  mission: TowerMission,
): string | undefined {
  const objective = state.objective;
  if (mission.milestone === undefined || objective === undefined) return undefined;
  const milestone = findMilestone(objective, mission.milestone);
  if (milestone === undefined) return undefined;
  const feature = `mission ${mission.id} is a feature of milestone ${milestone.id} "${milestone.title}" of objective ${objective.id}`;
  switch (objective.status) {
    case 'planning':
      return `${feature}, which is still planning — nothing starts before the human approves: finish the plan and hand it over with TowerObjective(action="request-approval"); ${NOTHING_CREATED}`;
    case 'awaiting-approval':
      return `${feature}, which is awaiting approval — nothing starts before the human approves it in the approval dialog or with /mission approve; ${NOTHING_CREATED}`;
    case 'paused':
      return `${feature}, which is paused${because(objective.pausedReason)} — no new work starts until the human resumes it with /mission resume; ${NOTHING_CREATED}`;
    case 'blocked':
      return `${feature}, which is blocked${because(objective.blockedReason)} — the human decides how to continue and resumes it with /mission resume; ${NOTHING_CREATED}`;
    case 'completed':
      return `${feature}, which is completed — plan further work into a new objective, which the human starts with /mission; ${NOTHING_CREATED}`;
    case 'executing': {
      const current = currentMilestone(objective);
      if (current?.id === milestone.id) return undefined;
      if (current === undefined || milestone.order < current.order) {
        return `${feature}, but milestone ${milestone.id} already passed validation — features start only in the current milestone; ${NOTHING_CREATED}`;
      }
      return `${feature}, but the current milestone is ${current.id} "${current.title}" — features of a later milestone start only after the earlier milestones pass validation, and the autopilot spawns them once ${milestone.id} becomes current; ${NOTHING_CREATED}`;
    }
  }
}
