import { Type, type Static } from 'typebox';

import { TOWER_PARAMETER_DESCRIPTIONS } from '../../prompts/index.ts';

const DESCRIPTIONS = TOWER_PARAMETER_DESCRIPTIONS.TowerTaskOutput;

export const TowerTaskOutputToolInputSchema = Type.Object(
  {
    agent: Type.String({ description: DESCRIPTIONS.agent }),
  },
  { additionalProperties: false },
);

export type TowerTaskOutputToolInput = Static<typeof TowerTaskOutputToolInputSchema>;
