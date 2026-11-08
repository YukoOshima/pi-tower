import {
  TOWER_MAIN_AGENT_ONLY,
  TOWER_RESUME_DESCRIPTION,
  resumeHumanStoppedRefusal,
  resumeLeasedRefusal,
  resumeReviewerRefusal,
  resumeRetiredRefusal,
  resumeRunningRefusal,
  unknownAgentRefusal,
  workerSpawnGuidance,
} from '../../prompts/index.ts';
import { isStoppedByUser } from '../status/statusTool.ts';
import { describeAgentModel, isHumanStop, knownAgentNames, resolveAgentRef } from '../agents.ts';
import {
  isMainAgent,
  runTowerTool,
  type TowerCaller,
  type TowerTool,
  type TowerToolHost,
} from '../support.ts';
import { TowerResumeToolInputSchema } from './resume.ts';

export function resumeRestartedRefusal(name: string): string {
  return `tower agent "${name}" is not running in this process — the tower restarted, so its run cannot be resumed and no agent was started; spawn a fresh worker for its mission under a new name with TowerSpawn`;
}

export function createTowerResumeTool(
  host: TowerToolHost,
  caller: TowerCaller,
): TowerTool<typeof TowerResumeToolInputSchema> {
  return {
    name: 'TowerResume',
    label: 'Tower Resume',
    description: TOWER_RESUME_DESCRIPTION,
    parameters: TowerResumeToolInputSchema,
    async run(args) {
      if (!isMainAgent(caller)) return { isError: true, output: TOWER_MAIN_AGENT_ONLY };
      return runTowerTool(async () => {
        const ref = args.agent.trim();
        if (args.prompt.trim().length === 0) {
          return { output: 'resume prompt must not be empty — no agent was started', isError: true };
        }
        const state = await host.store().load();
        const { entry } = resolveAgentRef(state, ref);
        if (entry === undefined) {
          if (host.isRetiredAgent(ref)) return { output: resumeRetiredRefusal(ref), isError: true };
          return {
            output: unknownAgentRefusal(ref, knownAgentNames(state, host.listAgents(false))),
            isError: true,
          };
        }
        const info = host.agentInfo(entry.agentId);
        if (isStoppedByUser(entry) || (info !== undefined && isHumanStop(info))) {
          return { output: resumeHumanStoppedRefusal(entry.name), isError: true };
        }
        if (entry.kind === 'reviewer') {
          return { output: resumeReviewerRefusal(entry.name), isError: true };
        }
        if (entry.sessionId !== undefined && entry.sessionId !== host.sessionId) {
          return { output: resumeRetiredRefusal(entry.name), isError: true };
        }
        if (info === undefined) return { output: resumeRestartedRefusal(entry.name), isError: true };
        if (info.status === 'running') {
          return { output: resumeRunningRefusal(entry.name), isError: true };
        }
        const branch =
          entry.branch ??
          entry.reviewTarget ??
          state.missions.find((mission) => mission.id === entry.missionId)?.branch;
        if (branch !== undefined && host.isBranchLeased(branch)) {
          return { output: resumeLeasedRefusal(entry.name, branch), isError: true };
        }
        const result = await host.resumeAgent(entry.agentId, args.prompt);
        if (!result.ok) return { output: result.reason, isError: true };
        const resumed = host.agentInfo(entry.agentId) ?? info;
        return {
          output: [
            `name: ${entry.name}`,
            `kind: ${entry.kind}`,
            `agent_id: ${result.agentId}`,
            `task_id: ${result.taskId}`,
            'status: running (resumed in the background with its full prior context)',
            describeAgentModel(resumed),
            ...(entry.missionId === undefined ? [] : [`mission: ${entry.missionId}`]),
            '',
            workerSpawnGuidance(entry.name),
          ].join('\n'),
        };
      });
    },
  };
}
