import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Api, Model } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEventListener,
  type ExtensionError,
  type LoadExtensionsResult,
  type ModelRegistry,
} from '@earendil-works/pi-coding-agent';

import { AGENTS_DIR } from '../protocol/paths.ts';
import type {
  TowerAgentSession,
  TowerAgentSessionFactory,
  TowerAgentSpec,
  TowerSteerDisposition,
  TowerThinkingLevel,
} from './types.ts';

export const DEFAULT_TOWER_AGENT_TOOLS: readonly string[] = [
  'read',
  'bash',
  'edit',
  'write',
  'grep',
  'find',
  'ls',
];

export const PI_TOWER_PACKAGE_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

export const PI_TOWER_PACKAGE_NAME = 'pi-tower';

const INLINE_EXTENSION_PREFIX = '<inline:';

export interface PiSessionFactoryOptions {
  readonly projectTrusted: boolean | (() => boolean);
  readonly agentDir?: string;
  readonly modelRuntime?: ModelRuntime;
  readonly modelRegistry?: ModelRegistry | (() => ModelRegistry | undefined);
  readonly repoRoot?: string;
  readonly excludeExtensionRoots?: readonly string[];
  readonly excludePackageNames?: readonly string[];
  readonly onExtensionError?: (agentId: string, error: ExtensionError) => void;
  readonly onDiagnostic?: (message: string) => void;
}

export class PiTowerAgentSession implements TowerAgentSession {
  readonly session: AgentSession;
  private guardedSteers: string[] = [];
  private readonly unsubscribeQueue: () => void;

  constructor(session: AgentSession) {
    this.session = session;
    this.unsubscribeQueue = session.subscribe((event) => {
      if (event.type === 'queue_update') {
        this.guardedSteers = retainQueued(this.guardedSteers, event.steering);
      }
    });
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  get sessionFile(): string | undefined {
    return this.session.sessionFile;
  }

  get model(): Model<Api> | undefined {
    return this.session.model;
  }

  get thinkingLevel(): TowerThinkingLevel {
    return this.session.thinkingLevel;
  }

  get isStreaming(): boolean {
    return this.session.isStreaming;
  }

  prompt(text: string): Promise<void> {
    return this.session.prompt(text, { expandPromptTemplates: false, source: 'extension' });
  }

  async steer(text: string): Promise<TowerSteerDisposition> {
    if (!text.startsWith('/')) return this.session.steer(text, undefined, { source: 'extension' });
    const guarded = ` ${text}`;
    const disposition = await this.session.steer(guarded, undefined, { source: 'extension' });
    if (
      disposition === 'queued' &&
      countOf(this.session.getSteeringMessages(), guarded) > countOf(this.guardedSteers, guarded)
    ) {
      this.guardedSteers.push(guarded);
    }
    return disposition;
  }

  discardQueued(): readonly string[] {
    const guarded = this.guardedSteers;
    this.guardedSteers = [];
    return this.session.clearQueue().steering.map((text) => {
      const index = guarded.indexOf(text);
      if (index === -1) return text;
      guarded.splice(index, 1);
      return text.slice(1);
    });
  }

  abort(): Promise<void> {
    return this.session.abort();
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    return this.session.subscribe(listener);
  }

  async dispose(): Promise<void> {
    try {
      const runner = this.session.extensionRunner;
      if (runner.hasHandlers('session_shutdown')) {
        await runner.emit({ type: 'session_shutdown', reason: 'quit' });
      }
    } finally {
      this.unsubscribeQueue();
      this.session.dispose();
    }
  }
}

function retainQueued(guarded: readonly string[], queued: readonly string[]): string[] {
  const remaining = [...queued];
  return guarded.filter((text) => {
    const index = remaining.indexOf(text);
    if (index === -1) return false;
    remaining.splice(index, 1);
    return true;
  });
}

function countOf(texts: readonly string[], text: string): number {
  return texts.filter((candidate) => candidate === text).length;
}

export function createPiSessionFactory(options: PiSessionFactoryOptions): TowerAgentSessionFactory {
  const agentDir = resolve(options.agentDir ?? getAgentDir());
  const excludedRoots = (options.excludeExtensionRoots ?? [PI_TOWER_PACKAGE_ROOT]).map(canonicalPath);
  const excludedPackageNames = new Set(options.excludePackageNames ?? [PI_TOWER_PACKAGE_NAME]);
  let fallbackRuntime: Promise<ModelRuntime> | undefined;
  let registryDiagnosed = false;

  const modelRuntime = async (): Promise<ModelRuntime> => {
    if (options.modelRuntime !== undefined) return options.modelRuntime;
    const registry =
      typeof options.modelRegistry === 'function' ? options.modelRegistry() : options.modelRegistry;
    const parent = registryRuntime(registry);
    if (parent !== undefined) return parent;
    if (registry !== undefined && !registryDiagnosed) {
      registryDiagnosed = true;
      options.onDiagnostic?.(
        `the parent model registry exposes no reusable model runtime — tower agents use a model runtime loaded from ${agentDir}, so the parent session's runtime-only API keys and extension-registered providers are not available to them`,
      );
    }
    fallbackRuntime ??= ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: join(agentDir, 'models.json'),
    });
    try {
      return await fallbackRuntime;
    } catch (error) {
      fallbackRuntime = undefined;
      throw error;
    }
  };

  return async ({ agentId, spec }) => {
    if (!isDirectory(spec.cwd)) throw new Error(`tower agent cwd "${spec.cwd}" is not a directory`);
    const toolProblem = (spec.tools ?? []).find((name) => name.startsWith('+') || name.startsWith('-'));
    if (toolProblem !== undefined) {
      throw new Error(
        `tool allowlist entry "${toolProblem}" is a +/- modifier — pass plain tool names or * patterns`,
      );
    }
    const runtime = await modelRuntime();
    const model = spec.model === undefined ? undefined : await resolveAgentModel(runtime, spec.model);
    const projectTrusted =
      typeof options.projectTrusted === 'function' ? options.projectTrusted() : options.projectTrusted;
    const settingsManager = SettingsManager.create(spec.cwd, agentDir, { projectTrusted });
    const appended = appendedPrompts(spec);
    const resourceLoader = new DefaultResourceLoader({
      cwd: spec.cwd,
      agentDir,
      settingsManager,
      extensionFactories: [...(spec.extensionFactories ?? [])],
      extensionsOverride: (base) =>
        withoutExcludedExtensions(base, exclusionMatcher(excludedRoots, excludedPackageNames)),
      appendSystemPromptOverride: (base) => [...base, ...appended],
    });
    await resourceLoader.reload();
    const sessionManager =
      options.repoRoot === undefined
        ? SessionManager.inMemory(spec.cwd, { id: agentId })
        : SessionManager.create(spec.cwd, join(options.repoRoot, AGENTS_DIR), { id: agentId });
    const { session } = await createAgentSession({
      cwd: spec.cwd,
      agentDir,
      modelRuntime: runtime,
      model,
      thinkingLevel: spec.thinkingLevel,
      tools: toolAllowlist(spec, resourceLoader.getExtensions()),
      customTools: [...(spec.customTools ?? [])],
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    try {
      if (session.model === undefined) {
        throw new Error('no model is available for tower agents — configure a model with credentials');
      }
      await session.bindExtensions({
        mode: 'print',
        onError: (error) => {
          options.onExtensionError?.(agentId, error);
        },
      });
    } catch (error) {
      session.dispose();
      throw error;
    }
    return new PiTowerAgentSession(session);
  };
}

function registryRuntime(registry: ModelRegistry | undefined): ModelRuntime | undefined {
  if (registry === undefined) return undefined;
  const candidate = (registry as unknown as { readonly runtime?: unknown }).runtime;
  return isModelRuntime(candidate) ? candidate : undefined;
}

function isModelRuntime(value: unknown): value is ModelRuntime {
  if (typeof value !== 'object' || value === null) return false;
  const runtime = value as Partial<Record<keyof ModelRuntime, unknown>>;
  return (
    typeof runtime.getModel === 'function' &&
    typeof runtime.streamSimple === 'function' &&
    typeof runtime.hasConfiguredAuth === 'function' &&
    typeof runtime.checkAuth === 'function'
  );
}

async function resolveAgentModel(runtime: ModelRuntime, ref: string | Model<Api>): Promise<Model<Api>> {
  const model = typeof ref === 'string' ? findModel(runtime, ref) : ref;
  if (model === undefined) {
    throw new Error(`unknown model "${String(ref)}" — expected provider/modelId from the model registry`);
  }
  const authorized =
    runtime.hasConfiguredAuth(model.provider) || (await runtime.checkAuth(model.provider)) !== undefined;
  if (!authorized) {
    throw new Error(
      `no credentials configured for provider "${model.provider}" (model ${model.provider}/${model.id})`,
    );
  }
  return model;
}

function findModel(runtime: ModelRuntime, ref: string): Model<Api> | undefined {
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return runtime.getModel(ref.slice(0, slash), ref.slice(slash + 1));
}

function appendedPrompts(spec: TowerAgentSpec): string[] {
  if (spec.appendSystemPrompt === undefined) return [];
  return typeof spec.appendSystemPrompt === 'string'
    ? [spec.appendSystemPrompt]
    : [...spec.appendSystemPrompt];
}

function toolAllowlist(spec: TowerAgentSpec, extensions: LoadExtensionsResult): string[] {
  const names = new Set(spec.tools ?? DEFAULT_TOWER_AGENT_TOOLS);
  for (const tool of spec.customTools ?? []) names.add(tool.name);
  for (const extension of extensions.extensions) {
    if (!extension.path.startsWith(INLINE_EXTENSION_PREFIX)) continue;
    for (const name of extension.tools.keys()) names.add(name);
  }
  return [...names];
}

function withoutExcludedExtensions(
  base: LoadExtensionsResult,
  isExcluded: (path: string) => boolean,
): LoadExtensionsResult {
  const droppedPaths = new Set<string>();
  const extensions = base.extensions.filter((extension) => {
    if (!isExcluded(extension.resolvedPath)) return true;
    droppedPaths.add(extension.path);
    droppedPaths.add(extension.resolvedPath);
    return false;
  });
  const dropped = (extensionPath: string): boolean =>
    droppedPaths.has(extensionPath) || isExcluded(extensionPath);
  const { runtime } = base;
  runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter(
    (registration) => !dropped(registration.extensionPath),
  );
  runtime.pendingNativeProviderRegistrations = runtime.pendingNativeProviderRegistrations.filter(
    (registration) => !dropped(registration.extensionPath),
  );
  runtime.pendingVirtualModelRegistrations = runtime.pendingVirtualModelRegistrations.filter(
    (registration) => !dropped(registration.extensionPath),
  );
  for (const server of runtime.mcpServers.list()) {
    if (dropped(server.extensionPath)) runtime.mcpServers.unregister(server.name, server.extensionPath);
  }
  return { ...base, extensions };
}

function exclusionMatcher(
  roots: readonly string[],
  packageNames: ReadonlySet<string>,
): (path: string) => boolean {
  const packageNameByDir = new Map<string, string | undefined>();
  return (path) => {
    if (!isAbsolute(path)) return false;
    const real = canonicalPath(path);
    if (roots.some((root) => isWithin(real, root))) return true;
    if (packageNames.size === 0) return false;
    const name = nearestPackageName(real, packageNameByDir);
    return name !== undefined && packageNames.has(name);
  };
}

function nearestPackageName(file: string, cache: Map<string, string | undefined>): string | undefined {
  const visited: string[] = [];
  let dir = dirname(file);
  let name: string | undefined;
  for (;;) {
    if (cache.has(dir)) {
      name = cache.get(dir);
      break;
    }
    visited.push(dir);
    const manifest = readManifestName(join(dir, 'package.json'));
    if (manifest.found) {
      name = manifest.name;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const entry of visited) cache.set(entry, name);
  return name;
}

function readManifestName(path: string): { readonly found: boolean; readonly name?: string } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { found: false };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const name =
      typeof parsed === 'object' && parsed !== null ? (parsed as { readonly name?: unknown }).name : undefined;
    return { found: true, name: typeof name === 'string' ? name : undefined };
  } catch {
    return { found: true };
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
