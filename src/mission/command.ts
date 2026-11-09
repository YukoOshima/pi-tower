import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';

import { towerCommandCompletions, type ObjectiveHandOverRequest, type TowerCommandUi } from '../tower/command.ts';
import type { TowerController } from '../tower/controller.ts';
import { handleTowerModelsCommand } from '../tower/modelsCommand.ts';
import type { MissionMode } from './mode.ts';
import {
  MISSION_COMMAND_USAGE,
  MISSION_FILE_USAGE,
  MISSION_HELP_TITLE,
  MISSION_MODELS_TEXTS,
  MISSION_SUBCOMMANDS,
  missionNearMiss,
} from './texts.ts';

export interface MissionCompletionOptions {
  readonly agentNames?: () => readonly string[];
  readonly modelTargets?: () => readonly string[];
}

export async function handleMissionCommand(
  mission: MissionMode,
  controller: TowerController,
  args: string,
  ctx: ExtensionCommandContext,
  ui: TowerCommandUi,
): Promise<void> {
  controller.observe(ctx);
  const input = args.trim();
  const words = input.length === 0 ? [] : input.split(/\s+/);
  const head = (words[0] ?? '').toLowerCase();
  const rest = input.slice((words[0] ?? '').length).trim();
  const single = words.length === 1;

  if (input.length === 0) {
    await mission.enter(ctx, ui);
    return;
  }
  if (single && head === 'approve') {
    await mission.approve(ui);
    return;
  }
  if (head === 'pause') {
    await mission.pause(rest, ui);
    return;
  }
  if (single && head === 'resume') {
    await mission.resume(ui);
    return;
  }
  if (head === 'models') {
    await handleTowerModelsCommand(controller, words.slice(1), ctx, ui, MISSION_MODELS_TEXTS);
    mission.refreshSoon();
    return;
  }
  if (single && head === 'agents') {
    await mission.agents(ui);
    return;
  }
  if (head === 'stop') {
    await mission.stop(rest, ui);
    return;
  }
  if (single && (head === 'exit' || head === 'off')) {
    await mission.exit(ui);
    return;
  }
  if (single && (head === 'help' || head === '--help' || head === '-h')) {
    ui.notice(MISSION_HELP_TITLE, MISSION_COMMAND_USAGE);
    return;
  }
  const nearMiss = single ? missionNearMiss(words[0] ?? '') : undefined;
  if (nearMiss !== undefined) {
    ui.error(nearMiss);
    return;
  }
  const request = goalRequest(input);
  if (request === undefined) {
    ui.error(MISSION_FILE_USAGE);
    return;
  }
  await mission.startGoal(request, ctx, ui);
}

export function missionCommandCompletions(
  prefix: string,
  options: MissionCompletionOptions = {},
): AutocompleteItem[] | null {
  const lower = prefix.toLowerCase();
  if (!lower.includes(' ')) {
    const items = MISSION_SUBCOMMANDS.filter((item) => item.value.startsWith(lower)).map((item) => ({
      value: item.value,
      label: item.value,
      description: item.description,
    }));
    return items.length > 0 ? items : null;
  }
  const head = (lower.split(/\s+/)[0] ?? '').trim();
  if (head === 'stop' || head === 'models') return towerCommandCompletions(prefix, options);
  return null;
}

function goalRequest(input: string): ObjectiveHandOverRequest | undefined {
  if (!input.startsWith('@')) return { mode: 'interactive', text: input };
  const file = input.slice(1).trim();
  return file.length === 0 ? undefined : { mode: 'interactive', file };
}
