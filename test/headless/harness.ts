import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FakeScenario } from './fakePi.ts';

export type Json = Record<string, unknown>;

const here = dirname(fileURLToPath(import.meta.url));

export const FAKE_PI_SCRIPT = join(here, 'fakePi.ts');
export const CHECKOUT = join(here, '..', '..');

export interface FakeWorld {
  readonly dir: string;
  readonly repo: string;
  readonly piBin: string;
  readonly logFile: string;
  readonly objectiveFile: string;
  readonly statePath: string;
  scenario(scenario: FakeScenario): string[];
  log(): Json[];
  commands(): string[];
  state(): Json | undefined;
  writeState(state: Json): void;
  cleanup(): void;
}

export function createWorld(): FakeWorld {
  const dir = mkdtempSync(join(tmpdir(), 'pi-tower-headless-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  const piBin = join(dir, 'fake-pi');
  writeFileSync(piBin, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_PI_SCRIPT}' "$@"\n`);
  chmodSync(piBin, 0o755);
  const logFile = join(dir, 'pi.log');
  const objectiveFile = join(dir, 'objective.md');
  writeFileSync(objectiveFile, '# Ship the widget\n\nBuild the widget end to end.\n');
  const statePath = join(repo, '.tower', 'comms', 'state.json');
  const log = (): Json[] =>
    existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as Json)
      : [];
  return {
    dir,
    repo,
    piBin,
    logFile,
    objectiveFile,
    statePath,
    scenario(scenario) {
      const path = join(dir, 'scenario.json');
      writeFileSync(path, JSON.stringify(scenario));
      return ['--scenario', path, '--log', logFile];
    },
    log,
    commands() {
      return log()
        .filter((entry) => entry.kind === 'command' && (entry.record as Json).type === 'prompt')
        .map((entry) => String((entry.record as Json).message));
    },
    state() {
      return existsSync(statePath) ? (JSON.parse(readFileSync(statePath, 'utf8')) as Json) : undefined;
    },
    writeState(state) {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function milestone(id: string, status: string, order: number, extra: Json = {}): Json {
  return {
    id,
    title: `${id} title`,
    order,
    status,
    rounds: [],
    validation: { scrutiny: true, userTesting: true, commands: [] },
    ...extra,
  };
}

export function objective(status: string, extra: Json = {}): Json {
  return {
    id: 'O1',
    title: 'Ship the widget',
    goal: 'Build the widget end to end',
    definitionOfDone: ['the widget renders', 'npm test passes'],
    acceptanceCommands: ['npm test'],
    status,
    createdAt: '2026-11-09T00:00:00.000Z',
    limits: { maxValidationRounds: 3, maxFeatureAttempts: 3 },
    notes: ['assumed: Node 22 or newer'],
    milestones: [milestone('MS1', 'pending', 1), milestone('MS2', 'pending', 2)],
    ...extra,
  };
}

export function feature(id: string, milestoneId: string, status = 'planned'): Json {
  return { id, title: `${id} feature`, status, milestone: milestoneId, origin: 'plan', tasks: [], deps: [] };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitDead(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

export function processGroup(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
  } catch {
    return undefined;
  }
}
