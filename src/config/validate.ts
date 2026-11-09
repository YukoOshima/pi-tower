import { isThinkingLevel, TOWER_ROLES, TOWER_THINKING_LEVELS } from './modelRef.ts';
import { unresolvedModelHint } from './resolve.ts';
import { formatModelOrigin } from './source.ts';
import type { TowerResolvedModel, TowerResolvedModels, TowerRole } from './types.ts';

export interface TowerModelRegistry<TModel> {
  find(provider: string, modelId: string): TModel | undefined;
  hasConfiguredAuth(model: TModel): boolean;
}

export type TowerModelProblemKind = 'unresolved' | 'not-found' | 'no-auth';

export interface TowerModelProblem {
  readonly target: string;
  readonly kind: TowerModelProblemKind;
  readonly model?: string;
  readonly message: string;
}

export function validateModelBindings<TModel>(
  models: TowerResolvedModels,
  registry: TowerModelRegistry<TModel>,
): TowerModelProblem[] {
  const problems: TowerModelProblem[] = [];
  const inheriting = TOWER_ROLES.filter((role) => {
    const origin = models.roles[role].origin;
    return origin.kind === 'inherited' && origin.from === 'orchestrator';
  });
  for (const role of TOWER_ROLES) {
    const resolved = models.roles[role];
    if (resolved.origin.kind === 'inherited') continue;
    const dependents = role === 'orchestrator' ? inheriting : [];
    if (resolved.binding === undefined) {
      problems.push({
        target: role,
        kind: 'unresolved',
        message: withDependents(`${role}: no model — ${unresolvedModelHint(role)}`, dependents),
      });
      continue;
    }
    if (resolved.origin.kind === 'session') continue;
    const problem = checkModel(role, resolved, registry, dependents);
    if (problem !== undefined) problems.push(problem);
  }
  for (const [alias, resolved] of Object.entries(models.pool)) {
    const problem = checkModel(`models.${alias}`, resolved, registry, []);
    if (problem !== undefined) problems.push(problem);
  }
  return problems;
}

function checkModel<TModel>(
  target: string,
  resolved: TowerResolvedModel,
  registry: TowerModelRegistry<TModel>,
  dependents: readonly TowerRole[],
): TowerModelProblem | undefined {
  const binding = resolved.binding;
  if (binding === undefined) return undefined;
  const subject = `${target}: model "${binding.model}" (set by ${formatModelOrigin(resolved.origin)})`;
  const model = registry.find(binding.provider, binding.modelId);
  if (model === undefined) {
    return {
      target,
      kind: 'not-found',
      model: binding.model,
      message: withDependents(
        `${subject} is not in pi's model registry — check the provider/modelId (pi --list-models shows them)${thinkingSuffixHint(binding.modelId)}`,
        dependents,
      ),
    };
  }
  if (!registry.hasConfiguredAuth(model)) {
    return {
      target,
      kind: 'no-auth',
      model: binding.model,
      message: withDependents(
        `${subject} has no configured credentials for provider "${binding.provider}" — run /login or set the provider's API key`,
        dependents,
      ),
    };
  }
  return undefined;
}

function thinkingSuffixHint(modelId: string): string {
  const suffix = /:([A-Za-z]+)$/.exec(modelId)?.[1];
  if (suffix === undefined) return '';
  const lower = suffix.toLowerCase();
  return isThinkingLevel(lower)
    ? `; thinking levels are lowercase — did you mean ":${lower}"?`
    : `; if ":${suffix}" was meant as a thinking level, use one of ${TOWER_THINKING_LEVELS.join(', ')}`;
}

function withDependents(message: string, dependents: readonly TowerRole[]): string {
  if (dependents.length === 0) return message;
  const names =
    dependents.length < 3
      ? dependents.join(' and ')
      : `${dependents.slice(0, -1).join(', ')} and ${dependents.at(-1)!}`;
  return `${message}; ${names} ${dependents.length === 1 ? 'falls' : 'fall'} back to it`;
}
