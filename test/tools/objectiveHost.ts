import type { TowerStore, TowerValidationSettings } from '../../src/protocol/index.ts';
import {
  DEFAULT_OBJECTIVE_SETTINGS_VIEW,
  type TowerObjectiveSettingsView,
} from '../../src/tools/support.ts';
import { TestHost, git } from '../tower/fakes.ts';

export class ObjectiveTestHost extends TestHost {
  settings: TowerObjectiveSettingsView = DEFAULT_OBJECTIVE_SETTINGS_VIEW;
  settingsReads = 0;

  objectiveSettings(): TowerObjectiveSettingsView {
    this.settingsReads += 1;
    return this.settings;
  }
}

export async function executingObjective(
  store: TowerStore,
  settings: TowerValidationSettings = {},
): Promise<void> {
  await store.draftObjective({
    title: 'Ship CSV export',
    goal: 'Users export their data as CSV.',
    definitionOfDone: ['export --format csv writes a valid file'],
    milestones: [
      { title: 'Data model', description: 'The CSV row model exists.' },
      { title: 'CLI command', validation: { qaInstructions: 'run pi-csv export' } },
    ],
  });
  await store.plan(
    [{ title: 'Build csv model', scope: ['src/model/**'], tasks: ['add the row type'], milestone: 'MS1' }],
    settings,
  );
  await store.requestObjectiveApproval();
  await store.approveObjective('human');
}

export async function validatingMilestone(
  store: TowerStore,
  settings: TowerValidationSettings = {},
): Promise<string> {
  await executingObjective(store, settings);
  await store.updateMission('tower', 'M1', { status: 'abandoned' });
  const tip = await git(store.repoRoot, 'rev-parse', 'main');
  await store.startMilestoneValidation('MS1', tip, settings);
  return tip;
}

export async function registerValidator(
  store: TowerStore,
  name: string,
  agentId: string,
  commit: string,
  kind: 'scrutiny' | 'user-testing' = 'scrutiny',
): Promise<void> {
  await store.registerSpawnedAgent({
    name,
    agentId,
    sessionId: 'session-objective',
    kind: 'validator',
    milestoneId: 'MS1',
    validationKind: kind,
    validationRound: 1,
    validatedCommit: commit,
    spawnedAt: new Date().toISOString(),
  });
}
