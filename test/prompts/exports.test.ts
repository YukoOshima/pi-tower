import { describe, expect, it } from 'vitest';

import * as briefings from '../../src/prompts/briefings.ts';
import * as prompts from '../../src/prompts/index.ts';
import * as notifications from '../../src/prompts/notifications.ts';
import * as parameterDescriptions from '../../src/prompts/parameterDescriptions.ts';
import * as refusals from '../../src/prompts/refusals.ts';
import * as reminders from '../../src/prompts/reminders.ts';
import * as toolDescriptions from '../../src/prompts/toolDescriptions.ts';
import * as workerRole from '../../src/prompts/workerRole.ts';
import type { TowerInboxItem } from '../../src/protocol/types.ts';

const KIMI_ONLY: readonly RegExp[] = [
  /Agent\(resume/,
  /(?<![A-Za-z])TaskList(?![A-Za-z])/,
  /(?<![A-Za-z])TaskOutput(?![A-Za-z])/,
  /(?<![A-Za-z])TaskStop(?![A-Za-z])/,
  /kimi-file:\/\//,
  /secondary_model/,
  /secondary-pool/,
  /run_in_background/,
  /(?<![A-Za-z])WaitFor(?![A-Za-z])/,
  /AskUserQuestion/,
  /AgentSwarm/,
  /TodoList/,
  /CreateGoal|UpdateGoal/,
  /NotifyUser|WebSearch/,
  /Read\/Write\/Edit/,
  /(?<![A-Za-z])Glob(?![A-Za-z])/,
  /kimi/i,
];

const INBOX: readonly TowerInboxItem[] = [
  {
    messageId: 'msg-1',
    file: '.tower/comms/inbox/msg-1.md',
    from: 'agent-build',
    to: 'tower',
    subject: 'review-request',
    sentAt: '2026-11-08T00:00:00.000Z',
    body: 'Built the kernel.',
  },
];

const MISSION = {
  id: 'M1',
  kind: 'build' as const,
  branch: 'feat/build-gemm',
  scope: ['src/**'],
  owner: 'agent-build',
  spawnBase: '0123456789',
};

const REVIEW = { round: 1, reviewer: 'rev', status: 'p1-1items', merge: 'hold', body: 'leak' };

const WORKER_INPUT = {
  name: 'agent-build-2',
  mission: MISSION,
  missionText: '# Mission M1: Build gemm',
  worktreePath: '/repo/.tower/worktrees/wt-1',
  repoRoot: '/repo',
  base: 'main',
  instructions: 'extra',
  latestReview: REVIEW,
  towerInbox: INBOX,
};

const REVIEWER_INPUT = {
  name: 'reviewer-a',
  target: 'feat/build-gemm',
  reviewBase: 'main',
  repoRoot: '/repo',
  missionText: '# Mission M1: Build gemm',
  author: 'agent-build',
  reviews: [REVIEW],
  towerInbox: INBOX,
  instructions: 'extra',
};

const NOTIFICATION = {
  name: 'agent-build',
  agentId: 'agent-7',
  taskId: 'task-1',
  kind: 'worker' as const,
  description: 'M1 agent-build: Build gemm',
  status: 'failed' as const,
  stopReason: 'boom',
  wallTimeMs: 1000,
  result: 'final message',
};

const SAMPLES: Readonly<Record<string, () => string>> = {
  towerSpawnDescription: () => prompts.towerSpawnDescription('Available models (pass via model):'),
  towerModeReminderVariant: () => String(prompts.towerModeReminderVariant(0, [{ role: 'assistant' }])),
  selectTowerModeReminder: () =>
    [
      prompts.selectTowerModeReminder({ active: true, history: [] }),
      prompts.selectTowerModeReminder({
        active: true,
        last: { index: 0, kind: 'full' },
        history: [{ role: 'user', injected: true }, { role: 'assistant' }, { role: 'assistant' }],
      }),
      prompts.selectTowerModeReminder({ active: false, last: { index: 0, kind: 'full' }, history: [] }),
    ]
      .map((reminder) => reminder?.text ?? '')
      .join('\n'),
  truncateSection: () => prompts.truncateSection('abcdef', 3),
  findReviewRequest: () => prompts.findReviewRequest(INBOX, 'agent-build')?.body ?? '',
  buildSpawnBriefing: () =>
    prompts.buildSpawnBriefing({ kind: 'worker', ...WORKER_INPUT }) +
    prompts.buildSpawnBriefing({ kind: 'reviewer', ...REVIEWER_INPUT }),
  buildWorkerBriefing: () =>
    prompts.buildWorkerBriefing(WORKER_INPUT) +
    prompts.buildWorkerBriefing({ ...WORKER_INPUT, mission: { ...MISSION, kind: 'survey' } }),
  buildReviewerBriefing: () =>
    prompts.buildReviewerBriefing(REVIEWER_INPUT) +
    prompts.buildReviewerBriefing({ name: 'reviewer-b', target: 'feat/x', reviewBase: 'main', repoRoot: '/repo' }),
  workerHistorySection: () => prompts.workerHistorySection(WORKER_INPUT),
  reviewHistorySection: () => prompts.reviewHistorySection(Array.from({ length: 6 }, () => REVIEW)),
  renderInboxWake: () =>
    prompts.renderInboxWake({
      items: [{ from: 'w1', subject: 's', messageId: 'm', file: 'f', sentAt: 't', missionId: 'M1' }],
      recoveredAt: '2026-10-03T00:00:00.000Z',
      gateDigest: ['- M1: gate=unavailable'],
      digestOmitted: 1,
    }),
  wakeDigestTargets: () => JSON.stringify(prompts.wakeDigestTargets([{ from: 'w1', subject: 's', missionId: 'M1' }])),
  formatGateDigestLine: () =>
    prompts.formatGateDigestLine('M1', { ready: true, blocks: [], reviewBinding: 'exact-tip' }),
  renderSteerPreview: () => prompts.renderSteerPreview('tower', 'subject'),
  sendSteeredNote: () => prompts.sendSteeredNote('agent-build'),
  sendDeferredNote: () =>
    prompts.sendDeferredNote('agent-build', true) + prompts.sendDeferredNote('agent-build', false),
  sendHandledNote: () => prompts.sendHandledNote('agent-build'),
  sendUnreachableNote: () =>
    prompts.sendUnreachableNote('agent-build', 'worker') + prompts.sendUnreachableNote('reviewer-a', 'reviewer'),
  sendUndeliveredNote: () =>
    prompts.sendUndeliveredNote('agent-build', 'worker') + prompts.sendUndeliveredNote('reviewer-a', 'reviewer'),
  formatWallTime: () => prompts.formatWallTime(1500),
  agentNotificationBody: () =>
    [
      prompts.agentNotificationBody(NOTIFICATION),
      prompts.agentNotificationBody({ ...NOTIFICATION, kind: 'reviewer' }),
      prompts.agentNotificationBody({ ...NOTIFICATION, status: 'stopped', stoppedByHuman: true }),
      prompts.agentNotificationBody({ ...NOTIFICATION, status: 'timed_out' }),
    ].join('\n'),
  renderAgentNotification: () =>
    prompts.renderAgentNotification(NOTIFICATION) +
    prompts.renderAgentNotification({ ...NOTIFICATION, status: 'completed', result: 'x'.repeat(9000) }),
  spawnTaskDescription: () => prompts.spawnTaskDescription({ name: 'agent-build', reviewTarget: 'feat/x' }),
  undeliveredSteersSection: () =>
    (prompts.undeliveredSteersSection({ ...NOTIFICATION, undeliveredSteers: ['steer one'] }) ?? '') +
    (prompts.undeliveredSteersSection({
      ...NOTIFICATION,
      kind: 'reviewer',
      undeliveredSteers: ['steer two'],
    }) ?? ''),
  workerSpawnGuidance: () => prompts.workerSpawnGuidance('agent-build'),
  spawnSnapshotNote: () => prompts.spawnSnapshotNote('0123456789'),
  worktreeSetupWarning: () => prompts.worktreeSetupWarning('failed'),
  renderSpawnResult: () =>
    prompts.renderSpawnResult({
      name: 'agent-build',
      kind: 'worker',
      agentId: 'agent-7',
      taskId: 'task-1',
      model: 'anthropic/claude-sonnet',
      mission: { id: 'M1', title: 'Build gemm', branch: 'feat/build-gemm', worktreePath: '/repo/wt-1' },
    }) +
    prompts.renderSpawnResult({ name: 'reviewer-a', kind: 'reviewer', agentId: 'agent-9', reviewTarget: 'feat/x' }),
  todoToolDenied: () => prompts.todoToolDenied('todo'),
  subagentToolDenied: () => prompts.subagentToolDenied('subagent'),
  duplicateAgentRefusal: () =>
    prompts.duplicateAgentRefusal('agent-old', { agentId: 'agent-1', kind: 'worker' }) +
    prompts.duplicateAgentRefusal('reviewer-a', { agentId: 'agent-2', kind: 'reviewer' }),
  resumeLeasedRefusal: () => prompts.resumeLeasedRefusal('agent-build', 'feat/build-gemm'),
  resumeRunningRefusal: () => prompts.resumeRunningRefusal('agent-build'),
  resumeReviewerRefusal: () => prompts.resumeReviewerRefusal('reviewer-a'),
  resumeHumanStoppedRefusal: () => prompts.resumeHumanStoppedRefusal('agent-build'),
  resumeRetiredRefusal: () => prompts.resumeRetiredRefusal('agent-build'),
  unknownAgentRefusal: () => prompts.unknownAgentRefusal('agent-x', ['agent-build']),
};

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) collectStrings(nested, out);
  }
}

function allTexts(): { readonly label: string; readonly text: string }[] {
  const texts: { readonly label: string; readonly text: string }[] = [];
  for (const [name, value] of Object.entries(prompts)) {
    if (typeof value === 'function') continue;
    const strings: string[] = [];
    collectStrings(value, strings);
    for (const text of strings) texts.push({ label: name, text });
  }
  for (const [name, sample] of Object.entries(SAMPLES)) texts.push({ label: `${name}()`, text: sample() });
  return texts;
}

describe('src/prompts barrel', () => {
  it('re-exports every module export', () => {
    const modules = [
      toolDescriptions,
      parameterDescriptions,
      reminders,
      workerRole,
      briefings,
      notifications,
      refusals,
    ];
    const moduleExports = modules.flatMap((module) => Object.keys(module)).sort();
    expect(Object.keys(prompts).sort()).toEqual(moduleExports);
    expect(new Set(moduleExports).size).toBe(moduleExports.length);
  });

  it('exercises every function export', () => {
    const functions = Object.entries(prompts)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .sort();
    expect(Object.keys(SAMPLES).sort()).toEqual(functions);
    for (const [name, sample] of Object.entries(SAMPLES)) {
      expect(sample().length, name).toBeGreaterThan(0);
    }
  });

  it('exports only strings, string records, and numeric limits besides functions', () => {
    for (const [name, value] of Object.entries(prompts)) {
      if (typeof value === 'function') continue;
      expect(['string', 'number', 'object'], name).toContain(typeof value);
      if (typeof value === 'number') expect(Number.isInteger(value) && value > 0, name).toBe(true);
    }
  });
});

describe('kimi-only identifiers', () => {
  it('appear nowhere in exported or rendered text', () => {
    const texts = allTexts();
    expect(texts.length).toBeGreaterThan(80);
    for (const { label, text } of texts) {
      for (const pattern of KIMI_ONLY) {
        expect(pattern.test(text), `${label} matches ${String(pattern)}`).toBe(false);
      }
    }
  });

  it('are detected by the guard patterns', () => {
    for (const sample of [
      'Agent(resume="agent-1", run_in_background=true)',
      'use TaskList',
      'TaskOutput for a snapshot',
      'TaskStop the task',
      'kimi-file://upload/1',
      '[secondary_model] pool',
    ]) {
      expect(KIMI_ONLY.some((pattern) => pattern.test(sample)), sample).toBe(true);
    }
    for (const allowed of ['TowerTasks', 'TowerTaskOutput', 'TowerTaskStop', 'TowerResume']) {
      expect(KIMI_ONLY.some((pattern) => pattern.test(allowed)), allowed).toBe(false);
    }
  });
});
