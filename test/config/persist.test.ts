import { execFile } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  loadTowerConfig,
  TowerConfigError,
  updateTowerConfigModel,
} from '../../src/config/index.ts';
import type { TowerConfigModelUpdate } from '../../src/config/index.ts';

const execFileAsync = promisify(execFile);

let root: string;
let file: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pi-tower-config-persist-'));
  file = join(root, 'agent', 'tower.json');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeRaw(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function updateError(update: TowerConfigModelUpdate): Promise<TowerConfigError> {
  try {
    await updateTowerConfigModel(update);
  } catch (error) {
    if (error instanceof TowerConfigError) return error;
    throw error;
  }
  throw new Error('expected updateTowerConfigModel to throw');
}

describe('updateTowerConfigModel', () => {
  it('creates the file and its directory with 2-space JSON', async () => {
    const result = await updateTowerConfigModel({ path: file, key: 'worker', ref: 'openai/gpt-5.1-codex:high' });
    expect(result).toStrictEqual({
      path: file,
      field: 'worker',
      changed: true,
      value: { provider: 'openai', modelId: 'gpt-5.1-codex', thinkingLevel: 'high' },
    });
    expect(await readFile(file, 'utf8')).toBe('{\n  "worker": "openai/gpt-5.1-codex:high"\n}\n');
  });

  it('preserves unrelated keys and their order', async () => {
    await writeRaw(
      file,
      '{"maxRunningAgents":4,"orchestrator":"anthropic/claude-opus-4-5","models":{"fast":"google/gemini-2.5-flash"},"agentTimeoutMs":60000}',
    );
    await updateTowerConfigModel({ path: file, key: 'reviewer', ref: 'google/gemini-2.5-pro' });
    await updateTowerConfigModel({ path: file, key: 'orchestrator', ref: 'anthropic/claude-opus-4-5:max' });
    expect(await readFile(file, 'utf8')).toBe(
      `${JSON.stringify(
        {
          maxRunningAgents: 4,
          orchestrator: 'anthropic/claude-opus-4-5:max',
          models: { fast: 'google/gemini-2.5-flash' },
          agentTimeoutMs: 60000,
          reviewer: 'google/gemini-2.5-pro',
        },
        null,
        2,
      )}\n`,
    );
  });

  it('sets pool aliases under models', async () => {
    await updateTowerConfigModel({ path: file, key: 'fast', ref: 'google/gemini-2.5-flash' });
    const result = await updateTowerConfigModel({ path: file, key: 'deep', ref: 'anthropic/claude-opus-4-5:xhigh' });
    expect(result.field).toBe('models.deep');
    expect(await readJson(file)).toStrictEqual({
      models: { fast: 'google/gemini-2.5-flash', deep: 'anthropic/claude-opus-4-5:xhigh' },
    });
  });

  it('keeps the description of an object entry and replaces its model and level', async () => {
    await writeRaw(
      file,
      JSON.stringify({
        models: { fast: { model: 'google/gemini-2.5-flash', thinkingLevel: 'low', description: 'Quick edits' } },
      }),
    );
    const updated = await updateTowerConfigModel({ path: file, key: 'fast', ref: 'google/gemini-3-flash' });
    expect(updated.value).toStrictEqual({ provider: 'google', modelId: 'gemini-3-flash', description: 'Quick edits' });
    expect(await readJson(file)).toStrictEqual({
      models: { fast: { model: 'google/gemini-3-flash', description: 'Quick edits' } },
    });
    await updateTowerConfigModel({ path: file, key: 'fast', ref: 'google/gemini-3-flash:high' });
    expect(await readFile(file, 'utf8')).toContain(
      '"fast": {\n      "model": "google/gemini-3-flash",\n      "description": "Quick edits",\n      "thinkingLevel": "high"\n    }',
    );
  });

  it('clears roles and aliases, dropping an emptied models object', async () => {
    await writeRaw(file, JSON.stringify({ worker: 'openai/gpt-5.1', models: { fast: 'google/gemini-2.5-flash' } }));
    expect(await updateTowerConfigModel({ path: file, key: 'worker' })).toStrictEqual({
      path: file,
      field: 'worker',
      changed: true,
    });
    await updateTowerConfigModel({ path: file, key: 'fast' });
    expect(await readFile(file, 'utf8')).toBe('{}\n');
  });

  it('does not write when nothing changes', async () => {
    const missing = await updateTowerConfigModel({ path: file, key: 'reviewer' });
    expect(missing.changed).toBe(false);
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });

    await writeRaw(file, '{\n    "worker": "openai/gpt-5.1"\n}');
    const same = await updateTowerConfigModel({ path: file, key: 'worker', ref: 'openai/gpt-5.1' });
    expect(same).toStrictEqual({
      path: file,
      field: 'worker',
      changed: false,
      value: { provider: 'openai', modelId: 'gpt-5.1' },
    });
    expect(await readFile(file, 'utf8')).toBe('{\n    "worker": "openai/gpt-5.1"\n}');
  });

  it('treats primary as the orchestrator', async () => {
    const result = await updateTowerConfigModel({ path: file, key: 'primary', ref: 'anthropic/claude-opus-4-5' });
    expect(result.field).toBe('orchestrator');
    expect(await readJson(file)).toStrictEqual({ orchestrator: 'anthropic/claude-opus-4-5' });
  });

  it('accepts the models.<alias> labels shown by formatModelTable', async () => {
    const result = await updateTowerConfigModel({ path: file, key: 'models.fast', ref: 'google/gemini-2.5-flash' });
    expect(result.field).toBe('models.fast');
    expect(await readJson(file)).toStrictEqual({ models: { fast: 'google/gemini-2.5-flash' } });
    expect((await updateError({ path: file, key: 'models.worker', ref: 'a/b' })).issues[0]).toEqual({
      source: file,
      key: 'models.worker',
      message: '"worker" is reserved for the role models (primary, orchestrator, worker, reviewer) — rename the alias',
    });
  });

  it('rejects bad references and aliases without touching the file', async () => {
    await writeRaw(file, '{"worker":"openai/gpt-5.1"}');
    expect((await updateError({ path: file, key: 'worker', ref: 'gpt-5' })).issues).toEqual([
      {
        source: file,
        key: 'worker',
        message:
          '"gpt-5" has no provider — expected provider/modelId[:thinkingLevel] (e.g. anthropic/claude-sonnet-4-5:high)',
      },
    ]);
    expect((await updateError({ path: file, key: 'Primary', ref: 'a/b' })).issues[0]?.key).toBe('models.Primary');
    expect((await updateError({ path: file, key: 'my alias', ref: 'a/b' })).message).toContain(
      'models.my alias: invalid alias "my alias"',
    );
    expect(await readFile(file, 'utf8')).toBe('{"worker":"openai/gpt-5.1"}');
  });

  it('refuses to rewrite a file it cannot validate', async () => {
    await writeRaw(file, '{"worker": ');
    expect((await updateError({ path: file, key: 'worker', ref: 'a/b' })).message).toMatch(
      new RegExp(`^Invalid tower config — ${file}: invalid JSON — `),
    );
    await writeRaw(file, '{"worker":"openai/gpt-5.1","maxRunningAgents":0}');
    expect((await updateError({ path: file, key: 'reviewer', ref: 'a/b' })).issues).toEqual([
      { source: file, key: 'maxRunningAgents', message: 'expected a positive integer, got 0' },
    ]);
    await writeRaw(file, '{"models":["a/b"]}');
    expect((await updateError({ path: file, key: 'fast', ref: 'a/b' })).issues[0]?.key).toBe('models');
    await writeRaw(file, '[]');
    expect((await updateError({ path: file, key: 'worker', ref: 'a/b' })).issues[0]?.message).toBe(
      'expected a JSON object — fix the file by hand first',
    );
    expect(await readFile(file, 'utf8')).toBe('[]');
    expect(await readdir(dirname(file))).toEqual(['tower.json']);
  });

  it('round-trips through loadTowerConfig for the global and project files', async () => {
    const agentDir = join(root, 'agent');
    const cwd = join(root, 'repo');
    const projectFile = join(cwd, '.pi', 'tower.json');
    await updateTowerConfigModel({ path: file, key: 'orchestrator', ref: 'anthropic/claude-opus-4-5:xhigh' });
    await updateTowerConfigModel({ path: projectFile, key: 'worker', ref: 'openai/gpt-5.1-codex' });
    await updateTowerConfigModel({ path: projectFile, key: 'fast', ref: 'google/gemini-2.5-flash:low' });
    const config = await loadTowerConfig({ agentDir, cwd, env: {}, projectTrusted: true });
    expect(config.roles).toStrictEqual({
      orchestrator: {
        value: { provider: 'anthropic', modelId: 'claude-opus-4-5', thinkingLevel: 'xhigh' },
        source: { kind: 'file', scope: 'global', path: file },
      },
      worker: {
        value: { provider: 'openai', modelId: 'gpt-5.1-codex' },
        source: { kind: 'file', scope: 'project', path: projectFile },
      },
    });
    expect(config.models).toStrictEqual({
      fast: {
        value: { provider: 'google', modelId: 'gemini-2.5-flash', thinkingLevel: 'low' },
        source: { kind: 'file', scope: 'project', path: projectFile },
      },
    });
  });

  it('keeps every concurrent in-process update and leaves no temporary or lock files', async () => {
    await writeRaw(file, '{}');
    const aliases = Array.from({ length: 12 }, (_, index) => `alias${String(index)}`);
    await Promise.all([
      ...aliases.map((alias) => updateTowerConfigModel({ path: file, key: alias, ref: `provider/${alias}` })),
      updateTowerConfigModel({ path: file, key: 'worker', ref: 'openai/gpt-5.1' }),
      updateTowerConfigModel({ path: join(root, 'agent', '..', 'agent', 'tower.json'), key: 'reviewer', ref: 'google/gemini-2.5-pro' }),
    ]);
    const saved = (await readJson(file)) as { models: Record<string, string>; worker: string; reviewer: string };
    expect(Object.keys(saved.models).sort()).toEqual([...aliases].sort());
    expect(saved.models['alias7']).toBe('provider/alias7');
    expect(saved.worker).toBe('openai/gpt-5.1');
    expect(saved.reviewer).toBe('google/gemini-2.5-pro');
    expect(await readdir(dirname(file))).toEqual(['tower.json']);
  });

  it('keeps every update from concurrent processes', async () => {
    await writeRaw(file, '{}');
    const moduleUrl = new URL('../../src/config/index.ts', import.meta.url).href;
    const script = [
      `const { updateTowerConfigModel } = await import(${JSON.stringify(moduleUrl)});`,
      'const [path, prefix] = process.argv.slice(1);',
      'for (let index = 0; index < 5; index += 1) {',
      '  await updateTowerConfigModel({ path, key: `${prefix}${index}`, ref: `provider/${prefix}${index}` });',
      '}',
    ].join('\n');
    const prefixes = ['p0-', 'p1-', 'p2-', 'p3-'];
    await Promise.all(
      prefixes.map((prefix) =>
        execFileAsync(process.execPath, [
          '--experimental-strip-types',
          '--no-warnings',
          '--input-type=module',
          '-e',
          script,
          file,
          prefix,
        ]),
      ),
    );
    const saved = (await readJson(file)) as { models: Record<string, string> };
    const expected = prefixes.flatMap((prefix) => [0, 1, 2, 3, 4].map((index) => `${prefix}${String(index)}`));
    expect(Object.keys(saved.models).sort()).toEqual(expected.sort());
    expect(await readdir(dirname(file))).toEqual(['tower.json']);
  }, 30_000);

  it('recovers from a stale lock left behind by a crashed writer', async () => {
    await writeRaw(file, '{}');
    const lock = `${file}.lock`;
    await writeFile(lock, 'pid=999999 host=another-host since=2020-01-01T00:00:00.000Z token=crashed\n', 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    await updateTowerConfigModel({ path: file, key: 'worker', ref: 'openai/gpt-5.1' });
    expect(await readJson(file)).toStrictEqual({ worker: 'openai/gpt-5.1' });
    expect(await readdir(dirname(file))).toEqual(['tower.json']);
  });

  it('returns only own entries for prototype-named aliases', async () => {
    await writeRaw(file, '{"models":{"keep":"a/b"}}');
    for (const alias of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(await updateTowerConfigModel({ path: file, key: alias })).toStrictEqual({
        path: file,
        field: `models.${alias}`,
        changed: false,
      });
    }
    const set = await updateTowerConfigModel({ path: file, key: 'constructor', ref: 'openai/gpt-5.1' });
    expect(set).toStrictEqual({
      path: file,
      field: 'models.constructor',
      changed: true,
      value: { provider: 'openai', modelId: 'gpt-5.1' },
    });
    const saved = (await readJson(file)) as { models: Record<string, unknown> };
    expect(Object.entries(saved.models)).toEqual([
      ['keep', 'a/b'],
      ['constructor', 'openai/gpt-5.1'],
    ]);
  });

  it('writes through a symlinked config and keeps the file mode', async () => {
    const real = join(root, 'dotfiles', 'tower.json');
    await writeRaw(real, '{"worker":"openai/gpt-5.1"}');
    await chmod(real, 0o600);
    await mkdir(dirname(file), { recursive: true });
    await symlink(real, file);
    await updateTowerConfigModel({ path: file, key: 'reviewer', ref: 'google/gemini-2.5-pro' });
    expect((await lstat(file)).isSymbolicLink()).toBe(true);
    expect(await readJson(real)).toStrictEqual({ worker: 'openai/gpt-5.1', reviewer: 'google/gemini-2.5-pro' });
    expect((await stat(real)).mode & 0o777).toBe(0o600);
  });
});
