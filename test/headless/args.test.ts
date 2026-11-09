import { describe, expect, it } from 'vitest';

import { HEADLESS_SYNOPSIS, HEADLESS_USAGE, parseHeadlessArgs, piRunArgs } from '../../src/headless/args.ts';

const BASE = '/work/here';
const EXEC_HINT = 'exec needs --mission (pi-tower only runs missions) — use pi-tower exec --mission -f <mission.md>, the same as pi-tower run -f <mission.md>';
const REF_FORMAT = 'expected provider/modelId[:thinkingLevel] (e.g. anthropic/claude-sonnet-4-5:high)';

function error(argv: readonly string[]): string {
  const parsed = parseHeadlessArgs(argv, BASE);
  if (parsed.kind !== 'error') throw new Error(`expected an error, got ${parsed.kind}`);
  return parsed.message;
}

describe('parseHeadlessArgs', () => {
  it('parses a full run command and resolves paths against the base directory', () => {
    expect(
      parseHeadlessArgs(
        ['run', '-f', 'goal.md', '--auto-approve', '--timeout', '60000', '--cwd', '../repo', '--pi', '/opt/pi', '--', '--model', 'a/b', '-e', 'x.ts'],
        BASE,
      ),
    ).toEqual({
      kind: 'run',
      options: {
        objectiveFile: '/work/here/goal.md',
        autoApprove: true,
        timeoutMs: 60_000,
        cwd: '/work/repo',
        piBin: '/opt/pi',
        piArgs: ['--model', 'a/b', '-e', 'x.ts'],
        models: {},
      },
    });
  });

  it('applies defaults and accepts --name=value forms', () => {
    expect(parseHeadlessArgs(['run', '--file=/abs/goal.md'], BASE)).toEqual({
      kind: 'run',
      options: { objectiveFile: '/abs/goal.md', autoApprove: false, timeoutMs: undefined, cwd: BASE, piBin: 'pi', piArgs: [], models: {} },
    });
    const parsed = parseHeadlessArgs(['run', '-f', 'g.md', '--timeout=5', '--cwd=/r', '--pi=pi2'], BASE);
    expect(parsed).toMatchObject({ kind: 'run', options: { timeoutMs: 5, cwd: '/r', piBin: 'pi2' } });
  });

  it('resolves a path-like --pi against the base directory and keeps a bare command for the PATH lookup', () => {
    expect(parseHeadlessArgs(['run', '-f', 'g.md', '--pi', './tools/pi'], BASE)).toMatchObject({ options: { piBin: '/work/here/tools/pi' } });
    expect(parseHeadlessArgs(['run', '-f', 'g.md', '--pi', 'pi-nightly'], BASE)).toMatchObject({ options: { piBin: 'pi-nightly' } });
  });

  it('answers --help and --version before validating anything else', () => {
    expect(parseHeadlessArgs(['--help'], BASE)).toEqual({ kind: 'help' });
    expect(parseHeadlessArgs(['run', '-h'], BASE)).toEqual({ kind: 'help' });
    expect(parseHeadlessArgs(['exec', '--help'], BASE)).toEqual({ kind: 'help' });
    expect(parseHeadlessArgs(['--version'], BASE)).toEqual({ kind: 'version' });
    expect(parseHeadlessArgs(['run', '--bogus', '--version'], BASE)).toEqual({ kind: 'version' });
  });

  it('passes --help after -- through to pi', () => {
    expect(parseHeadlessArgs(['run', '-f', 'g.md', '--', '--help'], BASE)).toMatchObject({ kind: 'run', options: { piArgs: ['--help'] } });
  });

  it('reports every usage error with a clear message', () => {
    expect(error([])).toBe('missing command — expected "run" or "exec --mission"');
    expect(error(['go'])).toBe('unknown command "go" — expected "run" or "exec --mission"');
    expect(error(['-f', 'g.md'])).toBe('unknown option -f — options go after "run" or "exec --mission"');
    expect(error(['run'])).toBe('missing -f <objective file>');
    expect(error(['run', '-f'])).toBe('-f needs a value');
    expect(error(['run', '-f', '--auto-approve'])).toBe('-f needs a value');
    expect(error(['run', '--file='])).toBe('--file needs a value');
    expect(error(['run', '-f', 'a.md', '-f', 'b.md'])).toBe('-f is given twice');
    expect(error(['run', '-f', 'a.md', '--auto-approve', '--auto-approve'])).toBe('--auto-approve is given twice');
    expect(error(['run', '-f', 'a.md', '--auto-approve=yes'])).toBe('--auto-approve takes no value');
    expect(error(['run', '-f', 'a.md', '--verbose'])).toBe('unknown option --verbose');
    expect(error(['run', '-f', 'a.md', 'extra'])).toBe('unexpected argument "extra"');
    expect(error(['run', '-f', 'a.md', '--timeout', 'soon'])).toBe('--timeout must be a positive whole number of milliseconds, got "soon"');
    expect(error(['run', '-f', 'a.md', '--timeout', '0'])).toBe('--timeout must be a positive whole number of milliseconds, got "0"');
    expect(error(['run', '-f', 'a.md', '--timeout=1.5'])).toBe('--timeout must be a positive whole number of milliseconds, got "1.5"');
    expect(error(['run', '-f', 'a.md', '--timeout', '-5'])).toBe('--timeout needs a value');
    expect(error(['run', '-f', 'a.md', '--timeout', '2147483648'])).toBe('--timeout must be at most 2147483647 milliseconds (about 24.8 days), got "2147483648"');
    expect(parseHeadlessArgs(['run', '-f', 'a.md', '--timeout', '2147483647'], BASE)).toMatchObject({ kind: 'run', options: { timeoutMs: 2_147_483_647 } });
  });

  it('documents every exit code in the usage text', () => {
    for (const code of ['0  ', '1  ', '2  ', '3  ', '4  ', '130 / 143']) expect(HEADLESS_USAGE).toContain(`  ${code}`);
  });

  describe('role model flags', () => {
    it('accepts --orchestrator-model, --worker-model, --reviewer-model and --validator-model in both forms and leaves the extra pi args alone', () => {
      expect(
        parseHeadlessArgs(
          [
            'run',
            '--orchestrator-model',
            'anthropic/claude-opus-4-5:high',
            '-f',
            'g.md',
            '--worker-model=openai/gpt-5.1-codex',
            '--reviewer-model',
            ' openai/gpt-5.1 ',
            '--validator-model=google/gemini-2.5-pro:low',
            '--',
            '--tower-worker-model',
            'x/y',
          ],
          BASE,
        ),
      ).toEqual({
        kind: 'run',
        options: {
          objectiveFile: '/work/here/g.md',
          autoApprove: false,
          timeoutMs: undefined,
          cwd: BASE,
          piBin: 'pi',
          piArgs: ['--tower-worker-model', 'x/y'],
          models: {
            orchestrator: 'anthropic/claude-opus-4-5:high',
            worker: 'openai/gpt-5.1-codex',
            reviewer: 'openai/gpt-5.1',
            validator: 'google/gemini-2.5-pro:low',
          },
        },
      });
    });

    it('records only the roles that are given', () => {
      expect(parseHeadlessArgs(['run', '-f', 'g.md', '--worker-model', 'ollama/llama3:8b'], BASE)).toMatchObject({ kind: 'run', options: { models: { worker: 'ollama/llama3:8b' } } });
      const parsed = parseHeadlessArgs(['run', '-f', 'g.md', '--validator-model', 'openai/gpt-5.1:xhigh'], BASE);
      expect(parsed.kind === 'run' ? parsed.options.models : undefined).toEqual({ validator: 'openai/gpt-5.1:xhigh' });
    });

    it('rejects a missing, malformed or repeated model and an unknown model flag', () => {
      expect(error(['run', '-f', 'g.md', '--worker-model'])).toBe('--worker-model needs a value');
      expect(error(['run', '-f', 'g.md', '--orchestrator-model', '--auto-approve'])).toBe('--orchestrator-model needs a value');
      expect(error(['run', '-f', 'g.md', '--validator-model='])).toBe('--validator-model needs a value');
      expect(error(['run', '-f', 'g.md', '--reviewer-model', '  '])).toBe('--reviewer-model needs a value');
      expect(error(['run', '-f', 'g.md', '--worker-model', 'gpt-5.1'])).toBe(`--worker-model "gpt-5.1" has no provider — ${REF_FORMAT}`);
      expect(error(['run', '-f', 'g.md', '--reviewer-model', 'openai/'])).toBe(`--reviewer-model "openai/" has an empty model id — ${REF_FORMAT}`);
      expect(error(['run', '-f', 'g.md', '--validator-model=/gpt-5.1'])).toBe(`--validator-model "/gpt-5.1" has an empty provider — ${REF_FORMAT}`);
      expect(error(['run', '-f', 'g.md', '--worker-model', 'a/b', '--worker-model=c/d'])).toBe('--worker-model is given twice');
      expect(error(['run', '-f', 'g.md', '--workers-model', 'a/b'])).toBe('unknown option --workers-model');
      expect(error(['run', '-f', 'g.md', '--primary-model', 'a/b'])).toBe('unknown option --primary-model');
      expect(error(['run', '-f', 'g.md', '--tower-worker-model', 'a/b'])).toBe('unknown option --tower-worker-model');
    });
  });

  describe('exec --mission, the Droid spelling', () => {
    const RUN_ARGS = ['-f', 'g.md', '--worker-model', 'a/b', '--validator-model=c/d:high', '--auto-approve', '--', '-e', 'x.ts'];

    it('parses exec --mission exactly like run, with --mission anywhere among the options', () => {
      const run = parseHeadlessArgs(['run', ...RUN_ARGS], BASE);
      expect(run).toMatchObject({ kind: 'run', options: { models: { worker: 'a/b', validator: 'c/d:high' }, autoApprove: true, piArgs: ['-e', 'x.ts'] } });
      expect(parseHeadlessArgs(['exec', '--mission', ...RUN_ARGS], BASE)).toEqual(run);
      expect(parseHeadlessArgs(['exec', '-f', 'g.md', '--mission', ...RUN_ARGS.slice(2)], BASE)).toEqual(run);
    });

    it('lets run accept --mission and ignore it', () => {
      expect(parseHeadlessArgs(['run', '--mission', ...RUN_ARGS], BASE)).toEqual(parseHeadlessArgs(['run', ...RUN_ARGS], BASE));
    });

    it('refuses exec without --mission with a hint, also when --mission only appears after --', () => {
      expect(error(['exec'])).toBe(EXEC_HINT);
      expect(error(['exec', '-f', 'g.md', '--auto-approve'])).toBe(EXEC_HINT);
      expect(error(['exec', '-f', 'g.md', '--', '--mission'])).toBe(EXEC_HINT);
    });

    it('validates exec --mission like run', () => {
      expect(error(['exec', '--mission'])).toBe('missing -f <objective file>');
      expect(error(['exec', '--mission', '--mission', '-f', 'g.md'])).toBe('--mission is given twice');
      expect(error(['exec', '--mission=yes', '-f', 'g.md'])).toBe('--mission takes no value');
      expect(error(['exec', '--mission', '-f', 'g.md', '--worker-model'])).toBe('--worker-model needs a value');
      expect(error(['exec', '--mission', '-f', 'g.md', '--model', 'a/b'])).toBe('unknown option --model');
    });
  });

  it('covers the role model flags and the exec alias in the usage text, starting with the synopsis', () => {
    expect(HEADLESS_USAGE.startsWith(`${HEADLESS_SYNOPSIS}\n\n`)).toBe(true);
    for (const role of ['orchestrator', 'worker', 'reviewer', 'validator']) {
      expect(HEADLESS_SYNOPSIS).toContain(`[--${role}-model <ref>]`);
      expect(HEADLESS_USAGE).toMatch(new RegExp(`^  --${role}-model <ref> +model of the ${role}`, 'm'));
    }
    expect(HEADLESS_SYNOPSIS).toContain('pi-tower exec --mission -f <mission.md>');
    expect(HEADLESS_USAGE).toMatch(/^ {2}--mission {19}required by exec; run accepts it and ignores it$/m);
    expect(HEADLESS_USAGE).toContain('Each --<role>-model reaches pi as --tower-<role>-model');
    expect(HEADLESS_USAGE).toContain('so it wins over a --tower-<role>-model given after --');
  });
});

describe('piRunArgs', () => {
  it('passes the extra pi args unchanged when no role model is given', () => {
    expect(piRunArgs({ piArgs: ['--model', 'a/b', '-e', 'x.ts'], models: {} })).toEqual(['--model', 'a/b', '-e', 'x.ts']);
    expect(piRunArgs({ piArgs: [], models: {} })).toEqual([]);
  });

  it('appends one --tower-<role>-model=<ref> per given role, in role order, after the extra pi args', () => {
    expect(
      piRunArgs({
        piArgs: ['-e', 'x.ts', '--tower-worker-model', 'old/model'],
        models: { validator: 'google/gemini-2.5-pro:low', worker: 'openai/gpt-5.1-codex', orchestrator: 'anthropic/claude-opus-4-5:high' },
      }),
    ).toEqual([
      '-e',
      'x.ts',
      '--tower-worker-model',
      'old/model',
      '--tower-orchestrator-model=anthropic/claude-opus-4-5:high',
      '--tower-worker-model=openai/gpt-5.1-codex',
      '--tower-validator-model=google/gemini-2.5-pro:low',
    ]);
  });

  it('puts the model flags before a bare -- among the extra pi args, where pi still reads flags', () => {
    expect(piRunArgs({ piArgs: ['-e', 'x.ts', '--', 'hello', '--'], models: { reviewer: 'openai/gpt-5.1' } })).toEqual(['-e', 'x.ts', '--tower-reviewer-model=openai/gpt-5.1', '--', 'hello', '--']);
  });
});
