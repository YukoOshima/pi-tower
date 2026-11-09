import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TOWER_MAIN_AGENT_ONLY, TOWER_MODE_USER_ENABLED_ONLY } from '../../src/prompts/index.ts';
import { MAIN_AGENT_ID, TowerStore, sortedMilestones } from '../../src/protocol/index.ts';
import {
  planObjectiveUpdate,
  resolveMilestoneSlots,
  type TowerObjectiveToolInput,
} from '../../src/tools/objective/objective.ts';
import { createTowerObjectiveTool } from '../../src/tools/objective/objectiveTool.ts';
import { TestHost, createRepo, removeDir } from '../tower/fakes.ts';
import { ObjectiveTestHost } from './objectiveHost.ts';

let repo: string;
let store: TowerStore;
let host: ObjectiveTestHost;

beforeEach(async () => {
  repo = await createRepo('tower-objective-tool-');
  store = new TowerStore(repo);
  await store.init('session-objective');
  host = new ObjectiveTestHost(repo);
  host.sessionId = 'session-objective';
});

afterEach(async () => {
  await removeDir(repo);
});

function objective(args: TowerObjectiveToolInput, agentId = MAIN_AGENT_ID) {
  return createTowerObjectiveTool(host, { agentId }).run(args, { toolCallId: 'call_objective' });
}

const DRAFT: TowerObjectiveToolInput = {
  action: 'draft',
  title: 'Ship CSV export',
  goal: 'Users export their data as CSV.',
  definition_of_done: ['export --format csv writes a valid file'],
  milestones: [{ title: 'Data model' }, { title: 'CLI command', qa_instructions: 'run the CLI' }],
};

async function milestoneIds(): Promise<string[]> {
  const state = await store.load();
  return sortedMilestones(state.objective!).map((milestone) => milestone.id);
}

async function approvedObjective(): Promise<void> {
  expect((await objective(DRAFT)).isError).toBeUndefined();
  await store.plan([{ title: 'Build csv model', scope: ['src/model/**'], milestone: 'MS1' }]);
  await store.requestObjectiveApproval();
  await store.approveObjective('human');
}

describe('TowerObjective tool', () => {
  it('exposes the five actions and no limits, approve, or complete parameter', () => {
    const tool = createTowerObjectiveTool(host, { agentId: MAIN_AGENT_ID });
    const properties = tool.parameters.properties as Record<string, { enum?: string[] }>;

    expect(tool.name).toBe('TowerObjective');
    expect(properties.action?.enum).toEqual(['draft', 'update', 'request-approval', 'status', 'block']);
    expect(Object.keys(properties).sort()).toEqual(
      ['acceptance_commands', 'action', 'definition_of_done', 'goal', 'milestones', 'note', 'reason', 'title'],
    );
  });

  it('is orchestrator only', async () => {
    expect(await objective({ action: 'status' }, 'agent-w1')).toEqual({
      isError: true,
      output: TOWER_MAIN_AGENT_ONLY,
    });
  });

  it('refuses plan changes while tower mode is off but still shows the status', async () => {
    expect((await objective(DRAFT)).isError).toBeUndefined();
    host.active = false;

    expect(await objective({ action: 'update', note: 'x' })).toEqual({
      isError: true,
      output: TOWER_MODE_USER_ENABLED_ONLY,
    });
    const status = await objective({ action: 'status' });
    expect(status.isError).toBeUndefined();
    expect(status.output).toContain('# Objective O1 — Ship CSV export');
  });

  it.each([
    [{ action: 'approve' }, 'there is no approve or complete action'],
    [{ action: 'draft' }, 'action="draft" needs a title'],
    [{ action: 'update' }, 'action="update" needs at least one field to change'],
    [{ action: 'draft', title: 'x', reason: 'r' }, 'does not take reason'],
    [{ action: 'block' }, 'action="block" needs a reason'],
    [{ action: 'block', reason: '   ' }, 'action="block" needs a reason'],
    [{ action: 'block', reason: 'stuck', goal: 'g' }, 'takes only reason — got goal'],
    [{ action: 'status', note: 'n' }, 'action="status" takes no other parameters — got note'],
    [{ action: 'request-approval', reason: 'r' }, 'takes no other parameters — got reason'],
    [
      { action: 'update', milestones: [{ id: 'MS1', title: 'a' }, { id: 'MS1', title: 'b' }] },
      'milestone MS1 appears more than once',
    ],
    [{ action: 'update', milestones: [{ id: ' ', title: 'a' }] }, 'has a blank id'],
  ])('refuses malformed input %j before touching the store', async (args, message) => {
    const result = await objective(args as TowerObjectiveToolInput);

    expect(result.isError).toBe(true);
    expect(result.output).toContain(message);
    expect((await store.load()).objective).toBeUndefined();
  });

  it('drafts the objective with limits taken from the configured settings', async () => {
    host.settings = {
      ...host.settings,
      maxValidationRounds: 5,
      maxFeatureAttempts: 2,
      maxWallTimeMs: 3_600_000,
      maxCostUsd: 20,
      skipScrutiny: true,
    };

    const result = await objective({ ...DRAFT, acceptance_commands: ['npm ci && npm test'], note: 'assume UTF-8' });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('objective O1 drafted: "Ship CSV export" — status planning');
    expect(result.output).toContain('1. MS1 "Data model" — pending · validation: user-testing');
    expect(result.output).toContain('2. MS2 "CLI command" — pending · validation: user-testing · commands `npm ci && npm test`');
    expect(result.output).toContain('TowerPlan(milestone="MS1")');
    expect(result.output).not.toContain('maxCostUsd');
    const stored = (await store.load()).objective!;
    expect(stored.limits).toEqual({ maxValidationRounds: 5, maxFeatureAttempts: 2, maxWallTimeMs: 3_600_000, maxCostUsd: 20 });
    expect(stored.notes).toEqual(['assume UTF-8']);
    expect(stored.milestones[1]?.validation).toEqual({
      scrutiny: true,
      userTesting: true,
      commands: [],
      qaInstructions: 'run the CLI',
    });
    expect(host.settingsReads).toBeGreaterThan(0);
  });

  it('drafts with the config defaults when the host has no objective settings', async () => {
    const plain = createTowerObjectiveTool(new TestHost(repo), { agentId: MAIN_AGENT_ID });

    const result = await plain.run(DRAFT, { toolCallId: 'call_objective' });

    expect(result.isError).toBeUndefined();
    expect((await store.load()).objective?.limits).toEqual({ maxValidationRounds: 3, maxFeatureAttempts: 3 });
  });

  it('surfaces store refusals as tool errors', async () => {
    expect((await objective(DRAFT)).isError).toBeUndefined();

    const again = await objective(DRAFT);
    expect(again.isError).toBe(true);
    expect(again.output).toContain('objective O1 is still planning');

    const withId = await objective({ action: 'update', milestones: [{ id: 'MS9', title: 'x' }] });
    expect(withId.isError).toBe(true);
    expect(withId.output).toContain('has no milestone "MS9"');
  });

  it('refuses an update when there is no objective', async () => {
    const result = await objective({ action: 'update', note: 'x' });

    expect(result).toEqual({ isError: true, output: 'there is no objective to update — draft one first' });
  });

  it('treats milestones as the complete ordered list: keep by id, add without id, remove by omission', async () => {
    expect((await objective(DRAFT)).isError).toBeUndefined();

    const result = await objective({
      action: 'update',
      milestones: [{ id: 'MS1', title: 'Data model v2', scrutiny: false }, { title: 'Docs', commands: ['npm run docs'] }],
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('objective O1 updated:');
    expect(result.output).toContain('removed:MS2');
    expect(result.output).toContain('appended:MS3');
    const stored = (await store.load()).objective!;
    expect(sortedMilestones(stored).map((milestone) => [milestone.id, milestone.title])).toEqual([
      ['MS1', 'Data model v2'],
      ['MS3', 'Docs'],
    ]);
    expect(stored.milestones[0]?.validation.scrutiny).toBe(false);
    expect(stored.milestones.find((milestone) => milestone.id === 'MS3')?.validation.commands).toEqual(['npm run docs']);
    expect(stored.removedMilestones).toEqual(['MS2']);
  });

  it('reorders existing milestones by their position in the list', async () => {
    expect((await objective(DRAFT)).isError).toBeUndefined();

    const result = await objective({
      action: 'update',
      milestones: [{ id: 'MS2', title: 'CLI command' }, { id: 'MS1', title: 'Data model' }],
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('reordered:MS2+MS1');
    expect(await milestoneIds()).toEqual(['MS2', 'MS1']);
  });

  it('places a new milestone between existing ones with a second ordering pass', async () => {
    expect((await objective(DRAFT)).isError).toBeUndefined();

    const result = await objective({
      action: 'update',
      milestones: [{ id: 'MS1', title: 'Data model' }, { title: 'Parser' }, { id: 'MS2', title: 'CLI command' }],
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('appended:MS3');
    expect(result.output).toContain('reordered:MS1+MS3+MS2');
    expect(await milestoneIds()).toEqual(['MS1', 'MS3', 'MS2']);
  });

  it('appends new milestones at the end without a reorder', async () => {
    await approvedObjective();

    const result = await objective({
      action: 'update',
      milestones: [{ id: 'MS1', title: 'Data model' }, { id: 'MS2', title: 'CLI command' }, { title: 'Polish' }],
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).not.toContain('reordered');
    expect(result.output).toContain('status executing');
    expect(await milestoneIds()).toEqual(['MS1', 'MS2', 'MS3']);
  });

  it('reports that a contract change after approval needs the human again', async () => {
    await approvedObjective();

    const result = await objective({ action: 'update', goal: 'Users export and import CSV.' });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('status awaiting-approval');
    expect(result.output).toContain('is awaiting approval again');
    expect((await store.load()).objective?.approvalReason).toBe('contract-changed');
  });

  it('asks to tell the human about a contract change while the first approval is pending', async () => {
    expect((await objective(DRAFT)).isError).toBeUndefined();
    await store.plan([{ title: 'Build csv model', scope: ['src/model/**'], milestone: 'MS1' }]);
    await store.requestObjectiveApproval();

    const result = await objective({ action: 'update', definition_of_done: ['export works', 'import works'] });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('status awaiting-approval');
    expect(result.output).toContain('the human approves the plan as it is now');
    expect(result.output).not.toContain('awaiting approval again');
  });

  it('reports an update that changes nothing', async () => {
    expect((await objective(DRAFT)).isError).toBeUndefined();

    const result = await objective({ action: 'update', title: 'Ship CSV export' });

    expect(result.output).toBe('objective O1 unchanged — everything you passed already matches the stored plan (status planning)');
  });

  it('requests approval and returns the approval request with the skipped kinds applied', async () => {
    host.settings = { ...host.settings, skipUserTesting: true };
    expect((await objective(DRAFT)).isError).toBeUndefined();
    const refused = await objective({ action: 'request-approval' });
    expect(refused.isError).toBe(true);
    expect(refused.output).toContain('has no build feature');
    await store.plan([{ title: 'Build csv model', scope: ['src/model/**'], milestone: 'MS1' }]);

    const result = await objective({ action: 'request-approval' });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('objective O1 is now awaiting approval (estimated runs ≈ 5)');
    expect(result.output).toContain('never approve or claim approval');
    expect(result.output).toContain('is ready for your approval');
    expect(result.output).toContain('1. MS1 "Data model" — 1 feature: M1 "Build csv model"');
    expect(result.output).toContain('   validation: scrutiny');
    expect(result.output).not.toContain('user-testing');
    expect(result.output).toContain('To approve, run: /tower approve');
    expect((await store.load()).objective?.status).toBe('awaiting-approval');
  });

  it('renders the objective dashboard with live agents and the skipped kinds', async () => {
    host.settings = { ...host.settings, skipScrutiny: true };
    await approvedObjective();
    const launched = await host.runtime.spawn({ name: 'agent-model', kind: 'worker', cwd: repo, prompt: 'x' });
    if (!launched.ok) throw new Error(launched.reason);
    await store.registerSpawnedAgent(
      { name: 'agent-model', agentId: launched.agentId, sessionId: host.sessionId, kind: 'worker', missionId: 'M1', spawnedAt: new Date().toISOString() },
      { id: 'M1', owner: 'agent-model' },
    );

    const result = await objective({ action: 'status' });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('# Objective O1 — Ship CSV export');
    expect(result.output).toContain('🔵 MS1 Data model — active · features 0/1 merged · validation: user-testing');
    expect(result.output).toContain('- 🔵 M1 Build csv model — active · worker agent-model');
    expect(result.output).toContain('## Live agents (1)\n- agent-model — worker · M1 Build csv model');
  });

  it('reports a missing objective on status', async () => {
    const result = await objective({ action: 'status' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('there is no objective in this workspace');
  });

  it('blocks the objective with the reason and returns the human notice', async () => {
    await approvedObjective();

    const result = await objective({ action: 'block', reason: 'the vendor API is down for days' });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('objective O1 is blocked');
    expect(result.output).toContain('Objective O1 "Ship CSV export" is blocked: the vendor API is down for days.');
    expect(result.output).toContain('Milestone MS1 "Data model" is active.');
    const stored = (await store.load()).objective!;
    expect(stored.status).toBe('blocked');
    expect(stored.blockedReason).toBe('the vendor API is down for days');

    const again = await objective({ action: 'block', reason: 'again' });
    expect(again.isError).toBe(true);
    expect(again.output).toContain('already blocked');
  });
});

describe('planObjectiveUpdate', () => {
  it('passes only the plan fields that were given and never limits', async () => {
    expect((await objective(DRAFT)).isError).toBeUndefined();
    const stored = (await store.load()).objective!;

    expect(planObjectiveUpdate(stored, { action: 'update', goal: 'g', note: 'n' })).toEqual({
      input: { goal: 'g', notes: ['n'] },
    });
    expect(
      planObjectiveUpdate(stored, { action: 'update', milestones: [{ id: 'MS1', title: 'Data model' }, { id: 'MS2', title: 'CLI command' }] }),
    ).toEqual({
      input: { milestones: [{ id: 'MS1', title: 'Data model' }, { id: 'MS2', title: 'CLI command' }] },
    });
  });

  it('gives up placing new milestones when the appended ids do not match the new items', () => {
    expect(resolveMilestoneSlots([{ id: 'MS1' }, { appended: 0 }, { id: 'MS2' }], [])).toBeUndefined();
    expect(resolveMilestoneSlots([{ id: 'MS1' }, { appended: 0 }, { id: 'MS2' }], ['MS4'])).toEqual(['MS1', 'MS4', 'MS2']);
  });
});
