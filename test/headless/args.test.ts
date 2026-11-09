import { describe, expect, it } from 'vitest';

import { HEADLESS_USAGE, parseHeadlessArgs } from '../../src/headless/args.ts';

const BASE = '/work/here';

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
      },
    });
  });

  it('applies defaults and accepts --name=value forms', () => {
    expect(parseHeadlessArgs(['run', '--file=/abs/goal.md'], BASE)).toEqual({
      kind: 'run',
      options: { objectiveFile: '/abs/goal.md', autoApprove: false, timeoutMs: undefined, cwd: BASE, piBin: 'pi', piArgs: [] },
    });
    const parsed = parseHeadlessArgs(['run', '-f', 'g.md', '--timeout=5', '--cwd=/r', '--pi=pi2'], BASE);
    expect(parsed).toMatchObject({ kind: 'run', options: { timeoutMs: 5, cwd: '/r', piBin: 'pi2' } });
  });

  it('answers --help and --version before validating anything else', () => {
    expect(parseHeadlessArgs(['--help'], BASE)).toEqual({ kind: 'help' });
    expect(parseHeadlessArgs(['run', '-h'], BASE)).toEqual({ kind: 'help' });
    expect(parseHeadlessArgs(['--version'], BASE)).toEqual({ kind: 'version' });
    expect(parseHeadlessArgs(['run', '--bogus', '--version'], BASE)).toEqual({ kind: 'version' });
  });

  it('passes --help after -- through to pi', () => {
    expect(parseHeadlessArgs(['run', '-f', 'g.md', '--', '--help'], BASE)).toMatchObject({ kind: 'run', options: { piArgs: ['--help'] } });
  });

  it('reports every usage error with a clear message', () => {
    expect(error([])).toBe('missing command — expected "run"');
    expect(error(['go'])).toBe('unknown command "go" — expected "run"');
    expect(error(['-f', 'g.md'])).toBe('unknown option -f — options go after "run"');
    expect(error(['run'])).toBe('missing -f <objective file>');
    expect(error(['run', '-f'])).toBe('-f needs a value');
    expect(error(['run', '-f', '--auto-approve'])).toBe('-f needs a value');
    expect(error(['run', '--file='])).toBe('--file needs a value');
    expect(error(['run', '-f', 'a.md', '-f', 'b.md'])).toBe('-f is given twice');
    expect(error(['run', '-f', 'a.md', '--auto-approve', '--auto-approve'])).toBe('--auto-approve is given twice');
    expect(error(['run', '-f', 'a.md', '--verbose'])).toBe('unknown option --verbose');
    expect(error(['run', '-f', 'a.md', 'extra'])).toBe('unexpected argument "extra"');
    expect(error(['run', '-f', 'a.md', '--timeout', 'soon'])).toBe('--timeout must be a positive whole number of milliseconds, got "soon"');
    expect(error(['run', '-f', 'a.md', '--timeout', '0'])).toBe('--timeout must be a positive whole number of milliseconds, got "0"');
    expect(error(['run', '-f', 'a.md', '--timeout=1.5'])).toBe('--timeout must be a positive whole number of milliseconds, got "1.5"');
    expect(error(['run', '-f', 'a.md', '--timeout', '-5'])).toBe('--timeout needs a value');
  });

  it('documents every exit code in the usage text', () => {
    for (const code of ['0  ', '1  ', '2  ', '3  ', '4  ', '130 / 143']) expect(HEADLESS_USAGE).toContain(`  ${code}`);
  });
});
