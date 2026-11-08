export const SHELL_PARSE_MAX_TOKENS = 10_000;
export const SHELL_PARSE_MAX_SUBSHELL_DEPTH = 16;

export interface ShellParseOptions {
  readonly maxTokens?: number;
}

export interface ShellWord {
  readonly text: string;
  readonly value: string | undefined;
  readonly literal?: string;
  readonly pattern?: string;
}

export interface ShellAssignment {
  readonly name: string;
  readonly value: ShellWord;
}

export interface ShellRedirect {
  readonly operator: string;
  readonly target: ShellWord;
}

export interface ShellSimpleCommand {
  readonly kind: 'simple';
  readonly assignments: readonly ShellAssignment[];
  readonly words: readonly ShellWord[];
  readonly redirects: readonly ShellRedirect[];
}

export interface ShellSubshell {
  readonly kind: 'subshell';
  readonly script: ShellScript;
  readonly redirects: readonly ShellRedirect[];
}

export type ShellCommand = ShellSimpleCommand | ShellSubshell;

export interface ShellPipeline {
  readonly negated: boolean;
  readonly commands: readonly ShellCommand[];
}

export interface ShellAndOrLink {
  readonly operator: '&&' | '||';
  readonly pipeline: ShellPipeline;
}

export interface ShellAndOr {
  readonly first: ShellPipeline;
  readonly rest: readonly ShellAndOrLink[];
}

export interface ShellStatement {
  readonly body: ShellAndOr;
  readonly background: boolean;
}

export interface ShellScript {
  readonly statements: readonly ShellStatement[];
}

export type ShellParseFailure =
  | 'syntax'
  | 'unterminated-quote'
  | 'command-substitution'
  | 'process-substitution'
  | 'expansion'
  | 'brace-group'
  | 'compound-command'
  | 'heredoc'
  | 'too-large';

export type ShellParseResult =
  | { readonly ok: true; readonly script: ShellScript }
  | { readonly ok: false; readonly reason: ShellParseFailure; readonly offset: number };

type ShellOperator = ';;&' | ';;' | ';&' | '&&' | '||' | '|&' | '|' | ';' | '&' | '(' | ')';

type Token =
  | { readonly kind: 'word'; readonly word: ShellWord; readonly offset: number }
  | { readonly kind: 'operator'; readonly operator: ShellOperator; readonly offset: number }
  | { readonly kind: 'redirect'; readonly operator: string; readonly offset: number }
  | { readonly kind: 'newline'; readonly offset: number };

interface Cursor {
  readonly tokens: readonly Token[];
  readonly length: number;
  index: number;
  depth: number;
}

class ShellParseError extends Error {
  readonly reason: ShellParseFailure;
  readonly offset: number;

  constructor(reason: ShellParseFailure, offset: number) {
    super(`${reason} at offset ${offset}`);
    this.reason = reason;
    this.offset = offset;
  }
}

const OPERATORS: readonly ShellOperator[] = [';;&', ';;', ';&', '&&', '||', '|&', '|', ';', '&', '(', ')'];
const WORD_BREAKS: ReadonlySet<string> = new Set([' ', '\t', '\n', '|', '&', ';', '(', ')', '<', '>']);
const REDIRECT = /(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?(<<<|<<-?|<>|<&|<\(|<|>>|>&|>\||>\(|>)|(&>>?)/y;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/;
const DYNAMIC_VALUE = /[$`*?[\]{}]/;
const NON_GLOB_DYNAMIC_VALUE = /[$`{}]/;
const DOUBLE_QUOTE_ESCAPES = '$`"\\';
const GLOB_SPECIAL = '*?[]\\';
const UNQUOTED_EXPANSIONS = '*?[{';

const COMPOUND_COMMAND_WORDS: readonly string[] = [
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'case',
  'esac',
  'for',
  'select',
  'while',
  'until',
  'do',
  'done',
  'function',
  'coproc',
];

const RESERVED_WORDS: ReadonlyMap<string, ShellParseFailure> = new Map<string, ShellParseFailure>([
  ['{', 'brace-group'],
  ['}', 'brace-group'],
  ['!', 'syntax'],
  ...COMPOUND_COMMAND_WORDS.map((word): [string, ShellParseFailure] => [word, 'compound-command']),
]);

export function parseShell(source: string, options: ShellParseOptions = {}): ShellParseResult {
  try {
    const carriageReturn = source.indexOf('\r');
    if (carriageReturn >= 0) throw new ShellParseError('syntax', carriageReturn);
    const tokens = tokenize(source, options.maxTokens ?? SHELL_PARSE_MAX_TOKENS);
    return { ok: true, script: parseScript({ tokens, length: source.length, index: 0, depth: 0 }, false) };
  } catch (error) {
    if (error instanceof ShellParseError) return { ok: false, reason: error.reason, offset: error.offset };
    throw error;
  }
}

function tokenize(source: string, maxTokens: number): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  while (pos < source.length) {
    const char = source[pos]!;
    if (char === ' ' || char === '\t') {
      pos += 1;
      continue;
    }
    if (char === '\\' && source[pos + 1] === '\n') {
      pos += 2;
      continue;
    }
    if (char === '#') {
      const end = source.indexOf('\n', pos);
      pos = end < 0 ? source.length : end;
      continue;
    }
    if (tokens.length >= maxTokens) throw new ShellParseError('too-large', pos);
    if (char === '\n') {
      tokens.push({ kind: 'newline', offset: pos });
      pos += 1;
      continue;
    }
    REDIRECT.lastIndex = pos;
    const redirect = REDIRECT.exec(source);
    if (redirect !== null) {
      const operator = redirect[1] ?? redirect[2] ?? '';
      if (operator === '<<' || operator === '<<-') throw new ShellParseError('heredoc', pos);
      if (operator === '<(' || operator === '>(') throw new ShellParseError('process-substitution', pos);
      tokens.push({ kind: 'redirect', operator, offset: pos });
      pos += redirect[0].length;
      continue;
    }
    if (source.startsWith('((', pos)) throw new ShellParseError('compound-command', pos);
    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, pos));
    if (operator !== undefined) {
      tokens.push({ kind: 'operator', operator, offset: pos });
      pos += operator.length;
      continue;
    }
    const scanned = scanWord(source, pos);
    tokens.push({ kind: 'word', word: scanned.word, offset: pos });
    pos = scanned.end;
  }
  return tokens;
}

function scanWord(source: string, start: number): { readonly word: ShellWord; readonly end: number } {
  let pos = start;
  let value = '';
  let pattern = '';
  let dynamic = false;
  let expandable = false;
  while (pos < source.length) {
    const char = source[pos]!;
    if (WORD_BREAKS.has(char)) break;
    if (char === '\\') {
      const next = source[pos + 1];
      if (next === undefined) {
        value += char;
        pattern += quoteForPattern(char);
        pos += 1;
      } else {
        if (next !== '\n') {
          value += next;
          pattern += quoteForPattern(next);
        }
        pos += 2;
      }
      continue;
    }
    if (char === "'") {
      const close = source.indexOf("'", pos + 1);
      if (close < 0) throw new ShellParseError('unterminated-quote', pos);
      const quoted = source.slice(pos + 1, close);
      value += quoted;
      pattern += quoteForPattern(quoted);
      pos = close + 1;
      continue;
    }
    if (char === '"') {
      const quoted = scanDoubleQuoted(source, pos);
      value += quoted.value;
      pattern += quoteForPattern(quoted.value);
      dynamic ||= quoted.dynamic;
      pos = quoted.end;
      continue;
    }
    if (char === '`') throw new ShellParseError('command-substitution', pos);
    if (char === '$') {
      pos = scanExpansion(source, pos, false);
      dynamic = true;
      continue;
    }
    if (UNQUOTED_EXPANSIONS.includes(char)) expandable = true;
    value += char;
    pattern += char;
    pos += 1;
  }
  const text = source.slice(start, pos);
  return { word: wordOf(text, value, pattern, dynamic, expandable || text.startsWith('~')), end: pos };
}

function wordOf(text: string, value: string, pattern: string, dynamic: boolean, expandable: boolean): ShellWord {
  if (dynamic) return { text, value: undefined };
  const literal = expandable ? {} : { literal: value };
  if (expandsTildePrefix(text)) return { text, value: undefined };
  if (!DYNAMIC_VALUE.test(value)) return { text, value, ...literal };
  if (NON_GLOB_DYNAMIC_VALUE.test(value)) return { text, value: undefined, ...literal };
  return { text, value: undefined, ...literal, pattern };
}

function quoteForPattern(text: string): string {
  let quoted = '';
  for (const char of text) quoted += GLOB_SPECIAL.includes(char) ? `\\${char}` : char;
  return quoted;
}

function scanDoubleQuoted(
  source: string,
  start: number,
): { readonly value: string; readonly dynamic: boolean; readonly end: number } {
  let pos = start + 1;
  let value = '';
  let dynamic = false;
  while (pos < source.length) {
    const char = source[pos]!;
    if (char === '"') return { value, dynamic, end: pos + 1 };
    if (char === '\\') {
      const next = source[pos + 1];
      if (next === '\n') {
        pos += 2;
      } else if (next !== undefined && DOUBLE_QUOTE_ESCAPES.includes(next)) {
        value += next;
        pos += 2;
      } else {
        value += char;
        pos += 1;
      }
      continue;
    }
    if (char === '`') throw new ShellParseError('command-substitution', pos);
    if (char === '$') {
      pos = scanExpansion(source, pos, true);
      dynamic = true;
      continue;
    }
    value += char;
    pos += 1;
  }
  throw new ShellParseError('unterminated-quote', start);
}

function scanExpansion(source: string, start: number, inDoubleQuotes: boolean): number {
  const next = source[start + 1];
  if (next === '(') throw new ShellParseError('command-substitution', start);
  if (next === '[') throw new ShellParseError('expansion', start);
  if (next === '{') {
    const close = source.indexOf('}', start + 2);
    if (close < 0 || /[`$(){}'"\\\n]/.test(source.slice(start + 2, close))) {
      throw new ShellParseError('expansion', start);
    }
    return close + 1;
  }
  if (!inDoubleQuotes && next === "'") return scanAnsiCString(source, start);
  if (!inDoubleQuotes && next === '"') return scanDoubleQuoted(source, start + 1).end;
  if (next !== undefined && /[A-Za-z_]/.test(next)) {
    let end = start + 2;
    while (end < source.length && /[A-Za-z0-9_]/.test(source[end]!)) end += 1;
    return end;
  }
  if (next !== undefined && /[0-9@*#?$!-]/.test(next)) return start + 2;
  return start + 1;
}

function scanAnsiCString(source: string, start: number): number {
  let pos = start + 2;
  while (pos < source.length) {
    const char = source[pos]!;
    if (char === "'") return pos + 1;
    pos += char === '\\' ? 2 : 1;
  }
  throw new ShellParseError('unterminated-quote', start);
}

function expandsTildePrefix(text: string): boolean {
  return text.startsWith('~') && text !== '~' && !text.startsWith('~/');
}

function parseScript(cursor: Cursor, nested: boolean): ShellScript {
  const statements: ShellStatement[] = [];
  skipNewlines(cursor);
  while (cursor.index < cursor.tokens.length) {
    if (nested && isOperatorToken(cursor.tokens[cursor.index], ')')) break;
    const body = parseAndOr(cursor);
    const token = cursor.tokens[cursor.index];
    const closes = nested && isOperatorToken(token, ')');
    if (token !== undefined && !closes && token.kind !== 'newline' && !isOperator(token, ';') && !isOperator(token, '&')) {
      throw unexpected(token);
    }
    statements.push({ body, background: token !== undefined && isOperator(token, '&') });
    if (!closes) cursor.index += 1;
    skipNewlines(cursor);
  }
  return { statements };
}

function parseAndOr(cursor: Cursor): ShellAndOr {
  const first = parsePipeline(cursor);
  const rest: ShellAndOrLink[] = [];
  for (;;) {
    const token = cursor.tokens[cursor.index];
    if (token?.kind !== 'operator') return { first, rest };
    const operator = token.operator;
    if (operator !== '&&' && operator !== '||') return { first, rest };
    cursor.index += 1;
    skipNewlines(cursor);
    rest.push({ operator, pipeline: parsePipeline(cursor) });
  }
}

function parsePipeline(cursor: Cursor): ShellPipeline {
  let negated = false;
  for (;;) {
    const token = cursor.tokens[cursor.index];
    if (token?.kind !== 'word' || token.word.text !== '!') break;
    negated = !negated;
    cursor.index += 1;
  }
  const commands = [parseCommand(cursor)];
  for (;;) {
    const token = cursor.tokens[cursor.index];
    if (token === undefined || !(isOperator(token, '|') || isOperator(token, '|&'))) return { negated, commands };
    cursor.index += 1;
    skipNewlines(cursor);
    commands.push(parseCommand(cursor));
  }
}

function parseCommand(cursor: Cursor): ShellCommand {
  const first = cursor.tokens[cursor.index];
  if (first !== undefined && isOperator(first, '(')) return parseSubshell(cursor, first.offset);
  const assignments: ShellAssignment[] = [];
  const words: ShellWord[] = [];
  const redirects: ShellRedirect[] = [];
  for (;;) {
    const token = cursor.tokens[cursor.index];
    if (token?.kind === 'redirect') {
      redirects.push(parseRedirect(cursor, token.operator, token.offset));
      continue;
    }
    if (token?.kind !== 'word') break;
    if (words.length === 0) {
      const reserved = RESERVED_WORDS.get(token.word.text);
      if (reserved !== undefined) throw new ShellParseError(reserved, token.offset);
      const assignment = assignmentOf(token.word);
      if (assignment !== undefined) {
        assignments.push(assignment);
        cursor.index += 1;
        continue;
      }
    }
    words.push(token.word);
    cursor.index += 1;
  }
  if (assignments.length === 0 && words.length === 0 && redirects.length === 0) {
    const token = cursor.tokens[cursor.index];
    throw token === undefined ? new ShellParseError('syntax', cursor.length) : unexpected(token);
  }
  return { kind: 'simple', assignments, words, redirects };
}

function parseSubshell(cursor: Cursor, offset: number): ShellSubshell {
  if (cursor.depth >= SHELL_PARSE_MAX_SUBSHELL_DEPTH) throw new ShellParseError('too-large', offset);
  cursor.index += 1;
  cursor.depth += 1;
  const script = parseScript(cursor, true);
  cursor.depth -= 1;
  const close = cursor.tokens[cursor.index];
  if (close === undefined || !isOperator(close, ')') || script.statements.length === 0) {
    throw new ShellParseError('syntax', close?.offset ?? cursor.length);
  }
  cursor.index += 1;
  const redirects: ShellRedirect[] = [];
  for (;;) {
    const token = cursor.tokens[cursor.index];
    if (token?.kind !== 'redirect') return { kind: 'subshell', script, redirects };
    redirects.push(parseRedirect(cursor, token.operator, token.offset));
  }
}

function parseRedirect(cursor: Cursor, operator: string, offset: number): ShellRedirect {
  const target = cursor.tokens[cursor.index + 1];
  if (target?.kind !== 'word') throw new ShellParseError('syntax', offset);
  cursor.index += 2;
  return { operator, target: target.word };
}

function assignmentOf(word: ShellWord): ShellAssignment | undefined {
  const match = ASSIGNMENT.exec(word.text);
  if (match === null) return undefined;
  const prefix = match[0].length;
  return { name: match[1]!, value: { text: word.text.slice(prefix), value: word.value?.slice(prefix) } };
}

function skipNewlines(cursor: Cursor): void {
  while (cursor.tokens[cursor.index]?.kind === 'newline') cursor.index += 1;
}

function isOperator(token: Token, operator: ShellOperator): boolean {
  return token.kind === 'operator' && token.operator === operator;
}

function isOperatorToken(token: Token | undefined, operator: ShellOperator): boolean {
  return token !== undefined && isOperator(token, operator);
}

function unexpected(token: Token): ShellParseError {
  return new ShellParseError('syntax', token.offset);
}
