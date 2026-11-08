import { TOWER_FINDING_DESCRIPTION } from '../../prompts/index.ts';
import { runTowerTool, type TowerCaller, type TowerTool, type TowerToolHost } from '../support.ts';
import { TowerFindingToolInputSchema } from './finding.ts';

export function createTowerFindingTool(
  host: TowerToolHost,
  caller: TowerCaller,
): TowerTool<typeof TowerFindingToolInputSchema> {
  return {
    name: 'TowerFinding',
    label: 'Tower Finding',
    description: TOWER_FINDING_DESCRIPTION,
    parameters: TowerFindingToolInputSchema,
    run: (args) =>
      runTowerTool(async () => {
        const store = host.store();
        const state = await store.load();
        const name = store.resolveCallerName(state, caller.agentId);
        const rel = await store.fileFinding(name, {
          type: args.type,
          title: args.title,
          ...(args.severity === undefined ? {} : { severity: args.severity }),
          summary: args.summary,
          ...(args.location === undefined ? {} : { location: args.location }),
          details: args.details,
          suggestedFix: args.suggested_fix,
        });
        return {
          output: `finding filed: ${rel}\nThe tower will route it — do not fix out-of-scope issues yourself.`,
        };
      }),
  };
}
