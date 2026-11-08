import { Type, type Static } from 'typebox';

import { TOWER_PARAMETER_DESCRIPTIONS } from '../../prompts/index.ts';

const DESCRIPTIONS = TOWER_PARAMETER_DESCRIPTIONS.TowerInbox;

export const TowerInboxToolInputSchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, description: DESCRIPTIONS.limit })),
    include_read: Type.Optional(Type.Boolean({ description: DESCRIPTIONS.include_read })),
  },
  { additionalProperties: false },
);

export type TowerInboxToolInput = Static<typeof TowerInboxToolInputSchema>;
