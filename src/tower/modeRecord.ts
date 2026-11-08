import { TOWER_MODE_ENTRY } from './constants.ts';

export interface TowerSessionModel {
  readonly provider: string;
  readonly modelId: string;
}

export interface TowerModeRecord {
  readonly active: boolean;
  readonly sessionId?: string;
  readonly pid?: number;
  readonly previousModel?: TowerSessionModel;
  readonly previousThinkingLevel?: string;
  readonly orchestratorModel?: TowerSessionModel;
}

interface SessionEntryLike {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}

export function latestTowerModeRecord(
  entries: readonly SessionEntryLike[],
): TowerModeRecord | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== 'custom' || entry.customType !== TOWER_MODE_ENTRY) continue;
    const record = parseTowerModeRecord(entry.data);
    if (record !== undefined) return record;
  }
  return undefined;
}

export function parseTowerModeRecord(data: unknown): TowerModeRecord | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const raw = data as Record<string, unknown>;
  if (typeof raw['active'] !== 'boolean') return undefined;
  const previousModel = parseSessionModel(raw['previousModel']);
  const orchestratorModel = parseSessionModel(raw['orchestratorModel']);
  return {
    active: raw['active'],
    ...(typeof raw['sessionId'] === 'string' ? { sessionId: raw['sessionId'] } : {}),
    ...(typeof raw['pid'] === 'number' ? { pid: raw['pid'] } : {}),
    ...(previousModel === undefined ? {} : { previousModel }),
    ...(typeof raw['previousThinkingLevel'] === 'string'
      ? { previousThinkingLevel: raw['previousThinkingLevel'] }
      : {}),
    ...(orchestratorModel === undefined ? {} : { orchestratorModel }),
  };
}

function parseSessionModel(value: unknown): TowerSessionModel | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  return typeof raw['provider'] === 'string' && typeof raw['modelId'] === 'string'
    ? { provider: raw['provider'], modelId: raw['modelId'] }
    : undefined;
}
