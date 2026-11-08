import { TOWER_SEND_DESCRIPTION } from '../../prompts/index.ts';
import { deliverTowerMessage } from '../delivery.ts';
import { runTowerTool, type TowerCaller, type TowerTool, type TowerToolHost } from '../support.ts';
import { TowerSendToolInputSchema } from './send.ts';

export function createTowerSendTool(
  host: TowerToolHost,
  caller: TowerCaller,
): TowerTool<typeof TowerSendToolInputSchema> {
  return {
    name: 'TowerSend',
    label: 'Tower Send',
    description: TOWER_SEND_DESCRIPTION,
    parameters: TowerSendToolInputSchema,
    run: (args) =>
      runTowerTool(async () => {
        const store = host.store();
        const resolved = await store.resolveMessagingCaller(
          await store.loadOrRecover(),
          caller.agentId,
        );
        const sender = resolved.caller;
        const to = args.to.trim();
        const sent = await store.sendDetailed(sender, {
          to,
          subject: args.subject,
          body: args.body,
          ...(args.scope === undefined ? {} : { scope: args.scope }),
          ...(args.action === undefined ? {} : { action: args.action }),
          ...(args.consent_ref === undefined ? {} : { consentRef: args.consent_ref }),
        });
        const delivery = await deliverTowerMessage(host, resolved.state, sent);
        const lines = [`message sent to ${args.to}\nfile: ${sent.item.file}${delivery}`];
        if (resolved.placeholder === true) {
          lines.push(
            `note: the tower state was recovered after a loss, so your roster entry was reconstructed as placeholder "${sender}" — your original name and mission assignment are gone; the recovered state's recoveredAt marker reminds the tower to report the history loss to the user`,
          );
        }
        if (sent.activityLogError !== undefined) {
          lines.push(`activity log error: ${sent.activityLogError}`);
        }
        return {
          output: lines.join('\n'),
          ...(sent.activityLogError === undefined ? {} : { isError: true }),
        };
      }),
  };
}
