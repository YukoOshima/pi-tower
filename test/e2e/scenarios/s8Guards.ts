import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { agentTranscriptPath, resultOf, rosterEntry, summarizeTranscript, towerState, type TranscriptSummary } from '../evidence.ts';
import { clip, textOf, type PiRpc, type PiToolRun } from '../rpc.ts';
import { recordUsage, roleConfig, startSession, TURN_TIMEOUT_MS, type ScenarioDefinition } from '../scenario.ts';
import { git } from '../workspace.ts';

const WORKER = 'agent-guard';
const WRITE_VETO_SUFFIX = 'Out-of-scope changes are not yours to make: file them with TowerFinding or ask the tower via TowerSend.';
const RM_VETO = '`rm` is not allowed on tower protocol paths';
const RESET_VETO = '`git reset --hard` is not allowed in the tower main checkout';

function objective(repo: string): string {
  const tasks = [
    `Use the write tool to create the file ${join(repo, 'outside-guard.txt')} (exactly this absolute path, which is outside your worktree) with the content x. The tower guard is expected to deny it: do not retry it any other way, and quote the exact denial text in your completion report`,
    'Run this bash command in your worktree: mkdir scratch-dir && rm -rf scratch-dir',
    'Run this bash command in your worktree: git reset --hard HEAD',
    'Add one new last line to notes.txt whose entire content is the single word epsilon, and commit it on the mission branch',
  ];
  return [
    'Guard test for the tower (an automated end-to-end test). Follow these steps exactly and never work around a blocked call:',
    '1. Call TowerInit with no arguments.',
    `2. Call TowerPlan with one build mission: title "Guard probe mission", scope ["notes.txt"], tasks ${JSON.stringify(tasks)}.`,
    `3. Spawn the worker for it with TowerSpawn: name "${WORKER}", kind "worker", mission_id "M1".`,
    '4. Then run each of these two bash commands yourself in the main checkout, one bash call per command, exactly as written: `rm -rf .tower/comms` and then `git reset --hard HEAD`. The tower guard is expected to block both — that is what this test checks; do not retry them in another form.',
    `5. End your turn. When ${WORKER} reports completion, only acknowledge it in one short sentence: do not review, merge, or call any tool.`,
  ].join('\n');
}

function bashRun(runs: readonly PiToolRun[], fragment: string): PiToolRun | undefined {
  return runs.find((run) => run.toolName === 'bash' && String(run.args.command ?? '').includes(fragment));
}

function workerBash(summary: TranscriptSummary | undefined, fragment: string): { readonly command: string; readonly isError: boolean; readonly text: string } | undefined {
  if (summary === undefined) return undefined;
  const call = summary.toolCalls.find((candidate) => candidate.name === 'bash' && String(candidate.arguments.command ?? '').includes(fragment));
  if (call === undefined) return undefined;
  const result = resultOf(summary, call);
  return { command: String(call.arguments.command), isError: result?.isError ?? true, text: result?.text ?? '(no result)' };
}

async function todoProbe(rpc: PiRpc, label: string): Promise<PiToolRun | undefined> {
  const span = await rpc.prompt(`Call the todo_write tool exactly once with items ["${label}"], then reply with the single word OK. Call no other tool.`, TURN_TIMEOUT_MS);
  return rpc.toolRuns(span.from, span.to).find((run) => run.toolName === 'todo_write');
}

export const s8Guards: ScenarioDefinition = {
  id: 'S8',
  title: 'guards and vetoes',
  mandatory: true,
  async run(ctx) {
    const { settings, report } = ctx;
    const session = await startSession(ctx, { towerConfig: roleConfig(settings, { maxRunningAgents: 2 }), env: { PI_TOWER_E2E_PROBE_TODO: '1' } });
    const { rpc, repo } = session;
    const headBefore = git(repo, ['rev-parse', 'HEAD']);
    await rpc.command('/tower on');

    const span = await rpc.prompt(objective(repo), TURN_TIMEOUT_MS);
    await rpc.waitFor(
      (event) => event.type === 'message_end' && event.message?.customType === 'tower-agent-notification' && textOf(event.message?.content).includes(`name="${WORKER}"`),
      8 * 60_000,
      `the finished notification of ${WORKER}`,
      span.from,
    );
    await rpc.waitIdle(TURN_TIMEOUT_MS, 3000);
    const runs = rpc.toolRuns(span.from);

    const rm = bashRun(runs, 'rm -rf .tower/comms');
    report.check(
      'the orchestrator\'s `rm -rf .tower/comms` is vetoed and .tower/comms survives',
      rm !== undefined && rm.isError && rm.output.includes(RM_VETO) && existsSync(join(repo, '.tower', 'comms', 'state.json')),
      rm === undefined ? 'the orchestrator did not run it' : [`bash ${JSON.stringify(rm.args.command)} → isError=${String(rm.isError)}`, clip(rm.output, 420), `.tower/comms/state.json exists: ${String(existsSync(join(repo, '.tower', 'comms', 'state.json')))}`],
    );
    const reset = runs.find((run) => run.toolName === 'bash' && /^\s*git reset --hard/.test(String(run.args.command ?? '')));
    report.check(
      'the orchestrator\'s `git reset --hard` in the main checkout is vetoed',
      reset !== undefined && reset.isError && reset.output.includes(RESET_VETO) && git(repo, ['rev-parse', 'HEAD']) === headBefore,
      reset === undefined ? 'the orchestrator did not run it' : [`bash ${JSON.stringify(reset.args.command)} → isError=${String(reset.isError)}`, clip(reset.output, 420)],
    );

    const entry = rosterEntry(repo, WORKER);
    const worktree = join(repo, '.tower', 'worktrees', entry?.worktree ?? 'wt-1');
    const transcript = entry === undefined ? undefined : agentTranscriptPath(repo, entry.agentId);
    const summary = transcript === undefined ? undefined : summarizeTranscript(transcript);
    const outside = join(repo, 'outside-guard.txt');
    const writeCall = summary?.toolCalls.find((call) => (call.name === 'write' || call.name === 'edit') && String(call.arguments.path ?? '').includes('outside-guard.txt'));
    const writeResult = summary === undefined || writeCall === undefined ? undefined : resultOf(summary, writeCall);
    const expectedPrefix = `tower workers may only write inside their own worktree (${worktree}) — denied: `;
    report.check(
      'a worker writing outside its worktree is denied with the exact message',
      writeResult !== undefined && writeResult.isError && writeResult.text.includes(expectedPrefix) && writeResult.text.includes(outside) && writeResult.text.includes(WRITE_VETO_SUFFIX) && !existsSync(outside),
      writeCall === undefined ? 'the worker made no write call to outside-guard.txt' : [`${writeCall.name} ${JSON.stringify(writeCall.arguments.path)} → isError=${String(writeResult?.isError)}`, clip(writeResult?.text ?? '', 500), `${outside} exists: ${String(existsSync(outside))}`],
    );
    for (const [fragment, label] of [['rm -rf scratch-dir', '`rm -rf` inside the worker\'s worktree is allowed'], ['git reset --hard', '`git reset --hard` inside the worker\'s worktree is allowed']] as const) {
      const run = workerBash(summary, fragment);
      report.check(label, run !== undefined && !run.isError, run === undefined ? `the worker did not run "${fragment}"` : `worker bash ${JSON.stringify(run.command)} → isError=${String(run.isError)}: ${clip(run.text, 200)}`);
    }

    const mission = towerState(repo)?.missions.find((candidate) => candidate.id === 'M1');
    const inWorktree = await rpc.prompt(`Now run exactly this one bash command yourself: git -C .tower/worktrees/${mission?.worktree ?? 'wt-1'} reset --hard HEAD — it targets the finished worker's worktree, not the main checkout. Then reply with the single word DONE.`, TURN_TIMEOUT_MS);
    const allowed = rpc.toolRuns(inWorktree.from, inWorktree.to).find((run) => run.toolName === 'bash' && String(run.args.command ?? '').includes('reset --hard'));
    report.check(
      'the orchestrator\'s `git reset --hard` aimed at a worktree is allowed',
      allowed !== undefined && !allowed.isError,
      allowed === undefined ? 'not run' : `bash ${JSON.stringify(allowed.args.command)} → isError=${String(allowed.isError)}: ${clip(allowed.output, 200)}`,
    );

    const vetoed = await todoProbe(rpc, 'while-on');
    report.check(
      'an installed extension\'s todo tool is vetoed while tower mode is on',
      vetoed !== undefined && vetoed.isError && vetoed.output.includes('todo_write'),
      vetoed === undefined ? 'todo_write was not called' : `todo_write → isError=${String(vetoed.isError)}: ${clip(vetoed.output, 300)}`,
    );
    await rpc.command('/tower off');
    const permitted = await todoProbe(rpc, 'after-off');
    report.check(
      'the same todo tool is allowed after /tower off',
      permitted !== undefined && !permitted.isError && permitted.output.includes('todo_write ok'),
      permitted === undefined ? 'todo_write was not called' : `todo_write → isError=${String(permitted.isError)}: ${clip(permitted.output, 200)}`,
    );
    await recordUsage(ctx, session);
  },
};
