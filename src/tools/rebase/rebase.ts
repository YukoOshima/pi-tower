import { Type, type Static } from 'typebox';

import { TOWER_PARAMETER_DESCRIPTIONS } from '../../prompts/index.ts';

const DESCRIPTIONS = TOWER_PARAMETER_DESCRIPTIONS.TowerRebase;

export const TowerRebaseToolInputSchema = Type.Object(
  {
    mission: Type.String({ description: DESCRIPTIONS.mission }),
  },
  { additionalProperties: false },
);

export type TowerRebaseToolInput = Static<typeof TowerRebaseToolInputSchema>;
