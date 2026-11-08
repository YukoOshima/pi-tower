import { Type, type Static } from 'typebox';

import { TOWER_PARAMETER_DESCRIPTIONS } from '../../prompts/index.ts';

const DESCRIPTIONS = TOWER_PARAMETER_DESCRIPTIONS.TowerTeardown;

export const TowerTeardownToolInputSchema = Type.Object(
  {
    force: Type.Optional(Type.Boolean({ description: DESCRIPTIONS.force })),
    exclude: Type.Optional(Type.Array(Type.String(), { description: DESCRIPTIONS.exclude })),
    dry_run: Type.Optional(Type.Boolean({ description: DESCRIPTIONS.dry_run })),
  },
  { additionalProperties: false },
);

export type TowerTeardownToolInput = Static<typeof TowerTeardownToolInputSchema>;
