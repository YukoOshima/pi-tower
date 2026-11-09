import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadTowerConfig,
  readTowerModelFlags,
  resolveObjectiveSettings,
  TowerConfigError,
  towerConfigPaths,
} from '../../src/config/index.ts';
import type { TowerConfigLoadInput } from '../../src/config/index.ts';

let root: string;
let agentDir: string;
let cwd: string;
let globalFile: string;
let projectFile: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pi-tower-config-load-'));
  agentDir = join(root, 'agent');
  cwd = join(root, 'repo');
  globalFile = join(agentDir, 'tower.json');
  projectFile = join(cwd, '.pi', 'tower.json');
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function input(overrides: Partial<TowerConfigLoadInput> = {}): TowerConfigLoadInput {
  return { agentDir, cwd, env: {}, projectTrusted: true, ...overrides };
}

async function loadError(overrides: Partial<TowerConfigLoadInput> = {}): Promise<TowerConfigError> {
  try {
    await loadTowerConfig(input(overrides));
  } catch (error) {
    if (error instanceof TowerConfigError) return error;
    throw error;
  }
  throw new Error('expected loadTowerConfig to throw');
}

const globalSource = () => ({ kind: 'file', scope: 'global', path: globalFile }) as const;
const projectSource = () => ({ kind: 'file', scope: 'project', path: projectFile }) as const;

describe('loadTowerConfig', () => {
  it('returns an empty config when nothing is configured', async () => {
    expect(await loadTowerConfig(input())).toStrictEqual({
      roles: {},
      models: {},
      files: [
        { scope: 'global', path: globalFile, status: 'missing' },
        { scope: 'project', path: projectFile, status: 'missing' },
      ],
    });
  });

  it('reads the global file with per-field sources', async () => {
    await writeJson(globalFile, {
      orchestrator: 'anthropic/claude-opus-4-5:xhigh',
      models: { fast: { model: 'google/gemini-2.5-flash', description: 'Quick edits' } },
      maxRunningAgents: 6,
    });
    const config = await loadTowerConfig(input());
    expect(config.roles).toStrictEqual({
      orchestrator: {
        value: { provider: 'anthropic', modelId: 'claude-opus-4-5', thinkingLevel: 'xhigh' },
        source: globalSource(),
      },
    });
    expect(config.models).toStrictEqual({
      fast: {
        value: { provider: 'google', modelId: 'gemini-2.5-flash', description: 'Quick edits' },
        source: globalSource(),
      },
    });
    expect(config.maxRunningAgents).toStrictEqual({ value: 6, source: globalSource() });
    expect(config.agentTimeoutMs).toBeUndefined();
    expect(config.files[0]).toStrictEqual({ scope: 'global', path: globalFile, status: 'loaded' });
  });

  it('applies flags > env > trusted project file > global file per role', async () => {
    await writeJson(globalFile, {
      orchestrator: 'global/orchestrator',
      worker: 'global/worker',
      reviewer: 'global/reviewer',
    });
    await writeJson(projectFile, {
      orchestrator: 'project/orchestrator',
      worker: 'project/worker',
      reviewer: 'project/reviewer:low',
    });
    const config = await loadTowerConfig(
      input({
        env: {
          PI_TOWER_ORCHESTRATOR_MODEL: 'env/orchestrator',
          PI_TOWER_WORKER_MODEL: 'env/worker:high',
        },
        flags: { orchestrator: 'flag/orchestrator:max' },
      }),
    );
    expect(config.roles).toStrictEqual({
      orchestrator: {
        value: { provider: 'flag', modelId: 'orchestrator', thinkingLevel: 'max' },
        source: { kind: 'flag', flag: 'tower-orchestrator-model' },
      },
      worker: {
        value: { provider: 'env', modelId: 'worker', thinkingLevel: 'high' },
        source: { kind: 'env', variable: 'PI_TOWER_WORKER_MODEL' },
      },
      reviewer: {
        value: { provider: 'project', modelId: 'reviewer', thinkingLevel: 'low' },
        source: projectSource(),
      },
    });
  });

  it('reads the validator role from the global file, the project file, env and flag in precedence order', async () => {
    await writeJson(globalFile, { validator: 'global/validator' });
    expect((await loadTowerConfig(input())).roles).toStrictEqual({
      validator: { value: { provider: 'global', modelId: 'validator' }, source: globalSource() },
    });
    await writeJson(projectFile, { validator: { model: 'project/validator', thinkingLevel: 'high' } });
    expect((await loadTowerConfig(input())).roles.validator).toStrictEqual({
      value: { provider: 'project', modelId: 'validator', thinkingLevel: 'high' },
      source: projectSource(),
    });
    const env = { PI_TOWER_VALIDATOR_MODEL: 'env/validator:low' };
    expect((await loadTowerConfig(input({ env }))).roles.validator).toStrictEqual({
      value: { provider: 'env', modelId: 'validator', thinkingLevel: 'low' },
      source: { kind: 'env', variable: 'PI_TOWER_VALIDATOR_MODEL' },
    });
    const flagged = await loadTowerConfig(input({ env, flags: { validator: 'flag/validator:max' } }));
    expect(flagged.roles.validator).toStrictEqual({
      value: { provider: 'flag', modelId: 'validator', thinkingLevel: 'max' },
      source: { kind: 'flag', flag: 'tower-validator-model' },
    });
    expect((await loadError({ env: { PI_TOWER_VALIDATOR_MODEL: 'nope' } })).issues[0]?.source).toBe(
      'env PI_TOWER_VALIDATOR_MODEL',
    );
  });

  it('merges the model pool per alias with the project file winning', async () => {
    await writeJson(globalFile, {
      models: { fast: 'google/gemini-2.5-flash', deep: 'anthropic/claude-opus-4-5:high' },
      maxRunningAgents: 8,
      agentTimeoutMs: 60_000,
    });
    await writeJson(projectFile, {
      models: { deep: 'anthropic/claude-opus-4-5:max', local: 'ollama/qwen2.5-coder:7b' },
      maxRunningAgents: 2,
    });
    const config = await loadTowerConfig(input());
    expect(Object.keys(config.models)).toEqual(['fast', 'deep', 'local']);
    expect(config.models['fast']?.source).toStrictEqual(globalSource());
    expect(config.models['deep']).toStrictEqual({
      value: { provider: 'anthropic', modelId: 'claude-opus-4-5', thinkingLevel: 'max' },
      source: projectSource(),
    });
    expect(config.models['local']?.value).toStrictEqual({
      provider: 'ollama',
      modelId: 'qwen2.5-coder:7b',
    });
    expect(config.maxRunningAgents).toStrictEqual({ value: 2, source: projectSource() });
    expect(config.agentTimeoutMs).toStrictEqual({ value: 60_000, source: globalSource() });
  });

  it('keeps the objective sections in precedence order so the project overrides the global file per key', async () => {
    await writeJson(globalFile, { objective: { maxValidationRounds: 5, autopilot: false, maxCostUsd: 20 } });
    await writeJson(projectFile, { objective: { maxValidationRounds: 2, skipScrutiny: true } });
    const config = await loadTowerConfig(input());
    expect(config.objective).toStrictEqual([
      { value: { maxValidationRounds: 2, skipScrutiny: true }, source: projectSource() },
      { value: { maxValidationRounds: 5, autopilot: false, maxCostUsd: 20 }, source: globalSource() },
    ]);
    const settings = resolveObjectiveSettings(config);
    expect(settings.maxValidationRounds).toStrictEqual({ value: 2, source: projectSource() });
    expect(settings.autopilot).toStrictEqual({ value: false, source: globalSource() });
    expect(settings.maxCostUsd).toStrictEqual({ value: 20, source: globalSource() });
    expect(settings.skipScrutiny).toStrictEqual({ value: true, source: projectSource() });
    expect(settings.maxFeatureAttempts).toStrictEqual({ value: 3, source: { kind: 'default' } });

    const untrusted = await loadTowerConfig(input({ projectTrusted: false }));
    expect(resolveObjectiveSettings(untrusted).maxValidationRounds).toStrictEqual({ value: 5, source: globalSource() });

    await writeJson(projectFile, { objective: {} });
    await writeJson(globalFile, {});
    expect((await loadTowerConfig(input())).objective).toBeUndefined();
  });

  it('names the file and key of an invalid objective setting', async () => {
    await writeJson(projectFile, { objective: { maxFeatureAttempts: 0 } });
    expect((await loadError()).issues).toEqual([
      { source: `${projectFile} (project)`, key: 'objective.maxFeatureAttempts', message: 'expected a positive integer, got 0' },
    ]);
  });

  it('ignores the project file when the project is not trusted', async () => {
    await writeJson(globalFile, { worker: 'global/worker' });
    await writeJson(projectFile, { worker: 'project/worker', bogus: true });
    const config = await loadTowerConfig(input({ projectTrusted: false }));
    expect(config.roles.worker?.source).toStrictEqual(globalSource());
    expect(config.files).toStrictEqual([
      { scope: 'global', path: globalFile, status: 'loaded' },
      { scope: 'project', path: projectFile, status: 'untrusted' },
    ]);
  });

  it('reports a missing project file as missing even when untrusted', async () => {
    const config = await loadTowerConfig(input({ projectTrusted: false }));
    expect(config.files[1]).toStrictEqual({ scope: 'project', path: projectFile, status: 'missing' });
  });

  it('lets PI_TOWER_CONFIG replace the global file path', async () => {
    const override = join(root, 'elsewhere', 'team-tower.json');
    await writeJson(globalFile, { worker: 'default/location' });
    await writeJson(override, { worker: 'override/location' });
    const config = await loadTowerConfig(input({ env: { PI_TOWER_CONFIG: override } }));
    expect(config.roles.worker).toStrictEqual({
      value: { provider: 'override', modelId: 'location' },
      source: { kind: 'file', scope: 'global', path: override },
    });
    expect(config.files[0]).toStrictEqual({ scope: 'global', path: override, status: 'loaded' });

    const absent = join(root, 'not-created-yet.json');
    const fresh = await loadTowerConfig(input({ env: { PI_TOWER_CONFIG: absent } }));
    expect(fresh.roles).toStrictEqual({});
    expect(fresh.files[0]).toStrictEqual({ scope: 'global', path: absent, status: 'missing' });
  });

  it('resolves a relative PI_TOWER_CONFIG against cwd and expands ~', () => {
    const base = { agentDir, cwd, homeDir: '/home/someone' };
    expect(towerConfigPaths({ ...base, env: { PI_TOWER_CONFIG: 'cfg/tower.json' } }).global).toBe(
      join(cwd, 'cfg', 'tower.json'),
    );
    expect(towerConfigPaths({ ...base, env: { PI_TOWER_CONFIG: '~/tower/pi.json' } }).global).toBe(
      '/home/someone/tower/pi.json',
    );
    expect(towerConfigPaths({ ...base, env: { PI_TOWER_CONFIG: '  ' } }).global).toBe(globalFile);
    expect(towerConfigPaths({ ...base, env: {}, configDirName: '.tau' }).project).toBe(
      join(cwd, '.tau', 'tower.json'),
    );
  });

  it('ignores blank env and flag values', async () => {
    await writeJson(globalFile, { worker: 'global/worker' });
    const config = await loadTowerConfig(
      input({ env: { PI_TOWER_WORKER_MODEL: '   ' }, flags: { worker: '' } }),
    );
    expect(config.roles.worker?.source).toStrictEqual(globalSource());
  });

  it('names the env variable or flag that holds a bad reference', async () => {
    const error = await loadError({
      env: { PI_TOWER_WORKER_MODEL: 'sonnet' },
      flags: { reviewer: 'anthropic/' },
    });
    expect(error.issues).toEqual([
      {
        source: 'env PI_TOWER_WORKER_MODEL',
        message:
          '"sonnet" has no provider — expected provider/modelId[:thinkingLevel] (e.g. anthropic/claude-sonnet-4-5:high)',
      },
      {
        source: '--tower-reviewer-model',
        message:
          '"anthropic/" has an empty model id — expected provider/modelId[:thinkingLevel] (e.g. anthropic/claude-sonnet-4-5:high)',
      },
    ]);
  });

  it('names the file for invalid JSON and aggregates problems across layers', async () => {
    await mkdir(agentDir, { recursive: true });
    await writeFile(globalFile, '{ "worker": ', 'utf8');
    await writeJson(projectFile, { models: { primary: 'a/b' } });
    const error = await loadError({ env: { PI_TOWER_ORCHESTRATOR_MODEL: 'nope' } });
    expect(error.issues.map((issue) => [issue.source, issue.key])).toEqual([
      [`${globalFile} (global)`, undefined],
      [`${projectFile} (project)`, 'models.primary'],
      ['env PI_TOWER_ORCHESTRATOR_MODEL', undefined],
    ]);
    expect(error.issues[0]?.message).toMatch(/^invalid JSON — /);
    expect(error.message.startsWith('Invalid tower config:\n- ')).toBe(true);
  });

  it('reports an unreadable config path', async () => {
    await mkdir(globalFile, { recursive: true });
    const error = await loadError();
    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]?.source).toBe(`${globalFile} (global)`);
    expect(error.issues[0]?.message).toMatch(/^cannot read the file — .*EISDIR/);
  });

  it('treats an empty or BOM-prefixed file as JSON input', async () => {
    await mkdir(agentDir, { recursive: true });
    await writeFile(globalFile, '\n', 'utf8');
    await writeJson(projectFile, {});
    await writeFile(projectFile, `\uFEFF${JSON.stringify({ worker: 'openai/gpt-5.1' })}`, 'utf8');
    const config = await loadTowerConfig(input());
    expect(config.files.map((file) => file.status)).toEqual(['loaded', 'loaded']);
    expect(config.roles.worker?.value).toStrictEqual({ provider: 'openai', modelId: 'gpt-5.1' });
  });
});

describe('readTowerModelFlags', () => {
  it('reads the string-valued tower model flags', () => {
    const values: Record<string, boolean | string | undefined> = {
      'tower-orchestrator-model': 'anthropic/claude-opus-4-5',
      'tower-worker-model': true,
    };
    const requested: string[] = [];
    expect(
      readTowerModelFlags((name) => {
        requested.push(name);
        return values[name];
      }),
    ).toStrictEqual({ orchestrator: 'anthropic/claude-opus-4-5' });
    expect(requested).toEqual([
      'tower-orchestrator-model',
      'tower-worker-model',
      'tower-reviewer-model',
      'tower-validator-model',
    ]);
    expect(readTowerModelFlags((name) => (name === 'tower-validator-model' ? 'a/b:high' : undefined))).toStrictEqual({
      validator: 'a/b:high',
    });
  });
});
