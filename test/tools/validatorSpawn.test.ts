import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VALIDATOR_SPAWN_GUIDANCE } from '../../src/prompts/index.ts';
import { MAIN_AGENT_ID, STATE_FILE, TowerProtocolError, TowerStore } from '../../src/protocol/index.ts';
import type { TowerSpawnToolInput } from '../../src/tools/spawn/spawn.ts';
import { createTowerSpawnTool } from '../../src/tools/spawn/spawnTool.ts';
import { createTowerValidateTool } from '../../src/tools/validate/validateTool.ts';
import { commitFile, createRepo, git, removeDir } from '../tower/fakes.ts';
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
  repo = await createRepo('tower-validator-spawn-');
  store = new TowerStore(repo);
  await store.init('session-objective');
  host = new ObjectiveTestHost(repo);
  host.sessionId = 'session-objective';
});

afterEach(async () => {
  vi.restoreAllMocks();
  await removeDir(repo);
});

const SCRUTINY: TowerSpawnToolInput = {
  name: 'val-a',
  kind: 'validator',
  milestone: 'MS1',
  validation_kind: 'scrutiny',
};

function spawn(args: TowerSpawnToolInput) {
  return createTowerSpawnTool(host, { agentId: MAIN_AGENT_ID }).run(args, { toolCallId: 'call_spawn' });
}

function worktreePath(name = 'val-ms1-scrutiny-r1'): string {
  return join(repo, '.tower/worktrees', name);
}

async function expectNoValidatorSideEffects(): Promise<void> {
  expect(host.launches).toEqual([]);
  expect((await store.load()).roster.agents.filter((agent) => agent.kind === 'validator')).toEqual([]);
  expect(existsSync(worktreePath())).toBe(false);
  expect(await git(repo, 'worktree', 'list')).not.toContain('val-ms1');
}

describe('TowerSpawn kind="validator"', () => {
  it.each([
    [{ name: 'val-a', kind: 'validator' }, 'validator spawns require milestone and validation_kind'],
    [{ name: 'val-a', kind: 'validator', milestone: 'MS1' }, 'validator spawns require milestone and validation_kind'],
    [{ ...SCRUTINY, validation_kind: 'commands' }, 'the commands validation is run by the tower itself'],
    [{ ...SCRUTINY, mission_id: 'M1' }, 'not mission_id or review_target'],
    [{ name: 'agent-x', kind: 'worker', mission_id: 'M1', milestone: 'MS1' }, 'apply only to validator spawns'],
    [{ name: 'rev-x', kind: 'reviewer', review_target: 'feat/x', validation_kind: 'scrutiny' }, 'apply only to validator spawns'],
  ])('refuses malformed input %j before any side effect', async (args, message) => {
    const result = await spawn(args as TowerSpawnToolInput);

    expect(result.isError).toBe(true);
    expect(result.output).toContain(message);
    expect(host.launches).toEqual([]);
  });

  it('requires an executing objective', async () => {
    const none = await spawn(SCRUTINY);
    expect(none.output).toBe(
      'validator spawns need an executing objective — there is no objective; no worktree or agent was created',
    );

    await store.draftObjective({ title: 'Ship CSV export', milestones: [{ title: 'Data model' }] });
    const planning = await spawn(SCRUTINY);
    expect(planning.isError).toBe(true);
    expect(planning.output).toContain('objective O1 is planning');
    await expectNoValidatorSideEffects();
  });

  it('requires a known, validating milestone and a required kind', async () => {
    host.settings = { ...host.settings, skipUserTesting: true };
    await executingObjective(store, { skipUserTesting: true });

    const unknown = await spawn({ ...SCRUTINY, milestone: 'MS7' });
    expect(unknown.output).toContain('objective O1 has no milestone "MS7" (milestones: MS1 active, MS2 pending)');
    const active = await spawn(SCRUTINY);
    expect(active.output).toContain('milestone MS1 is active, not validating');

    await store.updateMission('tower', 'M1', { status: 'abandoned' });
    await store.startMilestoneValidation('MS1', await git(repo, 'rev-parse', 'main'), { skipUserTesting: true });
    const skipped = await spawn({ ...SCRUTINY, validation_kind: 'user-testing' });
    expect(skipped.isError).toBe(true);
    expect(skipped.output).toContain('milestone MS1 does not require user-testing validation (required: scrutiny)');
    await expectNoValidatorSideEffects();
  });

  it('prepares a detached validation worktree, briefs the validator there, and registers its round', async () => {
    const tip = await validatingMilestone(store);
    const models = vi.spyOn(host, 'resolveSpawnModel');

    const result = await spawn({ ...SCRUTINY, instructions: 'Focus on the CSV escaping.' });

    expect(result.isError).toBeUndefined();
    const path = worktreePath();
    expect(models).toHaveBeenCalledWith('validator', undefined);
    expect(result.output).toContain('kind: validator');
    expect(result.output).toContain('agent_id: agent-1');
    expect(result.output).toContain('milestone: MS1');
    expect(result.output).toContain('validation: scrutiny r1');
    expect(result.output).toContain(`validated_commit: ${tip}`);
    expect(result.output).toContain(`worktree: ${path}`);
    expect(result.output).toContain(VALIDATOR_SPAWN_GUIDANCE);
    expect(host.launches[0]).toMatchObject({
      name: 'val-a',
      kind: 'validator',
      cwd: path,
      description: 'MS1 scrutiny validation r1: val-a',
    });
    const prompt = host.launches[0]?.prompt ?? '';
    expect(prompt).toContain('You are "val-a", a tower validator agent');
    expect(prompt).toContain(`Validation worktree (detached, read-only): ${path}`);
    expect(prompt).toContain(`Validated commit: ${tip}`);
    expect(prompt).toContain('### M1: Build csv model (abandoned');
    expect(prompt).toContain('# Additional instructions from the tower\nFocus on the CSV escaping.');
    expect(await git(path, 'rev-parse', 'HEAD')).toBe(tip);
    expect(host.registered).toEqual(['agent-1']);
    const entry = (await store.load()).roster.agents.find((agent) => agent.name === 'val-a');
    expect(entry).toMatchObject({
      agentId: 'agent-1',
      sessionId: 'session-objective',
      kind: 'validator',
      milestoneId: 'MS1',
      validationKind: 'scrutiny',
      validationRound: 1,
      validatedCommit: tip,
      worktree: 'val-ms1-scrutiny-r1',
      cwd: path,
      model: 'fake/default-model',
    });
    expect(entry?.contractRevision).toBeUndefined();
    const log = await readFile(join(repo, '.tower/comms/log/activity.log'), 'utf8');
    expect(log).toContain(
      `tower spawn name=val-a kind=validator agent=agent-1 milestone=MS1 validation=scrutiny round=1 worktree=val-ms1-scrutiny-r1 commit=${tip.slice(0, 7)} model=fake/default-model thinking=medium`,
    );

    const verdict = await createTowerValidateTool(host, { agentId: 'agent-1' }).run(
      { milestone: 'MS1', kind: 'scrutiny', verdict: 'pass', evidence: 'typecheck clean' },
      { toolCallId: 'call_validate' },
    );
    expect(verdict.isError).toBeUndefined();
    expect((await store.load()).objective?.milestones[0]?.rounds[0]).toMatchObject({
      validator: 'val-a',
      validatedCommit: tip,
      verdict: 'pass',
    });
  });

  it('stamps the snapshot contract revision on the roster entry', async () => {
    await validatingMilestone(store);
    const state = await store.load();
    state.objective!.contractRevision = 2;
    await writeFile(store.abs(STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);

    const result = await spawn(SCRUTINY);

    expect(result.isError).toBeUndefined();
    expect((await store.load()).roster.agents.find((agent) => agent.name === 'val-a')?.contractRevision).toBe(2);
  });

  it('refuses before any worktree when the validator model cannot be resolved', async () => {
    await validatingMilestone(store);
    host.spawnModel = { ok: false, error: 'Invalid model "smart" — available models: orchestrator, primary, worker, reviewer, validator' };

    const result = await spawn({ ...SCRUTINY, model: 'smart' });

    expect(result).toEqual({
      isError: true,
      output: 'Invalid model "smart" — available models: orchestrator, primary, worker, reviewer, validator',
    });
    await expectNoValidatorSideEffects();
  });

  it('removes the prepared worktree when the launch is refused', async () => {
    await validatingMilestone(store);
    host.runtime.failSpawn = 'provider unavailable';

    const result = await spawn(SCRUTINY);

    expect(result).toEqual({ isError: true, output: 'tower spawn failed: provider unavailable' });
    expect(host.launches).toHaveLength(1);
    expect(existsSync(worktreePath())).toBe(false);
    expect(await git(repo, 'worktree', 'list')).not.toContain('val-ms1');
    expect((await store.load()).roster.agents).toEqual([]);
  });

  it('aborts the agent and removes the worktree when registration fails', async () => {
    await validatingMilestone(store);
    vi.spyOn(TowerStore.prototype, 'registerSpawnedAgent').mockRejectedValueOnce(
      new TowerProtocolError('forced registration failure'),
    );

    const result = await spawn(SCRUTINY);

    expect(result).toEqual({ isError: true, output: 'forced registration failure' });
    expect(host.aborted).toEqual(['agent-1']);
    expect(host.registered).toEqual([]);
    expect(existsSync(worktreePath())).toBe(false);
  });

  it('refuses registration when the contract changed after the snapshot was briefed', async () => {
    await validatingMilestone(store);
    const prepare = TowerStore.prototype.prepareValidationWorktree;
    vi.spyOn(TowerStore.prototype, 'prepareValidationWorktree').mockImplementationOnce(async function (
      this: TowerStore,
      milestoneId,
      kind,
    ) {
      const prepared = await prepare.call(this, milestoneId, kind);
      await this.updateObjective({ definitionOfDone: ['export --format csv writes a valid file', 'import works'] });
      return prepared;
    });

    const result = await spawn(SCRUTINY);

    expect(result.isError).toBe(true);
    expect(result.output).toContain('was briefed under contract revision 0');
    expect(host.aborted).toEqual(['agent-1']);
    expect(existsSync(worktreePath())).toBe(false);
    expect((await store.load()).roster.agents).toEqual([]);
  });

  it('refuses and cleans up when the prepared commit is not the snapshot validation commit', async () => {
    await validatingMilestone(store);
    const prepare = TowerStore.prototype.prepareValidationWorktree;
    vi.spyOn(TowerStore.prototype, 'prepareValidationWorktree').mockImplementationOnce(async function (
      this: TowerStore,
      milestoneId,
      kind,
    ) {
      return { ...(await prepare.call(this, milestoneId, kind)), commit: 'f'.repeat(40) };
    });

    const result = await spawn(SCRUTINY);

    expect(result.isError).toBe(true);
    expect(result.output).toContain('restarted its validation on fffffff');
    expect(host.launches).toEqual([]);
    expect(existsSync(worktreePath())).toBe(false);
  });

  it('refuses a second validator while one is running or once the kind has a verdict', async () => {
    const tip = await validatingMilestone(store);
    expect((await spawn(SCRUTINY)).isError).toBeUndefined();

    const duplicate = await spawn({ ...SCRUTINY, name: 'val-b' });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.output).toContain('validator "val-a" is still running the MS1 scrutiny validation');

    await registerValidator(store, 'val-u', 'agent-u', tip, 'user-testing');
    await store.submitValidation('val-u', { milestone: 'MS1', kind: 'user-testing', verdict: 'pass' });
    const decided = await spawn({ ...SCRUTINY, name: 'val-c', validation_kind: 'user-testing' });
    expect(decided.isError).toBe(true);
    expect(decided.output).toContain('already has a user-testing verdict');
    expect(host.launches).toHaveLength(1);
  });

  it('briefs a later milestone with the diff from the commit the previous milestone passed on', async () => {
    await store.draftObjective({
      title: 'Ship CSV export',
      goal: 'Users export their data as CSV.',
      definitionOfDone: ['export works'],
      milestones: [
        { title: 'Data model', validation: { scrutiny: false, userTesting: false } },
        { title: 'CLI command' },
      ],
    });
    await store.plan([{ title: 'Build csv model', scope: ['src/model/**'], milestone: 'MS1' }]);
    await store.requestObjectiveApproval();
    await store.approveObjective('human');
    await store.updateMission('tower', 'M1', { status: 'abandoned' });
    const first = await git(repo, 'rev-parse', 'main');
    await store.startMilestoneValidation('MS1', first);
    await store.activateNextMilestone();
    await store.plan([{ title: 'Build csv cli', scope: ['src/cli/**'], milestone: 'MS2' }]);
    await store.updateMission('tower', 'M2', { status: 'abandoned' });
    await commitFile(repo, 'src/cli/index.ts', 'export {};\n', 'cli');
    const second = await git(repo, 'rev-parse', 'main');
    await store.startMilestoneValidation('MS2', second);

    const result = await spawn({ ...SCRUTINY, milestone: 'MS2' });

    expect(result.isError).toBeUndefined();
    expect(host.launches[0]?.cwd).toBe(worktreePath('val-ms2-scrutiny-r1'));
    expect(host.launches[0]?.prompt).toContain(`\`git diff ${first}..${second}\``);
    expect(host.launches[0]?.prompt).toContain('FINAL milestone');
  });
});
