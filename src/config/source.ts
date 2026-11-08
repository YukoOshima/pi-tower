import type { TowerConfigSource, TowerModelOrigin } from './types.ts';

export function formatConfigSource(source: TowerConfigSource): string {
  switch (source.kind) {
    case 'flag':
      return `--${source.flag}`;
    case 'env':
      return `env ${source.variable}`;
    case 'file':
      return `${source.path} (${source.scope})`;
  }
}

export function formatModelOrigin(origin: TowerModelOrigin): string {
  switch (origin.kind) {
    case 'session':
      return 'session model';
    case 'inherited':
      return `inherited from ${origin.from}`;
    default:
      return formatConfigSource(origin);
  }
}
