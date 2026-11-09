import type { TSchema } from 'typebox';

import { createTowerCompleteTool } from './complete/completeTool.ts';
import { createTowerFindingTool } from './finding/findingTool.ts';
import { createTowerInboxTool } from './inbox/inboxTool.ts';
import { createTowerInitTool } from './init/initTool.ts';
import { createTowerMergeTool } from './merge/mergeTool.ts';
import { createTowerMissionTool } from './mission/missionTool.ts';
import { createTowerObjectiveTool } from './objective/objectiveTool.ts';
import { createTowerPlanTool } from './plan/planTool.ts';
import { createTowerRebaseTool } from './rebase/rebaseTool.ts';
import { createTowerResumeTool } from './resume/resumeTool.ts';
import { createTowerReviewTool } from './review/reviewTool.ts';
import { createTowerSendTool } from './send/sendTool.ts';
import { createTowerSpawnTool } from './spawn/spawnTool.ts';
import { createTowerStatusTool } from './status/statusTool.ts';
import { ORCHESTRATOR_CALLER, type TowerCaller, type TowerTool, type TowerToolHost } from './support.ts';
import { createTowerTaskOutputTool } from './taskOutput/taskOutputTool.ts';
import { createTowerTasksTool } from './tasks/tasksTool.ts';
import { createTowerTaskStopTool } from './taskStop/taskStopTool.ts';
import { createTowerTeardownTool } from './teardown/teardownTool.ts';
import { createTowerValidateTool } from './validate/validateTool.ts';

export type AnyTowerTool = TowerTool<TSchema>;

export function createOrchestratorTools(
  host: TowerToolHost,
  spawnModelLines?: string,
): AnyTowerTool[] {
  const caller = ORCHESTRATOR_CALLER;
  return [
    createTowerInitTool(host, caller),
    createTowerPlanTool(host, caller),
    createTowerSpawnTool(host, caller, spawnModelLines),
    createTowerMergeTool(host, caller),
    createTowerRebaseTool(host, caller),
    createTowerTeardownTool(host, caller),
    createTowerSendTool(host, caller),
    createTowerInboxTool(host, caller),
    createTowerFindingTool(host, caller),
    createTowerReviewTool(host, caller),
    createTowerMissionTool(host, caller),
    createTowerStatusTool(host, caller),
    createTowerResumeTool(host, caller),
    createTowerTasksTool(host, caller),
    createTowerTaskOutputTool(host, caller),
    createTowerTaskStopTool(host, caller),
  ] as AnyTowerTool[];
}

export function createObjectiveOrchestratorTools(host: TowerToolHost): AnyTowerTool[] {
  return [createTowerObjectiveTool(host, ORCHESTRATOR_CALLER)] as AnyTowerTool[];
}

export function createAgentTools(host: TowerToolHost, caller: TowerCaller): AnyTowerTool[] {
  return [
    createTowerCompleteTool(host, caller),
    createTowerFindingTool(host, caller),
    createTowerInboxTool(host, caller),
    createTowerMissionTool(host, caller),
    createTowerReviewTool(host, caller),
    createTowerSendTool(host, caller),
    createTowerStatusTool(host, caller),
  ] as AnyTowerTool[];
}

export function createValidatorTools(host: TowerToolHost, caller: TowerCaller): AnyTowerTool[] {
  return [
    createTowerFindingTool(host, caller),
    createTowerInboxTool(host, caller),
    createTowerSendTool(host, caller),
    createTowerStatusTool(host, caller),
    createTowerValidateTool(host, caller),
  ] as AnyTowerTool[];
}

export { createTowerMergeTool } from './merge/mergeTool.ts';
export { createTowerObjectiveTool } from './objective/objectiveTool.ts';
export { createOrchestratorOperations, type TowerOrchestratorOperations } from './operations.ts';
export { createTowerRebaseTool } from './rebase/rebaseTool.ts';
export { createTowerResumeTool } from './resume/resumeTool.ts';
export { createTowerSpawnTool } from './spawn/spawnTool.ts';
export { createTowerValidateTool } from './validate/validateTool.ts';
export type { TowerValidatorKind } from './validate/validate.ts';
export {
  DEFAULT_OBJECTIVE_SETTINGS_VIEW,
  ORCHESTRATOR_CALLER,
  objectiveSettingsOf,
  runTowerTool,
  skippedValidationKinds,
  toToolDefinition,
  validationSettingsOf,
  type TowerCaller,
  type TowerInboxSentPayload,
  type TowerLaunchRequest,
  type TowerObjectiveSettingsView,
  type TowerOwner,
  type TowerSpawnBinding,
  type TowerSpawnModelResolution,
  type TowerTool,
  type TowerToolHost,
  type TowerToolResult,
} from './support.ts';
