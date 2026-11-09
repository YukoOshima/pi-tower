import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';

import { TOWER_OBJECTIVE_DEFAULTS } from '../config/index.ts';
import { TOWER_TEARDOWN_PROMPT, unknownAgentRefusal } from '../prompts/index.ts';
import { formatDuration, formatUsd } from '../prompts/objectiveFormat.ts';
import { buildObjectivePlanningPrompt } from '../prompts/objectivePlanning.ts';
import { renderObjectiveStatus } from '../prompts/objectiveStatus.ts';
import {
  MAIN_AGENT_ID,
  branchExists,
  canPlanObjective,
  currentMilestone,
  isInsideRepo,
  objectiveMissions,
  type TowerObjective,
  type TowerObjectiveLimits,
  type TowerObjectiveLimitsInput,
  type TowerObjectiveMode,
  type TowerRosterEntry,
  type TowerState,
  type TowerStore,
  type TowerValidationKind,
} from '../protocol/index.ts';
import { knownAgentNames, loadRoster, resolveAgentRef } from '../tools/agents.ts';
import { readTowerStatusSummary } from '../tools/status/statusReader.ts';
import { renderTowerTasks } from '../tools/tasks/tasksTool.ts';
import { towerEnterFailureMessage, type TowerController } from './controller.ts';
import type { TowerAgentInfo } from './runtimeTypes.ts';

export const TOWER_COMMAND_DESCRIPTION =
  'Tower multi-agent mode: /tower on | off | status | teardown | <base-branch> | models [<role|alias> <provider/model[:thinking]>|--clear] [--project] | agents | stop <agent> | objective [--headless] <text | @file> | objective status | approve [--auto] | pause [reason] | resume | help';

export const TOWER_SUBCOMMANDS: readonly { readonly value: string; readonly description: string }[] = [
  { value: 'on', description: 'Turn tower mode on (the main agent becomes the tower)' },
  { value: 'off', description: 'Turn tower mode off; agents keep running and .tower/ stays on disk' },
  { value: 'status', description: 'Show the tower dashboard without a model turn' },
  { value: 'teardown', description: 'Ask the tower to remove the finished mission worktrees' },
  { value: 'models', description: 'Show or set the orchestrator, worker, reviewer and validator models' },
  { value: 'agents', description: 'List the background workers, reviewers and validators and their status' },
  { value: 'stop', description: 'Stop a running worker, reviewer or validator (a human stop: it is never resumed)' },
  {
    value: 'objective',
    description: 'Start an objective the fleet works on until its validation contract is met, or show its status',
  },
  { value: 'approve', description: "Approve the objective's plan so the fleet starts executing it" },
  { value: 'pause', description: 'Pause the executing objective; nothing new starts until /tower resume' },
  { value: 'resume', description: 'Resume a paused or blocked objective with the current objective settings' },
  { value: 'help', description: 'Show the /tower usage' },
];

export const TOWER_COMMAND_USAGE = [
  '/tower on — turn tower mode on (the main agent becomes the tower)',
  '/tower off — turn tower mode off; agents keep running and .tower/ stays on disk',
  '/tower or /tower status — show the tower dashboard without a model turn',
  '/tower teardown — ask the tower to remove the finished mission worktrees',
  '/tower <base-branch> — turn tower mode on with that local branch as the base (a missing branch is created from HEAD)',
  '/tower models [<role|alias> <provider/model[:thinking]>|<role|alias> --clear] [--project] — show or set the orchestrator, worker, reviewer and validator models',
  '/tower agents — list the background workers, reviewers and validators',
  '/tower stop <agent> — stop a running worker, reviewer or validator (a human stop: it is never resumed)',
  '/tower objective [--headless] <text | @file> — hand an objective to the tower: it plans milestones and features (with you, or without questions when --headless), you approve, and the fleet works until every milestone passes validation',
  '/tower objective status — show the objective dashboard',
  "/tower approve [--auto] — approve the objective's plan (--auto records an automatic approval)",
  '/tower pause [reason] — pause the executing objective; running agents finish, nothing new starts',
  '/tower resume — resume a paused or blocked objective, refreshing its limits from the current objective settings',
  '/tower help — show this help',
].join('\n');

export const TOWER_OBJECTIVE_USAGE =
  'Usage: /tower objective [--headless] <text | @file> — describe the objective inline or point at a file with @path; /tower objective status shows the current objective';

const NO_ARGUMENT_SUBCOMMANDS = new Set(['on', 'off', 'status', 'teardown', 'agents', 'resume', 'help']);

const NEAR_MISSES: Readonly<Record<string, string>> = {
  model: '/tower models',
  config: '/tower models',
  configure: '/tower models',
  agent: '/tower agents',
  task: '/tower agents (or /tower stop <agent>)',
  tasks: '/tower agents (or /tower stop <agent>)',
  list: '/tower agents',
  ls: '/tower agents',
  start: '/tower on',
  enable: '/tower on',
  disable: '/tower off',
  stat: '/tower status',
  state: '/tower status',
  kill: '/tower stop <agent>',
  objectives: '/tower objective',
  goal: '/tower objective',
  approval: '/tower approve',
  accept: '/tower approve',
  unpause: '/tower resume',
  continue: '/tower resume',
};

export function towerSubcommandTypo(words: readonly string[]): string | undefined {
  const head = (words[0] ?? '').toLowerCase();
  if (NO_ARGUMENT_SUBCOMMANDS.has(head) && words.length > 1) {
    return `/tower ${head} takes no arguments — did you mean /tower ${head}? Run /tower help for usage.`;
  }
  const suggestion = Object.hasOwn(NEAR_MISSES, head) ? NEAR_MISSES[head] : undefined;
  if (suggestion !== undefined) {
    return `Unknown /tower subcommand "${words[0] ?? ''}" — did you mean ${suggestion}? Run /tower help for usage; /tower <base-branch> starts the tower on a branch.`;
  }
  if (words.length > 1) {
    return `"${words.join(' ')}" is not a branch name — /tower <base-branch> takes a single branch name. Run /tower help for usage.`;
  }
  return undefined;
}

export interface TowerCommandUi {
  notice(title: string, body?: string): void;
  status(text: string): void;
  warn(text: string): void;
  error(text: string): void;
}

export interface ObjectiveSettingsValues {
  readonly autopilot: boolean;
  readonly autoApprove: boolean;
  readonly maxValidationRounds: number;
  readonly maxFeatureAttempts: number;
  readonly skipScrutiny: boolean;
  readonly skipUserTesting: boolean;
  readonly maxWallTimeMs?: number;
  readonly maxCostUsd?: number;
}

export interface TowerObjectiveCommandHooks {
  autopilotTick(reason: string): Promise<void>;
  objectiveSettings(): ObjectiveSettingsValues;
}

export interface TowerCommandDeps {
  readonly sendUserMessage: (text: string, options?: { readonly deliverAs?: 'steer' | 'followUp' }) => void;
  readonly models?: (args: readonly string[], ui: TowerCommandUi) => Promise<void>;
  readonly objective?: TowerObjectiveCommandHooks;
}

export function commandUi(ctx: Pick<ExtensionContext, 'hasUI' | 'mode' | 'ui'>): TowerCommandUi {
  const emit = (text: string, level: 'info' | 'warning' | 'error'): void => {
    if (ctx.hasUI) {
      ctx.ui.notify(text, level);
      return;
    }
    if (ctx.mode === 'print') {
      (level === 'error' ? process.stderr : process.stdout).write(`${text}\n`);
    }
  };
  return {
    notice: (title, body) => emit(body === undefined ? title : `${title}\n${body}`, 'info'),
    status: (text) => emit(text, 'info'),
    warn: (text) => emit(text, 'warning'),
    error: (text) => emit(text, 'error'),
  };
}

export async function handleTowerCommand(
  controller: TowerController,
  args: string,
  ctx: ExtensionCommandContext,
  deps: TowerCommandDeps,
  ui: TowerCommandUi = commandUi(ctx),
): Promise<void> {
  controller.observe(ctx);
  const input = args.trim();
  const words = input.length === 0 ? [] : input.split(/\s+/);
  const sub = input.toLowerCase();
  const head = (words[0] ?? '').toLowerCase();
  const rest = input.slice((words[0] ?? '').length).trim();

  if (sub === 'on') {
    await applyTowerMode(controller, ui, true);
    return;
  }
  if (sub === 'off') {
    await applyTowerMode(controller, ui, false);
    return;
  }
  if (sub === '' || sub === 'status') {
    await showTowerStatus(controller, ui);
    return;
  }
  if (sub === 'teardown') {
    deps.sendUserMessage(TOWER_TEARDOWN_PROMPT, idle(ctx) ? undefined : { deliverAs: 'followUp' });
    return;
  }
  if (head === 'models') {
    if (deps.models === undefined) {
      ui.error('Tower model configuration is not available in this build.');
      return;
    }
    await deps.models(words.slice(1), ui);
    return;
  }
  if (sub === 'agents') {
    try {
      ui.notice('Tower agents', await renderTowerTasks(controller, false));
    } catch (error) {
      ui.error(`Failed to list tower agents: ${errorText(error)}`);
    }
    return;
  }
  if (head === 'stop') {
    await humanStop(controller, ui, words.slice(1).join(' '));
    return;
  }
  if (head === 'objective') {
    await objectiveCommand(controller, ctx, deps, ui, rest);
    return;
  }
  if (head === 'approve') {
    await approveObjective(controller, deps, ui, words.slice(1));
    return;
  }
  if (head === 'pause') {
    await pauseObjective(controller, ui, rest);
    return;
  }
  if (sub === 'resume') {
    await resumeObjective(controller, deps, ui);
    return;
  }
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    ui.notice('Tower command', TOWER_COMMAND_USAGE);
    return;
  }
  const typo = towerSubcommandTypo(words);
  if (typo !== undefined && !(words.length === 1 && (await isLocalBranch(controller, input)))) {
    ui.error(typo);
    return;
  }
  if (!(await confirmNewBaseBranch(controller, ctx, input))) {
    ui.status(`Cancelled — branch "${input}" was not created and tower mode is unchanged.`);
    return;
  }
  await startTowerWithBase(controller, ui, input);
}

async function isLocalBranch(controller: TowerController, name: string): Promise<boolean> {
  try {
    return await branchExists(controller.repoRoot, name);
  } catch {
    return false;
  }
}

async function confirmNewBaseBranch(
  controller: TowerController,
  ctx: ExtensionCommandContext,
  base: string,
): Promise<boolean> {
  if (!ctx.hasUI || (await isLocalBranch(controller, base))) return true;
  return ctx.ui.confirm(
    `Create branch "${base}"?`,
    `"${base}" is not a local branch. /tower ${base} creates it from the current HEAD, switches the checkout to it, commits any uncommitted changes onto it as a snapshot, and makes it the tower base.`,
  );
}

export function towerCommandCompletions(
  prefix: string,
  options: { readonly agentNames?: () => readonly string[]; readonly modelTargets?: () => readonly string[] } = {},
): AutocompleteItem[] | null {
  const lower = prefix.toLowerCase();
  if (!lower.includes(' ')) {
    const items = TOWER_SUBCOMMANDS.filter((item) => item.value.startsWith(lower)).map((item) => ({
      value: item.value,
      label: item.value,
      description: item.description,
    }));
    return items.length > 0 ? items : null;
  }
  const [head = '', ...rest] = prefix.split(/\s+/);
  const partial = rest.join(' ');
  if (head.toLowerCase() === 'stop') {
    return completeWord(`${head} `, partial, options.agentNames?.() ?? []);
  }
  if (head.toLowerCase() === 'models') {
    if (rest.length <= 1) return completeWord(`${head} `, partial, options.modelTargets?.() ?? []);
    const last = rest.at(-1) ?? '';
    const typed = rest.slice(0, -1);
    const flags = rest.length === 2 ? ['--clear', '--project'] : ['--project'];
    return completeWord(
      prefix.slice(0, prefix.length - last.length),
      last,
      flags.filter((flag) => !typed.includes(flag)),
    );
  }
  if (head.toLowerCase() === 'objective' && rest.length <= 1) {
    return completeWord(`${head} `, partial, ['status', '--headless']);
  }
  if (head.toLowerCase() === 'approve' && rest.length <= 1) {
    return completeWord(`${head} `, partial, ['--auto']);
  }
  return null;
}

function completeWord(lead: string, partial: string, candidates: readonly string[]): AutocompleteItem[] | null {
  const items = candidates
    .filter((candidate) => candidate.startsWith(partial))
    .map((candidate) => ({ value: `${lead}${candidate}`, label: candidate }));
  return items.length > 0 ? items : null;
}

async function applyTowerMode(
  controller: TowerController,
  ui: TowerCommandUi,
  enabled: boolean,
): Promise<void> {
  const wasActive = controller.isActive;
  if (!(await setTowerMode(controller, ui, enabled))) return;
  if (wasActive === enabled) {
    ui.status(`Tower mode is already ${enabled ? 'on' : 'off'}.`);
    return;
  }
  ui.notice(enabled ? 'Tower mode: ON' : 'Tower mode: OFF');
}

async function startTowerWithBase(
  controller: TowerController,
  ui: TowerCommandUi,
  base: string,
): Promise<void> {
  const wasActive = controller.isActive;
  if (!(await setTowerMode(controller, ui, true, base))) return;
  ui.notice(wasActive ? `Tower base: ${base}` : `Tower mode: ON (base: ${base})`);
}

export async function setTowerMode(
  controller: TowerController,
  ui: TowerCommandUi,
  enabled: boolean,
  base?: string,
): Promise<boolean> {
  try {
    if (enabled) {
      const result = await controller.enter(base);
      if (!result.entered) {
        ui.error(`Tower mode could not be enabled — ${towerEnterFailureMessage(result)}.`);
        return false;
      }
    } else {
      await controller.exit('user');
    }
  } catch (error) {
    ui.error(`Failed to ${enabled ? 'enable' : 'disable'} tower mode: ${errorText(error)}`);
    return false;
  }
  if (controller.isActive !== enabled) {
    ui.error(enabled ? 'Tower mode could not be enabled.' : 'Tower mode could not be disabled.');
    return false;
  }
  return true;
}

export async function towerStatusSummary(controller: TowerController): Promise<string> {
  return readTowerStatusSummary({
    active: controller.isActive,
    store: controller.store(),
    agentId: MAIN_AGENT_ID,
    activeAgentIds: () => controller.activeAgentIds(),
    concurrency: () => controller.rateLimitSnapshot(),
  });
}

async function showTowerStatus(controller: TowerController, ui: TowerCommandUi): Promise<void> {
  try {
    const [title, ...rest] = (await towerStatusSummary(controller)).split('\n');
    ui.notice(title ?? 'Tower status', rest.length > 0 ? rest.join('\n') : undefined);
  } catch (error) {
    ui.error(`Failed to read tower status: ${errorText(error)}`);
  }
}

export type TowerHumanStopOutcome =
  | { readonly status: 'stopped'; readonly info: TowerAgentInfo }
  | { readonly status: 'not-running'; readonly info: TowerAgentInfo }
  | { readonly status: 'unknown'; readonly refusal: string };

export async function humanStopAgent(controller: TowerController, target: string): Promise<TowerHumanStopOutcome> {
  const state = await loadRoster(controller);
  const resolved = resolveAgentRef(state, target);
  const unknown = (): TowerHumanStopOutcome => ({
    status: 'unknown',
    refusal: unknownAgentRefusal(target, knownAgentNames(state, controller.listAgents(false))),
  });
  const info = controller.agentInfo(resolved.id);
  if (info === undefined) return unknown();
  const result = await controller.humanStop(resolved.id);
  if (result === 'stopped') return { status: 'stopped', info };
  if (result === 'idle' || (result === 'missing' && info.status !== 'running')) return { status: 'not-running', info };
  return unknown();
}

async function humanStop(controller: TowerController, ui: TowerCommandUi, ref: string): Promise<void> {
  const target = ref.trim();
  if (target.length === 0) {
    ui.error('Usage: /tower stop <agent> — pass the roster name, agent id, or task id of a running agent');
    return;
  }
  try {
    const outcome = await humanStopAgent(controller, target);
    switch (outcome.status) {
      case 'stopped':
        ui.notice(
          `Stopped ${outcome.info.name}`,
          `${outcome.info.name} (agent_id: ${outcome.info.agentId}) is stopped by you — dead by intent: the tower will not resume, reassign, or replace it unless you say so.`,
        );
        return;
      case 'not-running':
        ui.status(`${outcome.info.name} is not running — nothing was stopped.`);
        return;
      case 'unknown':
        ui.error(outcome.refusal);
        return;
    }
  } catch (error) {
    ui.error(`Failed to stop ${target}: ${errorText(error)}`);
  }
}

interface ObjectiveRequest {
  readonly mode: TowerObjectiveMode;
  readonly text?: string;
  readonly file?: string;
}

function parseObjectiveRequest(rest: string): ObjectiveRequest | undefined {
  const flag = /^--headless(?:\s+|$)/i.exec(rest);
  const mode: TowerObjectiveMode = flag === null ? 'interactive' : 'headless';
  const remaining = rest.slice(flag?.[0].length ?? 0).trim();
  if (remaining.length === 0 || remaining.startsWith('--')) return undefined;
  if (!remaining.startsWith('@')) return { mode, text: remaining };
  const file = remaining.slice(1).trim();
  return file.length === 0 ? undefined : { mode, file };
}

async function objectiveCommand(
  controller: TowerController,
  ctx: ExtensionCommandContext,
  deps: TowerCommandDeps,
  ui: TowerCommandUi,
  rest: string,
): Promise<void> {
  if (rest.toLowerCase() === 'status') {
    await showObjectiveStatus(controller, deps, ui);
    return;
  }
  const request = parseObjectiveRequest(rest);
  if (request === undefined) {
    ui.error(TOWER_OBJECTIVE_USAGE);
    return;
  }
  if (!controller.isActive) {
    ui.error('Tower mode is off — turn it on with /tower on, then hand the objective over with /tower objective.');
    return;
  }
  try {
    const send: TowerCommandDeps['sendUserMessage'] = (text, options) => {
      deps.sendUserMessage(text, options);
    };
    const outcome = await handOverObjective(controller, ctx, send, request);
    if (!outcome.handed) {
      ui.error(openObjectiveRefusal(outcome.open));
      return;
    }
    ui.notice(
      request.mode === 'headless' ? 'Objective handed to the tower (headless)' : 'Objective handed to the tower',
      [
        ...(outcome.initializedBase === undefined
          ? []
          : [`Initialized the tower workspace on base "${outcome.initializedBase}".`]),
        request.mode === 'headless'
          ? 'The orchestrator plans it without asking questions, records its assumptions as notes, and requests approval.'
          : 'The orchestrator plans it with you, then asks you to approve the plan with /tower approve.',
      ].join(' '),
    );
  } catch (error) {
    ui.error(`/tower objective failed: ${errorText(error)}`);
  }
}

export interface ObjectiveHandOverRequest {
  readonly mode: TowerObjectiveMode;
  readonly text?: string;
  readonly file?: string;
}

export type ObjectiveHandOverOutcome =
  | { readonly handed: true; readonly current?: TowerObjective; readonly initializedBase?: string }
  | { readonly handed: false; readonly open: TowerObjective };

export async function handOverObjective(
  controller: TowerController,
  ctx: Pick<ExtensionContext, 'cwd' | 'isIdle'>,
  send: TowerCommandDeps['sendUserMessage'],
  request: ObjectiveHandOverRequest,
): Promise<ObjectiveHandOverOutcome> {
  const file = request.file === undefined ? undefined : resolve(ctx.cwd, request.file);
  const text = file === undefined ? (request.text ?? '') : await readObjectiveFile(file);
  const workspace = await ensureTowerWorkspace(controller);
  const current = (await workspace.store.load()).objective;
  if (current !== undefined && !canPlanObjective(current)) return { handed: false, open: current };
  await workspace.store.setObjectiveMode(request.mode);
  send(
    buildObjectivePlanningPrompt({
      mode: request.mode,
      text,
      ...(file === undefined ? {} : { file }),
      ...(current === undefined ? {} : { current: { id: current.id, title: current.title, status: current.status } }),
    }),
    idle(ctx) ? undefined : { deliverAs: 'followUp' },
  );
  return {
    handed: true,
    ...(current === undefined ? {} : { current }),
    ...(workspace.initializedBase === undefined ? {} : { initializedBase: workspace.initializedBase }),
  };
}

async function readObjectiveFile(file: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`cannot read the objective file ${file}: ${errorText(error)}`);
  }
  if (text.trim().length === 0) throw new Error(`the objective file ${file} is empty`);
  return text;
}

export async function ensureTowerWorkspace(
  controller: TowerController,
): Promise<{ readonly store: TowerStore; readonly initializedBase?: string }> {
  const store = controller.store();
  if (await store.isInitialized()) return { store };
  if (await store.isStateLost()) {
    throw new Error(
      'tower state was lost — .tower/comms/state.json is missing while .tower/ still exists; check /tower status and let the tower recover it before handing over an objective',
    );
  }
  if (!(await isInsideRepo(controller.repoRoot))) {
    throw new Error(
      `${controller.repoRoot} is not a git repository — the tower needs one: run git init and commit what should become the base (check for secrets and large files first), then retry`,
    );
  }
  const result = await store.init(controller.sessionId);
  controller.noteRetiredAgents(result.retiredAgents);
  return { store, initializedBase: result.base };
}

function openObjectiveRefusal(objective: TowerObjective): string {
  const next =
    objective.status === 'awaiting-approval'
      ? 'approve its plan with /tower approve, or ask the tower to change it'
      : objective.status === 'paused'
        ? 'continue it with /tower resume, or ask the tower to block it first'
        : 'let the fleet finish it, ask the tower to block it, or wait until it completes or blocks — pausing does not help: a paused objective is refused too';
  return `Objective ${objective.id} "${objective.title}" is ${objective.status} — /tower objective plans a new objective only when none is open or the open one is still planning. See it with /tower objective status; ${next}.`;
}

export function objectiveSettingsOf(deps: Pick<TowerCommandDeps, 'objective'>): ObjectiveSettingsValues {
  return deps.objective?.objectiveSettings() ?? TOWER_OBJECTIVE_DEFAULTS;
}

export function skippedKinds(settings: ObjectiveSettingsValues): TowerValidationKind[] {
  return [
    ...(settings.skipScrutiny ? (['scrutiny'] as const) : []),
    ...(settings.skipUserTesting ? (['user-testing'] as const) : []),
  ];
}

export function liveRosterAgents(controller: TowerController, state: TowerState): TowerRosterEntry[] {
  const active = controller.activeAgentIds();
  return state.roster.agents.filter((agent) => agent.diedAt === undefined && active.has(agent.agentId));
}

export function objectiveStatusMarkdown(
  controller: TowerController,
  deps: Pick<TowerCommandDeps, 'objective'>,
  state: TowerState,
  objective: TowerObjective,
  nowMs: number,
): string {
  return renderObjectiveStatus({
    objective,
    features: objectiveMissions(state),
    agents: liveRosterAgents(controller, state),
    nowMs,
    skipKinds: skippedKinds(objectiveSettingsOf(deps)),
  });
}

async function showObjectiveStatus(
  controller: TowerController,
  deps: TowerCommandDeps,
  ui: TowerCommandUi,
): Promise<void> {
  try {
    const store = controller.store();
    if (!(await store.isInitialized()) && !(await store.isStateLost())) {
      ui.status('There is no objective — the tower workspace is not initialized yet.');
      return;
    }
    const state = await store.load();
    const objective = state.objective;
    if (objective === undefined) {
      ui.status('There is no objective — hand one to the tower with /tower objective <text | @file>.');
      return;
    }
    const [title = '', ...body] = objectiveStatusMarkdown(controller, deps, state, objective, Date.now()).split('\n');
    ui.notice(title.replace(/^#\s*/, ''), body.join('\n'));
  } catch (error) {
    ui.error(`Failed to read the objective status: ${errorText(error)}`);
  }
}

export async function approveTowerObjective(
  controller: TowerController,
  by: 'human' | 'auto',
): Promise<TowerObjective> {
  return controller.store().approveObjective(by);
}

export async function pauseTowerObjective(controller: TowerController, reason: string): Promise<TowerObjective> {
  return controller.store().pauseObjective(reason);
}

async function approveObjective(
  controller: TowerController,
  deps: TowerCommandDeps,
  ui: TowerCommandUi,
  args: readonly string[],
): Promise<void> {
  const auto = args.length === 1 && args[0]?.toLowerCase() === '--auto';
  if (args.length > 0 && !auto) {
    ui.error("Usage: /tower approve [--auto] — approve the objective's plan; --auto records an automatic approval");
    return;
  }
  let objective: TowerObjective;
  try {
    objective = await approveTowerObjective(controller, auto ? 'auto' : 'human');
  } catch (error) {
    ui.error(`Approval failed — ${errorText(error)}`);
    return;
  }
  const milestone = currentMilestone(objective);
  ui.notice(
    `Objective ${objective.id} approved — ${objective.status}`,
    [
      `"${objective.title}" was approved by ${auto ? 'auto' : 'human'}.`,
      ...(milestone === undefined ? [] : [`Milestone ${milestone.id} "${milestone.title}" is ${milestone.status}.`]),
      'Follow it with /tower objective status; /tower pause stops new work.',
    ].join(' '),
  );
  continueObjective(controller, deps, ui, 'approve');
}

async function pauseObjective(controller: TowerController, ui: TowerCommandUi, reason: string): Promise<void> {
  try {
    const objective = await pauseTowerObjective(controller, reason);
    ui.notice(
      `Objective ${objective.id} paused`,
      `Reason: ${objective.pausedReason ?? reason}. Running agents keep their current turn; nothing new starts until /tower resume.`,
    );
  } catch (error) {
    ui.error(`Pause failed — ${errorText(error)}`);
  }
}

export type TowerResumeOutcome =
  | { readonly status: 'resumed'; readonly objective: TowerObjective }
  | { readonly status: 'missing' }
  | { readonly status: 'not-resumable'; readonly objective: TowerObjective };

export async function resumeTowerObjective(
  controller: TowerController,
  settings: () => ObjectiveSettingsValues,
): Promise<TowerResumeOutcome> {
  const store = controller.store();
  const current = (await store.load()).objective;
  if (current === undefined) return { status: 'missing' };
  if (current.status !== 'paused' && current.status !== 'blocked') {
    return { status: 'not-resumable', objective: current };
  }
  await store.updateObjective({ limits: refreshedLimits(settings()) });
  return { status: 'resumed', objective: await store.resumeObjective() };
}

async function resumeObjective(
  controller: TowerController,
  deps: TowerCommandDeps,
  ui: TowerCommandUi,
): Promise<void> {
  let objective: TowerObjective;
  try {
    const outcome = await resumeTowerObjective(controller, () => objectiveSettingsOf(deps));
    if (outcome.status === 'missing') {
      ui.error('There is no objective to resume — hand one to the tower with /tower objective <text | @file>.');
      return;
    }
    if (outcome.status === 'not-resumable') {
      ui.error(
        `Resume failed — objective ${outcome.objective.id} is ${outcome.objective.status}; only a paused or blocked objective can be resumed.`,
      );
      return;
    }
    objective = outcome.objective;
  } catch (error) {
    ui.error(`Resume failed — ${errorText(error)}`);
    return;
  }
  ui.notice(
    `Objective ${objective.id} resumed — ${objective.status}`,
    `Limits from the current objective settings: ${describeLimits(objective.limits)}.`,
  );
  const exhausted = exhaustedBudgets(objective, Date.now());
  if (exhausted.length > 0) {
    ui.warn(
      `Objective ${objective.id} is over its ${exhausted.join(' and ')} — the autopilot pauses it again unless you raise the limit in the objective settings.`,
    );
  }
  continueObjective(controller, deps, ui, 'resume');
}

function refreshedLimits(settings: ObjectiveSettingsValues): TowerObjectiveLimitsInput {
  return {
    maxValidationRounds: settings.maxValidationRounds,
    maxFeatureAttempts: settings.maxFeatureAttempts,
    maxWallTimeMs: settings.maxWallTimeMs ?? null,
    maxCostUsd: settings.maxCostUsd ?? null,
  };
}

export function describeLimits(limits: TowerObjectiveLimits): string {
  return [
    `${String(limits.maxValidationRounds)} failed validation rounds per kind`,
    `${String(limits.maxFeatureAttempts)} attempts per feature`,
    `wall time ${limits.maxWallTimeMs === undefined ? 'unlimited' : formatDuration(limits.maxWallTimeMs)}`,
    `cost ${limits.maxCostUsd === undefined ? 'unlimited' : formatUsd(limits.maxCostUsd)}`,
  ].join(' · ');
}

export function exhaustedBudgets(objective: TowerObjective, nowMs: number): string[] {
  const exhausted: string[] = [];
  const { maxWallTimeMs, maxCostUsd } = objective.limits;
  const startedAt = objective.startedAt === undefined ? Number.NaN : Date.parse(objective.startedAt);
  if (maxWallTimeMs !== undefined && !Number.isNaN(startedAt) && nowMs - startedAt >= maxWallTimeMs) {
    exhausted.push(`wall-time limit (${formatDuration(nowMs - startedAt)} of ${formatDuration(maxWallTimeMs)})`);
  }
  const cost = objective.usage?.costUsd ?? 0;
  if (maxCostUsd !== undefined && cost >= maxCostUsd) {
    exhausted.push(`cost limit (${formatUsd(cost)} of ${formatUsd(maxCostUsd)})`);
  }
  return exhausted;
}

function continueObjective(
  controller: TowerController,
  deps: TowerCommandDeps,
  ui: TowerCommandUi,
  reason: 'approve' | 'resume',
): void {
  const continued = continueTowerObjective(controller, deps.objective, reason, (message) => {
    ui.error(`The autopilot tick after /tower ${reason} failed: ${message}`);
  });
  if (!continued) ui.status('Tower mode is off — the objective continues once you turn it on with /tower on.');
}

export function continueTowerObjective(
  controller: TowerController,
  hooks: TowerObjectiveCommandHooks | undefined,
  reason: 'approve' | 'resume',
  onTickFailure: (message: string) => void,
): boolean {
  if (!controller.isActive) return false;
  if (hooks === undefined) return true;
  void Promise.resolve()
    .then(() => hooks.autopilotTick(reason))
    .catch((error: unknown) => {
      try {
        onTickFailure(errorText(error));
      } catch {
        return;
      }
    });
  return true;
}

function idle(ctx: Pick<ExtensionContext, 'isIdle'>): boolean {
  try {
    return ctx.isIdle();
  } catch {
    return true;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
