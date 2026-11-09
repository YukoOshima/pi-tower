import { describe, expect, it } from 'vitest';

import {
  TOWER_MAIN_AGENT_ONLY,
  TOWER_MODE_USER_ENABLED_ONLY,
  duplicateAgentRefusal,
  resumeHumanStoppedRefusal,
  resumeLeasedRefusal,
  resumeRetiredRefusal,
  resumeReviewerRefusal,
  resumeRunningRefusal,
  subagentToolDenied,
  todoToolDenied,
  unknownAgentRefusal,
} from '../../src/prompts/index.ts';

describe('tower tool refusals', () => {
  it('keeps the upstream main-agent and user-enabled refusals', () => {
    expect(TOWER_MAIN_AGENT_ONLY).toBe('Tower orchestration tools are only supported by the main agent.');
    expect(TOWER_MODE_USER_ENABLED_ONLY).toBe(
      'tower mode is not active — only the user can enable it (with /mission or /tower on), never the agent. Ask the user to turn tower mode on, then drive the tower protocol.',
    );
  });

  it('denies todo tools while tower mode is active', () => {
    expect(todoToolDenied('todo')).toBe(
      'todo is not available while tower mode is active — mission state lives in the tower protocol (TowerPlan/TowerMission/TowerStatus, MISSIONS.md), and todo semantics would serialize the fleet. Spawn every dependency-unblocked mission now, then end your turn: worker completions wake you.',
    );
  });

  it('denies subagent tools while tower mode is active', () => {
    const text = subagentToolDenied('subagent');
    expect(text.startsWith('subagent is not available while tower mode is active')).toBe(true);
    expect(text).toContain('the tower fleet runs through TowerSpawn, one mission per worker in its own worktree');
    expect(text).toContain('exit tower mode first');
  });

  it('routes a duplicate worker name to TowerResume', () => {
    const text = duplicateAgentRefusal('agent-old', { agentId: 'agent-3', kind: 'worker' });
    expect(text).toBe(
      'tower agent "agent-old" is already registered (agent_id: agent-3, kind: worker) — resume it instead of spawning a duplicate: TowerResume(agent="agent-old", prompt="...")',
    );
  });

  it('never routes a duplicate reviewer name to a resume', () => {
    const text = duplicateAgentRefusal('reviewer-a', { agentId: 'agent-4', kind: 'reviewer' });
    expect(text).toContain('already registered');
    expect(text).toContain('a reviewer is one-shot');
    expect(text).toContain('spawn a fresh reviewer with a new name');
    expect(text).not.toContain('TowerResume');
  });

  it('refuses TowerResume during a merge/rebase lease', () => {
    expect(resumeLeasedRefusal('agent-build', 'feat/build-gemm')).toBe(
      'Cannot resume tower agent "agent-build" while branch "feat/build-gemm" is leased by a merge/rebase — no agent was started; retry after that operation finishes',
    );
  });

  it('refuses TowerResume for running, reviewer, human-stopped, and retired agents', () => {
    expect(resumeRunningRefusal('agent-build')).toContain('is still running — no agent was started');
    expect(resumeRunningRefusal('agent-build')).toContain('redirect it with TowerSend instead');
    expect(resumeReviewerRefusal('reviewer-a')).toContain('a reviewer is one-shot');
    expect(resumeHumanStoppedRefusal('agent-build')).toContain(
      'an agent stopped by the human is dead by intent: never resume, reassign, or replace it unless the human says otherwise',
    );
    expect(resumeRetiredRefusal('agent-build')).toContain('agent ids cannot be resumed across sessions');
    expect(resumeRetiredRefusal('agent-build')).toContain('spawn a new worker for its mission with TowerSpawn');
  });

  it('lists the known agents for an unknown agent reference', () => {
    expect(unknownAgentRefusal('agent-x', ['agent-build', 'reviewer-a'])).toBe(
      'unknown tower agent "agent-x" — known agents: agent-build, reviewer-a',
    );
    expect(unknownAgentRefusal('agent-x', [])).toBe(
      'unknown tower agent "agent-x" — known agents: (none spawned yet)',
    );
  });
});
