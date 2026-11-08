import { TOWER_INBOX_DESCRIPTION } from '../../prompts/index.ts';
import { runTowerTool, type TowerCaller, type TowerTool, type TowerToolHost } from '../support.ts';
import { TowerInboxToolInputSchema } from './inbox.ts';

const DEFAULT_LIMIT = 20;

export function createTowerInboxTool(
  host: TowerToolHost,
  caller: TowerCaller,
): TowerTool<typeof TowerInboxToolInputSchema> {
  return {
    name: 'TowerInbox',
    label: 'Tower Inbox',
    description: TOWER_INBOX_DESCRIPTION,
    parameters: TowerInboxToolInputSchema,
    run: (args) =>
      runTowerTool(async () => {
        const store = host.store();
        const state = await store.load();
        const name = store.resolveCallerName(state, caller.agentId);
        const limit = args.limit ?? DEFAULT_LIMIT;
        const items =
          args.include_read === true
            ? await store.readInbox(name, limit)
            : await store.readUnreadInbox(name, limit);
        if (items.length === 0) {
          return { output: `inbox empty for ${name}; 0 unread message(s) remaining` };
        }
        const remaining = await store.ackInbox(
          name,
          items.map((item) => item.messageId),
        );
        const sections = items.map((item) =>
          [
            `file: ${item.file}`,
            `from: ${item.from}`,
            `to: ${item.to}`,
            `subject: ${item.subject}`,
            `sent_at: ${item.sentAt}`,
            ...(item.scope !== undefined ? [`scope: ${item.scope}`] : []),
            ...(item.action !== undefined ? [`action: ${item.action}`] : []),
            '',
            item.body,
          ].join('\n'),
        );
        return {
          output: [
            `${String(items.length)} message(s) for ${name} (newest first):`,
            '',
            sections.join('\n\n---\n\n'),
            '',
            `${String(remaining)} unread message(s) remaining`,
          ].join('\n'),
        };
      }),
  };
}
