import { describe, expect, it } from 'vitest';

import { parseTowerConfig, TowerConfigError } from '../../src/config/index.ts';

const SOURCE = '/home/u/.pi/agent/tower.json (global)';

function configError(raw: unknown): TowerConfigError {
  try {
    parseTowerConfig(raw, SOURCE);
  } catch (error) {
    if (error instanceof TowerConfigError) return error;
    throw error;
  }
  throw new Error('expected parseTowerConfig to throw');
}

describe('parseTowerConfig', () => {
  it('normalizes string and object model specs', () => {
    expect(
      parseTowerConfig(
        {
          orchestrator: 'anthropic/claude-opus-4-5:xhigh',
          worker: { model: 'openai/gpt-5.1-codex', thinkingLevel: 'medium', description: ' Fast\n  implementer ' },
          reviewer: { model: 'anthropic/claude-sonnet-4-5:high' },
          models: {
            fast: { model: 'google/gemini-2.5-flash', description: 'Quick, cheap edits' },
            'deep.v2': 'anthropic/claude-opus-4-5:max',
            local_1: { model: 'ollama/qwen2.5-coder:7b', description: '' },
          },
          maxRunningAgents: 4,
          agentTimeoutMs: 7_200_000,
        },
        SOURCE,
      ),
    ).toStrictEqual({
      orchestrator: { provider: 'anthropic', modelId: 'claude-opus-4-5', thinkingLevel: 'xhigh' },
      worker: {
        provider: 'openai',
        modelId: 'gpt-5.1-codex',
        thinkingLevel: 'medium',
        description: 'Fast implementer',
      },
      reviewer: { provider: 'anthropic', modelId: 'claude-sonnet-4-5', thinkingLevel: 'high' },
      models: {
        fast: { provider: 'google', modelId: 'gemini-2.5-flash', description: 'Quick, cheap edits' },
        'deep.v2': { provider: 'anthropic', modelId: 'claude-opus-4-5', thinkingLevel: 'max' },
        local_1: { provider: 'ollama', modelId: 'qwen2.5-coder:7b' },
      },
      maxRunningAgents: 4,
      agentTimeoutMs: 7_200_000,
    });
  });

  it('accepts an empty object', () => {
    expect(parseTowerConfig({}, SOURCE)).toStrictEqual({});
  });

  it('rejects unknown top-level keys naming the file and key', () => {
    const error = configError({ orchestrater: 'anthropic/claude-opus-4-5' });
    expect(error.message).toBe(
      'Invalid tower config — /home/u/.pi/agent/tower.json (global): orchestrater: unknown key — allowed keys: orchestrator, worker, reviewer, validator, models, maxRunningAgents, agentTimeoutMs, objective',
    );
    expect(error.issues).toEqual([
      {
        source: SOURCE,
        key: 'orchestrater',
        message:
          'unknown key — allowed keys: orchestrator, worker, reviewer, validator, models, maxRunningAgents, agentTimeoutMs, objective',
      },
    ]);
  });

  it('rejects unknown keys inside a model spec', () => {
    expect(configError({ worker: { model: 'openai/gpt-5.1', thinking: 'high' } }).issues).toEqual([
      {
        source: SOURCE,
        key: 'worker.thinking',
        message: 'unknown key — allowed keys: model, thinkingLevel, description',
      },
    ]);
  });

  it('rejects a bad thinking level', () => {
    expect(configError({ reviewer: { model: 'openai/gpt-5.1', thinkingLevel: 'ultra' } }).message).toBe(
      'Invalid tower config — /home/u/.pi/agent/tower.json (global): reviewer.thinkingLevel: "ultra" is not a thinking level — use off, minimal, low, medium, high, xhigh, max',
    );
    expect(configError({ models: { fast: { model: 'a/b', thinkingLevel: 2 } } }).issues[0]?.key).toBe(
      'models.fast.thinkingLevel',
    );
  });

  it('rejects a thinking level given both as suffix and as thinkingLevel', () => {
    expect(configError({ worker: { model: 'openai/gpt-5.1:high', thinkingLevel: 'low' } }).issues).toEqual([
      {
        source: SOURCE,
        key: 'worker',
        message: 'thinking level set twice (":high" suffix on model and thinkingLevel "low") — keep one',
      },
    ]);
  });

  it('rejects malformed model references with the offending key', () => {
    expect(configError({ orchestrator: 'claude-opus' }).issues).toEqual([
      {
        source: SOURCE,
        key: 'orchestrator',
        message:
          '"claude-opus" has no provider — expected provider/modelId[:thinkingLevel] (e.g. anthropic/claude-sonnet-4-5:high)',
      },
    ]);
    expect(configError({ worker: { model: 'openai/' } }).issues[0]?.key).toBe('worker.model');
    expect(configError({ worker: { thinkingLevel: 'high' } }).issues).toEqual([
      { source: SOURCE, key: 'worker.model', message: 'required — "provider/modelId[:thinkingLevel]"' },
    ]);
    expect(configError({ worker: { model: 42 } }).issues[0]?.message).toBe(
      'expected a "provider/modelId[:thinkingLevel]" string, got 42',
    );
    expect(configError({ reviewer: null }).issues[0]?.message).toBe(
      'expected "provider/modelId[:thinkingLevel]" or { "model", "thinkingLevel"?, "description"? }, got null',
    );
    expect(configError({ worker: { model: 'a/b', description: 3 } }).issues[0]?.key).toBe(
      'worker.description',
    );
  });

  it.each(['primary', 'orchestrator', 'worker', 'reviewer', 'Primary', 'WORKER'])(
    'rejects the reserved pool alias %s',
    (alias) => {
      expect(configError({ models: { [alias]: 'openai/gpt-5.1' } }).issues).toEqual([
        {
          source: SOURCE,
          key: `models.${alias}`,
          message: `"${alias}" is reserved for the role models (primary, orchestrator, worker, reviewer, validator) — rename the alias`,
        },
      ]);
    },
  );

  it('accepts a validator model spec and reserves the validator alias', () => {
    expect(
      parseTowerConfig({ validator: { model: 'openai/gpt-5.1', thinkingLevel: 'high', description: 'QA' } }, SOURCE),
    ).toStrictEqual({
      validator: { provider: 'openai', modelId: 'gpt-5.1', thinkingLevel: 'high', description: 'QA' },
    });
    expect(configError({ validator: 'nope' }).issues[0]?.key).toBe('validator');
    expect(configError({ models: { Validator: 'a/b' } }).issues).toEqual([
      {
        source: SOURCE,
        key: 'models.Validator',
        message:
          '"Validator" is reserved for the role models (primary, orchestrator, worker, reviewer, validator) — rename the alias',
      },
    ]);
  });

  it.each(['', 'my alias', 'kimi/k3', 'a:b', '-fast', 'x'.repeat(65)])(
    'rejects the malformed pool alias %j',
    (alias) => {
      expect(configError({ models: { [alias]: 'openai/gpt-5.1' } }).issues[0]?.message).toMatch(
        /^invalid alias .* — use 1-64 letters, digits, "\.", "_" or "-", starting with a letter or digit$/,
      );
    },
  );

  it('rejects a models value that is not an object', () => {
    expect(configError({ models: ['openai/gpt-5.1'] }).issues[0]).toEqual({
      source: SOURCE,
      key: 'models',
      message:
        'expected an object mapping alias to "provider/modelId[:thinkingLevel]" or { "model", "thinkingLevel"?, "description"? }, got an array',
    });
  });

  it.each([
    [0, '0'],
    [-3, '-3'],
    [1.5, '1.5'],
    ['4', '"4"'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
  ])('rejects maxRunningAgents/agentTimeoutMs = %j', (value, shown) => {
    expect(configError({ maxRunningAgents: value, agentTimeoutMs: value }).issues).toEqual([
      { source: SOURCE, key: 'maxRunningAgents', message: `expected a positive integer, got ${shown}` },
      { source: SOURCE, key: 'agentTimeoutMs', message: `expected a positive integer, got ${shown}` },
    ]);
  });

  it("caps agentTimeoutMs at Node's timer limit", () => {
    expect(parseTowerConfig({ agentTimeoutMs: 2_147_483_647 }, SOURCE)).toStrictEqual({
      agentTimeoutMs: 2_147_483_647,
    });
    expect(configError({ agentTimeoutMs: 2_592_000_000 }).issues).toEqual([
      {
        source: SOURCE,
        key: 'agentTimeoutMs',
        message: "expected at most 2147483647 (Node's timer limit, about 24.8 days), got 2592000000",
      },
    ]);
    expect(parseTowerConfig({ maxRunningAgents: 2_592_000_000 }, SOURCE).maxRunningAgents).toBe(2_592_000_000);
  });

  it('rejects a root that is not an object', () => {
    for (const [raw, shown] of [
      [[], 'an array'],
      [null, 'null'],
      ['anthropic/x', '"anthropic/x"'],
    ] as const) {
      expect(configError(raw).issues).toEqual([
        { source: SOURCE, message: `expected a JSON object, got ${shown}` },
      ]);
    }
  });

  it('collects every problem into one error', () => {
    const error = configError({
      worker: 'nope',
      models: { primary: 'a/b', fast: { model: 'a/b', thinkingLevel: 'turbo' } },
      maxRunningAgents: 0,
    });
    expect(error.issues.map((issue) => issue.key)).toEqual([
      'worker',
      'models.primary',
      'models.fast.thinkingLevel',
      'maxRunningAgents',
    ]);
    expect(error.message.split('\n')).toEqual([
      'Invalid tower config:',
      `- ${SOURCE}: worker: "nope" has no provider — expected provider/modelId[:thinkingLevel] (e.g. anthropic/claude-sonnet-4-5:high)`,
      `- ${SOURCE}: models.primary: "primary" is reserved for the role models (primary, orchestrator, worker, reviewer, validator) — rename the alias`,
      `- ${SOURCE}: models.fast.thinkingLevel: "turbo" is not a thinking level — use off, minimal, low, medium, high, xhigh, max`,
      `- ${SOURCE}: maxRunningAgents: expected a positive integer, got 0`,
    ]);
    expect(error.name).toBe('TowerConfigError');
  });
});

describe('parseTowerConfig objective section', () => {
  const full = {
    autopilot: false,
    autoApprove: true,
    maxValidationRounds: 5,
    maxFeatureAttempts: 2,
    watchdogIntervalMs: 30_000,
    stallTimeoutMs: 600_000,
    maxStallWakes: 1,
    maxWallTimeMs: 14_400_000,
    maxCostUsd: 12.5,
    skipScrutiny: true,
    skipUserTesting: true,
    autoTeardown: true,
  };

  it('accepts every objective setting and an empty section', () => {
    expect(parseTowerConfig({ objective: full }, SOURCE)).toStrictEqual({ objective: full });
    expect(parseTowerConfig({ objective: {} }, SOURCE)).toStrictEqual({ objective: {} });
  });

  it('rejects unknown objective keys naming the allowed ones', () => {
    expect(configError({ objective: { autoPilot: true } }).issues).toEqual([
      {
        source: SOURCE,
        key: 'objective.autoPilot',
        message:
          'unknown key — allowed keys: autopilot, autoApprove, maxValidationRounds, maxFeatureAttempts, watchdogIntervalMs, stallTimeoutMs, maxStallWakes, maxWallTimeMs, maxCostUsd, skipScrutiny, skipUserTesting, autoTeardown',
      },
    ]);
  });

  it('rejects an objective value that is not an object', () => {
    for (const [raw, shown] of [
      [[], 'an array'],
      [null, 'null'],
      [true, 'true'],
    ] as const) {
      expect(configError({ objective: raw }).issues).toEqual([
        { source: SOURCE, key: 'objective', message: `expected an object of objective settings, got ${shown}` },
      ]);
    }
  });

  it('requires booleans for the switches', () => {
    expect(
      configError({ objective: { autopilot: 'yes', autoApprove: 1, skipScrutiny: null, skipUserTesting: {}, autoTeardown: [] } })
        .issues,
    ).toEqual([
      { source: SOURCE, key: 'objective.autopilot', message: 'expected true or false, got "yes"' },
      { source: SOURCE, key: 'objective.autoApprove', message: 'expected true or false, got 1' },
      { source: SOURCE, key: 'objective.skipScrutiny', message: 'expected true or false, got null' },
      { source: SOURCE, key: 'objective.skipUserTesting', message: 'expected true or false, got an object' },
      { source: SOURCE, key: 'objective.autoTeardown', message: 'expected true or false, got an array' },
    ]);
  });

  it.each([
    [0, '0'],
    [-1, '-1'],
    [2.5, '2.5'],
    ['3', '"3"'],
    [Number.NaN, 'NaN'],
  ])('rejects counts and milliseconds = %j', (value, shown) => {
    const keys = [
      'maxValidationRounds',
      'maxFeatureAttempts',
      'maxStallWakes',
      'watchdogIntervalMs',
      'stallTimeoutMs',
      'maxWallTimeMs',
    ];
    expect(configError({ objective: Object.fromEntries(keys.map((key) => [key, value])) }).issues).toEqual(
      keys.map((key) => ({
        source: SOURCE,
        key: `objective.${key}`,
        message: `expected a positive integer, got ${shown}`,
      })),
    );
  });

  it("caps the millisecond settings at Node's timer limit but not the counts", () => {
    const tooLong = 2_592_000_000;
    expect(
      configError({ objective: { watchdogIntervalMs: tooLong, stallTimeoutMs: tooLong, maxWallTimeMs: tooLong } }).issues.map(
        (issue) => [issue.key, issue.message],
      ),
    ).toEqual(
      ['watchdogIntervalMs', 'stallTimeoutMs', 'maxWallTimeMs'].map((key) => [
        `objective.${key}`,
        "expected at most 2147483647 (Node's timer limit, about 24.8 days), got 2592000000",
      ]),
    );
    expect(parseTowerConfig({ objective: { maxWallTimeMs: 2_147_483_647, maxValidationRounds: tooLong } }, SOURCE)).toStrictEqual({
      objective: { maxWallTimeMs: 2_147_483_647, maxValidationRounds: tooLong },
    });
  });

  it('requires a positive finite number for maxCostUsd', () => {
    expect(parseTowerConfig({ objective: { maxCostUsd: 0.25 } }, SOURCE)).toStrictEqual({
      objective: { maxCostUsd: 0.25 },
    });
    for (const [value, shown] of [
      [0, '0'],
      [-5, '-5'],
      ['10', '"10"'],
      [Number.POSITIVE_INFINITY, 'Infinity'],
      [null, 'null'],
    ] as const) {
      expect(configError({ objective: { maxCostUsd: value } }).issues).toEqual([
        { source: SOURCE, key: 'objective.maxCostUsd', message: `expected a positive number, got ${shown}` },
      ]);
    }
  });

  it('reports objective problems together with the rest of the file', () => {
    const error = configError({ worker: 'nope', objective: { maxCostUsd: -1, extra: 1 } });
    expect(error.issues.map((issue) => issue.key)).toEqual(['worker', 'objective.maxCostUsd', 'objective.extra']);
  });
});
