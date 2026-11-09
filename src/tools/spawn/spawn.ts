import { Type, type Static } from 'typebox';

import { TOWER_PARAMETER_DESCRIPTIONS } from '../../prompts/index.ts';
import { stringEnum } from '../support.ts';
import { TOWER_VALIDATOR_KINDS, isTowerValidatorKind } from '../validate/validate.ts';

const DESCRIPTIONS = TOWER_PARAMETER_DESCRIPTIONS.TowerSpawn;

export const TowerSpawnToolInputSchema = Type.Object(
  {
    name: Type.String({ description: DESCRIPTIONS.name }),
    kind: stringEnum(['worker', 'reviewer', 'validator'] as const, DESCRIPTIONS.kind),
    model: Type.Optional(Type.String({ description: DESCRIPTIONS.model })),
    mission_id: Type.Optional(Type.String({ description: DESCRIPTIONS.mission_id })),
    review_target: Type.Optional(Type.String({ description: DESCRIPTIONS.review_target })),
    milestone: Type.Optional(Type.String({ description: DESCRIPTIONS.milestone })),
    validation_kind: Type.Optional(stringEnum(TOWER_VALIDATOR_KINDS, DESCRIPTIONS.validation_kind)),
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
  if (input.kind === 'validator') {
    if ((input.milestone ?? '').trim().length === 0 || input.validation_kind === undefined) {
      return 'validator spawns require milestone and validation_kind';
    }
    if (!isTowerValidatorKind(input.validation_kind)) {
      return `validator spawns require validation_kind "scrutiny" or "user-testing", got "${String(input.validation_kind)}" — the commands validation is run by the tower itself, without an agent`;
    }
    if (input.mission_id !== undefined || input.review_target !== undefined) {
      return 'validator spawns take milestone and validation_kind, not mission_id or review_target';
    }
    return undefined;
  }
  if (input.milestone !== undefined || input.validation_kind !== undefined) {
    return 'milestone and validation_kind apply only to validator spawns (kind="validator")';
  }
  return undefined;
}
