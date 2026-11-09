import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

import { MODEL_REF_FORMAT, TowerConfigError } from '../config/index.ts';
import type { TowerCommandUi } from './command.ts';
import type { TowerController } from './controller.ts';

export const TOWER_MODELS_USAGE = `Usage: /tower models — show the orchestrator, worker, reviewer and validator models and the objective settings; /tower models <orchestrator|primary|worker|reviewer|validator|alias> <${MODEL_REF_FORMAT}> [--project] — set one; /tower models <role|alias> --clear [--project] — remove it (the global tower.json is written unless --project is given)`;

export interface TowerModelsCommandTexts {
  readonly title: string;
  readonly usage: string;
  readonly unavailable: string;
  readonly orchestratorNote: string;
}

export const TOWER_MODELS_TEXTS: TowerModelsCommandTexts = {
  title: 'Tower models',
  usage: TOWER_MODELS_USAGE,
  unavailable: 'Tower model configuration is not available in this build.',
  orchestratorNote:
    'The orchestrator model is applied when tower mode turns on — run /tower off and /tower on, or switch this session now with /model.',
};

export async function handleTowerModelsCommand(
  controller: TowerController,
  args: readonly string[],
  ctx: ExtensionCommandContext,
  ui: TowerCommandUi,
  texts: TowerModelsCommandTexts = TOWER_MODELS_TEXTS,
): Promise<void> {
  const models = controller.models;
  if (models === undefined) {
    ui.error(texts.unavailable);
    return;
  }
  const flags = args.filter((arg) => arg.startsWith('--'));
  const words = args.filter((arg) => !arg.startsWith('--'));
  const unknownFlag = flags.find((flag) => !['--project', '--clear'].includes(flag));
  if (unknownFlag !== undefined) {
    ui.error(`Unknown option ${unknownFlag}. ${texts.usage}`);
    return;
  }
  if (words.length === 0 && flags.length === 0) {
    await controller.reloadModels();
    ui.notice(texts.title, models.describe(controller.primaryModel(), ctx.modelRegistry));
    return;
  }
  const clear = flags.includes('--clear');
  const [target, ref, ...extra] = words;
  if (target === undefined || extra.length > 0 || (clear ? ref !== undefined : ref === undefined)) {
    ui.error(texts.usage);
    return;
  }
  const scope = flags.includes('--project') ? 'project' : 'global';
  try {
    const result = await models.write(controller.modelsContext(ctx), {
      key: target,
      ...(ref === undefined ? {} : { ref }),
      scope,
    });
    controller.refreshSpawnTool();
    const notes =
      controller.isActive && (target === 'primary' || target === 'orchestrator') ? [texts.orchestratorNote] : [];
    ui.notice(
      texts.title,
      [...result.lines, ...notes, '', models.describe(controller.primaryModel(), ctx.modelRegistry)].join(
        '\n',
      ),
    );
    for (const warning of result.warnings) ui.warn(warning);
  } catch (error) {
    ui.error(
      error instanceof TowerConfigError
        ? error.message
        : `Failed to update the tower model config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
