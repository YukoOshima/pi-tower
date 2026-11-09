import {
  isThinkingLevel,
  MODEL_REF_FORMAT,
  parseModelRef,
  TOWER_THINKING_LEVELS,
} from './modelRef.ts';
import type { TowerConfigFile, TowerModelRef, TowerModelSpec } from './types.ts';

export const TOWER_CONFIG_KEYS = [
  'orchestrator',
  'worker',
  'reviewer',
  'validator',
  'models',
  'maxRunningAgents',
  'agentTimeoutMs',
] as const;

export const TOWER_MODEL_SPEC_KEYS = ['model', 'thinkingLevel', 'description'] as const;

export const RESERVED_MODEL_ALIASES = [
  'primary',
  'orchestrator',
  'worker',
  'reviewer',
  'validator',
] as const;

const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_TIMER_MS = 2_147_483_647;
const SPEC_SHAPE = `"${MODEL_REF_FORMAT}" or { "model", "thinkingLevel"?, "description"? }`;

export interface TowerConfigIssue {
  readonly source: string;
  readonly key?: string;
  readonly message: string;
}

export class TowerConfigError extends Error {
  readonly issues: readonly TowerConfigIssue[];

  constructor(issues: readonly TowerConfigIssue[]) {
    super(renderConfigIssues(issues));
    this.name = 'TowerConfigError';
    this.issues = issues;
  }
}

export function renderConfigIssues(issues: readonly TowerConfigIssue[]): string {
  const lines = issues.map((issue) =>
    issue.key === undefined
      ? `${issue.source}: ${issue.message}`
      : `${issue.source}: ${issue.key}: ${issue.message}`,
  );
  if (lines.length === 1) return `Invalid tower config — ${lines[0]!}`;
  return ['Invalid tower config:', ...lines.map((line) => `- ${line}`)].join('\n');
}

export function modelAliasProblem(alias: string): string | undefined {
  const lower = alias.toLowerCase();
  if (RESERVED_MODEL_ALIASES.some((name) => name === lower)) {
    return `"${alias}" is reserved for the role models (${RESERVED_MODEL_ALIASES.join(', ')}) — rename the alias`;
  }
  if (!ALIAS_PATTERN.test(alias)) {
    return `invalid alias "${alias}" — use 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit`;
  }
  return undefined;
}

export function parseTowerConfig(raw: unknown, source: string): TowerConfigFile {
  const issues: TowerConfigIssue[] = [];
  const config = readConfig(raw, (key, message) => {
    issues.push(key === undefined ? { source, message } : { source, key, message });
  });
  if (issues.length > 0) throw new TowerConfigError(issues);
  return config;
}

type Report = (key: string | undefined, message: string) => void;

type Writable<T> = { -readonly [K in keyof T]: T[K] };

function readConfig(raw: unknown, report: Report): TowerConfigFile {
  if (!isPlainObject(raw)) {
    report(undefined, `expected a JSON object, got ${describeValue(raw)}`);
    return {};
  }
  const config: Writable<TowerConfigFile> = {};
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case 'orchestrator':
      case 'worker':
      case 'reviewer':
      case 'validator': {
        const spec = readModelSpec(value, key, report);
        if (spec !== undefined) config[key] = spec;
        break;
      }
      case 'models': {
        const models = readModelPool(value, report);
        if (models !== undefined) config.models = models;
        break;
      }
      case 'maxRunningAgents': {
        const number = readPositiveInteger(value, key, report);
        if (number !== undefined) config[key] = number;
        break;
      }
      case 'agentTimeoutMs': {
        const number = readPositiveInteger(value, key, report, MAX_TIMER_MS);
        if (number !== undefined) config[key] = number;
        break;
      }
      default:
        report(key, `unknown key — allowed keys: ${TOWER_CONFIG_KEYS.join(', ')}`);
    }
  }
  return config;
}

function readModelPool(
  value: unknown,
  report: Report,
): Readonly<Record<string, TowerModelSpec>> | undefined {
  if (!isPlainObject(value)) {
    report(
      'models',
      `expected an object mapping alias to ${SPEC_SHAPE}, got ${describeValue(value)}`,
    );
    return undefined;
  }
  const pool: Record<string, TowerModelSpec> = {};
  for (const [alias, entry] of Object.entries(value)) {
    const key = `models.${alias}`;
    const problem = modelAliasProblem(alias);
    if (problem !== undefined) {
      report(key, problem);
      continue;
    }
    const spec = readModelSpec(entry, key, report);
    if (spec !== undefined) pool[alias] = spec;
  }
  return pool;
}

function readModelSpec(value: unknown, key: string, report: Report): TowerModelSpec | undefined {
  if (typeof value === 'string') return readModelRef(value, key, report);
  if (!isPlainObject(value)) {
    report(key, `expected ${SPEC_SHAPE}, got ${describeValue(value)}`);
    return undefined;
  }
  let valid = true;
  const fail = (field: string, message: string): void => {
    report(field, message);
    valid = false;
  };
  for (const field of Object.keys(value)) {
    if (!(TOWER_MODEL_SPEC_KEYS as readonly string[]).includes(field)) {
      fail(`${key}.${field}`, `unknown key — allowed keys: ${TOWER_MODEL_SPEC_KEYS.join(', ')}`);
    }
  }
  const model = value['model'];
  let ref: TowerModelRef | undefined;
  if (typeof model === 'string') {
    ref = readModelRef(model, `${key}.model`, report);
    if (ref === undefined) valid = false;
  } else if (model === undefined) {
    fail(`${key}.model`, `required — "${MODEL_REF_FORMAT}"`);
  } else {
    fail(`${key}.model`, `expected a "${MODEL_REF_FORMAT}" string, got ${describeValue(model)}`);
  }
  const thinkingLevel = value['thinkingLevel'];
  if (thinkingLevel !== undefined && !isThinkingLevel(thinkingLevel)) {
    fail(
      `${key}.thinkingLevel`,
      `${describeValue(thinkingLevel)} is not a thinking level — use ${TOWER_THINKING_LEVELS.join(', ')}`,
    );
  }
  if (ref?.thinkingLevel !== undefined && thinkingLevel !== undefined) {
    fail(
      key,
      `thinking level set twice (":${ref.thinkingLevel}" suffix on model and thinkingLevel ${describeValue(thinkingLevel)}) — keep one`,
    );
  }
  const description = value['description'];
  if (description !== undefined && typeof description !== 'string') {
    fail(`${key}.description`, `expected a string, got ${describeValue(description)}`);
  }
  if (!valid || ref === undefined) return undefined;
  const level = ref.thinkingLevel ?? (isThinkingLevel(thinkingLevel) ? thinkingLevel : undefined);
  const hint = typeof description === 'string' ? description.replaceAll(/\s+/g, ' ').trim() : '';
  return {
    provider: ref.provider,
    modelId: ref.modelId,
    ...(level === undefined ? {} : { thinkingLevel: level }),
    ...(hint.length === 0 ? {} : { description: hint }),
  };
}

function readModelRef(text: string, key: string, report: Report): TowerModelRef | undefined {
  const parsed = parseModelRef(text);
  if (parsed.ok) return parsed.ref;
  report(key, parsed.error);
  return undefined;
}

function readPositiveInteger(
  value: unknown,
  key: string,
  report: Report,
  max?: number,
): number | undefined {
  const integer = typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  if (integer && (max === undefined || value <= max)) return value;
  report(
    key,
    integer
      ? `expected at most ${String(max)} (Node's timer limit, about 24.8 days), got ${String(value)}`
      : `expected a positive integer, got ${describeValue(value)}`,
  );
  return undefined;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') {
    return JSON.stringify(value.length > 60 ? `${value.slice(0, 57)}...` : value);
  }
  return String(value);
}
