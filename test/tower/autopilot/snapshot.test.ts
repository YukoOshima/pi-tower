import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  TowerInboxItem,
  TowerMission,
  TowerMissionGateResult,
  TowerObjective,
  TowerReviewInfo,
  TowerRosterEntry,
  TowerState,
  TowerStore,
} from '../../../src/protocol/index.ts';
import {
  NO_PENDING_WORK,
  buildAutopilotSnapshot,
  observeAutopilotWorld,
  type AutopilotWorld,
} from '../../../src/tower/autopilot/snapshot.ts';
import type {
  AutopilotAgentObservation,
  AutopilotObservations,
  AutopilotRuntimeSettings,
} from '../../../src/tower/autopilot/types.ts';
import { commitFile, createRepo, createStore, git } from './repo.ts';

const T0 = Date.parse('2026-11-09T10:00:00.000Z');
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

const SETTINGS: AutopilotRuntimeSettings = {
  autopilot: true,
  autoApprove: false,
  maxValidationRounds: 3,
  maxFeatureAttempts: 3,
  skipScrutiny: false,
  skipUserTesting: false,
  maxRunningAgents: 4,
  watchdogIntervalMs: 60_000,
  stallTimeoutMs: 180_000,
  maxStallWakes: 3,
};

function mission(id: string, overrides: Partial<TowerMission> = {}): TowerMission {
  return {
    id,
    title: `Feature ${id}`,
    slug: `feature-${id.toLowerCase()}`,
    kind: 'build',
    scope: [`src/${id.toLowerCase()}/**`],
    branch: `feat/feature-${id.toLowerCase()}`,
    worktree: `wt-${id.slice(1)}`,
    deps: [],
    status: 'active',
    tasks: [],
    notes: [],
    blockers: [],
    milestone: 'MS1',
    attempts: 1,
    ...overrides,
  };
}

function objective(overrides: Partial<TowerObjective> = {}): TowerObjective {
  return {
    id: 'O1',
    title: 'Ship',
    goal: 'ship it',
    definitionOfDone: ['works'],
    acceptanceCommands: ['npm test'],
    status: 'executing',
    milestones: [
      {
        id: 'MS1',
        title: 'Core',
        order: 1,
        validation: { scrutiny: true, userTesting: false, commands: ['npm run lint', 'npm run build'] },
        status: 'active',
        rounds: [],
      },
    ],
    limits: { maxValidationRounds: 3, maxFeatureAttempts: 3, maxCostUsd: 10 },
    createdAt: iso(-60_000),
    startedAt: iso(-30_000),
    usage: { costUsd: 1.5 },
    notes: [],
    ...overrides,
  };
}

function agent(name: string, overrides: Partial<TowerRosterEntry> = {}): TowerRosterEntry {
  return { name, agentId: `id-${name}`, kind: 'worker', spawnedAt: iso(0), ...overrides };
}

function towerState(overrides: Partial<TowerState> = {}): TowerState {
  return {
    version: 1,
    base: 'main',
    mode: 'branch',
    createdAt: iso(-120_000),
    roster: { agents: [] },
    missions: [],
    objective: objective(),
    ...overrides,
  };
}

function gate(tip: string | undefined, overrides: Partial<TowerMissionGateResult> = {}): TowerMissionGateResult {
  return {
    ready: false,
    noop: false,
    blocks: [{ reason: 'not-completed', message: 'merge blocked: not completed' }],
    observations: {
      baseTip: 'base',
      headTip: 'base',
      baseDirtyFiles: [],
      ...(tip === undefined
        ? {}
        : { branch: { tip, baseIsAncestor: true, diffBase: 'base', changedFiles: [], mergeTouchedFiles: [] } }),
    },
    ...overrides,
  };
}

function review(reviewer: string, commit: string, overrides: Partial<TowerReviewInfo> = {}): TowerReviewInfo {
  return {
    reviewer,
    target: 'feat/feature-m1',
    round: 1,
    status: 'clean',
    merge: 'merge',
    reviewedCommit: commit,
    date: '2026-11-09',
    file: `.tower/comms/reviews/review-${reviewer}.md`,
    mtimeMs: T0,
    mission: 'M1',
    ...overrides,
  };
}

let messageCounter = 0;
function message(overrides: Partial<TowerInboxItem>): TowerInboxItem {
  messageCounter += 1;
  return {
    messageId: `msg-${String(messageCounter)}`,
    file: `.tower/comms/inbox/msg-${String(messageCounter)}.md`,
    from: 'w1',
    to: 'tower',
    subject: 'note',
    sentAt: iso(0),
    body: '',
    ...overrides,
  };
}

type WorldParts = Partial<Omit<AutopilotWorld, 'agent'>> & {
  readonly agents?: Readonly<Record<string, AutopilotAgentObservation>>;
};

function world(parts: WorldParts = {}): AutopilotWorld {
  const { agents = {}, ...rest } = parts;
  return {
    now: T0 + 60_000,
    state: towerState(),
    baseTip: 'base',
    settings: SETTINGS,
    orchestratorBusy: false,
    agent: (agentId) => agents[agentId],
    gates: new Map(),
    reviews: new Map(),
    commitTimes: new Map(),
    inbox: [],
    reviewCount: 0,
    pending: NO_PENDING_WORK,
    ...rest,
  };
}

describe('buildAutopilotSnapshot — objective, settings and memory', () => {
  it('maps the objective, its milestones and the runtime settings', () => {
    const snap = buildAutopilotSnapshot(world());
    expect(snap.now).toBe(T0 + 60_000);
    expect(snap.objective).toEqual({
      id: 'O1',
      status: 'executing',
      startedAt: T0 - 30_000,
      costUsd: 1.5,
      acceptanceCommands: 1,
      limits: { maxValidationRounds: 3, maxFeatureAttempts: 3, maxCostUsd: 10 },
      milestones: [
        { id: 'MS1', order: 1, status: 'active', validation: { scrutiny: true, userTesting: false, commands: 2 }, rounds: [] },
      ],
    });
    expect(snap.settings).toEqual({
      autopilot: true,
      maxRunningAgents: 4,
      stallTimeoutMs: 180_000,
      maxStallWakes: 3,
      skipScrutiny: false,
      skipUserTesting: false,
    });
  });

  it('keeps only rounds of the current contract revision and passes validationCommit through', () => {
    const base = objective();
    const snap = buildAutopilotSnapshot(
      world({
        state: towerState({
          objective: {
            ...base,
            contractRevision: 2,
            milestones: [
              {
                ...base.milestones[0]!,
                status: 'validating',
                validationCommit: 'c2',
                rounds: [
                  { round: 1, kind: 'scrutiny', validator: 'v1', validatedCommit: 'c1', verdict: 'fail', failures: ['x'], file: 'f1', date: iso(0) },
                  { round: 2, kind: 'scrutiny', validator: 'v2', validatedCommit: 'c2', verdict: 'pass', failures: [], file: 'f2', date: iso(0), contractRevision: 1 },
                  { round: 3, kind: 'commands', validator: 'tower', validatedCommit: 'c2', verdict: 'fail', failures: ['y'], file: 'f3', date: iso(0), contractRevision: 2 },
                ],
              },
            ],
          },
        }),
      }),
    );
    expect(snap.objective?.milestones[0]).toMatchObject({
      validationCommit: 'c2',
      rounds: [{ kind: 'commands', round: 3, commit: 'c2', verdict: 'fail' }],
    });
  });

  it('reads the autopilot memory with progressAt in epoch ms', () => {
    const snap = buildAutopilotSnapshot(
      world({
        state: towerState({
          objective: objective({ autopilot: { progressKey: 'k1', progressAt: iso(5_000), stallWakes: 2, wakeKeys: ['a', 'b'] } }),
        }),
      }),
    );
    expect(snap.memory).toEqual({ progressKey: 'k1', progressAt: T0 + 5_000, stallWakes: 2, wakeKeys: ['a', 'b'] });
    expect(buildAutopilotSnapshot(world()).memory).toEqual({ stallWakes: 0, wakeKeys: [] });
  });

  it('has no objective when the state has none', () => {
    const snap = buildAutopilotSnapshot(world({ state: towerState({ objective: undefined }) }));
    expect(snap.objective).toBeUndefined();
  });

  it('counts only inbox messages from agents, never what the tower itself delivers', () => {
    const snap = buildAutopilotSnapshot(
      world({
        inbox: [
          message({ from: 'w1' }),
          message({ from: 'v1', action: 'validation-result' }),
          message({ from: 'tower', to: 'tower', action: 'validation-result' }),
          message({ from: 'tower', to: 'w1' }),
        ],
        reviewCount: 7,
      }),
    );
    expect(snap.inboxCount).toBe(2);
    expect(snap.reviewCount).toBe(7);
  });
});

describe('buildAutopilotSnapshot — workers', () => {
  const cases: Array<{ name: string; observation?: AutopilotAgentObservation; died?: boolean; state: string; human?: boolean }> = [
    { name: 'running', observation: { status: 'running' }, state: 'running' },
    { name: 'idle', observation: { status: 'idle' }, state: 'idle' },
    { name: 'unknown is idle, never running', observation: { status: 'unknown' }, state: 'idle' },
    { name: 'unknown and marked died is dead', observation: { status: 'unknown' }, died: true, state: 'dead' },
    { name: 'gone from the runtime is dead', state: 'dead' },
    { name: 'completed is dead', observation: { status: 'completed' }, state: 'dead' },
    { name: 'failed is dead', observation: { status: 'failed' }, state: 'dead' },
    { name: 'timeout is dead', observation: { status: 'timeout' }, state: 'dead' },
    { name: 'stopped by the tower is dead', observation: { status: 'stopped', stopReason: 'stopped by the tower: x' }, state: 'dead', human: false },
    { name: 'stopped by the human is dead and human-stopped', observation: { status: 'stopped', stopReason: 'user' }, state: 'dead', human: true },
  ];
  it.each(cases)('$name', ({ observation, died, state, human }) => {
    const entry = agent('w1', { missionId: 'M1', ...(died === true ? { diedAt: iso(1) } : {}) });
    const snap = buildAutopilotSnapshot(
      world({
        state: towerState({ missions: [mission('M1')], roster: { agents: [entry] } }),
        agents: observation === undefined ? {} : { 'id-w1': observation },
      }),
    );
    expect(snap.missions[0]!.worker).toEqual({ state, name: 'w1', humanStopped: human ?? false, unreadFindings: false });
  });

  it('reads a human stop from the roster death record after the runtime forgot the agent', () => {
    const entry = agent('w1', { missionId: 'M1', diedAt: iso(1), deathStatus: 'stopped', deathReason: 'user' });
    const snap = buildAutopilotSnapshot(world({ state: towerState({ missions: [mission('M1')], roster: { agents: [entry] } }) }));
    expect(snap.missions[0]!.worker).toMatchObject({ state: 'dead', humanStopped: true });
  });

  it('uses the latest worker of the mission and reports none without one', () => {
    const snap = buildAutopilotSnapshot(
      world({
        state: towerState({
          missions: [mission('M1'), mission('M2', { attempts: 0, status: 'planned' })],
          roster: { agents: [agent('w-old', { missionId: 'M1' }), agent('w-new', { missionId: 'M1' })] },
        }),
        agents: { 'id-w-old': { status: 'failed' }, 'id-w-new': { status: 'running' } },
      }),
    );
    expect(snap.missions[0]!.worker).toMatchObject({ state: 'running', name: 'w-new' });
    expect(snap.missions[1]!.worker).toEqual({ state: 'none', humanStopped: false, unreadFindings: false });
    expect(snap.missions[1]!.attempts).toBe(0);
  });

  it('flags unread review findings addressed to the worker only until it reads or acks them', () => {
    const findings = message({ from: 'r1', to: 'w1', action: 'review-result', scope: 'M1', sentAt: iso(10_000), messageId: 'f1' });
    const build = (entry: TowerRosterEntry) =>
      buildAutopilotSnapshot(
        world({ state: towerState({ missions: [mission('M1')], roster: { agents: [entry] } }), inbox: [findings] }),
      ).missions[0]!.worker.unreadFindings;
    expect(build(agent('w1', { missionId: 'M1' }))).toBe(true);
    expect(build(agent('w1', { missionId: 'M1', lastInboxReadAt: iso(20_000) }))).toBe(false);
    expect(build(agent('w1', { missionId: 'M1', inboxAckIds: ['f1'] }))).toBe(false);
    expect(build(agent('w2', { missionId: 'M1' }))).toBe(false);
  });
});

describe('buildAutopilotSnapshot — review and gate facts', () => {
  const TIP = 'tip-1';

  function completedWorld(parts: WorldParts = {}, missionOverrides: Partial<TowerMission> = {}): AutopilotWorld {
    return world({
      state: towerState({
        missions: [mission('M1', { status: 'completed', ...missionOverrides })],
        roster: { agents: [agent('w1', { missionId: 'M1' })] },
      }),
      agents: { 'id-w1': { status: 'idle' } },
      gates: new Map([['M1', gate(TIP, { blocks: [{ reason: 'no-review', message: 'm' }] })]]),
      commitTimes: new Map([[TIP, { committedAt: T0 + 5_000, authoredAt: T0 + 5_000 }]]),
      inbox: [message({ action: 'complete', subject: 'review-request', scope: 'M1', sentAt: iso(6_000) })],
      ...parts,
    });
  }

  it('maps the tip and gate codes of an open feature', () => {
    const snap = buildAutopilotSnapshot(completedWorld());
    expect(snap.missions[0]).toMatchObject({ tip: TIP, gate: { ready: false, blocks: ['no-review'] } });
  });

  it('a review-request sent after the tip was committed covers the tip', () => {
    expect(buildAutopilotSnapshot(completedWorld()).missions[0]!.reviewRequestOnTip).toBe(true);
  });

  it('a commit after the latest review-request is not covered', () => {
    const snap = buildAutopilotSnapshot(
      completedWorld({ commitTimes: new Map([[TIP, { committedAt: T0 + 7_000, authoredAt: T0 + 7_000 }]]) }),
    );
    expect(snap.missions[0]!.reviewRequestOnTip).toBe(false);
  });

  it('a tower rebase keeps the review-request valid through the preserved author date', () => {
    const snap = buildAutopilotSnapshot(
      completedWorld(
        { commitTimes: new Map([[TIP, { committedAt: T0 + 9_000, authoredAt: T0 + 5_000 }]]) },
        { lastRebase: { fromCommit: 'tip-0', toCommit: TIP } },
      ),
    );
    expect(snap.missions[0]!.reviewRequestOnTip).toBe(true);
  });

  it('needs a completed build mission and a request scoped to it', () => {
    expect(buildAutopilotSnapshot(completedWorld({}, { status: 'active' })).missions[0]!.reviewRequestOnTip).toBe(false);
    expect(
      buildAutopilotSnapshot(
        completedWorld({ inbox: [message({ action: 'complete', subject: 'review-request', scope: 'M2', sentAt: iso(6_000) })] }),
      ).missions[0]!.reviewRequestOnTip,
    ).toBe(false);
  });

  it('reports the latest review on the tip, carried over by a clean-rebase waiver, but not a stale one', () => {
    const exact = gate(TIP, { selectedReview: review('r1', TIP), reviewBinding: 'exact-tip' });
    const waived = gate(TIP, { selectedReview: review('r1', 'tip-0', { status: 'p1-2items', merge: 'hold' }), reviewBinding: 'clean-rebase-waived' });
    const stale = gate(TIP, { selectedReview: review('r1', 'tip-0'), reviewBinding: 'stale-tip' });
    const latest = (value: TowerMissionGateResult) =>
      buildAutopilotSnapshot(completedWorld({ gates: new Map([['M1', value]]) })).missions[0]!.latestReviewOnTip;
    expect(latest(exact)).toEqual({ status: 'clean', merge: 'merge' });
    expect(latest(waived)).toEqual({ status: 'p1-2items', merge: 'hold' });
    expect(latest(stale)).toBeUndefined();
  });

  it('counts reviewers spawned for the current tip that ended without a review', () => {
    const reviewers = [
      agent('r-running', { kind: 'reviewer', reviewTarget: 'feat/feature-m1', reviewMissionId: 'M1', spawnedAt: iso(8_000) }),
      agent('r-died', { kind: 'reviewer', reviewTarget: 'feat/feature-m1', reviewMissionId: 'M1', spawnedAt: iso(8_000) }),
      agent('r-idle', { kind: 'reviewer', reviewTarget: 'feat/feature-m1', reviewMissionId: 'M1', spawnedAt: iso(9_000) }),
      agent('r-unknown', { kind: 'reviewer', reviewTarget: 'feat/feature-m1', spawnedAt: iso(9_000) }),
      agent('r-reviewed', { kind: 'reviewer', reviewTarget: 'feat/feature-m1', reviewMissionId: 'M1', spawnedAt: iso(9_000) }),
      agent('r-older-tip', { kind: 'reviewer', reviewTarget: 'feat/feature-m1', reviewMissionId: 'M1', spawnedAt: iso(1_000) }),
      agent('r-other', { kind: 'reviewer', reviewTarget: 'feat/other', reviewMissionId: 'M9', spawnedAt: iso(9_000) }),
    ];
    const snap = buildAutopilotSnapshot(
      completedWorld({
        state: towerState({
          missions: [mission('M1', { status: 'completed' })],
          roster: { agents: [agent('w1', { missionId: 'M1' }), ...reviewers] },
        }),
        agents: {
          'id-w1': { status: 'idle' },
          'id-r-running': { status: 'running' },
          'id-r-died': { status: 'failed' },
          'id-r-idle': { status: 'idle' },
          'id-r-unknown': { status: 'unknown' },
        },
        reviews: new Map([['M1', [review('r-reviewed', 'tip-0')]]]),
      }),
    );
    expect(snap.missions[0]).toMatchObject({ reviewerRunning: true, reviewerAttemptsOnTip: 3 });
  });

  it('an unobservable reviewer is never running', () => {
    const snap = buildAutopilotSnapshot(
      completedWorld({
        state: towerState({
          missions: [mission('M1', { status: 'completed' })],
          roster: { agents: [agent('r1', { kind: 'reviewer', reviewTarget: 'feat/feature-m1', reviewMissionId: 'M1' })] },
        }),
        agents: { 'id-r1': { status: 'unknown' } },
      }),
    );
    expect(snap.missions[0]!.reviewerRunning).toBe(false);
  });

  it('splits the tower rebase-conflict blocker from worker blockers', () => {
    const snap = buildAutopilotSnapshot(
      completedWorld({}, {
        status: 'blocked',
        blockers: ['tower rebase onto main conflicted in: src/a.ts — the rebase was aborted', 'which API version?'],
      }),
    );
    expect(snap.missions[0]).toMatchObject({ rebaseConflict: true, blockers: ['which API version?'] });
  });

  it('closed missions and missions outside the objective carry no gate', () => {
    const snap = buildAutopilotSnapshot(
      world({ state: towerState({ missions: [mission('M1', { status: 'merged' }), mission('M2', { milestone: undefined })] }) }),
    );
    expect(snap.missions.map((entry) => entry.gate)).toEqual([
      { ready: false, blocks: [] },
      { ready: false, blocks: [] },
    ]);
    expect(snap.missions[1]!.milestone).toBeUndefined();
  });
});

describe('buildAutopilotSnapshot — validators and live agents', () => {
  const validating = objective({
    contractRevision: 1,
    milestones: [
      {
        id: 'MS1',
        title: 'Core',
        order: 1,
        validation: { scrutiny: true, userTesting: true, commands: [] },
        status: 'validating',
        validationCommit: 'c1',
        rounds: [{ round: 1, kind: 'scrutiny', validator: 'v-done', validatedCommit: 'c1', verdict: 'pass', failures: [], file: 'f', date: iso(0), contractRevision: 1 }],
      },
    ],
  });
  const validator = (name: string, overrides: Partial<TowerRosterEntry> = {}): TowerRosterEntry =>
    agent(name, { kind: 'validator', milestoneId: 'MS1', validationKind: 'user-testing', validatedCommit: 'c1', contractRevision: 1, ...overrides });

  it('reports running validators in flight and ended ones without a verdict as attempts', () => {
    const snap = buildAutopilotSnapshot(
      world({
        state: towerState({
          objective: validating,
          roster: {
            agents: [
              validator('v-run'),
              validator('v-dead'),
              validator('v-idle'),
              validator('v-unknown'),
              validator('v-done', { validationKind: 'scrutiny' }),
              validator('v-old-revision', { contractRevision: 0 }),
              validator('v-old-commit', { validatedCommit: 'c0' }),
            ],
          },
        }),
        agents: {
          'id-v-run': { status: 'running' },
          'id-v-dead': { status: 'failed' },
          'id-v-idle': { status: 'idle' },
          'id-v-unknown': { status: 'unknown' },
          'id-v-done': { status: 'completed' },
        },
      }),
    );
    expect(snap.validators).toEqual([{ milestone: 'MS1', kind: 'user-testing', commit: 'c1', name: 'v-run' }]);
    expect(snap.validationAttempts).toEqual([
      { milestone: 'MS1', kind: 'user-testing', commit: 'c1', attempts: 3 },
      { milestone: 'MS1', kind: 'user-testing', commit: 'c0', attempts: 1 },
    ]);
  });

  it('reports pending validator spawns and commands runs as live runs without double counting', () => {
    const snap = buildAutopilotSnapshot(
      world({
        state: towerState({ objective: validating, roster: { agents: [validator('v-run')] } }),
        agents: { 'id-v-run': { status: 'running' } },
        pending: {
          agents: [],
          validators: [
            { milestone: 'MS1', kind: 'user-testing', commit: 'c1', name: 'v-run' },
            { milestone: 'MS1', kind: 'scrutiny', commit: 'c1', name: 'v-next' },
            { milestone: 'MS1', kind: 'commands', commit: 'c1' },
          ],
        },
      }),
    );
    expect(snap.validators).toEqual([
      { milestone: 'MS1', kind: 'user-testing', commit: 'c1', name: 'v-run' },
      { milestone: 'MS1', kind: 'scrutiny', commit: 'c1', name: 'v-next' },
      { milestone: 'MS1', kind: 'commands', commit: 'c1' },
    ]);
    expect(snap.otherRunningAgents).toBe(0);
  });

  it('counts unrepresented running agents and deferred agent effects as other running agents', () => {
    const snap = buildAutopilotSnapshot(
      world({
        state: towerState({
          missions: [mission('M1'), mission('M2', { milestone: undefined })],
          roster: {
            agents: [
              agent('w-old', { missionId: 'M1' }),
              agent('w1', { missionId: 'M1' }),
              agent('w2', { missionId: 'M2' }),
              agent('r-loose', { kind: 'reviewer', reviewTarget: 'feat/nowhere' }),
              agent('w-idle', { missionId: 'M3' }),
            ],
          },
        }),
        agents: {
          'id-w-old': { status: 'running' },
          'id-w1': { status: 'running' },
          'id-w2': { status: 'running' },
          'id-r-loose': { status: 'running' },
          'id-w-idle': { status: 'idle' },
        },
        pending: { agents: ['ap-w-M4-1', 'w1', 'w-idle'], validators: [] },
      }),
    );
    expect(snap.missions.filter((entry) => entry.worker.state === 'running')).toHaveLength(2);
    expect(snap.otherRunningAgents).toBe(4);
  });
});

describe('observeAutopilotWorld on a real repository', () => {
  let repo: string;
  let store: TowerStore;

  beforeEach(async () => {
    repo = await createRepo('tower-snapshot-');
    store = await createStore(repo);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  function observations(agents: Record<string, AutopilotAgentObservation>): AutopilotObservations {
    return {
      now: () => T0,
      store: () => store,
      settings: () => SETTINGS,
      agent: (agentId) => agents[agentId],
      orchestratorBusy: () => false,
      headless: () => false,
      totalCostUsd: () => 0,
    };
  }

  async function completedFeature(): Promise<string> {
    await store.draftObjective({ title: 'Ship', goal: 'ship it', definitionOfDone: ['works'], milestones: [{ title: 'Core' }] });
    await store.plan([{ title: 'Core feature', scope: ['src/core/**'], milestone: 'MS1', tasks: ['build it'] }]);
    await store.requestObjectiveApproval();
    await store.approveObjective('auto');
    const state = await store.load();
    const feature = state.missions[0]!;
    await store.addWorktree(feature.worktree, feature.branch, state.base);
    await store.registerSpawnedAgent(
      { name: 'w1', agentId: 'agent-w1', kind: 'worker', missionId: feature.id, worktree: feature.worktree, branch: feature.branch, spawnedAt: new Date(Date.now() - 5_000).toISOString() },
      { id: feature.id, owner: 'w1' },
    );
    const worktree = join(repo, '.tower', 'worktrees', feature.worktree);
    await commitFile(worktree, 'src/core/index.ts', 'export const core = 1;\n', 'core');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await store.updateMission('w1', feature.id, { taskDone: 'build it' });
    await store.complete('w1', 'built the core');
    return worktree;
  }

  it('observes gates, tips, the review-request and the inbox through the store', async () => {
    const worktree = await completedFeature();
    const state = await store.load();
    const snap = buildAutopilotSnapshot(
      await observeAutopilotWorld({ store, observations: observations({ 'agent-w1': { status: 'idle' } }), state }),
    );
    const tip = await git(worktree, 'rev-parse', 'HEAD');
    expect(snap.baseTip).toBe(await git(repo, 'rev-parse', 'main'));
    expect(snap.missions[0]).toMatchObject({
      id: 'M1',
      status: 'completed',
      tip,
      attempts: 1,
      worker: { state: 'idle', name: 'w1' },
      reviewRequestOnTip: true,
      gate: { ready: false, blocks: ['no-review'] },
    });
    expect(snap.inboxCount).toBe(1);
    expect(snap.objective?.milestones[0]?.status).toBe('active');
  });

  it('a commit after the review-request withdraws it, and an unobservable worker blocks the gate as worker-unknown', async () => {
    const worktree = await completedFeature();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await commitFile(worktree, 'src/core/more.ts', 'export const more = 2;\n', 'more');
    const state = await store.load();
    const snap = buildAutopilotSnapshot(
      await observeAutopilotWorld({ store, observations: observations({ 'agent-w1': { status: 'unknown' } }), state }),
    );
    expect(snap.missions[0]).toMatchObject({
      reviewRequestOnTip: false,
      worker: { state: 'idle' },
      gate: { ready: false, blocks: ['worker-unknown'] },
    });
  });
});
