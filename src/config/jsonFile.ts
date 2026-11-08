import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { TowerConfigError } from './schema.ts';

export interface ConfigJson {
  readonly exists: boolean;
  readonly value: unknown;
}

export async function readConfigJson(path: string, source: string): Promise<ConfigJson> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) return { exists: false, value: {} };
    throw new TowerConfigError([
      { source, message: `cannot read the file — ${errorMessage(error)}` },
    ]);
  }
  const body = text.replace(/^\uFEFF/, '');
  if (body.trim().length === 0) return { exists: true, value: {} };
  try {
    return { exists: true, value: JSON.parse(body) as unknown };
  } catch (error) {
    throw new TowerConfigError([{ source, message: `invalid JSON — ${errorMessage(error)}` }]);
  }
}

export async function writeConfigJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const mode = await fileMode(path);
  const tmp = `${path}.tmp-${String(process.pid)}-${randomUUID()}`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

export function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fileMode(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mode & 0o777;
  } catch {
    return undefined;
  }
}
