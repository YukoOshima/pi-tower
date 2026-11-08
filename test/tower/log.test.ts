import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TOWER_LOG_FILE, createTowerFileLog } from '../../src/tower/log.ts';
import { createRepo, removeDir } from './fakes.ts';

const cleanups: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of cleanups.splice(0)) await removeDir(dir);
});

describe('createTowerFileLog', () => {
  it('appends timestamped lines lazily to the agent dir, then to .tower/ once it exists, never to comms or the terminal', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'tower-log-agent-'));
    const repo = await createRepo('tower-log-repo-');
    cleanups.push(agentDir, repo);
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write');
    let bound: string | undefined;
    const log = createTowerFileLog({
      agentDir,
      repoRoot: () => bound,
      now: () => new Date('2026-11-09T01:02:03.000Z'),
    });
    expect(await readdir(agentDir)).toEqual([]);

    log.warn('tower: failed to deliver the agent notification', { error: 'boom' });
    bound = repo;
    log.info('tower: before the workspace exists');
    await log.flush();

    expect(await readFile(join(agentDir, TOWER_LOG_FILE), 'utf8')).toBe(
      '2026-11-09T01:02:03.000Z warn tower: failed to deliver the agent notification {"error":"boom"}\n' +
        '2026-11-09T01:02:03.000Z info tower: before the workspace exists\n',
    );
    expect(existsSync(join(repo, '.tower'))).toBe(false);

    await mkdir(join(repo, '.tower'));
    log.warn('tower: failed to release tower workspace ownership');
    await log.flush();

    expect(await readFile(join(repo, '.tower', TOWER_LOG_FILE), 'utf8')).toBe(
      '2026-11-09T01:02:03.000Z warn tower: failed to release tower workspace ownership\n',
    );
    expect(existsSync(join(repo, '.tower', 'comms'))).toBe(false);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });
});
