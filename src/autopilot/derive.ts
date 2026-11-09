import type {
  AutopilotMilestone,
  AutopilotMission,
  AutopilotObjective,
  AutopilotRound,
  AutopilotSettings,
  AutopilotSnapshot,
  AutopilotValidationKind,
} from './types.ts';

export function compareIds(a: string, b: string): number {
  const left = idNumber(a);
  const right = idNumber(b);
  if (left !== right) return left - right;
  return a < b ? -1 : a > b ? 1 : 0;
}

function idNumber(id: string): number {
  const match = /\d+/.exec(id);
  return match === null ? Number.POSITIVE_INFINITY : Number(match[0]);
}

export function sortedMilestones(objective: AutopilotObjective): AutopilotMilestone[] {
  return [...objective.milestones].sort((a, b) => a.order - b.order || compareIds(a.id, b.id));
}

export function currentMilestone(objective: AutopilotObjective): AutopilotMilestone | undefined {
  return sortedMilestones(objective).find((milestone) => milestone.status !== 'passed');
}

export function finalMilestone(objective: AutopilotObjective): AutopilotMilestone | undefined {
  return sortedMilestones(objective).at(-1);
}

export function milestoneRequiredKinds(
  objective: AutopilotObjective,
  milestone: AutopilotMilestone,
  settings: Pick<AutopilotSettings, 'skipScrutiny' | 'skipUserTesting'>,
): AutopilotValidationKind[] {
  const kinds: AutopilotValidationKind[] = [];
  if (milestone.validation.scrutiny && !settings.skipScrutiny) kinds.push('scrutiny');
  if (milestone.validation.userTesting && !settings.skipUserTesting) kinds.push('user-testing');
  const final = finalMilestone(objective)?.id === milestone.id;
  if (milestone.validation.commands + (final ? objective.acceptanceCommands : 0) > 0) {
    kinds.push('commands');
  }
  return kinds;
}

export function latestRound(
  milestone: AutopilotMilestone,
  kind: AutopilotValidationKind,
  commit?: string,
): AutopilotRound | undefined {
  let latest: AutopilotRound | undefined;
  for (const round of milestone.rounds) {
    if (round.kind !== kind || (commit !== undefined && round.commit !== commit)) continue;
    if (latest === undefined || round.round > latest.round) latest = round;
  }
  return latest;
}

export function failedRoundCount(milestone: AutopilotMilestone, kind: AutopilotValidationKind): number {
  return milestone.rounds.filter((round) => round.kind === kind && round.verdict === 'fail').length;
}

export function isClosed(mission: AutopilotMission): boolean {
  return mission.status === 'merged' || mission.status === 'abandoned';
}

export function sortedMissions(missions: readonly AutopilotMission[]): AutopilotMission[] {
  return [...missions].sort((a, b) => compareIds(a.id, b.id));
}

export function milestoneFeatures(
  snapshot: AutopilotSnapshot,
  milestoneId: string,
): AutopilotMission[] {
  return sortedMissions(snapshot.missions.filter((mission) => mission.milestone === milestoneId));
}

export function depsSettled(snapshot: AutopilotSnapshot, mission: AutopilotMission): boolean {
  return mission.deps.every((dep) => {
    const dependency = snapshot.missions.find((candidate) => candidate.id === dep);
    return dependency === undefined || isClosed(dependency);
  });
}

export function runningAgents(snapshot: AutopilotSnapshot): number {
  let running = snapshot.otherRunningAgents;
  for (const mission of snapshot.missions) {
    if (mission.worker.state === 'running') running += 1;
    if (mission.reviewerRunning) running += 1;
  }
  for (const run of snapshot.validators) {
    if (run.kind !== 'commands') running += 1;
  }
  return running;
}
