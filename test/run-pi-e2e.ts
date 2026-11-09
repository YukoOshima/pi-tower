import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderReport, ScenarioReport } from './e2e/report.ts';
import { sleep } from './e2e/rpc.ts';
import { globalTimeoutMs, scenarioTimeoutMs } from './e2e/scenario.ts';
import { SCENARIOS } from './e2e/scenarios/index.ts';
import { discriminationNotes, loadSettings } from './e2e/settings.ts';
import { selfCheckWakeParser } from './e2e/wakes.ts';
import { RunRoot, tryGit } from './e2e/workspace.ts';

const settings = loadSettings(process.argv.slice(2));
const selfCheck = await selfCheckWakeParser(settings.checkout);
console.log(`wake parser self-check: ${selfCheck.ok ? 'ok' : 'FAILED'}\n${selfCheck.lines.map((line) => `  - ${line}`).join('\n')}`);
if (process.argv.includes('--selfcheck')) console.log(`role-model discrimination:\n${discriminationNotes(settings).map((note) => `  - ${note}`).join('\n')}`);
if (!selfCheck.ok || process.argv.includes('--selfcheck')) process.exit(selfCheck.ok ? 0 : 1);
const startedAt = Date.now();
const root = new RunRoot();
const reports: ScenarioReport[] = [];
const selected = SCENARIOS.filter((scenario) => settings.scenarios.includes(scenario.id));
const runTimeoutMs = globalTimeoutMs(settings, selected);
const watched = [join(settings.agentDir, 'settings.json'), join(settings.agentDir, 'tower.json')];

function fingerprint(path: string): string {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'absent';
}

const before = watched.map(fingerprint);
const checkoutRev = tryGit(settings.checkout, ['rev-parse', '--short', 'HEAD']) ?? 'not a git checkout';
const checkoutDirty = (tryGit(settings.checkout, ['status', '--porcelain', '--', 'src']) ?? '').length > 0;

const header = [
  `- pi: ${settings.piVersion} (${settings.piBin})`,
  `- extension: ${settings.extension} @ ${checkoutRev}${checkoutDirty ? ' (uncommitted src changes)' : ''}`,
  `- orchestrator model (A): ${settings.orchestrator.spec}`,
  `- worker model (B): ${settings.worker.spec}`,
  `- reviewer model (C): ${settings.reviewer.spec}`,
  `- validator model (objective scenarios): ${settings.validator.spec}`,
  `- starting session model: ${settings.session.spec}`,
  `- scenarios: ${selected.map((scenario) => `${scenario.id} (timeout ${String(Math.round(scenarioTimeoutMs(settings, scenario) / 60_000))} min)`).join(', ')}`,
  `- run timeout: ${String(Math.round(runTimeoutMs / 60_000))} min`,
  `- run root: ${root.path}${settings.keep ? ' (kept)' : ' (removed at exit)'}`,
  `- offline wake parser self-check: ok (${selfCheck.lines.join('; ')})`,
  '- role-model discrimination:',
  ...discriminationNotes(settings).map((note) => `  - ${note}`),
];
console.log(['pi-tower live e2e', ...header].join('\n'));

let finishing = false;

async function finish(code: number, reason?: string): Promise<never> {
  if (finishing) process.exit(code);
  finishing = true;
  if (reason !== undefined) console.log(reason);
  root.killAll();
  await sleep(500);
  const after = watched.map(fingerprint);
  const mutated = watched.filter((_, index) => before[index] !== after[index]);
  const footer = [
    `- total wall time: ${((Date.now() - startedAt) / 1000).toFixed(0)}s`,
    `- global pi settings untouched: ${mutated.length === 0 ? 'yes' : `NO — changed: ${mutated.join(', ')}`}`,
  ];
  const text = renderReport(reports, [...header, ...footer]);
  console.log(`\n${text}`);
  if (settings.reportPath !== undefined) writeFileSync(settings.reportPath, text);
  if (!settings.keep) root.cleanup();
  const failed = reports.filter((report) => report.verdict === 'fail');
  process.exit(code !== 0 ? code : failed.length > 0 || mutated.length > 0 ? 1 : 0);
}

const globalTimer = setTimeout(() => {
  void finish(2, `GLOBAL TIMEOUT after ${String(runTimeoutMs)}ms — killing pi processes`);
}, runTimeoutMs);
globalTimer.unref();
process.on('uncaughtException', (error) => {
  void finish(1, `uncaught exception: ${error.stack ?? error.message}`);
});
process.on('unhandledRejection', (reason) => {
  void finish(1, `unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void finish(130, `received ${signal} — killing pi processes`);
  });
}

for (const definition of selected) {
  const report = new ScenarioReport(definition.id, definition.title, definition.mandatory);
  reports.push(report);
  console.log(`\n== ${definition.id} ${definition.title}`);
  const begin = Date.now();
  const dir = root.scenarioDir(definition.id);
  const timeoutMs = scenarioTimeoutMs(settings, definition);
  let timer: NodeJS.Timeout | undefined;
  const running = definition.run({ settings, root, report, dir });
  running.catch(() => undefined);
  try {
    await Promise.race([
      running,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`scenario timeout after ${String(timeoutMs)}ms`));
        }, timeoutMs);
      }),
    ]);
    if (report.checks.length === 0 && report.verdict === 'pass') report.fail('the scenario made no assertions');
  } catch (error) {
    report.fail(error);
  } finally {
    clearTimeout(timer);
    await root.closeAll();
    report.durationMs = Date.now() - begin;
    console.log(`== ${definition.id}: ${report.verdict.toUpperCase()} in ${(report.durationMs / 1000).toFixed(0)}s (logs: ${dir})`);
  }
}

await finish(0);
