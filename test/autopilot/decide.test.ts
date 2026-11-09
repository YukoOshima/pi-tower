import { describe, expect, it } from 'vitest';

import {
  computeProgressKey,
  decideAutopilot,
  digest,
  runningAgents,
  type AutopilotAction,
  type AutopilotDecision,
  type AutopilotObjective,
  type AutopilotObjectiveStatus,
  type AutopilotSnapshot,
  type AutopilotWakeReason,
} from '../../src/autopilot/index.ts';
import {
  BASE,
  NOW,
  SETTINGS,
  actionIdentity,
  applyDecision,
  awaitingReview,
  feature,
  mergeable,
  merged,
  milestone,
  snapshot,
  statusOnStart,
  worker,
  working,
} from './fixtures.ts';
import { World, plannedFeature, type WorldScript } from './world.ts';

interface Row {
  readonly name: string;
  readonly snap: AutopilotSnapshot;
  readonly actions: readonly unknown[];
}

function wakeOf(reason: AutopilotWakeReason, subject: string, revision: string): unknown {
  return expect.objectContaining({
    type: 'wake-orchestrator',
    reason,
    subject,
    revision,
    key: `${reason}:${subject}:${revision}`,
  });
}

function blockOf(reason: string): unknown {
  return expect.objectContaining({ type: 'block-objective', objective: 'O1', reason });
}

function pauseOf(reason: string): unknown {
  return expect.objectContaining({ type: 'pause-objective', objective: 'O1', reason });
}

const spawn = (mission: string): AutopilotAction => ({ type: 'spawn-worker', mission });
const reviewer = (mission: string): AutopilotAction => ({ type: 'spawn-reviewer', mission });
const rebase = (mission: string): AutopilotAction => ({ type: 'rebase', mission });
const merge = (mission: string): AutopilotAction => ({ type: 'merge', mission });

const ALL_ROWS: Row[] = [];

function table(title: string, rows: Row[]): void {
  ALL_ROWS.push(...rows);
  describe(title, () => {
    it.each(rows)('$name', ({ snap, actions }) => {
      expect(decideAutopilot(snap).actions).toEqual(actions);
    });
  });
}

const PLANNED = [feature('M1')];

table('objective gating', [
  { name: 'no objective produces nothing', snap: { ...snapshot({ missions: PLANNED }), objective: undefined }, actions: [] },
  ...(['planning', 'awaiting-approval', 'paused', 'completed', 'blocked'] as AutopilotObjectiveStatus[]).map(
    (status): Row => ({
      name: `a ${status} objective produces nothing`,
      snap: snapshot({ objective: { status }, missions: PLANNED }),
      actions: [],
    }),
  ),
  {
    name: 'an executing objective acts',
    snap: snapshot({ missions: PLANNED }),
    actions: [spawn('M1')],
  },
]);

table('budget limits pause first', [
  {
    name: 'wall time reached pauses alone',
    snap: snapshot({ objective: { limits: { maxValidationRounds: 3, maxFeatureAttempts: 3, maxWallTimeMs: 60_000 } }, missions: PLANNED }),
    actions: [pauseOf('max-wall-time')],
  },
  {
    name: 'wall time below the limit does not pause',
    snap: snapshot({ objective: { limits: { maxValidationRounds: 3, maxFeatureAttempts: 3, maxWallTimeMs: 60_001 } }, missions: PLANNED }),
    actions: [spawn('M1')],
  },
  {
    name: 'no startedAt never hits the wall-time limit',
    snap: snapshot({ objective: { startedAt: undefined, limits: { maxValidationRounds: 3, maxFeatureAttempts: 3, maxWallTimeMs: 1 } }, missions: PLANNED }),
    actions: [spawn('M1')],
  },
  {
    name: 'cost reached pauses alone',
    snap: snapshot({ objective: { costUsd: 5, limits: { maxValidationRounds: 3, maxFeatureAttempts: 3, maxCostUsd: 5 } }, missions: PLANNED }),
    actions: [pauseOf('max-cost')],
  },
  {
    name: 'cost below the limit does not pause',
    snap: snapshot({ objective: { costUsd: 4.99, limits: { maxValidationRounds: 3, maxFeatureAttempts: 3, maxCostUsd: 5 } }, missions: PLANNED }),
    actions: [spawn('M1')],
  },
  {
    name: 'wall time wins when both limits are reached',
    snap: snapshot({ objective: { costUsd: 9, limits: { maxValidationRounds: 3, maxFeatureAttempts: 3, maxWallTimeMs: 1, maxCostUsd: 1 } } }),
    actions: [pauseOf('max-wall-time')],
  },
  {
    name: 'budget pauses in manual mode too',
    snap: snapshot({ settings: { autopilot: false }, objective: { costUsd: 2, limits: { maxValidationRounds: 3, maxFeatureAttempts: 3, maxCostUsd: 1 } } }),
    actions: [pauseOf('max-cost')],
  },
]);

table('spawn-worker', [
  {
    name: 'spawns every startable feature in mission-number order',
    snap: snapshot({ missions: [feature('M10'), feature('M2'), feature('M3')] }),
    actions: [spawn('M2'), spawn('M3'), spawn('M10')],
  },
  {
    name: 'never spawns more than the free slots',
    snap: snapshot({ settings: { maxRunningAgents: 2 }, missions: [feature('M3'), feature('M1'), feature('M2')] }),
    actions: [spawn('M1'), spawn('M2')],
  },
  {
    name: 'live workers, reviewers, validators and other agents fill the slots',
    snap: snapshot({
      otherRunningAgents: 1,
      validators: [{ milestone: 'MS1', kind: 'scrutiny', commit: 'base-old' }],
      missions: [working('M1'), awaitingReview('M2', { reviewerRunning: true }), feature('M3')],
    }),
    actions: [],
  },
  {
    name: 'a mechanical commands run takes no agent slot',
    snap: snapshot({
      otherRunningAgents: 1,
      validators: [{ milestone: 'MS1', kind: 'commands', commit: 'base-old' }],
      missions: [working('M1'), awaitingReview('M2', { reviewerRunning: true }), feature('M3')],
    }),
    actions: [spawn('M3')],
  },
  {
    name: 'waits for a dependency that is still open',
    snap: snapshot({ missions: [working('M1'), feature('M2', { deps: ['M1'] })] }),
    actions: [],
  },
  {
    name: 'starts once the dependencies are merged or abandoned',
    snap: snapshot({
      missions: [merged('M1'), feature('M2', { status: 'abandoned' }), feature('M3', { deps: ['M1', 'M2'] })],
    }),
    actions: [spawn('M3')],
  },
  {
    name: 'an unknown dependency does not hold a feature back',
    snap: snapshot({ missions: [feature('M1', { deps: ['M99'] })] }),
    actions: [spawn('M1')],
  },
  {
    name: 'features of a later milestone do not start',
    snap: snapshot({ missions: [working('M1'), feature('M5', { milestone: 'MS2' })] }),
    actions: [],
  },
  {
    name: 'missions outside the objective are left alone',
    snap: snapshot({ missions: [working('M1'), feature('M7', { milestone: undefined }), feature('M8', { milestone: 'MS9' })] }),
    actions: [],
  },
  {
    name: 'a paused feature is left alone',
    snap: snapshot({ missions: [working('M1'), feature('M2', { status: 'paused' })] }),
    actions: [],
  },
]);

table('spawn-reviewer', [
  {
    name: 'spawns a reviewer for a review-request on the current tip',
    snap: snapshot({ missions: [awaitingReview('M1')] }),
    actions: [reviewer('M1')],
  },
  {
    name: 'waits while a reviewer is running',
    snap: snapshot({ missions: [awaitingReview('M1', { reviewerRunning: true })] }),
    actions: [],
  },
  {
    name: 'a review already on the tip needs no reviewer',
    snap: snapshot({
      missions: [awaitingReview('M1', { latestReviewOnTip: { status: 'clean', merge: 'fix-then-merge' }, gate: { ready: false, blocks: ['review-not-approved'] } })],
    }),
    actions: [wakeOf('merge-blocked', 'M1', 'tip-M1:review-not-approved')],
  },
  {
    name: 'a moved tip with a fresh review-request gets a reviewer, not a wake',
    snap: snapshot({ missions: [awaitingReview('M1', { gate: { ready: false, blocks: ['tip-moved'] } })] }),
    actions: [reviewer('M1')],
  },
  {
    name: 'no review-request means no reviewer and a merge-blocked wake',
    snap: snapshot({ missions: [awaitingReview('M1', { reviewRequestOnTip: false })] }),
    actions: [wakeOf('merge-blocked', 'M1', 'tip-M1:no-review')],
  },
  {
    name: 'a stale base is rebased before the review',
    snap: snapshot({ missions: [awaitingReview('M1', { gate: { ready: false, blocks: ['stale-base'] } })] }),
    actions: [rebase('M1')],
  },
  {
    name: 'a survey is never reviewed and merges when ready',
    snap: snapshot({ missions: [mergeable('M1', { kind: 'survey', latestReviewOnTip: undefined, reviewRequestOnTip: true })] }),
    actions: [merge('M1')],
  },
]);

const STALE = mergeable('M1', { gate: { ready: false, blocks: ['stale-base'] } });

table('rebase and merge', [
  { name: 'rebases a stale-base branch with an idle worker', snap: snapshot({ missions: [STALE] }), actions: [rebase('M1')] },
  {
    name: 'rebases when the worker is dead',
    snap: snapshot({ missions: [{ ...STALE, worker: worker({ state: 'dead', name: 'w-M1' }) }] }),
    actions: [rebase('M1')],
  },
  {
    name: 'never rebases under a running worker',
    snap: snapshot({ missions: [{ ...STALE, worker: worker({ state: 'running', name: 'w-M1' }) }] }),
    actions: [],
  },
  {
    name: 'never rebases under a running reviewer',
    snap: snapshot({ missions: [{ ...STALE, reviewerRunning: true }] }),
    actions: [],
  },
  { name: 'merges a READY feature', snap: snapshot({ missions: [mergeable('M1')] }), actions: [merge('M1')] },
  {
    name: 'merges one READY feature per tick, lowest mission number first',
    snap: snapshot({ missions: [mergeable('M3'), mergeable('M2')] }),
    actions: [merge('M2')],
  },
  {
    name: 'merges and rebases in the same tick',
    snap: snapshot({ missions: [{ ...STALE, id: 'M2', tip: 'tip-M2' }, mergeable('M1')] }),
    actions: [merge('M1'), rebase('M2')],
  },
  {
    name: 'a dead worker on a READY feature does not hold the merge',
    snap: snapshot({ missions: [mergeable('M1', { worker: worker({ state: 'dead', name: 'w-M1' }) })] }),
    actions: [merge('M1')],
  },
]);

const IDLE = worker({ state: 'idle', name: 'w-M1' });
const DEAD = worker({ state: 'dead', name: 'w-M1' });
const CONFLICT = feature('M1', {
  status: 'blocked',
  attempts: 1,
  tip: 'tip-M1',
  worker: IDLE,
  rebaseConflict: true,
  gate: { ready: false, blocks: ['not-completed', 'blockers'] },
});
const CONFLICT_RESUME_KEY = `resume-rebase-conflict:M1:tip-M1@${BASE}`;
const FINDINGS = working('M1', { worker: worker({ state: 'idle', name: 'w-M1', unreadFindings: true }) });
const STOPPED_SILENTLY = working('M1', { worker: IDLE });
const CONTINUE_KEY = 'resume-continue:M1:tip-M1';
const NUDGED = [CONTINUE_KEY, 'worker-idle:M1:tip-M1'];

function nudge(mission: string, tip: string, name = 'w-M1'): AutopilotAction {
  return { type: 'resume-worker', mission, worker: name, reason: 'continue', key: `resume-continue:${mission}:${tip}` };
}

table('resume-worker', [
  {
    name: 'resumes an idle worker with unread review findings',
    snap: snapshot({ missions: [FINDINGS] }),
    actions: [{ type: 'resume-worker', mission: 'M1', worker: 'w-M1', reason: 'review-findings', key: 'resume-review-findings:M1:tip-M1#0' }],
  },
  {
    name: 'a findings resume already sent for this tip and review count is not repeated',
    snap: snapshot({ missions: [FINDINGS], memory: { wakeKeys: ['resume-review-findings:M1:tip-M1#0'] } }),
    actions: [],
  },
  {
    name: 'a new review allows a new findings resume',
    snap: snapshot({ reviewCount: 1, missions: [FINDINGS], memory: { wakeKeys: ['resume-review-findings:M1:tip-M1#0'] } }),
    actions: [{ type: 'resume-worker', mission: 'M1', worker: 'w-M1', reason: 'review-findings', key: 'resume-review-findings:M1:tip-M1#1' }],
  },
  {
    name: 'a findings resume left unanswered with the findings still unread is no continue nudge',
    snap: snapshot({ missions: [FINDINGS], memory: { wakeKeys: ['resume-review-findings:M1:tip-M1#0', CONTINUE_KEY] } }),
    actions: [],
  },
  {
    name: 'a human-stopped worker is never resumed',
    snap: snapshot({ missions: [{ ...FINDINGS, worker: { ...FINDINGS.worker, humanStopped: true } }] }),
    actions: [],
  },
  {
    name: 'resumes an idle worker to resolve a rebase conflict',
    snap: snapshot({ missions: [CONFLICT] }),
    actions: [{ type: 'resume-worker', mission: 'M1', worker: 'w-M1', reason: 'rebase-conflict', key: CONFLICT_RESUME_KEY }],
  },
  {
    name: 'a conflict the resumed worker left unresolved wakes the orchestrator',
    snap: snapshot({ missions: [CONFLICT], memory: { wakeKeys: [CONFLICT_RESUME_KEY] } }),
    actions: [wakeOf('rebase-conflict', 'M1', `tip-M1@${BASE}`)],
  },
  {
    name: 'a conflict on a human-stopped worker wakes the orchestrator',
    snap: snapshot({ missions: [{ ...CONFLICT, worker: { ...IDLE, humanStopped: true } }] }),
    actions: [wakeOf('rebase-conflict', 'M1', `tip-M1@${BASE}`)],
  },
  {
    name: 'a conflict on a dead worker respawns it',
    snap: snapshot({ missions: [{ ...CONFLICT, worker: DEAD }] }),
    actions: [{ type: 'respawn-worker', mission: 'M1', attempt: 2, previousWorker: 'w-M1' }],
  },
]);

table('continue nudge and worker-idle wake', [
  {
    name: 'an idle worker that stopped silently on an active feature is resumed to continue',
    snap: snapshot({ missions: [STOPPED_SILENTLY] }),
    actions: [nudge('M1', 'tip-M1')],
  },
  {
    name: 'idle again on the same tip after the nudge wakes the orchestrator instead',
    snap: snapshot({ missions: [STOPPED_SILENTLY], memory: { wakeKeys: [CONTINUE_KEY] } }),
    actions: [wakeOf('worker-idle', 'M1', 'tip-M1')],
  },
  { name: 'the worker-idle wake is sent once per tip', snap: snapshot({ missions: [STOPPED_SILENTLY], memory: { wakeKeys: NUDGED } }), actions: [] },
  {
    name: 'a respawned worker idle on an already-nudged tip is reported as a worker of the feature, not as the one resumed',
    snap: snapshot({ missions: [{ ...STOPPED_SILENTLY, attempts: 2, worker: worker({ state: 'idle', name: 'w-M1-2' }) }], memory: { wakeKeys: [CONTINUE_KEY] } }),
    actions: [
      expect.objectContaining({
        type: 'wake-orchestrator',
        key: 'worker-idle:M1:tip-M1',
        detail: 'M1: worker w-M1-2 is idle on the active feature without TowerComplete, a blocker or an unanswered message, and a worker of this feature was already resumed once on this tip',
      }),
    ],
  },
  {
    name: 'a new tip re-arms the nudge',
    snap: snapshot({ missions: [{ ...STOPPED_SILENTLY, tip: 'tip-M1b' }], memory: { wakeKeys: NUDGED } }),
    actions: [nudge('M1', 'tip-M1b')],
  },
  {
    name: 'a feature without a branch tip is nudged on "-"',
    snap: snapshot({ missions: [{ ...STOPPED_SILENTLY, tip: undefined }] }),
    actions: [nudge('M1', '-')],
  },
  { name: 'a running worker is never nudged', snap: snapshot({ missions: [working('M1')] }), actions: [] },
  {
    name: 'a human-stopped worker is neither nudged nor reported',
    snap: snapshot({ missions: [{ ...STOPPED_SILENTLY, worker: { ...IDLE, humanStopped: true } }] }),
    actions: [],
  },
  {
    name: 'a worker awaiting the reply to its own message is neither nudged nor reported',
    snap: snapshot({ missions: [{ ...STOPPED_SILENTLY, worker: { ...IDLE, awaitingReply: true } }] }),
    actions: [],
  },
  {
    name: 'a worker that asked after its nudge on this tip is not reported',
    snap: snapshot({ missions: [{ ...STOPPED_SILENTLY, worker: { ...IDLE, awaitingReply: true } }], memory: { wakeKeys: [CONTINUE_KEY] } }),
    actions: [],
  },
  {
    name: 'manual mode does not report a worker awaiting a reply',
    snap: snapshot({ settings: { autopilot: false }, missions: [{ ...STOPPED_SILENTLY, worker: { ...IDLE, awaitingReply: true } }] }),
    actions: [],
  },
  {
    name: 'a rebase conflict still resumes a worker awaiting a reply',
    snap: snapshot({ missions: [{ ...CONFLICT, worker: { ...IDLE, awaitingReply: true } }] }),
    actions: [{ type: 'resume-worker', mission: 'M1', worker: 'w-M1', reason: 'rebase-conflict', key: CONFLICT_RESUME_KEY }],
  },
  {
    name: 'a feature rebased in this tick waits for the next tick and its new tip',
    snap: snapshot({ missions: [{ ...STOPPED_SILENTLY, gate: { ready: false, blocks: ['not-completed', 'stale-base'] } }] }),
    actions: [rebase('M1')],
  },
  {
    name: 'a dead worker is respawned, not nudged',
    snap: snapshot({ missions: [{ ...STOPPED_SILENTLY, worker: DEAD }] }),
    actions: [{ type: 'respawn-worker', mission: 'M1', attempt: 2, previousWorker: 'w-M1' }],
  },
  {
    name: 'an active feature that still lists a blocker gets the blocker wake only',
    snap: snapshot({ missions: [{ ...STOPPED_SILENTLY, blockers: ['need API key'] }] }),
    actions: [wakeOf('blocker', 'M1', digest('need API key'))],
  },
  {
    name: 'a blocked feature is not nudged',
    snap: snapshot({ missions: [{ ...STOPPED_SILENTLY, status: 'blocked', blockers: ['need API key'] }], memory: { wakeKeys: [`blocker:M1:${digest('need API key')}`] } }),
    actions: [],
  },
  { name: 'a completed feature is not nudged', snap: snapshot({ missions: [awaitingReview('M1', { reviewerRunning: true })] }), actions: [] },
  { name: 'a planned feature is not nudged', snap: snapshot({ missions: [{ ...STOPPED_SILENTLY, status: 'planned' }] }), actions: [] },
  {
    name: 'missions outside the objective and features of a later milestone are never nudged',
    snap: snapshot({
      missions: [
        working('M1'),
        { ...STOPPED_SILENTLY, id: 'M5', tip: 'tip-M5', milestone: 'MS2' },
        { ...STOPPED_SILENTLY, id: 'M7', tip: 'tip-M7', milestone: undefined },
        { ...STOPPED_SILENTLY, id: 'M8', tip: 'tip-M8', milestone: 'MS9' },
      ],
    }),
    actions: [],
  },
  {
    name: 'a feature of the pending milestone waits for its activation',
    snap: snapshot({ objective: { milestones: [milestone('MS1', 1, { status: 'passed' }), milestone('MS2', 2)] }, missions: [{ ...STOPPED_SILENTLY, milestone: 'MS2' }] }),
    actions: [{ type: 'advance-milestone', milestone: 'MS2', from: 'MS1' }],
  },
  {
    name: 'without a free agent slot the nudge waits and nothing wakes',
    snap: snapshot({ settings: { maxRunningAgents: 1 }, missions: [STOPPED_SILENTLY, working('M2')] }),
    actions: [],
  },
  {
    name: 'a worker the snapshot cannot name is reported instead of resumed',
    snap: snapshot({ missions: [{ ...STOPPED_SILENTLY, worker: worker({ state: 'idle' }) }] }),
    actions: [wakeOf('worker-idle', 'M1', 'tip-M1')],
  },
  {
    name: 'manual mode wakes the orchestrator at once instead of resuming',
    snap: snapshot({ settings: { autopilot: false }, missions: [STOPPED_SILENTLY] }),
    actions: [wakeOf('worker-idle', 'M1', 'tip-M1')],
  },
  {
    name: 'manual mode wakes once per tip',
    snap: snapshot({ settings: { autopilot: false }, missions: [STOPPED_SILENTLY], memory: { wakeKeys: ['worker-idle:M1:tip-M1'] } }),
    actions: [],
  },
]);

table('respawn-worker', [
  {
    name: 'respawns a dead worker on an active feature',
    snap: snapshot({ missions: [working('M1', { worker: DEAD })] }),
    actions: [{ type: 'respawn-worker', mission: 'M1', attempt: 2, previousWorker: 'w-M1' }],
  },
  {
    name: 'respawns a feature whose worker was retired by a restart',
    snap: snapshot({ missions: [working('M1', { attempts: 2, worker: worker() })] }),
    actions: [{ type: 'respawn-worker', mission: 'M1', attempt: 3 }],
  },
  {
    name: 'stops at maxFeatureAttempts and wakes the orchestrator once',
    snap: snapshot({ missions: [working('M1', { attempts: 3, worker: DEAD })] }),
    actions: [wakeOf('feature-attempts-exhausted', 'M1', '3')],
  },
  {
    name: 'never respawns a worker the human stopped',
    snap: snapshot({ missions: [working('M1', { worker: { ...DEAD, humanStopped: true } })] }),
    actions: [],
  },
  {
    name: 'a planned feature with open dependencies is not respawned',
    snap: snapshot({ missions: [working('M2'), feature('M1', { attempts: 1, deps: ['M2'], worker: DEAD })] }),
    actions: [],
  },
  {
    name: 'a completed feature with a dead worker needs no worker',
    snap: snapshot({ missions: [awaitingReview('M1', { worker: DEAD })] }),
    actions: [reviewer('M1')],
  },
  {
    name: 'a respawn wins over a first spawn when slots are short',
    snap: snapshot({ settings: { maxRunningAgents: 1 }, missions: [feature('M1'), working('M2', { worker: worker({ state: 'dead', name: 'w-M2' }) })] }),
    actions: [{ type: 'respawn-worker', mission: 'M2', attempt: 2, previousWorker: 'w-M2' }],
  },
]);

const EVERY_MECHANIC = [
  mergeable('M1'),
  { ...STALE, id: 'M2', tip: 'tip-M2' },
  awaitingReview('M3'),
  { ...FINDINGS, id: 'M4', tip: 'tip-M4' },
  working('M5', { worker: worker({ state: 'dead', name: 'w-M5' }) }),
  feature('M6'),
  { ...CONFLICT, id: 'M7', tip: 'tip-M7' },
  { ...STOPPED_SILENTLY, id: 'M8', tip: 'tip-M8' },
];

table('slot priority and output order', [
  {
    name: 'reviewers, then resumes, then respawns, then spawns',
    snap: snapshot({
      settings: { maxRunningAgents: 2 },
      missions: [feature('M1'), working('M2', { worker: DEAD }), { ...FINDINGS, id: 'M3', tip: 'tip-M3' }, awaitingReview('M4')],
    }),
    actions: [reviewer('M4'), { type: 'resume-worker', mission: 'M3', worker: 'w-M1', reason: 'review-findings', key: 'resume-review-findings:M3:tip-M3#0' }],
  },
  {
    name: 'every mechanic of one tick in the documented order',
    snap: snapshot({ settings: { maxRunningAgents: 8 }, missions: EVERY_MECHANIC }),
    actions: [
      merge('M1'),
      rebase('M2'),
      reviewer('M3'),
      { type: 'resume-worker', mission: 'M4', worker: 'w-M1', reason: 'review-findings', key: 'resume-review-findings:M4:tip-M4#0' },
      { type: 'respawn-worker', mission: 'M5', attempt: 2, previousWorker: 'w-M5' },
      spawn('M6'),
      { type: 'resume-worker', mission: 'M7', worker: 'w-M1', reason: 'rebase-conflict', key: `resume-rebase-conflict:M7:tip-M7@${BASE}` },
      nudge('M8', 'tip-M8'),
    ],
  },
]);

table('blocker and merge-blocked wakes', [
  {
    name: 'a worker-reported blocker wakes the orchestrator',
    snap: snapshot({ missions: [working('M1', { status: 'blocked', worker: IDLE, blockers: ['need API key'] })] }),
    actions: [wakeOf('blocker', 'M1', digest('need API key'))],
  },
  {
    name: 'a scope violation is a merge block autopilot cannot fix',
    snap: snapshot({ missions: [mergeable('M1', { gate: { ready: false, blocks: ['out-of-scope'] } })] }),
    actions: [wakeOf('merge-blocked', 'M1', 'tip-M1:out-of-scope')],
  },
  {
    name: 'unknown and environmental gate codes are merge blocks',
    snap: snapshot({ missions: [mergeable('M1', { gate: { ready: false, blocks: ['base-dirty', 'zz-new-code'] } })] }),
    actions: [wakeOf('merge-blocked', 'M1', 'tip-M1:base-dirty+zz-new-code')],
  },
  {
    name: 'transient gate codes do not wake',
    snap: snapshot({ missions: [mergeable('M1', { gate: { ready: false, blocks: ['worker-busy', 'deps-unmerged'] } })] }),
    actions: [],
  },
  {
    name: 'a running reviewer defers the merge-blocked decision',
    snap: snapshot({ missions: [mergeable('M1', { reviewerRunning: true, gate: { ready: false, blocks: ['out-of-scope'] } })] }),
    actions: [],
  },
]);

type Kind = 'scrutiny' | 'user-testing' | 'commands';

function round(kind: Kind, n: number, commit: string, verdict: 'pass' | 'fail') {
  return { kind, round: n, commit, verdict } as const;
}

function validate(ms: string, commit: string, kinds: Kind[]): AutopilotAction {
  return { type: 'start-validation', milestone: ms, commit, kinds };
}

const PASSED_MS1 = milestone('MS1', 1, { status: 'passed' });
const SKIP_FLIPPED = snapshot({
  settings: { skipUserTesting: true },
  objective: { milestones: [milestone('MS1', 1, { status: 'validating', validationCommit: BASE, rounds: [round('scrutiny', 1, BASE, 'pass')] }), milestone('MS2', 2)] },
  missions: [merged('M1')],
});
const DONE_MS1 = [merged('M1'), feature('M2', { status: 'abandoned' })];
const NO_KINDS = { scrutiny: false, userTesting: false, commands: 0 };

table('milestone activation and advance', [
  {
    name: 'activates a pending current milestone before its features start',
    snap: snapshot({ objective: { milestones: [milestone('MS1', 1), milestone('MS2', 2)] }, missions: [feature('M1')] }),
    actions: [{ type: 'advance-milestone', milestone: 'MS1' }],
  },
  {
    name: 'advances to the next milestone after a pass',
    snap: snapshot({ objective: { milestones: [PASSED_MS1, milestone('MS2', 2)] }, missions: [merged('M1'), feature('M3', { milestone: 'MS2' })] }),
    actions: [{ type: 'advance-milestone', milestone: 'MS2', from: 'MS1' }],
  },
  {
    name: 'orders milestones by order, not by position',
    snap: snapshot({ objective: { milestones: [milestone('MS2', 2), PASSED_MS1] }, missions: [merged('M1'), feature('M3', { milestone: 'MS2' })] }),
    actions: [{ type: 'advance-milestone', milestone: 'MS2', from: 'MS1' }],
  },
  {
    name: 'an empty current milestone wakes the orchestrator to plan it',
    snap: snapshot(),
    actions: [wakeOf('plan-milestone', 'MS1', BASE)],
  },
  {
    name: 'activating an empty milestone also asks for its plan',
    snap: snapshot({ objective: { milestones: [PASSED_MS1, milestone('MS2', 2)] }, missions: [merged('M1')] }),
    actions: [{ type: 'advance-milestone', milestone: 'MS2', from: 'MS1' }, wakeOf('plan-milestone', 'MS2', BASE)],
  },
]);

table('start-validation', [
  { name: 'validates once every feature is merged or abandoned', snap: snapshot({ missions: DONE_MS1 }), actions: [validate('MS1', BASE, ['scrutiny', 'user-testing'])] },
  { name: 'does not validate while a feature is open', snap: snapshot({ missions: [merged('M1'), working('M2')] }), actions: [] },
  {
    name: 'milestone validation.scrutiny=false drops scrutiny',
    snap: snapshot({ objective: { milestones: [milestone('MS1', 1, { status: 'active', validation: { scrutiny: false, userTesting: true, commands: 0 } })] }, missions: DONE_MS1 }),
    actions: [validate('MS1', BASE, ['user-testing'])],
  },
  { name: 'skipUserTesting drops user-testing', snap: snapshot({ settings: { skipUserTesting: true }, missions: DONE_MS1 }), actions: [validate('MS1', BASE, ['scrutiny'])] },
  { name: 'skipScrutiny drops scrutiny', snap: snapshot({ settings: { skipScrutiny: true }, missions: DONE_MS1 }), actions: [validate('MS1', BASE, ['user-testing'])] },
  {
    name: 'milestone commands add the commands kind',
    snap: snapshot({ objective: { milestones: [milestone('MS1', 1, { status: 'active', validation: { scrutiny: true, userTesting: true, commands: 2 } })] }, missions: DONE_MS1 }),
    actions: [validate('MS1', BASE, ['scrutiny', 'user-testing', 'commands'])],
  },
  {
    name: 'acceptance commands run on the final milestone',
    snap: snapshot({
      objective: { acceptanceCommands: 1, milestones: [PASSED_MS1, milestone('MS2', 2, { status: 'active', validation: NO_KINDS })] },
      missions: [merged('M1'), merged('M3', { milestone: 'MS2' })],
    }),
    actions: [validate('MS2', BASE, ['commands'])],
  },
  {
    name: 'acceptance commands do not run on an earlier milestone; nothing required passes at once',
    snap: snapshot({ objective: { acceptanceCommands: 2, milestones: [milestone('MS1', 1, { status: 'active', validation: NO_KINDS }), milestone('MS2', 2)] }, missions: DONE_MS1 }),
    actions: [validate('MS1', BASE, [])],
  },
  {
    name: 'LLM validators respect the slot cap; the commands kind needs no slot',
    snap: snapshot({
      settings: { maxRunningAgents: 1 },
      objective: { milestones: [milestone('MS1', 1, { status: 'active', validation: { scrutiny: true, userTesting: true, commands: 1 } })] },
      missions: DONE_MS1,
    }),
    actions: [validate('MS1', BASE, ['scrutiny', 'commands'])],
  },
  {
    name: 'with no free slot only the commands kind starts',
    snap: snapshot({
      settings: { maxRunningAgents: 1 },
      otherRunningAgents: 1,
      objective: { milestones: [milestone('MS1', 1, { status: 'active', validation: { scrutiny: true, userTesting: true, commands: 1 } })] },
      missions: DONE_MS1,
    }),
    actions: [validate('MS1', BASE, ['commands'])],
  },
  { name: 'with no free slot and no commands nothing starts', snap: snapshot({ settings: { maxRunningAgents: 1 }, otherRunningAgents: 1, missions: DONE_MS1 }), actions: [] },
  {
    name: 'a kind already in flight on the tip is not started again',
    snap: snapshot({ validators: [{ milestone: 'MS1', kind: 'scrutiny', commit: BASE }], missions: DONE_MS1 }),
    actions: [validate('MS1', BASE, ['user-testing'])],
  },
  {
    name: 'nothing starts while every kind is in flight',
    snap: snapshot({
      objective: { milestones: [milestone('MS1', 1, { status: 'validating' })] },
      validators: [
        { milestone: 'MS1', kind: 'scrutiny', commit: BASE },
        { milestone: 'MS1', kind: 'user-testing', commit: BASE },
      ],
      missions: DONE_MS1,
    }),
    actions: [],
  },
  {
    name: 'a validator on a stale commit does not cover the tip',
    snap: snapshot({ validators: [{ milestone: 'MS1', kind: 'scrutiny', commit: 'base-old' }], missions: DONE_MS1 }),
    actions: [validate('MS1', BASE, ['scrutiny', 'user-testing'])],
  },
  {
    name: 'continues a partial validation with the missing kind',
    snap: snapshot({ objective: { milestones: [milestone('MS1', 1, { status: 'validating', rounds: [round('scrutiny', 1, BASE, 'pass')] })] }, missions: DONE_MS1 }),
    actions: [validate('MS1', BASE, ['user-testing'])],
  },
  {
    name: 're-runs validation on the new tip when the base moved while validating',
    snap: snapshot({
      objective: { milestones: [milestone('MS1', 1, { status: 'validating', rounds: [round('scrutiny', 1, 'base-old', 'pass'), round('user-testing', 1, 'base-old', 'pass')] })] },
      missions: DONE_MS1,
    }),
    actions: [validate('MS1', BASE, ['scrutiny', 'user-testing'])],
  },
  {
    name: 'a validating milestone whose required kinds became empty is passed with an empty start-validation',
    snap: snapshot({
      settings: { skipScrutiny: true, skipUserTesting: true },
      objective: { milestones: [milestone('MS1', 1, { status: 'validating', validationCommit: BASE }), milestone('MS2', 2)] },
      missions: DONE_MS1,
    }),
    actions: [validate('MS1', BASE, [])],
  },
  {
    name: 'every required kind already passed on the tip but the store has not marked it passed: re-derive with []',
    snap: snapshot({
      objective: { milestones: [milestone('MS1', 1, { status: 'validating', rounds: [round('scrutiny', 1, BASE, 'pass'), round('user-testing', 1, BASE, 'pass')] }), milestone('MS2', 2)] },
      missions: DONE_MS1,
    }),
    actions: [validate('MS1', BASE, [])],
  },
  { name: 'a skip flag flipped mid-validation leaves only passed kinds: re-derive with []', snap: SKIP_FLIPPED, actions: [validate('MS1', BASE, [])] },
  {
    name: 'an active milestone whose required kinds all passed on the tip is re-derived too',
    snap: snapshot({
      objective: { milestones: [milestone('MS1', 1, { status: 'active', rounds: [round('scrutiny', 1, BASE, 'pass'), round('user-testing', 1, BASE, 'pass')] }), milestone('MS2', 2)] },
      missions: DONE_MS1,
    }),
    actions: [validate('MS1', BASE, [])],
  },
  {
    name: 'a kind still in flight on the tip holds the re-derive',
    snap: snapshot({
      objective: { milestones: [milestone('MS1', 1, { status: 'validating', validationCommit: BASE, rounds: [round('scrutiny', 1, BASE, 'pass')] }), milestone('MS2', 2)] },
      validators: [{ milestone: 'MS1', kind: 'user-testing', commit: BASE }],
      missions: DONE_MS1,
    }),
    actions: [],
  },
  {
    name: 'a pass on an older commit is not re-derived: the kind runs again on the tip',
    snap: snapshot({
      objective: { milestones: [milestone('MS1', 1, { status: 'validating', validationCommit: BASE, rounds: [round('scrutiny', 1, BASE, 'pass'), round('user-testing', 1, 'base-old', 'pass')] }), milestone('MS2', 2)] },
      missions: DONE_MS1,
    }),
    actions: [validate('MS1', BASE, ['user-testing'])],
  },
]);

const FAIL_ROUNDS = [round('scrutiny', 1, BASE, 'fail'), round('user-testing', 1, BASE, 'pass')];
const THREE_FAILS = [round('scrutiny', 1, 'a', 'fail'), round('scrutiny', 2, 'b', 'fail'), round('scrutiny', 3, BASE, 'fail')];
const UT_FAILED_ON_TIP = [round('scrutiny', 1, BASE, 'pass'), round('user-testing', 1, BASE, 'fail')];

table('validation failure, fix and block', [
  {
    name: 'a fail on the tip wakes the orchestrator and starts nothing else',
    snap: snapshot({
      objective: { milestones: [milestone('MS1', 1, { status: 'validating', rounds: [round('scrutiny', 1, BASE, 'fail')] })] },
      validators: [{ milestone: 'MS1', kind: 'user-testing', commit: BASE }],
      missions: DONE_MS1,
    }),
    actions: [wakeOf('validation-failed', 'MS1', 'scrutiny-r1')],
  },
  {
    name: 'a failed milestone wakes the orchestrator with the failing rounds',
    snap: snapshot({ objective: { milestones: [milestone('MS1', 1, { status: 'failed', rounds: FAIL_ROUNDS })] }, missions: DONE_MS1 }),
    actions: [wakeOf('validation-failed', 'MS1', 'scrutiny-r1')],
  },
  {
    name: 'every failing kind is part of the wake revision',
    snap: snapshot({
      objective: { milestones: [milestone('MS1', 1, { status: 'failed', rounds: [round('scrutiny', 1, BASE, 'fail'), round('user-testing', 1, BASE, 'fail')] })] },
      missions: DONE_MS1,
    }),
    actions: [wakeOf('validation-failed', 'MS1', 'scrutiny-r1+user-testing-r1')],
  },
  {
    name: 'a failed milestone is not re-validated just because the base moved',
    snap: snapshot({ baseTip: 'base-1', objective: { milestones: [milestone('MS1', 1, { status: 'failed', rounds: FAIL_ROUNDS })] }, missions: DONE_MS1 }),
    actions: [wakeOf('validation-failed', 'MS1', 'scrutiny-r1')],
  },
  {
    name: 'fix features run without a repeated wake',
    snap: snapshot({
      objective: { milestones: [milestone('MS1', 1, { status: 'active', rounds: FAIL_ROUNDS })] },
      missions: [merged('M1'), working('M3')],
      memory: { wakeKeys: ['validation-failed:MS1:scrutiny-r1'] },
    }),
    actions: [],
  },
  {
    name: 'merged fixes trigger a new validation round on the new tip',
    snap: snapshot({
      baseTip: 'base-1',
      objective: { milestones: [milestone('MS1', 1, { status: 'active', rounds: FAIL_ROUNDS })] },
      missions: [merged('M1'), merged('M3')],
      memory: { wakeKeys: ['validation-failed:MS1:scrutiny-r1'] },
    }),
    actions: [validate('MS1', 'base-1', ['scrutiny', 'user-testing'])],
  },
  {
    name: 'a resumed milestone with maxValidationRounds failed rounds asks for a fix instead of re-blocking',
    snap: snapshot({ objective: { milestones: [milestone('MS1', 1, { status: 'failed', rounds: THREE_FAILS })] }, missions: DONE_MS1 }),
    actions: [wakeOf('validation-failed', 'MS1', 'scrutiny-r3')],
  },
  {
    name: 'fix planning after a resume from a rounds block proceeds',
    snap: snapshot({
      objective: { milestones: [milestone('MS1', 1, { status: 'active', rounds: THREE_FAILS })] },
      missions: [merged('M1'), feature('M9')],
      memory: { wakeKeys: ['validation-failed:MS1:scrutiny-r3'] },
    }),
    actions: [spawn('M9')],
  },
  {
    name: 'old failed rounds on stale commits do not block a fresh round running on the tip',
    snap: snapshot({
      objective: { milestones: [milestone('MS1', 1, { status: 'validating', rounds: [round('scrutiny', 1, 'a', 'fail'), round('scrutiny', 2, 'b', 'fail'), round('scrutiny', 3, 'c', 'fail')] })] },
      validators: [
        { milestone: 'MS1', kind: 'scrutiny', commit: BASE },
        { milestone: 'MS1', kind: 'user-testing', commit: BASE },
      ],
      missions: DONE_MS1,
    }),
    actions: [],
  },
  {
    name: 'fewer failed rounds than the limit keep looping',
    snap: snapshot({ objective: { milestones: [milestone('MS1', 1, { status: 'failed', rounds: [round('scrutiny', 1, 'a', 'fail'), round('scrutiny', 2, BASE, 'fail')] })] }, missions: DONE_MS1 }),
    actions: [wakeOf('validation-failed', 'MS1', 'scrutiny-r2')],
  },
  {
    name: 'failed rounds of a kind that is no longer required are ignored',
    snap: snapshot({
      settings: { skipScrutiny: true },
      objective: { milestones: [milestone('MS1', 1, { status: 'active', rounds: [round('scrutiny', 1, 'a', 'fail'), round('scrutiny', 2, 'b', 'fail'), round('scrutiny', 3, 'c', 'fail')] })] },
      missions: DONE_MS1,
    }),
    actions: [validate('MS1', BASE, ['user-testing'])],
  },
  {
    name: 'a failed milestone whose failed kind is now skipped re-derives with []',
    snap: snapshot({
      settings: { skipUserTesting: true },
      objective: { milestones: [milestone('MS1', 1, { status: 'failed', validationCommit: BASE, rounds: UT_FAILED_ON_TIP }), milestone('MS2', 2)] },
      missions: DONE_MS1,
    }),
    actions: [validate('MS1', BASE, [])],
  },
  {
    name: 'blocked, then /tower resume with the failing kind skipped (the store gives failed): re-derive with []',
    snap: snapshot({
      settings: { skipUserTesting: true },
      objective: {
        milestones: [
          milestone('MS1', 1, {
            status: 'failed',
            validationCommit: BASE,
            rounds: [round('scrutiny', 1, BASE, 'pass'), round('user-testing', 1, 'a', 'fail'), round('user-testing', 2, 'b', 'fail'), round('user-testing', 3, BASE, 'fail')],
          }),
          milestone('MS2', 2),
        ],
      },
      missions: DONE_MS1,
      memory: { wakeKeys: ['validation-failed:MS1:user-testing-r1', 'validation-failed:MS1:user-testing-r2', 'validation-failed:MS1:user-testing-r3'] },
    }),
    actions: [validate('MS1', BASE, [])],
  },
  {
    name: 'a failed milestone whose failing kind is still required only wakes for a fix',
    snap: snapshot({
      objective: { milestones: [milestone('MS1', 1, { status: 'failed', validationCommit: BASE, rounds: UT_FAILED_ON_TIP }), milestone('MS2', 2)] },
      missions: DONE_MS1,
    }),
    actions: [wakeOf('validation-failed', 'MS1', 'user-testing-r1')],
  },
  {
    name: 'a failed milestone whose remaining kind has no round on the tip starts nothing',
    snap: snapshot({
      settings: { skipUserTesting: true },
      objective: {
        milestones: [
          milestone('MS1', 1, { status: 'failed', validationCommit: BASE, rounds: [round('scrutiny', 1, 'base-old', 'pass'), round('user-testing', 1, BASE, 'fail')] }),
          milestone('MS2', 2),
        ],
      },
      missions: DONE_MS1,
    }),
    actions: [],
  },
  {
    name: 'a milestone the store blocked (e.g. maxValidationRounds) blocks the objective',
    snap: snapshot({ objective: { milestones: [milestone('MS1', 1, { status: 'blocked' })] }, missions: [feature('M1')] }),
    actions: [blockOf('milestone-blocked')],
  },
]);

const FINAL_PASSED = milestone('MS2', 2, {
  status: 'passed',
  validationCommit: BASE,
  rounds: [round('scrutiny', 1, BASE, 'pass'), round('user-testing', 1, BASE, 'pass')],
});
const FINAL_FAILED_ON_TIP = { ...FINAL_PASSED, rounds: [...FINAL_PASSED.rounds, round('user-testing', 2, BASE, 'fail')] };
const ZERO_KIND_FINAL = milestone('MS2', 2, { status: 'passed', validation: NO_KINDS, validationCommit: BASE });
const ALL_MERGED = [merged('M1'), merged('M3', { milestone: 'MS2' })];

table('completion', [
  {
    name: 'completes when every milestone passed and the final rounds are on the tip',
    snap: snapshot({ objective: { milestones: [PASSED_MS1, FINAL_PASSED] }, missions: ALL_MERGED }),
    actions: [{ type: 'complete-objective', objective: 'O1' }],
  },
  {
    name: 're-validates the final milestone when the base moved after its pass',
    snap: snapshot({ baseTip: 'base-1', objective: { milestones: [PASSED_MS1, FINAL_PASSED] }, missions: ALL_MERGED }),
    actions: [validate('MS2', 'base-1', ['scrutiny', 'user-testing'])],
  },
  {
    name: 'waits for an in-flight final re-validation',
    snap: snapshot({
      baseTip: 'base-1',
      validators: [
        { milestone: 'MS2', kind: 'scrutiny', commit: 'base-1' },
        { milestone: 'MS2', kind: 'user-testing', commit: 'base-1' },
      ],
      objective: { milestones: [PASSED_MS1, { ...FINAL_PASSED, status: 'validating', validationCommit: 'base-1' }] },
      missions: ALL_MERGED,
    }),
    actions: [],
  },
  {
    name: 'a stale final whose kinds have no free slot is still re-stamped on the tip',
    snap: snapshot({
      baseTip: 'base-1',
      settings: { maxRunningAgents: 1 },
      otherRunningAgents: 1,
      objective: { milestones: [PASSED_MS1, FINAL_PASSED] },
      missions: ALL_MERGED,
    }),
    actions: [validate('MS2', 'base-1', [])],
  },
  {
    name: 'passing rounds on the tip without a matching validationCommit are re-stamped, not completed',
    snap: snapshot({ objective: { milestones: [PASSED_MS1, { ...FINAL_PASSED, validationCommit: 'base-old' }] }, missions: ALL_MERGED }),
    actions: [validate('MS2', BASE, [])],
  },
  {
    name: 'a re-stamped final left validating although its kinds passed on the tip is re-derived',
    snap: snapshot({ objective: { milestones: [PASSED_MS1, { ...FINAL_PASSED, status: 'validating' }] }, missions: ALL_MERGED }),
    actions: [validate('MS2', BASE, [])],
  },
  {
    name: 'a stamped final that now requires another kind starts it instead of completing',
    snap: snapshot({ objective: { acceptanceCommands: 1, milestones: [PASSED_MS1, FINAL_PASSED] }, missions: ALL_MERGED }),
    actions: [validate('MS2', BASE, ['commands'])],
  },
  {
    name: 'a fail on the tip never completes: the passed final wakes for a fix',
    snap: snapshot({ objective: { milestones: [PASSED_MS1, FINAL_FAILED_ON_TIP] }, missions: ALL_MERGED }),
    actions: [wakeOf('validation-failed', 'MS2', 'user-testing-r2')],
  },
  {
    name: 'the final failure wake is sent once',
    snap: snapshot({
      objective: { milestones: [PASSED_MS1, FINAL_FAILED_ON_TIP] },
      missions: ALL_MERGED,
      memory: { wakeKeys: ['validation-failed:MS2:user-testing-r2'] },
    }),
    actions: [],
  },
  {
    name: 'every failing kind of the passed final is part of the wake revision',
    snap: snapshot({
      objective: {
        milestones: [
          PASSED_MS1,
          { ...FINAL_PASSED, rounds: [...FINAL_FAILED_ON_TIP.rounds, round('scrutiny', 2, BASE, 'fail')] },
        ],
      },
      missions: ALL_MERGED,
    }),
    actions: [wakeOf('validation-failed', 'MS2', 'scrutiny-r2+user-testing-r2')],
  },
  {
    name: 'a new failing round on the passed final wakes again',
    snap: snapshot({
      objective: {
        milestones: [
          PASSED_MS1,
          { ...FINAL_PASSED, rounds: [...FINAL_FAILED_ON_TIP.rounds, round('user-testing', 3, BASE, 'fail')] },
        ],
      },
      missions: ALL_MERGED,
      memory: { wakeKeys: ['validation-failed:MS2:user-testing-r2'] },
    }),
    actions: [wakeOf('validation-failed', 'MS2', 'user-testing-r3')],
  },
  {
    name: 'a fix still open on the failed final does not suppress the wake',
    snap: snapshot({
      objective: { milestones: [PASSED_MS1, FINAL_FAILED_ON_TIP] },
      missions: [...ALL_MERGED, working('M9', { milestone: 'MS2' })],
    }),
    actions: [wakeOf('validation-failed', 'MS2', 'user-testing-r2')],
  },
  {
    name: 'a later pass on the tip supersedes the failing final round',
    snap: snapshot({
      objective: {
        milestones: [
          PASSED_MS1,
          { ...FINAL_PASSED, rounds: [...FINAL_FAILED_ON_TIP.rounds, round('user-testing', 3, BASE, 'pass')] },
        ],
      },
      missions: ALL_MERGED,
    }),
    actions: [{ type: 'complete-objective', objective: 'O1' }],
  },
  {
    name: 'a failing final round on an older commit re-validates on the moved tip instead',
    snap: snapshot({ baseTip: 'base-1', objective: { milestones: [PASSED_MS1, FINAL_FAILED_ON_TIP] }, missions: ALL_MERGED }),
    actions: [validate('MS2', 'base-1', ['scrutiny', 'user-testing'])],
  },
  {
    name: 'a failing round of a kind the final no longer requires is ignored',
    snap: snapshot({ settings: { skipUserTesting: true }, objective: { milestones: [PASSED_MS1, FINAL_FAILED_ON_TIP] }, missions: ALL_MERGED }),
    actions: [{ type: 'complete-objective', objective: 'O1' }],
  },
  {
    name: 'an open feature holds the completion',
    snap: snapshot({ objective: { milestones: [PASSED_MS1, FINAL_PASSED] }, missions: [...ALL_MERGED, working('M9', { milestone: 'MS2' })] }),
    actions: [],
  },
  {
    name: 'a zero-kind final milestone stamped on the tip completes',
    snap: snapshot({ objective: { milestones: [PASSED_MS1, ZERO_KIND_FINAL] }, missions: ALL_MERGED }),
    actions: [{ type: 'complete-objective', objective: 'O1' }],
  },
  {
    name: 'a zero-kind final milestone passed on an older commit is re-validated, not completed',
    snap: snapshot({ baseTip: 'base-1', objective: { milestones: [PASSED_MS1, ZERO_KIND_FINAL] }, missions: ALL_MERGED }),
    actions: [validate('MS2', 'base-1', [])],
  },
  {
    name: 'a zero-kind final milestone without a validationCommit is re-validated, not completed',
    snap: snapshot({ objective: { milestones: [PASSED_MS1, { ...ZERO_KIND_FINAL, validationCommit: undefined }] }, missions: ALL_MERGED }),
    actions: [validate('MS2', BASE, [])],
  },
  { name: 'an objective without milestones does nothing', snap: snapshot({ objective: { milestones: [] } }), actions: [] },
]);

function settled(
  snap: AutopilotSnapshot,
  quietMs: number,
  memory: Partial<AutopilotSnapshot['memory']> = {},
): AutopilotSnapshot {
  return {
    ...snap,
    memory: { ...snap.memory, progressKey: computeProgressKey(snap), progressAt: NOW - quietMs, ...memory },
  };
}

const QUIET = snapshot({ missions: [STOPPED_SILENTLY], memory: { wakeKeys: NUDGED } });
const QUIET_KEY = computeProgressKey(QUIET);
const MANUAL_PENDING = snapshot({ settings: { autopilot: false }, missions: [STOPPED_SILENTLY, feature('M2')], memory: { wakeKeys: NUDGED } });

const DUE = snapshot({ missions: [STOPPED_SILENTLY, feature('M2')], memory: { wakeKeys: NUDGED } });
const DUE_KEY = computeProgressKey(DUE);

function stallRevision(key: string, n: number, since: number): string {
  return `${key}#${String(n)}@${String(since)}`;
}

table('stall watchdog', [
  {
    name: 'a quiet, unchanged objective wakes after stallTimeoutMs',
    snap: settled(QUIET, 180_000),
    actions: [wakeOf('stalled', 'O1', stallRevision(QUIET_KEY, 1, NOW - 180_000))],
  },
  { name: 'quiet for less than stallTimeoutMs is not a stall', snap: settled(QUIET, 179_999), actions: [] },
  { name: 'a live agent is not a stall', snap: settled(snapshot({ missions: [working('M1')] }), 999_999), actions: [] },
  { name: 'a busy orchestrator is not a stall', snap: settled({ ...QUIET, orchestratorBusy: true }, 999_999), actions: [] },
  {
    name: 'an in-flight commands run is not a stall',
    snap: settled({ ...QUIET, validators: [{ milestone: 'MS1', kind: 'commands', commit: BASE }] }, 999_999),
    actions: [],
  },
  { name: 'a due action under stallTimeoutMs is simply emitted', snap: settled(DUE, 179_999), actions: [spawn('M2')] },
  {
    name: 'a due action that never takes effect does not hold the watchdog: the stall wake joins it',
    snap: settled(DUE, 999_999),
    actions: [spawn('M2'), wakeOf('stalled', 'O1', stallRevision(DUE_KEY, 1, NOW - 999_999))],
  },
  {
    name: 'each stall wake has its own key',
    snap: settled(QUIET, 180_000, { stallWakes: 2 }),
    actions: [wakeOf('stalled', 'O1', stallRevision(QUIET_KEY, 3, NOW - 180_000))],
  },
  { name: 'maxStallWakes stall wakes without progress block the objective', snap: settled(QUIET, 180_000, { stallWakes: 3 }), actions: [blockOf('stalled')] },
  { name: 'the stalled block replaces the due actions', snap: settled(DUE, 180_000, { stallWakes: 3 }), actions: [blockOf('stalled')] },
  {
    name: 'a stall wake already sent is not resent',
    snap: settled(QUIET, 180_000, { wakeKeys: [...NUDGED, `stalled:O1:${stallRevision(QUIET_KEY, 1, NOW - 180_000)}`] }),
    actions: [],
  },
  {
    name: 'resuming from a stalled block re-arms the stall wakes',
    snap: settled(QUIET, 180_000, {
      stallWakes: 0,
      wakeKeys: [...NUDGED, ...[1, 2, 3].map((n) => `stalled:O1:${stallRevision(QUIET_KEY, n, NOW - 1_000_000 + n * 180_000)}`)],
    }),
    actions: [wakeOf('stalled', 'O1', stallRevision(QUIET_KEY, 1, NOW - 180_000))],
  },
  {
    name: 'manual mode stalls when the orchestrator leaves feature execution undone',
    snap: settled(MANUAL_PENDING, 180_000),
    actions: [wakeOf('stalled', 'O1', stallRevision(computeProgressKey(MANUAL_PENDING), 1, NOW - 180_000))],
  },
]);

describe('stall bookkeeping', () => {
  it.each([
    {
      name: 'a changed progress key restarts the clock and the stall count',
      snap: { ...QUIET, memory: { progressKey: 'older', progressAt: NOW - 999_999, stallWakes: 2, wakeKeys: [] } },
      stall: { progressAt: NOW, idleMs: 0, stalled: false, stallWakes: 0 },
    },
    { name: 'the first tick counts as progress', snap: QUIET, stall: { progressAt: NOW, idleMs: 0, stalled: false, stallWakes: 0 } },
    { name: 'a quiet tick keeps the clock', snap: settled(QUIET, 100_000, { stallWakes: 1 }), stall: { progressAt: NOW - 100_000, idleMs: 100_000, stalled: false, stallWakes: 1 } },
    { name: 'activity restarts the clock but keeps the count', snap: settled({ ...QUIET, orchestratorBusy: true }, 500_000, { stallWakes: 1 }), stall: { progressAt: NOW, idleMs: 0, stalled: false, stallWakes: 1 } },
    { name: 'a stall wake restarts the clock and counts', snap: settled(QUIET, 200_000), stall: { progressAt: NOW, idleMs: 200_000, stalled: true, stallWakes: 1 } },
    {
      name: 'a suppressed stall wake still counts as sent',
      snap: settled(QUIET, 200_000, { wakeKeys: [...NUDGED, `stalled:O1:${stallRevision(QUIET_KEY, 1, NOW - 200_000)}`] }),
      stall: { progressAt: NOW, idleMs: 200_000, stalled: true, stallWakes: 1 },
    },
    { name: 'a due action does not restart the clock', snap: settled(DUE, 100_000), stall: { progressAt: NOW - 100_000, idleMs: 100_000, stalled: false, stallWakes: 0 } },
    { name: 'the stall block keeps the count', snap: settled(QUIET, 200_000, { stallWakes: 3 }), stall: { progressAt: NOW - 200_000, idleMs: 200_000, stalled: true, stallWakes: 3 } },
    {
      name: 'a non-executing objective rests the clock',
      snap: settled(snapshot({ objective: { status: 'paused' } }), 999_999, { stallWakes: 2 }),
      stall: { progressAt: NOW, idleMs: 0, stalled: false, stallWakes: 2 },
    },
  ])('$name', ({ snap, stall }) => {
    expect(decideAutopilot(snap).stall).toEqual(stall);
  });

  it('returns the progress key of the snapshot', () => {
    expect(decideAutopilot(QUIET).progressKey).toBe(QUIET_KEY);
  });
});

function refuseEveryAction(start: AutopilotSnapshot, ticks: number): AutopilotDecision[] {
  const decisions: AutopilotDecision[] = [];
  let snap = start;
  for (let tick = 0; tick < ticks; tick += 1) {
    const decision = decideAutopilot(snap);
    decisions.push(decision);
    const sent = decision.actions.flatMap((action) =>
      action.type === 'wake-orchestrator' || action.type === 'resume-worker' ? [action.key] : [],
    );
    snap = {
      ...start,
      now: snap.now + 60_000,
      memory: {
        progressKey: decision.progressKey,
        progressAt: decision.stall.progressAt,
        stallWakes: decision.stall.stallWakes,
        wakeKeys: [...snap.memory.wakeKeys, ...sent],
      },
    };
  }
  return decisions;
}

describe('stall watchdog with an executor that refuses every action', () => {
  it.each([
    { name: 'rebase', action: 'rebase', snap: snapshot({ missions: [STALE] }) },
    { name: 'spawn-worker', action: 'spawn-worker', snap: snapshot({ missions: PLANNED }) },
    { name: 'start-validation', action: 'start-validation', snap: snapshot({ missions: DONE_MS1 }) },
    { name: 're-derive start-validation([]) the store never applies', action: 'start-validation', snap: SKIP_FLIPPED },
    { name: 'complete-objective', action: 'complete-objective', snap: snapshot({ objective: { milestones: [PASSED_MS1, FINAL_PASSED] }, missions: ALL_MERGED }) },
  ])('a refused $name keeps being emitted, stall wakes #1..#3 join it, then block-objective alone', ({ action, snap }) => {
    const decisions = refuseEveryAction(snap, 13);
    const ticks = decisions.map((decision) =>
      decision.actions.map((next) => (next.type === 'wake-orchestrator' ? `wake:${next.reason}` : next.type)).join(' '),
    );
    const due = action;
    const stalled = `${action} wake:stalled`;
    expect(ticks).toEqual([due, due, due, stalled, due, due, stalled, due, due, stalled, due, due, 'block-objective']);
    const key = decisions[0]!.progressKey;
    const revisions = decisions.flatMap((decision) =>
      decision.actions.flatMap((next) => (next.type === 'wake-orchestrator' ? [next.revision] : [])),
    );
    expect(revisions).toEqual([
      stallRevision(key, 1, NOW),
      stallRevision(key, 2, NOW + 180_000),
      stallRevision(key, 3, NOW + 360_000),
    ]);
  });
});

describe('store model of the test executors on start-validation', () => {
  const objectiveWith = (ms: ReturnType<typeof milestone>) => snapshot({ objective: { milestones: [ms] } }).objective!;
  it.each([
    { name: 'no required kind passes', ms: milestone('MS1', 1, { status: 'active', validation: NO_KINDS }), status: 'passed' },
    { name: 'required kinds without rounds stay validating', ms: milestone('MS1', 1, { status: 'active' }), status: 'validating' },
    {
      name: 'every required kind already passed on the commit is re-derived as passed',
      ms: milestone('MS1', 1, { status: 'validating', rounds: [round('scrutiny', 1, BASE, 'pass'), round('user-testing', 1, BASE, 'pass')] }),
      status: 'passed',
    },
    {
      name: 'passes on another commit only stay validating',
      ms: milestone('MS1', 1, { status: 'passed', rounds: [round('scrutiny', 1, 'base-old', 'pass'), round('user-testing', 1, 'base-old', 'pass')] }),
      status: 'validating',
    },
  ])('$name', ({ ms, status }) => {
    expect(statusOnStart(objectiveWith(ms), 'MS1', SETTINGS, BASE)).toBe(status);
  });
});

describe('computeProgressKey', () => {
  const base = snapshot({
    reviewCount: 2,
    inboxCount: 5,
    missions: [working('M1'), merged('M2')],
    objective: { milestones: [milestone('MS1', 1, { status: 'validating', rounds: [round('scrutiny', 1, BASE, 'fail'), round('user-testing', 1, BASE, 'pass')] })] },
  });
  const key = computeProgressKey(base);
  const objective = base.objective!;
  const ms1 = objective.milestones[0]!;

  it('is a short deterministic hex digest', () => {
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(computeProgressKey(base)).toBe(key);
  });

  it('ignores the input order of missions and rounds', () => {
    const reordered: AutopilotSnapshot = {
      ...base,
      missions: [...base.missions].reverse(),
      objective: { ...objective, milestones: [{ ...ms1, rounds: [...ms1.rounds].reverse() }] },
    };
    expect(computeProgressKey(reordered)).toBe(key);
  });

  it.each([
    ['a mission status', { missions: [working('M1', { status: 'completed' }), merged('M2')] }],
    ['a branch tip', { missions: [working('M1', { tip: 'tip-M1b' }), merged('M2')] }],
    ['a new mission', { missions: [...base.missions, feature('M3')] }],
    ['the base tip', { baseTip: 'base-9' }],
    ['the review count', { reviewCount: 3 }],
    ['the inbox count', { inboxCount: 6 }],
    ['a new validation round', { objective: { ...objective, milestones: [{ ...ms1, rounds: [...ms1.rounds, round('scrutiny', 2, BASE, 'pass')] }] } }],
    ['a milestone status', { objective: { ...objective, milestones: [{ ...ms1, status: 'failed' as const }] } }],
    ['a validation commit', { objective: { ...objective, milestones: [{ ...ms1, validationCommit: 'base-9' }] } }],
  ] as Array<[string, Partial<AutopilotSnapshot>]>)('changes with %s', (_label, patch) => {
    expect(computeProgressKey({ ...base, ...patch })).not.toBe(key);
  });

  it.each([
    ['the clock', { now: NOW + 1 }],
    ['worker liveness', { missions: [working('M1', { worker: IDLE }), merged('M2')] }],
    ['the orchestrator', { orchestratorBusy: true }],
    ['the memory', { memory: { progressKey: 'x', progressAt: 1, stallWakes: 2, wakeKeys: ['k'] } }],
    ['running validators', { validators: [{ milestone: 'MS1', kind: 'scrutiny' as const, commit: BASE }] }],
    ['gate observations', { missions: [working('M1', { gate: { ready: false, blocks: ['stale-base'] } }), merged('M2')] }],
  ] as Array<[string, Partial<AutopilotSnapshot>]>)('ignores %s', (_label, patch) => {
    expect(computeProgressKey({ ...base, ...patch })).toBe(key);
  });
});

const SCOPE_BLOCKED = mergeable('M1', { gate: { ready: false, blocks: ['out-of-scope'] } });

table('wake dedupe keys', [
  { name: 'a wake whose key was already sent is suppressed', snap: snapshot({ memory: { wakeKeys: [`plan-milestone:MS1:${BASE}`] } }), actions: [] },
  {
    name: 'a moved base re-arms the plan-milestone wake',
    snap: snapshot({ baseTip: 'base-1', memory: { wakeKeys: [`plan-milestone:MS1:${BASE}`] } }),
    actions: [wakeOf('plan-milestone', 'MS1', 'base-1')],
  },
  {
    name: 'the same blocker is not re-sent',
    snap: snapshot({ missions: [working('M1', { status: 'blocked', worker: IDLE, blockers: ['need API key'] })], memory: { wakeKeys: [`blocker:M1:${digest('need API key')}`] } }),
    actions: [],
  },
  {
    name: 'a new blocker re-wakes',
    snap: snapshot({
      missions: [working('M1', { status: 'blocked', worker: IDLE, blockers: ['need API key', 'and a database'] })],
      memory: { wakeKeys: [`blocker:M1:${digest('need API key')}`] },
    }),
    actions: [wakeOf('blocker', 'M1', digest('need API key\nand a database'))],
  },
  {
    name: 'a new failed validation round re-wakes',
    snap: snapshot({
      objective: { milestones: [milestone('MS1', 1, { status: 'failed', rounds: [round('scrutiny', 1, 'a', 'fail'), round('scrutiny', 2, BASE, 'fail')] })] },
      missions: DONE_MS1,
      memory: { wakeKeys: ['validation-failed:MS1:scrutiny-r1'] },
    }),
    actions: [wakeOf('validation-failed', 'MS1', 'scrutiny-r2')],
  },
  {
    name: 'a moved tip re-arms the merge-blocked wake',
    snap: snapshot({ missions: [{ ...SCOPE_BLOCKED, tip: 'tip-M1b' }], memory: { wakeKeys: ['merge-blocked:M1:tip-M1:out-of-scope'] } }),
    actions: [wakeOf('merge-blocked', 'M1', 'tip-M1b:out-of-scope')],
  },
  {
    name: 'exhausted attempts wake once',
    snap: snapshot({ missions: [working('M1', { attempts: 3, worker: DEAD })], memory: { wakeKeys: ['feature-attempts-exhausted:M1:3'] } }),
    actions: [],
  },
]);

const MANUAL = { autopilot: false };

table('manual mode (autopilot=false)', [
  {
    name: 'every due feature-execution action is left to the orchestrator',
    snap: snapshot({ settings: { ...MANUAL, maxRunningAgents: 8 }, missions: EVERY_MECHANIC }),
    actions: [wakeOf('rebase-conflict', 'M7', `tip-M7@${BASE}`), wakeOf('worker-idle', 'M8', 'tip-M8')],
  },
  {
    name: 'a pending milestone is still activated, and an empty one asks for its plan',
    snap: snapshot({ settings: MANUAL, objective: { milestones: [PASSED_MS1, milestone('MS2', 2)] }, missions: [merged('M1')] }),
    actions: [{ type: 'advance-milestone', milestone: 'MS2', from: 'MS1' }, wakeOf('plan-milestone', 'MS2', BASE)],
  },
  {
    name: 'a pending milestone is activated before its features are touched',
    snap: snapshot({ settings: MANUAL, objective: { milestones: [PASSED_MS1, milestone('MS2', 2)] }, missions: [merged('M1'), { ...SCOPE_BLOCKED, id: 'M3', milestone: 'MS2', tip: 'tip-M3' }] }),
    actions: [{ type: 'advance-milestone', milestone: 'MS2', from: 'MS1' }],
  },
  {
    name: 'validation still starts with the LLM kinds and the commands kind',
    snap: snapshot({
      settings: MANUAL,
      objective: { milestones: [milestone('MS1', 1, { status: 'active', validation: { scrutiny: true, userTesting: true, commands: 1 } })] },
      missions: DONE_MS1,
    }),
    actions: [validate('MS1', BASE, ['scrutiny', 'user-testing', 'commands'])],
  },
  {
    name: 'a moved base still re-validates the final milestone',
    snap: snapshot({ settings: MANUAL, baseTip: 'base-1', objective: { milestones: [PASSED_MS1, FINAL_PASSED] }, missions: ALL_MERGED }),
    actions: [validate('MS2', 'base-1', ['scrutiny', 'user-testing'])],
  },
  {
    name: 'the objective still completes',
    snap: snapshot({ settings: MANUAL, objective: { milestones: [PASSED_MS1, FINAL_PASSED] }, missions: ALL_MERGED }),
    actions: [{ type: 'complete-objective', objective: 'O1' }],
  },
  {
    name: 'validation failures still wake',
    snap: snapshot({ settings: MANUAL, objective: { milestones: [milestone('MS1', 1, { status: 'failed', rounds: FAIL_ROUNDS })] }, missions: DONE_MS1 }),
    actions: [wakeOf('validation-failed', 'MS1', 'scrutiny-r1')],
  },
  { name: 'a rebase conflict wakes instead of resuming', snap: snapshot({ settings: MANUAL, missions: [CONFLICT] }), actions: [wakeOf('rebase-conflict', 'M1', `tip-M1@${BASE}`)] },
  {
    name: 'a dead worker on a conflict wakes instead of respawning',
    snap: snapshot({ settings: MANUAL, missions: [{ ...CONFLICT, worker: DEAD }] }),
    actions: [wakeOf('rebase-conflict', 'M1', `tip-M1@${BASE}`)],
  },
  { name: 'exhausted attempts still wake', snap: snapshot({ settings: MANUAL, missions: [working('M1', { attempts: 3, worker: DEAD })] }), actions: [wakeOf('feature-attempts-exhausted', 'M1', '3')] },
  { name: 'merge blocks still wake', snap: snapshot({ settings: MANUAL, missions: [SCOPE_BLOCKED] }), actions: [wakeOf('merge-blocked', 'M1', 'tip-M1:out-of-scope')] },
  {
    name: 'a milestone the store blocked still blocks the objective',
    snap: snapshot({ settings: MANUAL, objective: { milestones: [milestone('MS1', 1, { status: 'blocked', rounds: THREE_FAILS })] }, missions: DONE_MS1 }),
    actions: [blockOf('milestone-blocked')],
  },
]);

const SECOND_OBJECTIVE = [milestone('MS3', 1, { status: 'active' }), milestone('MS4', 2)];
const EARLIER_OBJECTIVE_MISSIONS = [merged('M1'), working('M2', { milestone: 'MS2', worker: DEAD })];

table('features attached to the objective', [
  {
    name: "missions on an earlier objective's milestones are not features",
    snap: snapshot({ objective: { milestones: SECOND_OBJECTIVE }, missions: [...EARLIER_OBJECTIVE_MISSIONS, feature('M5', { milestone: 'MS3' })] }),
    actions: [spawn('M5')],
  },
  {
    name: "an earlier objective's merged missions do not make a milestone non-empty",
    snap: snapshot({ objective: { milestones: SECOND_OBJECTIVE }, missions: EARLIER_OBJECTIVE_MISSIONS }),
    actions: [wakeOf('plan-milestone', 'MS3', BASE)],
  },
  {
    name: 'an open mission of an earlier objective does not hold the completion',
    snap: snapshot({
      objective: { milestones: [milestone('MS3', 1, { status: 'passed' }), { ...FINAL_PASSED, id: 'MS4' }] },
      missions: [...EARLIER_OBJECTIVE_MISSIONS, merged('M5', { milestone: 'MS3' }), merged('M6', { milestone: 'MS4' })],
    }),
    actions: [{ type: 'complete-objective', objective: 'O1' }],
  },
]);

const silentValidators = (ms: string, kind: Kind, commit: string, attempts: number, humanStopped = false) => [
  { milestone: ms, kind, commit, attempts, humanStopped },
];

table('loop guard for agents that end without submitting', [
  {
    name: 'a reviewer that ended without a review is replaced while attempts remain',
    snap: snapshot({ missions: [awaitingReview('M1', { reviewerAttemptsOnTip: 2 })] }),
    actions: [reviewer('M1')],
  },
  {
    name: 'maxFeatureAttempts silent reviewers on the tip stop reviewer spawns and wake once',
    snap: snapshot({ missions: [awaitingReview('M1', { reviewerAttemptsOnTip: 3 })] }),
    actions: [wakeOf('review-stuck', 'M1', 'tip-M1')],
  },
  {
    name: 'the review-stuck wake is not repeated',
    snap: snapshot({ missions: [awaitingReview('M1', { reviewerAttemptsOnTip: 3 })], memory: { wakeKeys: ['review-stuck:M1:tip-M1'] } }),
    actions: [],
  },
  {
    name: 'a stuck review on a new tip wakes again',
    snap: snapshot({ missions: [awaitingReview('M1', { tip: 'tip-M1b', reviewerAttemptsOnTip: 3 })], memory: { wakeKeys: ['review-stuck:M1:tip-M1'] } }),
    actions: [wakeOf('review-stuck', 'M1', 'tip-M1b')],
  },
  {
    name: 'manual mode still reports a stuck review',
    snap: snapshot({ settings: { autopilot: false }, missions: [awaitingReview('M1', { reviewerAttemptsOnTip: 3 })] }),
    actions: [wakeOf('review-stuck', 'M1', 'tip-M1')],
  },
  {
    name: 'a validator that ended without a verdict is replaced while attempts remain',
    snap: snapshot({ validationAttempts: silentValidators('MS1', 'scrutiny', BASE, 2), missions: DONE_MS1 }),
    actions: [validate('MS1', BASE, ['scrutiny', 'user-testing'])],
  },
  {
    name: 'maxFeatureAttempts silent validators stop that kind and wake once',
    snap: snapshot({ validationAttempts: silentValidators('MS1', 'scrutiny', BASE, 3), missions: DONE_MS1 }),
    actions: [validate('MS1', BASE, ['user-testing']), wakeOf('validation-stuck', 'MS1:scrutiny', BASE)],
  },
  {
    name: 'the validation-stuck wake is not repeated',
    snap: snapshot({ validationAttempts: silentValidators('MS1', 'scrutiny', BASE, 3), missions: DONE_MS1, memory: { wakeKeys: [`validation-stuck:MS1:scrutiny:${BASE}`] } }),
    actions: [validate('MS1', BASE, ['user-testing'])],
  },
  {
    name: 'silent validators on another commit do not count',
    snap: snapshot({ validationAttempts: silentValidators('MS1', 'scrutiny', 'base-old', 9), missions: DONE_MS1 }),
    actions: [validate('MS1', BASE, ['scrutiny', 'user-testing'])],
  },
  {
    name: 'the commands kind is guarded the same way',
    snap: snapshot({
      validationAttempts: silentValidators('MS1', 'commands', BASE, 3),
      objective: { milestones: [milestone('MS1', 1, { status: 'active', validation: { scrutiny: true, userTesting: true, commands: 1 } })] },
      missions: DONE_MS1,
    }),
    actions: [validate('MS1', BASE, ['scrutiny', 'user-testing']), wakeOf('validation-stuck', 'MS1:commands', BASE)],
  },
  {
    name: 'a stuck final re-validation wakes too',
    snap: snapshot({
      baseTip: 'base-1',
      validationAttempts: silentValidators('MS2', 'scrutiny', 'base-1', 3),
      objective: { milestones: [PASSED_MS1, FINAL_PASSED] },
      missions: ALL_MERGED,
    }),
    actions: [validate('MS2', 'base-1', ['user-testing']), wakeOf('validation-stuck', 'MS2:scrutiny', 'base-1')],
  },
]);

const STOPPED_REVIEW = awaitingReview('M1', { reviewerAttemptsOnTip: 1, reviewerHumanStopped: true });

table('reviewers and validators the human stopped', [
  {
    name: 'a reviewer the human stopped is never replaced and wakes the orchestrator',
    snap: snapshot({ missions: [STOPPED_REVIEW] }),
    actions: [wakeOf('review-stuck', 'M1', 'tip-M1')],
  },
  {
    name: 'the human-stop review wake is sent once per tip',
    snap: snapshot({ missions: [STOPPED_REVIEW], memory: { wakeKeys: ['review-stuck:M1:tip-M1'] } }),
    actions: [],
  },
  {
    name: 'manual mode reports a reviewer the human stopped too',
    snap: snapshot({ settings: { autopilot: false }, missions: [STOPPED_REVIEW] }),
    actions: [wakeOf('review-stuck', 'M1', 'tip-M1')],
  },
  {
    name: 'a feature whose reviewer the human stopped is still rebased onto a moved base',
    snap: snapshot({ missions: [{ ...STOPPED_REVIEW, gate: { ready: false, blocks: ['stale-base'] } }] }),
    actions: [rebase('M1')],
  },
  {
    name: 'a validator the human stopped is never replaced and wakes the orchestrator',
    snap: snapshot({ validationAttempts: silentValidators('MS1', 'scrutiny', BASE, 1, true), missions: DONE_MS1 }),
    actions: [validate('MS1', BASE, ['user-testing']), wakeOf('validation-stuck', 'MS1:scrutiny', BASE)],
  },
  {
    name: 'the human-stop validation wake is sent once per commit',
    snap: snapshot({
      validationAttempts: silentValidators('MS1', 'scrutiny', BASE, 1, true),
      missions: DONE_MS1,
      memory: { wakeKeys: [`validation-stuck:MS1:scrutiny:${BASE}`] },
    }),
    actions: [validate('MS1', BASE, ['user-testing'])],
  },
  {
    name: 'a validator the human stopped on an older commit does not hold the new commit',
    snap: snapshot({ validationAttempts: silentValidators('MS1', 'scrutiny', 'base-old', 1, true), missions: DONE_MS1 }),
    actions: [validate('MS1', BASE, ['scrutiny', 'user-testing'])],
  },
  {
    name: 'a final re-validation the human stopped wakes too',
    snap: snapshot({
      baseTip: 'base-1',
      validationAttempts: silentValidators('MS2', 'scrutiny', 'base-1', 1, true),
      objective: { milestones: [PASSED_MS1, FINAL_PASSED] },
      missions: ALL_MERGED,
    }),
    actions: [validate('MS2', 'base-1', ['user-testing']), wakeOf('validation-stuck', 'MS2:scrutiny', 'base-1')],
  },
]);

const EXECUTION_TYPES = new Set(['spawn-worker', 'resume-worker', 'respawn-worker', 'spawn-reviewer', 'rebase', 'merge']);
const BOOKKEEPING_TYPES = new Set(['advance-milestone', 'start-validation', 'complete-objective']);

function withAutopilot(snap: AutopilotSnapshot, autopilot: boolean): AutopilotSnapshot {
  return { ...snap, settings: { ...snap.settings, autopilot } };
}

function actionsOfTypes(snap: AutopilotSnapshot, types: ReadonlySet<string>): AutopilotAction[] {
  return decideAutopilot(snap).actions.filter((action) => types.has(action.type));
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

describe('idempotency and purity', () => {
  it.each(ALL_ROWS)('$name: the same snapshot gives the same decision', ({ snap }) => {
    expect(decideAutopilot(snap)).toEqual(decideAutopilot(snap));
  });

  it.each(ALL_ROWS)('$name: the post-action snapshot repeats no action', ({ snap }) => {
    const first = decideAutopilot(snap);
    const second = decideAutopilot(applyDecision(snap, first));
    const before = new Set(first.actions.map(actionIdentity));
    expect(second.actions.map(actionIdentity).filter((id) => before.has(id))).toEqual([]);
  });

  it.each(ALL_ROWS)('$name: a frozen snapshot decides the same', ({ snap }) => {
    const copy = structuredClone(snap);
    expect(decideAutopilot(deepFreeze(copy))).toEqual(decideAutopilot(snap));
  });

  it.each(ALL_ROWS)('$name: manual mode never emits a feature-execution action', ({ snap }) => {
    expect(actionsOfTypes(withAutopilot(snap, false), EXECUTION_TYPES)).toEqual([]);
  });

  it.each(ALL_ROWS)('$name: manual mode keeps the same objective bookkeeping', ({ snap }) => {
    expect(actionsOfTypes(withAutopilot(snap, false), BOOKKEEPING_TYPES)).toEqual(
      actionsOfTypes(withAutopilot(snap, true), BOOKKEEPING_TYPES),
    );
  });
});

describe('happy-path simulation: two milestones, parallel features, a failed validation and its fix', () => {
  const objective: AutopilotObjective = {
    id: 'O1',
    status: 'executing',
    startedAt: 1_000_000,
    costUsd: 0,
    acceptanceCommands: 1,
    limits: { maxValidationRounds: 3, maxFeatureAttempts: 3 },
    milestones: [
      milestone('MS1', 1, { status: 'active' }),
      milestone('MS2', 2, { validation: { scrutiny: true, userTesting: false, commands: 0 } }),
    ],
  };
  const script: WorldScript = {
    reviewVerdict: (planned, reviewNumber) => (planned.id === 'M2' && reviewNumber === 1 ? 'p1-1items' : 'clean'),
    validationVerdict: (ms, kind, n) => (ms === 'MS1' && kind === 'user-testing' && n === 1 ? 'fail' : 'pass'),
    plan: (ms, reason) =>
      reason === 'validation-failed' ? [plannedFeature('M4', ms)] : [plannedFeature('M5', ms), plannedFeature('M6', ms)],
  };
  const world = new World(
    objective,
    [plannedFeature('M1', 'MS1'), plannedFeature('M2', 'MS1'), plannedFeature('M3', 'MS1', ['M1'])],
    script,
    3,
  );
  const ticks: string[][] = [];
  const overCap: number[] = [];
  for (let tick = 0; tick < 100 && world.objective.status === 'executing'; tick += 1) {
    const decision = decideAutopilot(world.snapshot());
    ticks.push(decision.actions.map(actionIdentity));
    world.apply(decision);
    if (runningAgents(world.snapshot()) > world.settings.maxRunningAgents) overCap.push(tick);
    world.agentsAct();
  }
  const flat = ticks.flat();
  const first = (prefix: string, after = -1): number =>
    flat.findIndex((id, index) => index > after && id.startsWith(prefix));

  it('completes the objective with every feature merged and nothing unexpected', () => {
    expect(world.objective.status).toBe('completed');
    expect(world.unexpected).toEqual([]);
    expect(world.features.map((planned) => `${planned.id}:${planned.status}`)).toEqual(
      ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'].map((id) => `${id}:merged`),
    );
    expect(flat.filter((id) => id.startsWith('merge:'))).toHaveLength(6);
  });

  it('starts independent features in parallel and holds a dependent one back', () => {
    expect(ticks[0]).toEqual(['spawn-worker:M1', 'spawn-worker:M2']);
    expect(first('spawn-worker:M3')).toBeGreaterThan(first('merge:M1'));
    expect(ticks.some((actions) => actions.includes('spawn-worker:M5') && actions.includes('spawn-worker:M6'))).toBe(true);
  });

  it('routes review findings back to the worker and rebases stale branches before merging', () => {
    expect(first('resume-worker:resume-review-findings:M2:')).toBeGreaterThan(-1);
    expect(first('rebase:M2')).toBeLessThan(first('merge:M2'));
    expect(first('rebase:M6')).toBeLessThan(first('merge:M6'));
  });

  it('fails the first milestone validation, plans a fix, re-validates and advances', () => {
    const validation = first('start-validation:MS1:');
    const failure = first('wake-orchestrator:validation-failed:MS1:user-testing-r1', validation);
    const fix = first('spawn-worker:M4', failure);
    const revalidation = first('start-validation:MS1:', fix);
    const advance = first('advance-milestone:MS2', revalidation);
    const plan = first('wake-orchestrator:plan-milestone:MS2:', revalidation);
    const finalValidation = first('start-validation:MS2:', plan);
    const complete = first('complete-objective:O1', finalValidation);
    expect([validation, failure, fix, revalidation, advance, plan, finalValidation, complete].every((index) => index >= 0)).toBe(true);
    expect(advance).toBeLessThan(plan);
    expect(flat[validation]).toMatch(/:scrutiny\+user-testing$/);
    expect(flat[revalidation]).not.toBe(flat[validation]);
    expect(flat[finalValidation]).toMatch(/:scrutiny\+commands$/);
    expect(complete).toBe(flat.length - 1);
  });

  it('never exceeds maxRunningAgents, never stalls and never repeats an action on the next tick', () => {
    expect(overCap).toEqual([]);
    expect(flat.filter((id) => id.includes('stalled') || id.startsWith('block-objective'))).toEqual([]);
    for (let tick = 1; tick < ticks.length; tick += 1) {
      expect(ticks[tick]!.filter((id) => ticks[tick - 1]!.includes(id))).toEqual([]);
    }
  });
});
