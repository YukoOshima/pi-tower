import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { WORKTREES_DIR } from './paths.ts';

export function resolveTowerRepoRoot(cwd: string): string {
  const normalized = cwd.replaceAll('\\', '/');
  if (normalized.endsWith(`/${WORKTREES_DIR}`)) {
    return cwd.slice(0, normalized.length - WORKTREES_DIR.length - 1);
  }
  if (!normalized.includes(`/${WORKTREES_DIR}/`)) return cwd;
  return towerWorktreeRoot(cwd) ?? cwd;
}

function towerWorktreeRoot(cwd: string): string | undefined {
  if (!isAbsolute(cwd)) return undefined;
  const worktree = nearestGitLinkDir(cwd);
  if (worktree === undefined) return undefined;
  const parent = dirname(worktree).replaceAll('\\', '/');
  if (!parent.endsWith(`/${WORKTREES_DIR}`)) return undefined;
  const root = worktree.slice(0, parent.length - WORKTREES_DIR.length - 1);
  if (!isAbsolute(root)) return undefined;
  const gitDir = gitLinkTarget(worktree);
  const commonDir = commonGitDir(root);
  if (gitDir === undefined || commonDir === undefined) return undefined;
  return isWorktreeAdminDir(commonDir, gitDir) ? root : undefined;
}

function nearestGitLinkDir(start: string): string | undefined {
  for (let dir = start; ; ) {
    const kind = entryKind(join(dir, '.git'));
    if (kind !== undefined) return kind === 'file' ? dir : undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function commonGitDir(root: string): string | undefined {
  const dotGit = join(root, '.git');
  const kind = entryKind(dotGit);
  if (kind === undefined) return undefined;
  if (kind === 'other') return dotGit;
  const gitDir = gitLinkTarget(root);
  if (gitDir === undefined) return undefined;
  const common = readText(join(gitDir, 'commondir'))?.trim();
  return common === undefined || common.length === 0 ? gitDir : resolve(gitDir, common);
}

function gitLinkTarget(dir: string): string | undefined {
  const target = /^gitdir:(.*)/.exec(readText(join(dir, '.git')) ?? '')?.[1]?.trim();
  return target === undefined || target.length === 0 ? undefined : resolve(dir, target);
}

function isWorktreeAdminDir(commonDir: string, gitDir: string): boolean {
  try {
    const inside = relative(realpathSync(join(commonDir, 'worktrees')), realpathSync(gitDir));
    return inside.length > 0 && inside !== '..' && !inside.includes(sep) && !isAbsolute(inside);
  } catch {
    return false;
  }
}

function entryKind(path: string): 'file' | 'other' | undefined {
  try {
    const stats = statSync(path, { throwIfNoEntry: false });
    if (stats === undefined) return undefined;
    return stats.isFile() ? 'file' : 'other';
  } catch {
    return undefined;
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
