import { Type, type Static } from 'typebox';

export const TowerStatusToolInputSchema = Type.Object({}, { additionalProperties: false });

export type TowerStatusToolInput = Static<typeof TowerStatusToolInputSchema>;
