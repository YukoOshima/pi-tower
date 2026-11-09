import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { InputEvent, InputEventResult, SessionStartEvent } from '@earendil-works/pi-coding-agent';

import { handleMissionCommand } from '../../src/mission/command.ts';
import { MISSION_STATUS_KEY, MISSION_WIDGET_KEY } from '../../src/mission/constants.ts';
import { MissionMode } from '../../src/mission/mode.ts';
import type { MissionTimers } from '../../src/mission/refresher.ts';
import { TowerStore } from '../../src/protocol/index.ts';
import type { ObjectiveSettingsValues, TowerCommandUi, TowerObjectiveCommandHooks } from '../../src/tower/command.ts';
import { TowerController } from '../../src/tower/controller.ts';
import { TowerModels } from '../../src/tower/models.ts';
import {
  FakeContext,
  FakePi,
  FakeRuntime,
  FakeSessionManager,
  createRepo,
  type FakeEntry,
} from '../tower/fakes.ts';

export const SESSION_ID = 'session-mission';
export const FOREIGN_PID = 515_151;
export const START: SessionStartEvent = { type: 'session_start', reason: 'startup' };

export interface Recorded {
  readonly notices: { readonly title: string; readonly body?: string }[];
  readonly statuses: string[];
  readonly warnings: string[];
  readonly errors: string[];
}

export function recordingUi(): { readonly ui: TowerCommandUi; readonly recorded: Recorded } {
  const recorded: Recorded = { notices: [], statuses: [], warnings: [], errors: [] };
  return {
    recorded,
    ui: {
      notice: (title, body) => {
        recorded.notices.push(body === undefined ? { title } : { title, body });
      },
      status: (text) => {
        recorded.statuses.push(text);
      },
      warn: (text) => {
        recorded.warnings.push(text);
      },
      error: (text) => {
        recorded.errors.push(text);
      },
    },
  };
}

export class ManualTimers implements MissionTimers {
  private time: number;
  private counter = 0;
  private readonly timeouts = new Map<number, { readonly at: number; readonly callback: () => void }>();
  private readonly intervals = new Map<number, { readonly every: number; next: number; readonly callback: () => void }>();

  constructor(start = Date.now()) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    this.counter += 1;
    this.timeouts.set(this.counter, { at: this.time + ms, callback });
    return this.counter;
  }

  clearTimeout(handle: unknown): void {
    this.timeouts.delete(handle as number);
  }

  setInterval(callback: () => void, ms: number): unknown {
    this.counter += 1;
    this.intervals.set(this.counter, { every: ms, next: this.time + ms, callback });
    return this.counter;
  }

  clearInterval(handle: unknown): void {
    this.intervals.delete(handle as number);
  }

  get pendingTimeouts(): number {
    return this.timeouts.size;
  }

  get activeIntervals(): number {
    return this.intervals.size;
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = this.nextDue(target);
      if (due === undefined) break;
      this.time = due.at;
      due.run();
    }
    this.time = target;
  }

  private nextDue(limit: number): { readonly at: number; readonly run: () => void } | undefined {
    let best: { readonly at: number; readonly run: () => void } | undefined;
    for (const [id, timeout] of this.timeouts) {
      if (timeout.at > limit || (best !== undefined && timeout.at >= best.at)) continue;
      best = {
        at: timeout.at,
        run: () => {
          this.timeouts.delete(id);
          timeout.callback();
        },
      };
    }
    for (const interval of this.intervals.values()) {
      if (interval.next > limit || (best !== undefined && interval.next >= best.at)) continue;
      best = {
        at: interval.next,
        run: () => {
          interval.next += interval.every;
          interval.callback();
        },
      };
    }
    return best;
  }
}

export interface SelectCall {
  readonly title: string;
  readonly options: readonly string[];
  readonly signal: AbortSignal | undefined;
  readonly answer: (value: string | undefined) => void;
}

export interface WidgetCall {
  readonly key: string;
  readonly lines: readonly string[] | undefined;
  readonly placement: string | undefined;
}

export class MissionContext extends FakeContext {
  readonly selects: SelectCall[] = [];
  readonly widgetCalls: WidgetCall[] = [];
  readonly statusCalls: { readonly key: string; readonly text: string | undefined }[] = [];
  selectFailure: Error | undefined;

  constructor(cwd: string, session: FakeSessionManager) {
    super(cwd, session);
    const record = this.ui.setStatus.bind(this.ui);
    Object.assign(this.ui, {
      select: (title: string, options: string[], opts?: { readonly signal?: AbortSignal }): Promise<string | undefined> => {
        if (this.selectFailure !== undefined) return Promise.reject(this.selectFailure);
        return new Promise((resolve) => {
          if (opts?.signal?.aborted === true) {
            resolve(undefined);
            return;
          }
          opts?.signal?.addEventListener(
            'abort',
            () => {
              resolve(undefined);
            },
            { once: true },
          );
          this.selects.push({ title, options: [...options], signal: opts?.signal, answer: resolve });
        });
      },
      setWidget: (key: string, lines: string[] | undefined, options?: { readonly placement?: string }): void => {
        this.widgetCalls.push({ key, lines: lines === undefined ? undefined : [...lines], placement: options?.placement });
      },
      setStatus: (key: string, text: string | undefined): void => {
        this.statusCalls.push({ key, text });
        record(key, text);
      },
    });
  }

  widget(key = MISSION_WIDGET_KEY): readonly string[] | undefined {
    return this.widgetCalls.filter((call) => call.key === key).at(-1)?.lines;
  }

  missionStatus(): string | undefined {
    return this.ui.statuses.get(MISSION_STATUS_KEY);
  }
}

export interface FakeHooks extends TowerObjectiveCommandHooks {
  readonly ticks: string[];
  settings: ObjectiveSettingsValues;
}

export function fakeHooks(): FakeHooks {
  const hooks: FakeHooks = {
    ticks: [],
    settings: {
      autopilot: true,
      autoApprove: false,
      maxValidationRounds: 3,
      maxFeatureAttempts: 3,
      skipScrutiny: false,
      skipUserTesting: false,
    },
    async autopilotTick(reason) {
      hooks.ticks.push(reason);
    },
    objectiveSettings: () => hooks.settings,
  };
  return hooks;
}

export interface MissionHarnessOptions {
  readonly repo?: string;
  readonly global?: unknown;
  readonly entries?: FakeEntry[];
  readonly sessionModel?: readonly [string, string];
  readonly throttleMs?: number;
  readonly tickMs?: number;
}

export interface MissionHarness {
  readonly repo: string;
  readonly agentDir: string;
  readonly session: FakeSessionManager;
  readonly ctx: MissionContext;
  readonly pi: FakePi;
  readonly runtime: FakeRuntime;
  readonly models: TowerModels;
  readonly controller: TowerController;
  readonly mission: MissionMode;
  readonly timers: ManualTimers;
  readonly hooks: FakeHooks;
  readonly store: TowerStore;
  run(args: string): Promise<Recorded>;
  input(text: string, extra?: Partial<Omit<InputEvent, 'type' | 'text'>>): Promise<InputEventResult>;
}

export async function missionHarness(cleanups: string[], options: MissionHarnessOptions = {}): Promise<MissionHarness> {
  const repo = options.repo ?? (await createRepo('mission-'));
  const agentDir = await mkdtemp(join(tmpdir(), 'mission-agent-'));
  cleanups.push(...(options.repo === undefined ? [repo] : []), agentDir);
  if (options.global !== undefined) await writeJson(join(agentDir, 'tower.json'), options.global);
  const session = new FakeSessionManager(SESSION_ID, options.entries ?? []);
  const ctx = new MissionContext(repo, session);
  const [provider, id] = options.sessionModel ?? ['prov', 'session-model'];
  ctx.model = ctx.modelRegistry.add(provider, id);
  const pi = new FakePi();
  pi.session = session;
  pi.context = ctx;
  const models = new TowerModels({ agentDir, configDirName: '.pi', env: {}, getFlag: (name) => pi.getFlag(name) });
  const runtime = new FakeRuntime();
  const controller = new TowerController({
    pi,
    models,
    createRuntime: () => runtime,
    isProcessAlive: (pid) => pid === process.pid || pid === FOREIGN_PID,
  });
  if (controller.runtime !== runtime) throw new Error('the fake runtime is not the controller runtime');
  const timers = new ManualTimers();
  const hooks = fakeHooks();
  const mission = new MissionMode({
    controller,
    pi,
    objective: hooks,
    timers,
    throttleMs: options.throttleMs ?? 0,
    tickMs: options.tickMs ?? 5_000,
  });
  controller.onChange((change) => {
    mission.onTowerChange(change);
  });
  await controller.onSessionStart(START, ctx.asContext);
  mission.onSessionStart(ctx.asContext);
  return {
    repo,
    agentDir,
    session,
    ctx,
    pi,
    runtime,
    models,
    controller,
    mission,
    timers,
    hooks,
    store: new TowerStore(repo),
    async run(args) {
      const { ui, recorded } = recordingUi();
      await handleMissionCommand(mission, controller, args, ctx.asCommandContext, ui);
      return recorded;
    },
    input(text, extra = {}) {
      return mission.onInput({ type: 'input', text, source: 'interactive', ...extra }, ctx.asContext);
    },
  };
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function plannedObjective(store: TowerStore): Promise<void> {
  if (!(await store.isInitialized())) await store.init(SESSION_ID, 'main');
  await store.draftObjective({
    title: 'CSV and JSON export',
    goal: 'Add a --format csv|json option to shop report',
    definitionOfDone: ['both formats work'],
    milestones: [{ title: 'Serializers' }, { title: 'CLI options' }],
  });
  await store.plan([
    { title: 'CSV serializer', scope: ['src/csv/**'], milestone: 'MS1' },
    { title: 'JSON serializer', scope: ['src/json/**'], milestone: 'MS1' },
  ]);
}

export async function awaitingApproval(store: TowerStore): Promise<void> {
  await plannedObjective(store);
  await store.requestObjectiveApproval();
}
