import { Type, type Static } from 'typebox';

import { TOWER_PARAMETER_DESCRIPTIONS } from '../../prompts/index.ts';

const DESCRIPTIONS = TOWER_PARAMETER_DESCRIPTIONS.TowerTasks;

export const TowerTasksToolInputSchema = Type.Object(
  {
    active_only: Type.Optional(Type.Boolean({ description: DESCRIPTIONS.active_only })),
  },
  { additionalProperties: false },
);

export type TowerTasksToolInput = Static<typeof TowerTasksToolInputSchema>;
