import { describe, expect, it } from 'vitest';

import {
  computeProgressKey,
  decideAutopilot,
  digest,
  type AutopilotAction,
  type AutopilotObjectiveStatus,
  type AutopilotSnapshot,
  type AutopilotWakeReason,
} from '../../src/autopilot/index.ts';
import {
  BASE,
  NOW,
  actionIdentity,
  applyDecision,
  awaitingReview,
  feature,
  mergeable,
  merged,
  milestone,
  snapshot,
  worker,
  working,
} from './fixtures.ts';

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
  { name: 'an idle worker without findings is left waiting', snap: snapshot({ missions: [working('M1', { worker: IDLE })] }), actions: [] },
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
    snap: snapshot({
      settings: { maxRunningAgents: 8 },
      missions: [
        mergeable('M1'),
        { ...STALE, id: 'M2', tip: 'tip-M2' },
        awaitingReview('M3'),
        { ...FINDINGS, id: 'M4', tip: 'tip-M4' },
        working('M5', { worker: worker({ state: 'dead', name: 'w-M5' }) }),
        feature('M6'),
        { ...CONFLICT, id: 'M7', tip: 'tip-M7' },
      ],
    }),
    actions: [
      merge('M1'),
      rebase('M2'),
      reviewer('M3'),
      { type: 'resume-worker', mission: 'M4', worker: 'w-M1', reason: 'review-findings', key: 'resume-review-findings:M4:tip-M4#0' },
      { type: 'respawn-worker', mission: 'M5', attempt: 2, previousWorker: 'w-M5' },
      spawn('M6'),
      { type: 'resume-worker', mission: 'M7', worker: 'w-M1', reason: 'rebase-conflict', key: `resume-rebase-conflict:M7:tip-M7@${BASE}` },
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
