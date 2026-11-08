import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function e2eProbe(pi: ExtensionAPI): void {
  pi.registerCommand('e2e-tools', {
    description: 'pi-tower e2e probe: list the registered and the active tools',
    handler: async (_args, ctx) => {
      const active = pi.getActiveTools();
      const registered = pi.getAllTools().map((tool) => tool.name);
      ctx.ui.notify(`e2e-tools active=${active.join(',')} registered=${registered.join(',')}`, 'info');
    },
  });
}
