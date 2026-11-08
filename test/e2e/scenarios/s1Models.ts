import { join } from 'node:path';

import { activityLog, agentTranscriptPath, distinct, frontmatter, readJsonl, reviewFiles, rosterEntry, summarizeTranscript, towerState } from '../evidence.ts';
import { clip, textOf, type PiRpc, type PiToolRun } from '../rpc.ts';
import {
  firstLine,
  recordUsage,
  runsOf,
  sessionModel,
  startSession,
  TURN_TIMEOUT_MS,
  type ScenarioContext,
  type ScenarioDefinition,
} from '../scenario.ts';
import { discriminationNotes, type RoleModel } from '../settings.ts';

const WORKER = 'agent-notes';
const REVIEWERS = ['reviewer-default-1', 'reviewer-as-worker', 'reviewer-default-2'] as const;
const BOGUS_MODEL = 'turbo-9000';
const AGENT_WAIT_MS = 8 * 60_000;

const OBJECTIVE = [
  'Objective for the tower (an automated end-to-end test — follow these steps exactly):',
  '1. Call TowerInit with no arguments.',
  `2. Call TowerPlan with exactly one build mission: title "Append delta to notes", scope ["notes.txt"], tasks ["Add one new last line to notes.txt whose entire content is the single word delta (the file then ends with the two lines alpha and delta)", "Commit the change on the mission branch"].`,
  `3. Spawn the worker for that mission with TowerSpawn: name "${WORKER}", kind "worker", mission_id "M1". Do not pass a model, so it runs on the default worker model.`,
  '4. End your turn. When the worker reports completion, only acknowledge it in one short sentence: do not spawn reviewers, do not merge, and call no tools until I send the next instruction.',
].join('\n');

function reviewPrompt(branch: string): string {
  return [
    `The worker ${WORKER} is done. Now set up the reviews for branch ${branch} exactly like this:`,
    `1. First try to spawn a reviewer named "reviewer-bogus" with model "${BOGUS_MODEL}" (kind "reviewer", review_target "${branch}"). It should be refused; do not retry it.`,
    `2. Spawn reviewer "${REVIEWERS[0]}" for ${branch} on the default reviewer model (do not pass a model).`,
    `3. Spawn reviewer "${REVIEWERS[1]}" for ${branch} — for this one reviewer I want you to use the worker model instead of the reviewer model.`,
    `4. Spawn reviewer "${REVIEWERS[2]}" for ${branch} on the default reviewer model again (do not pass a model).`,
    '5. Call TowerTasks once with active_only false, so finished agents are listed too.',
    'Then end your turn. When the reviews come in, only acknowledge them in one short sentence: do not merge, do not spawn anything else, and do not resume anyone.',
  ].join('\n');
}

function spawnRun(runs: readonly PiToolRun[], name: string): PiToolRun | undefined {
  return runsOf(runs, 'TowerSpawn').find((run) => run.args.name === name && !run.isError);
}

async function waitAgentNotification(rpc: PiRpc, name: string, from: number): Promise<void> {
  await rpc.waitFor(
    (event) => event.type === 'message_end' && event.message?.role === 'custom' && event.message?.customType === 'tower-agent-notification' && textOf(event.message?.content).includes(`name="${name}"`),
    AGENT_WAIT_MS,
    `the finished notification of ${name}`,
    from,
  );
}

function checkAgentModel(
  ctx: ScenarioContext,
  repo: string,
  input: { readonly name: string; readonly kind: string; readonly role: string; readonly expected: RoleModel; readonly spawn: PiToolRun | undefined; readonly agentsText: string; readonly tasksText: string },
): void {
  const { report } = ctx;
  const { name, kind, expected } = input;
  const thinking = expected.thinking;
  const spawnLine = input.spawn === undefined ? undefined : firstLine(input.spawn.output, /^model: /);
  const expectedSpawn = thinking === undefined ? `model: ${expected.model}` : `model: ${expected.model} (thinking ${thinking})`;
  report.check(`${name}: TowerSpawn output shows the ${input.role} model`, spawnLine === expectedSpawn, spawnLine ?? `no successful TowerSpawn for ${name}`);

  const logLine = activityLog(repo).find((line) => line.includes(' spawn ') && line.includes(`name=${name} `));
  const logOk = logLine !== undefined && logLine.includes(`kind=${kind}`) && logLine.includes(`model=${expected.model} `) && (thinking === undefined || logLine.includes(`thinking=${thinking}`));
  report.check(`${name}: activity-log spawn entry shows the ${input.role} model`, logOk, logLine ?? 'no spawn entry in .tower/comms/log/activity.log');

  const roster = rosterEntry(repo, name);
  report.check(`${name}: roster entry (state.json) shows the ${input.role} model`, roster?.model === expected.model && roster.kind === kind, roster === undefined ? 'no roster entry' : `roster: name=${roster.name} kind=${roster.kind} agentId=${roster.agentId} model=${String(roster.model)}`);

  const expectedTasks = thinking === undefined ? `model: ${expected.model}` : `model: ${expected.model} · thinking: ${thinking}`;
  const agentsLine = firstLine(input.agentsText, new RegExp(`^- ${name} \\(`));
  const tasksLine = firstLine(input.tasksText, new RegExp(`^- ${name} \\(`));
  report.check(
    `${name}: /tower agents and TowerTasks lines show the ${input.role} model`,
    agentsLine?.includes(expectedTasks) === true && tasksLine?.includes(expectedTasks) === true,
    [`/tower agents: ${clip(agentsLine ?? '(missing)', 260)}`, `TowerTasks: ${clip(tasksLine ?? '(missing)', 260)}`],
  );

  const transcript = roster === undefined ? undefined : agentTranscriptPath(repo, roster.agentId);
  const summary = transcript === undefined ? undefined : summarizeTranscript(transcript);
  const models = distinct(summary?.assistantModels ?? []);
  report.check(
    `${name}: its .tower/agents transcript runs on the ${input.role} model${thinking === undefined ? '' : ` at thinking ${thinking}`}`,
    summary !== undefined && summary.assistantModels.length > 0 && models.length === 1 && models[0] === expected.model && summary.modelChanges.at(-1) === expected.model && (thinking === undefined || summary.thinkingLevels.at(-1) === thinking),
    summary === undefined
      ? 'no transcript'
      : `${transcript?.split('/.tower/')[1] ?? ''}: model_change=${summary.modelChanges.join(',')} thinking=${summary.thinkingLevels.join(',')} assistant messages=${String(summary.assistantModels.length)} on ${models.join(',')}`,
  );
}

interface SessionSegment {
  readonly model: string;
  readonly assistant: string[];
  readonly thinking: string[];
}

function sessionSegments(sessionFile: string): { readonly changes: string[]; readonly segments: SessionSegment[] } {
  const changes: string[] = [];
  const segments: SessionSegment[] = [];
  let thinking = 'unset';
  for (const line of readJsonl(sessionFile)) {
    if (line.type === 'thinking_level_change') thinking = String(line.thinkingLevel);
    if (line.type === 'model_change') {
      const model = `${String(line.provider)}/${String(line.modelId)}`;
      changes.push(model);
      segments.push({ model, assistant: [], thinking: [] });
    }
    if (line.type === 'message' && line.message?.role === 'assistant') {
      segments.at(-1)?.assistant.push(`${String(line.message.provider)}/${String(line.message.model)}`);
      segments.at(-1)?.thinking.push(thinking);
    }
  }
  return { changes, segments };
}

async function fallbackCheck(ctx: ScenarioContext): Promise<void> {
  const { settings, report } = ctx;
  const subCtx: ScenarioContext = { ...ctx, dir: join(ctx.dir, 'fallback') };
  const { rpc } = await startSession(subCtx, {
    label: 'S1-fallback',
    towerConfig: { orchestrator: settings.orchestrator.spec, worker: settings.worker.spec },
  });
  const models = await rpc.command('/tower models');
  const row = firstLine(models.text, /^reviewer\s/);
  report.check(
    'with only orchestrator+worker configured the reviewer falls back to the orchestrator model',
    row !== undefined && row.includes(settings.orchestrator.model) && row.includes('inherited from orchestrator'),
    row ?? models.text,
  );
  await rpc.close();
}

export const s1Models: ScenarioDefinition = {
  id: 'S1',
  title: 'three distinct models per role',
  mandatory: true,
  async run(ctx) {
    const { settings, report } = ctx;
    const A = settings.orchestrator;
    const B = settings.worker;
    const C = settings.reviewer;
    const P = settings.session;
    const session = await startSession(ctx, {
      towerConfig: { orchestrator: B.spec, worker: B.spec, reviewer: B.spec, maxRunningAgents: 4 },
      extraArgs: ['--tower-orchestrator-model', A.spec],
      env: { PI_TOWER_REVIEWER_MODEL: C.spec },
    });
    const { rpc, repo } = session;
    const configPath = join(ctx.dir, 'tower.json');
    for (const note of discriminationNotes(settings)) report.note(note);

    const models = await rpc.command('/tower models');
    report.note(`/tower models:\n${models.text}`);
    const rows = {
      orchestrator: firstLine(models.text, /^orchestrator\s/),
      worker: firstLine(models.text, /^worker\s/),
      reviewer: firstLine(models.text, /^reviewer\s/),
    };
    const rowOk = (row: string | undefined, role: RoleModel, source: string): boolean =>
      row !== undefined && row.includes(role.model) && row.includes(source) && (role.thinking === undefined || row.includes(`${role.thinking} (configured)`));
    report.check('/tower models: orchestrator = A from --tower-orchestrator-model (flag beats tower.json)', rowOk(rows.orchestrator, A, '--tower-orchestrator-model'), rows.orchestrator ?? '(no row)');
    report.check('/tower models: worker = B from the global tower.json', rowOk(rows.worker, B, `${configPath} (global)`), rows.worker ?? '(no row)');
    report.check('/tower models: reviewer = C from env PI_TOWER_REVIEWER_MODEL (env beats tower.json)', rowOk(rows.reviewer, C, 'env PI_TOWER_REVIEWER_MODEL'), rows.reviewer ?? '(no row)');

    const pre = await rpc.prompt('Reply with the single word READY and call no tools.', TURN_TIMEOUT_MS);
    const preModels = distinct(rpc.assistantTurns(pre.from, pre.to).map((turn) => `${String(turn.provider)}/${String(turn.model)}`));
    report.check('before /tower on the main session answers on the starting model', preModels.length === 1 && preModels[0] === P.model, `assistant models before /tower on: ${preModels.join(', ')}`);

    const on = await rpc.command('/tower on');
    const onState = await rpc.send({ type: 'get_state' });
    const onModel = `${String(onState.data?.model?.provider)}/${String(onState.data?.model?.id)}`;
    const onThinking = String(onState.data?.thinkingLevel);
    report.check(
      `/tower on switches the main session to the orchestrator model A${A.thinking === undefined ? '' : ` at thinking ${A.thinking}`}`,
      /Tower mode: ON/.test(on.text) && onModel === A.model && (A.thinking === undefined || onThinking === A.thinking),
      `${on.text.split('\n')[0] ?? ''}; session model now ${onModel} (thinking ${onThinking})`,
    );

    const objective = await rpc.prompt(OBJECTIVE, TURN_TIMEOUT_MS);
    const objectiveModels = distinct(rpc.assistantTurns(objective.from, objective.to).map((turn) => `${String(turn.provider)}/${String(turn.model)}`));
    report.check('after /tower on every orchestrator assistant message carries A', objectiveModels.length === 1 && objectiveModels[0] === A.model, `assistant models after /tower on: ${objectiveModels.join(', ')}`);
    await waitAgentNotification(rpc, WORKER, objective.from);
    await rpc.waitIdle(TURN_TIMEOUT_MS);

    const mission = towerState(repo)?.missions.find((candidate) => candidate.id === 'M1');
    if (mission === undefined) throw new Error('mission M1 was not planned');
    report.note(`M1 status after the worker: ${mission.status} (branch ${mission.branch})`);
    const reviews = await rpc.prompt(reviewPrompt(mission.branch), TURN_TIMEOUT_MS);
    for (const name of REVIEWERS) await waitAgentNotification(rpc, name, reviews.from);
    await rpc.waitIdle(TURN_TIMEOUT_MS);

    const runs = rpc.toolRuns();
    const agentsText = (await rpc.command('/tower agents')).text;
    report.note(`/tower agents:\n${agentsText}`);
    const tasksText = runsOf(runs, 'TowerTasks').map((run) => run.output).join('\n');
    checkAgentModel(ctx, repo, { name: WORKER, kind: 'worker', role: 'worker', expected: B, spawn: spawnRun(runs, WORKER), agentsText, tasksText });
    checkAgentModel(ctx, repo, { name: REVIEWERS[0], kind: 'reviewer', role: 'reviewer', expected: C, spawn: spawnRun(runs, REVIEWERS[0]), agentsText, tasksText });

    const asWorker = spawnRun(runs, REVIEWERS[1]);
    report.check(
      `${REVIEWERS[1]}: the user's "use the worker model" request became TowerSpawn model="worker"`,
      asWorker?.args.model === 'worker',
      asWorker === undefined ? 'not spawned' : `TowerSpawn args: ${JSON.stringify(asWorker.args)}`,
    );
    checkAgentModel(ctx, repo, { name: REVIEWERS[1], kind: 'reviewer', role: 'worker (explicit choice)', expected: B, spawn: asWorker, agentsText, tasksText });
    checkAgentModel(ctx, repo, { name: REVIEWERS[2], kind: 'reviewer', role: 'reviewer (default again)', expected: C, spawn: spawnRun(runs, REVIEWERS[2]), agentsText, tasksText });

    for (const review of reviewFiles(repo)) {
      const fields = frontmatter(review.text);
      report.note(`review file ${review.name}: reviewer=${String(fields.reviewer)} status=${String(fields.status)} merge=${String(fields.merge)} round=${String(fields.round)}`);
    }

    const bogus = runsOf(runs, 'TowerSpawn').find((run) => run.args.model === BOGUS_MODEL);
    report.check(
      'an invalid model choice is refused with the allowed list',
      bogus !== undefined && bogus.isError && bogus.output.includes(`Invalid model "${BOGUS_MODEL}" — available models: orchestrator, primary, worker, reviewer`),
      bogus === undefined ? `no TowerSpawn with model "${BOGUS_MODEL}"` : clip(bogus.output, 400),
    );

    const off = await rpc.command('/tower off');
    const offModel = await sessionModel(rpc);
    report.check('/tower off restores the starting model', /Tower mode: OFF/.test(off.text) && offModel === P.model, `${off.text.split('\n')[0] ?? ''}; session model now ${offModel}`);
    const post = await rpc.prompt('Reply with the single word BYE and call no tools.', TURN_TIMEOUT_MS);
    const postModels = distinct(rpc.assistantTurns(post.from, post.to).map((turn) => `${String(turn.provider)}/${String(turn.model)}`));
    report.check('after /tower off the main session answers on the starting model again', postModels.length === 1 && postModels[0] === P.model, `assistant models after /tower off: ${postModels.join(', ')}`);

    const state = await rpc.send({ type: 'get_state' });
    const sessionFile = String(state.data?.sessionFile ?? '');
    const { changes, segments } = sessionSegments(sessionFile);
    const segmentLines = segments.map((segment) => `model_change ${segment.model} → ${String(segment.assistant.length)} assistant message(s) on ${distinct(segment.assistant).join(',') || '-'} at thinking ${distinct(segment.thinking).join(',') || '-'}`);
    const withMessages = segments.filter((segment) => segment.assistant.length > 0);
    const orchestratorThinking = withMessages[1]?.thinking ?? [];
    report.check(
      `the orchestrator session JSONL shows P → A (/tower on) → P (/tower off), each assistant message on the active model${A.thinking === undefined ? '' : `, A's at thinking ${A.thinking}`}`,
      withMessages.map((segment) => segment.model).join(' → ') === `${P.model} → ${A.model} → ${P.model}` &&
        segments.every((segment) => segment.assistant.every((model) => model === segment.model)) &&
        (A.thinking === undefined || (orchestratorThinking.length > 0 && orchestratorThinking.every((level) => level === A.thinking))),
      [`session file: ${sessionFile}`, `model_change sequence: ${changes.join(' → ')}`, ...segmentLines],
    );

    await recordUsage(ctx, session);
    await rpc.close();
    await fallbackCheck(ctx);
  },
};

