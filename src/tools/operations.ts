import { TowerProtocolError } from '../protocol/index.ts';
import { createTowerMergeTool } from './merge/mergeTool.ts';
import { createTowerRebaseTool } from './rebase/rebaseTool.ts';
import { createTowerResumeTool } from './resume/resumeTool.ts';
import { createTowerSpawnTool } from './spawn/spawnTool.ts';
import {
  ORCHESTRATOR_CALLER,
  runTowerTool,
  type TowerToolCall,
  type TowerToolHost,
  type TowerToolResult,
} from './support.ts';
import type { TowerValidatorKind } from './validate/validate.ts';

export interface TowerOrchestratorOperations {
  spawnWorker(missionId: string, name: string, instructions?: string): Promise<TowerToolResult>;
  spawnReviewer(missionId: string, name: string, instructions?: string): Promise<TowerToolResult>;
  spawnValidator(
    milestoneId: string,
    kind: TowerValidatorKind,
    name: string,
    instructions?: string,
  ): Promise<TowerToolResult>;
  resume(agent: string, prompt: string): Promise<TowerToolResult>;
  rebase(missionId: string): Promise<TowerToolResult>;
  merge(missionId: string): Promise<TowerToolResult>;
}

export function createOrchestratorOperations(host: TowerToolHost): TowerOrchestratorOperations {
  const call = (operation: string): TowerToolCall => ({ toolCallId: `tower-operation-${operation}` });
  const spawnTool = () => createTowerSpawnTool(host, ORCHESTRATOR_CALLER);
  const extra = (instructions: string | undefined) =>
    instructions === undefined ? {} : { instructions };
  const withMissionBranch = (
    missionId: string,
    execute: (branch: string) => Promise<TowerToolResult>,
  ): Promise<TowerToolResult> =>
    runTowerTool(async () => {
      const state = await host.store().load();
      const mission = state.missions.find((candidate) => candidate.id === missionId.trim());
      if (mission === undefined) {
        throw new TowerProtocolError(
          `unknown mission "${missionId}" — known missions: ${state.missions.map((candidate) => candidate.id).join(', ') || '(none planned yet)'}`,
        );
      }
      return execute(mission.branch);
    });
  return {
    spawnWorker: (missionId, name, instructions) =>
      spawnTool().run({ name, kind: 'worker', mission_id: missionId, ...extra(instructions) }, call('spawn-worker')),
    spawnReviewer: (missionId, name, instructions) =>
      withMissionBranch(missionId, (branch) =>
        spawnTool().run(
          { name, kind: 'reviewer', review_target: branch, ...extra(instructions) },
          call('spawn-reviewer'),
        ),
      ),
    spawnValidator: (milestoneId, kind, name, instructions) =>
      spawnTool().run(
        { name, kind: 'validator', milestone: milestoneId, validation_kind: kind, ...extra(instructions) },
        call('spawn-validator'),
      ),
    resume: (agent, prompt) =>
      createTowerResumeTool(host, ORCHESTRATOR_CALLER).run({ agent, prompt }, call('resume')),
    rebase: (missionId) =>
      createTowerRebaseTool(host, ORCHESTRATOR_CALLER).run({ mission: missionId }, call('rebase')),
    merge: (missionId) =>
      withMissionBranch(missionId, (branch) =>
        createTowerMergeTool(host, ORCHESTRATOR_CALLER).run({ branch }, call('merge')),
      ),
  };
}
