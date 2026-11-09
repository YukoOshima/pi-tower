import { readFileSync, statSync } from 'node:fs';

import { HEADLESS_USAGE, parseHeadlessArgs, type HeadlessRunOptions } from './args.ts';
import { PiRpcClient } from './rpc.ts';
import { HEADLESS_EXIT, runHeadless, type HeadlessClock, type HeadlessDeps, type HeadlessOutput, type HeadlessSignal } from './runner.ts';
import { readHeadlessSnapshot } from './state.ts';

export const systemClock: HeadlessClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
    }),
};

export const processOutput: HeadlessOutput = {
  info: (line) => {
    process.stdout.write(`${line}\n`);
  },
  error: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

export function processSignals(handler: (signal: HeadlessSignal) => void): () => void {
  const onSigint = (): void => {
    handler('SIGINT');
  };
  const onSigterm = (): void => {
    handler('SIGTERM');
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  return () => {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  };
}

export function headlessDeps(output: HeadlessOutput = processOutput): HeadlessDeps {
  return {
    createPi: (options) => new PiRpcClient(options),
    clock: systemClock,
    readState: readHeadlessSnapshot,
    output,
    onSignal: processSignals,
  };
}

export function packageVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { readonly version?: unknown };
  return typeof manifest.version === 'string' ? manifest.version : 'unknown';
}

export function preflight(options: HeadlessRunOptions): string | undefined {
  try {
    if (!statSync(options.cwd).isDirectory()) return `--cwd ${options.cwd} is not a directory`;
  } catch {
    return `--cwd ${options.cwd} does not exist`;
  }
  let objective: string;
  try {
    if (!statSync(options.objectiveFile).isFile()) return `objective file ${options.objectiveFile} is not a file`;
    objective = readFileSync(options.objectiveFile, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? `objective file ${options.objectiveFile} does not exist` : `cannot read objective file ${options.objectiveFile}: ${String(code)}`;
  }
  if (objective.trim().length === 0) return `objective file ${options.objectiveFile} is empty`;
  return undefined;
}

export async function main(argv: readonly string[], deps: HeadlessDeps = headlessDeps()): Promise<number> {
  const parsed = parseHeadlessArgs(argv, process.cwd());
  switch (parsed.kind) {
    case 'help':
      deps.output.info(HEADLESS_USAGE);
      return HEADLESS_EXIT.completed;
    case 'version':
      deps.output.info(packageVersion());
      return HEADLESS_EXIT.completed;
    case 'error':
      deps.output.error(`pi-tower: ${parsed.message}\nRun pi-tower --help for usage.`);
      return HEADLESS_EXIT.startup;
    case 'run': {
      const problem = preflight(parsed.options);
      if (problem !== undefined) {
        deps.output.error(`pi-tower: ${problem}`);
        return HEADLESS_EXIT.startup;
      }
      return runHeadless(parsed.options, deps);
    }
  }
}
