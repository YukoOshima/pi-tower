import { describe, expect, it } from 'vitest';

import {
  parseShell,
  SHELL_PARSE_MAX_SUBSHELL_DEPTH,
  type ShellCommand,
  type ShellScript,
  type ShellSimpleCommand,
  type ShellSubshell,
} from '../../src/guards/shellParser.ts';

function script(source: string): ShellScript {
  const parsed = parseShell(source);
  if (!parsed.ok) throw new Error(`expected "${source}" to parse, got ${parsed.reason} at ${parsed.offset}`);
  return parsed.script;
}

function topCommands(parsed: ShellScript): ShellCommand[] {
  return parsed.statements.flatMap((statement) =>
    [statement.body.first, ...statement.body.rest.map((link) => link.pipeline)].flatMap(
      (pipeline) => pipeline.commands,
    ),
  );
}

function simpleCommands(parsed: ShellScript): ShellSimpleCommand[] {
  return topCommands(parsed).flatMap((command) =>
    command.kind === 'simple' ? [command] : simpleCommands(command.script),
  );
}

function commands(source: string): ShellSimpleCommand[] {
  return simpleCommands(script(source));
}

function values(source: string): (string | undefined)[][] {
  return commands(source).map((command) => command.words.map((word) => word.value));
}

function subshell(source: string): ShellSubshell {
  const [command] = topCommands(script(source));
  if (command?.kind !== 'subshell') throw new Error(`expected "${source}" to start with a subshell`);
  return command;
}

describe('parseShell structure', () => {
  it('splits statements on ; & and newlines and keeps && / || links', () => {
    const parsed = script('a && b || c; d & e\nf');
    expect(parsed.statements.map((statement) => statement.background)).toEqual([false, true, false, false]);
    const first = parsed.statements[0]!.body;
    expect(first.rest.map((link) => link.operator)).toEqual(['&&', '||']);
    expect(values('a && b || c; d & e\nf')).toEqual([['a'], ['b'], ['c'], ['d'], ['e'], ['f']]);
  });

  it('parses pipelines and negation', () => {
    const parsed = script('! a | b |& c');
    const pipeline = parsed.statements[0]!.body.first;
    expect(pipeline.negated).toBe(true);
    expect(pipeline.commands).toHaveLength(3);
    expect(script('! ! a').statements[0]!.body.first.negated).toBe(false);
  });

  it('accepts newlines after && || and |', () => {
    expect(values('a &&\n  b ||\n\n c |\n d')).toEqual([['a'], ['b'], ['c'], ['d']]);
  });

  it('parses an empty or comment-only script', () => {
    expect(script('').statements).toEqual([]);
    expect(script('  # just a comment\n\n').statements).toEqual([]);
  });

  it('drops comments only at word starts', () => {
    expect(values('a # b c\nd')).toEqual([['a'], ['d']]);
    expect(values('echo a#b $#')).toEqual([['echo', 'a#b', undefined]]);
    expect(values('a;#comment\nb')).toEqual([['a'], ['b']]);
  });

  it('consumes redirections with their targets', () => {
    expect(values('cmd >out 2>&1 <in arg &>/dev/null 3>>log {fd}>x >|y <>z <<<"here" &>>all')).toEqual([
      ['cmd', 'arg'],
    ]);
    const [command] = commands('cmd >out 2>&1 arg <<<"here"');
    expect(command!.redirects.map((redirect) => [redirect.operator, redirect.target.value])).toEqual([
      ['>', 'out'],
      ['>&', '1'],
      ['<<<', 'here'],
    ]);
    expect(commands('exit')[0]!.redirects).toEqual([]);
  });

  it('parses subshells with their own statements and trailing redirections', () => {
    const parsed = subshell('(cd a && b; c\n d) >log 2>&1 | e');
    expect(parsed.script.statements).toHaveLength(3);
    expect(parsed.redirects.map((redirect) => redirect.operator)).toEqual(['>', '>&']);
    expect(values('(cd a && b; c\n d) >log 2>&1 | e')).toEqual([['cd', 'a'], ['b'], ['c'], ['d'], ['e']]);
    expect(values('! ( (a) ) && (b) & (c)')).toEqual([['a'], ['b'], ['c']]);
    expect(script('( (a) )').statements[0]!.body.first.commands[0]!.kind).toBe('subshell');
  });

  it('separates prefix assignments from the command words', () => {
    const [command] = commands('FOO=1 BAR="a b" BAZ+=x cmd QUX=2');
    expect(command!.assignments.map((assignment) => [assignment.name, assignment.value.value])).toEqual([
      ['FOO', '1'],
      ['BAR', 'a b'],
      ['BAZ', 'x'],
    ]);
    expect(command!.words.map((word) => word.value)).toEqual(['cmd', 'QUX=2']);
    expect(commands('"FOO=1" cmd')[0]!.assignments).toEqual([]);
  });

  it('records a bare assignment as a command without words', () => {
    const [command] = commands('FOO=$BAR');
    expect(command!.words).toEqual([]);
    expect(command!.assignments[0]!.name).toBe('FOO');
    expect(command!.assignments[0]!.value.value).toBeUndefined();
  });
});

describe('parseShell words', () => {
  it('removes quotes and backslash escapes', () => {
    expect(values(`rm -rf "a b" 'c d' e\\ f x"y"'z' \\"q\\" "\\$\\\`\\"\\\\" "\\n"`)).toEqual([
      ['rm', '-rf', 'a b', 'c d', 'e f', 'xyz', '"q"', undefined, '\\n'],
    ]);
  });

  it('joins line continuations outside single quotes', () => {
    expect(values('ec\\\nho "a\\\nb" \'c\\\nd\'')).toEqual([['echo', 'ab', 'c\\\nd']]);
  });

  it('keeps escaped operators inside words', () => {
    expect(values('echo a \\; b \\| c \\&\\& d')).toEqual([['echo', 'a', ';', 'b', '|', 'c', '&&', 'd']]);
    expect(values('echo "a; b | c && d"')).toEqual([['echo', 'a; b | c && d']]);
  });

  it.each([
    '$HOME',
    '"$x"',
    '${x}',
    '${x:-a b}',
    '"${#x}"',
    '$1',
    '$@',
    "$'x'",
    '$"x"',
    '*.ts',
    'a?',
    'a[1]',
    "'*'",
    '{a,b}',
    'HEAD@{1}',
    '~user/x',
    '~+',
    'a$',
  ])('marks %s as dynamic', (word) => {
    const [command] = commands(`echo ${word}`);
    expect(command!.words[1]!.value).toBeUndefined();
    expect(command!.words[1]!.text).toBe(word);
  });

  it.each([
    ['~', '~'],
    ['~/x', '~/x'],
    ['a~b', 'a~b'],
    ["'~user'", '~user'],
    ['-', '-'],
    ['""', ''],
  ])('keeps %s literal', (word, value) => {
    expect(commands(`echo ${word}`)[0]!.words[1]!.value).toBe(value);
  });

  it('does not treat $\' or $" inside double quotes as quoting', () => {
    expect(values(`echo "$'" ; rm -rf x ; echo "'"`)).toEqual([['echo', undefined], ['rm', '-rf', 'x'], ['echo', "'"]]);
    expect(values('echo "$" ; rm x')).toEqual([['echo', undefined], ['rm', 'x']]);
  });

  it('scans ANSI-C strings with escaped quotes', () => {
    expect(values("echo $'it\\'s' ; rm x")).toEqual([['echo', undefined], ['rm', 'x']]);
  });

  it.each([
    ['*.ts', '*.ts'],
    ['dist/*.js', 'dist/*.js'],
    ["'*'.ts", '\\*.ts'],
    ['a\\*b?', 'a\\*b?'],
    ['"[x]"*', '\\[x\\]*'],
    ["'a b'/c*", 'a b/c*'],
    ['/tmp/pi-test-*', '/tmp/pi-test-*'],
  ])('keeps a glob pattern for %s', (word, pattern) => {
    const [command] = commands(`rm ${word}`);
    expect(command!.words[1]!.value).toBeUndefined();
    expect(command!.words[1]!.pattern).toBe(pattern);
  });

  it.each(['$x*', '"$x"/*', '{a,b}*', "'{a}'*", '~user/*', 'a\\$*', 'a$'])(
    'keeps no glob pattern for %s',
    (word) => {
      const [command] = commands(`rm ${word}`);
      expect(command!.words[1]!.pattern).toBeUndefined();
    },
  );

  it('keeps no glob pattern for literal words', () => {
    expect(commands('rm build')[0]!.words[1]).toEqual({ text: 'build', value: 'build', literal: 'build' });
  });

  it.each([
    ["'[ -f done.flag ] && rm -rf x'", '[ -f done.flag ] && rm -rf x'],
    ['"echo \\$HOME *.log {a,b}"', 'echo $HOME *.log {a,b}'],
    ["'~/x'", '~/x'],
    ['a\\*b', 'a*b'],
    ['plain', 'plain'],
  ])('keeps the exact argv string of %s', (word, literal) => {
    expect(commands(`bash -c ${word}`)[0]!.words[2]!.literal).toBe(literal);
  });

  it.each(['"$x"', '*.ts', 'a?', '[ab]', '{a,b}', '~/x', '~', '~user', "$'x'"])(
    'keeps no exact argv string for the expanding word %s',
    (word) => {
      expect(commands(`bash -c ${word}`)[0]!.words[2]!.literal).toBeUndefined();
    },
  );
});

describe('parseShell failures', () => {
  it.each([
    ['echo $(x)', 'command-substitution'],
    ['echo "$(x)"', 'command-substitution'],
    ['echo $((1 + 2))', 'command-substitution'],
    ['echo `x`', 'command-substitution'],
    ['echo "a`x`"', 'command-substitution'],
    ['echo $[1 + 2]', 'expansion'],
    ['echo ${a$(b)}', 'expansion'],
    ['echo ${a:-"b}"}', 'expansion'],
    ['echo ${a', 'expansion'],
    ['f() { a; }', 'syntax'],
    ['echo a(b)', 'syntax'],
    ['()', 'syntax'],
    ['(a', 'syntax'],
    ['( ; )', 'syntax'],
    ['(a) b', 'syntax'],
    ['(a)(b)', 'syntax'],
    ['X=1 (a)', 'syntax'],
    ['((1 + 2))', 'compound-command'],
    ['a && ((x > 1))', 'compound-command'],
    ['{ a; }', 'brace-group'],
    ['if a; then b; fi', 'compound-command'],
    ['for x in a; do b; done', 'compound-command'],
    ['while a; do b; done', 'compound-command'],
    ['until a; do b; done', 'compound-command'],
    ['case x in a) b;; esac', 'compound-command'],
    ['select x in a; do b; done', 'compound-command'],
    ['function f { a; }', 'compound-command'],
    ['coproc a', 'compound-command'],
    ['repeat 2 a', 'compound-command'],
    ['foreach x (a) b; end', 'compound-command'],
    ['FOO=1 if a; then b; fi', 'compound-command'],
    ['cat <<EOF\nx\nEOF', 'heredoc'],
    ['cat <<-EOF\n\tx\n\tEOF', 'heredoc'],
    ["cat 2<<'EOF'\nx\nEOF", 'heredoc'],
    ['diff <(a) b', 'process-substitution'],
    ['tee >(a)', 'process-substitution'],
    ['echo "abc', 'unterminated-quote'],
    ["echo 'abc", 'unterminated-quote'],
    ["echo $'abc", 'unterminated-quote'],
    ['a &&', 'syntax'],
    ['| a', 'syntax'],
    ['a || || b', 'syntax'],
    ['a ;; b', 'syntax'],
    ['a ;& b', 'syntax'],
    ['a | ! b', 'syntax'],
    ['a )', 'syntax'],
    ['echo >', 'syntax'],
    ['echo > ;', 'syntax'],
    ['a\r\nb', 'syntax'],
    [';', 'syntax'],
  ])('rejects %j as %s', (source, reason) => {
    const parsed = parseShell(source);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe(reason);
  });

  it('enforces the token budget', () => {
    expect(parseShell('a b c', { maxTokens: 3 }).ok).toBe(true);
    const parsed = parseShell('a b c d', { maxTokens: 3 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe('too-large');
  });

  it('bounds subshell nesting', () => {
    const nest = (depth: number): string => `${'( '.repeat(depth)}a${' )'.repeat(depth)}`;
    expect(parseShell(nest(SHELL_PARSE_MAX_SUBSHELL_DEPTH)).ok).toBe(true);
    const parsed = parseShell(nest(SHELL_PARSE_MAX_SUBSHELL_DEPTH + 1));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe('too-large');
    expect(parseShell(nest(3_000)).ok).toBe(false);
  });

  it('accepts here-strings, background jobs and trailing separators', () => {
    expect(parseShell('cat <<< "x"').ok).toBe(true);
    expect(parseShell('a &').ok).toBe(true);
    expect(parseShell('a;').ok).toBe(true);
    expect(parseShell('a\n\n').ok).toBe(true);
  });
});
