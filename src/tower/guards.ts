import { join } from 'node:path';

import {
  isToolCallEventType,
  type InlineExtension,
  type ToolCallEvent,
  type ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';

import {
  analyzeTowerBashCommand,
  commandNeedsTowerGuard,
  findWriteEscapes,
  towerWorkspaceOwned,
  VALIDATOR_WRITE_VETO,
  writeGuardVeto,
} from '../guards/index.ts';
import { STATE_FILE, TowerStore, WORKTREES_DIR, resolveTowerRepoRoot } from '../protocol/index.ts';

export const TOWER_AGENT_GUARDS_EXTENSION = 'pi-tower-guards';

export interface TowerAgentGuardTarget {
  readonly agentId: string;
  readonly kind: string | undefined;
  readonly cwd: string;
  readonly repoRoot: () => string;
}

export async function towerBashGuard(
  event: ToolCallEvent,
  cwd: string,
): Promise<ToolCallEventResult | undefined> {
  if (!isToolCallEventType('bash', event)) return undefined;
  const command: unknown = event.input.command;
  if (typeof command !== 'string' || !commandNeedsTowerGuard(command)) return undefined;
  const mainCheckout = resolveTowerRepoRoot(cwd);
  if (!(await towerWorkspaceOwned(join(mainCheckout, STATE_FILE)))) return undefined;
  const reason = analyzeTowerBashCommand({ command, cwd, mainCheckout });
  return reason === undefined ? undefined : { block: true, reason };
}

export async function towerWriteGuard(
  event: ToolCallEvent,
  cwd: string,
  target: TowerAgentGuardTarget,
): Promise<ToolCallEventResult | undefined> {
  if (!isToolCallEventType('write', event) && !isToolCallEventType('edit', event)) return undefined;
  if (target.kind === 'validator') return { block: true, reason: VALIDATOR_WRITE_VETO };
  if (target.kind !== 'worker') return undefined;
  const path: unknown = event.input.path;
  if (typeof path !== 'string') return undefined;
  const worktree = (await rosterWorktree(target)) ?? target.cwd;
  const escapes = findWriteEscapes([path], worktree, cwd);
  return escapes.length === 0 ? undefined : { block: true, reason: writeGuardVeto(worktree, escapes) };
}

export function towerAgentGuards(target: TowerAgentGuardTarget): InlineExtension {
  return {
    name: TOWER_AGENT_GUARDS_EXTENSION,
    hidden: true,
    factory: (pi) => {
      pi.on('tool_call', async (event, ctx) => {
        return (await towerBashGuard(event, ctx.cwd)) ?? (await towerWriteGuard(event, ctx.cwd, target));
      });
    },
  };
}

async function rosterWorktree(target: TowerAgentGuardTarget): Promise<string | undefined> {
  try {
    const store = new TowerStore(target.repoRoot());
    const entry = store.resolveAgent(await store.load(), target.agentId);
    return entry?.worktree === undefined ? undefined : store.abs(join(WORKTREES_DIR, entry.worktree));
  } catch {
    return undefined;
  }
}
