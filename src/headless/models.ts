import { TOWER_ROLES } from '../config/modelRef.ts';

export const TOWER_MODELS_COMMAND = '/tower models';

const TABLE_HEADER = /^role {2,}model(?: {2,}|$)/;
const COLUMN_GAP = / {2,}/;
const PROBLEMS_HEADER = 'Problems:';

export function towerModelProblems(reply: string): string[] {
  const lines = reply.split('\n');
  const table = lines.findIndex((line) => TABLE_HEADER.test(line));
  const start = table === -1 ? -1 : lines.indexOf(PROBLEMS_HEADER, table + 1);
  if (start === -1) return [];
  const problems: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim().length === 0) break;
    problems.push(line.replace(/^- /, '').trim());
  }
  return problems;
}

export function towerModelLines(reply: string): string[] | undefined {
  const lines = reply.split('\n');
  const start = lines.findIndex((line) => TABLE_HEADER.test(line));
  if (start === -1) return undefined;
  const header = (lines[start] ?? '').split(COLUMN_GAP);
  const rows = new Map<string, readonly string[]>();
  for (const line of lines.slice(start + 1)) {
    if (line.trim().length === 0) break;
    const cells = line.split(COLUMN_GAP);
    rows.set(cells[0] ?? '', [...cells.slice(0, header.length - 1), cells.slice(header.length - 1).join('  ')]);
  }
  const described: string[] = [];
  for (const role of TOWER_ROLES) {
    const cells = rows.get(role);
    const model = cells?.[1] ?? '';
    if (cells === undefined || model.length === 0) return undefined;
    const details = header.slice(2).flatMap((name, column) => {
      const cell = cells[column + 2] ?? '';
      return cell.length === 0 || cell === '-' ? [] : [`${name}: ${cell}`];
    });
    described.push([`${role} model: ${model}`, ...details].join(' · '));
  }
  return described;
}
