import { TOWER_MAIN_AGENT_ONLY, TOWER_TEARDOWN_DESCRIPTION } from '../../prompts/index.ts';
import { TowerProtocolError } from '../../protocol/index.ts';
import { ownerLabel } from '../init/initTool.ts';
import {
  isMainAgent,
  runTowerTool,
  type TowerCaller,
  type TowerTool,
  type TowerToolHost,
} from '../support.ts';
import { TowerTeardownToolInputSchema } from './teardown.ts';

export function createTowerTeardownTool(
  host: TowerToolHost,
  caller: TowerCaller,
): TowerTool<typeof TowerTeardownToolInputSchema> {
  return {
    name: 'TowerTeardown',
    label: 'Tower Teardown',
    description: TOWER_TEARDOWN_DESCRIPTION,
    parameters: TowerTeardownToolInputSchema,
    async run(args) {
      if (!isMainAgent(caller)) return { isError: true, output: TOWER_MAIN_AGENT_ONLY };
      return runTowerTool(async () => {
        const store = host.store();
        const prior = await store.load().then(
          (state) => ({ sessionId: state.sessionId, pid: state.ownerPid }),
          () => undefined,
        );
        if (
          prior?.sessionId !== undefined &&
          prior.sessionId !== host.sessionId &&
          host.isOwnerLive(prior)
        ) {
          throw new TowerProtocolError(
            `tower workspace is owned by a live session (${ownerLabel(prior.sessionId, prior.pid)}) — tearing it down would dismantle that session's fleet. Use TowerTeardown from that session, or close it first.`,
          );
        }
        const report = await store.teardown({
          ...(args.force === undefined ? {} : { force: args.force }),
          ...(args.exclude === undefined ? {} : { exclude: args.exclude }),
          ...(args.dry_run === undefined ? {} : { dryRun: args.dry_run }),
          liveAgentIds: host.activeAgentIds(),
        });
        return {
          output: [
            args.dry_run === true
              ? 'tower teardown (dry run — nothing was changed):'
              : 'tower teardown:',
            ...report.map((line) => `- ${line}`),
            '',
            'Tower mode stays active — the next objective starts with TowerInit, and the human can turn the mode off with /tower off. .tower/comms/ (state, inbox, findings, reviews, activity log) is kept as the audit trail — remove it by hand only if you are sure.',
          ].join('\n'),
        };
      });
    },
  };
}
