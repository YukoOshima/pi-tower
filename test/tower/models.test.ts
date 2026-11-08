import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { SessionStartEvent } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';

import { TOWER_WORKER_ROLE } from '../../src/prompts/index.ts';
import { TowerStore } from '../../src/protocol/index.ts';
import type { TowerCommandUi } from '../../src/tower/command.ts';
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  TOWER_MODE_ENTRY,
  TOWER_REVIEWER_BASE_TOOLS,
  TOWER_WORKER_BASE_TOOLS,
} from '../../src/tower/constants.ts';
import { TowerController } from '../../src/tower/controller.ts';
import { TowerModels } from '../../src/tower/models.ts';
import { TOWER_MODELS_USAGE, handleTowerModelsCommand } from '../../src/tower/modelsCommand.ts';
import {
  FakeContext,
  FakePi,
  FakeRuntime,
  FakeSessionManager,
  createRepo,
  removeDir,
  type FakeModel,
} from './fakes.ts';

const SESSION_ID = 'session-models';
const START: SessionStartEvent = { type: 'session_start', reason: 'startup' };

const cleanups: string[] = [];

afterEach(async () => {
  for (const dir of cleanups.splice(0)) await removeDir(dir);
});

interface HarnessOptions {
  readonly global?: unknown;
  readonly project?: unknown;
  readonly env?: Readonly<Record<string, string>>;
  readonly flags?: Readonly<Record<string, string>>;
  readonly trusted?: boolean;
  readonly repo?: string;
  readonly agentDir?: string;
  readonly entries?: FakeSessionManager['entries'];
  readonly sessionModel?: readonly [string, string];
}

interface Harness {
  readonly repo: string;
  readonly agentDir: string;
  readonly globalPath: string;
  readonly projectPath: string;
  readonly session: FakeSessionManager;
  readonly ctx: FakeContext;
  readonly pi: FakePi;
  readonly runtime: FakeRuntime;
  readonly models: TowerModels;
  readonly controller: TowerController;
  readonly sessionModel: FakeModel;
}

interface RecordingUi {
  readonly ui: TowerCommandUi;
  readonly notices: { readonly title: string; readonly body?: string }[];
  readonly statuses: string[];
  readonly warnings: string[];
  readonly errors: string[];
}

interface RegisteredTool {
  readonly description: string;
  readonly defaultActive?: boolean;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown,
  ): Promise<{ readonly content: readonly { readonly text: string }[]; readonly isError?: boolean }>;
}

async function writeConfig(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

async function readConfig(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const repo = options.repo ?? (await createRepo('tower-models-'));
  const agentDir = options.agentDir ?? (await mkdtemp(join(tmpdir(), 'tower-models-agent-')));
  if (options.repo === undefined) cleanups.push(repo);
  if (options.agentDir === undefined) cleanups.push(agentDir);
  const globalPath = join(agentDir, 'tower.json');
  const projectPath = join(repo, '.pi', 'tower.json');
  if (options.global !== undefined) await writeConfig(globalPath, options.global);
  if (options.project !== undefined) await writeConfig(projectPath, options.project);
  const session = new FakeSessionManager(SESSION_ID, options.entries ?? []);
  const ctx = new FakeContext(repo, session);
  ctx.trusted = options.trusted ?? true;
  const [provider, id] = options.sessionModel ?? ['prov', 'session-model'];
  const sessionModel = ctx.modelRegistry.add(provider, id);
  ctx.model = sessionModel;
  const pi = new FakePi();
  pi.session = session;
  pi.context = ctx;
  for (const [name, value] of Object.entries(options.flags ?? {})) pi.flags.set(name, value);
  const models = new TowerModels({
    agentDir,
    configDirName: '.pi',
    env: { ...options.env },
    getFlag: (name) => pi.getFlag(name),
  });
  const runtime = new FakeRuntime();
  const controller = new TowerController({
    pi,
    models,
    createRuntime: () => runtime,
    isProcessAlive: () => true,
  });
  await controller.onSessionStart(START, ctx.asContext);
  return { repo, agentDir, globalPath, projectPath, session, ctx, pi, runtime, models, controller, sessionModel };
}

function recordingUi(): RecordingUi {
  const notices: { title: string; body?: string }[] = [];
  const statuses: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  return {
    notices,
    statuses,
    warnings,
    errors,
    ui: {
      notice: (title, body) => {
        notices.push(body === undefined ? { title } : { title, body });
      },
      status: (text) => {
        statuses.push(text);
      },
      warn: (text) => {
        warnings.push(text);
      },
      error: (text) => {
        errors.push(text);
      },
    },
  };
}

async function runModels(h: Harness, args: readonly string[]): Promise<RecordingUi> {
  const recorded = recordingUi();
  await handleTowerModelsCommand(h.controller, args, h.ctx.asCommandContext, recorded.ui);
  return recorded;
}

function registeredTool(h: Harness, name: string): RegisteredTool {
  const tool = h.pi.registeredTools.get(name) as RegisteredTool | undefined;
  if (tool === undefined) throw new Error(`${name} is not registered`);
  return tool;
}

function spawnDescription(h: Harness): string {
  return registeredTool(h, 'TowerSpawn').description;
}

function lastModeRecord(h: Harness): unknown {
  return h.pi.appended.filter((entry) => entry.customType === TOWER_MODE_ENTRY).at(-1)?.data;
}

describe('spawn model resolution', () => {
  it('defaults workers to the worker role and reviewers to the reviewer role', async () => {
    const h = await harness({ global: { worker: 'prov/worker-model:high', reviewer: 'prov/reviewer-model' } });
    h.ctx.modelRegistry.add('prov', 'worker-model');
    h.ctx.modelRegistry.add('prov', 'reviewer-model');

    expect(await h.controller.resolveSpawnModel('worker', undefined)).toEqual({
      ok: true,
      binding: { choice: 'worker', model: 'prov/worker-model', thinkingLevel: 'high' },
    });
    expect(await h.controller.resolveSpawnModel('reviewer', undefined)).toEqual({
      ok: true,
      binding: { choice: 'reviewer', model: 'prov/reviewer-model' },
    });
    expect(await h.controller.resolveSpawnModel('worker', 'reviewer')).toEqual({
      ok: true,
      binding: { choice: 'reviewer', model: 'prov/reviewer-model' },
    });
    expect(await h.controller.resolveSpawnModel('reviewer', 'primary')).toEqual({
      ok: true,
      binding: { choice: 'orchestrator', model: 'prov/session-model', thinkingLevel: 'medium' },
    });
  });

  it('falls back to the orchestrator, and to the session model when no orchestrator is configured', async () => {
    const configured = await harness({ global: { orchestrator: 'prov/orch-model:low' } });
    configured.ctx.modelRegistry.add('prov', 'orch-model');
    expect(await configured.controller.resolveSpawnModel('worker', undefined)).toEqual({
      ok: true,
      binding: { choice: 'worker', model: 'prov/orch-model', thinkingLevel: 'low' },
    });

    const bare = await harness();
    bare.pi.thinkingLevel = 'high';
    expect(await bare.controller.resolveSpawnModel('reviewer', undefined)).toEqual({
      ok: true,
      binding: { choice: 'reviewer', model: 'prov/session-model', thinkingLevel: 'high' },
    });
  });

  it('lets the pi flags and environment variables override tower.json', async () => {
    const h = await harness({
      global: { worker: 'prov/worker-model', reviewer: 'prov/reviewer-model' },
      env: { PI_TOWER_WORKER_MODEL: 'prov/env-worker', PI_TOWER_REVIEWER_MODEL: 'prov/env-reviewer' },
      flags: { 'tower-worker-model': 'prov/flag-worker:high' },
    });
    h.ctx.modelRegistry.add('prov', 'flag-worker');
    h.ctx.modelRegistry.add('prov', 'env-reviewer');

    expect(await h.controller.resolveSpawnModel('worker', undefined)).toEqual({
      ok: true,
      binding: { choice: 'worker', model: 'prov/flag-worker', thinkingLevel: 'high' },
    });
    expect(await h.controller.resolveSpawnModel('reviewer', undefined)).toEqual({
      ok: true,
      binding: { choice: 'reviewer', model: 'prov/env-reviewer' },
    });
  });

  it('refuses an unknown model choice and lists the available ones', async () => {
    const h = await harness({ global: { models: { fast: 'prov/fast-model' } } });

    expect(await h.controller.resolveSpawnModel('worker', 'gpt-9')).toEqual({
      ok: false,
      error:
        'Invalid model "gpt-9" — available models: orchestrator, primary, worker, reviewer, fast (primary is an alias of orchestrator). Omit model to use the worker default; other provider/model ids are not accepted — add them to "models" in tower.json first.',
    });
  });

  it("refuses a spawn whose own model is missing from pi's registry or lacks credentials, and only that one", async () => {
    const h = await harness({
      global: {
        worker: 'prov/missing-model',
        reviewer: 'prov/locked-model',
        models: { fast: 'prov/fast-model', broken: 'prov/nowhere' },
      },
    });
    h.ctx.modelRegistry.add('prov', 'locked-model', { auth: false });
    h.ctx.modelRegistry.add('prov', 'fast-model');
    const source = `${h.globalPath} (global)`;

    expect(await h.controller.resolveSpawnModel('worker', undefined)).toEqual({
      ok: false,
      error: `tower spawn refused — the worker model "worker" is not usable: worker: model "prov/missing-model" (set by ${source}) is not in pi's model registry — check the provider/modelId (pi --list-models shows them)`,
    });
    expect(await h.controller.resolveSpawnModel('reviewer', undefined)).toEqual({
      ok: false,
      error: `tower spawn refused — the reviewer model "reviewer" is not usable: reviewer: model "prov/locked-model" (set by ${source}) has no configured credentials for provider "prov" — run /login or set the provider's API key`,
    });
    expect(await h.controller.resolveSpawnModel('worker', 'fast')).toEqual({
      ok: true,
      binding: { choice: 'fast', model: 'prov/fast-model' },
    });
    expect(await h.controller.resolveSpawnModel('worker', 'broken')).toEqual({
      ok: false,
      error: `tower spawn refused — the worker model "broken" is not usable: models.broken: model "prov/nowhere" (set by ${source}) is not in pi's model registry — check the provider/modelId (pi --list-models shows them)`,
    });
  });

  it('refuses an inheriting role when the orchestrator it falls back to is unusable', async () => {
    const h = await harness({ global: { orchestrator: 'prov/ghost-model', reviewer: 'prov/reviewer-model' } });
    h.ctx.modelRegistry.add('prov', 'reviewer-model');

    expect(await h.controller.resolveSpawnModel('worker', undefined)).toEqual({
      ok: false,
      error: `tower spawn refused — the worker model "worker" is not usable: orchestrator: model "prov/ghost-model" (set by ${h.globalPath} (global)) is not in pi's model registry — check the provider/modelId (pi --list-models shows them); worker falls back to it`,
    });
    expect(await h.controller.resolveSpawnModel('reviewer', undefined)).toEqual({
      ok: true,
      binding: { choice: 'reviewer', model: 'prov/reviewer-model' },
    });
  });

  it('refuses every spawn while the tower model configuration does not load', async () => {
    const broken = await harness({ global: '{ not json' });
    expect(await broken.controller.resolveSpawnModel('worker', undefined)).toEqual({
      ok: false,
      error: expect.stringContaining(
        `tower spawn refused — the tower model configuration could not be loaded: Invalid tower config — ${broken.globalPath} (global)`,
      ) as unknown as string,
    });
    expect(spawnDescription(broken)).not.toContain('Available models');

    const badFlag = await harness({ flags: { 'tower-reviewer-model': 'no-slash' } });
    const refused = await badFlag.controller.resolveSpawnModel('reviewer', undefined);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? '' : refused.error).toContain('--tower-reviewer-model');
  });

  it('launches agents with the resolved model, the role prompt, the per-kind tools and the configured timeout', async () => {
    const h = await harness({ global: { worker: 'prov/worker-model:high', agentTimeoutMs: 60_000 } });
    h.ctx.modelRegistry.add('prov', 'worker-model');
    const store = new TowerStore(h.repo);
    await store.init(SESSION_ID, 'main');
    await store.plan([{ title: 'Build gemm', scope: ['src/**'] }]);
    expect(await h.controller.enter()).toEqual({ entered: true });

    const result = await registeredTool(h, 'TowerSpawn').execute(
      'call_spawn',
      { name: 'agent-build', kind: 'worker', mission_id: 'M1' },
      undefined,
      undefined,
      h.ctx.asContext,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('prov/worker-model');
    expect(h.runtime.specs).toHaveLength(1);
    expect(h.runtime.specs[0]).toMatchObject({
      name: 'agent-build',
      kind: 'worker',
      model: 'prov/worker-model',
      thinkingLevel: 'high',
      appendSystemPrompt: TOWER_WORKER_ROLE,
      tools: TOWER_WORKER_BASE_TOOLS,
      timeoutMs: 60_000,
    });
    const state = await store.load();
    expect(state.roster.agents[0]).toMatchObject({ name: 'agent-build', model: 'prov/worker-model' });
  });

  it('gives reviewers read-only tools and the default two-hour timeout', async () => {
    const h = await harness();

    await h.controller.launchAgent({
      name: 'agent-review',
      kind: 'reviewer',
      description: 'review',
      cwd: h.repo,
      prompt: 'review it',
      binding: { choice: 'reviewer', model: 'prov/session-model', thinkingLevel: 'medium' },
    });

    expect(h.runtime.specs[0]).toMatchObject({
      kind: 'reviewer',
      tools: TOWER_REVIEWER_BASE_TOOLS,
      timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
      model: 'prov/session-model',
      thinkingLevel: 'medium',
    });
    expect(TOWER_REVIEWER_BASE_TOOLS).not.toContain('write');
    expect(TOWER_REVIEWER_BASE_TOOLS).not.toContain('edit');
    expect(DEFAULT_AGENT_TIMEOUT_MS).toBe(7_200_000);
  });
});

describe('TowerSpawn model description', () => {
  it('re-registers TowerSpawn with the available models after the config loads and after model changes', async () => {
    const h = await harness({ global: { worker: 'prov/worker-model:high', models: { fast: 'prov/fast-model' } } });

    const loaded = registeredTool(h, 'TowerSpawn');
    expect(loaded.defaultActive).toBe(false);
    expect(loaded.description).toContain('Available models (pass via model):');
    expect(loaded.description).toContain('- orchestrator (alias primary): prov/session-model, thinking medium');
    expect(loaded.description).toContain('- worker [worker default]: prov/worker-model, thinking high');
    expect(loaded.description).toContain('- reviewer [reviewer default]: prov/session-model, thinking medium');
    expect(loaded.description).toContain('- fast: prov/fast-model, pi default thinking');

    h.ctx.model = h.ctx.modelRegistry.add('prov', 'next-model');
    h.controller.onModelChanged(h.ctx.asContext);
    expect(spawnDescription(h)).toContain('- orchestrator (alias primary): prov/next-model, thinking medium');

    h.pi.thinkingLevel = 'low';
    h.controller.onModelChanged(h.ctx.asContext);
    expect(spawnDescription(h)).toContain('- reviewer [reviewer default]: prov/next-model, thinking low');
  });

  it('re-registers TowerSpawn after every /tower models write', async () => {
    const h = await harness();
    expect(spawnDescription(h)).toContain('- worker [worker default]: prov/session-model, thinking medium');

    await runModels(h, ['worker', 'prov/other-model:low']);
    expect(spawnDescription(h)).toContain('- worker [worker default]: prov/other-model, thinking low');

    await runModels(h, ['fast', 'prov/fast-model']);
    expect(spawnDescription(h)).toContain('- fast: prov/fast-model, pi default thinking');
    expect(h.models.targets()).toEqual(['orchestrator', 'worker', 'reviewer', 'primary', 'fast']);
  });
});

describe('/tower models', () => {
  it('shows the resolved models, the config files and any registry problems', async () => {
    const h = await harness({ global: { worker: 'prov/missing-model' } });

    const shown = await runModels(h, []);

    expect(shown.errors).toEqual([]);
    expect(shown.notices).toHaveLength(1);
    expect(shown.notices[0]?.title).toBe('Tower models');
    const body = shown.notices[0]?.body ?? '';
    expect(body).toMatch(/orchestrator\s+prov\/session-model\s+medium \(session\)\s+session model/);
    expect(body).toMatch(/worker\s+prov\/missing-model\s+pi default\s+/);
    expect(body).toContain(`global config: ${h.globalPath} (loaded)`);
    expect(body).toContain(`project config: ${h.projectPath} (not found)`);
    expect(body).toContain('Problems:');
    expect(body).toContain('- worker: model "prov/missing-model"');
  });

  it('writes the global tower.json by default and --project writes the project file', async () => {
    const h = await harness();

    const global = await runModels(h, ['worker', 'prov/other-model:low']);
    expect(global.errors).toEqual([]);
    expect(global.warnings).toEqual([]);
    expect(await readConfig(h.globalPath)).toEqual({ worker: 'prov/other-model:low' });
    expect(global.notices[0]?.body).toContain(`Set worker = prov/other-model:low in ${h.globalPath}.`);

    const project = await runModels(h, ['reviewer', 'prov/review-model', '--project']);
    expect(project.warnings).toEqual([]);
    expect(await readConfig(h.projectPath)).toEqual({ reviewer: 'prov/review-model' });
    expect(project.notices[0]?.body).toContain(`Set reviewer = prov/review-model in ${h.projectPath}.`);

    const again = await runModels(h, ['reviewer', 'prov/review-model', '--project']);
    expect(again.notices[0]?.body).toContain(`reviewer is already prov/review-model in ${h.projectPath}.`);
  });

  it('maps primary to the orchestrator and pool aliases to models.<alias>', async () => {
    const h = await harness();

    const primary = await runModels(h, ['primary', 'prov/orch-model']);
    const alias = await runModels(h, ['fast', 'prov/fast-model:minimal']);

    expect(primary.notices[0]?.body).toContain(`Set orchestrator = prov/orch-model in ${h.globalPath}.`);
    expect(alias.notices[0]?.body).toContain(`Set models.fast = prov/fast-model:minimal in ${h.globalPath}.`);
    expect(await readConfig(h.globalPath)).toEqual({
      orchestrator: 'prov/orch-model',
      models: { fast: 'prov/fast-model:minimal' },
    });
  });

  it('tells the user how to apply an orchestrator change while tower mode is on', async () => {
    const h = await harness();
    await h.controller.enter();

    const written = await runModels(h, ['orchestrator', 'prov/orch-model']);

    expect(written.notices[0]?.body).toContain(
      'The orchestrator model is applied when tower mode turns on — run /tower off and /tower on, or switch this session now with /model.',
    );
  });

  it('warns when a flag, an environment variable or the project file shadows the written value', async () => {
    const h = await harness({
      flags: { 'tower-worker-model': 'prov/flag-worker' },
      env: { PI_TOWER_REVIEWER_MODEL: 'prov/env-reviewer' },
      project: { orchestrator: 'prov/project-orch' },
    });

    const flag = await runModels(h, ['worker', 'prov/other-worker']);
    const env = await runModels(h, ['reviewer', 'prov/other-reviewer']);
    const project = await runModels(h, ['orchestrator', 'prov/global-orch']);

    expect(flag.warnings).toEqual([
      `worker is shadowed by --tower-worker-model, which takes precedence — the value written to ${h.globalPath} is not in effect.`,
    ]);
    expect(env.warnings).toEqual([
      `reviewer is shadowed by env PI_TOWER_REVIEWER_MODEL, which takes precedence — the value written to ${h.globalPath} is not in effect.`,
    ]);
    expect(project.warnings).toEqual([
      `orchestrator is shadowed by ${h.projectPath} (project), which takes precedence — the value written to ${h.globalPath} is not in effect.`,
    ]);
  });

  it('warns that a project file written in an untrusted project has no effect yet', async () => {
    const h = await harness({ trusted: false, global: { worker: 'prov/global-worker' } });

    const written = await runModels(h, ['worker', 'prov/project-worker', '--project']);

    expect(await readConfig(h.projectPath)).toEqual({ worker: 'prov/project-worker' });
    expect(written.warnings).toEqual([
      `This project is not trusted, so ${h.projectPath} is ignored until you trust the project — the change was written but has no effect yet.`,
    ]);
    expect(written.notices[0]?.body).toContain(`project config: ${h.projectPath} (ignored — project not trusted)`);

    const unchanged = await runModels(h, ['worker', 'prov/project-worker', '--project']);
    expect(unchanged.warnings).toEqual([]);
  });

  it('--clear removes the entry and reports when another source still sets it', async () => {
    const h = await harness({
      global: { worker: 'prov/w', reviewer: 'prov/r' },
      project: { reviewer: 'prov/project-r' },
    });

    const cleared = await runModels(h, ['worker', '--clear']);
    expect(cleared.notices[0]?.body).toContain(`Cleared worker in ${h.globalPath}.`);
    expect(cleared.warnings).toEqual([]);
    expect(await readConfig(h.globalPath)).toEqual({ reviewer: 'prov/r' });

    const nothing = await runModels(h, ['worker', '--clear']);
    expect(nothing.notices[0]?.body).toContain(`worker was not set in ${h.globalPath} — nothing changed.`);

    const shadowed = await runModels(h, ['reviewer', '--clear']);
    expect(shadowed.warnings).toEqual([`reviewer is still set by ${h.projectPath} (project).`]);
    expect(await readConfig(h.globalPath)).toEqual({});
  });

  it('rejects malformed invocations with the usage text', async () => {
    const h = await harness();

    for (const args of [['worker'], ['worker', 'a/b', 'c'], ['--clear'], ['worker', 'prov/x', '--clear'], ['--project']]) {
      const refused = await runModels(h, args);
      expect(refused.errors).toEqual([TOWER_MODELS_USAGE]);
      expect(refused.notices).toEqual([]);
    }
    expect((await runModels(h, ['worker', 'prov/x', '--global'])).errors).toEqual([
      `Unknown option --global. ${TOWER_MODELS_USAGE}`,
    ]);
  });

  it('surfaces config errors and file-system failures as readable errors without touching the files', async () => {
    const h = await harness();

    const invalid = await runModels(h, ['worker', 'nonsense']);
    expect(invalid.errors).toHaveLength(1);
    expect(invalid.errors[0]).toMatch(/^Invalid tower config — /);
    expect(invalid.errors[0]).toContain('worker');
    await expect(readFile(h.globalPath, 'utf8')).rejects.toThrow();

    const reserved = await runModels(h, ['models.primary', 'prov/x']);
    expect(reserved.errors[0]).toMatch(/^Invalid tower config — /);

    const fileAgentDir = join(h.agentDir, 'not-a-directory');
    await writeFile(fileAgentDir, 'plain file\n');
    const blocked = await harness({ repo: h.repo, agentDir: fileAgentDir });
    const failed = await runModels(blocked, ['worker', 'prov/x']);
    expect(failed.errors).toHaveLength(1);
    expect(failed.errors[0]).toMatch(/^Failed to update the tower model config: /);
  });
});

describe('orchestrator model switch', () => {
  it('switches to the configured orchestrator on enter and restores the session model on exit', async () => {
    const h = await harness({ global: { orchestrator: 'prov/orch-model:high' } });
    const orchestrator = h.ctx.modelRegistry.add('prov', 'orch-model');

    expect(await h.controller.enter()).toEqual({ entered: true });

    expect(h.pi.modelChanges).toEqual([orchestrator]);
    expect(h.ctx.model).toBe(orchestrator);
    expect(h.pi.thinkingLevel).toBe('high');
    expect(lastModeRecord(h)).toMatchObject({
      active: true,
      previousModel: { provider: 'prov', modelId: 'session-model' },
      previousThinkingLevel: 'medium',
      orchestratorModel: { provider: 'prov', modelId: 'orch-model' },
    });
    expect(spawnDescription(h)).toContain('- orchestrator (alias primary): prov/orch-model, thinking high');

    await h.controller.exit();

    expect(h.pi.modelChanges).toEqual([orchestrator, h.sessionModel]);
    expect(h.ctx.model).toBe(h.sessionModel);
    expect(h.pi.thinkingLevel).toBe('medium');
    expect(lastModeRecord(h)).toEqual({ active: false });
  });

  it('leaves a model the user picked while tower mode was on', async () => {
    const h = await harness({ global: { orchestrator: 'prov/orch-model:high' } });
    const orchestrator = h.ctx.modelRegistry.add('prov', 'orch-model');
    await h.controller.enter();

    const picked = h.ctx.modelRegistry.add('prov', 'picked-model');
    h.ctx.model = picked;
    h.pi.thinkingLevel = 'low';
    await h.controller.exit();

    expect(h.pi.modelChanges).toEqual([orchestrator]);
    expect(h.ctx.model).toBe(picked);
    expect(h.pi.thinkingLevel).toBe('low');
  });

  it('never switches when the orchestrator comes from the session', async () => {
    const h = await harness();

    await h.controller.enter();
    await h.controller.exit();

    expect(h.pi.modelChanges).toEqual([]);
    expect(h.pi.thinkingLevel).toBe('medium');
    const records = h.pi.appended.filter((entry) => entry.customType === TOWER_MODE_ENTRY).map((entry) => entry.data);
    expect(records[0]).not.toHaveProperty('orchestratorModel');
  });

  it('only changes the thinking level when the orchestrator is already the session model', async () => {
    const h = await harness({ global: { orchestrator: 'prov/session-model:xhigh' } });

    await h.controller.enter();
    expect(h.pi.modelChanges).toEqual([]);
    expect(h.pi.thinkingLevel).toBe('xhigh');

    await h.controller.exit();
    expect(h.pi.modelChanges).toEqual([]);
    expect(h.pi.thinkingLevel).toBe('medium');
  });

  it('stays on the session model with a warning when the orchestrator is unknown or has no credentials', async () => {
    const unknown = await harness({ global: { orchestrator: 'prov/ghost-model' } });
    expect(await unknown.controller.enter()).toEqual({ entered: true });
    expect(unknown.pi.modelChanges).toEqual([]);
    expect(unknown.ctx.ui.notices).toContainEqual({
      message: "Tower orchestrator model prov/ghost-model is not in pi's model registry — staying on prov/session-model.",
      level: 'warning',
    });
    expect(lastModeRecord(unknown)).not.toHaveProperty('orchestratorModel');

    const locked = await harness({ global: { orchestrator: 'prov/locked-model' } });
    locked.ctx.modelRegistry.add('prov', 'locked-model');
    locked.pi.setModelResult = false;
    expect(await locked.controller.enter()).toEqual({ entered: true });
    expect(locked.ctx.model).toBe(locked.sessionModel);
    expect(locked.ctx.ui.notices).toContainEqual({
      message: 'Tower orchestrator model prov/locked-model has no configured credentials — staying on prov/session-model.',
      level: 'warning',
    });
    expect(locked.controller.isActive).toBe(true);
  });

  it('restores the pre-tower model after pi restarts with tower mode still on', async () => {
    const first = await harness({ global: { orchestrator: 'prov/orch-model:high' } });
    const orchestrator = first.ctx.modelRegistry.add('prov', 'orch-model');
    await first.controller.enter();
    expect(first.ctx.model).toBe(orchestrator);

    const second = await harness({
      repo: first.repo,
      agentDir: first.agentDir,
      entries: [...first.session.entries],
      sessionModel: ['prov', 'orch-model'],
    });
    second.pi.thinkingLevel = 'high';
    const previous = second.ctx.modelRegistry.add('prov', 'session-model');
    expect(second.controller.isActive).toBe(true);

    await second.controller.exit();

    expect(second.pi.modelChanges).toEqual([previous]);
    expect(second.ctx.model).toBe(previous);
    expect(second.pi.thinkingLevel).toBe('medium');
  });
});
