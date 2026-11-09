import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { pathExists, readConfigJson } from './jsonFile.ts';
import { parseModelRef, TOWER_ROLES } from './modelRef.ts';
import { parseTowerConfig, TowerConfigError } from './schema.ts';
import type { TowerConfigIssue } from './schema.ts';
import { formatConfigSource } from './source.ts';
import type {
  TowerConfig,
  TowerConfigFile,
  TowerConfigFileState,
  TowerConfigScope,
  TowerConfigSource,
  TowerConfigValue,
  TowerModelSpec,
  TowerRole,
} from './types.ts';

export const TOWER_CONFIG_FILE_NAME = 'tower.json';
export const DEFAULT_CONFIG_DIR_NAME = '.pi';
export const TOWER_CONFIG_ENV = 'PI_TOWER_CONFIG';

export const TOWER_MODEL_ENV: Readonly<Record<TowerRole, string>> = {
  orchestrator: 'PI_TOWER_ORCHESTRATOR_MODEL',
  worker: 'PI_TOWER_WORKER_MODEL',
  reviewer: 'PI_TOWER_REVIEWER_MODEL',
  validator: 'PI_TOWER_VALIDATOR_MODEL',
};

export const TOWER_MODEL_FLAGS: Readonly<Record<TowerRole, string>> = {
  orchestrator: 'tower-orchestrator-model',
  worker: 'tower-worker-model',
  reviewer: 'tower-reviewer-model',
  validator: 'tower-validator-model',
};

export type TowerEnv = Readonly<Record<string, string | undefined>>;

export type TowerModelFlags = Readonly<Partial<Record<TowerRole, string>>>;

export interface TowerConfigPathsInput {
  readonly agentDir: string;
  readonly cwd: string;
  readonly env: TowerEnv;
  readonly homeDir?: string;
  readonly configDirName?: string;
}

export interface TowerConfigLoadInput extends TowerConfigPathsInput {
  readonly projectTrusted: boolean;
  readonly flags?: TowerModelFlags;
}

export interface TowerConfigPaths {
  readonly global: string;
  readonly project: string;
}

interface ConfigLayer {
  readonly state: TowerConfigFileState;
  readonly config?: TowerConfigFile;
}

type RoleValues = Partial<Record<TowerRole, TowerConfigValue<TowerModelSpec>>>;

export function towerConfigPaths(input: TowerConfigPathsInput): TowerConfigPaths {
  const cwd = resolve(input.cwd);
  const override = nonBlank(input.env[TOWER_CONFIG_ENV]);
  return {
    global:
      override === undefined
        ? resolve(cwd, input.agentDir, TOWER_CONFIG_FILE_NAME)
        : expandPath(override, cwd, input.homeDir ?? homedir()),
    project: join(cwd, input.configDirName ?? DEFAULT_CONFIG_DIR_NAME, TOWER_CONFIG_FILE_NAME),
  };
}

export function readTowerModelFlags(
  getFlag: (name: string) => boolean | string | undefined,
): TowerModelFlags {
  const flags: Partial<Record<TowerRole, string>> = {};
  for (const role of TOWER_ROLES) {
    const value = getFlag(TOWER_MODEL_FLAGS[role]);
    if (typeof value === 'string') flags[role] = value;
  }
  return flags;
}

export async function loadTowerConfig(input: TowerConfigLoadInput): Promise<TowerConfig> {
  const paths = towerConfigPaths(input);
  const issues: TowerConfigIssue[] = [];
  const global = await readLayer('global', paths.global, issues);
  const project = input.projectTrusted
    ? await readLayer('project', paths.project, issues)
    : await untrustedLayer(paths.project);
  const fromEnv = readRoleRefs(
    (role) => input.env[TOWER_MODEL_ENV[role]],
    (role) => ({ kind: 'env', variable: TOWER_MODEL_ENV[role] }),
    issues,
  );
  const fromFlags = readRoleRefs(
    (role) => input.flags?.[role],
    (role) => ({ kind: 'flag', flag: TOWER_MODEL_FLAGS[role] }),
    issues,
  );
  if (issues.length > 0) throw new TowerConfigError(issues);

  const roles: RoleValues = {};
  for (const role of TOWER_ROLES) {
    const value =
      fromFlags[role] ??
      fromEnv[role] ??
      layerValue(project, project.config?.[role]) ??
      layerValue(global, global.config?.[role]);
    if (value !== undefined) roles[role] = value;
  }
  const models: Record<string, TowerConfigValue<TowerModelSpec>> = {};
  for (const layer of [global, project]) {
    for (const [alias, spec] of Object.entries(layer.config?.models ?? {})) {
      models[alias] = { value: spec, source: layerSource(layer) };
    }
  }
  const maxRunningAgents =
    layerValue(project, project.config?.maxRunningAgents) ??
    layerValue(global, global.config?.maxRunningAgents);
  const agentTimeoutMs =
    layerValue(project, project.config?.agentTimeoutMs) ??
    layerValue(global, global.config?.agentTimeoutMs);
  return {
    roles,
    models,
    ...(maxRunningAgents === undefined ? {} : { maxRunningAgents }),
    ...(agentTimeoutMs === undefined ? {} : { agentTimeoutMs }),
    files: [global.state, project.state],
  };
}

async function readLayer(
  scope: TowerConfigScope,
  path: string,
  issues: TowerConfigIssue[],
): Promise<ConfigLayer> {
  const source = formatConfigSource({ kind: 'file', scope, path });
  try {
    const json = await readConfigJson(path, source);
    if (!json.exists) return { state: { scope, path, status: 'missing' } };
    return {
      state: { scope, path, status: 'loaded' },
      config: parseTowerConfig(json.value, source),
    };
  } catch (error) {
    if (!(error instanceof TowerConfigError)) throw error;
    issues.push(...error.issues);
    return { state: { scope, path, status: 'loaded' } };
  }
}

async function untrustedLayer(path: string): Promise<ConfigLayer> {
  const status = (await pathExists(path)) ? 'untrusted' : 'missing';
  return { state: { scope: 'project', path, status } };
}

function readRoleRefs(
  valueOf: (role: TowerRole) => string | undefined,
  sourceOf: (role: TowerRole) => TowerConfigSource,
  issues: TowerConfigIssue[],
): RoleValues {
  const values: RoleValues = {};
  for (const role of TOWER_ROLES) {
    const text = nonBlank(valueOf(role));
    if (text === undefined) continue;
    const source = sourceOf(role);
    const parsed = parseModelRef(text);
    if (parsed.ok) values[role] = { value: parsed.ref, source };
    else issues.push({ source: formatConfigSource(source), message: parsed.error });
  }
  return values;
}

function layerValue<T>(layer: ConfigLayer, value: T | undefined): TowerConfigValue<T> | undefined {
  return value === undefined ? undefined : { value, source: layerSource(layer) };
}

function layerSource(layer: ConfigLayer): TowerConfigSource {
  return { kind: 'file', scope: layer.state.scope, path: layer.state.path };
}

function expandPath(path: string, cwd: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return resolve(cwd, path);
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
