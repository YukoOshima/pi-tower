export const MAX_DELAY_MS = 2_147_483_647;

export function boundedDelay(ms: number): number {
  return Math.min(Math.max(0, ms), MAX_DELAY_MS);
}
