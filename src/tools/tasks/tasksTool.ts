import { TOWER_MAIN_AGENT_ONLY, TOWER_TASKS_DESCRIPTION } from '../../prompts/index.ts';
import { agentLine, loadRoster } from '../agents.ts';
import {
  isMainAgent,
  runTowerTool,
  type TowerCaller,
  type TowerTool,
  type TowerToolHost,
} from '../support.ts';
import { TowerTasksToolInputSchema } from './tasks.ts';

export function createTowerTasksTool(
  host: TowerToolHost,
  caller: TowerCaller,
): TowerTool<typeof TowerTasksToolInputSchema> {
  return {
    name: 'TowerTasks',
    label: 'Tower Tasks',
    description: TOWER_TASKS_DESCRIPTION,
    parameters: TowerTasksToolInputSchema,
    async run(args) {
      if (!isMainAgent(caller)) return { isError: true, output: TOWER_MAIN_AGENT_ONLY };
      return runTowerTool(async () => ({
        output: await renderTowerTasks(host, args.active_only ?? true),
      }));
    },
  };
}

export async function renderTowerTasks(host: TowerToolHost, activeOnly: boolean): Promise<string> {
  const agents = host.listAgents(activeOnly);
  if (agents.length === 0) {
    return activeOnly
      ? 'no running tower agents in this session — pass active_only=false to include finished runs'
      : 'no tower agents in this session — spawn workers and reviewers with TowerSpawn';
  }
  const state = await loadRoster(host);
  const now = Date.now();
  return [
    `${String(agents.length)} tower agent(s)${activeOnly ? ' running' : ' in this session'}:`,
    ...agents.map((info) =>
      agentLine(
        info,
        state?.roster.agents.findLast((agent) => agent.agentId === info.agentId),
        now,
      ),
    ),
  ].join('\n');
}
