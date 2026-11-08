import { describe, expect, it } from 'vitest';

import {
  AGENT_RESULT_PREVIEW_MAX_CHARS,
  REVIEWER_SPAWN_GUIDANCE,
  STEER_SUBJECT_PREVIEW_MAX,
  TOWER_TEARDOWN_PROMPT,
  WAKE_BATCH_LIMIT,
  WAKE_DIGEST_LIMIT,
  WAKE_SUBJECT_PREVIEW_MAX,
  agentNotificationBody,
  formatGateDigestLine,
  formatWallTime,
  renderAgentNotification,
  renderInboxWake,
  renderSpawnResult,
  renderSteerPreview,
  sendSteeredNote,
  sendUndeliveredNote,
  spawnSnapshotNote,
  spawnTaskDescription,
  wakeDigestTargets,
  workerSpawnGuidance,
  worktreeSetupWarning,
  type InboxWakeItem,
  type TowerAgentNotificationInput,
} from '../../src/prompts/index.ts';

function wakeItem(index: number, overrides: Partial<InboxWakeItem> = {}): InboxWakeItem {
  return {
    from: 'w1',
    subject: `subject-${String(index)}`,
    messageId: `msg-${String(index)}`,
    ...overrides,
  };
}

const WORKER_DEATH: TowerAgentNotificationInput = {
  name: 'agent-build',
  agentId: 'agent-7',
  taskId: 'task-1',
  kind: 'worker',
  description: 'M1 agent-build: Build gemm',
  status: 'failed',
  stopReason: 'provider blew up',
  wallTimeMs: 12_345,
};

describe('renderInboxWake', () => {
  it('uses the upstream limits', () => {
    expect(WAKE_SUBJECT_PREVIEW_MAX).toBe(120);
    expect(WAKE_BATCH_LIMIT).toBe(6);
    expect(WAKE_DIGEST_LIMIT).toBe(4);
  });

  it('wakes with a single message reference', () => {
    expect(renderInboxWake({ items: [{ from: 'w1', subject: 'need wider scope' }] })).toBe(
      [
        '1 new tower inbox message — 1 reference(s), omitted=0. Read and route with TowerInbox; this wake does not acknowledge them.',
        '- w1: "need wider scope"',
      ].join('\n'),
    );
  });

  it('lists every reference field that is known', () => {
    const text = renderInboxWake({
      items: [
        {
          from: 'w1',
          subject: 'first update',
          messageId: 'msg-digest-1',
          file: '.tower/comms/inbox/first.md',
          sentAt: '2026-09-30T00:00:00.000Z',
          missionId: 'M1',
        },
        { from: 'w2', subject: 'second update', file: '.tower/comms/inbox/second.md' },
      ],
    });
    expect(text).toContain('2 new tower inbox messages — 2 reference(s), omitted=0.');
    expect(text).toContain(
      '- w1: "first update" (messageId=msg-digest-1, file=.tower/comms/inbox/first.md, sentAt=2026-09-30T00:00:00.000Z, mission=M1)',
    );
    expect(text).toContain('- w2: "second update" (file=.tower/comms/inbox/second.md)');
    expect(text).not.toContain('Gate digest:');
  });

  it('previews long subjects at 120 characters', () => {
    const subject = 's'.repeat(WAKE_SUBJECT_PREVIEW_MAX + 10);
    const text = renderInboxWake({ items: [{ from: 'w1', subject }] });
    expect(text).toContain(`- w1: "${'s'.repeat(WAKE_SUBJECT_PREVIEW_MAX)}…"`);
    expect(text).not.toContain('s'.repeat(WAKE_SUBJECT_PREVIEW_MAX + 1));
  });

  it('bounds references to the six latest while preserving the omitted count', () => {
    const items = Array.from({ length: 8 }, (_, index) => wakeItem(index + 1));
    const text = renderInboxWake({ items });
    expect(text).toContain('8 new tower inbox messages — 6 reference(s), omitted=2.');
    expect(text).not.toContain('messageId=msg-1)');
    expect(text).not.toContain('messageId=msg-2)');
    expect(text).toContain('messageId=msg-3');
    expect(text).toContain('messageId=msg-8');
    expect(text.split('\n').filter((line) => line.startsWith('- w1:'))).toHaveLength(6);
  });

  it('adds caller-reported omissions to the count', () => {
    const text = renderInboxWake({ items: [wakeItem(1), wakeItem(2)], omitted: 3 });
    expect(text).toContain('5 new tower inbox messages — 2 reference(s), omitted=3.');
  });

  it('keeps identical legacy references as separate lines', () => {
    const text = renderInboxWake({
      items: [
        { from: 'w1', subject: 'same legacy subject' },
        { from: 'w1', subject: 'same legacy subject' },
      ],
    });
    expect(text).toContain('2 new tower inbox messages');
    expect(text.match(/- w1: "same legacy subject"/g)).toHaveLength(2);
  });

  it('warns in the wake text when the tower state was recovered after a loss', () => {
    const text = renderInboxWake({
      items: [{ from: 'w1', subject: 'after loss' }],
      recoveredAt: '2026-10-03T00:00:00.000Z',
    });
    expect(text).toContain('recovered after a loss at 2026-10-03T00:00:00.000Z');
    expect(text).toContain('Report the loss to the user');
  });

  it('renders the caller-supplied gate digest after the references', () => {
    const text = renderInboxWake({
      items: [wakeItem(1, { missionId: 'M1' }), wakeItem(2, { missionId: 'M2' })],
      recoveredAt: '2026-10-03T00:00:00.000Z',
      gateDigest: [
        formatGateDigestLine('M1', { ready: false, blocks: [{ reason: 'not-completed' }] }),
        formatGateDigestLine('M2', 'unavailable'),
      ],
      digestOmitted: 2,
    });
    const lines = text.split('\n');
    expect(lines.slice(-5)).toEqual([
      expect.stringContaining('⚠️ Tower state was recovered'),
      'Gate digest:',
      '- M1: gate=BLOCKED reasons=not-completed',
      '- M2: gate=unavailable',
      '- digest-omitted=2',
    ]);
  });
});

describe('wakeDigestTargets', () => {
  it('collects distinct mission ids in arrival order', () => {
    expect(
      wakeDigestTargets([
        wakeItem(1, { missionId: 'M1' }),
        wakeItem(2),
        wakeItem(3, { missionId: 'M1' }),
        wakeItem(4, { missionId: 'M2' }),
      ]),
    ).toEqual({ missionIds: ['M1', 'M2'], omitted: 0 });
  });

  it('limits the digest to four missions and counts the rest', () => {
    const items = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'].map((missionId, index) =>
      wakeItem(index, { missionId }),
    );
    expect(wakeDigestTargets(items)).toEqual({ missionIds: ['M1', 'M2', 'M3', 'M4'], omitted: 2 });
  });

  it('only considers the six references the wake keeps', () => {
    const items = ['M9', 'M1', 'M2', 'M1', 'M2', 'M1', 'M2'].map((missionId, index) =>
      wakeItem(index, { missionId }),
    );
    expect(wakeDigestTargets(items)).toEqual({ missionIds: ['M1', 'M2'], omitted: 0 });
  });
});

describe('formatGateDigestLine', () => {
  it('formats gate outcomes like the upstream wake digest', () => {
    expect(formatGateDigestLine('M1', { ready: true, blocks: [], reviewBinding: 'exact-tip' })).toBe(
      '- M1: gate=READY reasons=none binding=exact-tip',
    );
    expect(formatGateDigestLine('M1', { ready: true, blocks: [] })).toBe('- M1: gate=READY reasons=none');
    expect(
      formatGateDigestLine('M2', {
        ready: false,
        blocks: [{ reason: 'not-completed' }, { reason: 'open-tasks' }],
      }),
    ).toBe('- M2: gate=BLOCKED reasons=not-completed,open-tasks');
    expect(formatGateDigestLine('M3', 'merged')).toBe('- M3: gate=merged');
    expect(formatGateDigestLine('M4', 'abandoned')).toBe('- M4: gate=abandoned');
    expect(formatGateDigestLine('M5', 'mission-missing')).toBe('- M5: gate=mission-missing');
    expect(formatGateDigestLine('M6', 'unavailable')).toBe('- M6: gate=unavailable');
  });
});

describe('steer and delivery notes', () => {
  it('renders the steer preview with a 120-character subject', () => {
    expect(STEER_SUBJECT_PREVIEW_MAX).toBe(120);
    expect(renderSteerPreview('tower', 'URGENT: stop and rebase')).toBe(
      '[tower inbox] new message from tower: "URGENT: stop and rebase" — read it now with TowerInbox and act on it before continuing.',
    );
    expect(renderSteerPreview('tower', 'u'.repeat(130))).toContain(`"${'u'.repeat(120)}…"`);
  });

  it('reports a steered delivery', () => {
    expect(sendSteeredNote('agent-build')).toBe(
      'note: agent-build is mid-turn — the message was steered into its running turn; it sees the directive at its next step boundary.',
    );
  });

  it('points undelivered worker messages at TowerResume', () => {
    expect(sendUndeliveredNote('agent-build', 'worker')).toBe(
      'note: agent-build has no running task in this session — the message sits in its inbox until you deliver it with TowerResume(agent="agent-build", prompt="...")',
    );
  });

  it('never suggests resuming a one-shot reviewer', () => {
    const note = sendUndeliveredNote('reviewer-a', 'reviewer');
    expect(note).toContain('a reviewer is one-shot and is never resumed');
    expect(note).not.toContain('TowerResume');
  });
});

describe('background agent notifications', () => {
  it('formats wall time in seconds', () => {
    expect(formatWallTime(12_345)).toBe('12.345 seconds');
    expect(formatWallTime(-5)).toBe('0.000 seconds');
  });

  it('reports a completed run without recovery guidance', () => {
    expect(
      agentNotificationBody({ ...WORKER_DEATH, status: 'completed', stopReason: undefined }),
    ).toBe('Wall time: 12.345 seconds\nM1 agent-build: Build gemm completed.');
  });

  it('reports a worker death with diagnosis-first TowerResume recovery', () => {
    const body = agentNotificationBody(WORKER_DEATH);
    expect(body).toContain('M1 agent-build: Build gemm failed. Reason: provider blew up');
    expect(body).toContain('Diagnose first: check why it died');
    expect(body).toContain('lost contact, timeout, OOM');
    expect(body).toContain('fixed or escalated to the human before any revive');
    expect(body).toContain(
      'To recover or continue this worker, call TowerResume(agent="agent-build", prompt="Pick up where you left off; redo the last tool call if its result was never observed.").',
    );
    expect(body).toContain('NOT task_id ("task-1")');
    expect(body).toContain('TowerResume always runs it in the background');
    expect(body).toContain('any in-flight tool call lost its result and may need to be redone');
  });

  it('omits the task id warning when the run has no separate task id', () => {
    const body = agentNotificationBody({ ...WORKER_DEATH, taskId: undefined });
    expect(body).toContain('TowerResume(agent="agent-build"');
    expect(body).not.toContain('task_id');
  });

  it('words timeouts and stops like upstream', () => {
    expect(agentNotificationBody({ ...WORKER_DEATH, status: 'timed_out' })).toContain(
      'M1 agent-build: Build gemm timed out.',
    );
    expect(
      agentNotificationBody({ ...WORKER_DEATH, status: 'stopped', stopReason: 'Stopped by TowerTaskStop' }),
    ).toContain('M1 agent-build: Build gemm was stopped. Reason: Stopped by TowerTaskStop');
    expect(agentNotificationBody({ ...WORKER_DEATH, status: 'stopped', stopReason: '  ' })).toContain(
      'M1 agent-build: Build gemm was stopped.\n',
    );
  });

  it('treats a human stop as dead by intent', () => {
    const body = agentNotificationBody({ ...WORKER_DEATH, status: 'stopped', stoppedByHuman: true });
    expect(body).toContain('M1 agent-build: Build gemm was stopped by user.');
    expect(body).toContain(
      'The human stopped this worker, so it is dead by intent: never resume, reassign, or replace it unless the human says otherwise.',
    );
    expect(body).not.toContain('TowerResume');
  });

  it('never suggests resuming a dead reviewer', () => {
    const body = agentNotificationBody({
      ...WORKER_DEATH,
      name: 'reviewer-a',
      kind: 'reviewer',
      description: 'M1 review: feat/build-gemm',
    });
    expect(body).toContain('A reviewer is one-shot — do not resume it or another roster agent');
    expect(body).toContain('spawn a fresh reviewer only if the mission still needs one');
    expect(body).not.toContain('TowerResume');
  });

  it('wraps the body in a notification envelope with escaped attributes', () => {
    const text = renderAgentNotification({ ...WORKER_DEATH, name: 'agent-"x"' });
    const lines = text.split('\n');
    expect(lines[0]).toBe(
      '<notification id="task:task-1:failed" category="task" type="task.failed" source_kind="tower_agent" source_id="task-1" agent_id="agent-7" name="agent-&quot;x&quot;">',
    );
    expect(lines[1]).toBe('Title: Background worker failed');
    expect(lines[2]).toBe('Severity: warning');
    expect(lines[3]).toBe('Wall time: 12.345 seconds');
    expect(lines.at(-1)).toBe('</notification>');
  });

  it('marks completed runs as info and falls back to the agent id as source', () => {
    const text = renderAgentNotification({
      ...WORKER_DEATH,
      taskId: undefined,
      status: 'completed',
      stopReason: undefined,
    });
    expect(text).toContain('id="task:agent-7:completed"');
    expect(text).toContain('source_id="agent-7"');
    expect(text).toContain('Severity: info');
    expect(text).not.toContain('<agent-result');
  });

  it('inlines the escaped final message', () => {
    const text = renderAgentNotification({
      ...WORKER_DEATH,
      status: 'completed',
      result: '  done: a < b && c > d  ',
    });
    expect(text).toContain(
      '<agent-result chars="20" truncated="false">\ndone: a &lt; b &amp;&amp; c &gt; d\n</agent-result>\n</notification>',
    );
  });

  it('previews long final messages and points to TowerTaskOutput', () => {
    expect(AGENT_RESULT_PREVIEW_MAX_CHARS).toBe(8000);
    const text = renderAgentNotification({
      ...WORKER_DEATH,
      status: 'completed',
      result: 'z'.repeat(AGENT_RESULT_PREVIEW_MAX_CHARS + 1),
    });
    expect(text).toContain(`<agent-result chars="${String(AGENT_RESULT_PREVIEW_MAX_CHARS + 1)}" truncated="true">`);
    expect(text).toContain(
      'Showing the first 8000 characters of the final message; read the rest with TowerTaskOutput(agent="agent-build").',
    );
    expect(text).toContain(`${'z'.repeat(AGENT_RESULT_PREVIEW_MAX_CHARS)}\n</agent-result>`);
    expect(text).not.toContain('z'.repeat(AGENT_RESULT_PREVIEW_MAX_CHARS + 1));
  });
});

describe('TowerSpawn result text', () => {
  it('labels spawned agents like upstream task descriptions', () => {
    expect(spawnTaskDescription({ name: 'agent-build', mission: { id: 'M1', title: 'Build gemm' } })).toBe(
      'M1 agent-build: Build gemm',
    );
    expect(
      spawnTaskDescription({ name: 'reviewer-a', reviewTarget: 'feat/build-gemm', reviewMissionId: 'M1' }),
    ).toBe('M1 review: feat/build-gemm');
    expect(spawnTaskDescription({ name: 'reviewer-b', reviewTarget: 'feat/orphan-branch' })).toBe(
      'review reviewer-b: feat/orphan-branch',
    );
  });

  it('renders the worker result with TowerResume recovery guidance', () => {
    const text = renderSpawnResult({
      name: 'agent-build',
      kind: 'worker',
      agentId: 'agent-7',
      taskId: 'task-1',
      model: 'anthropic/claude-sonnet',
      mission: {
        id: 'M1',
        title: 'Build gemm',
        branch: 'feat/build-gemm',
        worktreePath: '/work/repo/.tower/worktrees/wt-1',
      },
      notes: [spawnSnapshotNote('0123456789abcdef')],
    });
    expect(text.split('\n').slice(0, 11)).toEqual([
      'name: agent-build',
      'kind: worker',
      'agent_id: agent-7',
      'task_id: task-1',
      'status: running',
      'model: anthropic/claude-sonnet',
      'mission: M1 — Build gemm',
      'branch: feat/build-gemm',
      'worktree: /work/repo/.tower/worktrees/wt-1',
      "base snapshot: 0123456 — the base checkout had uncommitted changes; they are committed as the branch's first commit (the checkout itself was left untouched)",
      '',
    ]);
    expect(text.endsWith(workerSpawnGuidance('agent-build'))).toBe(true);
  });

  it('renders the reviewer result with one-shot guidance', () => {
    const text = renderSpawnResult({
      name: 'reviewer-a',
      kind: 'reviewer',
      agentId: 'agent-9',
      reviewTarget: 'feat/build-gemm',
    });
    expect(text).toBe(
      [
        'name: reviewer-a',
        'kind: reviewer',
        'agent_id: agent-9',
        'status: running',
        'review_target: feat/build-gemm',
        '',
        REVIEWER_SPAWN_GUIDANCE,
      ].join('\n'),
    );
  });

  it('keeps the worker diagnosis-first guidance', () => {
    const guidance = workerSpawnGuidance('agent-build');
    expect(guidance).toContain('The worker runs detached in the background; its completion arrives as a notification.');
    expect(guidance).toContain('diagnose first: check why it died');
    expect(guidance).toContain('Resume with TowerResume(agent="agent-build", prompt="...")');
    expect(guidance).toContain('lost contact, timeout, OOM');
    expect(guidance).toContain('fixed or escalated to the human before any revive');
    expect(guidance).toContain('A user-stopped worker is never resumed, reassigned, or replaced.');
  });

  it('keeps the reviewer one-shot guidance', () => {
    expect(REVIEWER_SPAWN_GUIDANCE).toContain('A reviewer is one-shot');
    expect(REVIEWER_SPAWN_GUIDANCE).toContain('spawn a fresh reviewer only if the mission still needs one');
    expect(REVIEWER_SPAWN_GUIDANCE).not.toContain('TowerResume');
  });

  it('formats worktree setup warnings', () => {
    expect(worktreeSetupWarning('git worktree add failed')).toBe(
      'worktree setup warning (continuing): git worktree add failed',
    );
  });
});

describe('TOWER_TEARDOWN_PROMPT', () => {
  it('is the upstream /tower teardown prompt', () => {
    expect(TOWER_TEARDOWN_PROMPT).toBe(
      'Tear down the tower: call TowerTeardown and report what it did. It refuses to destroy dirty worktrees unless forced.',
    );
  });
});
