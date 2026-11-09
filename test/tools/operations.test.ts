import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAIN_AGENT_ID, TowerStore } from '../../src/protocol/index.ts';
import { resumeValidatorRefusal } from '../../src/prompts/validatorNotes.ts';
import {
  createAgentTools,
  createObjectiveOrchestratorTools,
  createOrchestratorOperations,
  createOrchestratorTools,
  createValidatorTools,
} from '../../src/tools/index.ts';
import { createRepo, removeDir } from '../tower/fakes.ts';
import { ObjectiveTestHost, executingObjective, validatingMilestone } from './objectiveHost.ts';

let repo: string;
let store: TowerStore;
let host: ObjectiveTestHost;

beforeEach(async () => {
  repo = await createRepo('tower-operations-');
  store = new TowerStore(repo);
  await store.init('session-objective');
  host = new ObjectiveTestHost(repo);
  host.sessionId = 'session-objective';
});

afterEach(async () => {
  await removeDir(repo);
});

describe('tool factory lists', () => {
  it('keeps the orchestrator and agent lists unchanged and exports the objective lists separately', () => {
    expect(createOrchestratorTools(host).map((tool) => tool.name)).toEqual([
      'TowerInit',
      'TowerPlan',
      'TowerSpawn',
      'TowerMerge',
      'TowerRebase',
      'TowerTeardown',
      'TowerSend',
      'TowerInbox',
      'TowerFinding',
      'TowerReview',
      'TowerMission',
      'TowerStatus',
      'TowerResume',
      'TowerTasks',
      'TowerTaskOutput',
      'TowerTaskStop',
    ]);
    expect(createAgentTools(host, { agentId: 'agent-1' }).map((tool) => tool.name)).toEqual([
      'TowerComplete',
      'TowerFinding',
      'TowerInbox',
      'TowerMission',
      'TowerReview',
      'TowerSend',
      'TowerStatus',
    ]);
    expect(createObjectiveOrchestratorTools(host).map((tool) => tool.name)).toEqual(['TowerObjective']);
    expect(createValidatorTools(host, { agentId: 'agent-1' }).map((tool) => tool.name)).toEqual([
      'TowerFinding',
      'TowerInbox',
      'TowerSend',
      'TowerStatus',
      'TowerValidate',
    ]);
  });

  it('binds the objective tool to the orchestrator caller', async () => {
    const [objective] = createObjectiveOrchestratorTools(host);

    const result = await objective!.run({ action: 'draft', title: 'Ship CSV export' }, { toolCallId: 'call_1' });

    expect(result.isError).toBeUndefined();
    expect((await store.load()).objective?.id).toBe('O1');
  });

  it('binds the validator tools to the validator caller', async () => {
    const tools = createValidatorTools(host, { agentId: MAIN_AGENT_ID });
    const validate = tools.find((tool) => tool.name === 'TowerValidate')!;

    const result = await validate.run(
      { milestone: 'MS1', kind: 'scrutiny', verdict: 'pass', evidence: 'x' },
      { toolCallId: 'call_1' },
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('TowerValidate is for validators only');
  });
});

describe('createOrchestratorOperations', () => {
  it('spawns workers, reviewers, and validators through TowerSpawn with the orchestrator caller', async () => {
    await executingObjective(store);
    const operations = createOrchestratorOperations(host);

    const worker = await operations.spawnWorker('M1', 'ap-w-M1-1', 'Respawned after a timeout.');
    const reviewer = await operations.spawnReviewer('M1', 'ap-r-M1-1');
    const unknown = await operations.spawnReviewer('M9', 'ap-r-M9-1');

    expect(worker.isError).toBeUndefined();
    expect(host.launches[0]).toMatchObject({ name: 'ap-w-M1-1', kind: 'worker' });
    expect(host.launches[0]?.prompt).toContain('# Additional instructions from the tower\nRespawned after a timeout.');
    expect(reviewer.isError).toBeUndefined();
    expect(host.launches[1]).toMatchObject({ name: 'ap-r-M1-1', kind: 'reviewer', description: 'M1 review: feat/build-csv-model' });
    expect(unknown).toEqual({ isError: true, output: 'unknown mission "M9" — known missions: M1' });
    const roster = (await store.load()).roster.agents.map((agent) => [agent.name, agent.kind]);
    expect(roster).toEqual([
      ['ap-w-M1-1', 'worker'],
      ['ap-r-M1-1', 'reviewer'],
    ]);
  });

  it('spawns a validator and refuses to resume it', async () => {
    await validatingMilestone(store);
    const operations = createOrchestratorOperations(host);

    const spawned = await operations.spawnValidator('MS1', 'scrutiny', 'ap-v-MS1-scrutiny-1');
    host.runtime.finish('agent-1', 'failed', { stopReason: 'lost contact' });
    const resumed = await operations.resume('ap-v-MS1-scrutiny-1', 'continue');

    expect(spawned.isError).toBeUndefined();
    expect(spawned.output).toContain('validation: scrutiny r1');
    expect(resumed).toEqual({ isError: true, output: resumeValidatorRefusal('ap-v-MS1-scrutiny-1') });
  });

  it('runs rebase and merge through their gates by mission id', async () => {
    await executingObjective(store);
    const operations = createOrchestratorOperations(host);
    expect((await operations.spawnWorker('M1', 'ap-w-M1-1')).isError).toBeUndefined();
    host.runtime.finish('agent-1', 'idle');

    const rebase = await operations.rebase('M1');
    const merge = await operations.merge('M1');
    const unknown = await operations.merge('M7');

    expect(rebase.isError).toBeFalsy();
    expect(rebase.output).toContain('mission M1 (feat/build-csv-model) is already up to date');
    expect(merge.isError).toBe(true);
    expect(merge.output).toContain('only a completed mission can merge');
    expect(unknown).toEqual({ isError: true, output: 'unknown mission "M7" — known missions: M1' });
  });

  it('resumes an idle worker through TowerResume', async () => {
    await executingObjective(store);
    const operations = createOrchestratorOperations(host);
    expect((await operations.spawnWorker('M1', 'ap-w-M1-1')).isError).toBeUndefined();
    host.runtime.finish('agent-1', 'idle');

    const result = await operations.resume('ap-w-M1-1', 'Address the review findings.');

    expect(result.isError).toBeFalsy();
    expect(host.runtime.promptsOf('agent-1').at(-1)).toBe('Address the review findings.');
  });
});
