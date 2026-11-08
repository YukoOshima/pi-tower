import { subagentToolDenied, todoToolDenied } from '../prompts/index.ts';

export const TOWER_VETOED_TODO_TOOLS: readonly string[] = ['todo', 'todo_write', 'TodoWrite', 'TodoList'];

export const TOWER_VETOED_SUBAGENT_TOOLS: readonly string[] = ['subagent', 'AgentSwarm'];

export function towerModeVeto(toolName: string): string | undefined {
  if (TOWER_VETOED_TODO_TOOLS.includes(toolName)) return todoToolDenied(toolName);
  if (TOWER_VETOED_SUBAGENT_TOOLS.includes(toolName)) return subagentToolDenied(toolName);
  return undefined;
}
