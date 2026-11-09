import { TowerProtocolError } from '../protocol/index.ts';
import { createTowerMergeTool } from '../tools/merge/mergeTool.ts';
import { createTowerRebaseTool } from '../tools/rebase/rebaseTool.ts';
import { createTowerResumeTool } from '../tools/resume/resumeTool.ts';
import { createTowerSpawnTool } from '../tools/spawn/spawnTool.ts';
import { ORCHESTRATOR_CALLER, type TowerToolCall, type TowerToolResult } from '../tools/support.ts';
import type { TowerController } from './controller.ts';

const DETAIL_MAX_CHARS = 300;

export type TowerEffectResult =
  | { readonly ok: true; readonly detail?: string }
  | { readonly ok: false; readonly error: string };

export function towerAutopilotEffects(controller: TowerController) {
  const spawn = createTowerSpawnTool(controller, ORCHESTRATOR_CALLER);
  const resume = createTowerResumeTool(controller, ORCHESTRATOR_CALLER);
  const rebase = createTowerRebaseTool(controller, ORCHESTRATOR_CALLER);
  const merge = createTowerMergeTool(controller, ORCHESTRATOR_CALLER);
  let calls = 0;
  const call = (): TowerToolCall => {
    calls += 1;
    return { toolCallId: `autopilot-${String(calls)}` };
  };
  return {
    spawnWorker: (missionId: string, name: string): Promise<TowerEffectResult> =>
      effect(() => spawn.run({ name, kind: 'worker', mission_id: missionId }, call())),
    respawnWorker: (missionId: string, name: string, reason: string): Promise<TowerEffectResult> =>
      effect(() => spawn.run({ name, kind: 'worker', mission_id: missionId, instructions: reason }, call())),
    resumeWorker: (agentName: string, prompt: string): Promise<TowerEffectResult> =>
      effect(() => resume.run({ agent: agentName, prompt }, call())),
    spawnReviewer: (missionId: string, name: string): Promise<TowerEffectResult> =>
      effect(async () =>
        spawn.run({ name, kind: 'reviewer', review_target: await missionBranch(controller, missionId) }, call()),
      ),
    rebase: (missionId: string): Promise<TowerEffectResult> =>
      effect(() => rebase.run({ mission: missionId }, call())),
    merge: (missionId: string): Promise<TowerEffectResult> =>
      effect(async () => merge.run({ branch: await missionBranch(controller, missionId) }, call())),
    wakeOrchestrator: (text: string): void => {
      controller.wakeOrchestrator(text);
    },
    notifyHuman: (text: string, level: 'info' | 'warning' | 'error'): void => {
      controller.notify(text, level);
    },
  };
}

async function effect(execute: () => Promise<TowerToolResult>): Promise<TowerEffectResult> {
  try {
    const result = await execute();
    return result.isError === true ? { ok: false, error: result.output } : { ok: true, detail: summary(result.output) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function summary(output: string): string {
  const line = (output.trim().split(/\n\s*\n/, 1)[0] ?? '').replaceAll(/\s+/g, ' ');
  return line.length > DETAIL_MAX_CHARS ? `${line.slice(0, DETAIL_MAX_CHARS - 1)}…` : line;
}

async function missionBranch(controller: TowerController, missionId: string): Promise<string> {
  const state = await controller.store().load();
  const mission = state.missions.find((candidate) => candidate.id === missionId);
  if (mission === undefined) throw new TowerProtocolError(`unknown mission "${missionId}"`);
  return mission.branch;
}
