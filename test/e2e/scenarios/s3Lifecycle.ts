import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { agentTranscriptPath, frontmatter, reviewFiles, summarizeTranscript, towerState, type MissionRecord, type RosterEntry } from '../evidence.ts';
import { clip, type PiRpc } from '../rpc.ts';
import { driveUntil, recordUsage, roleConfig, runsOf, sessionModel, startSession, TURN_TIMEOUT_MS, type ScenarioContext, type ScenarioDefinition } from '../scenario.ts';
import { git, listFiles, tryGit } from '../workspace.ts';

const OBJECTIVE = [
  'Objective — an automated end-to-end test of the tower. Run it to the end on your own and never ask me questions.',
  'Start with TowerInit, then plan exactly these three missions in a single TowerPlan call:',
  '- title "Add gamma line to notes", kind build, scope ["notes.txt"], tasks ["Add one new last line to notes.txt whose entire content is the single word gamma", "Commit the change on the mission branch"].',
  '- title "Add four line to numbers", kind build, scope ["numbers.txt"], deps ["M1"], tasks ["Add one new last line to numbers.txt whose entire content is the number 4", "Commit the change on the mission branch"].',
  '- title "Survey README first line", kind survey, scope ["README.md"], tasks ["Report in the completion report how many words the first line of README.md has; change no files"].',
  'Spawn the three workers right away so they run in parallel: agent-gamma for M1, agent-four for M2, agent-survey for M3.',
  'Then drive the protocol yourself: one independent reviewer per completed build mission, merges in dependency order (M1 before M2), TowerRebase when the merge gate reports a stale base, and close the survey once its summary is in.',
  'You are done when every mission is merged. Do not call TowerTeardown — I will ask for that separately.',
].join('\n');

const NUDGE = 'Continue driving the objective with the tower tools until every mission is merged. Do not call TowerTeardown yet.';

function missions(repo: string): readonly MissionRecord[] {
  return towerState(repo)?.missions ?? [];
}

function allMerged(repo: string): boolean {
  const list = missions(repo);
  return list.length === 3 && list.every((mission) => mission.status === 'merged');
}

function overlaps(a: { firstAt: number; lastAt: number }, b: { firstAt: number; lastAt: number }): boolean {
  return a.firstAt < b.lastAt && b.firstAt < a.lastAt;
}

function customCount(rpc: PiRpc, type: string, pattern: RegExp, from: number): number {
  return rpc.customMessages(type, from).filter((message) => pattern.test(message.text)).length;
}

async function teardown(ctx: ScenarioContext, rpc: PiRpc, repo: string, mergedMissions: readonly MissionRecord[]): Promise<void> {
  const { report } = ctx;
  await rpc.waitIdle(TURN_TIMEOUT_MS, 3000);
  const mark = rpc.events.length;
  await rpc.command('/tower teardown');
  await rpc.waitFor((event) => event.type === 'agent_start', 60_000, 'the teardown turn to start', mark);
  await rpc.waitFor((event) => event.type === 'agent_settled', TURN_TIMEOUT_MS, 'the teardown turn to settle', mark);
  await rpc.waitIdle(TURN_TIMEOUT_MS, 3000);
  const run = runsOf(rpc.toolRuns(mark), 'TowerTeardown').find((candidate) => !candidate.isError);
  report.check('/tower teardown makes the tower call TowerTeardown', run !== undefined, clip(run?.output ?? 'no successful TowerTeardown call', 400));

  const worktrees = git(repo, ['worktree', 'list', '--porcelain']).split('\n').filter((line) => line.startsWith('worktree '));
  const leftover = listFiles(join(repo, '.tower', 'worktrees')).filter((name) => name.startsWith('wt-'));
  report.check('teardown removes the mission worktrees', worktrees.length === 1 && leftover.length === 0, [`git worktree list: ${worktrees.join(' | ')}`, `.tower/worktrees entries: ${leftover.join(', ') || '(none)'}`]);

  const branches = git(repo, ['branch', '--list', '--format=%(refname:short)']).split('\n');
  const kept = mergedMissions.map((mission) => mission.branch).filter((branch) => branches.includes(branch));
  const comms = ['state.json', 'MISSIONS.md', 'reviews', 'inbox', 'log'].filter((name) => existsSync(join(repo, '.tower', 'comms', name)));
  report.check(
    'teardown keeps the mission branches and .tower/comms',
    kept.length === mergedMissions.length && comms.length === 5,
    [`branches: ${branches.join(', ')}`, `.tower/comms keeps: ${comms.join(', ')}`],
  );
}

export const s3Lifecycle: ScenarioDefinition = {
  id: 'S3',
  title: 'full objective lifecycle',
  mandatory: true,
  async run(ctx) {
    const { settings, report } = ctx;
    const session = await startSession(ctx, { towerConfig: roleConfig(settings, { maxRunningAgents: 4 }) });
    const { rpc, repo } = session;
    const initial = git(repo, ['rev-parse', 'HEAD']);
    const on = await rpc.command('/tower on');
    report.check('/tower on', /Tower mode: ON/.test(on.text), on.text);

    const start = rpc.events.length;
    await rpc.send({ type: 'prompt', message: OBJECTIVE, streamingBehavior: 'followUp' });
    const nudges = await driveUntil(ctx, rpc, () => allMerged(repo), { label: 'every mission merged', timeoutMs: 16 * 60_000, nudge: NUDGE });
    report.note(`autonomous run finished with ${String(nudges)} nudge(s)`);

    const runs = rpc.toolRuns(start);
    const state = towerState(repo);
    const list = missions(repo);
    const [m1, m2, m3] = [list.find((m) => m.id === 'M1'), list.find((m) => m.id === 'M2'), list.find((m) => m.id === 'M3')];
    const init = runsOf(runs, 'TowerInit').find((run) => !run.isError);
    const plan = runsOf(runs, 'TowerPlan').find((run) => !run.isError);
    report.check(
      'TowerInit + TowerPlan create two dependent build missions and one survey',
      init !== undefined && plan !== undefined && m1?.kind === 'build' && m2?.kind === 'build' && (m2.deps ?? []).includes('M1') && m3?.kind === 'survey',
      list.map((m) => `${m.id} ${m.kind ?? '?'} "${m.title ?? ''}" deps=[${(m.deps ?? []).join(',')}] status=${m.status} branch=${m.branch}`),
    );

    const roster: readonly RosterEntry[] = state?.roster.agents ?? [];
    const workers = roster.filter((agent) => agent.kind === 'worker');
    const reviewers = roster.filter((agent) => agent.kind === 'reviewer');
    const summaries = new Map(roster.map((agent) => [agent.name, agentTranscriptPath(repo, agent.agentId)] as const).filter((pair): pair is readonly [string, string] => pair[1] !== undefined).map(([name, path]) => [name, summarizeTranscript(path)] as const));

    const cwdLines = workers.map((worker) => {
      const expected = join(repo, '.tower', 'worktrees', worker.worktree ?? '?');
      const transcriptCwd = summaries.get(worker.name)?.cwd;
      return { ok: worker.cwd === expected && transcriptCwd === expected, line: `${worker.name} (${worker.missionId ?? '?'}): roster cwd=${String(worker.cwd)} transcript cwd=${String(transcriptCwd)}` };
    });
    report.check('every worker runs with cwd = its mission worktree', workers.length >= 3 && cwdLines.every((entry) => entry.ok), cwdLines.map((entry) => entry.line));

    const windows = workers.flatMap((worker) => {
      const summary = summaries.get(worker.name);
      return summary === undefined ? [] : [{ name: worker.name, firstAt: summary.firstAt, lastAt: summary.lastAt }];
    });
    const parallel = windows.flatMap((a, index) => windows.slice(index + 1).filter((b) => overlaps(a, b)).map((b) => `${a.name} ∥ ${b.name}`));
    report.check(
      'at least two workers ran at the same time',
      parallel.length > 0,
      [...windows.map((w) => `${w.name}: ${new Date(w.firstAt).toISOString()} → ${new Date(w.lastAt).toISOString()}`), `overlapping: ${parallel.join(', ') || '(none)'}`],
    );

    const reviewWakes = customCount(rpc, 'tower-inbox-wake', /review-request/, start);
    const digestWakes = customCount(rpc, 'tower-inbox-wake', /Gate digest:/, start);
    const surveyWakes = customCount(rpc, 'tower-inbox-wake', /survey-summary/, start);
    report.check(
      'TowerComplete wakes the tower (review-request and survey-summary wakes with a gate digest)',
      reviewWakes >= 2 && digestWakes >= 1 && surveyWakes >= 1,
      `tower-inbox-wake messages: review-request=${String(reviewWakes)} survey-summary=${String(surveyWakes)} with gate digest=${String(digestWakes)}`,
    );

    const reviewerLines = reviewers.map((reviewer) => {
      const summary = summaries.get(reviewer.name);
      const writes = (summary?.toolCalls ?? []).filter((call) => call.name === 'write' || call.name === 'edit');
      const ok = reviewer.cwd === repo && summary?.cwd === repo && !(summary.tools.includes('write') || summary.tools.includes('edit')) && writes.length === 0;
      return { ok, line: `${reviewer.name} → ${String(reviewer.reviewTarget)}: cwd=${String(summary?.cwd)} tools=${(summary?.tools ?? []).filter((tool) => !tool.startsWith('Tower')).join(',')} write/edit calls=${String(writes.length)}` };
    });
    const reviewedBranches = new Set(reviewers.map((reviewer) => reviewer.reviewTarget));
    report.check(
      'independent reviewers run read-only in the main checkout, one per build mission',
      m1 !== undefined && m2 !== undefined && reviewedBranches.has(m1.branch) && reviewedBranches.has(m2.branch) && reviewerLines.every((entry) => entry.ok),
      reviewerLines.map((entry) => entry.line),
    );

    const reviews = reviewFiles(repo).map((review) => ({ name: review.name, fields: frontmatter(review.text) }));
    for (const review of reviews) report.note(`review ${review.name}: reviewer=${String(review.fields.reviewer)} target=${String(review.fields.target)} status=${String(review.fields.status)} merge=${String(review.fields.merge)} round=${String(review.fields.round)}`);
    const merges = runsOf(runs, 'TowerMerge').filter((run) => !run.isError);
    const mergeOrder = merges.map((run) => list.find((mission) => mission.branch === run.args.branch)?.id ?? String(run.args.branch));
    const mergeCommits = git(repo, ['log', '--merges', '--format=%H %P | %s', 'main']).split('\n').filter((line) => line.length > 0);
    const mergeOf = (mission: MissionRecord | undefined): string | undefined =>
      mission === undefined ? undefined : mergeCommits.find((line) => line.endsWith(`Merge branch '${mission.branch}'`))?.split(' ')[0];
    const m1Merge = mergeOf(m1);
    const m2Merge = mergeOf(m2);
    const ordered = m1Merge !== undefined && m2Merge !== undefined && tryGit(repo, ['merge-base', '--is-ancestor', m1Merge, m2Merge]) !== undefined;
    report.check(
      'TowerMerge lands M1 then M2 as --no-ff merge commits on main',
      ordered && mergeCommits.length >= 2,
      [`successful TowerMerge calls in order: ${mergeOrder.join(' → ')}`, ...mergeCommits.map((line) => `merge commit ${line}`)],
    );
    report.note(`git log --graph --oneline main:\n${git(repo, ['log', '--graph', '--oneline', '--decorate', 'main', '-n', '14'])}`);
    const notes = git(repo, ['show', 'main:notes.txt']).split('\n');
    const numbers = git(repo, ['show', 'main:numbers.txt']).split('\n');
    report.check('main carries both build changes', notes.at(-1) === 'gamma' && numbers.at(-1) === '4', `main:notes.txt=${JSON.stringify(notes)} main:numbers.txt=${JSON.stringify(numbers)}`);

    const surveyDiff = m3 === undefined ? undefined : tryGit(repo, ['diff', '--stat', `${initial}...${m3.branch}`]);
    const surveyReviews = reviews.filter((review) => review.fields.target === m3?.branch || review.fields.mission === 'M3');
    const surveyMerge = mergeOf(m3) !== undefined;
    report.check(
      'the survey closes zero-diff without a review',
      m3?.status === 'merged' && surveyDiff === '' && surveyReviews.length === 0 && !surveyMerge,
      `M3 status=${String(m3?.status)} diff vs base: ${surveyDiff === '' ? '(empty)' : String(surveyDiff)} reviews=${String(surveyReviews.length)} merge commit=${String(surveyMerge)}`,
    );

    const notified = roster.filter((agent) => rpc.customMessages('tower-agent-notification', start).some((message) => message.text.includes(`name="${agent.name}"`)));
    report.check('a finished notification arrives for every agent', notified.length === roster.length, `notified ${String(notified.length)}/${String(roster.length)}: ${notified.map((agent) => agent.name).join(', ')}`);
    const reminders = rpc.customMessages('tower-mode-reminder', start);
    const full = reminders.filter((message) => message.text.startsWith('Tower mode is active.')).length;
    const sparse = reminders.filter((message) => message.text.startsWith('Tower mode still active.')).length;
    report.check('the full reminder comes first, then sparse reminders', full >= 1 && sparse >= 1 && reminders[0]?.text.startsWith('Tower mode is active.') === true, `tower-mode-reminder: full=${String(full)} sparse=${String(sparse)}`);

    const status = await rpc.command('/tower status');
    const missionLines = status.text.split('\n').filter((line) => /^\s+M\d /.test(line));
    report.check('/tower status shows every mission done', missionLines.length === 3 && missionLines.every((line) => line.includes('— merged')), missionLines);

    await teardown(ctx, rpc, repo, list);
    const off = await rpc.command('/tower off');
    const model = await sessionModel(rpc);
    report.check('/tower off ends the run and restores the starting model', /Tower mode: OFF/.test(off.text) && model === settings.session.model, `${off.text}; session model ${model}`);
    report.note(`activity log merges: ${readFileSync(join(repo, '.tower', 'comms', 'log', 'activity.log'), 'utf8').split('\n').filter((line) => / merge /.test(line)).join(' | ')}`);
    await recordUsage(ctx, session);
  },
};
