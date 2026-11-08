import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCENARIO_IDS = ['S1', 'S2', 'S3', 'S8', 'S4', 'S7', 'S13'] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];
export const DEFAULT_SCENARIOS: readonly ScenarioId[] = SCENARIO_IDS;

export interface RoleModel {
  readonly spec: string;
  readonly model: string;
  readonly thinking: string | undefined;
}

export interface E2eSettings {
  readonly checkout: string;
  readonly extension: string;
  readonly probeExtension: string;
  readonly piBin: string;
  readonly piVersion: string;
  readonly orchestrator: RoleModel;
  readonly worker: RoleModel;
  readonly reviewer: RoleModel;
  readonly session: RoleModel;
  readonly scenarios: readonly ScenarioId[];
  readonly globalTimeoutMs: number;
  readonly scenarioTimeoutMs: number;
  readonly keep: boolean;
  readonly verbose: boolean;
  readonly reportPath: string | undefined;
}

const here = dirname(fileURLToPath(import.meta.url));

export function parseRoleModel(spec: string): RoleModel {
  const trimmed = spec.trim();
  const match = /^([^/\s]+\/[^:\s]+)(?::([a-z]+))?$/.exec(trimmed);
  if (match === null) throw new Error(`model "${spec}" must look like provider/modelId[:thinking]`);
  return { spec: trimmed, model: match[1] ?? trimmed, thinking: match[2] };
}

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = envValue(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return value;
}

function parseScenarios(raw: string | undefined): readonly ScenarioId[] {
  if (raw === undefined || raw.toLowerCase() === 'all') return DEFAULT_SCENARIOS;
  const picked = raw.split(',').map((item) => item.trim().toUpperCase()).filter((item) => item.length > 0);
  const unknown = picked.filter((item) => !(SCENARIO_IDS as readonly string[]).includes(item));
  if (unknown.length > 0) throw new Error(`unknown scenario(s) ${unknown.join(', ')} — known: ${SCENARIO_IDS.join(', ')}`);
  return SCENARIO_IDS.filter((id) => picked.includes(id));
}

export function loadSettings(argv: readonly string[]): E2eSettings {
  const checkout = resolve(envValue('PI_TOWER_E2E_CHECKOUT') ?? join(here, '..', '..'));
  const extension = join(checkout, 'src', 'index.ts');
  if (!existsSync(extension)) throw new Error(`extension entry ${extension} does not exist — set PI_TOWER_E2E_CHECKOUT to a pi-tower checkout`);
  const piBin = envValue('PI_TOWER_E2E_PI') ?? 'pi';
  const piVersion = execFileSync(piBin, ['--version'], { encoding: 'utf8' }).trim();
  const orchestrator = parseRoleModel(envValue('PI_TOWER_E2E_ORCHESTRATOR_MODEL') ?? 'byteplus-gateway/claude-sonnet-5-5:low');
  const worker = parseRoleModel(envValue('PI_TOWER_E2E_WORKER_MODEL') ?? 'byteplus-gateway/claude-haiku-5-5:low');
  const reviewer = parseRoleModel(envValue('PI_TOWER_E2E_REVIEWER_MODEL') ?? 'byteplus-gateway/claude-opus-5-5:low');
  const session = parseRoleModel(envValue('PI_TOWER_E2E_SESSION_MODEL') ?? 'byteplus-gateway/claude-haiku-5-5:low');
  const distinct = new Set([orchestrator.model, worker.model, reviewer.model]);
  if (distinct.size !== 3) {
    throw new Error(`the orchestrator, worker and reviewer models must be three distinct provider/model ids, got ${orchestrator.model}, ${worker.model}, ${reviewer.model}`);
  }
  if (session.model === orchestrator.model) {
    throw new Error(`the starting session model (${session.model}) must differ from the orchestrator model so the /tower on switch is observable`);
  }
  const cliScenarios = argv.find((arg) => arg.startsWith('--scenarios='))?.slice('--scenarios='.length);
  return {
    checkout,
    extension,
    probeExtension: join(here, 'probe.ts'),
    piBin,
    piVersion,
    orchestrator,
    worker,
    reviewer,
    session,
    scenarios: parseScenarios(cliScenarios ?? envValue('PI_TOWER_E2E_SCENARIOS')),
    globalTimeoutMs: positiveInt('PI_TOWER_E2E_TIMEOUT_MS', 75 * 60_000),
    scenarioTimeoutMs: positiveInt('PI_TOWER_E2E_SCENARIO_TIMEOUT_MS', 20 * 60_000),
    keep: envValue('PI_TOWER_E2E_KEEP') === '1' || argv.includes('--keep'),
    verbose: envValue('PI_TOWER_E2E_VERBOSE') === '1' || argv.includes('--verbose'),
    reportPath: argv.find((arg) => arg.startsWith('--report='))?.slice('--report='.length) ?? envValue('PI_TOWER_E2E_REPORT'),
  };
}
