import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';

import { TOWER_TEARDOWN_PROMPT, unknownAgentRefusal } from '../prompts/index.ts';
import { MAIN_AGENT_ID, branchExists } from '../protocol/index.ts';
import { knownAgentNames, loadRoster, resolveAgentRef } from '../tools/agents.ts';
import { readTowerStatusSummary } from '../tools/status/statusReader.ts';
import { renderTowerTasks } from '../tools/tasks/tasksTool.ts';
import { towerEnterFailureMessage, type TowerController } from './controller.ts';

export const TOWER_COMMAND_DESCRIPTION =
  'Tower multi-agent mode: /tower on | off | status | teardown | <base-branch> | models [<role|alias> <provider/model[:thinking]>|--clear] [--project] | agents | stop <agent> | help';

export const TOWER_SUBCOMMANDS: readonly { readonly value: string; readonly description: string }[] = [
  { value: 'on', description: 'Turn tower mode on (the main agent becomes the tower)' },
  { value: 'off', description: 'Turn tower mode off; agents keep running and .tower/ stays on disk' },
  { value: 'status', description: 'Show the tower dashboard without a model turn' },
  { value: 'teardown', description: 'Ask the tower to remove the finished mission worktrees' },
  { value: 'models', description: 'Show or set the orchestrator, worker and reviewer models' },
  { value: 'agents', description: 'List the background workers and reviewers and their status' },
  { value: 'stop', description: 'Stop a running worker or reviewer (a human stop: it is never resumed)' },
  { value: 'help', description: 'Show the /tower usage' },
];

export const TOWER_COMMAND_USAGE = [
  '/tower on — turn tower mode on (the main agent becomes the tower)',
  '/tower off — turn tower mode off; agents keep running and .tower/ stays on disk',
  '/tower or /tower status — show the tower dashboard without a model turn',
  '/tower teardown — ask the tower to remove the finished mission worktrees',
  '/tower <base-branch> — turn tower mode on with that local branch as the base (a missing branch is created from HEAD)',
  '/tower models [<role|alias> <provider/model[:thinking]>|<role|alias> --clear] [--project] — show or set the orchestrator, worker and reviewer models',
  '/tower agents — list the background workers and reviewers',
  '/tower stop <agent> — stop a running worker or reviewer (a human stop: it is never resumed)',
  '/tower help — show this help',
].join('\n');

const NO_ARGUMENT_SUBCOMMANDS = new Set(['on', 'off', 'status', 'teardown', 'agents', 'help']);

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

export interface TowerCommandDeps {
  readonly sendUserMessage: (text: string, options?: { readonly deliverAs?: 'steer' | 'followUp' }) => void;
  readonly models?: (args: readonly string[], ui: TowerCommandUi) => Promise<void>;
}

export function commandUi(ctx: ExtensionCommandContext): TowerCommandUi {
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
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    ui.notice('Tower command', TOWER_COMMAND_USAGE);
    return;
  }
  const typo = towerSubcommandTypo(words);
  if (typo !== undefined) {
    ui.error(typo);
    return;
  }
  if (!(await confirmNewBaseBranch(controller, ctx, input))) {
    ui.status(`Cancelled — branch "${input}" was not created and tower mode is unchanged.`);
    return;
  }
  await startTowerWithBase(controller, ui, input);
}

async function confirmNewBaseBranch(
  controller: TowerController,
  ctx: ExtensionCommandContext,
  base: string,
): Promise<boolean> {
  if (!ctx.hasUI) return true;
  let exists = false;
  try {
    exists = await branchExists(controller.repoRoot, base);
  } catch {
    exists = false;
  }
  if (exists) return true;
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

async function setTowerMode(
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

async function humanStop(controller: TowerController, ui: TowerCommandUi, ref: string): Promise<void> {
  const target = ref.trim();
  if (target.length === 0) {
    ui.error('Usage: /tower stop <agent> — pass the roster name, agent id, or task id of a running agent');
    return;
  }
  try {
    const state = await loadRoster(controller);
    const resolved = resolveAgentRef(state, target);
    const info = controller.agentInfo(resolved.id);
    if (info === undefined) {
      ui.error(unknownAgentRefusal(target, knownAgentNames(state, controller.listAgents(false))));
      return;
    }
    const result = await controller.humanStop(resolved.id);
    if (result === 'stopped') {
      ui.notice(
        `Stopped ${info.name}`,
        `${info.name} (agent_id: ${info.agentId}) is stopped by you — dead by intent: the tower will not resume, reassign, or replace it unless you say so.`,
      );
      return;
    }
    if (result === 'idle' || (result === 'missing' && info.status !== 'running')) {
      ui.status(`${info.name} is not running — nothing was stopped.`);
      return;
    }
    ui.error(unknownAgentRefusal(target, knownAgentNames(state, controller.listAgents(false))));
  } catch (error) {
    ui.error(`Failed to stop ${target}: ${errorText(error)}`);
  }
}

function idle(ctx: ExtensionCommandContext): boolean {
  try {
    return ctx.isIdle();
  } catch {
    return true;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
