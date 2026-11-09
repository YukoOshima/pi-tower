import type { PromptFeature, PromptLiveAgent, PromptValidationKind } from '../../prompts/index.ts';
import { describeValidation } from '../../prompts/objectiveFormat.ts';
import { renderObjectiveStatus } from '../../prompts/objectiveStatus.ts';
import {
  finalMilestone,
  objectiveMissions,
  sortedMilestones,
  type TowerObjective,
  type TowerState,
} from '../../protocol/index.ts';

export interface ObjectiveDashboardOptions {
  readonly activeAgentIds: ReadonlySet<string>;
  readonly skipKinds: readonly PromptValidationKind[];
  readonly nowMs?: number;
}

export function objectiveFeatures(state: TowerState): PromptFeature[] {
  return objectiveMissions(state);
}

export function liveObjectiveAgents(
  state: TowerState,
  activeAgentIds: ReadonlySet<string>,
): PromptLiveAgent[] {
  return state.roster.agents.filter((agent) => activeAgentIds.has(agent.agentId));
}

export function renderObjectiveDashboard(
  state: TowerState,
  objective: TowerObjective,
  options: ObjectiveDashboardOptions,
): string {
  return renderObjectiveStatus({
    objective,
    features: objectiveFeatures(state),
    agents: liveObjectiveAgents(state, options.activeAgentIds),
    nowMs: options.nowMs ?? Date.now(),
    skipKinds: options.skipKinds,
  });
}

export function objectiveMilestoneLines(
  objective: TowerObjective,
  skipKinds: readonly PromptValidationKind[],
): string[] {
  const finalId = finalMilestone(objective)?.id;
  const milestones = sortedMilestones(objective);
  if (milestones.length === 0) return ['(no milestones yet — add them with TowerObjective(action="update", milestones=[...]))'];
  return milestones.map(
    (milestone, index) =>
      `${String(index + 1)}. ${milestone.id} "${milestone.title}" — ${milestone.status} · validation: ${describeValidation(
        milestone.validation,
        milestone.id === finalId ? objective.acceptanceCommands : [],
        skipKinds,
      )}`,
  );
}
