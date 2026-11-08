import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  formatModelRef,
  isThinkingLevel,
  isTowerRole,
  parseModelRef,
  splitModelKey,
  TOWER_THINKING_LEVELS,
} from '../../src/config/index.ts';
import type { TowerModelRefResult, TowerThinkingLevel } from '../../src/config/index.ts';

function ref(result: TowerModelRefResult) {
  if (!result.ok) throw new Error(`expected a model ref, got error: ${result.error}`);
  return result.ref;
}

function error(result: TowerModelRefResult): string {
  if (result.ok) throw new Error(`expected an error, got ${JSON.stringify(result.ref)}`);
  return result.error;
}

describe('parseModelRef', () => {
  it('splits provider and model id at the first slash', () => {
    expect(ref(parseModelRef('anthropic/claude-sonnet-4-5'))).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
    });
  });

  it('keeps slashes and non-level colons inside the model id', () => {
    expect(ref(parseModelRef('openrouter/qwen/qwen3-coder:exacto'))).toEqual({
      provider: 'openrouter',
      modelId: 'qwen/qwen3-coder:exacto',
    });
    expect(ref(parseModelRef('ollama/qwen2.5-coder:7b'))).toEqual({
      provider: 'ollama',
      modelId: 'qwen2.5-coder:7b',
    });
  });

  it('parses a trailing thinking level suffix', () => {
    expect(ref(parseModelRef('anthropic/claude-opus-4-5:xhigh'))).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-5',
      thinkingLevel: 'xhigh',
    });
    expect(ref(parseModelRef('openrouter/qwen/qwen3-coder:exacto:low'))).toEqual({
      provider: 'openrouter',
      modelId: 'qwen/qwen3-coder:exacto',
      thinkingLevel: 'low',
    });
  });

  it.each(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])(
    'accepts the %s thinking level',
    (level) => {
      expect(ref(parseModelRef(`openai/gpt-5.1:${level}`)).thinkingLevel).toBe(level);
    },
  );

  it('treats only exact lowercase level names as a suffix, like pi', () => {
    expect(ref(parseModelRef('openai/gpt-5.1:HIGH'))).toEqual({
      provider: 'openai',
      modelId: 'gpt-5.1:HIGH',
    });
    expect(ref(parseModelRef('openai/gpt-5.1:ultra')).modelId).toBe('gpt-5.1:ultra');
  });

  it('does not mistake a model id that is itself a level name for a suffix', () => {
    expect(ref(parseModelRef('custom/high'))).toEqual({ provider: 'custom', modelId: 'high' });
  });

  it('trims surrounding whitespace', () => {
    expect(ref(parseModelRef('  google/gemini-2.5-pro:low \n'))).toEqual({
      provider: 'google',
      modelId: 'gemini-2.5-pro',
      thinkingLevel: 'low',
    });
  });

  it('rejects references without a usable provider or model id', () => {
    expect(error(parseModelRef(''))).toBe(
      'empty model reference — expected provider/modelId[:thinkingLevel]',
    );
    expect(error(parseModelRef('sonnet'))).toBe(
      '"sonnet" has no provider — expected provider/modelId[:thinkingLevel] (e.g. anthropic/claude-sonnet-4-5:high)',
    );
    expect(error(parseModelRef('/claude'))).toContain('"/claude" has an empty provider');
    expect(error(parseModelRef('anthropic/'))).toContain('"anthropic/" has an empty model id');
    expect(error(parseModelRef('anthropic/:high'))).toContain('"anthropic/:high" has an empty model id');
    expect(error(parseModelRef('my provider/x'))).toContain('has whitespace in its provider');
  });
});

describe('splitModelKey', () => {
  it('never strips a thinking suffix', () => {
    expect(ref(splitModelKey('custom/model:high'))).toEqual({
      provider: 'custom',
      modelId: 'model:high',
    });
  });
});

describe('formatModelRef', () => {
  it('round-trips parsed references', () => {
    for (const text of [
      'anthropic/claude-sonnet-4-5',
      'anthropic/claude-opus-4-5:max',
      'openrouter/qwen/qwen3-coder:exacto',
      'openrouter/qwen/qwen3-coder:exacto:medium',
    ]) {
      expect(formatModelRef(ref(parseModelRef(text)))).toBe(text);
    }
  });
});

describe('guards', () => {
  it('recognizes thinking levels and roles', () => {
    expect(isThinkingLevel('xhigh')).toBe(true);
    expect(isThinkingLevel('ultra')).toBe(false);
    expect(isThinkingLevel(3)).toBe(false);
    expect(isTowerRole('reviewer')).toBe(true);
    expect(isTowerRole('primary')).toBe(false);
  });

  it('matches the thinking levels pi accepts', () => {
    expectTypeOf<TowerThinkingLevel>().toEqualTypeOf<ReturnType<ExtensionAPI['getThinkingLevel']>>();
    expect(TOWER_THINKING_LEVELS).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });
});
