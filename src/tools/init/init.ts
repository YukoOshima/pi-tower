import { Type, type Static } from 'typebox';

import { TOWER_PARAMETER_DESCRIPTIONS } from '../../prompts/index.ts';

const DESCRIPTIONS = TOWER_PARAMETER_DESCRIPTIONS.TowerInit;

export const TowerInitToolInputSchema = Type.Object(
  {
    base: Type.Optional(Type.String({ minLength: 1, description: DESCRIPTIONS.base })),
  },
  { additionalProperties: false },
);

export type TowerInitToolInput = Static<typeof TowerInitToolInputSchema>;
