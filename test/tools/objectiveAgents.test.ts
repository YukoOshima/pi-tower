import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAIN_AGENT_ID, TowerStore } from '../../src/protocol/index.ts';
import { resumeValidatorRefusal } from '../../src/prompts/validatorNotes.ts';
import { agentAssignment } from '../../src/tools/agents.ts';
import { createTowerMergeTool } from '../../src/tools/merge/mergeTool.ts';
import { createTowerResumeTool } from '../../src/tools/resume/resumeTool.ts';
import { createTowerSpawnTool } from '../../src/tools/spawn/spawnTool.ts';
import { readTowerStatusSummary } from '../../src/tools/status/statusReader.ts';
import { createTowerStatusTool } from '../../src/tools/status/statusTool.ts';
import { createTowerTaskOutputTool } from '../../src/tools/taskOutput/taskOutputTool.ts';
import { createTowerTasksTool } from '../../src/tools/tasks/tasksTool.ts';
import { createTowerTaskStopTool } from '../../src/tools/taskStop/taskStopTool.ts';
import { createRepo, git, removeDir } from '../tower/fakes.ts';
import { ObjectiveTestHost, executingObjective, validatingMilestone } from './objectiveHost.ts';

let repo: string;
let store: TowerStore;
let host: ObjectiveTestHost;

beforeEach(async () => {
  repo = await createRepo('tower-objective-agents-');
  store = new TowerStore(repo);
  await store.init('session-objective');
  host = new ObjectiveTestHost(repo);
  host.sessionId = 'session-objective';
});

afterEach(async () => {
  await removeDir(repo);
});

const ORCHESTRATOR = { agentId: MAIN_AGENT_ID };
const CALL = { toolCallId: 'call_1' };

async function runningValidator(): Promise<string> {
  const tip = await validatingMilestone(store);
  const spawned = await createTowerSpawnTool(host, ORCHESTRATOR).run(
    { name: 'val-a', kind: 'validator', milestone: 'MS1', validation_kind: 'scrutiny' },
    CALL,
  );
  expect(spawned.isError).toBeUndefined();
  return tip;
}

async function status(): Promise<string> {
  const result = await createTowerStatusTool(host, ORCHESTRATOR).run({}, CALL);
  expect(result.isError).toBeUndefined();
  return result.output;
}

describe('TowerStatus with an objective', () => {
  it('adds no objective block without an objective', async () => {
    await store.plan([{ title: 'Build gemm', scope: ['src/**'] }]);

    const output = await status();

    expect(output).not.toContain('Objective');
    expect(output).toContain(
      '- M1 (feat/build-gemm) — planned but no worker spawned yet: launch one with TowerSpawn(kind="worker", mission_id="M1", name="...")',
    );
  });

  it('shows the objective block before the missions and lists the validator in the roster', async () => {
    const tip = await runningValidator();
    const short = tip.slice(0, 7);

    const output = await status();

    expect(output).toContain('## Objective O1 — Ship CSV export');
    expect(output).toContain('### Milestones');
    expect(output).toContain(`🔍 MS1 Data model — validating ${short}`);
    expect(output).toContain('### Live agents (1)\n- val-a — validator · MS1 scrutiny r1');
    expect(output).toContain('### Next\nValidating MS1');
    expect(output.indexOf('## Objective O1')).toBeLessThan(output.indexOf('## Missions'));
    expect(output).toContain(
      `- val-a (validator) — agent agent-1, validating MS1 scrutiny r1 on ${short} (worktree val-ms1-scrutiny-r1), model fake/default-model`,
    );
    expect(output).toContain('do not run TowerTeardown until the objective completes');
    expect(output).not.toContain('Free the worktree checkouts now');
  });

  it('applies the configured skipped kinds to the objective block', async () => {
    host.settings = { ...host.settings, skipUserTesting: true };
    await executingObjective(store, { skipUserTesting: true });

    const output = await status();

    expect(output).toContain('🔵 MS1 Data model — active · features 0/1 merged · validation: scrutiny');
    expect(output).not.toContain('user-testing');
  });

  it('explains when objective features start instead of asking for a manual spawn', async () => {
    await executingObjective(store);
    await store.plan([{ title: 'Build csv cli', scope: ['src/cli/**'], milestone: 'MS2' }]);

    const autopilot = await status();
    expect(autopilot).toContain(
      '- M1 (feat/build-csv-model) — feature of MS1, the current milestone: the autopilot spawns its worker once its deps are merged or abandoned',
    );
    expect(autopilot).toContain('- M2 (feat/build-csv-cli) — feature of MS2: it starts when MS2 becomes the current milestone');

    host.settings = { ...host.settings, autopilot: false };
    const manual = await status();
    expect(manual).toContain(
      '- M1 (feat/build-csv-model) — planned but no worker spawned yet: launch one with TowerSpawn(kind="worker", mission_id="M1", name="...")',
    );
    expect(manual).toContain('- M2 (feat/build-csv-cli) — feature of MS2: it starts when MS2 becomes the current milestone');
  });

  it('says nothing starts while the objective awaits approval', async () => {
    await store.draftObjective({ title: 'Ship CSV export', goal: 'g', definitionOfDone: ['d'], milestones: [{ title: 'Data model' }] });
    await store.plan([{ title: 'Build csv model', scope: ['src/model/**'], milestone: 'MS1' }]);
    await store.requestObjectiveApproval();

    expect(await status()).toContain(
      '- M1 (feat/build-csv-model) — feature of MS1: nothing starts while objective O1 is awaiting-approval',
    );
  });

  it('summarizes the objective and validators for /tower status', async () => {
    const tip = await runningValidator();

    const summary = await readTowerStatusSummary({
      active: true,
      store,
      agentId: MAIN_AGENT_ID,
      activeAgentIds: () => host.activeAgentIds(),
      concurrency: () => host.rateLimitSnapshot(),
    });

    expect(summary).toContain('Objective: O1 Ship CSV export — executing · milestones 0/2 passed · current MS1 validating');
    expect(summary).toContain(`  val-a (validator) — validating MS1 scrutiny r1 on ${tip.slice(0, 7)} · agent-1 · model fake/default-model`);
  });
});

describe('agent tools with validators', () => {
  it('never resumes a validator', async () => {
    await runningValidator();
    host.runtime.finish('agent-1', 'failed', { stopReason: 'provider error' });

    const result = await createTowerResumeTool(host, ORCHESTRATOR).run({ agent: 'val-a', prompt: 'continue' }, CALL);

    expect(result).toEqual({ isError: true, output: resumeValidatorRefusal('val-a') });
    expect(host.runtime.resumes).toEqual([]);
  });

  it('stops a validator with one-shot guidance', async () => {
    await runningValidator();

    const result = await createTowerTaskStopTool(host, ORCHESTRATOR).run({ agent: 'val-a', reason: 'wrong commit' }, CALL);

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('stopped tower agent "val-a" (agent_id: agent-1, task_id: task-1)');
    expect(result.output).toContain(
      'A validator is one-shot: it is never resumed. If its round produced no verdict, a fresh validator under a new name re-runs it',
    );
    expect(result.output).not.toContain('TowerResume');
  });

  it('lists validators with their milestone round in TowerTasks and TowerTaskOutput', async () => {
    const tip = await runningValidator();
    const assignment = `validating MS1 scrutiny r1 on ${tip.slice(0, 7)}`;

    const tasks = await createTowerTasksTool(host, ORCHESTRATOR).run({}, CALL);
    const output = await createTowerTaskOutputTool(host, ORCHESTRATOR).run({ agent: 'val-a' }, CALL);

    expect(tasks.output).toContain('- val-a (validator) — status: running');
    expect(tasks.output).toContain(assignment);
    expect(output.output).toContain('kind: validator');
    expect(output.output).toContain(assignment);
  });

  it('describes a validator run without a roster entry', () => {
    expect(agentAssignment({ kind: 'validator' }, undefined)).toBe('validation ?');
    expect(agentAssignment({ kind: 'reviewer' }, undefined)).toBe('review');
    expect(agentAssignment({ kind: 'worker' }, undefined)).toBe('mission ?');
  });
});

describe('TowerMerge with an open objective', () => {
  it('does not point at TowerTeardown when the last mission merges but the objective is open', async () => {
    await store.draftObjective({ title: 'Ship CSV export', milestones: [{ title: 'Data model' }] });
    await store.plan([{ title: 'Survey engine', scope: ['src/engine/**'], kind: 'survey' }]);
    await git(repo, 'branch', 'feat/survey-engine');
    await store.updateMission('tower', 'M1', { status: 'completed' }, { silent: true });

    const result = await createTowerMergeTool(host, ORCHESTRATOR).run({ branch: 'feat/survey-engine' }, CALL);

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('read-only survey');
    expect(result.output).toContain('objective O1 is still planning');
    expect(result.output).not.toContain('ready for TowerTeardown');
  });
});
