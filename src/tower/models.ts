import {
  TOWER_ROLES,
  TowerSpawnModelError,
  describeSpawnModels,
  formatConfigSource,
  formatModelRef,
  formatModelTable,
  isTowerRole,
  loadTowerConfig,
  readTowerModelFlags,
  resolveSpawnModel,
  resolveTowerModels,
  towerConfigPaths,
  updateTowerConfigModel,
  validateModelBindings,
  type TowerConfig,
  type TowerConfigSource,
  type TowerEnv,
  type TowerModelBinding,
  type TowerModelRegistry,
  type TowerPrimaryModel,
  type TowerResolvedModels,
  type TowerSpawnKind,
  type TowerThinkingLevel,
} from '../config/index.ts';
import type { TowerSpawnBinding, TowerSpawnModelResolution } from '../tools/support.ts';

export interface TowerModelsOptions {
  readonly agentDir: string;
  readonly configDirName: string;
  readonly env: TowerEnv;
  readonly getFlag: (name: string) => boolean | string | undefined;
  readonly homeDir?: string;
}

export interface TowerModelsContext {
  readonly cwd: string;
  readonly projectTrusted: boolean;
}

export type TowerModelsScope = 'global' | 'project';

export interface TowerModelsWriteResult {
  readonly lines: readonly string[];
  readonly warnings: readonly string[];
}

export class TowerModels {
  private readonly options: TowerModelsOptions;
  private loaded: TowerConfig | undefined;
  private failure: string | undefined;

  constructor(options: TowerModelsOptions) {
    this.options = options;
  }

  get config(): TowerConfig | undefined {
    return this.loaded;
  }

  get loadError(): string | undefined {
    return this.failure;
  }

  get maxRunningAgents(): number | undefined {
    return this.loaded?.maxRunningAgents?.value;
  }

  get agentTimeoutMs(): number | undefined {
    return this.loaded?.agentTimeoutMs?.value;
  }

  async load(context: TowerModelsContext): Promise<void> {
    try {
      this.loaded = await loadTowerConfig({
        agentDir: this.options.agentDir,
        cwd: context.cwd,
        env: this.options.env,
        ...(this.options.homeDir === undefined ? {} : { homeDir: this.options.homeDir }),
        configDirName: this.options.configDirName,
        projectTrusted: context.projectTrusted,
        flags: readTowerModelFlags(this.options.getFlag),
      });
      this.failure = undefined;
    } catch (error) {
      this.loaded = undefined;
      this.failure = errorText(error);
    }
  }

  resolve(primary: TowerPrimaryModel | undefined): TowerResolvedModels | undefined {
    return this.loaded === undefined ? undefined : resolveTowerModels(this.loaded, primary);
  }

  spawnModelLines(primary: TowerPrimaryModel | undefined): string | undefined {
    const resolved = this.resolve(primary);
    return resolved === undefined ? undefined : describeSpawnModels(resolved);
  }

  targets(): readonly string[] {
    const pool = Object.keys(this.loaded?.models ?? {});
    return [...TOWER_ROLES, 'primary', ...pool];
  }

  resolveSpawn<TModel>(
    kind: TowerSpawnKind,
    choice: string | undefined,
    primary: TowerPrimaryModel | undefined,
    registry: TowerModelRegistry<TModel> | undefined,
  ): TowerSpawnModelResolution {
    if (this.failure !== undefined) {
      return {
        ok: false,
        error: `tower spawn refused — the tower model configuration could not be loaded: ${this.failure}`,
      };
    }
    const resolved = this.resolve(primary);
    if (resolved === undefined) return { ok: true };
    let spawn: ReturnType<typeof resolveSpawnModel>;
    try {
      spawn = resolveSpawnModel(resolved, kind, choice);
    } catch (error) {
      if (error instanceof TowerSpawnModelError) return { ok: false, error: error.message };
      throw error;
    }
    if (registry !== undefined) {
      const targets = relevantTargets(spawn.choice, resolved);
      const problems = validateModelBindings(resolved, registry).filter((problem) =>
        targets.has(problem.target),
      );
      if (problems.length > 0) {
        return {
          ok: false,
          error: `tower spawn refused — the ${kind} model "${spawn.choice}" is not usable: ${problems.map((problem) => problem.message).join('; ')}`,
        };
      }
    }
    return { ok: true, binding: spawnBinding(spawn.choice, spawn.binding) };
  }

  orchestratorBinding(primary: TowerPrimaryModel | undefined): TowerModelBinding | undefined {
    const orchestrator = this.resolve(primary)?.roles.orchestrator;
    if (orchestrator === undefined || orchestrator.origin.kind === 'session') return undefined;
    return orchestrator.binding;
  }

  describe<TModel>(
    primary: TowerPrimaryModel | undefined,
    registry: TowerModelRegistry<TModel> | undefined,
  ): string {
    if (this.failure !== undefined) {
      return `The tower model configuration could not be loaded:\n${this.failure}`;
    }
    const resolved = this.resolve(primary);
    if (resolved === undefined) return 'The tower model configuration is not loaded yet.';
    const problems = registry === undefined ? [] : validateModelBindings(resolved, registry);
    return [
      formatModelTable(resolved),
      ...(problems.length > 0
        ? ['', 'Problems:', ...problems.map((problem) => `- ${problem.message}`)]
        : []),
    ].join('\n');
  }

  paths(cwd: string): { readonly global: string; readonly project: string } {
    return towerConfigPaths({
      agentDir: this.options.agentDir,
      cwd,
      env: this.options.env,
      ...(this.options.homeDir === undefined ? {} : { homeDir: this.options.homeDir }),
      configDirName: this.options.configDirName,
    });
  }

  async write(
    context: TowerModelsContext,
    request: { readonly key: string; readonly ref?: string; readonly scope: TowerModelsScope },
  ): Promise<TowerModelsWriteResult> {
    const paths = this.paths(context.cwd);
    const path = request.scope === 'project' ? paths.project : paths.global;
    const ignoredProjectWrite = request.scope === 'project' && !context.projectTrusted;
    const result = await updateTowerConfigModel({
      path,
      key: request.key,
      ...(request.ref === undefined ? {} : { ref: request.ref }),
    });
    await this.load(context);
    const warnings: string[] = [];
    if (ignoredProjectWrite && result.changed) {
      warnings.push(
        `This project is not trusted, so ${path} is ignored until you trust the project — the change was written but has no effect yet.`,
      );
    }
    const value = result.value === undefined ? request.ref : formatModelRef(result.value);
    const lines = [
      request.ref === undefined
        ? result.changed
          ? `Cleared ${result.field} in ${path}.`
          : `${result.field} was not set in ${path} — nothing changed.`
        : result.changed
          ? `Set ${result.field} = ${value ?? ''} in ${path}.`
          : `${result.field} is already ${value ?? ''} in ${path}.`,
    ];
    const effective = this.effectiveSource(result.field);
    if (this.failure !== undefined) {
      warnings.push(`The tower model configuration no longer loads: ${this.failure}`);
    } else if (effective !== undefined && !sameFile(effective, path)) {
      if (request.ref === undefined) {
        warnings.push(`${result.field} is still set by ${formatConfigSource(effective)}.`);
      } else if (!ignoredProjectWrite || effective.kind !== 'file') {
        warnings.push(
          `${result.field} is shadowed by ${formatConfigSource(effective)}, which takes precedence — the value written to ${path} is not in effect.`,
        );
      }
    }
    return { lines, warnings };
  }

  private effectiveSource(field: string): TowerConfigSource | undefined {
    const config = this.loaded;
    if (config === undefined) return undefined;
    if (isTowerRole(field)) return config.roles[field]?.source;
    const alias = field.startsWith('models.') ? field.slice('models.'.length) : field;
    return Object.hasOwn(config.models, alias) ? config.models[alias]?.source : undefined;
  }
}

export function towerPrimaryModel(
  model: { readonly provider: string; readonly id: string } | undefined,
  thinkingLevel: string | undefined,
): TowerPrimaryModel | undefined {
  if (model === undefined) return undefined;
  return {
    provider: model.provider,
    modelId: model.id,
    ...(thinkingLevel === undefined ? {} : { thinkingLevel: thinkingLevel as TowerThinkingLevel }),
  };
}

function relevantTargets(choice: string, resolved: TowerResolvedModels): ReadonlySet<string> {
  if (isTowerRole(choice)) {
    const targets = new Set<string>([choice]);
    if (resolved.roles[choice].origin.kind === 'inherited') targets.add('orchestrator');
    return targets;
  }
  return new Set([`models.${choice}`]);
}

function spawnBinding(choice: string, binding: TowerModelBinding): TowerSpawnBinding {
  return {
    choice,
    model: binding.model,
    ...(binding.thinkingLevel === undefined ? {} : { thinkingLevel: binding.thinkingLevel }),
  };
}

function sameFile(source: TowerConfigSource, path: string): boolean {
  return source.kind === 'file' && source.path === path;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
