import {
  TOWER_MAIN_AGENT_ONLY,
  TOWER_TASK_OUTPUT_DESCRIPTION,
  unknownAgentRefusal,
} from '../../prompts/index.ts';
import { knownAgentNames, loadRoster, renderAgentOutput, resolveAgentRef } from '../agents.ts';
import {
  isMainAgent,
  runTowerTool,
  type TowerCaller,
  type TowerTool,
  type TowerToolHost,
} from '../support.ts';
import { TowerTaskOutputToolInputSchema } from './taskOutput.ts';

export function createTowerTaskOutputTool(
  host: TowerToolHost,
  caller: TowerCaller,
): TowerTool<typeof TowerTaskOutputToolInputSchema> {
  return {
    name: 'TowerTaskOutput',
    label: 'Tower Task Output',
    description: TOWER_TASK_OUTPUT_DESCRIPTION,
    parameters: TowerTaskOutputToolInputSchema,
    async run(args) {
      if (!isMainAgent(caller)) return { isError: true, output: TOWER_MAIN_AGENT_ONLY };
      return runTowerTool(async () => {
        const state = await loadRoster(host);
        const ref = resolveAgentRef(state, args.agent);
        const output = host.agentOutput(ref.id);
        if (output === undefined) {
          if (ref.entry !== undefined) {
            return {
              output: `tower agent "${ref.entry.name}" (agent_id: ${ref.entry.agentId}) has no run in this process — the tower restarted or the agent was never started here, so no output is available; its roster record and any death mark are in TowerStatus`,
              isError: true,
            };
          }
          return {
            output: unknownAgentRefusal(args.agent.trim(), knownAgentNames(state, host.listAgents(false))),
            isError: true,
          };
        }
        const entry =
          ref.entry ?? state?.roster.agents.findLast((agent) => agent.agentId === output.agentId);
        return { output: renderAgentOutput(output, entry, Date.now()) };
      });
    },
  };
}
