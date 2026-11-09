import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  parseModelRef,
  resolveSpawnModel,
  resolveTowerModels,
  spawnModelChoices,
  TowerSpawnModelError,
} from '../../src/config/index.ts';
import type {
  TowerConfig,
  TowerConfigSource,
  TowerConfigValue,
  TowerModelSpec,
  TowerPrimaryModel,
  TowerResolvedModels,
  TowerSpawnKind,
} from '../../src/config/index.ts';

const GLOBAL: TowerConfigSource = { kind: 'file', scope: 'global', path: '/u/.pi/agent/tower.json' };
const PROJECT: TowerConfigSource = { kind: 'file', scope: 'project', path: '/repo/.pi/tower.json' };
const SESSION = { provider: 'anthropic', modelId: 'claude-sonnet-4-5', thinkingLevel: 'high' } as const;

function value(
  text: string,
  source: TowerConfigSource = GLOBAL,
  description?: string,
): TowerConfigValue<TowerModelSpec> {
  const parsed = parseModelRef(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return { value: description === undefined ? parsed.ref : { ...parsed.ref, description }, source };
}

function config(partial: Partial<TowerConfig> = {}): TowerConfig {
  return { roles: {}, models: {}, files: [], ...partial };
}

function spawnError(
  models: TowerResolvedModels,
  kind: TowerSpawnKind,
  choice?: string,
): TowerSpawnModelError {
  try {
    resolveSpawnModel(models, kind, choice);
  } catch (error) {
    if (error instanceof TowerSpawnModelError) return error;
    throw error;
  }
  throw new Error('expected resolveSpawnModel to throw');
}

describe('resolveTowerModels', () => {
  it('uses the session model and level for every role when nothing is configured', () => {
    const models = resolveTowerModels(config(), SESSION);
    const binding = {
      model: 'anthropic/claude-sonnet-4-5',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      thinkingLevel: 'high',
    };
    expect(models.roles).toStrictEqual({
      orchestrator: { binding, origin: { kind: 'session' } },
      worker: { binding, origin: { kind: 'inherited', from: 'orchestrator' } },
      reviewer: { binding, origin: { kind: 'inherited', from: 'orchestrator' } },
      validator: { binding, origin: { kind: 'inherited', from: 'orchestrator' } },
    });
  });

  it('lets unset worker and reviewer inherit the configured orchestrator binding with its level', () => {
    const models = resolveTowerModels(
      config({ roles: { orchestrator: value('anthropic/claude-opus-4-5:xhigh') } }),
      { provider: 'openai', modelId: 'gpt-5.1', thinkingLevel: 'low' },
    );
    const binding = {
      model: 'anthropic/claude-opus-4-5',
      provider: 'anthropic',
      modelId: 'claude-opus-4-5',
      thinkingLevel: 'xhigh',
    };
    expect(models.roles.orchestrator).toStrictEqual({ binding, origin: GLOBAL });
    expect(models.roles.worker).toStrictEqual({ binding, origin: { kind: 'inherited', from: 'orchestrator' } });
    expect(models.roles.reviewer.binding).toStrictEqual(binding);
  });

  it('leaves the level undefined for a configured orchestrator without one, also for its dependents', () => {
    const models = resolveTowerModels(
      config({ roles: { orchestrator: value('anthropic/claude-opus-4-5') } }),
      SESSION,
    );
    expect(models.roles.orchestrator.binding).toStrictEqual({
      model: 'anthropic/claude-opus-4-5',
      provider: 'anthropic',
      modelId: 'claude-opus-4-5',
    });
    expect(models.roles.worker.binding?.thinkingLevel).toBeUndefined();
    expect(models.roles.reviewer.binding?.thinkingLevel).toBeUndefined();
  });

  it('keeps each configured role on its own model and explicit level only', () => {
    const models = resolveTowerModels(
      config({
        roles: {
          worker: value('openai/gpt-5.1-codex', PROJECT),
          reviewer: value('google/gemini-2.5-pro:medium', { kind: 'env', variable: 'PI_TOWER_REVIEWER_MODEL' }),
        },
      }),
      SESSION,
    );
    expect(models.roles.orchestrator.origin).toStrictEqual({ kind: 'session' });
    expect(models.roles.worker).toStrictEqual({
      binding: { model: 'openai/gpt-5.1-codex', provider: 'openai', modelId: 'gpt-5.1-codex' },
      origin: PROJECT,
    });
    expect(models.roles.reviewer).toStrictEqual({
      binding: {
        model: 'google/gemini-2.5-pro',
        provider: 'google',
        modelId: 'gemini-2.5-pro',
        thinkingLevel: 'medium',
      },
      origin: { kind: 'env', variable: 'PI_TOWER_REVIEWER_MODEL' },
    });
  });

  it('resolves no binding when the session has no model and no orchestrator is configured', () => {
    const models = resolveTowerModels(config({ roles: { reviewer: value('openai/gpt-5.1') } }), undefined);
    expect(models.roles.orchestrator).toStrictEqual({ origin: { kind: 'session' } });
    expect(models.roles.worker).toStrictEqual({ origin: { kind: 'inherited', from: 'orchestrator' } });
    expect(models.roles.reviewer.binding?.model).toBe('openai/gpt-5.1');
  });

  it('lets an unset validator inherit the configured reviewer, and the orchestrator when no reviewer is configured', () => {
    const withReviewer = resolveTowerModels(
      config({
        roles: {
          orchestrator: value('anthropic/claude-opus-4-5'),
          reviewer: value('openai/gpt-5.1:high', PROJECT, 'Strict reviewer'),
        },
      }),
      SESSION,
    );
    expect(withReviewer.roles.validator).toStrictEqual({
      binding: { model: 'openai/gpt-5.1', provider: 'openai', modelId: 'gpt-5.1', thinkingLevel: 'high' },
      origin: { kind: 'inherited', from: 'reviewer' },
    });
    const withoutReviewer = resolveTowerModels(
      config({ roles: { orchestrator: value('anthropic/claude-opus-4-5') } }),
      SESSION,
    );
    expect(withoutReviewer.roles.validator).toStrictEqual({
      binding: { model: 'anthropic/claude-opus-4-5', provider: 'anthropic', modelId: 'claude-opus-4-5' },
      origin: { kind: 'inherited', from: 'orchestrator' },
    });
    expect(resolveTowerModels(config(), SESSION).roles.validator.origin).toStrictEqual({
      kind: 'inherited',
      from: 'orchestrator',
    });
    expect(resolveTowerModels(config(), undefined).roles.validator).toStrictEqual({
      origin: { kind: 'inherited', from: 'orchestrator' },
    });
  });

  it('keeps a configured validator on its own model whatever the reviewer is', () => {
    const flag: TowerConfigSource = { kind: 'flag', flag: 'tower-validator-model' };
    const models = resolveTowerModels(
      config({ roles: { reviewer: value('openai/gpt-5.1'), validator: value('google/gemini-2.5-pro:low', flag) } }),
      SESSION,
    );
    expect(models.roles.validator).toStrictEqual({
      binding: { model: 'google/gemini-2.5-pro', provider: 'google', modelId: 'gemini-2.5-pro', thinkingLevel: 'low' },
      origin: flag,
    });
    expect(models.roles.reviewer.binding?.model).toBe('openai/gpt-5.1');
  });

  it('takes the session provider and model id verbatim, without splitting or suffix parsing', () => {
    const models = resolveTowerModels(config(), {
      provider: 'openrouter',
      modelId: 'qwen/qwen3-coder:high',
    });
    expect(models.roles.orchestrator.binding).toStrictEqual({
      model: 'openrouter/qwen/qwen3-coder:high',
      provider: 'openrouter',
      modelId: 'qwen/qwen3-coder:high',
    });
  });

  it('keeps a session provider id that itself contains a slash', () => {
    const models = resolveTowerModels(config(), {
      provider: 'my/proxy',
      modelId: 'model-x',
      thinkingLevel: 'medium',
    });
    const binding = { model: 'my/proxy/model-x', provider: 'my/proxy', modelId: 'model-x', thinkingLevel: 'medium' };
    expect(models.roles.orchestrator).toStrictEqual({ binding, origin: { kind: 'session' } });
    expect(models.roles.worker.binding).toStrictEqual(binding);
    expect(models.roles.reviewer.binding).toStrictEqual(binding);
    expect(resolveSpawnModel(models, 'reviewer').binding).toStrictEqual(binding);
    expect(resolveSpawnModel(models, 'worker', 'primary').binding.provider).toBe('my/proxy');
  });

  it("maps pi's live model and thinking level onto the session input field by field", () => {
    const fromPi = (
      model: NonNullable<ExtensionContext['model']>,
      thinkingLevel: ReturnType<ExtensionAPI['getThinkingLevel']>,
    ): TowerPrimaryModel => ({ provider: model.provider, modelId: model.id, thinkingLevel });
    expectTypeOf(fromPi).returns.toEqualTypeOf<TowerPrimaryModel>();
  });

  it('resolves pool aliases and keeps descriptions only on configured entries', () => {
    const models = resolveTowerModels(
      config({
        roles: { orchestrator: value('anthropic/claude-opus-4-5', GLOBAL, 'Planner') },
        models: { fast: value('google/gemini-2.5-flash', PROJECT, 'Quick edits') },
      }),
      SESSION,
    );
    expect(models.roles.orchestrator.description).toBe('Planner');
    expect(models.roles.worker.description).toBeUndefined();
    expect(models.pool).toStrictEqual({
      fast: {
        binding: { model: 'google/gemini-2.5-flash', provider: 'google', modelId: 'gemini-2.5-flash' },
        origin: PROJECT,
        description: 'Quick edits',
      },
    });
  });
});

describe('resolveSpawnModel', () => {
  const models = resolveTowerModels(
    config({
      roles: {
        worker: value('openai/gpt-5.1-codex:medium'),
        reviewer: value('google/gemini-2.5-pro'),
      },
      models: {
        fast: value('google/gemini-2.5-flash'),
        deep: value('anthropic/claude-opus-4-5:max', PROJECT),
      },
    }),
    SESSION,
  );

  it('defaults to the role model of the spawned kind', () => {
    expect(resolveSpawnModel(models, 'worker')).toStrictEqual({
      choice: 'worker',
      binding: {
        model: 'openai/gpt-5.1-codex',
        provider: 'openai',
        modelId: 'gpt-5.1-codex',
        thinkingLevel: 'medium',
      },
      origin: GLOBAL,
    });
    expect(resolveSpawnModel(models, 'reviewer').choice).toBe('reviewer');
    expect(resolveSpawnModel(models, 'reviewer').binding.model).toBe('google/gemini-2.5-pro');
    expect(resolveSpawnModel(models, 'worker', '  ').choice).toBe('worker');
  });

  it('accepts orchestrator and its primary alias as the effective orchestrator binding', () => {
    for (const choice of ['orchestrator', 'primary', ' primary ']) {
      expect(resolveSpawnModel(models, 'reviewer', choice)).toStrictEqual({
        choice: 'orchestrator',
        binding: {
          model: 'anthropic/claude-sonnet-4-5',
          provider: 'anthropic',
          modelId: 'claude-sonnet-4-5',
          thinkingLevel: 'high',
        },
        origin: { kind: 'session' },
      });
    }
  });

  it('accepts the other role and pool aliases', () => {
    expect(resolveSpawnModel(models, 'worker', 'reviewer').binding.model).toBe('google/gemini-2.5-pro');
    expect(resolveSpawnModel(models, 'reviewer', 'worker').binding.model).toBe('openai/gpt-5.1-codex');
    expect(resolveSpawnModel(models, 'worker', 'deep')).toStrictEqual({
      choice: 'deep',
      binding: {
        model: 'anthropic/claude-opus-4-5',
        provider: 'anthropic',
        modelId: 'claude-opus-4-5',
        thinkingLevel: 'max',
      },
      origin: PROJECT,
    });
  });

  it('rejects anything else with every allowed choice listed', () => {
    const error = spawnError(models, 'worker', 'anthropic/claude-opus-4-5');
    expect(error.message).toBe(
      'Invalid model "anthropic/claude-opus-4-5" — available models: orchestrator, primary, worker, reviewer, validator, fast, deep (primary is an alias of orchestrator). Omit model to use the worker default; other provider/model ids are not accepted — add them to "models" in tower.json first.',
    );
    expect(error.choice).toBe('anthropic/claude-opus-4-5');
    expect(error.allowed).toEqual(['orchestrator', 'primary', 'worker', 'reviewer', 'validator', 'fast', 'deep']);
    expect(spawnError(models, 'reviewer', 'Primary').message).toContain('use the reviewer default');
    expect(spawnError(models, 'worker', 'constructor').choice).toBe('constructor');
    expect(spawnError(models, 'worker', 'toString').name).toBe('TowerSpawnModelError');
  });

  it('explains how to fix a spawn without any resolvable model', () => {
    const empty = resolveTowerModels(config(), undefined);
    expect(spawnError(empty, 'worker').message).toBe(
      'No model for "worker" — it falls back to the orchestrator, but no orchestrator is configured and the session has no model; select a session model with /model or set "worker" or "orchestrator" in tower.json, PI_TOWER_WORKER_MODEL or --tower-worker-model',
    );
    expect(spawnError(empty, 'worker', 'primary').message).toBe(
      'No model for "orchestrator" — none is configured and the session has no model; select a session model with /model or set "orchestrator" in tower.json, PI_TOWER_ORCHESTRATOR_MODEL or --tower-orchestrator-model',
    );
  });

  it('defaults a validator spawn to the validator role and explains its fallback chain', () => {
    expect(resolveSpawnModel(models, 'validator')).toStrictEqual({
      choice: 'validator',
      binding: { model: 'google/gemini-2.5-pro', provider: 'google', modelId: 'gemini-2.5-pro' },
      origin: { kind: 'inherited', from: 'reviewer' },
    });
    expect(resolveSpawnModel(models, 'worker', 'validator').choice).toBe('validator');
    expect(spawnError(models, 'validator', 'gpt-9').message).toContain('use the validator default');
    expect(spawnError(resolveTowerModels(config(), undefined), 'validator').message).toBe(
      'No model for "validator" — it falls back to the reviewer and then the orchestrator, but neither is configured and the session has no model; select a session model with /model or set "validator", "reviewer" or "orchestrator" in tower.json, PI_TOWER_VALIDATOR_MODEL or --tower-validator-model',
    );
  });

  it('lists the spawn choices in a stable order', () => {
    expect(spawnModelChoices(models)).toEqual([
      'orchestrator',
      'primary',
      'worker',
      'reviewer',
      'validator',
      'fast',
      'deep',
    ]);
  });
});
