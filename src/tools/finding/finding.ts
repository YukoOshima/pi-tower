import { Type, type Static } from 'typebox';

import { TOWER_PARAMETER_DESCRIPTIONS } from '../../prompts/index.ts';
import { stringEnum } from '../support.ts';

const DESCRIPTIONS = TOWER_PARAMETER_DESCRIPTIONS.TowerFinding;

export const TowerFindingToolInputSchema = Type.Object(
  {
    type: stringEnum(['bug', 'improve', 'vuln', 'idea'] as const, DESCRIPTIONS.type),
    title: Type.String({ description: DESCRIPTIONS.title }),
    severity: Type.Optional(stringEnum(['low', 'medium', 'high', 'critical'] as const)),
    summary: Type.String({ description: DESCRIPTIONS.summary }),
    location: Type.Optional(Type.String({ description: DESCRIPTIONS.location })),
    details: Type.String({ description: DESCRIPTIONS.details }),
    suggested_fix: Type.String({ description: DESCRIPTIONS.suggested_fix }),
  },
  { additionalProperties: false },
);

export type TowerFindingToolInput = Static<typeof TowerFindingToolInputSchema>;
