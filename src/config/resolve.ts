import { TOWER_MODEL_ENV, TOWER_MODEL_FLAGS } from './load.ts';
import { isTowerRole, modelKey } from './modelRef.ts';
import type {
  TowerConfig,
  TowerConfigValue,
  TowerModelBinding,
  TowerModelOrigin,
  TowerModelSpec,
  TowerPrimaryModel,
  TowerResolvedModel,
  TowerResolvedModels,
  TowerRole,
  TowerSpawnKind,
  TowerThinkingLevel,
} from './types.ts';

export const PRIMARY_MODEL_CHOICE = 'primary';

export interface TowerSpawnModel {
  readonly choice: string;
  readonly binding: TowerModelBinding;
  readonly origin: TowerModelOrigin;
}

export class TowerSpawnModelError extends Error {
  readonly choice: string | undefined;
  readonly allowed: readonly string[];

  constructor(message: string, choice: string | undefined, allowed: readonly string[]) {
    super(message);
    this.name = 'TowerSpawnModelError';
    this.choice = choice;
    this.allowed = allowed;
  }
}

export function resolveTowerModels(
  config: TowerConfig,
  primary: TowerPrimaryModel | undefined,
): TowerResolvedModels {
  const { orchestrator, worker, reviewer, validator } = config.roles;
  const effectiveOrchestrator =
    orchestrator === undefined ? sessionModel(primary) : configuredModel(orchestrator);
  const orFallback = (
    value: TowerConfigValue<TowerModelSpec> | undefined,
    fallback: TowerResolvedModel,
  ): TowerResolvedModel => (value === undefined ? fallback : configuredModel(value));
  const fromOrchestrator = inherit('orchestrator', effectiveOrchestrator);
  const effectiveReviewer = orFallback(reviewer, fromOrchestrator);
  return {
    roles: {
      orchestrator: effectiveOrchestrator,
      worker: orFallback(worker, fromOrchestrator),
      reviewer: effectiveReviewer,
      validator: orFallback(
        validator,
        reviewer === undefined ? fromOrchestrator : inherit('reviewer', effectiveReviewer),
      ),
    },
    pool: Object.fromEntries(
      Object.entries(config.models).map(([alias, value]) => [alias, configuredModel(value)]),
    ),
    files: config.files,
  };
}

export function spawnModelChoices(models: TowerResolvedModels): readonly string[] {
  return [
    'orchestrator',
    PRIMARY_MODEL_CHOICE,
    'worker',
    'reviewer',
    'validator',
    ...Object.keys(models.pool),
  ];
}

export function resolveSpawnModel(
  models: TowerResolvedModels,
  kind: TowerSpawnKind,
  choice?: string,
): TowerSpawnModel {
  const requested = choice?.trim() ?? '';
  const name =
    requested.length === 0 ? kind : requested === PRIMARY_MODEL_CHOICE ? 'orchestrator' : requested;
  const resolved = isTowerRole(name)
    ? models.roles[name]
    : Object.hasOwn(models.pool, name)
      ? models.pool[name]
      : undefined;
  if (resolved === undefined) {
    const allowed = spawnModelChoices(models);
    throw new TowerSpawnModelError(
      `Invalid model "${requested}" — available models: ${allowed.join(', ')} (primary is an alias of orchestrator). Omit model to use the ${kind} default; other provider/model ids are not accepted — add them to "models" in tower.json first.`,
      requested,
      allowed,
    );
  }
  if (resolved.binding === undefined) {
    throw new TowerSpawnModelError(
      `No model for "${name}" — ${unresolvedModelHint(isTowerRole(name) ? name : 'orchestrator')}`,
      requested.length === 0 ? undefined : requested,
      spawnModelChoices(models),
    );
  }
  return { choice: name, binding: resolved.binding, origin: resolved.origin };
}

export function unresolvedModelHint(role: TowerRole): string {
  const via =
    role === 'orchestrator'
      ? `"orchestrator" in tower.json, ${TOWER_MODEL_ENV.orchestrator} or --${TOWER_MODEL_FLAGS.orchestrator}`
      : `${role === 'validator' ? '"validator", "reviewer"' : `"${role}"`} or "orchestrator" in tower.json, ${TOWER_MODEL_ENV[role]} or --${TOWER_MODEL_FLAGS[role]}`;
  const why =
    role === 'orchestrator'
      ? 'none is configured and the session has no model'
      : role === 'validator'
        ? 'it falls back to the reviewer and then the orchestrator, but neither is configured and the session has no model'
        : 'it falls back to the orchestrator, but no orchestrator is configured and the session has no model';
  return `${why}; select a session model with /model or set ${via}`;
}

function configuredModel(value: TowerConfigValue<TowerModelSpec>): TowerResolvedModel {
  const { provider, modelId, thinkingLevel, description } = value.value;
  return {
    binding: toBinding(provider, modelId, thinkingLevel),
    origin: value.source,
    ...(description === undefined ? {} : { description }),
  };
}

function sessionModel(primary: TowerPrimaryModel | undefined): TowerResolvedModel {
  const origin = { kind: 'session' } as const;
  if (primary === undefined) return { origin };
  return { binding: toBinding(primary.provider, primary.modelId, primary.thinkingLevel), origin };
}

function inherit(
  from: 'orchestrator' | 'reviewer',
  resolved: TowerResolvedModel,
): TowerResolvedModel {
  const origin = { kind: 'inherited', from } as const;
  return resolved.binding === undefined ? { origin } : { binding: resolved.binding, origin };
}

function toBinding(
  provider: string,
  modelId: string,
  thinkingLevel: TowerThinkingLevel | undefined,
): TowerModelBinding {
  const model = modelKey({ provider, modelId });
  return thinkingLevel === undefined
    ? { model, provider, modelId }
    : { model, provider, modelId, thinkingLevel };
}
