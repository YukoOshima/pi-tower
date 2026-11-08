import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PiRpc } from './rpc.ts';
import type { E2eSettings } from './settings.ts';

export function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function tryGit(cwd: string, args: readonly string[]): string | undefined {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
}

export class RunRoot {
  readonly path: string;
  private readonly processes = new Set<PiRpc>();

  constructor() {
    this.path = mkdtempSync(join(tmpdir(), 'pi-tower-e2e-'));
  }

  scenarioDir(id: string): string {
    const dir = join(this.path, id);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  track(rpc: PiRpc): PiRpc {
    this.processes.add(rpc);
    return rpc;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.processes].map((rpc) => rpc.close(10_000)));
    this.processes.clear();
  }

  killAll(): void {
    for (const rpc of this.processes) rpc.kill();
  }

  cleanup(): void {
    rmSync(this.path, { recursive: true, force: true });
  }
}

export const TOY_FILES: Readonly<Record<string, string>> = {
  'README.md': '# toy\n\nA three-file repository used by the pi-tower live e2e run.\n',
  'notes.txt': 'alpha\n',
  'numbers.txt': '1\n2\n3\n',
};

export function createToyRepo(dir: string): string {
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'pi-tower e2e']);
  git(repo, ['config', 'user.email', 'e2e@pi-tower.invalid']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  for (const [name, content] of Object.entries(TOY_FILES)) writeFileSync(join(repo, name), content);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'initial toy repo']);
  return repo;
}

export function writeJson(path: string, value: unknown): string {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

export interface LaunchOptions {
  readonly label: string;
  readonly dir: string;
  readonly repo: string;
  readonly towerConfig: Record<string, unknown>;
  readonly sessionModel: string;
  readonly extraArgs?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export function launchPi(settings: E2eSettings, root: RunRoot, options: LaunchOptions): PiRpc {
  const configPath = writeJson(join(options.dir, 'tower.json'), options.towerConfig);
  const sessions = join(options.dir, 'sessions');
  mkdirSync(sessions, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, PI_TOWER_CONFIG: configPath, PI_OFFLINE: '1' };
  for (const key of ['PI_TOWER_ORCHESTRATOR_MODEL', 'PI_TOWER_WORKER_MODEL', 'PI_TOWER_REVIEWER_MODEL']) delete env[key];
  Object.assign(env, options.env ?? {});
  return root.track(
    new PiRpc({
      label: options.label,
      piBin: settings.piBin,
      cwd: options.repo,
      env,
      logFile: join(options.dir, 'pi.log'),
      echo: settings.verbose,
      args: [
        '--session-dir',
        sessions,
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '--no-context-files',
        '--offline',
        '--model',
        options.sessionModel,
        '-e',
        settings.extension,
        '-e',
        settings.probeExtension,
        ...(options.extraArgs ?? []),
      ],
    }),
  );
}

export function readJsonFile<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function listFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}
