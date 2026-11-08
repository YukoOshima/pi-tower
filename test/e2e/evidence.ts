import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Usage } from './report.ts';
import { listFiles, readJsonFile } from './workspace.ts';

export interface RosterEntry {
  readonly name: string;
  readonly agentId: string;
  readonly kind: string;
  readonly missionId?: string;
  readonly reviewTarget?: string;
  readonly worktree?: string;
  readonly branch?: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly deathStatus?: string;
}

export interface MissionRecord {
  readonly id: string;
  readonly title?: string;
  readonly status: string;
  readonly kind?: string;
  readonly branch: string;
  readonly worktree: string;
  readonly owner?: string;
  readonly deps?: readonly string[];
  readonly scope?: readonly string[];
}

export interface TowerState {
  readonly base: string;
  readonly roster: { readonly agents: readonly RosterEntry[] };
  readonly missions: readonly MissionRecord[];
}

export function towerState(repo: string): TowerState | undefined {
  return readJsonFile<TowerState>(join(repo, '.tower', 'comms', 'state.json'));
}

export function rosterEntry(repo: string, name: string): RosterEntry | undefined {
  return towerState(repo)?.roster.agents.find((agent) => agent.name === name);
}

export function activityLog(repo: string): string[] {
  const path = join(repo, '.tower', 'comms', 'log', 'activity.log');
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().length > 0) : [];
}

export function reviewFiles(repo: string): { readonly name: string; readonly text: string }[] {
  const dir = join(repo, '.tower', 'comms', 'reviews');
  return listFiles(dir).map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
}

export function inboxFiles(repo: string): string[] {
  return listFiles(join(repo, '.tower', 'comms', 'inbox'));
}

export function frontmatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  const fields: Record<string, string> = {};
  for (const line of (match?.[1] ?? '').split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return fields;
}

type JsonLine = Record<string, any>;

export function readJsonl(path: string): JsonLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as JsonLine];
      } catch {
        return [];
      }
    });
}

export interface TranscriptSummary {
  readonly path: string;
  readonly cwd: string | undefined;
  readonly modelChanges: readonly string[];
  readonly thinkingLevels: readonly string[];
  readonly assistantModels: readonly string[];
  readonly toolResults: readonly { readonly toolName: string; readonly isError: boolean; readonly text: string }[];
  readonly toolCalls: readonly { readonly name: string; readonly arguments: Record<string, unknown> }[];
  readonly tools: readonly string[];
  readonly firstAt: number;
  readonly lastAt: number;
  readonly usage: Usage;
}

function usageOf(message: JsonLine): Partial<Usage> {
  const usage = message.usage ?? {};
  return {
    input: Number(usage.input ?? 0),
    output: Number(usage.output ?? 0),
    cacheRead: Number(usage.cacheRead ?? 0),
    cacheWrite: Number(usage.cacheWrite ?? 0),
    total: Number(usage.totalTokens ?? 0),
    cost: Number(usage.cost?.total ?? 0),
  };
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block: JsonLine) => (block?.type === 'text' ? String(block.text) : '')).join('');
}

export function summarizeTranscript(path: string): TranscriptSummary {
  const lines = readJsonl(path);
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
  const summary = {
    path,
    cwd: lines.find((line) => line.type === 'session')?.cwd as string | undefined,
    modelChanges: [] as string[],
    thinkingLevels: [] as string[],
    assistantModels: [] as string[],
    toolResults: [] as { toolName: string; isError: boolean; text: string }[],
    toolCalls: [] as { name: string; arguments: Record<string, unknown> }[],
    tools: [] as string[],
    firstAt: Number.POSITIVE_INFINITY,
    lastAt: 0,
    usage,
  };
  for (const line of lines) {
    const at = Date.parse(String(line.timestamp ?? ''));
    if (Number.isFinite(at)) {
      summary.firstAt = Math.min(summary.firstAt, at);
      summary.lastAt = Math.max(summary.lastAt, at);
    }
    if (line.type === 'model_change') summary.modelChanges.push(`${String(line.provider)}/${String(line.modelId)}`);
    if (line.type === 'thinking_level_change') summary.thinkingLevels.push(String(line.thinkingLevel));
    if (line.type !== 'message') continue;
    const message = line.message ?? {};
    if (message.role === 'system') {
      for (const tool of Array.isArray(message.toolsAdded) ? (message.toolsAdded as JsonLine[]) : []) summary.tools.push(String(tool.name));
      for (const tool of Array.isArray(message.toolsRemoved) ? (message.toolsRemoved as JsonLine[]) : []) {
        summary.tools = summary.tools.filter((name) => name !== String(tool.name));
      }
    }
    if (message.role === 'assistant') {
      summary.assistantModels.push(`${String(message.provider)}/${String(message.model)}`);
      const part = usageOf(message);
      usage.input += part.input ?? 0;
      usage.output += part.output ?? 0;
      usage.cacheRead += part.cacheRead ?? 0;
      usage.cacheWrite += part.cacheWrite ?? 0;
      usage.total += part.total ?? 0;
      usage.cost += part.cost ?? 0;
      for (const block of Array.isArray(message.content) ? (message.content as JsonLine[]) : []) {
        if (block?.type === 'toolCall') summary.toolCalls.push({ name: String(block.name), arguments: (block.arguments ?? {}) as Record<string, unknown> });
      }
    }
    if (message.role === 'toolResult') {
      summary.toolResults.push({ toolName: String(message.toolName), isError: message.isError === true, text: contentText(message.content) });
    }
  }
  return summary;
}

export function agentTranscriptPath(repo: string, agentId: string): string | undefined {
  const dir = join(repo, '.tower', 'agents');
  const name = listFiles(dir).find((file) => file.endsWith(`_${agentId}.jsonl`));
  return name === undefined ? undefined : join(dir, name);
}

export function agentTranscripts(repo: string): string[] {
  const dir = join(repo, '.tower', 'agents');
  return listFiles(dir)
    .filter((file) => file.endsWith('.jsonl'))
    .map((file) => join(dir, file));
}

export function distinct<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
