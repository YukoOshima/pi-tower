import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCENARIO_IDS = ['S1', 'S2', 'S3', 'S8', 'S4', 'S7', 'S13', 'S15', 'S16', 'S17'] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];
export const OBJECTIVE_SCENARIOS: readonly ScenarioId[] = ['S15', 'S16', 'S17'];
export const DEFAULT_SCENARIOS: readonly ScenarioId[] = SCENARIO_IDS.filter((id) => !OBJECTIVE_SCENARIOS.includes(id));
export const DEFAULT_SCENARIO_TIMEOUT_MS = 20 * 60_000;
export const DEFAULT_GLOBAL_TIMEOUT_MS = 75 * 60_000;

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
  readonly validator: RoleModel;
  readonly session: RoleModel;
  readonly agentDir: string;
  readonly piDefault: { readonly model: string | undefined; readonly thinking: string | undefined };
  readonly scenarios: readonly ScenarioId[];
  readonly globalTimeoutMs: number | undefined;
  readonly scenarioTimeoutMs: number | undefined;
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

function positiveInt(name: string): number | undefined {
  const raw = envValue(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return value;
}

const SCENARIO_GROUPS: Readonly<Record<string, readonly ScenarioId[]>> = { ALL: DEFAULT_SCENARIOS, OBJECTIVE: OBJECTIVE_SCENARIOS };

function parseScenarios(raw: string | undefined): readonly ScenarioId[] {
  if (raw === undefined) return DEFAULT_SCENARIOS;
  const picked = raw
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter((item) => item.length > 0)
    .flatMap((item): readonly string[] => SCENARIO_GROUPS[item] ?? [item]);
  const unknown = picked.filter((item) => !(SCENARIO_IDS as readonly string[]).includes(item));
  if (unknown.length > 0) throw new Error(`unknown scenario(s) ${unknown.join(', ')} — known: ${SCENARIO_IDS.join(', ')}, all (${DEFAULT_SCENARIOS.join(',')}), objective (${OBJECTIVE_SCENARIOS.join(',')})`);
  return SCENARIO_IDS.filter((id) => picked.includes(id));
}

function readPiDefault(agentDir: string): E2eSettings['piDefault'] {
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')) as Record<string, unknown>;
    const provider = typeof parsed.defaultProvider === 'string' ? parsed.defaultProvider : undefined;
    const model = typeof parsed.defaultModel === 'string' ? parsed.defaultModel : undefined;
    return {
      model: provider !== undefined && model !== undefined ? `${provider}/${model}` : model,
      thinking: typeof parsed.defaultThinkingLevel === 'string' ? parsed.defaultThinkingLevel : undefined,
    };
  } catch {
    return { model: undefined, thinking: undefined };
  }
}

export function discriminationNotes(settings: E2eSettings): string[] {
  const { orchestrator: A, worker: B, reviewer: C, session: P, piDefault } = settings;
  const compare = (role: RoleModel, model: string | undefined, thinking: string | undefined, label: string): string => {
    if (role.model !== model) return `vs ${label}: discriminates (different model)`;
    if (role.thinking !== undefined && role.thinking !== thinking) return `vs ${label}: WARNING same model, discriminates only via the thinking-level assertions (${role.thinking} vs ${thinking ?? 'pi default'})`;
    return `vs ${label}: WARNING does not discriminate (same model and thinking) — pick another model or thinking level for this role`;
  };
  const fallback = `pi's global default ${piDefault.model ?? 'unknown'} (thinking ${piDefault.thinking ?? 'pi default'}), where a dropped role binding lands`;
  const starting = `the starting model P ${P.spec}, which only an agent wrongly inheriting the startup session model would get`;
  return [A, B, C].map((role, index) => {
    const label = ['orchestrator A', 'worker B', 'reviewer C'][index] ?? '';
    const versusP = role === A ? 'vs P: discriminates (A ≠ P is enforced)' : compare(role, P.model, P.thinking, starting);
    return `${label} ${role.spec} — ${compare(role, piDefault.model, piDefault.thinking, fallback)}; ${versusP}`;
  });
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
  const validator = parseRoleModel(envValue('PI_TOWER_E2E_VALIDATOR_MODEL') ?? reviewer.spec);
  const session = parseRoleModel(envValue('PI_TOWER_E2E_SESSION_MODEL') ?? 'byteplus-gateway/claude-haiku-5-5:low');
  const distinct = new Set([orchestrator.model, worker.model, reviewer.model]);
  if (distinct.size !== 3) {
    throw new Error(`the orchestrator, worker and reviewer models must be three distinct provider/model ids, got ${orchestrator.model}, ${worker.model}, ${reviewer.model}`);
  }
  if (session.model === orchestrator.model) {
    throw new Error(`the starting session model (${session.model}) must differ from the orchestrator model so the /tower on switch is observable`);
  }
  const agentDir = envValue('PI_CODING_AGENT_DIR')?.replace(/^~(?=\/|$)/, homedir()) ?? join(homedir(), '.pi', 'agent');
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
    validator,
    session,
    agentDir,
    piDefault: readPiDefault(agentDir),
    scenarios: parseScenarios(cliScenarios ?? envValue('PI_TOWER_E2E_SCENARIOS')),
    globalTimeoutMs: positiveInt('PI_TOWER_E2E_TIMEOUT_MS'),
    scenarioTimeoutMs: positiveInt('PI_TOWER_E2E_SCENARIO_TIMEOUT_MS'),
    keep: envValue('PI_TOWER_E2E_KEEP') === '1' || argv.includes('--keep'),
    verbose: envValue('PI_TOWER_E2E_VERBOSE') === '1' || argv.includes('--verbose'),
    reportPath: argv.find((arg) => arg.startsWith('--report='))?.slice('--report='.length) ?? envValue('PI_TOWER_E2E_REPORT'),
  };
}
