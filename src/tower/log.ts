import { existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { TOWER_ROOT } from '../protocol/index.ts';
import type { TowerLog } from './controller.ts';

export const TOWER_LOG_FILE = 'pi-tower.log';

export interface TowerFileLogOptions {
  readonly agentDir: string;
  readonly repoRoot: () => string | undefined;
  readonly now?: () => Date;
}

export interface TowerFileLog extends TowerLog {
  flush(): Promise<void>;
}

export function createTowerFileLog(options: TowerFileLogOptions): TowerFileLog {
  let chain: Promise<void> = Promise.resolve();
  const write = (level: 'info' | 'warn', message: string, payload?: Readonly<Record<string, unknown>>): void => {
    const stamp = (options.now?.() ?? new Date()).toISOString();
    const line = `${stamp} ${level} ${message}${payload === undefined ? '' : ` ${serialize(payload)}`}\n`;
    chain = chain
      .then(async () => {
        const path = towerLogPath(options);
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, line, 'utf8');
      })
      .catch(() => undefined);
  };
  return {
    info: (message, payload) => {
      write('info', message, payload);
    },
    warn: (message, payload) => {
      write('warn', message, payload);
    },
    flush: () => chain,
  };
}

export function towerLogPath(options: Pick<TowerFileLogOptions, 'agentDir' | 'repoRoot'>): string {
  let root: string | undefined;
  try {
    root = options.repoRoot();
  } catch {
    root = undefined;
  }
  if (root !== undefined) {
    const towerDir = join(root, TOWER_ROOT);
    if (existsSync(towerDir)) return join(towerDir, TOWER_LOG_FILE);
  }
  return join(options.agentDir, TOWER_LOG_FILE);
}

function serialize(payload: Readonly<Record<string, unknown>>): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}
