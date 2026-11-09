import { describe, expect, it } from 'vitest';

import { formatModelTable } from '../../src/config/describe.ts';
import { resolveTowerModels, TOWER_MODEL_FLAGS, type TowerConfig, type TowerConfigSource, type TowerModelSpec, type TowerRole } from '../../src/config/index.ts';
import { piRunArgs } from '../../src/headless/args.ts';
import { towerModelLines } from '../../src/headless/models.ts';
import { checkRoleModelLines, expectedThinking, HAND_OVER_COMMAND, headlessRoleModels, HEADLESS_ROLES, type HeadlessRole } from './headless.ts';
import { parseRoleModel, type RoleModel } from './settings.ts';

const MODELS: Readonly<Record<HeadlessRole, RoleModel>> = {
  orchestrator: parseRoleModel('byteplus-gateway/claude-sonnet-5-5:low'),
  worker: parseRoleModel('byteplus-gateway/claude-haiku-5-5:low'),
  reviewer: parseRoleModel('byteplus-gateway/claude-opus-5-5:low'),
  validator: parseRoleModel('byteplus-gateway/claude-opus-5-5:low'),
};

const CONFIG_PATH = '/tmp/pi-tower-e2e-x/S16/tower.json';

function spec(role: RoleModel): TowerModelSpec {
  const [provider = '', modelId = ''] = role.model.split('/');
  return role.thinking === undefined ? { provider, modelId } : ({ provider, modelId, thinkingLevel: role.thinking } as TowerModelSpec);
}

function printedLines(models: Readonly<Record<HeadlessRole, RoleModel>>, source: (role: TowerRole) => TowerConfigSource): string[] {
  const config: TowerConfig = {
    roles: Object.fromEntries(HEADLESS_ROLES.map((role) => [role, { value: spec(models[role]), source: source(role) }])),
    models: {},
    files: [],
  };
  const lines = towerModelLines(formatModelTable(resolveTowerModels(config, undefined))) ?? [];
  return lines.map((line) => `[pi-tower +1s] ${line}`);
}

function runnerOutput(modelLines: readonly string[]): string[] {
  return [
    '[pi-tower +0s] started pi (pi --mode rpc) in /tmp/pi-tower-e2e-x/S16/repo',
    '[pi-tower +1s] > /tower on',
    '[pi-tower +1s] pi: Tower mode: ON',
    '[pi-tower +1s] > /tower models',
    ...modelLines,
    `[pi-tower +1s] ${HAND_OVER_COMMAND}/tmp/pi-tower-e2e-x/S16/objective.md`,
    '[pi-tower +1s] objective handed to the orchestrator: /tmp/pi-tower-e2e-x/S16/objective.md',
  ];
}

const flagSource = (role: TowerRole): TowerConfigSource => ({ kind: 'flag', flag: TOWER_MODEL_FLAGS[role] });
const fileSource = (): TowerConfigSource => ({ kind: 'file', scope: 'global', path: CONFIG_PATH });

describe('headlessRoleModels', () => {
  it('reads the role model lines the runner prints from the /tower models table', () => {
    const lines = runnerOutput(printedLines(MODELS, flagSource));
    expect(headlessRoleModels(lines).map(({ index: _index, line: _line, ...row }) => row)).toEqual(
      HEADLESS_ROLES.map((role) => ({ role, model: MODELS[role].model, thinking: 'low (configured)', source: `--tower-${role}-model` })),
    );
    expect(headlessRoleModels(printedLines(MODELS, fileSource)).map((row) => row.source)).toEqual(HEADLESS_ROLES.map(() => `${CONFIG_PATH} (global)`));
  });

  it('expects "pi default" thinking for a model given without a thinking level, as the product prints it', () => {
    const plain = { ...MODELS, worker: parseRoleModel('byteplus-gateway/claude-haiku-5-5') };
    const worker = headlessRoleModels(printedLines(plain, flagSource)).find((row) => row.role === 'worker');
    expect(expectedThinking(plain.worker)).toBe('pi default');
    expect(worker?.thinking).toBe('pi default');
  });

  it('passes the per-role model flags to pi as --tower-<role>-model', () => {
    const args = piRunArgs({ piArgs: ['-e', 'src/index.ts'], models: { orchestrator: MODELS.orchestrator.spec, validator: MODELS.validator.spec } });
    expect(args).toEqual(['-e', 'src/index.ts', `--tower-orchestrator-model=${MODELS.orchestrator.spec}`, `--tower-validator-model=${MODELS.validator.spec}`]);
  });
});

describe('checkRoleModelLines', () => {
  const expected = (source: (role: HeadlessRole) => string) => (role: HeadlessRole) => ({ model: MODELS[role], source: source(role) });

  it('passes when every role prints its model, thinking level and source before the hand-over', () => {
    const lines = runnerOutput(printedLines(MODELS, flagSource));
    const check = checkRoleModelLines(lines, expected((role) => `--tower-${role}-model`));
    expect(check.ok).toBe(true);
    expect(check.evidence.at(-1)).toBe(`hand-over: [pi-tower +1s] ${HAND_OVER_COMMAND}/tmp/pi-tower-e2e-x/S16/objective.md`);
    expect(checkRoleModelLines(runnerOutput(printedLines(MODELS, fileSource)), expected(() => `${CONFIG_PATH} (global)`)).ok).toBe(true);
  });

  it('fails when a role line comes after the hand-over, names another source or model, or is missing', () => {
    const models = printedLines(MODELS, flagSource);
    const late = runnerOutput(models.slice(0, 3));
    late.push(models[3] ?? '');
    const lateCheck = checkRoleModelLines(late, expected((role) => `--tower-${role}-model`));
    expect(lateCheck.ok).toBe(false);
    expect(lateCheck.evidence[3]).toMatch(/validator model: .* — expected "validator model: .*" before the hand-over$/);
    expect(checkRoleModelLines(runnerOutput(models), expected(() => `${CONFIG_PATH} (global)`)).ok).toBe(false);
    expect(checkRoleModelLines(runnerOutput(models), (role) => ({ model: role === 'worker' ? MODELS.reviewer : MODELS[role], source: `--tower-${role}-model` })).ok).toBe(false);
    const missing = checkRoleModelLines(runnerOutput(models.slice(1)), expected((role) => `--tower-${role}-model`));
    expect(missing.ok).toBe(false);
    expect(missing.evidence[0]).toMatch(/^\(no orchestrator model line; expected "orchestrator model: /);
  });

  it('fails without a hand-over line', () => {
    const check = checkRoleModelLines(printedLines(MODELS, flagSource), expected((role) => `--tower-${role}-model`));
    expect(check.ok).toBe(false);
    expect(check.evidence.at(-1)).toBe('(no hand-over line)');
  });
});
