import { describe, expect, it } from 'vitest';

import {
  describeSpawnModels,
  describeThinking,
  formatConfigSource,
  formatModelOrigin,
  formatModelTable,
  formatObjectiveSettings,
  parseModelRef,
  resolveObjectiveSettings,
  resolveTowerModels,
} from '../../src/config/index.ts';
import type {
  TowerConfig,
  TowerConfigSource,
  TowerConfigValue,
  TowerModelSpec,
} from '../../src/config/index.ts';

const GLOBAL_PATH = '/u/.pi/agent/tower.json';
const PROJECT_PATH = '/repo/.pi/tower.json';
const GLOBAL: TowerConfigSource = { kind: 'file', scope: 'global', path: GLOBAL_PATH };
const PROJECT: TowerConfigSource = { kind: 'file', scope: 'project', path: PROJECT_PATH };
const SESSION = { provider: 'anthropic', modelId: 'claude-sonnet-4-5', thinkingLevel: 'high' } as const;

function value(
  text: string,
  source: TowerConfigSource,
  description?: string,
): TowerConfigValue<TowerModelSpec> {
  const parsed = parseModelRef(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return { value: description === undefined ? parsed.ref : { ...parsed.ref, description }, source };
}

const configured: TowerConfig = {
  roles: {
    orchestrator: value('anthropic/claude-opus-4-5:xhigh', GLOBAL),
    worker: value('openai/gpt-5.1-codex', { kind: 'flag', flag: 'tower-worker-model' }),
  },
  models: {
    fast: value('google/gemini-2.5-flash', GLOBAL, 'Quick, cheap edits'),
    deep: value('anthropic/claude-opus-4-5:max', PROJECT),
  },
  files: [
    { scope: 'global', path: GLOBAL_PATH, status: 'loaded' },
    { scope: 'project', path: PROJECT_PATH, status: 'loaded' },
  ],
};

function row(widths: readonly number[], ...cells: string[]): string {
  return cells.map((cell, index) => (index < widths.length ? cell.padEnd(widths[index]!) : cell)).join('');
}

describe('describeSpawnModels', () => {
  it('lists every choice with its model and marks the worker and reviewer defaults', () => {
    expect(describeSpawnModels(resolveTowerModels(configured, SESSION))).toBe(
      [
        'Available models (pass via model):',
        '- orchestrator (alias primary): anthropic/claude-opus-4-5, thinking xhigh',
        '- worker [worker default]: openai/gpt-5.1-codex, pi default thinking',
        '- reviewer [reviewer default]: anthropic/claude-opus-4-5, thinking xhigh',
        '- validator [validator default]: anthropic/claude-opus-4-5, thinking xhigh',
        '- fast: google/gemini-2.5-flash, pi default thinking — Quick, cheap edits',
        '- deep: anthropic/claude-opus-4-5, thinking max',
      ].join('\n'),
    );
  });

  it('shows the session model when nothing is configured and flags a missing model', () => {
    const empty: TowerConfig = { roles: {}, models: {}, files: [] };
    expect(describeSpawnModels(resolveTowerModels(empty, SESSION))).toBe(
      [
        'Available models (pass via model):',
        '- orchestrator (alias primary): anthropic/claude-sonnet-4-5, thinking high',
        '- worker [worker default]: anthropic/claude-sonnet-4-5, thinking high',
        '- reviewer [reviewer default]: anthropic/claude-sonnet-4-5, thinking high',
        '- validator [validator default]: anthropic/claude-sonnet-4-5, thinking high',
      ].join('\n'),
    );
    expect(describeSpawnModels(resolveTowerModels(empty, undefined)).split('\n')[2]).toBe(
      '- worker [worker default]: no model resolved',
    );
  });
});

describe('formatModelTable', () => {
  it('shows model, effective thinking level with its origin, and the source of every role and alias', () => {
    const widths = [14, 27, 37];
    expect(formatModelTable(resolveTowerModels(configured, SESSION))).toBe(
      [
        row(widths, 'role', 'model', 'thinking', 'source'),
        row(widths, 'orchestrator', 'anthropic/claude-opus-4-5', 'xhigh (configured)', `${GLOBAL_PATH} (global)`),
        row(widths, 'worker', 'openai/gpt-5.1-codex', 'pi default', '--tower-worker-model'),
        row(
          widths,
          'reviewer',
          'anthropic/claude-opus-4-5',
          'xhigh (inherited from orchestrator)',
          'inherited from orchestrator',
        ),
        row(
          widths,
          'validator',
          'anthropic/claude-opus-4-5',
          'xhigh (inherited from orchestrator)',
          'inherited from orchestrator',
        ),
        row(widths, 'models.fast', 'google/gemini-2.5-flash', 'pi default', `${GLOBAL_PATH} (global)`),
        row(widths, 'models.deep', 'anthropic/claude-opus-4-5', 'max (configured)', `${PROJECT_PATH} (project)`),
        '',
        `global config: ${GLOBAL_PATH} (loaded)`,
        `project config: ${PROJECT_PATH} (loaded)`,
      ].join('\n'),
    );
  });

  it('labels session levels and explains missing or untrusted config files', () => {
    const widths = [14, 29, 36];
    const models = resolveTowerModels(
      {
        roles: {},
        models: {},
        files: [
          { scope: 'global', path: GLOBAL_PATH, status: 'missing' },
          { scope: 'project', path: PROJECT_PATH, status: 'untrusted' },
        ],
      },
      SESSION,
    );
    expect(formatModelTable(models)).toBe(
      [
        row(widths, 'role', 'model', 'thinking', 'source'),
        row(widths, 'orchestrator', 'anthropic/claude-sonnet-4-5', 'high (session)', 'session model'),
        row(
          widths,
          'worker',
          'anthropic/claude-sonnet-4-5',
          'high (inherited from orchestrator)',
          'inherited from orchestrator',
        ),
        row(
          widths,
          'reviewer',
          'anthropic/claude-sonnet-4-5',
          'high (inherited from orchestrator)',
          'inherited from orchestrator',
        ),
        row(
          widths,
          'validator',
          'anthropic/claude-sonnet-4-5',
          'high (inherited from orchestrator)',
          'inherited from orchestrator',
        ),
        '',
        `global config: ${GLOBAL_PATH} (not found)`,
        `project config: ${PROJECT_PATH} (ignored — project not trusted)`,
      ].join('\n'),
    );
  });

  it('renders unresolved roles and omits the file footer when there are no files', () => {
    const lines = formatModelTable(
      resolveTowerModels({ roles: {}, models: {}, files: [] }, undefined),
    ).split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[1]?.split(/\s{2,}/)).toEqual(['orchestrator', '(none)', '-', 'session model']);
    expect(lines[2]?.split(/\s{2,}/)).toEqual(['worker', '(none)', '-', 'inherited from orchestrator']);
    expect(lines.every((line) => line === line.trimEnd())).toBe(true);
  });
});

describe('formatObjectiveSettings', () => {
  it('renders every objective setting with its value and source', () => {
    const settings = resolveObjectiveSettings({
      ...configured,
      objective: [
        { value: { autoApprove: true, maxCostUsd: 12.5 }, source: PROJECT },
        { value: { maxValidationRounds: 5, maxWallTimeMs: 14_400_000, autoApprove: false }, source: GLOBAL },
      ],
    });
    const widths = [21, 10];
    expect(formatObjectiveSettings(settings)).toBe(
      [
        row(widths, 'objective', 'value', 'source'),
        row(widths, 'autopilot', 'true', 'default'),
        row(widths, 'autoApprove', 'true', `${PROJECT_PATH} (project)`),
        row(widths, 'maxValidationRounds', '5', `${GLOBAL_PATH} (global)`),
        row(widths, 'maxFeatureAttempts', '3', 'default'),
        row(widths, 'watchdogIntervalMs', '60000', 'default'),
        row(widths, 'stallTimeoutMs', '180000', 'default'),
        row(widths, 'maxStallWakes', '3', 'default'),
        row(widths, 'maxWallTimeMs', '14400000', `${GLOBAL_PATH} (global)`),
        row(widths, 'maxCostUsd', '12.5', `${PROJECT_PATH} (project)`),
        row(widths, 'skipScrutiny', 'false', 'default'),
        row(widths, 'skipUserTesting', 'false', 'default'),
        row(widths, 'autoTeardown', 'true', 'default'),
      ].join('\n'),
    );
  });

  it('marks unset limits and leaves no trailing whitespace', () => {
    const lines = formatObjectiveSettings(resolveObjectiveSettings({ roles: {}, models: {}, files: [] })).split('\n');
    expect(lines).toHaveLength(13);
    expect(lines[8]?.split(/\s{2,}/)).toEqual(['maxWallTimeMs', 'unset', 'default']);
    expect(lines[9]?.split(/\s{2,}/)).toEqual(['maxCostUsd', 'unset', 'default']);
    expect(lines.every((line) => line === line.trimEnd())).toBe(true);
  });
});

describe('source labels', () => {
  it('formats config sources and model origins', () => {
    expect(formatConfigSource({ kind: 'flag', flag: 'tower-reviewer-model' })).toBe('--tower-reviewer-model');
    expect(formatConfigSource({ kind: 'env', variable: 'PI_TOWER_WORKER_MODEL' })).toBe(
      'env PI_TOWER_WORKER_MODEL',
    );
    expect(formatConfigSource(PROJECT)).toBe(`${PROJECT_PATH} (project)`);
    expect(formatModelOrigin({ kind: 'session' })).toBe('session model');
    expect(formatModelOrigin({ kind: 'inherited', from: 'orchestrator' })).toBe('inherited from orchestrator');
    expect(formatModelOrigin(GLOBAL)).toBe(`${GLOBAL_PATH} (global)`);
  });

  it('describes the effective thinking level and where it came from', () => {
    const models = resolveTowerModels(
      { roles: { reviewer: value('openai/gpt-5.1:low', GLOBAL) }, models: {}, files: [] },
      SESSION,
    );
    expect(describeThinking(models.roles.orchestrator)).toBe('high (session)');
    expect(describeThinking(models.roles.worker)).toBe('high (inherited from orchestrator)');
    expect(describeThinking(models.roles.reviewer)).toBe('low (configured)');
    const levelless = resolveTowerModels(
      { roles: {}, models: {}, files: [] },
      { provider: 'a', modelId: 'b' },
    );
    expect(describeThinking(levelless.roles.worker)).toBe('pi default');
    expect(describeThinking({ origin: { kind: 'session' } })).toBe('-');
  });

  it('labels a validator that inherits the reviewer', () => {
    const models = resolveTowerModels(
      { roles: { reviewer: value('openai/gpt-5.1:low', GLOBAL) }, models: {}, files: [] },
      SESSION,
    );
    expect(describeThinking(models.roles.validator)).toBe('low (inherited from reviewer)');
    expect(formatModelOrigin({ kind: 'inherited', from: 'reviewer' })).toBe('inherited from reviewer');
    expect(formatModelTable(models).split('\n')[4]?.split(/\s{2,}/)).toEqual([
      'validator',
      'openai/gpt-5.1',
      'low (inherited from reviewer)',
      'inherited from reviewer',
    ]);
  });
});
