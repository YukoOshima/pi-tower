import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export default function towerFixtureExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'TowerFixtureInit',
    label: 'Tower fixture',
    description: 'Stands in for the pi-tower extension in runtime tests.',
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text', text: 'tower fixture' }], details: {} }),
  });
}
