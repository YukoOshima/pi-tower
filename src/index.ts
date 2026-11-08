import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { createOrchestratorTools, toToolDefinition } from './tools/index.ts';
import {
  TOWER_COMMAND_DESCRIPTION,
  handleTowerCommand,
  towerCommandCompletions,
} from './tower/command.ts';
import { TOWER_COMMAND } from './tower/constants.ts';
import { TowerController } from './tower/controller.ts';

export default function towerExtension(pi: ExtensionAPI): void {
  const controller = new TowerController({ pi });
  const observe = { onContext: controller.observe.bind(controller) };

  for (const tool of createOrchestratorTools(controller)) {
    pi.registerTool(toToolDefinition(tool, { ...observe, defaultActive: false }));
  }

  pi.registerCommand(TOWER_COMMAND, {
    description: TOWER_COMMAND_DESCRIPTION,
    getArgumentCompletions: (prefix) =>
      towerCommandCompletions(prefix, {
        agentNames: () => controller.listAgents(true).map((agent) => agent.name),
      }),
    handler: (args, ctx) =>
      handleTowerCommand(controller, args, ctx, {
        sendUserMessage: (text, options) => {
          pi.sendUserMessage(text, options);
        },
      }),
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
}
