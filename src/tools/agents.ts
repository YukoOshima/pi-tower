import { formatWallTime } from '../prompts/index.ts';
import type { TowerRosterEntry, TowerState } from '../protocol/index.ts';
import { HUMAN_STOP_REASON } from '../tower/constants.ts';
import type { TowerAgentInfo, TowerAgentOutput } from '../tower/runtimeTypes.ts';
import type { TowerToolHost } from './support.ts';

export interface TowerAgentRef {
  readonly id: string;
  readonly entry?: TowerRosterEntry;
}

export async function loadRoster(host: TowerToolHost): Promise<TowerState | undefined> {
  return host
    .store()
    .load()
    .then(
      (state) => state,
      () => undefined,
    );
}

export function resolveAgentRef(state: TowerState | undefined, ref: string): TowerAgentRef {
  const trimmed = ref.trim();
  if (state === undefined) return { id: trimmed };
  const byName = state.roster.agents.find((agent) => agent.name === trimmed);
  if (byName !== undefined) return { id: byName.agentId, entry: byName };
  const byId = state.roster.agents.findLast((agent) => agent.agentId === trimmed);
  return byId === undefined ? { id: trimmed } : { id: byId.agentId, entry: byId };
}

export function knownAgentNames(
  state: TowerState | undefined,
  agents: readonly TowerAgentInfo[],
): string[] {
  return [
    ...new Set([
      ...(state?.roster.agents.map((agent) => agent.name) ?? []),
      ...agents.map((agent) => agent.name),
    ]),
  ];
}

export function isHumanStop(info: Pick<TowerAgentInfo, 'status' | 'stopReason'>): boolean {
  return info.status === 'stopped' && info.stopReason?.trim() === HUMAN_STOP_REASON;
}

export function displayStatus(info: Pick<TowerAgentInfo, 'status' | 'stopReason'>): string {
  if (info.status === 'idle') return 'completed';
  if (isHumanStop(info)) return 'stopped by the human';
  if (info.status === 'timed_out') return 'timed out';
  return info.status;
}

export function describeAgentModel(info: Pick<TowerAgentInfo, 'model' | 'thinkingLevel'>): string {
  if (info.model === undefined) return 'model: (session default)';
  return info.thinkingLevel === undefined
    ? `model: ${info.model}`
    : `model: ${info.model} · thinking: ${info.thinkingLevel}`;
}

export function agentAssignment(
  info: Pick<TowerAgentInfo, 'kind'>,
  entry: TowerRosterEntry | undefined,
): string {
  if (entry === undefined) return info.kind === 'reviewer' ? 'review' : 'mission ?';
  return entry.kind === 'worker'
    ? `mission ${entry.missionId ?? '?'}`
    : `reviewing ${entry.reviewTarget ?? '?'}`;
}

export function agentLine(
  info: TowerAgentInfo,
  entry: TowerRosterEntry | undefined,
  now: number,
): string {
  const reason =
    info.status !== 'running' && info.status !== 'idle' && !isHumanStop(info) && info.stopReason !== undefined
      ? ` (${singleLine(info.stopReason)})`
      : '';
  const elapsed = (info.endedAt ?? now) - info.startedAt;
  return [
    `- ${info.name} (${info.kind ?? entry?.kind ?? 'agent'}) — status: ${displayStatus(info)}${reason}`,
    `agent_id: ${info.agentId}`,
    `task_id: ${info.taskId}`,
    describeAgentModel(info),
    agentAssignment(info, entry),
    `runs: ${String(info.runs)}`,
    `${info.status === 'running' ? 'running for' : 'last run took'} ${formatWallTime(elapsed)}`,
  ].join(', ');
}

export function renderAgentOutput(
  output: TowerAgentOutput,
  entry: TowerRosterEntry | undefined,
  now: number,
): string {
  const lines = [
    `name: ${output.name}`,
    `kind: ${output.kind ?? entry?.kind ?? 'agent'}`,
    `agent_id: ${output.agentId}`,
    `task_id: ${output.taskId}`,
    `status: ${displayStatus(output)}`,
    describeAgentModel(output),
    agentAssignment(output, entry),
    `runs: ${String(output.runs)}`,
    `wall time: ${formatWallTime((output.endedAt ?? now) - output.startedAt)}`,
    `usage: input ${String(output.usage.input)} · output ${String(output.usage.output)} · cache read ${String(output.usage.cacheRead)} · cache write ${String(output.usage.cacheWrite)} · total ${String(output.usage.totalTokens)} tokens · cost $${output.usage.cost.toFixed(4)}`,
  ];
  if (output.stopReason !== undefined && output.status !== 'running') {
    lines.push(`stop reason: ${output.stopReason}`);
  }
  lines.push('', 'recent tool calls:');
  if (output.recentToolCalls.length === 0) {
    lines.push('(none)');
  } else {
    for (const call of output.recentToolCalls) {
      const state = call.endedAt === undefined ? 'running' : call.isError === true ? 'error' : 'ok';
      lines.push(`- ${call.name} ${call.args} — ${state}`);
    }
  }
  if (output.status === 'running') {
    const text = output.streamingText ?? output.lastAssistantText;
    lines.push('', 'latest assistant text:', text ?? '(no assistant text yet)');
  } else {
    lines.push('', 'final message:', output.lastAssistantText ?? '(the run ended without a final message)');
  }
  return lines.join('\n');
}

function singleLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}
