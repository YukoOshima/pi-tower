import { createHash } from 'node:crypto';

import { compareIds, sortedMilestones, sortedMissions } from './derive.ts';
import type { AutopilotRound, AutopilotSnapshot } from './types.ts';

export const PROGRESS_KEY_LENGTH = 16;

export function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, PROGRESS_KEY_LENGTH);
}

export function dedupeKey(reason: string, subject: string, revision: string): string {
  return `${reason}:${subject}:${revision}`;
}

export function computeProgressKey(snapshot: AutopilotSnapshot): string {
  const missions = sortedMissions(snapshot.missions)
    .map((mission) => `${mission.id}=${mission.status}@${mission.tip ?? '-'}`)
    .join(',');
  const milestones =
    snapshot.objective === undefined
      ? ''
      : sortedMilestones(snapshot.objective)
          .map(
            (milestone) =>
              `${milestone.id}=${milestone.status}@${milestone.validationCommit ?? '-'}[${roundsKey(milestone.rounds)}]`,
          )
          .join(',');
  return digest(
    [
      `base=${snapshot.baseTip}`,
      `reviews=${String(snapshot.reviewCount)}`,
      `inbox=${String(snapshot.inboxCount)}`,
      `missions=${missions}`,
      `milestones=${milestones}`,
    ].join('|'),
  );
}

function roundsKey(rounds: readonly AutopilotRound[]): string {
  return [...rounds]
    .sort((a, b) => compareIds(a.kind, b.kind) || a.round - b.round)
    .map((round) => `${round.kind}#${String(round.round)}@${round.commit}=${round.verdict}`)
    .join(',');
}
