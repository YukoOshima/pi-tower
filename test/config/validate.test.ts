import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { parseModelRef, resolveTowerModels, validateModelBindings } from '../../src/config/index.ts';
import type {
  TowerConfig,
  TowerConfigSource,
  TowerConfigValue,
  TowerModelProblem,
  TowerModelRegistry,
  TowerModelSpec,
} from '../../src/config/index.ts';

const GLOBAL: TowerConfigSource = { kind: 'file', scope: 'global', path: '/u/.pi/agent/tower.json' };
const SESSION = { model: 'anthropic/claude-sonnet-4-5', thinkingLevel: 'high' } as const;

interface FakeModel {
  readonly provider: string;
  readonly id: string;
}

function value(text: string, source: TowerConfigSource = GLOBAL): TowerConfigValue<TowerModelSpec> {
  const parsed = parseModelRef(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return { value: parsed.ref, source };
}

function config(partial: Partial<TowerConfig>): TowerConfig {
  return { roles: {}, models: {}, files: [], ...partial };
}

function registry(
  known: readonly string[],
  authenticated: readonly string[],
  lookups: string[] = [],
): TowerModelRegistry<FakeModel> {
  return {
    find(provider, modelId) {
      lookups.push(`${provider} | ${modelId}`);
      return known.includes(`${provider}/${modelId}`) ? { provider, id: modelId } : undefined;
    },
    hasConfiguredAuth(model) {
      return authenticated.includes(model.provider);
    },
  };
}

describe('validateModelBindings', () => {
  it('returns no problems when every configured model exists and has credentials', () => {
    const lookups: string[] = [];
    const models = resolveTowerModels(
      config({
        roles: { worker: value('openrouter/qwen/qwen3-coder:exacto'), reviewer: value('openai/gpt-5.1:high') },
        models: { fast: value('google/gemini-2.5-flash') },
      }),
      SESSION,
    );
    const known = ['openrouter/qwen/qwen3-coder:exacto', 'openai/gpt-5.1', 'google/gemini-2.5-flash'];
    expect(validateModelBindings(models, registry(known, ['openrouter', 'openai', 'google'], lookups))).toEqual(
      [],
    );
    expect(lookups).toEqual([
      'openrouter | qwen/qwen3-coder:exacto',
      'openai | gpt-5.1',
      'google | gemini-2.5-flash',
    ]);
  });

  it('reports unknown models and missing credentials per role and alias', () => {
    const models = resolveTowerModels(
      config({
        roles: {
          worker: value('openai/gpt-9', { kind: 'flag', flag: 'tower-worker-model' }),
          reviewer: value('anthropic/claude-opus-4-5', { kind: 'env', variable: 'PI_TOWER_REVIEWER_MODEL' }),
        },
        models: { fast: value('google/gemini-2.5-flash') },
      }),
      SESSION,
    );
    const problems = validateModelBindings(
      models,
      registry(['anthropic/claude-opus-4-5', 'google/gemini-2.5-flash'], ['anthropic']),
    );
    expect(problems).toStrictEqual<TowerModelProblem[]>([
      {
        target: 'worker',
        kind: 'not-found',
        model: 'openai/gpt-9',
        message:
          'worker: model "openai/gpt-9" (set by --tower-worker-model) is not in pi\'s model registry — check the provider/modelId (pi --list-models shows them)',
      },
      {
        target: 'models.fast',
        kind: 'no-auth',
        model: 'google/gemini-2.5-flash',
        message:
          'models.fast: model "google/gemini-2.5-flash" (set by /u/.pi/agent/tower.json (global)) has no configured credentials for provider "google" — run /login or set the provider\'s API key',
      },
    ]);
  });

  it('reports a broken orchestrator once and names the roles that fall back to it', () => {
    const both = resolveTowerModels(config({ roles: { orchestrator: value('anthropic/claude-opus-9') } }), SESSION);
    expect(validateModelBindings(both, registry([], [])).map((problem) => problem.message)).toEqual([
      'orchestrator: model "anthropic/claude-opus-9" (set by /u/.pi/agent/tower.json (global)) is not in pi\'s model registry — check the provider/modelId (pi --list-models shows them); worker and reviewer fall back to it',
    ]);
    const one = resolveTowerModels(
      config({ roles: { orchestrator: value('anthropic/claude-opus-9'), worker: value('openai/gpt-5.1') } }),
      SESSION,
    );
    const problems = validateModelBindings(one, registry(['openai/gpt-5.1'], ['openai']));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message.endsWith('; reviewer falls back to it')).toBe(true);
  });

  it('does not second-guess the live session model', () => {
    const models = resolveTowerModels(config({}), SESSION);
    expect(validateModelBindings(models, registry([], []))).toEqual([]);
  });

  it('reports an orchestrator that resolves to no model at all', () => {
    const models = resolveTowerModels(config({ roles: { reviewer: value('openai/gpt-5.1') } }), undefined);
    expect(validateModelBindings(models, registry(['openai/gpt-5.1'], ['openai']))).toStrictEqual([
      {
        target: 'orchestrator',
        kind: 'unresolved',
        message:
          'orchestrator: no model — none is configured and the session has no model; select a session model with /model or set "orchestrator" in tower.json, PI_TOWER_ORCHESTRATOR_MODEL or --tower-orchestrator-model; worker falls back to it',
      },
    ]);
  });

  it("accepts pi's ModelRegistry as the registry", () => {
    const models = resolveTowerModels(config({}), SESSION);
    const check = (piRegistry: ModelRegistry) => validateModelBindings(models, piRegistry);
    expectTypeOf(check).returns.toEqualTypeOf<TowerModelProblem[]>();
  });
});
