export function resumeValidatorRefusal(name: string): string {
  return `tower agent "${name}" is a validator — no agent was started; a validator is one-shot: the tower re-runs its round with a fresh validator under a new name — spawn one yourself with TowerSpawn(kind="validator") only to recover a validation-stuck round`;
}
