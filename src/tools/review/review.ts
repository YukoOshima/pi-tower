import { Type, type Static } from 'typebox';

import { TOWER_PARAMETER_DESCRIPTIONS } from '../../prompts/index.ts';
import { stringEnum } from '../support.ts';

const DESCRIPTIONS = TOWER_PARAMETER_DESCRIPTIONS.TowerReview;

export const TOWER_REVIEW_STATUS_PATTERN = '^(clean|p[12]-\\d+items)$';

export const TowerReviewToolInputSchema = Type.Object(
  {
    target: Type.String({ description: DESCRIPTIONS.target }),
    status: Type.String({ pattern: TOWER_REVIEW_STATUS_PATTERN, description: DESCRIPTIONS.status }),
    merge: stringEnum(['merge', 'fix-then-merge', 'hold'] as const, DESCRIPTIONS.merge),
    findings: Type.String({ description: DESCRIPTIONS.findings }),
    checks: Type.Optional(Type.Array(Type.String(), { description: DESCRIPTIONS.checks })),
    decision: Type.String({ description: DESCRIPTIONS.decision }),
  },
  { additionalProperties: false },
);

export type TowerReviewToolInput = Static<typeof TowerReviewToolInputSchema>;
