import { TOWER_ROLES } from './modelRef.ts';
import { TOWER_OBJECTIVE_KEYS } from './objective.ts';
import { formatConfigSource, formatModelOrigin } from './source.ts';
import type {
  TowerConfigFileState,
  TowerObjectiveSettings,
  TowerResolvedModel,
  TowerResolvedModels,
} from './types.ts';

export function describeThinking(resolved: TowerResolvedModel): string {
  if (resolved.binding === undefined) return '-';
  const level = resolved.binding.thinkingLevel;
  if (level === undefined) return 'pi default';
  switch (resolved.origin.kind) {
    case 'session':
      return `${level} (session)`;
    case 'inherited':
      return `${level} (inherited from ${resolved.origin.from})`;
    default:
      return `${level} (configured)`;
  }
}

export function describeSpawnModels(models: TowerResolvedModels): string {
  return [
    'Available models (pass via model):',
    spawnChoiceLine('orchestrator (alias primary)', models.roles.orchestrator),
    spawnChoiceLine('worker [worker default]', models.roles.worker),
    spawnChoiceLine('reviewer [reviewer default]', models.roles.reviewer),
    spawnChoiceLine('validator [validator default]', models.roles.validator),
    ...Object.entries(models.pool).map(([alias, resolved]) => spawnChoiceLine(alias, resolved)),
  ].join('\n');
}

export function formatModelTable(models: TowerResolvedModels): string {
  const table = alignColumns([
    ['role', 'model', 'thinking', 'source'],
    ...TOWER_ROLES.map((role) => modelRow(role, models.roles[role])),
    ...Object.entries(models.pool).map(([alias, resolved]) =>
      modelRow(`models.${alias}`, resolved),
    ),
  ]);
  if (models.files.length === 0) return table.join('\n');
  return [...table, '', ...models.files.map(fileLine)].join('\n');
}

export function formatObjectiveSettings(settings: TowerObjectiveSettings): string {
  return alignColumns([
    ['objective', 'value', 'source'],
    ...TOWER_OBJECTIVE_KEYS.map((key) => {
      const { value, source } = settings[key];
      return [
        key,
        value === undefined ? 'unset' : String(value),
        source.kind === 'default' ? 'default' : formatConfigSource(source),
      ];
    }),
  ]).join('\n');
}

function alignColumns(rows: readonly (readonly string[])[]): string[] {
  const columns = Math.max(...rows.map((row) => row.length)) - 1;
  const widths = Array.from({ length: columns }, (_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  return rows.map((row) =>
    row
      .map((cell, column) => (column < widths.length ? cell.padEnd(widths[column]!) : cell))
      .join('  '),
  );
}

function spawnChoiceLine(label: string, resolved: TowerResolvedModel): string {
  const binding = resolved.binding;
  if (binding === undefined) return `- ${label}: no model resolved`;
  const thinking =
    binding.thinkingLevel === undefined
      ? 'pi default thinking'
      : `thinking ${binding.thinkingLevel}`;
  const hint = resolved.description === undefined ? '' : ` — ${resolved.description}`;
  return `- ${label}: ${binding.model}, ${thinking}${hint}`;
}

function modelRow(label: string, resolved: TowerResolvedModel): readonly string[] {
  return [
    label,
    resolved.binding?.model ?? '(none)',
    describeThinking(resolved),
    formatModelOrigin(resolved.origin),
  ];
}

function fileLine(file: TowerConfigFileState): string {
  const status =
    file.status === 'loaded'
      ? 'loaded'
      : file.status === 'missing'
        ? 'not found'
        : 'ignored — project not trusted';
  return `${file.scope} config: ${file.path} (${status})`;
}
