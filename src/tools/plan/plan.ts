import { Type, type Static } from 'typebox';

import { TOWER_PARAMETER_DESCRIPTIONS } from '../../prompts/index.ts';
import { stringEnum } from '../support.ts';

const DESCRIPTIONS = TOWER_PARAMETER_DESCRIPTIONS.TowerPlan;

export const TowerPlanMissionSchema = Type.Object(
  {
    title: Type.String({ description: DESCRIPTIONS.title }),
    scope: Type.Array(Type.String(), { minItems: 1, description: DESCRIPTIONS.scope }),
    tasks: Type.Optional(Type.Array(Type.String(), { description: DESCRIPTIONS.tasks })),
    context: Type.Optional(Type.String({ description: DESCRIPTIONS.context })),
    deps: Type.Optional(Type.Array(Type.String(), { description: DESCRIPTIONS.deps })),
    kind: Type.Optional(stringEnum(['build', 'survey'] as const, DESCRIPTIONS.kind)),
    milestone: Type.Optional(Type.String({ description: DESCRIPTIONS.milestone })),
    origin: Type.Optional(stringEnum(['plan', 'fix'] as const, DESCRIPTIONS.origin)),
  },
  { additionalProperties: false },
);

export const TowerPlanToolInputSchema = Type.Object(
  {
    missions: Type.Array(TowerPlanMissionSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export type TowerPlanToolInput = Static<typeof TowerPlanToolInputSchema>;
