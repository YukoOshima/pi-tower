import { Type, type Static } from 'typebox';

import { TOWER_PARAMETER_DESCRIPTIONS } from '../../prompts/index.ts';
import { stringEnum } from '../support.ts';

const DESCRIPTIONS = TOWER_PARAMETER_DESCRIPTIONS.TowerMission;

export const TowerMissionToolInputSchema = Type.Object(
  {
    id: Type.String({ description: DESCRIPTIONS.id }),
    status: Type.Optional(
      stringEnum(
        ['planned', 'active', 'completed', 'blocked', 'paused', 'merged', 'abandoned'] as const,
        DESCRIPTIONS.status,
      ),
    ),
    note: Type.Optional(Type.String({ description: DESCRIPTIONS.note })),
    blocker: Type.Optional(Type.String({ description: DESCRIPTIONS.blocker })),
    clear_blockers: Type.Optional(Type.Boolean({ description: DESCRIPTIONS.clear_blockers })),
    task_done: Type.Optional(Type.String({ description: DESCRIPTIONS.task_done })),
    task_drop: Type.Optional(Type.String({ description: DESCRIPTIONS.task_drop })),
    task_drop_reason: Type.Optional(Type.String({ description: DESCRIPTIONS.task_drop_reason })),
    scope: Type.Optional(Type.Array(Type.String(), { description: DESCRIPTIONS.scope })),
  },
  { additionalProperties: false },
);

export type TowerMissionToolInput = Static<typeof TowerMissionToolInputSchema>;
