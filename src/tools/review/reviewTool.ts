import { TOWER_REVIEW_DESCRIPTION } from '../../prompts/index.ts';
import { deliverTowerMessage } from '../delivery.ts';
import { runTowerTool, type TowerCaller, type TowerTool, type TowerToolHost } from '../support.ts';
import { TowerReviewToolInputSchema } from './review.ts';

export function createTowerReviewTool(
  host: TowerToolHost,
  caller: TowerCaller,
): TowerTool<typeof TowerReviewToolInputSchema> {
  return {
    name: 'TowerReview',
    label: 'Tower Review',
    description: TOWER_REVIEW_DESCRIPTION,
    parameters: TowerReviewToolInputSchema,
    run: (args) =>
      runTowerTool(async () => {
        const store = host.store();
        const state = await store.load();
        const name = store.resolveCallerName(state, caller.agentId);
        const result = await store.submitReview(name, {
          target: args.target,
          status: args.status,
          merge: args.merge,
          findings: args.findings,
          ...(args.checks === undefined ? {} : { checks: args.checks }),
          decision: args.decision,
        });
        const deliveries: string[] = [];
        for (const message of result.storedMessages) {
          deliveries.push(await deliverTowerMessage(host, state, message));
        }
        const delivery = deliveries.join('');
        const notified = result.storedMessages.map((message) => message.item.to);
        const lines = [
          `review submitted: ${result.review.file}`,
          `notified: ${notified.length > 0 ? notified.join(', ') : '(none)'}`,
        ];
        if (result.notificationError !== undefined) {
          lines.push(`notification error: ${result.notificationError}`);
        }
        if (result.activityLogError !== undefined) {
          lines.push(`activity log error: ${result.activityLogError}`);
        }
        if (args.status === 'clean' && args.merge === 'merge') {
          lines.push(
            `next: ${args.target} is merge-ready — the tower can TowerMerge it in Dependency Flow order.`,
          );
        } else if (args.status === 'clean') {
          lines.push(
            args.merge === 'hold'
              ? `next: ${args.target} is blocked by the latest review's "hold" verdict — the merge gate rejects it; do not TowerMerge until a later clean review with merge verdict "merge" supersedes it.`
              : `next: ${args.target} is not merge-approved — "fix-then-merge" is not approval; the merge gate requires a clean review with merge verdict "merge" before TowerMerge.`,
          );
        } else {
          lines.push(
            `next: ${args.target} is not merge-ready — the gate requires a clean review with merge verdict "merge" on the exact tip; the author must fix and re-review.`,
          );
        }
        if (delivery.length > 0) lines.push(delivery);
        return {
          output: lines.join('\n'),
          ...(result.notificationError === undefined && result.activityLogError === undefined
            ? {}
            : { isError: true }),
        };
      }),
  };
}
