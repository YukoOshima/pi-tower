import { Type, type Static } from 'typebox';

import { TOWER_PARAMETER_DESCRIPTIONS } from '../../prompts/index.ts';

const DESCRIPTIONS = TOWER_PARAMETER_DESCRIPTIONS.TowerComplete;

export const TowerCompleteToolInputSchema = Type.Object(
  {
    report: Type.String({ description: DESCRIPTIONS.report }),
  },
  { additionalProperties: false },
);

export type TowerCompleteToolInput = Static<typeof TowerCompleteToolInputSchema>;

export const TOWER_COMPLETE_EMPTY_REPORT = 'report must not be empty';
