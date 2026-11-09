import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WORKTREES_DIR, resolveTowerRepoRoot } from '../../src/protocol/index.ts';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function createRepo(path: string, ...initArgs: string[]): Promise<string> {
  await mkdir(path, { recursive: true });
  await git(path, 'init', '-q', '-b', 'main', ...initArgs);
  await git(path, 'config', 'user.email', 'tower-test@example.com');
  await git(path, 'config', 'user.name', 'Tower Test');
  await writeFile(join(path, 'README.md'), '# fixture\n');
  await git(path, 'add', 'README.md');
  await git(path, 'commit', '-q', '-m', 'initial');
  return path;
}

async function addWorktree(repo: string, path: string, ...args: string[]): Promise<string> {
  await git(repo, 'worktree', 'add', '-q', ...args, path);
  return path;
}

let base: string;
let root: string;
let worktrees: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'pi-tower-repo-root-'));
  root = await createRepo(join(base, 'root'));
  worktrees = join(root, WORKTREES_DIR);
  await addWorktree(root, join(worktrees, 'wt-1'), '-b', 'feat/one');
  await addWorktree(root, join(worktrees, 'wt-12'), '-b', 'feat/twelve');
  await addWorktree(root, join(worktrees, 'val-ms1-scrutiny-r1'), '--detach');
  await mkdir(join(worktrees, 'wt-12', 'src', 'deep'), { recursive: true });
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('resolveTowerRepoRoot', () => {
  it('returns the cwd unchanged when it is the main checkout', () => {
    expect(resolveTowerRepoRoot('/repo')).toBe('/repo');
    expect(resolveTowerRepoRoot('/repo/src/layer')).toBe('/repo/src/layer');
    expect(resolveTowerRepoRoot(root)).toBe(root);
    expect(resolveTowerRepoRoot(join(root, 'src'))).toBe(join(root, 'src'));
  });

  it('maps a mission worktree and any directory inside it back to the main checkout', () => {
    expect(resolveTowerRepoRoot(join(worktrees, 'wt-1'))).toBe(root);
    expect(resolveTowerRepoRoot(`${join(worktrees, 'wt-1')}/`)).toBe(root);
    expect(resolveTowerRepoRoot(join(worktrees, 'wt-12', 'src'))).toBe(root);
    expect(resolveTowerRepoRoot(join(worktrees, 'wt-12', 'src', 'deep'))).toBe(root);
  });

  it('maps a detached validation worktree back to the main checkout', () => {
    expect(resolveTowerRepoRoot(join(worktrees, 'val-ms1-scrutiny-r1'))).toBe(root);
  });

  it('maps the worktrees directory itself back to the main checkout', () => {
    expect(resolveTowerRepoRoot(worktrees)).toBe(root);
    expect(resolveTowerRepoRoot('/repo/.tower/worktrees')).toBe('/repo');
    expect(resolveTowerRepoRoot('C:\\repo\\.tower\\worktrees')).toBe('C:\\repo');
  });

  it('does not mangle lookalike paths', () => {
    expect(resolveTowerRepoRoot('/repo/.tower/worktreesmith/x')).toBe(
      '/repo/.tower/worktreesmith/x',
    );
  });

  it('keeps an independent repository nested inside a worktree as its own root', async () => {
    const nested = await createRepo(join(worktrees, 'wt-1', 'tmp', 'repo'));
    await mkdir(join(nested, 'sub'), { recursive: true });

    expect(resolveTowerRepoRoot(nested)).toBe(nested);
    expect(resolveTowerRepoRoot(join(nested, 'sub'))).toBe(join(nested, 'sub'));
  });

  it('maps the worktrees of a nested repository to the nested repository, never to the outer workspace', async () => {
    const nested = await createRepo(join(worktrees, 'wt-12', 'tmp', 'tower-repo'));
    const nestedWorktree = await addWorktree(nested, join(nested, WORKTREES_DIR, 'wt-1'), '-b', 'feat/nested');

    expect(resolveTowerRepoRoot(nestedWorktree)).toBe(nested);
    expect(resolveTowerRepoRoot(join(nested, WORKTREES_DIR))).toBe(nested);
  });

  it('keeps a path below the worktrees directory that is not one of its worktrees unchanged', async () => {
    const plain = join(worktrees, 'wt-x', 'tmp', 'plain');
    await mkdir(plain, { recursive: true });

    expect(resolveTowerRepoRoot(plain)).toBe(plain);
    expect(resolveTowerRepoRoot(join(worktrees, 'wt-x'))).toBe(join(worktrees, 'wt-x'));
    expect(resolveTowerRepoRoot('/repo/.tower/worktrees/wt-1')).toBe('/repo/.tower/worktrees/wt-1');
    expect(resolveTowerRepoRoot('C:\\repo\\.tower\\worktrees\\wt-1')).toBe('C:\\repo\\.tower\\worktrees\\wt-1');
  });

  it('does not claim a worktree that belongs to another repository', async () => {
    const other = await createRepo(join(base, 'other'));
    const foreign = await addWorktree(other, join(worktrees, 'wt-foreign'), '-b', 'feat/foreign');

    expect(resolveTowerRepoRoot(foreign)).toBe(foreign);
  });

  it('follows relative gitdir links and a symlinked main checkout', async () => {
    const relativeLink = await addWorktree(root, join(worktrees, 'wt-relative'), '-b', 'feat/relative');
    await writeFile(join(relativeLink, '.git'), 'gitdir: ../../../.git/worktrees/wt-relative\n');
    const link = join(base, 'root-link');
    await symlink(root, link);

    expect(await git(relativeLink, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/relative');
    expect(resolveTowerRepoRoot(relativeLink)).toBe(root);
    expect(resolveTowerRepoRoot(join(link, WORKTREES_DIR, 'wt-1'))).toBe(link);
  });

  it('compares git common dirs, so separate git dirs and linked-worktree checkouts keep their worktrees', async () => {
    const separate = await createRepo(join(base, 'separate'), '--separate-git-dir', join(base, 'separate.git'));
    const separateWorktree = await addWorktree(separate, join(separate, WORKTREES_DIR, 'wt-1'), '-b', 'feat/separate');
    const linked = await addWorktree(root, join(base, 'linked'), '-b', 'feat/linked');
    const linkedWorktree = await addWorktree(linked, join(linked, WORKTREES_DIR, 'wt-1'), '-b', 'feat/linked-wt');

    expect(resolveTowerRepoRoot(separateWorktree)).toBe(separate);
    expect(resolveTowerRepoRoot(linkedWorktree)).toBe(linked);
  });
});
