import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { agentTranscriptPath, frontmatter, reviewFiles, rosterEntry, summarizeTranscript, towerState } from '../evidence.ts';
import { clip, textOf } from '../rpc.ts';
import { driveUntil, recordUsage, roleConfig, runsOf, startSession, TURN_TIMEOUT_MS, type ScenarioDefinition } from '../scenario.ts';
import { git } from '../workspace.ts';

const WORKER = 'agent-four';

const OBJECTIVE = [
  'Tower test (automated end-to-end test) — follow these steps exactly:',
  '1. Call TowerInit with no arguments.',
  '2. Call TowerPlan with one build mission: title "Add four line to numbers", scope ["numbers.txt"], tasks ["Add one new last line to numbers.txt whose entire content is the number 4", "Commit the change on the mission branch"].',
  `3. Spawn the worker with TowerSpawn: name "${WORKER}", kind "worker", mission_id "M1".`,
  `4. End your turn. When ${WORKER} reports completion, only acknowledge it in one short sentence: do not spawn a reviewer and do not merge until I say go.`,
].join('\n');

const GO = [
  'Go: review M1 now with one reviewer named "reviewer-r1".',
  `Then drive M1 to merged on your own: if a review is not clean, route the findings back to ${WORKER} (resume it so it keeps its context), have a fresh reviewer named "reviewer-r2" review the fix, and merge once a clean review with a merge verdict is in.`,
  'Stop when M1 is merged; do not call TowerTeardown.',
].join('\n');

export const s4Rework: ScenarioDefinition = {
  id: 'S4',
  title: 'review rework loop',
  mandatory: false,
  async run(ctx) {
    const { settings, report } = ctx;
    const session = await startSession(ctx, { towerConfig: roleConfig(settings, { maxRunningAgents: 2 }) });
    const { rpc, repo } = session;
    await rpc.command('/tower on');
    const span = await rpc.prompt(OBJECTIVE, TURN_TIMEOUT_MS);
    await rpc.waitFor(
      (event) => event.type === 'message_end' && event.message?.customType === 'tower-agent-notification' && textOf(event.message?.content).includes(`name="${WORKER}"`),
      6 * 60_000,
      `the finished notification of ${WORKER}`,
      span.from,
    );
    await rpc.waitIdle(TURN_TIMEOUT_MS, 3000);
    const mission = towerState(repo)?.missions.find((candidate) => candidate.id === 'M1');
    if (mission?.status !== 'completed') throw new Error(`M1 is ${String(mission?.status)} after the worker finished`);

    const worktree = join(repo, '.tower', 'worktrees', mission.worktree);
    const file = join(worktree, 'numbers.txt');
    const planted = readFileSync(file, 'utf8').replace(/^4$/m, '5');
    writeFileSync(file, planted);
    git(worktree, ['commit', '-q', '-am', 'numbers: adjust the new line']);
    report.note(`planted defect on ${mission.branch}: numbers.txt now ends with ${JSON.stringify(planted.trim().split('\n').at(-1))} (task requires 4), commit ${git(worktree, ['rev-parse', '--short', 'HEAD'])}`);

    const statuses: string[] = [];
    const observe = (): boolean => {
      const status = towerState(repo)?.missions.find((candidate) => candidate.id === 'M1')?.status ?? '?';
      if (statuses.at(-1) !== status) statuses.push(status);
      return status === 'merged';
    };
    const go = rpc.events.length;
    await rpc.send({ type: 'prompt', message: GO, streamingBehavior: 'followUp' });
    const nudges = await driveUntil(ctx, rpc, observe, { label: 'M1 merged after rework', timeoutMs: 14 * 60_000, nudge: 'Continue: drive M1 through the rework loop until it is merged.' });
    report.note(`drive finished with ${String(nudges)} nudge(s)`);

    const reviews = reviewFiles(repo).map((review) => ({ name: review.name, fields: frontmatter(review.text) })).filter((review) => review.fields.target === mission.branch);
    for (const review of reviews) report.note(`review ${review.name}: reviewer=${String(review.fields.reviewer)} seq=${String(review.fields.seq)} round=${String(review.fields.round)} status=${String(review.fields.status)} merge=${String(review.fields.merge)}`);
    report.note('rounds are numbered per reviewer (kimi parity, survey 8.2); seq orders the reviews of a branch');
    const first = reviews.find((review) => review.fields.seq === '1');
    const second = reviews.find((review) => review.fields.seq === '2');
    report.check('the first review (seq 1) finds the planted defect (p1 verdict, no merge)', first !== undefined && /^p1-/.test(first.fields.status ?? '') && first.fields.merge !== 'merge', first === undefined ? 'no seq-1 review' : `${first.name}: status=${String(first.fields.status)} merge=${String(first.fields.merge)}`);
    report.check('the p1 verdict flips the mission completed → active', statuses.join(' → ').includes('completed → active'), `observed M1 statuses: ${statuses.join(' → ')}`);

    const runs = rpc.toolRuns(go);
    const resumed = runsOf(runs, 'TowerResume').filter((run) => !run.isError);
    const steered = runsOf(runs, 'TowerSend').filter((run) => run.args.to === WORKER && /steered/.test(run.output));
    report.check(
      `the findings go back to ${WORKER}, which keeps its context`,
      resumed.length > 0 || steered.length > 0,
      [...resumed.map((run) => `TowerResume ${JSON.stringify(run.args).slice(0, 200)} → ${clip(run.output, 160)}`), ...steered.map((run) => `TowerSend → ${clip(run.output, 160)}`)],
    );
    const r2 = rosterEntry(repo, 'reviewer-r2');
    const r2Path = r2 === undefined ? undefined : agentTranscriptPath(repo, r2.agentId);
    const briefing = r2Path === undefined ? '' : summarizeTranscript(r2Path).prompt;
    report.check(
      'the fresh reviewer is briefed with the round-1 history',
      /Round 1 by reviewer-r1|round 1 by reviewer-r1/.test(briefing),
      clip(briefing.split('\n').find((line) => /round 1 by reviewer-r1/i.test(line)) ?? '(no round-1 history in the reviewer-r2 briefing)', 240),
    );
    report.check('the second review (seq 2, by the fresh reviewer) is clean with a merge verdict', second !== undefined && second.fields.reviewer === 'reviewer-r2' && second.fields.status === 'clean' && second.fields.merge === 'merge', second === undefined ? 'no seq-2 review' : `${second.name}: status=${String(second.fields.status)} merge=${String(second.fields.merge)}`);
    const numbers = git(repo, ['show', 'main:numbers.txt']).split('\n');
    report.check('the fixed change merges into main', statuses.at(-1) === 'merged' && numbers.at(-1) === '4', `main:numbers.txt=${JSON.stringify(numbers)}; ${git(repo, ['log', '--oneline', '-1', 'main'])}`);
    await rpc.command('/tower off');
    await recordUsage(ctx, session);
  },
};
