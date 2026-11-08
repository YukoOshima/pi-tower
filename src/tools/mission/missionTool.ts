import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { TOWER_MISSION_DESCRIPTION } from '../../prompts/index.ts';
import {
  MISSIONS_DIR,
  missionFileName,
  type TowerMission,
  type TowerStore,
} from '../../protocol/index.ts';
import { runTowerTool, type TowerCaller, type TowerTool, type TowerToolHost } from '../support.ts';
import { TowerMissionToolInputSchema } from './mission.ts';

export function createTowerMissionTool(
  host: TowerToolHost,
  caller: TowerCaller,
): TowerTool<typeof TowerMissionToolInputSchema> {
  return {
    name: 'TowerMission',
    label: 'Tower Mission',
    description: TOWER_MISSION_DESCRIPTION,
    parameters: TowerMissionToolInputSchema,
    run: (args) => {
      const hasPatch =
        args.status !== undefined ||
        args.note !== undefined ||
        args.blocker !== undefined ||
        args.clear_blockers !== undefined ||
        args.task_done !== undefined ||
        args.task_drop !== undefined ||
        args.scope !== undefined;
      return runTowerTool(async () => {
        const store = host.store();
        const state = await store.load();
        const name = store.resolveCallerName(state, caller.agentId);
        if (!hasPatch) {
          const mission = state.missions.find((m) => m.id === args.id);
          if (mission === undefined) {
            const known = state.missions.map((m) => m.id).join(', ');
            return {
              output: `unknown mission "${args.id}" — known missions: ${known.length > 0 ? known : '(none planned yet)'}`,
              isError: true,
            };
          }
          return { output: await renderMission(store, mission) };
        }
        const mission = await store.updateMission(name, args.id, {
          ...(args.status === undefined ? {} : { status: args.status }),
          ...(args.note === undefined ? {} : { note: args.note }),
          ...(args.blocker === undefined ? {} : { blocker: args.blocker }),
          ...(args.clear_blockers === undefined ? {} : { clearBlockers: args.clear_blockers }),
          ...(args.task_done === undefined ? {} : { taskDone: args.task_done }),
          ...(args.task_drop === undefined
            ? {}
            : {
                taskDrop: {
                  text: args.task_drop,
                  ...(args.task_drop_reason === undefined ? {} : { reason: args.task_drop_reason }),
                },
              }),
          ...(args.scope === undefined ? {} : { scope: args.scope }),
        });
        return {
          output: [
            `mission ${mission.id} updated — status: ${mission.status}, open tasks: ${String(mission.tasks.filter((t) => !t.done && t.dropped !== true).length)}, blockers: ${String(mission.blockers.length)}`,
            '',
            await renderMission(store, mission),
          ].join('\n'),
        };
      });
    },
  };
}

async function renderMission(store: TowerStore, mission: TowerMission): Promise<string> {
  return readFile(store.abs(join(MISSIONS_DIR, missionFileName(mission.id, mission.slug))), 'utf8');
}
