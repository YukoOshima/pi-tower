import { Type, type Static } from 'typebox';

import { TOWER_PARAMETER_DESCRIPTIONS } from '../../prompts/index.ts';

const DESCRIPTIONS = TOWER_PARAMETER_DESCRIPTIONS.TowerMerge;

export const TowerMergeToolInputSchema = Type.Object(
  {
    branch: Type.String({ description: DESCRIPTIONS.branch }),
  },
  { additionalProperties: false },
);

export type TowerMergeToolInput = Static<typeof TowerMergeToolInputSchema>;
