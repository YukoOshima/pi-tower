import {
  renderSteerPreview,
  sendDeferredNote,
  sendHandledNote,
  sendSteeredNote,
  sendUndeliveredNote,
  sendUnreachableNote,
} from '../prompts/index.ts';
import {
  BROADCAST_NAME,
  TOWER_NAME,
  type TowerRosterEntry,
  type TowerSendResult,
  type TowerState,
} from '../protocol/index.ts';
import type { TowerSteerResult } from '../tower/runtimeTypes.ts';
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
  const outcome = await steerIntoRunningAgent(host, entry.agentId, item.from, item.subject);
  if (outcome === 'steered') return `\n${sendSteeredNote(item.to)}`;
  if (item.from !== TOWER_NAME) return '';
  return `\n${undeliveredNote(host, entry, item.to, outcome)}`;
}

function undeliveredNote(
  host: TowerToolHost,
  entry: TowerRosterEntry,
  to: string,
  outcome: TowerSteerResult | 'failed',
): string {
  switch (outcome) {
    case 'handled':
      return sendHandledNote(to);
    case 'idle': {
      const info = host.agentInfo(entry.agentId);
      if (info !== undefined && (info.status === 'running' || info.windingDown)) {
        return sendDeferredNote(to, info.windingDown);
      }
      return sendUndeliveredNote(to, entry.kind);
    }
    case 'missing':
      return sendUnreachableNote(to, entry.kind);
    default:
      return sendUndeliveredNote(to, entry.kind);
  }
}

async function steerIntoRunningAgent(
  host: TowerToolHost,
  agentId: string,
  from: string,
  subject: string,
): Promise<TowerSteerResult | 'failed'> {
  try {
    return await host.steerAgent(agentId, renderSteerPreview(from, subject));
  } catch {
    return 'failed';
  }
}
