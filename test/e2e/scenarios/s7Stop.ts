import { agentTranscriptPath, rosterEntry, summarizeTranscript } from '../evidence.ts';
import { clip, sleep, textOf } from '../rpc.ts';
import { recordUsage, roleConfig, runsOf, startSession, TURN_TIMEOUT_MS, type ScenarioDefinition } from '../scenario.ts';

const WORKER = 'agent-slow';

const OBJECTIVE = [
  'Tower test (automated end-to-end test) — follow these steps exactly:',
  '1. Call TowerInit with no arguments.',
  '2. Call TowerPlan with one build mission: title "Slow notes mission", scope ["notes.txt"], tasks ["First run this bash command in your worktree and wait for it: sleep 90", "Then add one new last line to notes.txt whose entire content is the single word zeta, and commit it on the mission branch"].',
  `3. Spawn the worker with TowerSpawn: name "${WORKER}", kind "worker", mission_id "M1".`,
  `4. End your turn. If ${WORKER} later stops or dies, call TowerStatus once, report what happened in one short paragraph, and do nothing else — no resume, no new spawn — unless I explicitly tell you to.`,
].join('\n');

export const s7Stop: ScenarioDefinition = {
  id: 'S7',
  title: 'human stop via /tower stop',
  mandatory: false,
  async run(ctx) {
    const { settings, report } = ctx;
    const session = await startSession(ctx, { towerConfig: roleConfig(settings, { maxRunningAgents: 2 }) });
    const { rpc, repo } = session;
    await rpc.command('/tower on');
    const span = await rpc.prompt(OBJECTIVE, TURN_TIMEOUT_MS);
    const spawned = runsOf(rpc.toolRuns(span.from, span.to), 'TowerSpawn').find((run) => !run.isError && run.args.name === WORKER);
    if (spawned === undefined) throw new Error(`${WORKER} was not spawned`);

    await rpc.waitUntil(() => {
      const entry = rosterEntry(repo, WORKER);
      const path = entry === undefined ? undefined : agentTranscriptPath(repo, entry.agentId);
      return path !== undefined && summarizeTranscript(path).toolCalls.some((call) => call.name === 'bash' && String(call.arguments.command ?? '').includes('sleep'));
    }, 3 * 60_000, `${WORKER} to start its long bash command`);
    await sleep(2000);

    const mark = rpc.events.length;
    const stop = await rpc.command(`/tower stop ${WORKER}`);
    report.check('/tower stop stops the running worker as a human stop', /Stopped agent-slow/.test(stop.text) && /stopped by you — dead by intent/.test(stop.text), stop.text);
    const notification = await rpc.waitFor(
      (event) => event.type === 'message_end' && event.message?.customType === 'tower-agent-notification' && textOf(event.message?.content).includes(`name="${WORKER}"`),
      2 * 60_000,
      `the stop notification of ${WORKER}`,
      mark,
    );
    const notificationText = textOf(notification.message?.content);
    report.check('the tower is told the worker was stopped by the user', /stopped by user/.test(notificationText) && /dead by intent/.test(notificationText), clip(notificationText, 600));
    await rpc.waitIdle(TURN_TIMEOUT_MS, 3000);

    const reaction = rpc.toolRuns(mark);
    const statusRun = runsOf(reaction, 'TowerStatus').at(-1);
    const stopLine = statusRun?.output.split('\n').find((line) => line.includes('🛑'));
    report.check('TowerStatus marks the stopped worker with 🛑', stopLine !== undefined && stopLine.includes(WORKER), stopLine ?? (statusRun === undefined ? 'TowerStatus was not called' : 'no 🛑 line'));
    const agents = await rpc.command('/tower agents');
    const agentLine = agents.text.split('\n').find((line) => line.startsWith(`- ${WORKER} `));
    report.check('/tower agents shows the worker as stopped by the human', agentLine?.includes('stopped by the human') === true, agentLine ?? agents.text);
    const autonomous = reaction.filter((run) => run.toolName === 'TowerResume' || run.toolName === 'TowerSpawn');
    report.check('the tower neither resumes nor replaces the stopped worker on its own', autonomous.length === 0, autonomous.length === 0 ? 'no TowerResume/TowerSpawn after the stop' : autonomous.map((run) => `${run.toolName} ${JSON.stringify(run.args)}`));

    const resume = await rpc.prompt(`Call TowerResume once for ${WORKER} with prompt "continue the mission", then report the result in one sentence. Do not try anything else.`, TURN_TIMEOUT_MS);
    const resumeRun = runsOf(rpc.toolRuns(resume.from, resume.to), 'TowerResume')[0];
    report.check(
      'TowerResume refuses an agent stopped by the human',
      resumeRun !== undefined && resumeRun.isError && resumeRun.output.includes(`tower agent "${WORKER}" was stopped by the human — no agent was started`),
      resumeRun === undefined ? 'TowerResume was not called' : clip(resumeRun.output, 400),
    );
    await rpc.command('/tower off');
    await recordUsage(ctx, session);
  },
};
