import type { TowerRosterEntry, TowerState } from '../protocol/index.ts';

export const AUTOPILOT_INBOX_ACTIONS: readonly string[] = [
  'complete',
  'review-request',
  'review-result',
  'survey-summary',
  'validation-result',
];

export interface AutopilotInboxMessage {
  readonly action?: string;
  readonly scope?: string;
  readonly missionId?: string;
}

export function autopilotDrivesObjective(state: TowerState | undefined, autopilot: boolean): boolean {
  return autopilot && state?.objective?.status === 'executing';
}

export function isObjectiveAgent(state: TowerState, entry: TowerRosterEntry | undefined): boolean {
  switch (entry?.kind) {
    case undefined:
      return false;
    case 'worker':
      return isObjectiveFeature(state, entry.missionId);
    case 'reviewer':
      return isObjectiveFeature(state, entry.reviewMissionId);
    case 'validator':
      return isObjectiveMilestone(state, entry.milestoneId);
  }
}

export function isAutopilotInboxMessage(state: TowerState, message: AutopilotInboxMessage): boolean {
  if (message.action === undefined || !AUTOPILOT_INBOX_ACTIONS.includes(message.action)) return false;
  if (message.action === 'validation-result') return isObjectiveMilestone(state, message.scope);
  return isObjectiveFeature(state, message.missionId ?? message.scope);
}

function isObjectiveFeature(state: TowerState, missionId: string | undefined): boolean {
  if (missionId === undefined) return false;
  return isObjectiveMilestone(state, state.missions.find((mission) => mission.id === missionId)?.milestone);
}

function isObjectiveMilestone(state: TowerState, milestoneId: string | undefined): boolean {
  if (milestoneId === undefined) return false;
  return state.objective?.milestones.some((milestone) => milestone.id === milestoneId) ?? false;
}
