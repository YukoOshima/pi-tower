import type { TowerToolName } from '../prompts/index.ts';

export const TOWER_COMMAND = 'tower';
export const TOWER_STATUS_KEY = 'tower';

export const TOWER_MODE_ENTRY = 'tower-mode';
export const TOWER_REMINDER_MESSAGE = 'tower-mode-reminder';
export const TOWER_INBOX_WAKE_MESSAGE = 'tower-inbox-wake';
export const TOWER_AGENT_NOTIFICATION_MESSAGE = 'tower-agent-notification';

export const TOWER_MODE_TOOLS: readonly TowerToolName[] = [
  'TowerInit',
  'TowerPlan',
  'TowerSpawn',
  'TowerMerge',
  'TowerRebase',
  'TowerTeardown',
  'TowerSend',
  'TowerInbox',
  'TowerFinding',
  'TowerReview',
  'TowerMission',
  'TowerStatus',
  'TowerResume',
  'TowerTasks',
  'TowerTaskOutput',
  'TowerTaskStop',
];

export const TOWER_AGENT_TOOLS: readonly TowerToolName[] = [
  'TowerComplete',
  'TowerFinding',
  'TowerInbox',
  'TowerMission',
  'TowerReview',
  'TowerSend',
  'TowerStatus',
];

export const TOWER_WORKER_BASE_TOOLS: readonly string[] = [
  'read',
  'bash',
  'edit',
  'write',
  'grep',
  'find',
  'ls',
];

export const TOWER_REVIEWER_BASE_TOOLS: readonly string[] = ['read', 'bash', 'grep', 'find', 'ls'];

export const HUMAN_STOP_REASON = 'user';
export const TOWER_STOP_REASON_PREFIX = 'stopped by the tower';
export const SHUTDOWN_STOP_REASON = 'shutdown';
export const DEFAULT_AGENT_TIMEOUT_MS = 7_200_000;

export function isHumanStopReason(reason: string | undefined): boolean {
  return reason?.trim() === HUMAN_STOP_REASON;
}

export function isTowerStopReason(reason: string | undefined): boolean {
  const trimmed = reason?.trim();
  return (
    trimmed !== undefined &&
    (trimmed === TOWER_STOP_REASON_PREFIX || trimmed.startsWith(`${TOWER_STOP_REASON_PREFIX}: `))
  );
}
