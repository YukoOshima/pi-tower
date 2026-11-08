import type { TowerModelRef, TowerRole, TowerThinkingLevel } from './types.ts';

export const TOWER_ROLES: readonly TowerRole[] = ['orchestrator', 'worker', 'reviewer'];

export const TOWER_THINKING_LEVELS: readonly TowerThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export const MODEL_REF_FORMAT = 'provider/modelId[:thinkingLevel]';

const MODEL_REF_EXAMPLE = 'anthropic/claude-sonnet-4-5:high';

export type TowerModelRefResult =
  | { readonly ok: true; readonly ref: TowerModelRef }
  | { readonly ok: false; readonly error: string };

export function isTowerRole(value: string): value is TowerRole {
  return (TOWER_ROLES as readonly string[]).includes(value);
}

export function isThinkingLevel(value: unknown): value is TowerThinkingLevel {
  return typeof value === 'string' && (TOWER_THINKING_LEVELS as readonly string[]).includes(value);
}

export function parseModelRef(text: string): TowerModelRefResult {
  const split = splitModelKey(text.trim());
  if (!split.ok) return split;
  const { provider, modelId } = split.ref;
  const colon = modelId.lastIndexOf(':');
  const suffix = modelId.slice(colon + 1);
  if (colon === -1 || !isThinkingLevel(suffix)) return split;
  if (colon === 0) return refError(text.trim(), 'has an empty model id');
  return { ok: true, ref: { provider, modelId: modelId.slice(0, colon), thinkingLevel: suffix } };
}

export function splitModelKey(text: string): TowerModelRefResult {
  if (text.length === 0) {
    return { ok: false, error: `empty model reference — expected ${MODEL_REF_FORMAT}` };
  }
  const slash = text.indexOf('/');
  if (slash === -1) return refError(text, 'has no provider');
  const provider = text.slice(0, slash);
  const modelId = text.slice(slash + 1);
  if (provider.length === 0) return refError(text, 'has an empty provider');
  if (/\s/.test(provider)) return refError(text, 'has whitespace in its provider');
  if (modelId.length === 0) return refError(text, 'has an empty model id');
  return { ok: true, ref: { provider, modelId } };
}

export function modelKey(ref: Pick<TowerModelRef, 'provider' | 'modelId'>): string {
  return `${ref.provider}/${ref.modelId}`;
}

export function formatModelRef(ref: TowerModelRef): string {
  return ref.thinkingLevel === undefined ? modelKey(ref) : `${modelKey(ref)}:${ref.thinkingLevel}`;
}

function refError(text: string, problem: string): TowerModelRefResult {
  return {
    ok: false,
    error: `"${text}" ${problem} — expected ${MODEL_REF_FORMAT} (e.g. ${MODEL_REF_EXAMPLE})`,
  };
}
