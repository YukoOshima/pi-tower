import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { TOWER_MODEL_ENV, TOWER_MODEL_FLAGS, TOWER_ROLES } from './config/index.ts';
import {
  MISSION_COMMAND,
  MISSION_COMMAND_ALIAS,
  MISSION_COMMAND_DESCRIPTION,
  MISSIONS_COMMAND_DESCRIPTION,
  MissionMode,
  handleMissionCommand,
  missionCommandCompletions,
} from './mission/index.ts';
import { createObjectiveOrchestratorTools, createOrchestratorTools, toToolDefinition } from './tools/index.ts';
import { createTowerAgentRuntime } from './tower/agentRuntime.ts';
import { AutopilotRunner } from './tower/autopilot/index.ts';
import { towerAutopilotEffects, towerAutopilotObservations } from './tower/autopilotHost.ts';
import {
  TOWER_COMMAND_DESCRIPTION,
  commandUi,
  handleTowerCommand,
  towerCommandCompletions,
} from './tower/command.ts';
import { TOWER_COMMAND } from './tower/constants.ts';
import { TowerController } from './tower/controller.ts';
import { createTowerFileLog } from './tower/log.ts';
import { TowerModels } from './tower/models.ts';
import { handleTowerModelsCommand } from './tower/modelsCommand.ts';

export default function towerExtension(pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  const models = new TowerModels({
    agentDir,
    configDirName: CONFIG_DIR_NAME,
    env: process.env,
    getFlag: (name) => pi.getFlag(name),
  });
  const log = createTowerFileLog({ agentDir, repoRoot: () => controller.boundRoot });
  const controller: TowerController = new TowerController({
    pi,
    models,
    log,
    createRuntime: (owner) =>
      createTowerAgentRuntime(owner, { agentDir, maxRunningAgents: () => models.maxRunningAgents }),
    createAutopilot: (owner) =>
      new AutopilotRunner({
        observations: towerAutopilotObservations(owner),
        effects: towerAutopilotEffects(owner),
        log,
      }),
  });
  const mission = new MissionMode({ controller, pi });
  controller.onChange((change) => {
    mission.onTowerChange(change);
  });
  const observe = { onContext: controller.observe.bind(controller) };
  const completionOptions = {
    agentNames: () => controller.listAgents(true).map((agent) => agent.name),
    modelTargets: () => models.targets(),
  };

  for (const tool of [...createOrchestratorTools(controller), ...createObjectiveOrchestratorTools(controller)]) {
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
    getArgumentCompletions: (prefix) => towerCommandCompletions(prefix, completionOptions),
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
          objective: {
            autopilotTick: (reason) => controller.autopilotTick(reason),
            objectiveSettings: () => controller.objectiveSettings(),
          },
        },
        ui,
      );
      mission.onTowerCommand(args);
    },
  });

  for (const [name, description] of [
    [MISSION_COMMAND, MISSION_COMMAND_DESCRIPTION],
    [MISSION_COMMAND_ALIAS, MISSIONS_COMMAND_DESCRIPTION],
  ] as const) {
    pi.registerCommand(name, {
      description,
      getArgumentCompletions: (prefix) => missionCommandCompletions(prefix, completionOptions),
      handler: async (args, ctx) => {
        await handleMissionCommand(mission, controller, args, ctx, commandUi(ctx));
      },
    });
  }

  pi.on('session_start', async (event, ctx) => {
    await controller.onSessionStart(event, ctx);
    mission.onSessionStart(ctx);
  });
  pi.on('session_shutdown', async () => {
    mission.onSessionShutdown();
    await controller.onSessionShutdown();
  });
  pi.on('before_agent_start', (event, ctx) => controller.onBeforeAgentStart(event, ctx));
  pi.on('input', (event, ctx) => mission.onInput(event, ctx));
  pi.on('tool_call', (event, ctx) => controller.onToolCall(event, ctx));
  pi.on('tool_result', (event) => {
    mission.onToolResult(event);
    controller.onToolResult(event);
  });
  pi.on('after_provider_response', (event) => {
    controller.onAfterProviderResponse(event);
  });
  pi.on('message_end', (event) => {
    controller.onMessageEnd(event);
  });
  pi.on('agent_settled', (event, ctx) => {
    controller.onAgentSettled(event, ctx);
    mission.refreshSoon();
  });
  pi.on('model_select', (_event, ctx) => {
    controller.onModelChanged(ctx);
    mission.refreshSoon();
  });
  pi.on('thinking_level_select', (_event, ctx) => {
    controller.onModelChanged(ctx);
    mission.refreshSoon();
  });
}
