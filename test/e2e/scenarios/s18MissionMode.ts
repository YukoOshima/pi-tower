import { basename, join } from 'node:path';

import { distinct, logEntries, towerState, userMessages, type MissionRecord, type TowerState, type ValidationRoundRecord } from '../evidence.ts';
import {
  approvalDialogTitle,
  describeMissionModel,
  leftoverWorktrees,
  missionAcceptScript,
  missionModelRows,
  modelRowMatches,
  panelModelsLine,
  panelRunningFeatures,
  panelStatus,
  teardownSection,
  type LeftoverWorktrees,
  type MissionAcceptRun,
  type MissionModel,
  type MissionRole,
} from '../mission.ts';
import {
  autopilotEntries,
  checkAutopilotPromptness,
  checkRosterModels,
  concurrentFeatures,
  createTextkitRepo,
  describeObjective,
  describeWindow,
  featureWorkerWindows,
  humanScript,
  OBJECTIVE_MAX_RUNNING_AGENTS,
  objectiveSettingsConfig,
  ObjectiveTrace,
  planToApproval,
  recordObjectiveUsage,
  requiredValidationKinds,
  waitForObjective,
  writeText,
  type HumanScript,
  type ObjectiveLimits,
} from '../objective.ts';
import { chooseOption, clip, sleep, type PiDialog, type PiRpc } from '../rpc.ts';
import { sessionModel, startSession, type ScenarioContext, type ScenarioDefinition } from '../scenario.ts';
import type { E2eSettings, RoleModel } from '../settings.ts';
import { git, readJsonFile, tryGit } from '../workspace.ts';

const LIMITS: ObjectiveLimits = { maxCostUsd: 5, maxWallTimeMs: 30 * 60_000, skipUserTesting: true };
const MISSION_KEY = 'mission';
const PLANNING_HEADING = '# New mission — plan it with the human';
const WORKTREE_WAIT_MS = 3 * 60_000;
const TOWER_OFF = /^Tower (?:status —|mode:) OFF/m;

export function missionGoal(script: string): string {
  return [
    'Add two commands to the textkit CLI in this repository (README.md explains how commands work).',
    '`lower` prints its arguments joined by single spaces in lower case: `node src/cli.js lower Hello WORLD` prints `hello world`.',
    '`chars` prints the number of characters of its arguments joined by single spaces: `node src/cli.js chars ab cd` prints `5`.',
    'The two commands are independent of each other, and each one gets its own node:test test file.',
    'It is small, so one milestone is enough. Leave src/cli.js, README.md and package.json unchanged.',
    `The acceptance commands are exactly \`npm test\` and \`node ${script}\`.`,
    'Ask me your questions first.',
  ].join(' ');
}

const PLANNING_REPLY = [
  'My answers: done means both commands print exactly what my examples show and `npm test` passes;',
  'out of scope are any other command and any change to src/cli.js, README.md and package.json;',
  'a user runs the commands from a shell exactly like my examples;',
  'the acceptance commands are the two I gave, verbatim; plain Node.js ES modules, no dependencies.',
  'No more questions from me — decide anything else yourself, then draft the mission, plan its features and request my approval.',
].join(' ');

const EXECUTION_REPLY = 'No more questions from me — decide any open point yourself and keep the mission going on your own.';

export interface MissionSetup {
  readonly towerConfig: Record<string, unknown>;
  readonly extraArgs: readonly string[];
  readonly header: readonly MissionModel[];
  readonly panelModels: string;
}

function modelId(role: RoleModel): string {
  return role.model.slice(role.model.indexOf('/') + 1);
}

function configured(role: MissionRole, model: RoleModel, source: string): MissionModel {
  return { role, model: model.model, ...(model.thinking === undefined ? {} : { thinking: model.thinking }), source };
}

export function missionSetup(settings: E2eSettings): MissionSetup {
  const { orchestrator: A, worker: B, reviewer: C, validator: V } = settings;
  const inherited = V.spec === C.spec;
  return {
    towerConfig: { orchestrator: A.spec, reviewer: C.spec, ...(inherited ? {} : { validator: V.spec }), ...objectiveSettingsConfig(LIMITS) },
    extraArgs: ['--tower-worker-model', B.spec],
    header: [
      configured('orchestrator', A, 'global tower.json'),
      configured('worker', B, '--tower-worker-model'),
      configured('reviewer', C, 'global tower.json'),
      inherited ? { role: 'validator', note: 'same as reviewer' } : configured('validator', V, 'global tower.json'),
    ],
    panelModels: `models: orchestrator ${modelId(A)} · worker ${modelId(B)} · reviewer ${modelId(C)} · validator ${inherited ? '= reviewer' : modelId(V)}`,
  };
}

function modelRowsCheck(text: string, expected: readonly MissionModel[]): { readonly ok: boolean; readonly evidence: string[] } {
  const rows = missionModelRows(text);
  const lines = expected.map((want) => {
    const row = rows.find((candidate) => candidate.role === want.role);
    const ok = modelRowMatches(row, want);
    return { ok, line: `${row?.line.trim() ?? `(no ${want.role} row)`}${ok ? '' : ` — expected ${describeMissionModel(want)}`}` };
  });
  return { ok: lines.every((line) => line.ok), evidence: lines.map((line) => line.line) };
}

async function enterMissionMode(ctx: ScenarioContext, rpc: PiRpc, setup: MissionSetup): Promise<void> {
  const { report, settings } = ctx;
  const mark = rpc.events.length;
  const entered = await rpc.command('/mission', 1500);
  const modelTurn = rpc.events.slice(mark).some((event) => event.type === 'agent_start');
  const header = entered.notices.find((notice) => notice.text.startsWith('Mission mode\n'));
  const lines = (header?.text ?? '').split('\n');
  const rows = modelRowsCheck(header?.text ?? '', setup.header);
  const base = lines.find((line) => /^\s+Base branch\s/.test(line))?.trim();
  const question = lines.at(-1) ?? '';
  report.note(`/mission:\n${entered.text}`);
  report.check(
    '/mission enters mission mode without a model turn: its header lists the orchestrator, worker, reviewer and validator models with their sources, the base branch, and asks for the goal',
    entered.disposition === 'handled' &&
      !modelTurn &&
      header !== undefined &&
      rows.ok &&
      base !== undefined &&
      /^Base branch +main\b/.test(base) &&
      base.endsWith(`features run in parallel (up to ${String(OBJECTIVE_MAX_RUNNING_AGENTS)} agents)`) &&
      question.startsWith('What do you want to build?'),
    [`disposition=${String(entered.disposition)} model-turn=${String(modelTurn)}`, ...rows.evidence, base ?? '(no Base branch line)', question],
  );
  const state = await rpc.send({ type: 'get_state' });
  const model = `${String(state.data?.model?.provider)}/${String(state.data?.model?.id)}`;
  const thinking = String(state.data?.thinkingLevel);
  const A = settings.orchestrator;
  report.check(
    `/mission switches the session to the orchestrator model ${A.spec}`,
    model === A.model && (A.thinking === undefined || thinking === A.thinking),
    `session model ${model} (thinking ${thinking})`,
  );
}

interface Intake {
  readonly mark: number;
  readonly planned: TowerState;
}

async function handOverGoal(ctx: ScenarioContext, rpc: PiRpc, repo: string, goal: string, script: string, human: HumanScript): Promise<Intake> {
  const { report } = ctx;
  const mark = rpc.events.length;
  rpc.log(`> (goal) ${clip(goal, 300)}`);
  const response = await rpc.send({ type: 'prompt', message: goal });
  await rpc.waitFor((event) => event.type === 'agent_start', 60_000, 'the orchestrator to start planning', mark).catch(() => undefined);
  const planned = await planToApproval(ctx, rpc, repo, human);
  const handed = rpc.noticesSince(mark).find((notice) => notice.text.startsWith('Mission goal handed to the orchestrator'));
  const sessionFile = String((await rpc.send({ type: 'get_state' })).data?.sessionFile ?? '');
  const prompts = userMessages(sessionFile);
  const planning = prompts.find((message) => message.text.startsWith(PLANNING_HEADING));
  const raw = prompts.filter((message) => message.text.trim() === goal);
  const entries = logEntries(repo);
  const intakeMode = entries.find((entry) => entry.action === 'objective.mode' && entry.fields.mode === 'interactive');
  report.check(
    'the next plain message is the goal: the intake captures it and hands the orchestrator the planning prompt with the goal verbatim',
    response.success === true &&
      response.data?.disposition === 'handled' &&
      handed !== undefined &&
      intakeMode !== undefined &&
      planning !== undefined &&
      planning.text.includes(`## Mission goal\n\n${goal}\n`) &&
      raw.length === 0,
    [
      `prompt response: success=${String(response.success)} disposition=${String(response.data?.disposition)}`,
      clip(handed?.text ?? '(no "Mission goal handed to the orchestrator" notice)', 300),
      intakeMode?.line ?? '(no objective.mode mode=interactive line)',
      planning === undefined ? `(no user message starting with "${PLANNING_HEADING}" in ${sessionFile})` : `planning prompt (${String(planning.text.length)} chars) contains the goal verbatim: ${String(planning.text.includes(goal))}`,
      `user messages equal to the raw goal: ${String(raw.length)}`,
    ],
  );
  const objective = planned.objective;
  const drafted = entries.find((entry) => entry.action === 'objective.draft' && entry.fields.id === objective?.id);
  report.check(
    "the orchestrator drafts the mission from that goal (interactive mode, the goal's own acceptance command)",
    drafted !== undefined && drafted.fields.mode === 'interactive' && intakeMode !== undefined && intakeMode.index < drafted.index && (objective?.acceptanceCommands.some((command) => command.includes(script)) ?? false),
    [drafted?.line ?? '(no objective.draft line)', `acceptance commands: ${objective?.acceptanceCommands.join(' ; ') ?? '(no objective)'}`],
  );
  const request = entries.find((entry) => entry.action === 'objective.request-approval' && entry.fields.id === objective?.id);
  report.check(
    `the orchestrator interviews the human before it requests approval, and the scripted human answers within the reply budget (1-${String(human.maxReplies)})`,
    human.replies >= 1 && human.replies <= human.maxReplies && objective?.status === 'awaiting-approval' && request !== undefined,
    [`scripted replies: ${String(human.replies)} of ${String(human.maxReplies)}`, request?.line ?? '(no objective.request-approval line)'],
  );
  return { mark, planned };
}

function objectiveFeatures(state: TowerState | undefined): MissionRecord[] {
  const milestones = new Set(state?.objective?.milestones.map((milestone) => milestone.id) ?? []);
  return (state?.missions ?? []).filter((mission) => mission.milestone !== undefined && milestones.has(mission.milestone));
}

async function declineApproval(ctx: ScenarioContext, rpc: PiRpc, repo: string, intake: Intake): Promise<PiDialog | undefined> {
  const { report } = ctx;
  await rpc
    .waitFor((event) => event.type === 'extension_ui_request' && event.method === 'select' && approvalDialogTitle(String(event.title ?? '')) !== undefined, 90_000, 'the mission approval dialog', intake.mark)
    .catch(() => undefined);
  const dialog = rpc.dialogs.find((candidate) => candidate.index >= intake.mark && approvalDialogTitle(candidate.title) !== undefined);
  const keep =
    dialog === undefined
      ? undefined
      : await rpc
          .waitFor((event) => event.type === 'extension_ui_request' && event.method === 'notify' && /^Mission O\d+ still awaits your approval/.test(String(event.message)), 30_000, 'the keep-planning notice', dialog.index)
          .catch(() => undefined);
  await sleep(6000);
  const after = towerState(repo);
  const objective = after?.objective;
  const approved = logEntries(repo).filter((entry) => entry.action === 'objective.approve');
  const title = dialog === undefined ? undefined : approvalDialogTitle(dialog.title);
  const features = objectiveFeatures(after).filter((feature) => feature.status !== 'abandoned').length;
  const chosen = dialog !== undefined && 'value' in dialog.answer ? dialog.answer.value : undefined;
  report.check(
    'request-approval opens the approval select (extension_ui_request); the harness picks option 0, which does not approve: the mission stays awaiting approval',
    dialog !== undefined &&
      dialog.options.length === 2 &&
      chosen === dialog.options[0] &&
      title?.objective === objective?.id &&
      title?.milestones === objective?.milestones.length &&
      title?.features === features &&
      keep !== undefined &&
      objective?.status === 'awaiting-approval' &&
      approved.length === 0,
    [
      dialog === undefined ? '(no approval select)' : `select "${dialog.title}" options [${dialog.options.map((option) => `"${option}"`).join(', ')}] — harness chose ${chosen === undefined ? 'nothing' : `"${chosen}"`}`,
      `state.json: ${String(objective?.id)} ${String(objective?.status)} with ${String(objective?.milestones.length)} milestone(s) and ${String(features)} feature(s)`,
      clip(String(keep?.message ?? '(no keep-planning notice)'), 300),
      `objective.approve lines so far: ${String(approved.length)}`,
    ],
  );
  return dialog;
}

async function approveMission(ctx: ScenarioContext, rpc: PiRpc, repo: string, dialog: PiDialog | undefined): Promise<void> {
  const mark = rpc.events.length;
  const approved = await rpc.command('/mission approve');
  const objective = towerState(repo)?.objective;
  const line = logEntries(repo).find((entry) => entry.action === 'objective.approve');
  ctx.report.check(
    '/mission approve starts the mission: approved by the human, executing',
    approved.notices.some((notice) => notice.text.startsWith(`Mission ${String(objective?.id)} approved — executing\n`)) &&
      objective?.status === 'executing' &&
      objective.approvedBy === 'human' &&
      line?.fields.by === 'human' &&
      (dialog === undefined || mark > dialog.index),
    [clip(approved.text, 400), line?.line ?? '(no objective.approve line)'],
  );
}

async function showMissionControl(ctx: ScenarioContext, rpc: PiRpc, repo: string, setup: MissionSetup): Promise<void> {
  await sleep(3000);
  const control = await rpc.command('/mission', 1500);
  const view = control.notices.find((notice) => notice.text.startsWith('Mission Control\n'));
  const rows = modelRowsCheck(view?.text ?? '', setup.header);
  const objective = towerState(repo)?.objective;
  ctx.report.check(
    '/mission while the mission runs shows Mission Control: the role models, the mission and the commands of an executing mission',
    view !== undefined && view.text.startsWith('Mission Control\n## Models\n') && rows.ok && view.text.includes(`# Mission ${String(objective?.id)} — `) && view.text.includes('\n## Commands\n/mission pause [reason]'),
    [...rows.evidence, ...(view?.text ?? control.text).split('\n').filter((line) => line.startsWith('#') || line.startsWith('/mission')).map((line) => clip(line, 200))],
  );
}

async function waitForWorktreesGone(repo: string, timeoutMs: number): Promise<LeftoverWorktrees> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = leftoverWorktrees(repo);
    if ((left.registered.length === 0 && left.directories.length === 0) || Date.now() > deadline) return left;
    await sleep(2000);
  }
}

async function checkCompletion(ctx: ScenarioContext, rpc: PiRpc, repo: string, final: TowerState): Promise<void> {
  const { report } = ctx;
  const objective = final.objective;
  if (objective === undefined) throw new Error('state.json has no objective');
  const notice = await rpc
    .waitFor(
      (event) => event.type === 'extension_ui_request' && event.method === 'notify' && String(event.message).startsWith(`Mission ${objective.id} "${objective.title}" is complete:`),
      120_000,
      'the completion notice',
      0,
    )
    .catch(() => undefined);
  const text = String(notice?.message ?? '');
  const section = teardownSection(text);
  const features = objectiveFeatures(final);
  const removed = new Set((section?.items ?? []).filter((item) => item.startsWith('removed ')).map((item) => item.slice('removed '.length)));
  const unexpected = (section?.items ?? []).filter((item) => !item.startsWith('removed ') && !/^kept \S+ \(validator \S+ is finishing/.test(item));
  report.check(
    'the completion notice includes the automatic teardown section, which removed the worktree of every feature',
    section?.counts !== undefined && section.counts.failed === 0 && features.length > 0 && features.every((feature) => removed.has(`.tower/worktrees/${feature.worktree}`)) && unexpected.length === 0,
    [clip(text.split('\n')[0] ?? '(no completion notice)', 300), section?.summary ?? '(no "Automatic teardown" section)', ...(section?.items ?? []).map((item) => `- ${item}`)],
  );
  const left = await waitForWorktreesGone(repo, WORKTREE_WAIT_MS);
  const entries = logEntries(repo);
  const completed = entries.find((entry) => entry.action === 'objective.complete');
  const teardown = entries.find((entry) => entry.action === 'teardown' && completed !== undefined && entry.index > completed.index);
  report.check(
    'no mission worktree remains: git lists only the main checkout and .tower/worktrees is empty',
    left.registered.length === 0 && left.directories.length === 0 && teardown !== undefined,
    [
      `registered worktrees besides the main checkout: ${left.registered.join(', ') || '(none)'}`,
      `.tower/worktrees entries: ${left.directories.join(', ') || '(none)'}`,
      completed?.line ?? '(no objective.complete line)',
      teardown?.line ?? '(no tower teardown line after the completion)',
      ...entries.filter((entry) => entry.action.startsWith('worktree.')).map((entry) => entry.line),
    ],
  );
}

function checkLifecycle(ctx: ScenarioContext, repo: string, final: TowerState, trace: ObjectiveTrace): void {
  const objective = final.objective;
  const entries = logEntries(repo);
  const complete = entries.find((entry) => entry.actor === 'autopilot' && entry.action === 'complete-objective');
  const sequence = trace.objective.join(' → ');
  ctx.report.check(
    'lifecycle: awaiting approval → executing → completed, approved by the human, completed by the autopilot',
    /awaiting-approval → executing → completed$/.test(sequence) && objective?.status === 'completed' && objective.approvedBy === 'human' && complete !== undefined,
    [`observed mission statuses: ${sequence}`, complete?.line ?? '(no autopilot complete-objective line)'],
  );
}

function checkFeatures(ctx: ScenarioContext, repo: string, final: TowerState): void {
  const { report } = ctx;
  const features = objectiveFeatures(final);
  const merged = features.filter((feature) => feature.status === 'merged');
  const lower = tryGit(repo, ['show', 'main:src/commands/lower.js']);
  const chars = tryGit(repo, ['show', 'main:src/commands/chars.js']);
  report.check(
    'every feature is merged or abandoned, and main carries both commands',
    merged.length >= 2 && features.every((feature) => feature.status === 'merged' || feature.status === 'abandoned') && lower !== undefined && chars !== undefined,
    [...features.map((feature) => `${feature.id} "${feature.title ?? ''}" ${feature.milestone ?? '-'} origin=${String(feature.origin)} status=${feature.status} worktree=${feature.worktree}`), git(repo, ['log', '--oneline', '-8', 'main'])],
  );
  const plan = features.filter((feature) => feature.origin !== 'fix');
  const windows = featureWorkerWindows(repo, final, plan);
  const pairs = concurrentFeatures(windows);
  const spawns = autopilotEntries(repo, 'spawn-worker').filter((entry) => entry.fields.result === 'started');
  report.check(
    'at least two features of one milestone run concurrently (their worker transcripts overlap in time)',
    pairs.length > 0,
    [...windows.map(describeWindow), ...pairs.map((pair) => `${pair.a.worker} ∥ ${pair.b.worker} for ${(pair.overlapMs / 1000).toFixed(1)}s`), ...spawns.map((entry) => entry.line)],
  );
}

function latestRounds(rounds: readonly ValidationRoundRecord[]): Map<string, ValidationRoundRecord> {
  const latest = new Map<string, ValidationRoundRecord>();
  for (const round of [...rounds].sort((a, b) => a.round - b.round)) latest.set(round.kind, round);
  return latest;
}

function checkValidation(ctx: ScenarioContext, repo: string, final: TowerState, runs: readonly MissionAcceptRun[]): void {
  const objective = final.objective;
  if (objective === undefined) throw new Error('state.json has no objective');
  const mainTip = git(repo, ['rev-parse', 'main']);
  const milestones = [...objective.milestones].sort((a, b) => a.order - b.order);
  const last = milestones.at(-1);
  const lines: string[] = [];
  const passed = milestones.map((milestone) => {
    const required = requiredValidationKinds(objective, milestone, LIMITS);
    const latest = latestRounds(milestone.rounds);
    lines.push(
      `${milestone.id} ${milestone.status} validation commit ${milestone.validationCommit?.slice(0, 7) ?? '-'}, required ${required.join(', ') || '(none)'}: ${[...latest.values()].map((round) => `${round.kind} r${String(round.round)} ${round.verdict} by ${round.validator} on ${round.validatedCommit.slice(0, 7)}`).join('; ') || '(no rounds)'}`,
    );
    return milestone.status === 'passed' && required.every((kind) => latest.get(kind)?.verdict === 'pass' && latest.get(kind)?.validatedCommit === milestone.validationCommit);
  });
  const lastRun = runs.at(-1);
  ctx.report.check(
    "validation passes: every required kind passes on its milestone's validation commit, the final one is the tip of main, and the acceptance script passed there",
    milestones.length > 0 &&
      passed.every(Boolean) &&
      last !== undefined &&
      last.validationCommit === mainTip &&
      requiredValidationKinds(objective, last, LIMITS).includes('commands') &&
      lastRun?.pass === true &&
      lastRun.commit === mainTip &&
      /^val-.*commands/.test(basename(lastRun.cwd)),
    [...lines, `main ${mainTip.slice(0, 7)}`, `acceptance script runs: ${runs.map((run) => `#${String(run.execution)} ${basename(run.cwd)} ${run.commit.slice(0, 7)} pass=${String(run.pass)}`).join('; ') || '(none)'}`],
  );
}

async function exitMissionMode(ctx: ScenarioContext, rpc: PiRpc): Promise<number> {
  const mark = rpc.events.length;
  const exited = await rpc.command('/mission exit');
  const status = await rpc.command('/tower status');
  const again = await rpc.command('/mission exit');
  const model = await sessionModel(rpc);
  const tower = rpc.statusUpdates('tower', mark);
  const mission = rpc.statusUpdates(MISSION_KEY, mark);
  const panel = rpc.widgetUpdates(MISSION_KEY, mark);
  ctx.report.check(
    '/mission exit turns mission mode off: tower mode off, the mission status line and the panel cleared, the starting model restored',
    exited.notices.some((notice) => notice.text.startsWith('Mission mode: OFF\n')) &&
      TOWER_OFF.test(status.text) &&
      again.notices.some((notice) => notice.text === 'Mission mode is already off.') &&
      tower.some((update) => update.text === undefined) &&
      mission.length > 0 &&
      mission.at(-1)?.text === undefined &&
      panel.length > 0 &&
      panel.at(-1)?.lines === undefined &&
      model === ctx.settings.session.model,
    [
      clip(exited.text, 300),
      status.text.split('\n')[0] ?? '',
      again.text,
      `after exit: setStatus(tower) ${tower.map((update) => update.text ?? '(cleared)').join(' → ') || '(none)'}; setStatus(mission) ${mission.map((update) => update.text ?? '(cleared)').join(' → ') || '(none)'}; setWidget(mission) ${panel.map((update) => (update.lines === undefined ? '(cleared)' : `${String(update.lines.length)} lines`)).join(' → ') || '(none)'}`,
      `session model ${model}`,
    ],
  );
  return mark;
}

function collapse(values: readonly string[]): string[] {
  return values.filter((value, index) => index === 0 || values[index - 1] !== value);
}

function checkStatusLine(ctx: ScenarioContext, rpc: PiRpc): void {
  const texts = rpc.statusUpdates(MISSION_KEY).map((update) => update.text);
  const find = (pattern: RegExp): number => texts.findIndex((text) => text !== undefined && pattern.test(text));
  const waiting = texts.indexOf('mission: waiting for your goal');
  const planning = texts.indexOf('mission: planning your goal');
  const awaiting = find(/^mission O\d+ awaiting approval\b/);
  const executing = find(/^mission O\d+ executing\b/);
  const completed = find(/^mission O\d+ completed\b/);
  const running = distinct(texts.filter((text): text is string => text !== undefined && /^mission O\d+ executing\b/.test(text)));
  ctx.report.check(
    "the mission status line (setStatus 'mission') follows the mission: waiting for the goal → planning → awaiting approval → executing (updating) → completed → cleared on exit",
    waiting >= 0 && waiting < planning && planning < awaiting && awaiting < executing && executing < completed && running.length >= 2 && texts.length > 0 && texts.at(-1) === undefined,
    collapse(texts.map((text) => text ?? '(cleared)')),
  );
}

function checkPanel(ctx: ScenarioContext, rpc: PiRpc, setup: MissionSetup, exitMark: number): void {
  const { report } = ctx;
  const renders = rpc.widgetUpdates(MISSION_KEY);
  const shown = renders.flatMap((render) => (render.lines === undefined ? [] : [{ index: render.index, lines: render.lines }]));
  const executing = shown.filter((render) => panelStatus(render.lines) === 'executing');
  const models = distinct(shown.flatMap((render) => panelModelsLine(render.lines) ?? []));
  const completed = shown.filter((render) => panelStatus(render.lines) === 'completed').at(-1);
  const last = renders.at(-1);
  const sample = (lines: readonly string[] | undefined, label: string): string[] => (lines === undefined ? [`(no ${label} render)`] : [`${label}:`, ...lines.map((line) => `  ${line}`)]);
  report.check(
    "the Mission Control panel (setWidget 'mission', plain lines above the editor) updates while the mission runs, shows the role models and is cleared on exit",
    renders.length > 0 &&
      renders.every((render) => render.plain && render.placement === 'aboveEditor') &&
      distinct(executing.map((render) => JSON.stringify(render.lines))).length >= 2 &&
      models.length === 1 &&
      models[0] === setup.panelModels &&
      completed !== undefined &&
      last !== undefined &&
      last.lines === undefined &&
      last.index >= exitMark,
    [
      `${String(renders.length)} setWidget(mission) updates, ${String(executing.length)} while executing (${String(distinct(executing.map((render) => JSON.stringify(render.lines))).length)} distinct), all plain lines above the editor: ${String(renders.every((render) => render.plain && render.placement === 'aboveEditor'))}`,
      `models lines: ${models.join(' | ') || '(none)'} — expected ${setup.panelModels}`,
      ...sample(executing[0]?.lines, 'first executing render'),
      ...sample(completed?.lines, 'last completed render'),
      `last update: ${last === undefined ? '(none)' : last.lines === undefined ? '(cleared)' : `${String(last.lines.length)} lines`}`,
    ],
  );
  const parallel = executing.find((render) => distinct(panelRunningFeatures(render.lines).map((feature) => feature.feature)).length >= 2);
  report.check(
    'Mission Control shows two features of the milestone running at the same time',
    parallel !== undefined,
    parallel === undefined ? '(no executing render shows two features with a running worker)' : parallel.lines.map((line) => clip(line, 200)),
  );
}

export const s18MissionMode: ScenarioDefinition = {
  id: 'S18',
  title: 'mission mode: /mission from goal to completion',
  mandatory: true,
  timeoutMs: 50 * 60_000,
  async run(ctx) {
    const { settings, report, dir } = ctx;
    const setup = missionSetup(settings);
    const repo = createTextkitRepo(dir);
    const runsFile = join(dir, 'accept-s18-runs.json');
    const script = writeText(join(dir, 'accept-s18.mjs'), missionAcceptScript(runsFile));
    const goal = missionGoal(script);
    const session = await startSession(ctx, { repo, towerConfig: setup.towerConfig, extraArgs: setup.extraArgs });
    const { rpc } = session;
    rpc.dialogResponder = chooseOption(0, (request) => approvalDialogTitle(request.title) !== undefined);
    const trace = new ObjectiveTrace(repo);
    try {
      await enterMissionMode(ctx, rpc, setup);
      const intake = await handOverGoal(ctx, rpc, repo, goal, script, humanScript(PLANNING_REPLY));
      const dialog = await declineApproval(ctx, rpc, repo, intake);
      await approveMission(ctx, rpc, repo, dialog);
      await showMissionControl(ctx, rpc, repo, setup);
      const final = await waitForObjective(ctx, repo, (state) => state.objective?.status === 'completed', {
        label: 'the mission to complete',
        timeoutMs: LIMITS.maxWallTimeMs + 5 * 60_000,
        rpc,
        human: humanScript(EXECUTION_REPLY),
      });
      trace.stop();
      await checkCompletion(ctx, rpc, repo, final);
      const settled = towerState(repo) ?? final;
      checkLifecycle(ctx, repo, settled, trace);
      checkFeatures(ctx, repo, settled);
      checkValidation(ctx, repo, settled, readJsonFile<MissionAcceptRun[]>(runsFile) ?? []);
      checkRosterModels(ctx, settled, { worker: settings.worker, reviewer: settings.reviewer, validator: settings.validator }, (settled.objective?.milestones ?? []).some((milestone) => settled.objective !== undefined && requiredValidationKinds(settled.objective, milestone, LIMITS).includes('scrutiny')));
      checkAutopilotPromptness(ctx, repo);
      const exitMark = await exitMissionMode(ctx, rpc);
      checkStatusLine(ctx, rpc);
      checkPanel(ctx, rpc, setup, exitMark);
    } finally {
      trace.stop();
      report.note(`status trace:\n${trace.lines().join('\n')}`);
      report.note(`final state:\n${describeObjective(towerState(repo)).join('\n')}`);
      report.note(`autopilot activity:\n${autopilotEntries(repo).map((entry) => entry.line).join('\n')}`);
      report.note(`dialogs: ${rpc.dialogs.map((dialog) => `${dialog.method} "${dialog.title}" [${dialog.options.join(' | ')}] → ${JSON.stringify(dialog.answer)}`).join('; ') || '(none)'}`);
      report.note(`acceptance script runs: ${JSON.stringify(readJsonFile<MissionAcceptRun[]>(runsFile) ?? [])}`);
      recordObjectiveUsage(ctx, repo, join(dir, 'sessions'));
    }
  },
};
