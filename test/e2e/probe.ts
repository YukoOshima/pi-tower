import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export default function e2eProbe(pi: ExtensionAPI): void {
  pi.registerCommand('e2e-tools', {
    description: 'pi-tower e2e probe: list the registered and the active tools',
    handler: async (_args, ctx) => {
      const active = pi.getActiveTools();
      const registered = pi.getAllTools().map((tool) => tool.name);
      ctx.ui.notify(`e2e-tools active=${active.join(',')} registered=${registered.join(',')}`, 'info');
    },
  });
  if (process.env.PI_TOWER_E2E_PROBE_TODO !== '1') return;
  pi.registerTool({
    name: 'todo_write',
    label: 'todo_write',
    description: 'e2e probe stand-in for a todo-list tool from an installed extension: records the given items and returns ok',
    parameters: Type.Object({ items: Type.Array(Type.String()) }),
    async execute(_toolCallId, params) {
      return { content: [{ type: 'text', text: `todo_write ok: ${params.items.join(', ')}` }], details: {} };
    },
  });
}
