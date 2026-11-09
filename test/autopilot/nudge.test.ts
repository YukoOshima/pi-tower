import { describe, expect, it } from 'vitest';

import {
  currentMilestone,
  decideAutopilot,
  runningAgents,
  type AutopilotAction,
  type AutopilotMilestone,
  type AutopilotMission,
  type AutopilotMissionStatus,
  type AutopilotSnapshot,
  type AutopilotWorkerState,
} from '../../src/autopilot/index.ts';
import { actionIdentity, applyDecision, feature, milestone, snapshot, worker, working } from './fixtures.ts';

const SILENT = working('M1', { worker: worker({ state: 'idle', name: 'w-M1' }) });
const NUDGE = { type: 'resume-worker', mission: 'M1', worker: 'w-M1', reason: 'continue', key: 'resume-continue:M1:tip-M1' };

function workerIdleWake(mission: string, tip: string): unknown {
  return expect.objectContaining({ type: 'wake-orchestrator', reason: 'worker-idle', subject: mission, revision: tip, key: `worker-idle:${mission}:${tip}` });
}

function endTurn(snap: AutopilotSnapshot, mission: AutopilotMission, quietMs = 60_000): AutopilotSnapshot {
  return {
    ...snap,
    now: snap.now + quietMs,
    orchestratorBusy: false,
    missions: snap.missions.map((candidate) => (candidate.id === mission.id ? mission : candidate)),
  };
}

describe('a worker that stops silently on an active feature', () => {
  it('is nudged once, reported once when it stops again on the same tip, then left to the stall watchdog', () => {
    let snap = snapshot({ missions: [SILENT] });
    const nudged = decideAutopilot(snap);
    expect(nudged.actions).toEqual([NUDGE]);
    snap = endTurn(applyDecision(snap, nudged), SILENT);
    const reported = decideAutopilot(snap);
    expect(reported.actions).toEqual([workerIdleWake('M1', 'tip-M1')]);
    snap = endTurn(applyDecision(snap, reported), SILENT);
    const quiet = decideAutopilot(snap);
    expect(quiet.actions).toEqual([]);
    snap = endTurn(applyDecision(snap, quiet), SILENT, snap.settings.stallTimeoutMs);
    expect(decideAutopilot(snap).actions).toEqual([expect.objectContaining({ type: 'wake-orchestrator', reason: 'stalled' })]);
  });

  it('is nudged again once its new commit moved the tip', () => {
    let snap = snapshot({ missions: [SILENT] });
    snap = endTurn(applyDecision(snap, decideAutopilot(snap)), { ...SILENT, tip: 'tip-M1b' });
    expect(decideAutopilot(snap).actions).toEqual([{ ...NUDGE, key: 'resume-continue:M1:tip-M1b' }]);
  });

  it('is never nudged again after it finished with TowerComplete', () => {
    let snap = snapshot({ missions: [SILENT] });
    snap = endTurn(applyDecision(snap, decideAutopilot(snap)), { ...SILENT, status: 'completed', reviewRequestOnTip: true, gate: { ready: false, blocks: ['no-review'] } });
    expect(decideAutopilot(snap).actions).toEqual([{ type: 'spawn-reviewer', mission: 'M1' }]);
  });

  it('in manual mode is reported once per tip and never resumed', () => {
    let snap = snapshot({ settings: { autopilot: false }, missions: [SILENT] });
    const reported = decideAutopilot(snap);
    expect(reported.actions).toEqual([workerIdleWake('M1', 'tip-M1')]);
    snap = endTurn(applyDecision(snap, reported), SILENT);
    expect(decideAutopilot(snap).actions).toEqual([]);
    snap = endTurn(snap, { ...SILENT, tip: 'tip-M1b' });
    expect(decideAutopilot(snap).actions).toEqual([workerIdleWake('M1', 'tip-M1b')]);
  });
});

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const STATUSES: AutopilotMissionStatus[] = ['planned', 'active', 'active', 'active', 'completed', 'blocked', 'paused', 'merged', 'abandoned'];
const WORKER_STATES: AutopilotWorkerState[] = ['none', 'running', 'idle', 'idle', 'idle', 'dead'];
const MISSION_MILESTONES = ['MS1', 'MS1', 'MS2', undefined, 'MS9'];
const OPEN_GATES = [
  { ready: false, blocks: ['not-completed'] },
  { ready: false, blocks: ['not-completed', 'stale-base'] },
];
const COMPLETED_GATES = [
  { ready: false, blocks: ['no-review'] },
  { ready: false, blocks: ['stale-base'] },
  { ready: true, blocks: [] },
];
const MILESTONE_PLANS: AutopilotMilestone[][] = [
  [milestone('MS1', 1, { status: 'active' }), milestone('MS2', 2)],
  [milestone('MS1', 1, { status: 'passed' }), milestone('MS2', 2)],
  [milestone('MS1', 1, { status: 'passed' }), milestone('MS2', 2, { status: 'active' })],
];

function randomSnapshot(random: () => number): AutopilotSnapshot {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const chance = (p: number): boolean => random() < p;
  const missions = Array.from({ length: 1 + Math.floor(random() * 6) }, (_, index): AutopilotMission => {
    const id = `M${String(index + 1)}`;
    const status = pick(STATUSES);
    const state = pick(WORKER_STATES);
    const tip = chance(0.9) ? `tip-${id}${pick(['', 'b'])}` : undefined;
    return feature(id, {
      status,
      milestone: pick(MISSION_MILESTONES),
      attempts: state === 'none' ? 0 : 1,
      ...(tip === undefined ? {} : { tip }),
      worker: worker({
        state,
        ...(state === 'none' || chance(0.05) ? {} : { name: `w-${id}` }),
        humanStopped: chance(0.15),
        unreadFindings: chance(0.2),
        awaitingReply: chance(0.2),
      }),
      reviewRequestOnTip: chance(0.3),
      reviewerRunning: chance(0.1),
      rebaseConflict: chance(0.1),
      blockers: chance(0.15) ? ['need input'] : [],
      gate: pick(status === 'completed' ? COMPLETED_GATES : OPEN_GATES),
    });
  });
  const keys = missions
    .flatMap((mission) => [`resume-continue:${mission.id}:${mission.tip ?? '-'}`, `worker-idle:${mission.id}:${mission.tip ?? '-'}`])
    .filter(() => chance(0.3));
  return snapshot({
    settings: { autopilot: chance(0.7), maxRunningAgents: 1 + Math.floor(random() * 4) },
    objective: { milestones: pick(MILESTONE_PLANS) },
    missions,
    memory: { wakeKeys: keys },
  });
}

function stoppedSilently(snap: AutopilotSnapshot, mission: AutopilotMission): boolean {
  const objective = snap.objective!;
  const current = currentMilestone(objective);
  const order = objective.milestones.find((candidate) => candidate.id === mission.milestone)?.order;
  return (
    order !== undefined &&
    order <= (current?.order ?? Number.POSITIVE_INFINITY) &&
    !(current?.status === 'pending' && current.id === mission.milestone) &&
    mission.status === 'active' &&
    mission.worker.state === 'idle' &&
    !mission.worker.humanStopped &&
    !mission.worker.unreadFindings &&
    !mission.worker.awaitingReply &&
    !mission.rebaseConflict &&
    mission.blockers.length === 0
  );
}

function nudgedMission(action: AutopilotAction): string | undefined {
  if (action.type === 'resume-worker' && action.reason === 'continue') return action.mission;
  if (action.type === 'wake-orchestrator' && action.reason === 'worker-idle') return action.subject;
  return undefined;
}

function nudges(actions: readonly AutopilotAction[]): AutopilotAction[] {
  return actions.filter((action) => nudgedMission(action) !== undefined);
}

const SNAPSHOTS = Array.from({ length: 2_000 }, (_, seed) => randomSnapshot(seeded(seed + 1)));

describe('continue nudge invariants over random snapshots', () => {
  it('exercise silent stops, nudges, wakes, workers awaiting a reply and rebases planned in the tick', () => {
    const counts = { silent: 0, awaiting: 0, rebased: 0, nudges: 0, wakes: 0, manualWakes: 0 };
    for (const snap of SNAPSHOTS) {
      const { actions } = decideAutopilot(snap);
      for (const mission of snap.missions) {
        const replied = { ...mission, worker: { ...mission.worker, awaitingReply: false } };
        if (mission.worker.awaitingReply && stoppedSilently(snap, replied)) counts.awaiting += 1;
        if (!stoppedSilently(snap, mission)) continue;
        counts.silent += 1;
        if (actions.some((action) => action.type === 'rebase' && action.mission === mission.id)) counts.rebased += 1;
      }
      for (const action of actions) {
        if (action.type === 'resume-worker' && action.reason === 'continue') counts.nudges += 1;
        if (action.type !== 'wake-orchestrator' || action.reason !== 'worker-idle') continue;
        counts.wakes += 1;
        if (!snap.settings.autopilot) counts.manualWakes += 1;
      }
    }
    for (const count of Object.values(counts)) expect(count).toBeGreaterThan(0);
  });

  it('resumes only an idle, nameable, unstopped worker of an active objective feature, once per tip and only with the autopilot on', () => {
    for (const snap of SNAPSHOTS) {
      for (const action of decideAutopilot(snap).actions) {
        if (action.type !== 'resume-worker' || action.reason !== 'continue') continue;
        const mission = snap.missions.find((candidate) => candidate.id === action.mission)!;
        expect(stoppedSilently(snap, mission)).toBe(true);
        expect(snap.settings.autopilot).toBe(true);
        expect(action.worker).toBe(mission.worker.name);
        expect(action.key).toBe(`resume-continue:${mission.id}:${mission.tip ?? '-'}`);
        expect(snap.memory.wakeKeys).not.toContain(action.key);
      }
    }
  });

  it('reports a silent stop only after its nudge on that tip was sent, at once in manual mode, and once per tip', () => {
    for (const snap of SNAPSHOTS) {
      for (const action of decideAutopilot(snap).actions) {
        if (action.type !== 'wake-orchestrator' || action.reason !== 'worker-idle') continue;
        const mission = snap.missions.find((candidate) => candidate.id === action.subject)!;
        const tip = mission.tip ?? '-';
        expect(stoppedSilently(snap, mission)).toBe(true);
        expect(action.revision).toBe(tip);
        expect(snap.memory.wakeKeys).not.toContain(action.key);
        if (snap.settings.autopilot && mission.worker.name !== undefined) {
          expect(snap.memory.wakeKeys).toContain(`resume-continue:${mission.id}:${tip}`);
        }
      }
    }
  });

  it('gives every silent stop its nudge or its wake unless its rebase is planned in the tick or the agent slots are full', () => {
    for (const snap of SNAPSHOTS) {
      const { actions } = decideAutopilot(snap);
      const free = Math.max(0, snap.settings.maxRunningAgents - runningAgents(snap));
      const slotted = actions.filter((action) => action.type === 'spawn-reviewer' || action.type === 'resume-worker').length;
      for (const mission of snap.missions.filter((candidate) => stoppedSilently(snap, candidate))) {
        const tip = mission.tip ?? '-';
        const nudged = snap.memory.wakeKeys.includes(`resume-continue:${mission.id}:${tip}`);
        const woken = snap.memory.wakeKeys.includes(`worker-idle:${mission.id}:${tip}`);
        const rebased = actions.some((action) => action.type === 'rebase' && action.mission === mission.id);
        const found = actions.filter((action) => nudgedMission(action) === mission.id);
        if (rebased) {
          expect(found).toEqual([]);
        } else if (snap.settings.autopilot && mission.worker.name !== undefined && !nudged) {
          if (found.length === 0) expect(slotted).toBe(free);
          else expect(found).toEqual([expect.objectContaining({ type: 'resume-worker', reason: 'continue' })]);
        } else if (!woken) {
          expect(found).toEqual([expect.objectContaining({ type: 'wake-orchestrator', reason: 'worker-idle' })]);
        } else {
          expect(found).toEqual([]);
        }
      }
    }
  });

  it('never nudges or reports a worker awaiting the reply to its own message', () => {
    for (const snap of SNAPSHOTS) {
      for (const action of decideAutopilot(snap).actions) {
        const id = nudgedMission(action);
        if (id === undefined) continue;
        expect(snap.missions.find((candidate) => candidate.id === id)!.worker.awaitingReply).toBe(false);
      }
    }
  });

  it('the post-action snapshot repeats no nudge and no worker-idle wake', () => {
    for (const snap of SNAPSHOTS) {
      const first = decideAutopilot(snap);
      const sent = new Set(nudges(first.actions).map(actionIdentity));
      const second = decideAutopilot(applyDecision(snap, first));
      expect(nudges(second.actions).map(actionIdentity).filter((identity) => sent.has(identity))).toEqual([]);
    }
  });
});
