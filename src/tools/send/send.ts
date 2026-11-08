import { Type, type Static } from 'typebox';

import { TOWER_PARAMETER_DESCRIPTIONS } from '../../prompts/index.ts';

const DESCRIPTIONS = TOWER_PARAMETER_DESCRIPTIONS.TowerSend;

export const TowerSendToolInputSchema = Type.Object(
  {
    to: Type.String({ description: DESCRIPTIONS.to }),
    subject: Type.String({ description: DESCRIPTIONS.subject }),
    body: Type.String({ description: DESCRIPTIONS.body }),
    scope: Type.Optional(Type.String({ description: DESCRIPTIONS.scope })),
    action: Type.Optional(Type.String({ description: DESCRIPTIONS.action })),
    consent_ref: Type.Optional(Type.String({ description: DESCRIPTIONS.consent_ref })),
  },
  { additionalProperties: false },
);

export type TowerSendToolInput = Static<typeof TowerSendToolInputSchema>;
