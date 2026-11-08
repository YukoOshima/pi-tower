import { describe, expect, it } from 'vitest';

import {
  TOWER_CODER_ROLE,
  TOWER_TASK_AGENT_ROLE_PREFIX,
  TOWER_WORKER_ROLE,
  TOWER_WORKER_ROLE_OVERLAY,
} from '../../src/prompts/index.ts';

describe('tower worker role', () => {
  it('keeps the upstream task-agent prefix', () => {
    expect(TOWER_TASK_AGENT_ROLE_PREFIX).toBe(
      'You are a subagent; the main agent is your caller and all `user` messages come from it. The main agent sees only your final message. Do not ask the end user questions; explain ambiguities in your final handoff.',
    );
  });

  it('keeps the upstream coder handoff contract', () => {
    expect(TOWER_CODER_ROLE).toBe(
      `${TOWER_TASK_AGENT_ROLE_PREFIX}\n\nYour final message is the entire handoff. Make it technically complete: what you changed and why, the path of every file you touched, how you verified the change (tests or commands run, with results), and anything left undone or worth follow-up. If you are stopped before finishing, the parent receives only what you have written so far, so keep the handoff current.`,
    );
  });

  it('keeps the protocol paragraph of the overlay verbatim', () => {
    expect(TOWER_WORKER_ROLE_OVERLAY.split('\n\n')[0]).toBe(
      'You are a tower worker/reviewer in a multi-agent tower workspace. All collaboration protocol traffic (inbox messages, findings, reviews, mission updates) goes through the Tower* tools ONLY — never create, edit, or delete protocol artifacts under `.tower/comms/` by hand; hand-written protocol files break the merge gate. Your TowerSpawn briefing names your mission (worker) or review target (reviewer) — stay inside it.',
    );
  });

  it('adapts responsiveness to pi steering and the foreground-only bash tool', () => {
    for (const sentence of [
      'Stay responsive while you work.',
      'are steered into your current turn as injected user messages: they arrive at the next step boundary, once your in-flight tool calls finish',
      'read TowerInbox and act on it then instead of deferring it',
      'The bash tool has no background mode, so a command holds your turn — and any steered message — until it exits.',
      'give each long bash command a `timeout` (in seconds) so a hung command cannot stall you',
      'check TowerInbox between long steps so you remain responsive to steered messages',
      'A command you cannot retry safely when interrupted gets a timeout generous enough to finish, and you check TowerInbox immediately after it.',
    ]) {
      expect(TOWER_WORKER_ROLE_OVERLAY).toContain(sentence);
    }
    expect(TOWER_WORKER_ROLE_OVERLAY).not.toContain('run_in_background');
    expect(TOWER_WORKER_ROLE_OVERLAY).not.toContain('WaitFor');
  });

  it('composes the full worker role from the coder role and the overlay', () => {
    expect(TOWER_WORKER_ROLE).toBe(`${TOWER_CODER_ROLE}\n\n${TOWER_WORKER_ROLE_OVERLAY}`);
  });
});
