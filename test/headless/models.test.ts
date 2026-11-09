import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseArgs } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';

import { formatModelTable, resolveTowerModels } from '../../src/config/index.ts';
import { parseHeadlessArgs, piRunArgs } from '../../src/headless/args.ts';
import { towerModelLines } from '../../src/headless/models.ts';
import { TowerModels } from '../../src/tower/models.ts';
import { MODEL_LINES, MODELS_REPLY } from './stubs.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function agentDir(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-tower-headless-models-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'tower.json'), JSON.stringify(config));
  return dir;
}

async function towerModelsReply(argv: readonly string[], config: Record<string, unknown>, registry?: Parameters<TowerModels['describe']>[1]): Promise<string> {
  const dir = agentDir(config);
  const parsed = parseHeadlessArgs(argv, dir);
  if (parsed.kind !== 'run') throw new Error(`expected a run, got ${parsed.kind}`);
  const pi = parseArgs(['--mode', 'rpc', ...piRunArgs(parsed.options)]);
  const models = new TowerModels({ agentDir: dir, configDirName: '.pi', env: {}, getFlag: (name) => pi.unknownFlags.get(name) });
  await models.load({ cwd: dir, projectTrusted: false });
  return `Tower models\n${models.describe({ provider: 'fake', modelId: 'session-model' }, registry)}`;
}

describe('towerModelLines', () => {
  it('describes every role with its effective model, thinking level and source from the /tower models table', () => {
    expect(towerModelLines(MODELS_REPLY)).toEqual(MODEL_LINES);
  });

  it('leaves out a "-" cell and keeps a "(none)" model', () => {
    const table = formatModelTable(resolveTowerModels({ roles: {}, models: {}, files: [] }, undefined));
    expect(towerModelLines(`Tower models\n${table}`)).toEqual([
      'orchestrator model: (none) · source: session model',
      'worker model: (none) · source: inherited from orchestrator',
      'reviewer model: (none) · source: inherited from orchestrator',
      'validator model: (none) · source: inherited from orchestrator',
    ]);
  });

  it('keeps a source that contains two spaces in one piece', () => {
    const reply = MODELS_REPLY.replaceAll('/home/user/.pi/agent/tower.json', '/home/a  b/tower.json');
    expect(towerModelLines(reply)?.[0]).toBe('orchestrator model: anthropic/claude-opus-4-5 · thinking: high (configured) · source: /home/a  b/tower.json (global)');
  });

  it('finds no lines without a model table or when a role row is missing', () => {
    expect(towerModelLines('Tower models\nThe tower model configuration could not be loaded:\n/x/tower.json: Unexpected token')).toBeUndefined();
    expect(towerModelLines('Tower models\nThe tower model configuration is not loaded yet.')).toBeUndefined();
    expect(towerModelLines('')).toBeUndefined();
    const withoutValidator = MODELS_REPLY.split('\n')
      .filter((line) => !line.startsWith('validator '))
      .join('\n');
    expect(towerModelLines(withoutValidator)).toBeUndefined();
    expect(towerModelLines('role          model\norchestrator\nworker        a/b\nreviewer      a/b\nvalidator     a/b')).toBeUndefined();
  });
});

describe('role models from pi-tower flags to the role lines (pi parseArgs and the extension model loading)', () => {
  it('shows the flags given to pi-tower as the effective role models, with the configured roles beside them', async () => {
    const reply = await towerModelsReply(
      ['exec', '--mission', '-f', 'g.md', '--worker-model', 'openai/gpt-5.1-codex', '--validator-model=google/gemini-2.5-pro:medium'],
      { orchestrator: 'anthropic/claude-opus-4-5:high', reviewer: 'openai/gpt-5.1:low' },
    );
    const config = join(dirs[0] ?? '', 'tower.json');
    expect(towerModelLines(reply)).toEqual([
      `orchestrator model: anthropic/claude-opus-4-5 · thinking: high (configured) · source: ${config} (global)`,
      'worker model: openai/gpt-5.1-codex · thinking: pi default · source: --tower-worker-model',
      `reviewer model: openai/gpt-5.1 · thinking: low (configured) · source: ${config} (global)`,
      'validator model: google/gemini-2.5-pro · thinking: medium (configured) · source: --tower-validator-model',
    ]);
  });

  it('lets a pi-tower model flag win over the same --tower-<role>-model after --, which still applies to the other roles', async () => {
    const reply = await towerModelsReply(
      ['run', '-f', 'g.md', '--worker-model', 'openai/gpt-5.1-codex', '--', '--tower-worker-model', 'openai/gpt-4.1', '--tower-reviewer-model=openai/o3'],
      {},
    );
    expect(towerModelLines(reply)?.slice(1, 3)).toEqual([
      'worker model: openai/gpt-5.1-codex · thinking: pi default · source: --tower-worker-model',
      'reviewer model: openai/o3 · thinking: pi default · source: --tower-reviewer-model',
    ]);
  });

  it('still applies the model flags when the extra pi args contain a bare --', async () => {
    const reply = await towerModelsReply(['run', '-f', 'g.md', '--orchestrator-model', 'anthropic/claude-opus-4-5', '--', '--', 'ignored message'], {});
    expect(towerModelLines(reply)?.[0]).toBe('orchestrator model: anthropic/claude-opus-4-5 · thinking: pi default · source: --tower-orchestrator-model');
  });

  it('reads the table of a reply that also lists model problems', async () => {
    const reply = await towerModelsReply(['run', '-f', 'g.md', '--reviewer-model', 'nowhere/missing-model'], {}, {
      find: (provider) => (provider === 'nowhere' ? undefined : {}),
      hasConfiguredAuth: () => true,
    });
    expect(reply).toContain('\nProblems:\n');
    expect(towerModelLines(reply)).toEqual([
      'orchestrator model: fake/session-model · thinking: pi default · source: session model',
      'worker model: fake/session-model · thinking: pi default · source: inherited from orchestrator',
      'reviewer model: nowhere/missing-model · thinking: pi default · source: --tower-reviewer-model',
      'validator model: nowhere/missing-model · thinking: pi default · source: inherited from reviewer',
    ]);
  });
});
