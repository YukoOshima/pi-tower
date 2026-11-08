import { Type, type Static } from 'typebox';

import { TOWER_PARAMETER_DESCRIPTIONS } from '../../prompts/index.ts';

const DESCRIPTIONS = TOWER_PARAMETER_DESCRIPTIONS.TowerTaskStop;

export const TowerTaskStopToolInputSchema = Type.Object(
  {
    agent: Type.String({ description: DESCRIPTIONS.agent }),
    reason: Type.Optional(Type.String({ description: DESCRIPTIONS.reason })),
  },
  { additionalProperties: false },
);

export type TowerTaskStopToolInput = Static<typeof TowerTaskStopToolInputSchema>;
