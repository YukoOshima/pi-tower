import {
  DEFAULT_OBJECTIVE_SETTINGS_VIEW,
  type TowerObjectiveSettingsView,
} from '../../src/tools/support.ts';
import { TestHost } from '../tower/fakes.ts';

export class ObjectiveTestHost extends TestHost {
  settings: TowerObjectiveSettingsView = DEFAULT_OBJECTIVE_SETTINGS_VIEW;
  settingsReads = 0;

  objectiveSettings(): TowerObjectiveSettingsView {
    this.settingsReads += 1;
    return this.settings;
  }
}
