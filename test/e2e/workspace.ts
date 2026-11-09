import { execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { PiRpc, sleep } from './rpc.ts';
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

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function stopChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (exited(child)) return;
  const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  await Promise.race([gone, sleep(graceMs)]);
  if (!exited(child)) child.kill('SIGKILL');
}

export class RunRoot {
  readonly path: string;
  private readonly processes = new Set<PiRpc>();
  private readonly children = new Set<ChildProcess>();

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

  trackChild(child: ChildProcess): ChildProcess {
    this.children.add(child);
    return child;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...[...this.processes].map((rpc) => rpc.close(10_000)), ...[...this.children].map((child) => stopChild(child, 15_000))]);
    this.processes.clear();
    this.children.clear();
  }

  killAll(): void {
    for (const rpc of this.processes) rpc.kill();
    for (const child of this.children) if (!exited(child)) child.kill('SIGKILL');
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

export function createRepo(dir: string, files: Readonly<Record<string, string>>): string {
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'pi-tower e2e']);
  git(repo, ['config', 'user.email', 'e2e@pi-tower.invalid']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    writeFileSync(join(repo, name), content);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'initial toy repo']);
  return repo;
}

export function createToyRepo(dir: string): string {
  return createRepo(dir, TOY_FILES);
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

export interface IsolatedPi {
  readonly env: NodeJS.ProcessEnv;
  readonly args: readonly string[];
  readonly sessions: string;
}

export function isolatedPi(settings: E2eSettings, dir: string, towerConfig: Record<string, unknown>, sessionModel: string, extraEnv: Readonly<Record<string, string>> = {}): IsolatedPi {
  const configPath = writeJson(join(dir, 'tower.json'), towerConfig);
  const sessions = join(dir, 'sessions');
  mkdirSync(sessions, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, PI_TOWER_CONFIG: configPath, PI_OFFLINE: '1' };
  for (const key of ['PI_TOWER_ORCHESTRATOR_MODEL', 'PI_TOWER_WORKER_MODEL', 'PI_TOWER_REVIEWER_MODEL', 'PI_TOWER_VALIDATOR_MODEL']) delete env[key];
  Object.assign(env, extraEnv);
  const args = ['--session-dir', sessions, '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--offline', '--model', sessionModel, '-e', settings.extension];
  return { env, args, sessions };
}

export function launchPi(settings: E2eSettings, root: RunRoot, options: LaunchOptions): PiRpc {
  const pi = isolatedPi(settings, options.dir, options.towerConfig, options.sessionModel, options.env);
  return root.track(
    new PiRpc({
      label: options.label,
      piBin: settings.piBin,
      cwd: options.repo,
      env: pi.env,
      logFile: join(options.dir, 'pi.log'),
      echo: settings.verbose,
      args: [...pi.args, '-e', settings.probeExtension, ...(options.extraArgs ?? [])],
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
