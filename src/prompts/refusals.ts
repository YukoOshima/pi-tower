import type { TowerAgentKind } from '../protocol/types.ts';

export const TOWER_MAIN_AGENT_ONLY =
  'Tower orchestration tools are only supported by the main agent.';

export const TOWER_MODE_USER_ENABLED_ONLY =
  'tower mode is not active — only the user can enable it (with /tower on), never the agent. ' +
  'Ask the user to turn tower mode on, then drive the tower protocol.';

export function todoToolDenied(toolName: string): string {
  return `${toolName} is not available while tower mode is active — mission state lives in the tower protocol (TowerPlan/TowerMission/TowerStatus, MISSIONS.md), and todo semantics would serialize the fleet. Spawn every dependency-unblocked mission now, then end your turn: worker completions wake you.`;
}

export function subagentToolDenied(toolName: string): string {
  return `${toolName} is not available while tower mode is active — subagent delegation and tower mode are mutually exclusive, and the tower fleet runs through TowerSpawn, one mission per worker in its own worktree. If the work genuinely needs subagents instead, exit tower mode first.`;
}

export function duplicateAgentRefusal(
  name: string,
  existing: { readonly agentId: string; readonly kind: TowerAgentKind },
): string {
  return (
    `tower agent "${name}" is already registered (agent_id: ${existing.agentId}, kind: ${existing.kind}) — ` +
    (existing.kind === 'worker'
      ? `resume it instead of spawning a duplicate: TowerResume(agent="${name}", prompt="...")`
      : 'a reviewer is one-shot: diagnose the previous round and spawn a fresh reviewer with a new name instead of resuming a roster agent')
  );
}

export function resumeLeasedRefusal(name: string, branch: string): string {
  return `Cannot resume tower agent "${name}" while branch "${branch}" is leased by a merge/rebase — no agent was started; retry after that operation finishes`;
}

export function resumeRunningRefusal(name: string): string {
  return `tower agent "${name}" is still running — no agent was started; redirect it with TowerSend instead (the message is steered into its running turn at the next step boundary), or stop it with TowerTaskStop first if the directive genuinely cannot wait`;
}

export function resumeReviewerRefusal(name: string): string {
  return `tower agent "${name}" is a reviewer — no agent was started; a reviewer is one-shot: diagnose the previous round and spawn a fresh reviewer with a new name instead of resuming a roster agent`;
}

export function resumeHumanStoppedRefusal(name: string): string {
  return `tower agent "${name}" was stopped by the human — no agent was started; an agent stopped by the human is dead by intent: never resume, reassign, or replace it unless the human says otherwise`;
}

export function resumeRetiredRefusal(name: string): string {
  return `tower agent "${name}" was spawned by a previous session and is retired — no agent was started; agent ids cannot be resumed across sessions, so spawn a new worker for its mission with TowerSpawn`;
}

export function unknownAgentRefusal(ref: string, known: readonly string[]): string {
  return `unknown tower agent "${ref}" — known agents: ${known.length > 0 ? known.join(', ') : '(none spawned yet)'}`;
}
