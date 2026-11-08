import { renderSteerPreview, sendSteeredNote, sendUndeliveredNote } from '../prompts/index.ts';
import {
  BROADCAST_NAME,
  TOWER_NAME,
  type TowerSendResult,
  type TowerState,
} from '../protocol/index.ts';
import type { TowerToolHost } from './support.ts';

export async function deliverTowerMessage(
  host: TowerToolHost,
  state: TowerState,
  sent: TowerSendResult,
): Promise<string> {
  const { item } = sent;
  const toTower = item.to === TOWER_NAME || item.to === BROADCAST_NAME;
  if (item.from !== TOWER_NAME && toTower) {
    host.publishInboxSent({
      from: item.from,
      to: item.to,
      subject: item.subject,
      messageId: item.messageId,
      file: item.file,
      sentAt: item.sentAt,
      ...(sent.missionId === undefined ? {} : { missionId: sent.missionId }),
    });
  }
  const entry = toTower ? undefined : state.roster.agents.find((agent) => agent.name === item.to);
  if (entry === undefined) return '';
  const steered = await steerIntoRunningAgent(host, entry.agentId, item.from, item.subject);
  if (steered) return `\n${sendSteeredNote(item.to)}`;
  return item.from === TOWER_NAME ? `\n${sendUndeliveredNote(item.to, entry.kind)}` : '';
}

async function steerIntoRunningAgent(
  host: TowerToolHost,
  agentId: string,
  from: string,
  subject: string,
): Promise<boolean> {
  try {
    return (await host.steerAgent(agentId, renderSteerPreview(from, subject))) === 'steered';
  } catch {
    return false;
  }
}
