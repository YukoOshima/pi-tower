import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAIN_AGENT_ID, TowerStore } from '../../src/protocol/index.ts';
import type { TowerSpawnToolInput } from '../../src/tools/spawn/spawn.ts';
import { createTowerSpawnTool } from '../../src/tools/spawn/spawnTool.ts';
import { createRepo, git, removeDir } from '../tower/fakes.ts';
import {
  ObjectiveTestHost,
  executingObjective,
  registerValidator,
  validatingMilestone,
} from './objectiveHost.ts';

let repo: string;
let store: TowerStore;
let host: ObjectiveTestHost;

beforeEach(async () => {
  repo = await createRepo('tower-feature-spawn-');
  store = new TowerStore(repo);
  await store.init('session-objective');
  host = new ObjectiveTestHost(repo);
  host.sessionId = 'session-objective';
});

afterEach(async () => {
  await removeDir(repo);
});

function spawn(args: TowerSpawnToolInput) {
  return createTowerSpawnTool(host, { agentId: MAIN_AGENT_ID }).run(args, { toolCallId: 'call_spawn' });
}

const FEATURE = 'mission M1 is a feature of milestone MS1 "Data model" of objective O1';

async function plannedObjective(): Promise<void> {
  await store.draftObjective({
    title: 'Ship CSV export',
    goal: 'Users export their data as CSV.',
    definitionOfDone: ['export works'],
    milestones: [{ title: 'Data model' }, { title: 'CLI command' }],
  });
  await store.plan([{ title: 'Build csv model', scope: ['src/model/**'], milestone: 'MS1' }]);
}

async function expectRefused(args: TowerSpawnToolInput, message: string): Promise<void> {
  const result = await spawn(args);

  expect(result.isError).toBe(true);
  expect(result.output).toContain(message);
  expect(result.output).toContain('no worktree or agent was created');
  expect(host.launches).toEqual([]);
  await expect(git(repo, 'rev-parse', '--verify', 'refs/heads/feat/build-csv-model')).rejects.toThrow();
}

describe('TowerSpawn workers for objective features', () => {
  it('refuses while the objective is still planning', async () => {
    await plannedObjective();

    await expectRefused(
      { name: 'agent-model', kind: 'worker', mission_id: 'M1' },
      `${FEATURE}, which is still planning — nothing starts before the human approves: finish the plan and hand it over with TowerObjective(action="request-approval")`,
    );
  });

  it('refuses while the objective awaits approval', async () => {
    await plannedObjective();
    await store.requestObjectiveApproval();

    await expectRefused(
      { name: 'agent-model', kind: 'worker', mission_id: 'M1' },
      `${FEATURE}, which is awaiting approval — nothing starts before the human approves it with /tower approve`,
    );
  });

  it('refuses while the objective is paused or blocked', async () => {
    await executingObjective(store);
    await store.pauseObjective('cost budget reached');

    await expectRefused(
      { name: 'agent-model', kind: 'worker', mission_id: 'M1' },
      `${FEATURE}, which is paused (cost budget reached) — no new work starts until the human resumes it with /tower resume`,
    );

    await store.resumeObjective();
    await store.blockObjective('the vendor API is down');
    await expectRefused(
      { name: 'agent-model', kind: 'worker', mission_id: 'M1' },
      `${FEATURE}, which is blocked (the vendor API is down) — the human decides how to continue`,
    );
  });

  it('refuses a feature of a later milestone while an earlier one is current', async () => {
    await executingObjective(store);
    await store.plan([{ title: 'Build csv cli', scope: ['src/cli/**'], milestone: 'MS2' }]);

    const result = await spawn({ name: 'agent-cli', kind: 'worker', mission_id: 'M2' });

    expect(result.isError).toBe(true);
    expect(result.output).toContain(
      'mission M2 is a feature of milestone MS2 "CLI command" of objective O1, but the current milestone is MS1 "Data model" — features of a later milestone start only after the earlier milestones pass validation',
    );
    expect(host.launches).toEqual([]);
  });

  it('spawns a feature of the current milestone of an executing objective', async () => {
    await executingObjective(store);

    const result = await spawn({ name: 'agent-model', kind: 'worker', mission_id: 'M1' });

    expect(result.isError).toBeUndefined();
    expect(host.launches[0]).toMatchObject({ name: 'agent-model', kind: 'worker' });
    expect((await store.load()).missions[0]).toMatchObject({ status: 'active', owner: 'agent-model' });
  });

  it('spawns a fix feature planned into a failed milestone, which makes it current again', async () => {
    const tip = await validatingMilestone(store);
    await registerValidator(store, 'val-a', 'agent-v1', tip);
    await store.submitValidation('val-a', { milestone: 'MS1', kind: 'scrutiny', verdict: 'fail', failures: ['row type missing'] });
    await store.plan([{ title: 'Fix csv row type', scope: ['src/model/**'], milestone: 'MS1', origin: 'fix' }]);

    const result = await spawn({ name: 'agent-fix', kind: 'worker', mission_id: 'M2' });

    expect(result.isError).toBeUndefined();
    expect(host.launches[0]).toMatchObject({ name: 'agent-fix', kind: 'worker' });
  });

  it('leaves missions without a milestone and reviewers unaffected', async () => {
    await plannedObjective();
    await store.plan([{ title: 'Survey logs', scope: ['logs/**'], kind: 'survey' }]);

    const survey = await spawn({ name: 'agent-survey', kind: 'worker', mission_id: 'M2' });
    const reviewer = await spawn({ name: 'rev-model', kind: 'reviewer', review_target: 'feat/build-csv-model' });

    expect(survey.isError).toBeUndefined();
    expect(reviewer.isError).toBeUndefined();
    expect(host.launches.map((launch) => [launch.name, launch.kind])).toEqual([
      ['agent-survey', 'worker'],
      ['rev-model', 'reviewer'],
    ]);
  });
});
