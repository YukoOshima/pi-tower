import { defineTool, type InlineExtension } from '@earendil-works/pi-coding-agent';

import {
  TowerAgentRuntime,
  TowerRateLimiter,
  createPiSessionFactory,
  type PiSessionFactoryOptions,
  type TowerAgentSessionFactory,
  type TowerAgentSessionRequest,
} from '../runtime/index.ts';
import { createAgentTools, toToolDefinition } from '../tools/index.ts';
import { DEFAULT_AGENT_TIMEOUT_MS } from './constants.ts';
import type { TowerController } from './controller.ts';
import { towerAgentGuards } from './guards.ts';

export interface TowerAgentRuntimeOptions {
  readonly maxRunningAgents: () => number | undefined;
  readonly agentDir?: string;
  readonly createSessionFactory?: (options: PiSessionFactoryOptions) => TowerAgentSessionFactory;
  readonly extensionFactories?: (request: TowerAgentSessionRequest) => readonly InlineExtension[];
  readonly stopGraceMs?: number;
}

export function createTowerAgentRuntime(
  controller: TowerController,
  options: TowerAgentRuntimeOptions,
): TowerAgentRuntime {
  const createFactory = options.createSessionFactory ?? createPiSessionFactory;
  const factories = new Map<string, TowerAgentSessionFactory>();
  const factoryFor = (repoRoot: string): TowerAgentSessionFactory => {
    let factory = factories.get(repoRoot);
    if (factory === undefined) {
      factory = createFactory({
        ...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
        projectTrusted: () => controller.context?.isProjectTrusted() ?? false,
        modelRegistry: () => controller.context?.modelRegistry,
        repoRoot,
        onDiagnostic: (message) => {
          controller.diagnostic(message);
        },
        onExtensionError: (agentId, error) => {
          controller.diagnostic(`tower agent ${agentId}: extension ${error.extensionPath} failed on ${error.event}: ${error.error}`);
        },
      });
      factories.set(repoRoot, factory);
    }
    return factory;
  };
  const sessionFactory: TowerAgentSessionFactory = (request) => {
    controller.expectAgentRegistration(request.agentId);
    const agentTools = createAgentTools(controller, { agentId: request.agentId }).map((tool) => {
      const definition = toToolDefinition(tool);
      return defineTool({
        ...definition,
        execute: async (toolCallId, params, signal, onUpdate, ctx) => {
          await controller.agentRegistration(request.agentId);
          return definition.execute(toolCallId, params, signal, onUpdate, ctx);
        },
      });
    });
    const extensions = [
      towerAgentGuards({
        agentId: request.agentId,
        kind: request.spec.kind,
        cwd: request.spec.cwd,
        repoRoot: () => controller.repoRoot,
      }),
      ...(options.extensionFactories?.(request) ?? []),
    ];
    return factoryFor(controller.repoRoot)({
      agentId: request.agentId,
      spec: {
        ...request.spec,
        customTools: [...(request.spec.customTools ?? []), ...agentTools],
        extensionFactories: [...(request.spec.extensionFactories ?? []), ...extensions],
      },
    });
  };
  return new TowerAgentRuntime({
    sessionFactory,
    limiter: new TowerRateLimiter({ maxRunningAgents: options.maxRunningAgents }),
    timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
    ...(options.stopGraceMs === undefined ? {} : { stopGraceMs: options.stopGraceMs }),
    onListenerError: (error, event) => {
      controller.diagnostic(
        `tower runtime listener failed on ${event.type} for ${event.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
    onDiagnostic: (message) => {
      controller.diagnostic(message);
    },
  });
}
