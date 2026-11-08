import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import { isMissingFileError, readConfigJson, writeConfigJsonAtomic } from './jsonFile.ts';
import { formatModelRef, isTowerRole, modelKey, parseModelRef } from './modelRef.ts';
import { PRIMARY_MODEL_CHOICE } from './resolve.ts';
import { isPlainObject, modelAliasProblem, parseTowerConfig, TowerConfigError } from './schema.ts';
import type { TowerModelRef, TowerModelSpec } from './types.ts';

const POOL_FIELD_PREFIX = 'models.';

export interface TowerConfigModelUpdate {
  readonly path: string;
  readonly key: string;
  readonly ref?: string;
}

export interface TowerConfigModelUpdateResult {
  readonly path: string;
  readonly field: string;
  readonly changed: boolean;
  readonly value?: TowerModelSpec;
}

export async function updateTowerConfigModel(
  update: TowerConfigModelUpdate,
): Promise<TowerConfigModelUpdateResult> {
  const requested = update.key.trim();
  const pooled = requested.startsWith(POOL_FIELD_PREFIX);
  const key = pooled
    ? requested.slice(POOL_FIELD_PREFIX.length)
    : requested === PRIMARY_MODEL_CHOICE
      ? 'orchestrator'
      : requested;
  const role = !pooled && isTowerRole(key) ? key : undefined;
  const field = role ?? `${POOL_FIELD_PREFIX}${key}`;
  const source = update.path;
  if (role === undefined) {
    const problem = modelAliasProblem(key);
    if (problem !== undefined) throw configError(source, field, problem);
  }
  let ref: TowerModelRef | undefined;
  if (update.ref !== undefined) {
    const parsed = parseModelRef(update.ref);
    if (!parsed.ok) throw configError(source, field, parsed.error);
    ref = parsed.ref;
  }

  const target = await writeTarget(update.path);
  const current = (await readConfigJson(target, source)).value;
  if (!isPlainObject(current)) {
    throw configError(source, undefined, 'expected a JSON object — fix the file by hand first');
  }
  const next: Record<string, unknown> = { ...current };
  if (role !== undefined) {
    applyEntry(next, role, ref);
  } else {
    const pool = next['models'];
    if (pool !== undefined && !isPlainObject(pool)) {
      throw configError(
        source,
        'models',
        'expected an object mapping alias to model spec — fix the file by hand first',
      );
    }
    const models: Record<string, unknown> = { ...pool };
    applyEntry(models, key, ref);
    if (Object.keys(models).length === 0) delete next['models'];
    else next['models'] = models;
  }

  const config = parseTowerConfig(next, source);
  const value = role !== undefined ? config[role] : config.models?.[key];
  const changed = JSON.stringify(next) !== JSON.stringify(current);
  if (changed) await writeConfigJsonAtomic(target, next);
  return { path: update.path, field, changed, ...(value === undefined ? {} : { value }) };
}

function applyEntry(
  container: Record<string, unknown>,
  key: string,
  ref: TowerModelRef | undefined,
): void {
  if (ref === undefined) {
    delete container[key];
    return;
  }
  const existing = container[key];
  if (!isPlainObject(existing)) {
    container[key] = formatModelRef(ref);
    return;
  }
  const entry: Record<string, unknown> = { ...existing, model: modelKey(ref) };
  if (ref.thinkingLevel === undefined) delete entry['thinkingLevel'];
  else entry['thinkingLevel'] = ref.thinkingLevel;
  container[key] = entry;
}

async function writeTarget(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isMissingFileError(error)) return resolve(path);
    throw error;
  }
}

function configError(source: string, key: string | undefined, message: string): TowerConfigError {
  return new TowerConfigError([key === undefined ? { source, message } : { source, key, message }]);
}
