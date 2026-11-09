import { HEADLESS_LIMITS, headlessScenario } from '../headless.ts';
import { objectiveConfig } from '../objective.ts';

export const s16Headless = headlessScenario({
  id: 'S16',
  title: 'headless pi-tower run --auto-approve',
  command: 'pi-tower run --auto-approve',
  sources: 'all from tower.json',
  cliArgs: (objectiveFile) => ['run', '-f', objectiveFile, '--auto-approve'],
  towerConfig: (settings) => objectiveConfig(settings, HEADLESS_LIMITS),
  modelSource: (_role, configPath) => `${configPath} (global)`,
});
