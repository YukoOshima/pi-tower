import type { ScenarioReport } from './report.ts';
import { sleep, type PiRpc, type PiToolRun } from './rpc.ts';
import { DEFAULT_GLOBAL_TIMEOUT_MS, DEFAULT_SCENARIO_TIMEOUT_MS, type E2eSettings, type ScenarioId } from './settings.ts';
import { agentTranscripts, summarizeTranscript, towerState, type RosterEntry } from './evidence.ts';
import { createToyRepo, launchPi, type RunRoot } from './workspace.ts';

export interface ScenarioContext {
  readonly settings: E2eSettings;
  readonly root: RunRoot;
  readonly report: ScenarioReport;
  readonly dir: string;
}

export interface ScenarioDefinition {
  readonly id: ScenarioId;
  readonly title: string;
  readonly mandatory: boolean;
  readonly timeoutMs?: number;
  readonly run: (ctx: ScenarioContext) => Promise<void>;
}

export function scenarioTimeoutMs(settings: E2eSettings, definition: ScenarioDefinition): number {
  return settings.scenarioTimeoutMs ?? definition.timeoutMs ?? DEFAULT_SCENARIO_TIMEOUT_MS;
}

export function globalTimeoutMs(settings: E2eSettings, selected: readonly ScenarioDefinition[]): number {
  return settings.globalTimeoutMs ?? DEFAULT_GLOBAL_TIMEOUT_MS + selected.reduce((sum, definition) => sum + (definition.timeoutMs ?? 0), 0);
}

export const TURN_TIMEOUT_MS = 6 * 60_000;

export interface TowerSession {
  readonly rpc: PiRpc;
  readonly repo: string;
}

export interface StartOptions {
  readonly towerConfig?: Record<string, unknown>;
  readonly extraArgs?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly label?: string;
  readonly repo?: string;
}

export function roleConfig(settings: E2eSettings, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orchestrator: settings.orchestrator.spec,
    worker: settings.worker.spec,
    reviewer: settings.reviewer.spec,
    ...extra,
  };
}

export async function startSession(ctx: ScenarioContext, options: StartOptions = {}): Promise<TowerSession> {
  const repo = options.repo ?? createToyRepo(ctx.dir);
  const rpc = launchPi(ctx.settings, ctx.root, {
    label: options.label ?? ctx.report.id,
    dir: ctx.dir,
    repo,
    towerConfig: options.towerConfig ?? roleConfig(ctx.settings),
    sessionModel: ctx.settings.session.spec,
    ...(options.extraArgs === undefined ? {} : { extraArgs: options.extraArgs }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const state = await rpc.send({ type: 'get_state' }, 60_000);
  if (state.success !== true) throw new Error(`pi did not start: ${String(state.error)}\n${rpc.stderr}`);
  ctx.report.note(`pi pid ${String(rpc.pid)} in ${repo}; session model ${String(state.data?.model?.provider)}/${String(state.data?.model?.id)} (thinking ${String(state.data?.thinkingLevel)})`);
  return { rpc, repo };
}

export async function sessionModel(rpc: PiRpc): Promise<string> {
  const state = await rpc.send({ type: 'get_state' });
  return `${String(state.data?.model?.provider)}/${String(state.data?.model?.id)}`;
}

export function runsOf(runs: readonly PiToolRun[], toolName: string): PiToolRun[] {
  return runs.filter((run) => run.toolName === toolName);
}

export function firstLine(text: string, pattern: RegExp): string | undefined {
  return text.split('\n').find((line) => pattern.test(line));
}

export async function recordUsage(ctx: ScenarioContext, session: TowerSession): Promise<void> {
  const stats = await session.rpc.send({ type: 'get_session_stats' }).catch(() => undefined);
  const data = stats?.data;
  if (data !== undefined) {
    ctx.report.addUsage('orchestrator session', {
      input: Number(data.tokens?.input ?? 0),
      output: Number(data.tokens?.output ?? 0),
      cacheRead: Number(data.tokens?.cacheRead ?? 0),
      cacheWrite: Number(data.tokens?.cacheWrite ?? 0),
      total: Number(data.tokens?.total ?? 0),
      cost: Number(data.cost ?? 0),
    });
  }
  recordAgentUsage(ctx, session.repo);
}

const USAGE_ROLES: Readonly<Record<string, string>> = { worker: 'workers', reviewer: 'reviewers', validator: 'validators' };

export function recordAgentUsage(ctx: ScenarioContext, repo: string, retired: readonly RosterEntry[] = []): void {
  const roster = [...(towerState(repo)?.roster.agents ?? []), ...retired];
  for (const path of agentTranscripts(repo)) {
    const id = /_(agent-[0-9a-f]+)\.jsonl$/.exec(path)?.[1];
    const kind = roster.find((agent) => agent.agentId === id)?.kind ?? '';
    ctx.report.addUsage(USAGE_ROLES[kind] ?? 'tower agents', summarizeTranscript(path).usage);
  }
}

export function runningAgents(agentsText: string): string[] {
  return agentsText
    .split('\n')
    .filter((line) => /status: running/.test(line))
    .map((line) => /^- (\S+)/.exec(line)?.[1] ?? line);
}

export interface DriveOptions {
  readonly label: string;
  readonly timeoutMs: number;
  readonly nudge: string;
  readonly maxNudges?: number;
  readonly idleMs?: number;
}

export async function driveUntil(ctx: ScenarioContext, rpc: PiRpc, done: () => boolean, options: DriveOptions): Promise<number> {
  const deadline = Date.now() + options.timeoutMs;
  const idleMs = options.idleMs ?? 75_000;
  let nudges = 0;
  for (;;) {
    if (rpc.exitCode !== undefined) throw new Error(`pi exited (${String(rpc.exitCode)}) while waiting for ${options.label}`);
    if (done()) {
      await rpc.waitIdle(TURN_TIMEOUT_MS, 3000);
      if (done()) return nudges;
    }
    if (Date.now() > deadline) throw new Error(`timeout after ${String(options.timeoutMs)}ms waiting for ${options.label}`);
    if (!rpc.running && Date.now() - rpc.lastEventAt > idleMs) {
      const running = runningAgents((await rpc.command('/tower agents')).text);
      if (running.length === 0) {
        if (nudges >= (options.maxNudges ?? 2)) throw new Error(`the tower stalled (idle, no running agents) before ${options.label}`);
        nudges += 1;
        ctx.report.note(`nudge ${String(nudges)}: the tower was idle for ${String(Math.round(idleMs / 1000))}s with no running agents before ${options.label}`);
        await rpc.send({ type: 'prompt', message: options.nudge, streamingBehavior: 'followUp' });
      }
    }
    await sleep(3000);
  }
}
