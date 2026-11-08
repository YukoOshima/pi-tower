import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { TOWER_MODEL_ENV, TOWER_MODEL_FLAGS, TOWER_ROLES } from './config/index.ts';
import { createOrchestratorTools, toToolDefinition } from './tools/index.ts';
import { createTowerAgentRuntime } from './tower/agentRuntime.ts';
import {
  TOWER_COMMAND_DESCRIPTION,
  commandUi,
  handleTowerCommand,
  towerCommandCompletions,
} from './tower/command.ts';
import { TOWER_COMMAND } from './tower/constants.ts';
import { TowerController } from './tower/controller.ts';
import { TowerModels } from './tower/models.ts';
import { handleTowerModelsCommand } from './tower/modelsCommand.ts';

export default function towerExtension(pi: ExtensionAPI): void {
  const models = new TowerModels({
    agentDir: getAgentDir(),
    configDirName: CONFIG_DIR_NAME,
    env: process.env,
    getFlag: (name) => pi.getFlag(name),
  });
  const controller = new TowerController({
    pi,
    models,
    createRuntime: (owner) =>
      createTowerAgentRuntime(owner, { maxRunningAgents: () => models.maxRunningAgents }),
  });
  const observe = { onContext: controller.observe.bind(controller) };

  for (const tool of createOrchestratorTools(controller)) {
    pi.registerTool(toToolDefinition(tool, { ...observe, defaultActive: false }));
  }

  for (const role of TOWER_ROLES) {
    pi.registerFlag(TOWER_MODEL_FLAGS[role], {
      type: 'string',
      description: `Tower ${role} model as provider/modelId[:thinkingLevel] (overrides ${TOWER_MODEL_ENV[role]} and tower.json)`,
    });
  }

  pi.registerCommand(TOWER_COMMAND, {
    description: TOWER_COMMAND_DESCRIPTION,
    getArgumentCompletions: (prefix) =>
      towerCommandCompletions(prefix, {
        agentNames: () => controller.listAgents(true).map((agent) => agent.name),
        modelTargets: () => models.targets(),
      }),
    handler: async (args, ctx) => {
      const ui = commandUi(ctx);
      await handleTowerCommand(
        controller,
        args,
        ctx,
        {
          sendUserMessage: (text, options) => {
            pi.sendUserMessage(text, options);
          },
          models: (words, modelsUi) => handleTowerModelsCommand(controller, words, ctx, modelsUi),
        },
        ui,
      );
    },
  });

  pi.on('session_start', (event, ctx) => controller.onSessionStart(event, ctx));
  pi.on('session_shutdown', () => controller.onSessionShutdown());
  pi.on('before_agent_start', (event, ctx) => controller.onBeforeAgentStart(event, ctx));
  pi.on('tool_call', (event, ctx) => controller.onToolCall(event, ctx));
  pi.on('after_provider_response', (event) => {
    controller.onAfterProviderResponse(event);
  });
  pi.on('agent_settled', (event, ctx) => {
    controller.onAgentSettled(event, ctx);
  });
  pi.on('model_select', (_event, ctx) => {
    controller.onModelChanged(ctx);
  });
  pi.on('thinking_level_select', (_event, ctx) => {
    controller.onModelChanged(ctx);
  });
}
