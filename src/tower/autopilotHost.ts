import type { TowerState } from '../protocol/index.ts';
import { createOrchestratorOperations, type TowerToolResult, type TowerValidatorKind } from '../tools/index.ts';
import type { TowerController } from './controller.ts';

const DETAIL_MAX_CHARS = 300;

export type TowerEffectResult =
  | { readonly ok: true; readonly detail?: string }
  | { readonly ok: false; readonly error: string };

export function towerAutopilotObservations(controller: TowerController) {
  return {
    now: (): number => Date.now(),
    store: () => controller.store(),
    settings: () => controller.autopilotSettings(),
    agent: (agentId: string) => controller.autopilotAgent(agentId),
    orchestratorBusy: (): boolean => controller.orchestratorBusy(),
    headless: (state: TowerState): boolean => state.objectiveMode === 'headless',
    totalCostUsd: (): number => controller.totalCostUsd(),
  };
}

export function towerAutopilotEffects(controller: TowerController) {
  const operations = createOrchestratorOperations(controller);
  return {
    spawnWorker: (missionId: string, name: string): Promise<TowerEffectResult> =>
      effect(() => operations.spawnWorker(missionId, name)),
    respawnWorker: (missionId: string, name: string, reason: string): Promise<TowerEffectResult> =>
      effect(() => operations.spawnWorker(missionId, name, reason)),
    resumeWorker: (agentName: string, prompt: string): Promise<TowerEffectResult> =>
      effect(() => operations.resume(agentName, prompt)),
    spawnReviewer: (missionId: string, name: string): Promise<TowerEffectResult> =>
      effect(() => operations.spawnReviewer(missionId, name)),
    rebase: (missionId: string): Promise<TowerEffectResult> => effect(() => operations.rebase(missionId)),
    merge: (missionId: string): Promise<TowerEffectResult> => effect(() => operations.merge(missionId)),
    spawnValidator: (milestoneId: string, kind: TowerValidatorKind, name: string): Promise<TowerEffectResult> =>
      effect(() => operations.spawnValidator(milestoneId, kind, name)),
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
