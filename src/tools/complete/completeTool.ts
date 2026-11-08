import { TOWER_COMPLETE_DESCRIPTION } from '../../prompts/index.ts';
import { deliverTowerMessage } from '../delivery.ts';
import { runTowerTool, type TowerCaller, type TowerTool, type TowerToolHost } from '../support.ts';
import { TOWER_COMPLETE_EMPTY_REPORT, TowerCompleteToolInputSchema } from './complete.ts';

export function createTowerCompleteTool(
  host: TowerToolHost,
  caller: TowerCaller,
): TowerTool<typeof TowerCompleteToolInputSchema> {
  return {
    name: 'TowerComplete',
    label: 'Tower Complete',
    description: TOWER_COMPLETE_DESCRIPTION,
    parameters: TowerCompleteToolInputSchema,
    run: (args) => {
      if (args.report.trim().length === 0) {
        return Promise.resolve({ output: TOWER_COMPLETE_EMPTY_REPORT, isError: true });
      }
      return runTowerTool(async () => {
        const store = host.store();
        const resolved = await store.resolveMessagingCaller(
          await store.loadOrRecover(),
          caller.agentId,
        );
        const result = await store.complete(resolved.caller, args.report.trim());
        const delivery =
          result.message !== undefined
            ? await deliverTowerMessage(host, resolved.state, result.message)
            : '';
        const lines: string[] = [];
        if (result.mission === undefined) {
          lines.push(
            `the tower state was recovered at ${result.recoveredAt ?? 'an unknown time'} after a loss — your mission record is gone, so no mission was marked completed and nothing pretends otherwise`,
          );
          if (result.message !== undefined) {
            lines.push(
              `your report was still delivered to the tower as a ${result.message.item.subject} message: ${result.message.item.file}`,
              result.notificationCreated
                ? 'notification: stored once'
                : 'notification: reused the stored message; no duplicate was written',
            );
          }
        } else {
          lines.push(`mission ${result.mission.id} persisted as ${result.mission.status}`);
          if (result.message !== undefined) {
            lines.push(
              `${result.message.item.subject} notification: ${result.message.item.file}`,
              result.notificationCreated
                ? 'notification: stored once'
                : 'notification: reused the stored message; no duplicate was written',
            );
          }
        }
        if (result.notificationError !== undefined) {
          lines.push(`notification error: ${result.notificationError}`);
        }
        if (result.activityLogError !== undefined) {
          lines.push(`activity log error: ${result.activityLogError}`);
        }
        if (delivery.length > 0) lines.push(delivery);
        return {
          output: lines.join('\n'),
          ...(result.notificationError === undefined && result.activityLogError === undefined
            ? {}
            : { isError: true }),
        };
      });
    },
  };
}
