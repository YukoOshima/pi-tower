import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAIN_AGENT_ID, TowerStore } from '../../src/protocol/index.ts';
import type { TowerPlanToolInput } from '../../src/tools/plan/plan.ts';
import { createTowerPlanTool } from '../../src/tools/plan/planTool.ts';
import { createRepo, removeDir } from '../tower/fakes.ts';
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
  repo = await createRepo('tower-plan-tool-');
  store = new TowerStore(repo);
  await store.init('session-objective');
  host = new ObjectiveTestHost(repo);
  host.sessionId = 'session-objective';
});

afterEach(async () => {
  vi.restoreAllMocks();
  await removeDir(repo);
});

function plan(args: TowerPlanToolInput) {
  return createTowerPlanTool(host, { agentId: MAIN_AGENT_ID }).run(args, { toolCallId: 'call_plan' });
}

describe('TowerPlan with objective features', () => {
  it('always hands the configured skip settings to the store, even without an objective', async () => {
    host.settings = { ...host.settings, skipScrutiny: true };
    const spy = vi.spyOn(TowerStore.prototype, 'plan');

    const result = await plan({ missions: [{ title: 'Build gemm', scope: ['src/**'] }] });

    expect(result.isError).toBeUndefined();
    expect(spy).toHaveBeenCalledWith(expect.any(Array), { skipScrutiny: true, skipUserTesting: false });
    expect(result.output).toContain('| ID | Mission | Kind | Branch | Worktree | Scope |');
    expect(result.output).not.toContain('Milestone');
  });

  it('plans features into a milestone and explains that nothing starts before approval', async () => {
    await store.draftObjective({ title: 'Ship CSV export', milestones: [{ title: 'Data model' }, { title: 'CLI' }] });

    const result = await plan({
      missions: [
        { title: 'Build csv model', scope: ['src/model/**'], milestone: 'MS1' },
        { title: 'Build csv cli', scope: ['src/cli/**'], milestone: 'MS2', deps: ['M1'] },
      ],
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('| ID | Mission | Kind | Milestone | Origin | Branch | Worktree | Scope |');
    expect(result.output).toContain('| M1 | Build csv model | build | MS1 | plan | feat/build-csv-model | wt-1 | src/model/** |');
    expect(result.output).toContain('| M2 | Build csv cli | build | MS2 | plan |');
    expect(result.output).toContain('The autopilot spawns a worker for each feature of the current milestone');
    expect(result.output).toContain('(current milestone: MS1)');
    expect(result.output).toContain('Nothing starts before the human approves objective O1');
    const missions = (await store.load()).missions;
    expect(missions.map((mission) => [mission.id, mission.milestone, mission.origin])).toEqual([
      ['M1', 'MS1', 'plan'],
      ['M2', 'MS2', 'plan'],
    ]);
  });

  it('surfaces the store refusal for a build mission without a milestone while an objective is open', async () => {
    await store.draftObjective({ title: 'Ship CSV export', milestones: [{ title: 'Data model' }] });

    const result = await plan({ missions: [{ title: 'Loose work', scope: ['src/**'] }] });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('must name the milestone it belongs to');
  });

  it('plans a fix feature into a failed milestone and reopens it, with autopilot-off guidance', async () => {
    host.settings = { ...host.settings, autopilot: false };
    const tip = await validatingMilestone(store);
    await registerValidator(store, 'val-a', 'agent-v1', tip);
    await store.submitValidation('val-a', { milestone: 'MS1', kind: 'scrutiny', verdict: 'fail', failures: ['row type missing'] });
    expect((await store.load()).objective?.milestones[0]?.status).toBe('failed');

    const result = await plan({
      missions: [{ title: 'Fix csv row type', scope: ['src/model/**'], milestone: 'MS1', origin: 'fix', context: 'row type missing' }],
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('| M2 | Fix csv row type | build | MS1 | fix |');
    expect(result.output).toContain('The autopilot is off: once the objective is executing, TowerSpawn one worker per feature');
    expect(result.output).not.toContain('Nothing starts before the human approves');
    const state = await store.load();
    expect(state.objective?.milestones[0]?.status).toBe('active');
    expect(state.missions.find((mission) => mission.id === 'M2')?.origin).toBe('fix');
  });

  it('refuses an origin without a milestone', async () => {
    await executingObjective(store);

    const result = await plan({ missions: [{ title: 'Survey logs', scope: ['logs/**'], kind: 'survey', origin: 'fix' }] });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('without a milestone');
  });
});
