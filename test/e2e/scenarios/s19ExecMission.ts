import { HEADLESS_LIMITS, headlessScenario } from '../headless.ts';
import { objectiveSettingsConfig } from '../objective.ts';

export const s19ExecMission = headlessScenario({
  id: 'S19',
  title: 'headless pi-tower exec --mission with per-role model flags',
  command: 'pi-tower exec --mission --auto-approve',
  sources: 'each from its --<role>-model flag, tower.json names no model',
  cliArgs: (objectiveFile, settings) => [
    'exec',
    '--mission',
    '-f',
    objectiveFile,
    '--auto-approve',
    '--orchestrator-model',
    settings.orchestrator.spec,
    '--worker-model',
    settings.worker.spec,
    '--reviewer-model',
    settings.reviewer.spec,
    '--validator-model',
    settings.validator.spec,
  ],
  towerConfig: () => objectiveSettingsConfig(HEADLESS_LIMITS),
  modelSource: (role) => `--tower-${role}-model`,
});
