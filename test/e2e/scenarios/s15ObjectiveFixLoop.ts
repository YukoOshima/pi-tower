import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { agentTranscriptPath, frontmatter, logEntries, reviewFiles, summarizeTranscript, towerState, type LogEntry, type MissionRecord, type TowerState, type ValidationRoundRecord } from '../evidence.ts';
import {
  autopilotEntries,
  checkAutopilotPromptness,
  createTextkitRepo,
  describeObjective,
  humanScript,
  isAncestor,
  objectiveConfig,
  ObjectiveTrace,
  planToApproval,
  recordObjectiveUsage,
  validationFileFields,
  waitForObjective,
  writeText,
} from '../objective.ts';
import { clip } from '../rpc.ts';
import { startSession, type ScenarioContext, type ScenarioDefinition } from '../scenario.ts';
import { git, readJsonFile, tryGit } from '../workspace.ts';

const MAX_COST_USD = 6;
const MAX_WALL_TIME_MS = 40 * 60_000;
const DELIVERABLE = 'docs/USAGE.md';

interface AcceptRun {
  readonly execution: number;
  readonly cwd: string;
  readonly commit: string;
  readonly present: boolean;
  readonly pass: boolean;
  readonly at: string;
}

export function acceptScript(runsFile: string): string {
  return [
    "import { execFileSync } from 'node:child_process';",
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "import { basename, join } from 'node:path';",
    '',
    `const RUNS = ${JSON.stringify(runsFile)};`,
    'const cwd = process.cwd();',
    'if (!/^val-.*commands/.test(basename(cwd))) {',
    "  console.log('acceptance check: nothing to verify here — it checks the checkout of the tower commands validation');",
    '  process.exit(0);',
    '}',
    "const runs = existsSync(RUNS) ? JSON.parse(readFileSync(RUNS, 'utf8')) : [];",
    `const usage = join(cwd, ${JSON.stringify(DELIVERABLE)});`,
    "const present = existsSync(usage) && /usage/i.test(readFileSync(usage, 'utf8'));",
    "let commit = 'unknown';",
    'try {',
    "  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();",
    '} catch {}',
    'const execution = runs.length + 1;',
    'const pass = execution > 1 && present;',
    'runs.push({ execution, cwd, commit, present, pass, at: new Date().toISOString() });',
    "writeFileSync(RUNS, `${JSON.stringify(runs, null, 2)}\\n`);",
    'if (pass) {',
    `  console.log(\`acceptance check passed: ${DELIVERABLE} documents the CLI (check \${execution})\`);`,
    '  process.exit(0);',
    '}',
    'console.error(',
    '  present',
    `    ? 'ACCEPTANCE FAILED: ${DELIVERABLE} was not accepted on this first acceptance pass — a fix feature must rewrite it: a "## Usage" section that shows how to run \`node src/cli.js <command> [args...]\` and one example (command line and printed output) for every command.'`,
    `    : 'ACCEPTANCE FAILED: ${DELIVERABLE} is missing — add usage docs for the CLI: create ${DELIVERABLE} with a "## Usage" section that shows how to run \`node src/cli.js <command> [args...]\` and one example (command line and printed output) for every command.',`,
    ');',
    'process.exit(1);',
    '',
  ].join('\n');
}

export function objectiveText(script: string): string {
  return [
    '# textkit: slug and count commands',
    '',
    'This objective is complete as written — do not ask me questions. Draft the objective, plan the features and request approval in this turn; I approve the plan with /tower approve.',
    '',
    '## Goal',
    'Add two commands to the textkit CLI in this repository (read README.md first):',
    '- `slug` prints its arguments as a URL slug: the lower-cased words of letters and digits joined by single hyphens, everything else dropped. `node src/cli.js slug Hello, World!` prints `hello-world`.',
    '- `count` prints the number of words in its arguments. `node src/cli.js count the quick brown fox` prints `4`.',
    '',
    '## Plan',
    '- Exactly one milestone with exactly two build features that run in parallel, one per command. Each feature owns only its own two files: `src/commands/slug.js` + `test/slug.test.js`, and `src/commands/count.js` + `test/count.test.js`.',
    '- Each feature adds its command module and a node:test test file; no dependencies.',
    '- Out of scope: other commands and changes to `src/cli.js`.',
    '',
    '## Definition of done',
    '- `node src/cli.js slug Hello, World!` prints `hello-world`',
    '- `node src/cli.js count the quick brown fox` prints `4`',
    '- `npm test` passes',
    '',
    '## Validation',
    '- Milestone validation: scrutiny on, user testing off, no extra milestone commands.',
    '- `acceptance_commands` must be exactly these two commands, verbatim and in this order (the repository has no dependencies, so they need no install step):',
    '  - `npm test`',
    `  - \`node ${script}\``,
    '',
  ].join('\n');
}

const HUMAN_REPLY =
  'No more questions from me — everything I want is in the objective. Decide any open point yourself and keep going on your own: draft and plan it, request approval when the plan is ready, and plan fixes when a validation fails.';

function roundFile(repo: string, round: ValidationRoundRecord): string {
  const direct = join(repo, round.file);
  return existsSync(direct) ? direct : join(repo, '.tower', 'comms', 'validations', basename(round.file));
}

function overlaps(a: { firstAt: number; lastAt: number }, b: { firstAt: number; lastAt: number }): boolean {
  return a.firstAt < b.lastAt && b.firstAt < a.lastAt;
}

function firstIndex(entries: readonly LogEntry[], match: (entry: LogEntry) => boolean): number {
  return entries.find(match)?.index ?? -1;
}

function featureOf(state: TowerState, milestone: string): { readonly plan: MissionRecord[]; readonly fix: MissionRecord[] } {
  const features = state.missions.filter((mission) => mission.milestone === milestone);
  return { plan: features.filter((mission) => mission.origin !== 'fix'), fix: features.filter((mission) => mission.origin === 'fix') };
}

function assertPlan(ctx: ScenarioContext, state: TowerState, script: string): void {
  const objective = state.objective;
  const ms1 = objective?.milestones[0];
  const plan = ms1 === undefined ? [] : featureOf(state, ms1.id).plan;
  ctx.report.check(
    'the orchestrator drafts the objective, plans two MS1 features and requests approval',
    objective?.status === 'awaiting-approval' && objective.milestones.length === 1 && plan.length >= 2 && objective.acceptanceCommands.some((command) => command.includes(script)),
    describeObjective(state),
  );
}

function assertFixLoop(ctx: ScenarioContext, repo: string, state: TowerState, trace: ObjectiveTrace, runs: readonly AcceptRun[]): void {
  const { report } = ctx;
  const entries = logEntries(repo);
  const objective = state.objective;
  const ms1 = objective?.milestones[0];
  if (objective === undefined || ms1 === undefined) throw new Error('state.json has no objective with a milestone');
  const { plan, fix } = featureOf(state, ms1.id);
  const roster = state.roster.agents;

  const draft = firstIndex(entries, (entry) => entry.action === 'objective.draft');
  const request = firstIndex(entries, (entry) => entry.action === 'objective.request-approval');
  const approve = entries.find((entry) => entry.action === 'objective.approve');
  const notified = entries.find((entry) => entry.actor === 'autopilot' && entry.action === 'notify-human' && entry.fields.reason === 'approval');
  const sequence = trace.objective.join(' → ');
  report.check(
    'lifecycle: plan drafted → awaiting-approval → approved by the human → executing → completed',
    draft >= 0 && draft < request && approve !== undefined && request < approve.index && approve.fields.by === 'human' && objective.approvedBy === 'human' && /awaiting-approval → executing → completed$/.test(sequence),
    [`observed objective statuses: ${sequence}`, ...[draft, request].map((index) => entries[index]?.line ?? '(missing)'), approve?.line ?? '(no objective.approve line)'],
  );
  report.check(
    'the autopilot notifies the human of the approval request before the approval',
    notified !== undefined && approve !== undefined && notified.index > request && notified.index < approve.index,
    notified?.line ?? '(no autopilot notify-human reason=approval line)',
  );

  const workerWindows = plan.flatMap((mission) => {
    const worker = roster.find((agent) => agent.kind === 'worker' && agent.missionId === mission.id);
    const path = worker === undefined ? undefined : agentTranscriptPath(repo, worker.agentId);
    if (worker === undefined || path === undefined) return [];
    const summary = summarizeTranscript(path);
    return [{ name: worker.name, mission: mission.id, firstAt: summary.firstAt, lastAt: summary.lastAt }];
  });
  const parallel = workerWindows.flatMap((a, index) => workerWindows.slice(index + 1).filter((b) => overlaps(a, b)).map((b) => `${a.name} ∥ ${b.name}`));
  const spawns = autopilotEntries(repo, 'spawn-worker').filter((entry) => entry.fields.result === 'started');
  report.check(
    'the autopilot runs the MS1 plan features in parallel',
    plan.length >= 2 && plan.every((mission) => spawns.some((entry) => entry.fields.mission === mission.id)) && parallel.length > 0,
    [...spawns.map((entry) => entry.line), ...workerWindows.map((w) => `${w.name} (${w.mission}): ${new Date(w.firstAt).toISOString()} → ${new Date(w.lastAt).toISOString()}`), `overlapping: ${parallel.join(', ') || '(none)'}`],
  );

  const reviews = reviewFiles(repo).map((review) => ({ name: review.name, fields: frontmatter(review.text) }));
  const merges = entries.filter((entry) => entry.actor === 'tower' && entry.action === 'merge');
  const featureLines = [...plan, ...fix].map((mission) => {
    const workers = roster.filter((agent) => agent.kind === 'worker' && agent.missionId === mission.id).map((agent) => agent.name);
    const own = reviews.filter((review) => review.fields.target === mission.branch).sort((a, b) => Number(a.fields.seq ?? 0) - Number(b.fields.seq ?? 0));
    const last = own.at(-1);
    const reviewer = roster.find((agent) => agent.name === last?.fields.reviewer);
    const merge = merges.find((entry) => entry.fields.branch === mission.branch);
    const ok = mission.status === 'merged' && last?.fields.status === 'clean' && last.fields.merge === 'merge' && reviewer?.kind === 'reviewer' && !workers.includes(reviewer.name) && merge !== undefined;
    return { ok, line: `${mission.id} (${String(mission.origin)}) workers=${workers.join(',')} reviews=${own.map((review) => `${String(review.fields.reviewer)}:${String(review.fields.status)}/${String(review.fields.merge)}`).join(',') || '(none)'} merge=${merge?.fields.merge_commit ?? '(none)'} status=${mission.status}` };
  });
  report.check(
    'every feature gets an independent clean review and merges through the gate',
    featureLines.length >= 3 && featureLines.every((entry) => entry.ok),
    [...featureLines.map((entry) => entry.line), ...autopilotEntries(repo).filter((entry) => entry.action === 'spawn-reviewer' || entry.action === 'merge' || entry.action === 'rebase').map((entry) => entry.line)],
  );

  const commandsRounds = ms1.rounds.filter((round) => round.kind === 'commands').sort((a, b) => a.round - b.round);
  const failed = commandsRounds[0];
  const failedText = failed === undefined ? '' : existsSync(roundFile(repo, failed)) ? readFileSync(roundFile(repo, failed), 'utf8') : '';
  const failedFields = frontmatter(failedText);
  const failedSubmit = entries.find((entry) => entry.action === 'validation.submit' && entry.fields.kind === 'commands' && entry.fields.verdict === 'fail');
  report.check(
    `a failed commands round: the acceptance check reports ${DELIVERABLE} missing on the first validation commit`,
    failed !== undefined && failed.verdict === 'fail' && failed.validator === 'tower' && failedFields.verdict === 'fail' && failedText.includes(`${DELIVERABLE} is missing`) && runs[0]?.present === false && runs[0].commit === failed.validatedCommit,
    [
      failed === undefined ? '(no commands round)' : `commands r${String(failed.round)} ${failed.verdict} by ${failed.validator} on ${failed.validatedCommit.slice(0, 7)} — ${clip(failed.failures.join(' | '), 300)}`,
      `validation file ${failed?.file ?? '?'}: verdict=${String(failedFields.verdict)} validator=${String(failedFields.validator)} round=${String(failedFields.round)}`,
      failedSubmit?.line ?? '(no failing validation.submit line)',
      `acceptance script runs: ${runs.map((run) => `#${String(run.execution)} ${run.commit.slice(0, 7)} present=${String(run.present)} pass=${String(run.pass)}`).join('; ') || '(none)'}`,
    ],
  );

  const wake = entries.find((entry) => entry.actor === 'autopilot' && entry.action === 'wake-orchestrator' && entry.fields.reason === 'validation-failed');
  report.check(
    'the failed validation wakes the orchestrator (validation-failed)',
    wake !== undefined && failedSubmit !== undefined && wake.index > failedSubmit.index,
    wake?.line ?? '(no autopilot wake-orchestrator reason=validation-failed line)',
  );

  const fixPlan = entries.find((entry) => entry.actor === 'tower' && entry.action === 'plan' && fix.some((mission) => (entry.fields.missions ?? '').split(',').includes(mission.id)));
  const ms1Trace = trace.milestones.get(ms1.id) ?? [];
  report.check(
    'the orchestrator plans a fix feature (origin fix) into the failed MS1, which reopens it',
    fix.length >= 1 && fixPlan !== undefined && wake !== undefined && fixPlan.index > wake.index && fixPlan.fields.reactivated === ms1.id && /failed → active/.test(ms1Trace.join(' → ')),
    [fixPlan?.line ?? '(no plan line for a fix feature)', `${ms1.id} statuses: ${ms1Trace.join(' → ')}`, ...fix.map((mission) => `${mission.id} "${mission.title ?? ''}" origin=${String(mission.origin)} status=${mission.status}`)],
  );

  const finalCommit = ms1.validationCommit ?? '';
  const latest = new Map<string, ValidationRoundRecord>();
  for (const round of [...ms1.rounds].sort((a, b) => a.round - b.round)) latest.set(round.kind, round);
  const finalRounds = [...latest.values()];
  const fixMerges = fix.flatMap((mission) => merges.filter((entry) => entry.fields.branch === mission.branch).map((entry) => entry.fields.merge_commit ?? ''));
  const mainTip = git(repo, ['rev-parse', 'main']);
  const lastRun = runs.at(-1);
  report.check(
    'MS1 re-validates on the new base tip after the fix merge and every required kind passes there',
    ms1.status === 'passed' &&
      failed !== undefined &&
      finalCommit !== failed.validatedCommit &&
      finalCommit === mainTip &&
      latest.has('scrutiny') &&
      latest.has('commands') &&
      finalRounds.every((round) => round.verdict === 'pass' && round.validatedCommit === finalCommit) &&
      fixMerges.length > 0 &&
      fixMerges.every((merge) => merge.length > 0 && isAncestor(repo, merge, finalCommit)) &&
      lastRun?.pass === true &&
      lastRun.commit === finalCommit,
    [
      `first validation commit ${failed?.validatedCommit.slice(0, 7) ?? '?'}, final validation commit ${finalCommit.slice(0, 7)}, main ${mainTip.slice(0, 7)}, fix merges ${fixMerges.join(',') || '(none)'}`,
      ...finalRounds.map((round) => `latest ${round.kind} r${String(round.round)} ${round.verdict} by ${round.validator} on ${round.validatedCommit.slice(0, 7)} at ${round.date}`),
    ],
  );

  const complete = entries.find((entry) => entry.actor === 'autopilot' && entry.action === 'complete-objective');
  const passingSubmits = entries.filter((entry) => entry.action === 'validation.submit' && entry.fields.verdict === 'pass' && finalCommit.startsWith(entry.fields.commit ?? '-'));
  const completedAt = Date.parse(objective.completedAt ?? '');
  report.check(
    'the objective completes only after the passing re-validation',
    objective.status === 'completed' &&
      complete !== undefined &&
      passingSubmits.length >= finalRounds.length &&
      passingSubmits.every((entry) => entry.index < complete.index) &&
      entries.filter((entry) => entry.action === 'objective.complete').every((entry) => entry.index > (passingSubmits.at(-1)?.index ?? Number.POSITIVE_INFINITY)) &&
      finalRounds.every((round) => Date.parse(round.date) <= completedAt),
    [complete?.line ?? '(no autopilot complete-objective line)', ...passingSubmits.map((entry) => entry.line), `completedAt ${String(objective.completedAt)}`],
  );

  const validators = roster.filter((agent) => agent.kind === 'validator');
  const scrutinyRounds = validators.filter((agent) => agent.milestoneId === ms1.id && agent.validationKind === 'scrutiny');
  report.check(
    'validators are their own roster kind: one scrutiny validator per round, on the first and on the final commit; commands rounds are run by the tower',
    scrutinyRounds.some((agent) => agent.validatedCommit === failed?.validatedCommit) &&
      scrutinyRounds.some((agent) => agent.validatedCommit === finalCommit) &&
      commandsRounds.every((round) => round.validator === 'tower') &&
      new Set(scrutinyRounds.map((agent) => agent.validationRound)).size === scrutinyRounds.length,
    validators.map((agent) => `${agent.name}: kind=${agent.kind} milestone=${String(agent.milestoneId)} validation=${String(agent.validationKind)} r${String(agent.validationRound)} on ${String(agent.validatedCommit?.slice(0, 7))} model=${String(agent.model)}`),
  );

  const files = validationFileFields(repo);
  const fileLines = ms1.rounds.map((round) => {
    const file = files.find((candidate) => candidate.name === basename(round.file));
    const fields = file?.fields ?? {};
    const ok = fields.milestone === ms1.id && fields.kind === round.kind && fields.validator === round.validator && fields.round === String(round.round) && fields.verdict === round.verdict && fields.validatedCommit === round.validatedCommit;
    return { ok, line: `${file?.name ?? `(missing ${round.file})`}: ${fields.kind ?? '?'} r${fields.round ?? '?'} ${fields.verdict ?? '?'} by ${fields.validator ?? '?'} on ${(fields.validatedCommit ?? '?').slice(0, 7)}` };
  });
  report.check(
    'every validation round has its validation file, with frontmatter matching state.json',
    fileLines.length >= 4 && fileLines.every((entry) => entry.ok) && files.length === fileLines.length,
    fileLines.map((entry) => entry.line),
  );

  const usage = tryGit(repo, ['show', `main:${DELIVERABLE}`]);
  report.check(`main carries the fix (${DELIVERABLE})`, usage !== undefined && /usage/i.test(usage), clip(usage ?? '(missing on main)', 300));
  report.check(
    `the run stays inside its budget (objective.maxCostUsd ${String(MAX_COST_USD)}) and is never paused or blocked`,
    (objective.usage?.costUsd ?? 0) <= MAX_COST_USD && !trace.objective.some((status) => status === 'paused' || status === 'blocked'),
    `objective usage $${(objective.usage?.costUsd ?? 0).toFixed(4)}; statuses ${trace.objective.join(' → ')}`,
  );
}

export const s15ObjectiveFixLoop: ScenarioDefinition = {
  id: 'S15',
  title: 'objective fix loop until the contract is met',
  mandatory: true,
  timeoutMs: 55 * 60_000,
  async run(ctx) {
    const { settings, report, dir } = ctx;
    const repo = createTextkitRepo(dir);
    const runsFile = join(dir, 'accept-s15-runs.json');
    const script = writeText(join(dir, 'accept-s15.mjs'), acceptScript(runsFile));
    const objectiveFile = writeText(join(dir, 'objective.md'), objectiveText(script));
    const session = await startSession(ctx, { repo, towerConfig: objectiveConfig(settings, { maxCostUsd: MAX_COST_USD, maxWallTimeMs: MAX_WALL_TIME_MS, skipUserTesting: true }) });
    const { rpc } = session;
    const trace = new ObjectiveTrace(repo);
    const human = humanScript(HUMAN_REPLY);
    try {
      const on = await rpc.command('/tower on');
      report.check('/tower on', /Tower mode: ON/.test(on.text), on.text);
      const handed = await rpc.command(`/tower objective @${objectiveFile}`);
      report.check('/tower objective @file hands the objective to the orchestrator', /Objective handed to the tower/.test(handed.text), handed.text);
      assertPlan(ctx, await planToApproval(ctx, rpc, repo, human), script);
      const approve = await rpc.command('/tower approve');
      report.check('the scripted human approves with /tower approve and the objective starts executing', /approved/.test(approve.text) && towerState(repo)?.objective?.status === 'executing', approve.text);
      const final = await waitForObjective(ctx, repo, (state) => state.objective?.status === 'completed', { label: 'the objective to complete', timeoutMs: MAX_WALL_TIME_MS + 5 * 60_000, rpc, human });
      trace.stop();
      assertFixLoop(ctx, repo, final, trace, readJsonFile<AcceptRun[]>(runsFile) ?? []);
      checkAutopilotPromptness(ctx, repo);
      const off = await rpc.command('/tower off');
      report.note(off.text);
    } finally {
      trace.stop();
      report.note(`status trace:\n${trace.lines().join('\n')}`);
      report.note(`final state:\n${describeObjective(towerState(repo)).join('\n')}`);
      report.note(`autopilot activity:\n${autopilotEntries(repo).map((entry) => entry.line).join('\n')}`);
      report.note(`acceptance script runs: ${JSON.stringify(readJsonFile<AcceptRun[]>(runsFile) ?? [])}`);
      recordObjectiveUsage(ctx, repo, join(dir, 'sessions'));
    }
  },
};
