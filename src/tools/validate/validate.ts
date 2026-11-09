import { Type, type Static } from 'typebox';

import { TOWER_PARAMETER_DESCRIPTIONS } from '../../prompts/index.ts';
import { stringEnum } from '../support.ts';

const DESCRIPTIONS = TOWER_PARAMETER_DESCRIPTIONS.TowerValidate;

export const TOWER_VALIDATOR_KINDS = ['scrutiny', 'user-testing'] as const;

export type TowerValidatorKind = (typeof TOWER_VALIDATOR_KINDS)[number];

export const TowerValidateToolInputSchema = Type.Object(
  {
    milestone: Type.String({ description: DESCRIPTIONS.milestone }),
    kind: stringEnum(TOWER_VALIDATOR_KINDS, DESCRIPTIONS.kind),
    verdict: stringEnum(['pass', 'fail'] as const, DESCRIPTIONS.verdict),
    failures: Type.Optional(Type.Array(Type.String(), { description: DESCRIPTIONS.failures })),
    checks: Type.Optional(Type.Array(Type.String(), { description: DESCRIPTIONS.checks })),
    evidence: Type.String({ description: DESCRIPTIONS.evidence }),
  },
  { additionalProperties: false },
);

export type TowerValidateToolInput = Static<typeof TowerValidateToolInputSchema>;

export const TOWER_VALIDATE_VALIDATORS_ONLY =
  'TowerValidate is for validators only — the tower never reports a scrutiny or user-testing verdict itself: those come from the validator agents spawned for a validating milestone (TowerSpawn kind="validator"), and the mechanical commands validation is recorded by the tower code, not through this tool';

export function isTowerValidatorKind(kind: string): kind is TowerValidatorKind {
  return (TOWER_VALIDATOR_KINDS as readonly string[]).includes(kind);
}

export function towerValidateInputProblem(input: TowerValidateToolInput): string | undefined {
  const kind = input.kind as string;
  if (!isTowerValidatorKind(kind)) {
    return `TowerValidate kind must be scrutiny | user-testing, got "${kind}" — the commands validation is recorded by the tower itself`;
  }
  const verdict = input.verdict as string;
  if (verdict !== 'pass' && verdict !== 'fail') {
    return `TowerValidate verdict must be pass | fail, got "${verdict}"`;
  }
  return undefined;
}
