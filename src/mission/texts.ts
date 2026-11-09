import { basename } from 'node:path';

import { MODEL_REF_FORMAT, type TowerModelOrigin, type TowerRole } from '../config/index.ts';
import type { TowerObjective, TowerObjectiveStatus } from '../protocol/index.ts';
import type { TowerModelsCommandTexts } from '../tower/modelsCommand.ts';

export const MISSION_COMMAND_DESCRIPTION =
  'Mission mode: /mission | <goal text | @file> | approve | pause [reason] | resume | models [<role> <provider/model[:thinking]>] | agents | stop <agent> | exit | help';

export const MISSIONS_COMMAND_DESCRIPTION = `Same as /mission — ${MISSION_COMMAND_DESCRIPTION}`;

export const MISSION_SUBCOMMANDS: readonly { readonly value: string; readonly description: string }[] = [
  { value: 'approve', description: 'Approve the plan and start the mission' },
  { value: 'pause', description: 'Pause the mission: running agents finish their turn, nothing new starts' },
  { value: 'resume', description: 'Resume a paused or blocked mission' },
  { value: 'models', description: 'Show or set the orchestrator, worker, reviewer and validator models' },
  { value: 'agents', description: 'List the workers, reviewers and validators and their status' },
  { value: 'stop', description: 'Stop a running worker, reviewer or validator (a human stop: it is never resumed)' },
  { value: 'exit', description: 'Leave mission mode (tower mode turns off; agents keep running)' },
  { value: 'off', description: 'Same as /mission exit' },
  { value: 'help', description: 'Show the /mission usage' },
];

export const MISSION_HELP_TITLE = 'Mission command';

export const MISSION_FILE_USAGE = 'Usage: /mission @<file> — the mission goal is read from that file';

export const MISSION_COMMAND_USAGE = [
  '/mission — enter mission mode: shows the models and asks what you want to build; with an open mission it shows Mission Control',
  '/mission <goal> or /mission @file — plan a mission for that goal right away (a goal that starts with a subcommand word: run /mission, then type it)',
  '/mission approve — approve the plan and start the mission; the features of each milestone run in parallel',
  '/mission pause [reason] — pause the mission: running agents finish their turn, nothing new starts',
  '/mission resume — resume a paused or blocked mission with the current settings',
  '/mission models [<role|alias> <provider/model[:thinking]>|<role|alias> --clear] [--project] — show or set the orchestrator, worker, reviewer and validator models',
  '/mission agents — list the workers, reviewers and validators',
  '/mission stop <agent> — stop a running worker, reviewer or validator (a human stop: it is never resumed)',
  '/mission exit (or /mission off) — leave mission mode; agents keep running and .tower/ stays on disk',
  '/mission help — show this help',
  'Talk to the orchestrator in plain language at any time. /missions is the same command; the /tower commands stay available for advanced control.',
].join('\n');

const NEAR_MISSES: Readonly<Record<string, string>> = {
  status: '/mission (it shows Mission Control)',
  show: '/mission (it shows Mission Control)',
  view: '/mission (it shows Mission Control)',
  on: '/mission',
  start: '/mission',
  enter: '/mission',
  quit: '/mission exit',
  leave: '/mission exit',
  close: '/mission exit',
  accept: '/mission approve',
  approval: '/mission approve',
  continue: '/mission resume',
  unpause: '/mission resume',
  model: '/mission models',
  config: '/mission models',
  agent: '/mission agents',
  list: '/mission agents',
  ls: '/mission agents',
  tasks: '/mission agents',
  kill: '/mission stop <agent>',
};

export function missionNearMiss(word: string): string | undefined {
  const key = word.toLowerCase();
  const suggestion = Object.hasOwn(NEAR_MISSES, key) ? NEAR_MISSES[key] : undefined;
  if (suggestion === undefined) return undefined;
  return `Unknown /mission subcommand "${word}" — did you mean ${suggestion}? A one-word goal is too short to plan: describe it in a sentence, or run /mission and type it. /mission help shows the usage.`;
}

export const MISSION_MODE_TITLE = 'Mission mode';
export const MISSION_CONTROL_TITLE = 'Mission Control';

export const MISSION_GOAL_QUESTION =
  "What do you want to build? Describe the goal. I'll ask a few questions, then propose a plan for your approval.";

export const MISSION_MODELS_HINT = 'Change a model with /mission models <role> <provider/model[:thinking]>';

export const MISSION_ROLE_LABELS: Readonly<Record<TowerRole, string>> = {
  orchestrator: 'Orchestrator',
  worker: 'Worker',
  reviewer: 'Reviewer',
  validator: 'Validator',
};

export const MISSION_LABEL_WIDTH = 14;

export function missionModelSource(origin: TowerModelOrigin): string {
  switch (origin.kind) {
    case 'session':
      return 'session model';
    case 'inherited':
      return `same as ${origin.from}`;
    case 'flag':
      return `--${origin.flag}`;
    case 'env':
      return `env ${origin.variable}`;
    case 'file':
      return `${origin.scope} ${basename(origin.path)}`;
  }
}

export function missionModelMissing(role: TowerRole): string {
  return `(none) — select a session model with /model, or set one with /mission models ${role} <provider/model[:thinking]>`;
}

export function missionModelsLoadError(error: string): string {
  return `could not be loaded: ${error} — fix tower.json, then check /mission models`;
}

export const MISSION_MODELS_NOT_LOADED = 'not loaded yet — /mission models shows them';

export function missionBaseLine(base: string, initialized: boolean, maxRunningAgents: number): string {
  return `${base}${initialized ? ' (tower workspace initialized now)' : ''} · features run in parallel (up to ${String(maxRunningAgents)} agents)`;
}

export function missionPreviousLine(objective: TowerObjective): string {
  return `Previous mission ${objective.id} "${objective.title}" is ${objective.status} — your goal starts a new one.`;
}

export function missionPlanningLine(goal: string): string {
  return `The orchestrator is planning your goal: "${preview(goal, 160)}". Answer its questions in plain messages; it drafts the mission and proposes a plan for your approval. /mission <goal> starts over with another goal.`;
}

export const MISSION_HANDED_TITLE = 'Mission goal handed to the orchestrator';

export function missionHandedBody(initializedBase: string | undefined): string {
  return [
    ...(initializedBase === undefined ? [] : [`Initialized the tower workspace on base "${initializedBase}".`]),
    'It asks a few questions, then proposes a plan — milestones whose features run in parallel — for your approval.',
  ].join(' ');
}

export function missionOpenRefusal(objective: TowerObjective): string {
  const next =
    objective.status === 'awaiting-approval'
      ? 'approve its plan with /mission approve, or tell the orchestrator what to change'
      : objective.status === 'paused'
        ? 'continue it with /mission resume, or ask the orchestrator to block it first'
        : 'let it finish, or ask the orchestrator to block it — /mission shows its progress';
  return `Mission ${objective.id} "${objective.title}" is ${objective.status} — a new mission starts only when none is open or the open one is still planning; ${next}.`;
}

export function missionNotARepository(root: string): string {
  return `${root} is not a git repository — mission mode needs one: run git init and commit what should become the base (check for secrets and large files first), then run /mission again.`;
}

export const MISSION_NO_COMMITS =
  'The repository has no commits yet — commit what should become the base, then run /mission again.';

export const MISSION_DETACHED_HEAD =
  'The checkout is on a detached HEAD, so mission mode cannot pick a base branch — check out a branch and run /mission again, or set the base with /tower <base-branch> (for example /tower main), then run /mission.';

export function missionWorkspaceFailure(error: string): string {
  return `Mission mode could not prepare the tower workspace: ${error}`;
}

export function missionFailure(error: string): string {
  return `/mission failed: ${error}`;
}

export function missionCommandsFor(status: TowerObjectiveStatus): readonly string[] {
  switch (status) {
    case 'planning':
      return [
        'Answer the orchestrator in plain language — it drafts the mission and proposes a plan for your approval',
        '/mission models — show or change the models',
        '/mission exit — leave mission mode',
      ];
    case 'awaiting-approval':
      return [
        '/mission approve — approve the plan and start the mission',
        'Tell the orchestrator what to change, in plain language',
        '/mission models — show or change the models',
        '/mission exit — leave mission mode',
      ];
    case 'executing':
      return [
        '/mission pause [reason] — pause: running agents finish their turn, nothing new starts',
        '/mission agents — list the agents; /mission stop <agent> stops one',
        '/mission models — show or change the models',
        'Talk to the orchestrator in plain language at any time',
        '/mission exit — leave mission mode (agents keep running)',
      ];
    case 'paused':
      return [
        '/mission resume — continue the mission',
        '/mission agents — list the agents; /mission stop <agent> stops one',
        'Tell the orchestrator what you see, or ask it to re-plan',
        '/mission exit — leave mission mode',
      ];
    case 'blocked':
      return [
        '/mission resume — continue once the blocker is resolved',
        '/mission <goal> — start a new mission instead',
        'Tell the orchestrator how to continue, in plain language',
        '/mission exit — leave mission mode',
      ];
    case 'completed':
      return ['/mission — start a new mission', '/mission exit — leave mission mode'];
  }
}

export function missionApprovedTitle(objective: TowerObjective): string {
  return `Mission ${objective.id} approved — ${objective.status}`;
}

export function missionApprovedBody(
  objective: TowerObjective,
  milestone: { readonly id: string; readonly title: string; readonly status: string } | undefined,
): string {
  const start =
    milestone === undefined
      ? `"${objective.title}" starts now.`
      : `"${objective.title}" starts now: milestone ${milestone.id} "${milestone.title}" is ${milestone.status} and its features run in parallel.`;
  return `${start} Mission Control above the editor follows it; /mission shows the details and /mission pause stops new work.`;
}

export function missionApprovalFailed(error: string): string {
  return `Approval failed — ${error}`;
}

export function missionTickFailed(reason: string, error: string): string {
  return `The autopilot tick after /mission ${reason} failed: ${error}`;
}

export const MISSION_CONTINUES_LATER = 'Tower mode is off — the mission continues once you run /mission.';

export function missionPausedTitle(objective: TowerObjective): string {
  return `Mission ${objective.id} paused`;
}

export function missionPausedBody(reason: string): string {
  return `Reason: ${reason}. Running agents finish their current turn; nothing new starts until /mission resume.`;
}

export function missionPauseFailed(error: string): string {
  return `Pause failed — ${error}`;
}

export const MISSION_NOTHING_TO_RESUME = 'There is no mission to resume — start one with /mission.';

export function missionNotResumable(objective: TowerObjective): string {
  return `Resume failed — mission ${objective.id} is ${objective.status}; only a paused or blocked mission can be resumed.`;
}

export function missionResumeFailed(error: string): string {
  return `Resume failed — ${error}`;
}

export function missionResumedTitle(objective: TowerObjective): string {
  return `Mission ${objective.id} resumed — ${objective.status}`;
}

export function missionResumedBody(limits: string): string {
  return `Limits from the current settings: ${limits}.`;
}

export function missionOverBudget(objective: TowerObjective, exhausted: readonly string[]): string {
  return `Mission ${objective.id} is over its ${exhausted.join(' and ')} — the autopilot pauses it again unless you raise the limit in the objective settings of tower.json.`;
}

export const MISSION_AGENTS_TITLE = 'Mission agents';

export function missionAgentsFailed(error: string): string {
  return `Failed to list the mission agents: ${error}`;
}

export const MISSION_STOP_USAGE =
  'Usage: /mission stop <agent> — pass the name, agent id or task id of a running worker, reviewer or validator';

export function missionStoppedTitle(name: string): string {
  return `Stopped ${name}`;
}

export function missionStoppedBody(name: string, agentId: string): string {
  return `${name} (agent_id: ${agentId}) is stopped by you — dead by intent: the orchestrator will not resume, reassign or replace it unless you say so.`;
}

export function missionNotRunning(name: string): string {
  return `${name} is not running — nothing was stopped.`;
}

export function missionStopFailed(target: string, error: string): string {
  return `Failed to stop ${target}: ${error}`;
}

export const MISSION_OFF_TITLE = 'Mission mode: OFF';
export const MISSION_OFF_BODY =
  'Tower mode is off as well; running agents keep running and .tower/ stays on disk. /mission enters mission mode again.';
export const MISSION_ALREADY_OFF = 'Mission mode is already off.';

export const MISSION_MODELS_TEXTS: TowerModelsCommandTexts = {
  title: 'Mission models',
  usage: `Usage: /mission models — show the orchestrator, worker, reviewer and validator models and the objective settings; /mission models <orchestrator|worker|reviewer|validator|alias> <${MODEL_REF_FORMAT}> [--project] — set one; /mission models <role|alias> --clear [--project] — remove it (the global tower.json is written unless --project is given)`,
  unavailable: 'Mission model configuration is not available in this build.',
  orchestratorNote:
    'The orchestrator model is applied when mission mode starts — run /mission exit and /mission, or switch this session now with /model.',
};

export const MISSION_APPROVE_OPTION = 'Approve and start mission';
export const MISSION_KEEP_PLANNING_OPTION = 'Keep planning';

export function missionApprovalTitle(objective: TowerObjective, milestones: number, features: number): string {
  return `Start mission ${objective.id} "${objective.title}"? ${count(milestones, 'milestone')} · ${count(features, 'feature')} planned`;
}

export function missionKeepPlanning(objective: TowerObjective): string {
  return `Mission ${objective.id} still awaits your approval — tell the orchestrator what to change in plain language, or run /mission approve when the plan looks right.`;
}

export const MISSION_STATUS_WAITING_FOR_GOAL = 'mission: waiting for your goal';
export const MISSION_STATUS_PLANNING_GOAL = 'mission: planning your goal';

export function count(value: number, noun: string): string {
  return `${String(value)} ${noun}${value === 1 ? '' : 's'}`;
}

export function preview(text: string, max: number): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
