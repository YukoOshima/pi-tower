import { Type, type Static } from 'typebox';

import { TOWER_PARAMETER_DESCRIPTIONS } from '../../prompts/index.ts';
import { stringEnum } from '../support.ts';

const DESCRIPTIONS = TOWER_PARAMETER_DESCRIPTIONS.TowerSpawn;

export const TowerSpawnToolInputSchema = Type.Object(
  {
    name: Type.String({ description: DESCRIPTIONS.name }),
    kind: stringEnum(['worker', 'reviewer'] as const, DESCRIPTIONS.kind),
    model: Type.Optional(Type.String({ description: DESCRIPTIONS.model })),
    mission_id: Type.Optional(Type.String({ description: DESCRIPTIONS.mission_id })),
    review_target: Type.Optional(Type.String({ description: DESCRIPTIONS.review_target })),
    instructions: Type.Optional(Type.String({ description: DESCRIPTIONS.instructions })),
  },
  { additionalProperties: false },
);

export type TowerSpawnToolInput = Static<typeof TowerSpawnToolInputSchema>;

export function towerSpawnInputProblem(input: TowerSpawnToolInput): string | undefined {
  if (input.kind === 'worker' && (input.mission_id ?? '').trim().length === 0) {
    return 'worker spawns require mission_id';
  }
  if (input.kind === 'reviewer' && (input.review_target ?? '').trim().length === 0) {
    return 'reviewer spawns require review_target';
  }
  return undefined;
}
