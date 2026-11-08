import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  findWriteEscapes,
  isWithinDirectory,
  resolveToolPath,
  writeGuardVeto,
} from '../../src/guards/writeGuard.ts';

const repo = '/work/repo';
const worktrees = join(repo, '.tower', 'worktrees');
const worktree = join(worktrees, 'wt-1');
const home = '/home/tester';

describe('findWriteEscapes', () => {
  it('allows writes inside the worktree', () => {
    expect(
      findWriteEscapes(
        [`${worktree}/src/gemm.cpp`, 'src/a.ts', './b.ts', 'nested/../c.ts', worktree, `${worktree}/`],
        worktree,
        worktree,
        home,
      ),
    ).toEqual([]);
  });

  it('returns the resolved paths that leave the worktree', () => {
    expect(
      findWriteEscapes(
        [
          `${repo}/src/gemm.cpp`,
          `${repo}/.tower/worktrees/wt-2/x.ts`,
          '../wt-2/x.ts',
          `${worktree}/../wt-2/y.ts`,
          `${worktrees}/wt-10/z.ts`,
          '../../comms/state.json',
          '/etc/hosts',
        ],
        worktree,
        worktree,
        home,
      ),
    ).toEqual([
      `${repo}/src/gemm.cpp`,
      `${worktrees}/wt-2/x.ts`,
      `${worktrees}/wt-2/x.ts`,
      `${worktrees}/wt-2/y.ts`,
      `${worktrees}/wt-10/z.ts`,
      `${repo}/.tower/comms/state.json`,
      '/etc/hosts',
    ]);
  });

  it('resolves relative paths against the session cwd', () => {
    expect(findWriteEscapes(['src/x.ts', '.tower/worktrees/wt-1/src/x.ts'], worktree, repo, home)).toEqual([
      `${repo}/src/x.ts`,
    ]);
  });

  it('expands ~ against the home directory', () => {
    expect(findWriteEscapes(['~/wt-1/a.ts', '~/wt-2/a.ts', '~'], worktree, '/', worktrees)).toEqual([
      `${worktrees}/wt-2/a.ts`,
      worktrees,
    ]);
    expect(findWriteEscapes(['~/notes.md'], worktree, worktree, home)).toEqual([`${home}/notes.md`]);
    expect(findWriteEscapes(['~user/x', '~+/x'], worktree, worktree, home)).toEqual([]);
  });

  it('strips the @ prefix pi accepts on tool paths', () => {
    expect(findWriteEscapes([`@${repo}/src/x.ts`, '@src/a.ts'], worktree, worktree, home)).toEqual([
      `${repo}/src/x.ts`,
    ]);
  });

  it('resolves file URLs and normalizes unicode spaces like pi', () => {
    expect(
      findWriteEscapes([`file://${repo}/src/x.ts`, `file://${worktree}/x.ts`], worktree, worktree, home),
    ).toEqual([`${repo}/src/x.ts`]);
    expect(resolveToolPath('my\u00A0file\u2003.ts', worktree, home)).toBe(`${worktree}/my file .ts`);
  });

  it('denies paths pi cannot resolve', () => {
    expect(findWriteEscapes(['file://remote-host/x.ts'], worktree, worktree, home)).toEqual([
      'file://remote-host/x.ts',
    ]);
  });
});

describe('isWithinDirectory', () => {
  it.each([
    ['/a/b', '/a', true],
    ['/a', '/a', true],
    ['/a/', '/a', true],
    ['/a/..b', '/a', true],
    ['/ab', '/a', false],
    ['/a/../b', '/a', false],
    ['/', '/a', false],
  ])('%s within %s is %s', (path, directory, expected) => {
    expect(isWithinDirectory(path, directory)).toBe(expected);
  });
});

describe('writeGuardVeto', () => {
  it("reproduces kimi's denial message", () => {
    expect(writeGuardVeto(worktree, [`${repo}/src/gemm.cpp`, `${worktrees}/wt-2/x.ts`])).toBe(
      `tower workers may only write inside their own worktree (${worktree}) — denied: ` +
        `${repo}/src/gemm.cpp, ${worktrees}/wt-2/x.ts. ` +
        'Out-of-scope changes are not yours to make: file them with TowerFinding or ask the tower via TowerSend.',
    );
  });
});
