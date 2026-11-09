import { describe, expect, it } from 'vitest';

import {
  REVIEWER_SPAWN_GUIDANCE,
  TOWER_TASK_AGENT_ROLE_PREFIX,
  TOWER_VALIDATOR_ROLE,
  TOWER_VALIDATOR_ROLE_OVERLAY,
  TOWER_WORKER_ROLE_OVERLAY,
  VALIDATOR_SPAWN_GUIDANCE,
  agentNotificationBody,
  duplicateAgentRefusal,
  renderAgentNotification,
  renderSpawnResult,
  sendUndeliveredNote,
  sendUnreachableNote,
  spawnTaskDescription,
  undeliveredSteersSection,
  type PromptAgentKind,
} from '../../src/prompts/index.ts';
import { resumeValidatorRefusal } from '../../src/prompts/validatorNotes.ts';

type WidenedTowerAgentKind = 'worker' | 'reviewer' | 'validator';

const VALIDATOR = {
  name: 'validator-ms1-scrutiny-r2',
  agentId: 'agent-11',
  taskId: 'task-11',
  kind: 'validator' as const,
  description: 'MS1 scrutiny validation r2: validator-ms1-scrutiny-r2',
  status: 'failed' as const,
  stopReason: 'model error',
  wallTimeMs: 2000,
};

describe('validator kind alias', () => {
  it('accepts the widened agent kind union', () => {
    const kinds: readonly WidenedTowerAgentKind[] = ['worker', 'reviewer', 'validator'];
    const accepted: readonly PromptAgentKind[] = kinds;
    expect(accepted).toEqual(kinds);
  });
});

describe('delivery notes for validators', () => {
  it('never suggests resuming a validator', () => {
    const note = sendUndeliveredNote('validator-ms1-scrutiny-r2', 'validator');
    expect(note).toBe(
      "note: validator-ms1-scrutiny-r2 has no running task in this session — the message sits in its inbox; a validator is one-shot and is never resumed, so this input does not reach its round — a later validation round sees only what its briefing carries (the objective, the milestone and its features' tasks, earlier failures)",
    );
    expect(note).not.toContain('TowerResume');
    expect(sendUnreachableNote('validator-ms1-scrutiny-r2', 'validator')).toBe(note);
  });

  it('routes undelivered steers to the next round', () => {
    expect(undeliveredSteersSection({ ...VALIDATOR, undeliveredSteers: ['check the CSV header'] })).toBe(
      [
        'Undelivered steers: 1 steered message(s) never reached validator-ms1-scrutiny-r2 before its run ended — they sit only in its inbox:',
        '- check the CSV header',
        "A validator is one-shot and is never resumed, so these messages do not reach its round — a later validation round sees only what its briefing carries (the objective, the milestone and its features' tasks, earlier failures).",
      ].join('\n'),
    );
  });
});

describe('spawn texts for validators', () => {
  it('labels the background task by milestone, kind, and round', () => {
    expect(
      spawnTaskDescription({
        name: 'validator-ms1-scrutiny-r2',
        validation: { milestoneId: 'MS1', validationKind: 'scrutiny', round: 2 },
      }),
    ).toBe('MS1 scrutiny validation r2: validator-ms1-scrutiny-r2');
    expect(
      spawnTaskDescription({ name: 'v', validation: { milestoneId: 'MS2', validationKind: 'user-testing' } }),
    ).toBe('MS2 user-testing validation: v');
  });

  it('renders the validator spawn result with one-shot guidance', () => {
    const text = renderSpawnResult({
      name: 'validator-ms1-scrutiny-r2',
      kind: 'validator',
      agentId: 'agent-11',
      taskId: 'task-11',
      validation: {
        milestoneId: 'MS1',
        validationKind: 'scrutiny',
        round: 2,
        validatedCommit: 'c0ffee1234',
        worktreePath: '/repo/.tower/worktrees/val-ms1-scrutiny-r2',
      },
    });
    expect(text).toBe(
      [
        'name: validator-ms1-scrutiny-r2',
        'kind: validator',
        'agent_id: agent-11',
        'task_id: task-11',
        'status: running',
        'milestone: MS1',
        'validation: scrutiny r2',
        'validated_commit: c0ffee1234',
        'worktree: /repo/.tower/worktrees/val-ms1-scrutiny-r2',
        '',
        VALIDATOR_SPAWN_GUIDANCE,
      ].join('\n'),
    );
    expect(text).not.toContain('review_target');
    expect(VALIDATOR_SPAWN_GUIDANCE).toContain('A validator is one-shot — never resume it');
    expect(VALIDATOR_SPAWN_GUIDANCE).toContain('A user-stopped validator is never replaced.');
  });

  it('prints no empty review target for a validator without a validation target', () => {
    expect(renderSpawnResult({ name: 'v', kind: 'validator', agentId: 'agent-12' })).toBe(
      ['name: v', 'kind: validator', 'agent_id: agent-12', 'status: running', '', VALIDATOR_SPAWN_GUIDANCE].join('\n'),
    );
  });

  it('keeps the reviewer spawn result for reviewers', () => {
    const text = renderSpawnResult({ name: 'reviewer-a', kind: 'reviewer', agentId: 'agent-9', reviewTarget: 'feat/x' });
    expect(text.endsWith(`review_target: feat/x\n\n${REVIEWER_SPAWN_GUIDANCE}`)).toBe(true);
  });
});

describe('background notifications for validators', () => {
  it('diagnoses a validator death without suggesting a resume', () => {
    const body = agentNotificationBody(VALIDATOR);
    expect(body).toContain(`${VALIDATOR.description} failed. Reason: model error`);
    expect(body).toContain('A validator is one-shot — do not resume it.');
    expect(body).toContain('Its round produced no verdict, so the milestone still needs one');
    expect(body).toContain('wakes you with validation-stuck if validators keep ending without a verdict');
    expect(body).not.toContain('TowerResume');
  });

  it('treats a tower stop and a human stop correctly', () => {
    expect(agentNotificationBody({ ...VALIDATOR, status: 'stopped', stoppedByTower: true, stopReason: undefined })).toContain(
      'The tower stopped this validator on purpose with TowerTaskStop. A validator is one-shot — do not resume it',
    );
    expect(agentNotificationBody({ ...VALIDATOR, status: 'stopped', stoppedByHuman: true })).toContain(
      'The human stopped this validator, so it is dead by intent: never resume, reassign, or replace it unless the human says otherwise.',
    );
  });

  it('adds no recovery guidance to a completed run and titles the envelope', () => {
    expect(agentNotificationBody({ ...VALIDATOR, status: 'completed', stopReason: undefined })).toBe(
      `Wall time: 2.000 seconds\n${VALIDATOR.description} completed.`,
    );
    expect(renderAgentNotification(VALIDATOR)).toContain('Title: Background validator failed');
  });
});

describe('refusals for validators', () => {
  it('refuses a duplicate validator name without suggesting a resume', () => {
    expect(duplicateAgentRefusal('validator-ms1-scrutiny-r2', { agentId: 'agent-11', kind: 'validator' })).toBe(
      'tower agent "validator-ms1-scrutiny-r2" is already registered (agent_id: agent-11, kind: validator) — a validator is one-shot: every validation round gets a fresh validator with a new name instead of a reused roster agent',
    );
  });

  it('refuses to resume a validator', () => {
    expect(resumeValidatorRefusal('validator-ms1-scrutiny-r2')).toBe(
      'tower agent "validator-ms1-scrutiny-r2" is a validator — no agent was started; a validator is one-shot: the tower re-runs its round with a fresh validator under a new name — spawn one yourself with TowerSpawn(kind="validator") only to recover a validation-stuck round',
    );
  });
});

describe('validator role', () => {
  it('composes the task-agent prefix, a verdict handoff, and the validator overlay', () => {
    expect(TOWER_VALIDATOR_ROLE.startsWith(`${TOWER_TASK_AGENT_ROLE_PREFIX}\n\nYour final message is the entire handoff.`)).toBe(true);
    expect(TOWER_VALIDATOR_ROLE.endsWith(`\n\n${TOWER_VALIDATOR_ROLE_OVERLAY}`)).toBe(true);
    expect(TOWER_VALIDATOR_ROLE).toContain('the verdict you submitted and its number of failures');
    expect(TOWER_VALIDATOR_ROLE).not.toContain('the path of every file you touched');
  });

  it('keeps validators read-only and shares the responsiveness rules with workers', () => {
    expect(TOWER_VALIDATOR_ROLE_OVERLAY).toContain('You are a tower validator in a multi-agent tower workspace.');
    expect(TOWER_VALIDATOR_ROLE_OVERLAY).toContain('never edit tracked files, never commit');
    expect(TOWER_VALIDATOR_ROLE_OVERLAY).toContain('submit your verdict exactly once with TowerValidate');
    const shared = TOWER_WORKER_ROLE_OVERLAY.split('\n\n')[1];
    expect(shared?.startsWith('Stay responsive while you work.')).toBe(true);
    expect(TOWER_VALIDATOR_ROLE_OVERLAY.endsWith(`\n\n${shared ?? ''}`)).toBe(true);
  });
});
