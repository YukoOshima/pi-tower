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
  const run = (name: string, execute: () => Promise<TowerToolResult>): Promise<EffectResult> =>
    effect(execute).finally(() => {
      controller.noteStateChange(`autopilot ${name}`);
    });
  return {
    spawnWorker: (missionId, name) => run('spawn-worker', () => operations.spawnWorker(missionId, name)),
    respawnWorker: (missionId, name, reason) =>
      run('respawn-worker', () => operations.spawnWorker(missionId, name, reason)),
    resumeWorker: (agentName, prompt) => run('resume-worker', () => operations.resume(agentName, prompt)),
    spawnReviewer: (missionId, name) => run('spawn-reviewer', () => operations.spawnReviewer(missionId, name)),
    rebase: (missionId) => run('rebase', () => operations.rebase(missionId)),
    merge: (missionId) => run('merge', () => operations.merge(missionId)),
    spawnValidator: (milestoneId, kind, name) =>
      run('spawn-validator', () => operations.spawnValidator(milestoneId, kind, name)),
    wakeOrchestrator: (text) => {
      controller.wakeOrchestrator(text);
    },
    notifyHuman: (text, level) => {
      controller.notify(text, level);
      controller.noteStateChange('autopilot notice');
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
