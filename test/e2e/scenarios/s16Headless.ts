import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { logEntries, towerState } from '../evidence.ts';
import {
  autopilotEntries,
  checkAutopilotPromptness,
  createTextkitRepo,
  describeObjective,
  hashTree,
  killProcesses,
  objectiveConfig,
  processesUnder,
  recordObjectiveUsage,
  writeText,
} from '../objective.ts';
import { clip, sleep } from '../rpc.ts';
import type { ScenarioDefinition } from '../scenario.ts';
import { git, isolatedPi } from '../workspace.ts';

const MAX_COST_USD = 4;
const MAX_WALL_TIME_MS = 25 * 60_000;
const RUN_TIMEOUT_MS = 30 * 60_000;

const OBJECTIVE = [
  '# textkit: reverse command',
  '',
  '## Goal',
  'Add a `reverse` command to the textkit CLI in this repository (read README.md first): it prints its arguments joined by single spaces, with the characters in reverse order. `node src/cli.js reverse abc def` prints `fed cba`.',
  '',
  '## Plan',
  'One milestone with one build feature that adds `src/commands/reverse.js` and `test/reverse.test.js` (node:test). No other changes, no dependencies.',
  '',
  '## Definition of done',
  '- `node src/cli.js reverse abc def` prints `fed cba`',
  '- `npm test` passes',
  '',
  '## Validation',
  'Scrutiny on, user testing off. `acceptance_commands` are exactly `npm test` and `node src/cli.js reverse abc def | grep -qx "fed cba"` — the repository has no dependencies, so they need no install step.',
  '',
].join('\n');

interface HeadlessExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export const s16Headless: ScenarioDefinition = {
  id: 'S16',
  title: 'headless pi-tower run --auto-approve',
  mandatory: true,
  timeoutMs: RUN_TIMEOUT_MS + 10 * 60_000,
  async run(ctx) {
    const { settings, report, dir } = ctx;
    const repo = createTextkitRepo(dir);
    const objectiveFile = writeText(join(dir, 'objective.md'), OBJECTIVE);
    const pi = isolatedPi(settings, dir, objectiveConfig(settings, { maxCostUsd: MAX_COST_USD, maxWallTimeMs: MAX_WALL_TIME_MS, skipUserTesting: true }), settings.session.spec);
    const agentDirBefore = hashTree(settings.agentDir);
    const bin = join(settings.checkout, 'bin', 'pi-tower.js');
    const args = [bin, 'run', '-f', objectiveFile, '--auto-approve', '--timeout', String(RUN_TIMEOUT_MS), '--cwd', repo, '--pi', settings.piBin, '--', ...pi.args];
    const logFile = join(dir, 'headless.log');
    appendFileSync(logFile, `$ node ${args.join(' ')}\n`);
    report.note(`pi-tower run ${args.slice(1).join(' ')}`);
    const started = Date.now();
    const child = ctx.root.trackChild(spawn(process.execPath, args, { cwd: dir, env: pi.env, stdio: ['ignore', 'pipe', 'pipe'] }));
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      appendFileSync(logFile, chunk);
      if (settings.verbose) process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      appendFileSync(logFile, chunk);
      if (settings.verbose) process.stderr.write(chunk);
    });
    const result = await new Promise<HeadlessExit>((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
      child.on('error', (error) => resolve({ code: null, signal: null, stdout, stderr: `${stderr}\n${error.message}` }));
    });
    report.note(`pi-tower run exited with ${String(result.code ?? result.signal)} after ${String(Math.round((Date.now() - started) / 1000))}s`);
    try {
      const state = towerState(repo);
      const objective = state?.objective;
      const lines = `${result.stdout}\n${result.stderr}`.split('\n').filter((line) => line.trim().length > 0);
      report.check(
        'pi-tower run --auto-approve exits 0 once the objective completed',
        result.code === 0 && lines.some((line) => /objective O\d+ ".*" completed$/.test(line)),
        [`exit ${String(result.code ?? result.signal)}`, ...lines.filter((line) => line.startsWith('[pi-tower')).slice(-14).map((line) => clip(line, 300))],
      );
      const sent = ['> /tower on', '> /tower objective --headless @', '> /tower approve --auto'].map((command) => lines.findIndex((line) => line.includes(command)));
      report.check(
        'the runner hands the objective over headless and approves it automatically after printing the plan',
        sent.every((index, position) => index >= 0 && (position === 0 || index > (sent[position - 1] ?? -1))) && lines.some((line) => line.startsWith('Plan for O')),
        sent.map((index) => (index < 0 ? '(command not sent)' : clip(lines[index] ?? '', 200))),
      );
      const entries = logEntries(repo);
      const approve = entries.find((entry) => entry.action === 'objective.approve');
      const drafted = entries.find((entry) => entry.action === 'objective.draft' && entry.fields.id === objective?.id);
      const released = entries.find((entry) => entry.action === 'objective.mode' && entry.fields.objective === objective?.id && entry.fields.mode === 'none');
      const final = objective?.milestones.at(-1);
      const mainTip = git(repo, ['rev-parse', 'main']);
      report.check(
        'the objective completed, approved automatically, in headless mode from draft to completion, its final milestone passed on the base tip',
        objective?.status === 'completed' &&
          objective.approvedBy === 'auto' &&
          approve?.fields.by === 'auto' &&
          drafted?.fields.mode === 'headless' &&
          released?.fields.from === 'headless' &&
          objective.milestones.every((milestone) => milestone.status === 'passed') &&
          final?.validationCommit === mainTip &&
          (final?.rounds.some((round) => round.verdict === 'pass') ?? false),
        [...describeObjective(state), drafted?.line ?? '(no objective.draft line)', released?.line ?? '(no objective.mode release line)'],
      );
      const merged = (state?.missions ?? []).filter((mission) => mission.milestone !== undefined);
      report.check(
        'the autopilot drove the feature through an independent review and merge',
        merged.length > 0 && merged.every((mission) => mission.status === 'merged') && autopilotEntries(repo, 'spawn-reviewer').length > 0 && autopilotEntries(repo, 'merge').some((entry) => entry.fields.result === 'done'),
        autopilotEntries(repo).map((entry) => entry.line),
      );
      const reversed = (() => {
        try {
          return git(repo, ['show', 'main:src/commands/reverse.js']).length > 0;
        } catch {
          return false;
        }
      })();
      report.check('main carries the reverse command', reversed, git(repo, ['log', '--oneline', '-6', 'main']));
      checkAutopilotPromptness(ctx, repo);
      const agentDirAfter = hashTree(settings.agentDir);
      report.check(`${settings.agentDir} is unchanged (sha256 over every file before/after)`, agentDirBefore === agentDirAfter, `before ${agentDirBefore.slice(0, 16)}… after ${agentDirAfter.slice(0, 16)}…`);
      await sleep(3000);
      const leftovers = processesUnder(dir);
      report.check(
        'no pi or agent process is left behind',
        leftovers.length === 0,
        leftovers.length === 0 ? `no process has its cwd or command line under ${dir}` : leftovers.map((info) => `pid ${String(info.pid)} cwd ${info.cwd}: ${clip(info.command, 200)}`),
      );
      killProcesses(leftovers);
    } finally {
      recordObjectiveUsage(ctx, repo, pi.sessions);
    }
  },
};
