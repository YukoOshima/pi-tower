import { activityLog, agentTranscriptPath, rosterEntry, summarizeTranscript } from '../evidence.ts';
import { clip, textOf } from '../rpc.ts';
import { recordUsage, roleConfig, runsOf, startSession, TURN_TIMEOUT_MS, type ScenarioDefinition } from '../scenario.ts';

const FIRST = 'agent-one';
const SECOND = 'agent-two';

const OBJECTIVE = [
  'Tower test (automated end-to-end test) — follow these steps exactly:',
  '1. Call TowerInit with no arguments.',
  '2. Call TowerPlan with two build missions in one call:',
  '   - title "Budget notes mission", scope ["notes.txt"], tasks ["First run this bash command in your worktree and wait for it: sleep 25", "Then add one new last line to notes.txt whose entire content is the single word eta, and commit it on the mission branch"];',
  '   - title "Budget numbers mission", scope ["numbers.txt"], tasks ["Add one new last line to numbers.txt whose entire content is the number 5, and commit it on the mission branch"].',
  `3. Spawn "${FIRST}" (kind "worker", mission_id "M1"), then immediately spawn "${SECOND}" (kind "worker", mission_id "M2") in the next tool call.`,
  `4. If the second spawn is refused, report the refusal text in one sentence and end your turn; when ${FIRST} finishes, spawn "${SECOND}" for M2 again.`,
  'Do not review, merge, or resume anything in this test.',
].join('\n');

export const s13Budget: ScenarioDefinition = {
  id: 'S13',
  title: 'maxRunningAgents=1 concurrency budget',
  mandatory: false,
  async run(ctx) {
    const { settings, report } = ctx;
    const session = await startSession(ctx, { towerConfig: roleConfig(settings, { maxRunningAgents: 1 }) });
    const { rpc } = session;
    await rpc.command('/tower on');
    const span = await rpc.prompt(OBJECTIVE, TURN_TIMEOUT_MS);
    const spawns = runsOf(rpc.toolRuns(span.from, span.to), 'TowerSpawn');
    const first = spawns.find((run) => run.args.name === FIRST && !run.isError);
    const refused = spawns.find((run) => run.args.name === SECOND && run.isError);
    report.check(`${FIRST} spawns within the budget`, first !== undefined, clip(first?.output.split('\n').slice(0, 6).join(' | ') ?? 'not spawned', 300));
    report.check(
      'a second spawn is refused with "concurrency budget exhausted (1/1 …)"',
      refused !== undefined && refused.output.includes('tower concurrency budget exhausted (1/1 agents running)'),
      refused === undefined ? `no refused spawn of ${SECOND}: ${spawns.map((run) => `${String(run.args.name)} isError=${String(run.isError)}`).join(', ')}` : clip(refused.output, 300),
    );
    const status = await rpc.command('/tower status');
    const concurrency = status.text.split('\n').find((line) => line.startsWith('Concurrency:'));
    report.check('/tower status shows budget 1 and inflight 1 while the first worker runs', concurrency?.includes('budget: 1 agent(s) · inflight: 1') === true, concurrency ?? status.text);

    const retried = await rpc.waitFor(
      (event) => event.type === 'tool_execution_end' && event.toolName === 'TowerSpawn' && event.isError !== true && textOf(event.result?.content).includes(`name: ${SECOND}`),
      6 * 60_000,
      `the retried spawn of ${SECOND}`,
      span.to,
    );
    const one = rosterEntry(session.repo, FIRST);
    const two = rosterEntry(session.repo, SECOND);
    const onePath = one === undefined ? undefined : agentTranscriptPath(session.repo, one.agentId);
    const oneEnd = onePath === undefined ? Number.NaN : summarizeTranscript(onePath).lastAt;
    const twoSpawn = Date.parse(two?.spawnedAt ?? '');
    const log = activityLog(session.repo).filter((line) => line.includes(`${FIRST} mission.update`) || line.includes(`spawn name=${SECOND}`));
    report.check(
      `${SECOND} spawns once ${FIRST} has finished`,
      oneEnd < twoSpawn,
      [
        `${FIRST} transcript ends ${Number.isFinite(oneEnd) ? new Date(oneEnd).toISOString() : '?'}; ${SECOND} spawned ${two?.spawnedAt ?? '?'}`,
        `retried TowerSpawn: ${clip(textOf(retried.result?.content).split('\n').slice(0, 5).join(' | '), 200)}`,
        ...log,
      ],
    );
    await rpc.waitIdle(TURN_TIMEOUT_MS, 3000);
    await rpc.waitFor(
      (event) => event.type === 'message_end' && event.message?.customType === 'tower-agent-notification' && textOf(event.message?.content).includes(`name="${SECOND}"`),
      6 * 60_000,
      `the finished notification of ${SECOND}`,
      span.to,
    );
    await rpc.waitIdle(TURN_TIMEOUT_MS, 3000);
    await rpc.command('/tower off');
    await recordUsage(ctx, session);
  },
};
