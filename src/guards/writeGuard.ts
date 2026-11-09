import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export function resolveToolPath(path: string, cwd: string, home: string = homedir()): string {
  const normalized = expandPath(path.replace(UNICODE_SPACES, ' ').replace(/^@/, ''), home);
  return isAbsolute(normalized) ? resolve(normalized) : resolve(expandPath(cwd, home), normalized);
}

export function isWithinDirectory(path: string, directory: string): boolean {
  const rel = relative(resolve(directory), resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function findWriteEscapes(
  paths: readonly string[],
  worktreeAbs: string,
  cwd: string,
  home: string = homedir(),
): string[] {
  const escapes: string[] = [];
  for (const path of paths) {
    const resolved = tryResolveToolPath(path, cwd, home);
    if (resolved === undefined) escapes.push(path);
    else if (!isWithinDirectory(resolved, worktreeAbs)) escapes.push(resolved);
  }
  return escapes;
}

export function writeGuardVeto(worktree: string, escapes: readonly string[]): string {
  return (
    `tower workers may only write inside their own worktree (${worktree}) — denied: ` +
    `${escapes.join(', ')}. ` +
    'Out-of-scope changes are not yours to make: file them with TowerFinding or ask the tower via TowerSend.'
  );
}

export const VALIDATOR_WRITE_VETO =
  'tower validators are read-only: they judge the milestone on its exact commit and never edit files. ' +
  'Record every problem as a failure in your TowerValidate verdict, or file it with TowerFinding.';

function expandPath(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  if (path.startsWith('file://')) return fileURLToPath(path);
  return path;
}

function tryResolveToolPath(path: string, cwd: string, home: string): string | undefined {
  try {
    return resolveToolPath(path, cwd, home);
  } catch {
    return undefined;
  }
}
