import { createOrchestratorOperations, type TowerToolResult } from '../tools/index.ts';
import type { AutopilotEffects, AutopilotObservations, EffectResult } from './autopilot/index.ts';
import type { TowerController } from './controller.ts';

const DETAIL_MAX_CHARS = 300;

export function towerAutopilotObservations(controller: TowerController): AutopilotObservations {
  return {
    now: () => Date.now(),
    store: () => controller.store(),
    settings: () => controller.autopilotSettings(),
    agent: (agentId) => controller.autopilotAgent(agentId),
    orchestratorBusy: () => controller.orchestratorBusy(),
    headless: (state) => state.objectiveMode === 'headless',
    totalCostUsd: () => controller.totalCostUsd(),
  };
}

export function towerAutopilotEffects(controller: TowerController): AutopilotEffects {
  const operations = createOrchestratorOperations(controller);
  return {
    spawnWorker: (missionId, name) => effect(() => operations.spawnWorker(missionId, name)),
    respawnWorker: (missionId, name, reason) => effect(() => operations.spawnWorker(missionId, name, reason)),
    resumeWorker: (agentName, prompt) => effect(() => operations.resume(agentName, prompt)),
    spawnReviewer: (missionId, name) => effect(() => operations.spawnReviewer(missionId, name)),
    rebase: (missionId) => effect(() => operations.rebase(missionId)),
    merge: (missionId) => effect(() => operations.merge(missionId)),
    spawnValidator: (milestoneId, kind, name) => effect(() => operations.spawnValidator(milestoneId, kind, name)),
    wakeOrchestrator: (text) => {
      controller.wakeOrchestrator(text);
    },
    notifyHuman: (text, level) => {
      controller.notify(text, level);
    },
  };
}

async function effect(execute: () => Promise<TowerToolResult>): Promise<EffectResult> {
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
