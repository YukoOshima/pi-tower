import type {
  PromptMilestoneValidationSpec,
  PromptValidationKind,
  PromptValidationRound,
} from './objectiveTypes.ts';

export const VALIDATION_KINDS: readonly PromptValidationKind[] = ['scrutiny', 'user-testing', 'commands'];

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${String(hours)}h ${pad(minutes)}m`;
  if (minutes > 0) return `${String(minutes)}m ${pad(seconds)}s`;
  return `${String(seconds)}s`;
}

export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

export function requiredValidationKinds(
  spec: PromptMilestoneValidationSpec,
  acceptanceCommands: readonly string[] = [],
): PromptValidationKind[] {
  return VALIDATION_KINDS.filter((kind) =>
    kind === 'scrutiny'
      ? spec.scrutiny
      : kind === 'user-testing'
        ? spec.userTesting
        : spec.commands.length + acceptanceCommands.length > 0,
  );
}

export function describeValidation(
  spec: PromptMilestoneValidationSpec,
  acceptanceCommands: readonly string[] = [],
): string {
  const kinds = requiredValidationKinds(spec, acceptanceCommands);
  if (kinds.length === 0) return 'none (passes as soon as its features merge)';
  const commands = [...spec.commands, ...acceptanceCommands].map((command) => `\`${command}\``);
  return kinds
    .map((kind) => (kind === 'commands' ? `commands ${commands.join(', ')}` : kind))
    .join(' · ');
}

export function latestRound(
  rounds: readonly PromptValidationRound[],
  kind: PromptValidationKind,
): PromptValidationRound | undefined {
  return rounds
    .filter((round) => round.kind === kind)
    .reduce<PromptValidationRound | undefined>(
      (latest, round) => (latest === undefined || round.round > latest.round ? round : latest),
      undefined,
    );
}

export function numberedList(items: readonly string[]): string {
  return items.map((item, index) => `${String(index + 1)}. ${item.trim()}`).join('\n');
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
