import { join } from 'node:path';

import { agentTranscriptPath, logEntries, summarizeTranscript, towerState, type MissionRecord, type RosterEntry } from '../evidence.ts';
import {
  autopilotEntries,
  createTextkitRepo,
  describeObjective,
  humanScript,
  objectiveConfig,
  ObjectiveTrace,
  planToApproval,
  recordObjectiveUsage,
  toolCallCount,
  transcriptOf,
  waitForObjective,
  writeText,
} from '../objective.ts';
import { clip, sleep, type PiRpc } from '../rpc.ts';
import { runningAgents, startSession, type ScenarioDefinition } from '../scenario.ts';
import { git } from '../workspace.ts';

const MAX_COST_USD = 5;
const MAX_WALL_TIME_MS = 30 * 60_000;

const OBJECTIVE = [
  '# textkit: title command',
  '',
  '## Goal',
  'Add a `title` command to the textkit CLI in this repository (read README.md first): it prints its arguments joined by single spaces in Title Case — the first letter of every word upper-cased, the rest lower-cased. `node src/cli.js title hello BIG world` prints `Hello Big World`.',
  '',
  '## Plan',
  'One milestone with one build feature that adds `src/commands/title.js` and `test/title.test.js` (node:test). No other changes, no dependencies.',
  '',
  '## Definition of done',
  '- `node src/cli.js title hello BIG world` prints `Hello Big World`',
  '- `npm test` passes',
  '',
  '## Validation',
  'Scrutiny on, user testing off. `acceptance_commands` are exactly `npm test` and `node src/cli.js title hello BIG world | grep -qx "Hello Big World"` — the repository has no dependencies, so they need no install step.',
  '',
].join('\n');

const HUMAN_REPLY = 'No more questions from me — everything I want is in the objective. Decide any open point yourself, plan it and request approval now.';

interface Victim {
  readonly mission: MissionRecord;
  readonly worker: RosterEntry;
  readonly toolCalls: number;
  readonly agentsLine: string;
}

function liveWorker(repo: string): { mission: MissionRecord; worker: RosterEntry } | undefined {
  const state = towerState(repo);
  for (const mission of state?.missions ?? []) {
    if (mission.milestone === undefined || mission.status !== 'active') continue;
    const worker = state?.roster.agents.find((agent) => agent.kind === 'worker' && agent.missionId === mission.id && agent.diedAt === undefined);
    if (worker !== undefined && toolCallCount(transcriptOf(repo, worker.agentId)) > 0) return { mission, worker };
  }
  return undefined;
}

async function runningFeatureWorker(rpc: PiRpc, repo: string): Promise<Victim> {
  const deadline = Date.now() + 8 * 60_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`no feature worker started working within 8 minutes:\n${describeObjective(towerState(repo)).join('\n')}`);
    const live = liveWorker(repo);
    if (live !== undefined) {
      const agents = await rpc.command('/tower agents');
      const line = agents.text.split('\n').find((candidate) => candidate.startsWith(`- ${live.worker.name} `)) ?? '';
      const current = towerState(repo)?.missions.find((mission) => mission.id === live.mission.id);
      if (runningAgents(agents.text).includes(live.worker.name) && current?.status === 'active') {
        return { ...live, toolCalls: toolCallCount(transcriptOf(repo, live.worker.agentId)), agentsLine: line };
      }
    }
    await sleep(1000);
  }
}

export const s17Restart: ScenarioDefinition = {
  id: 'S17',
  title: 'restart continuation after pi is killed mid-feature',
  mandatory: false,
  timeoutMs: 45 * 60_000,
  async run(ctx) {
    const { settings, report, dir } = ctx;
    const repo = createTextkitRepo(dir);
    const objectiveFile = writeText(join(dir, 'objective.md'), OBJECTIVE);
    const towerConfig = objectiveConfig(settings, { maxCostUsd: MAX_COST_USD, maxWallTimeMs: MAX_WALL_TIME_MS, skipUserTesting: true });
    const first = await startSession(ctx, { repo, towerConfig, label: 'S17#1' });
    const trace = new ObjectiveTrace(repo);
    let retired: RosterEntry[] = [];
    try {
      await first.rpc.command('/tower on');
      const handed = await first.rpc.command(`/tower objective --headless @${objectiveFile}`);
      report.check('/tower objective --headless hands the objective to the orchestrator', /Objective handed to the tower/.test(handed.text), handed.text);
      await planToApproval(ctx, first.rpc, repo, humanScript(HUMAN_REPLY));
      const approve = await first.rpc.command('/tower approve');
      report.check('the scripted human approves the plan', /approved/.test(approve.text), approve.text);

      const victim = await runningFeatureWorker(first.rpc, repo);
      retired = [...(towerState(repo)?.roster.agents ?? [])];
      const pid = first.rpc.pid;
      first.rpc.kill();
      await first.rpc.waitUntil(() => first.rpc.exitCode !== undefined, 15_000, 'pi to die').catch(() => undefined);
      const alive = (() => {
        try {
          if (pid !== undefined) process.kill(pid, 0);
          return pid !== undefined;
        } catch {
          return false;
        }
      })();
      const killed = towerState(repo);
      const killedMission = killed?.missions.find((mission) => mission.id === victim.mission.id);
      report.check(
        `pi is SIGKILLed while ${victim.worker.name} runs ${victim.mission.id}`,
        !alive && first.rpc.exitCode !== undefined && killedMission?.status === 'active',
        [`pid ${String(pid)} gone=${String(!alive)}`, `runtime: ${victim.agentsLine}`, `${victim.worker.name} had made ${String(victim.toolCalls)} tool call(s); ${victim.mission.id} ${String(killedMission?.status)} on ${victim.mission.branch} (worktree ${victim.mission.worktree}, attempts ${String(killedMission?.attempts)})`],
      );

      const second = await startSession(ctx, { repo, towerConfig, label: 'S17#2' });
      const mark = logEntries(repo).length;
      const on = await second.rpc.command('/tower on');
      report.check('pi starts again in the same workspace and /tower on resumes the executing objective', /Tower mode: ON/.test(on.text) && towerState(repo)?.objective?.status === 'executing', on.text);
      await second.rpc.waitUntil(
        () => autopilotEntries(repo, 'respawn-worker').some((entry) => entry.index >= mark && entry.fields.mission === victim.mission.id && entry.fields.result === 'started'),
        5 * 60_000,
        `the autopilot to respawn a worker for ${victim.mission.id}`,
      );
      const final = await waitForObjective(ctx, repo, (state) => state.objective?.status === 'completed', { label: 'the objective to complete after the restart', timeoutMs: MAX_WALL_TIME_MS, rpc: second.rpc });
      trace.stop();

      const entries = logEntries(repo);
      const adopt = entries.find((entry) => entry.index >= mark && entry.action === 'adopt');
      report.check(
        `the restarted tower adopts the workspace and retires ${victim.worker.name}`,
        adopt !== undefined && (adopt.fields.retired ?? '').split(',').includes(victim.worker.name),
        adopt?.line ?? '(no tower adopt line after the restart)',
      );
      const respawn = entries.find((entry) => entry.index >= mark && entry.actor === 'autopilot' && entry.action === 'respawn-worker' && entry.fields.mission === victim.mission.id && entry.fields.result === 'started');
      const fresh = final.roster.agents.find((agent) => agent.name === respawn?.fields.name);
      const mission = final.missions.find((candidate) => candidate.id === victim.mission.id);
      const freshPath = fresh === undefined ? undefined : agentTranscriptPath(repo, fresh.agentId);
      const freshCwd = freshPath === undefined ? undefined : summarizeTranscript(freshPath).cwd;
      report.check(
        'the autopilot respawns the retired feature on the same branch under a new attempt name',
        respawn !== undefined &&
          fresh !== undefined &&
          fresh.kind === 'worker' &&
          fresh.name !== victim.worker.name &&
          fresh.missionId === victim.mission.id &&
          fresh.worktree === victim.worker.worktree &&
          fresh.branch === victim.worker.branch &&
          mission?.branch === victim.mission.branch &&
          (mission?.attempts ?? 0) >= 2 &&
          freshCwd === join(repo, '.tower', 'worktrees', victim.mission.worktree),
        [
          respawn?.line ?? '(no autopilot respawn-worker line)',
          `before: ${victim.worker.name} worktree=${String(victim.worker.worktree)} branch=${String(victim.worker.branch)}`,
          `after: ${String(fresh?.name)} worktree=${String(fresh?.worktree)} branch=${String(fresh?.branch)} cwd=${String(freshCwd)}; ${victim.mission.id} attempts=${String(mission?.attempts)} owner=${String(mission?.owner)} status=${String(mission?.status)}`,
        ],
      );
      const objective = final.objective;
      const mainTip = git(repo, ['rev-parse', 'main']);
      report.check(
        'the objective still completes: every feature merged, the final milestone passed on the base tip',
        objective?.status === 'completed' &&
          final.missions.filter((candidate) => candidate.milestone !== undefined).every((candidate) => candidate.status === 'merged') &&
          objective.milestones.every((milestone) => milestone.status === 'passed') &&
          objective.milestones.at(-1)?.validationCommit === mainTip,
        describeObjective(final),
      );
      const title = (() => {
        try {
          return git(repo, ['show', 'main:src/commands/title.js']);
        } catch {
          return '';
        }
      })();
      report.check('main carries the title command', title.length > 0, clip(title, 200));
      await second.rpc.command('/tower off');
    } finally {
      trace.stop();
      report.note(`status trace:\n${trace.lines().join('\n')}`);
      report.note(`final state:\n${describeObjective(towerState(repo)).join('\n')}`);
      report.note(`autopilot activity:\n${autopilotEntries(repo).map((entry) => entry.line).join('\n')}`);
      recordObjectiveUsage(ctx, repo, join(dir, 'sessions'), retired);
    }
  },
};
