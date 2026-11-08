import { Type, type Static } from 'typebox';

import { TOWER_PARAMETER_DESCRIPTIONS } from '../../prompts/index.ts';

const DESCRIPTIONS = TOWER_PARAMETER_DESCRIPTIONS.TowerResume;

export const TowerResumeToolInputSchema = Type.Object(
  {
    agent: Type.String({ description: DESCRIPTIONS.agent }),
    prompt: Type.String({ description: DESCRIPTIONS.prompt }),
  },
  { additionalProperties: false },
);

export type TowerResumeToolInput = Static<typeof TowerResumeToolInputSchema>;
