import {
  TOWER_MAIN_AGENT_ONLY,
  TOWER_TASK_STOP_DESCRIPTION,
  unknownAgentRefusal,
} from '../../prompts/index.ts';
import { TOWER_STOP_REASON_PREFIX } from '../../tower/constants.ts';
import {
  WINDING_DOWN_NOTE,
  displayStatus,
  knownAgentNames,
  loadRoster,
  resolveAgentRef,
} from '../agents.ts';
import {
  isMainAgent,
  runTowerTool,
  type TowerCaller,
  type TowerTool,
  type TowerToolHost,
} from '../support.ts';
import { TowerTaskStopToolInputSchema } from './taskStop.ts';

export function towerTaskStopReason(reason: string | undefined): string {
  const trimmed = reason?.replaceAll(/\s+/g, ' ').trim();
  return trimmed === undefined || trimmed.length === 0
    ? TOWER_STOP_REASON_PREFIX
    : `${TOWER_STOP_REASON_PREFIX}: ${trimmed}`;
}

export function createTowerTaskStopTool(
  host: TowerToolHost,
  caller: TowerCaller,
): TowerTool<typeof TowerTaskStopToolInputSchema> {
  return {
    name: 'TowerTaskStop',
    label: 'Tower Task Stop',
    description: TOWER_TASK_STOP_DESCRIPTION,
    parameters: TowerTaskStopToolInputSchema,
    async run(args) {
      if (!isMainAgent(caller)) return { isError: true, output: TOWER_MAIN_AGENT_ONLY };
      return runTowerTool(async () => {
        const state = await loadRoster(host);
        const ref = resolveAgentRef(state, args.agent);
        const before = host.agentInfo(ref.id);
        if (before === undefined) {
          return {
            output: unknownAgentRefusal(args.agent.trim(), knownAgentNames(state, host.listAgents(false))),
            isError: true,
          };
        }
        const reason = towerTaskStopReason(args.reason);
        const result = await host.stopAgent(ref.id, reason);
        const after = host.agentInfo(ref.id) ?? before;
        const windingDown = after.windingDown ? `; it is still ${WINDING_DOWN_NOTE}` : '';
        if (result === 'stopped') {
          const kind = after.kind ?? ref.entry?.kind;
          return {
            output: [
              `stopped tower agent "${after.name}" (agent_id: ${after.agentId}, task_id: ${after.taskId}) — reason recorded: ${reason}${windingDown}`,
              kind === 'reviewer'
                ? 'A reviewer is one-shot: it is never resumed; spawn a fresh reviewer with a new name if the review is still needed.'
                : kind === 'validator'
                  ? 'A validator is one-shot: it is never resumed. Its round produced no verdict, so a fresh validator under a new name re-runs it only if the milestone still needs that verdict.'
                  : `Resume it later with TowerResume(agent="${after.name}", prompt="...") if its work should continue.`,
            ].join('\n'),
          };
        }
        if (result === 'idle' || (result === 'missing' && after.status !== 'running')) {
          return {
            output: `tower agent "${after.name}" (agent_id: ${after.agentId}) is not running — its last run ended with status: ${displayStatus(after)}; nothing was stopped${windingDown}`,
          };
        }
        return {
          output: unknownAgentRefusal(args.agent.trim(), knownAgentNames(state, host.listAgents(false))),
          isError: true,
        };
      });
    },
  };
}
