import {
  selectTowerModeReminder,
  type TowerModeReminder,
  type TowerModeReminderKind,
  type TowerModeReminderMark,
  type TowerObjectivePlaybookVariant,
  type TowerReminderHistoryEntry,
} from '../prompts/index.ts';
import { isTerminalObjectiveStatus, type TowerState } from '../protocol/index.ts';
import { TOWER_REMINDER_MESSAGE } from './constants.ts';

export type TowerReminderTrigger = 'user' | 'custom';

export type TowerReminderObjectiveState = Pick<TowerState, 'objective' | 'objectiveMode'>;

export interface TowerReminderDetails {
  readonly kind: TowerModeReminderKind;
}

interface ContextEntryLike {
  readonly type: string;
  readonly customType?: string;
  readonly details?: unknown;
  readonly message?: { readonly role: string };
}

export interface TowerReminderProjection {
  readonly history: readonly TowerReminderHistoryEntry[];
  readonly last?: TowerModeReminderMark;
}

export function projectReminderHistory(
  entries: readonly ContextEntryLike[],
  trigger: TowerReminderTrigger,
): TowerReminderProjection {
  const history: TowerReminderHistoryEntry[] = [];
  let last: TowerModeReminderMark | undefined;
  for (const entry of entries) {
    if (entry.type === 'custom_message') {
      if (entry.customType === TOWER_REMINDER_MESSAGE) {
        last = { index: history.length, kind: reminderKind(entry.details) };
      }
      history.push({ role: 'user', injected: true });
      continue;
    }
    if (entry.type === 'message' && entry.message !== undefined) {
      const role = entry.message.role;
      history.push(role === 'custom' ? { role: 'user', injected: true } : { role });
      continue;
    }
    history.push({ role: entry.type });
  }
  history.push(trigger === 'user' ? { role: 'user' } : { role: 'user', injected: true });
  return last === undefined ? { history } : { history, last };
}

export function reminderObjectiveVariant(
  state: TowerReminderObjectiveState | undefined,
): TowerObjectivePlaybookVariant | undefined {
  const mode = state?.objectiveMode;
  if (mode === undefined) return undefined;
  const objective = state?.objective;
  if (objective !== undefined && isTerminalObjectiveStatus(objective.status)) return undefined;
  return mode;
}

export function selectReminderForContext(
  active: boolean,
  entries: readonly ContextEntryLike[],
  trigger: TowerReminderTrigger,
  state?: TowerReminderObjectiveState,
): TowerModeReminder | undefined {
  const { history, last } = projectReminderHistory(entries, trigger);
  const objective = reminderObjectiveVariant(state);
  return selectTowerModeReminder({
    active,
    ...(last === undefined ? {} : { last }),
    history,
    ...(objective === undefined ? {} : { objective }),
  });
}

function reminderKind(details: unknown): TowerModeReminderKind {
  const kind =
    typeof details === 'object' && details !== null
      ? (details as { readonly kind?: unknown }).kind
      : undefined;
  return kind === 'sparse' || kind === 'exit' ? kind : 'full';
}
