import { readFile } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAIN_AGENT_ID, TowerStore } from '../../src/protocol/index.ts';
import {
  TOWER_VALIDATE_VALIDATORS_ONLY,
  type TowerValidateToolInput,
} from '../../src/tools/validate/validate.ts';
import { createTowerValidateTool } from '../../src/tools/validate/validateTool.ts';
import { createRepo, removeDir } from '../tower/fakes.ts';
import { ObjectiveTestHost, registerValidator, validatingMilestone } from './objectiveHost.ts';

let repo: string;
let store: TowerStore;
let host: ObjectiveTestHost;

beforeEach(async () => {
  repo = await createRepo('tower-validate-tool-');
  store = new TowerStore(repo);
  await store.init('session-objective');
  host = new ObjectiveTestHost(repo);
  host.sessionId = 'session-objective';
});

afterEach(async () => {
  vi.restoreAllMocks();
  await removeDir(repo);
});

const PASS: TowerValidateToolInput = {
  milestone: 'MS1',
  kind: 'scrutiny',
  verdict: 'pass',
  checks: ['npm run typecheck: clean'],
  evidence: 'ran typecheck and tests',
};

function validate(args: TowerValidateToolInput, agentId: string) {
  return createTowerValidateTool(host, { agentId }).run(args, { toolCallId: 'call_validate' });
}

async function rounds() {
  return (await store.load()).objective?.milestones[0]?.rounds ?? [];
}

describe('TowerValidate tool', () => {
  it('never lets the orchestrator report a verdict as the tower', async () => {
    await validatingMilestone(store);
    const submit = vi.spyOn(TowerStore.prototype, 'submitValidation');

    const result = await validate(PASS, MAIN_AGENT_ID);

    expect(result).toEqual({ isError: true, output: TOWER_VALIDATE_VALIDATORS_ONLY });
    expect(submit).not.toHaveBeenCalled();
    expect(await rounds()).toEqual([]);
  });

  it('refuses the commands kind and unknown verdicts before the store is touched', async () => {
    const submit = vi.spyOn(TowerStore.prototype, 'submitValidation');

    const commands = await validate({ ...PASS, kind: 'commands' as 'scrutiny' }, 'agent-v1');
    const verdict = await validate({ ...PASS, verdict: 'maybe' as 'pass' }, 'agent-v1');

    expect(commands.isError).toBe(true);
    expect(commands.output).toContain('the commands validation is recorded by the tower itself');
    expect(verdict.isError).toBe(true);
    expect(verdict.output).toContain('verdict must be pass | fail');
    expect(submit).not.toHaveBeenCalled();
  });

  it('refuses roster agents that are not validators', async () => {
    const tip = await validatingMilestone(store);
    await registerValidator(store, 'val-a', 'agent-v1', tip);
    await store.registerAgent({ name: 'agent-build', agentId: 'agent-w1', kind: 'worker', missionId: 'M1', spawnedAt: new Date().toISOString() });

    const worker = await validate(PASS, 'agent-w1');
    const stranger = await validate(PASS, 'agent-unknown');

    expect(worker.isError).toBe(true);
    expect(worker.output).toContain('agent "agent-build" is a worker, not a validator');
    expect(stranger.isError).toBe(true);
    expect(stranger.output).toContain('is not a tower participant');
    expect(await rounds()).toEqual([]);
  });

  it('records the verdict under the validator name and wakes the tower', async () => {
    const tip = await validatingMilestone(store);
    await registerValidator(store, 'val-a', 'agent-v1', tip);

    const result = await validate(PASS, 'agent-v1');

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain(`validation recorded: validation MS1 scrutiny r1: pass on commit ${tip.slice(0, 7)}`);
    expect(result.output).toContain('milestone MS1 is now validating');
    expect(result.output).toContain('notified: tower (validation MS1 scrutiny r1: pass)');
    expect(result.output).toContain('do not call TowerValidate again');
    const [round] = await rounds();
    expect(round).toMatchObject({ round: 1, kind: 'scrutiny', validator: 'val-a', validatedCommit: tip, verdict: 'pass' });
    expect(await readFile(store.abs(round!.file), 'utf8')).toContain('ran typecheck and tests');
    expect(host.published).toEqual([
      expect.objectContaining({ from: 'val-a', to: 'tower', subject: 'validation MS1 scrutiny r1: pass' }),
    ]);
  });

  it('passes the configured skip settings to the store', async () => {
    host.settings = { ...host.settings, skipUserTesting: true };
    const tip = await validatingMilestone(store, { skipUserTesting: true });
    await registerValidator(store, 'val-a', 'agent-v1', tip);

    const result = await validate(PASS, 'agent-v1');

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('milestone MS1 is now passed');
    expect((await store.load()).objective?.milestones[0]?.status).toBe('passed');
  });

  it('records a failing verdict and refuses a second report from the same validator', async () => {
    const tip = await validatingMilestone(store);
    await registerValidator(store, 'val-b', 'agent-v2', tip, 'user-testing');

    const empty = await validate({ ...PASS, kind: 'user-testing', verdict: 'fail' }, 'agent-v2');
    expect(empty.isError).toBe(true);
    expect(empty.output).toContain('a fail verdict must list at least one failure');

    const result = await validate(
      { ...PASS, kind: 'user-testing', verdict: 'fail', failures: ['export crashes on an empty table', 'no --help text'] },
      'agent-v2',
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('validation MS1 user-testing r1: fail (2 failures)');
    expect(result.output).toContain('milestone MS1 is now failed');
    const again = await validate({ ...PASS, kind: 'user-testing' }, 'agent-v2');
    expect(again.isError).toBe(true);
    expect(again.output).toContain('a validator reports exactly once');
  });

  it('refuses a verdict for a kind the validator was not registered for', async () => {
    const tip = await validatingMilestone(store);
    await registerValidator(store, 'val-a', 'agent-v1', tip);

    const result = await validate({ ...PASS, kind: 'user-testing' }, 'agent-v1');

    expect(result.isError).toBe(true);
    expect(result.output).toContain('is not the validator registered for MS1 user-testing');
  });
});
