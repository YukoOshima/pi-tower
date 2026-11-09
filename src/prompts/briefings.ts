import { REVIEWS_DIR } from '../protocol/paths.ts';
import type { TowerInboxItem, TowerMissionKind } from '../protocol/types.ts';
import { buildValidatorBriefing, type ValidatorBriefingInput } from './validatorBriefing.ts';

export const REVIEW_REQUEST_SCAN_LIMIT = 50;
export const REVIEW_HISTORY_ROUNDS = 5;
export const REVIEW_EXCERPT_MAX_CHARS = 8000;

export interface BriefingMission {
  readonly id: string;
  readonly kind: TowerMissionKind;
  readonly branch: string;
  readonly scope: readonly string[];
  readonly spawnBase?: string;
  readonly owner?: string;
}

export interface BriefingReview {
  readonly round: number;
  readonly reviewer: string;
  readonly status: string;
  readonly merge: string;
  readonly body: string;
}

export interface WorkerBriefingInput {
  readonly name: string;
  readonly mission: BriefingMission;
  readonly missionText: string;
  readonly worktreePath: string;
  readonly repoRoot: string;
  readonly base: string;
  readonly instructions?: string;
  readonly latestReview?: BriefingReview;
  readonly towerInbox?: readonly TowerInboxItem[];
}

export interface ReviewerBriefingInput {
  readonly name: string;
  readonly target: string;
  readonly reviewBase: string;
  readonly repoRoot: string;
  readonly missionText?: string;
  readonly author?: string;
  readonly reviews?: readonly BriefingReview[];
  readonly towerInbox?: readonly TowerInboxItem[];
  readonly instructions?: string;
}

export type SpawnBriefingInput =
  | ({ readonly kind: 'worker' } & WorkerBriefingInput)
  | ({ readonly kind: 'reviewer' } & ReviewerBriefingInput)
  | ({ readonly kind: 'validator' } & ValidatorBriefingInput);

export type WorkerHistoryInput = Pick<
  WorkerBriefingInput,
  'name' | 'mission' | 'latestReview' | 'towerInbox'
>;

export function truncateSection(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…(truncated)`;
}

export function findReviewRequest(
  towerInbox: readonly TowerInboxItem[],
  author: string,
): TowerInboxItem | undefined {
  return towerInbox
    .slice(0, REVIEW_REQUEST_SCAN_LIMIT)
    .find((item) => item.from === author && item.subject.startsWith('review-request'));
}

export function buildSpawnBriefing(input: SpawnBriefingInput): string {
  if (input.kind === 'validator') return buildValidatorBriefing(input);
  return input.kind === 'worker' ? buildWorkerBriefing(input) : buildReviewerBriefing(input);
}

export function buildWorkerBriefing(input: WorkerBriefingInput): string {
  const { name, mission } = input;
  const extra = additionalInstructions(input.instructions);
  const workplace = workplaceSection(input);
  if (mission.kind === 'survey') {
    return (
      `You are "${name}", a tower worker agent in a multi-agent workspace, assigned a READ-ONLY survey mission.\n\n` +
      workplace +
      `# Your mission\n\n${input.missionText.trim()}\n\n` +
      `# Read-only discipline\n` +
      '- Your scope marks what you investigate, not what you may change. You MUST NOT modify, add, or delete any file in the repo, and your branch must end with zero commits — a changed file makes the merge gate reject your mission as a read-only violation.\n' +
      '- Your deliverables are knowledge: record findings as TowerMission notes, send summaries to the tower and to dependent agents with TowerSend, and file TowerFinding for out-of-scope discoveries.\n\n' +
      `# Communication protocol\n` +
      '- Ambiguity is escalated, not guessed: if the mission leaves substantive doubt about what to investigate, TowerSend(to="tower", subject="clarify-request", body=what needs pinning down) BEFORE acting — the tower relays to the human; you never ask the user directly.\n\n' +
      `# When the survey is done\n` +
      '1. Call TowerInbox once and fold anything new into your summary — TowerComplete refuses while unread messages wait in your inbox.\n' +
      '2. Call TowerComplete(report=the full survey result). It records completed and stores survey-summary to the tower in one protocol flow — do not substitute a TowerMission status patch or a manual TowerSend.\n' +
      '3. Finish with a structured final summary: what you covered, key facts with file:line references, open questions.' +
      extra
    );
  }
  return (
    `You are "${name}", a tower worker agent in a multi-agent workspace.\n\n` +
    workplace +
    `# Your mission\n\n${input.missionText.trim()}\n\n` +
    workerHistorySection(input) +
    `# Communication protocol\n` +
    '- Found something notable outside your scope? File it with TowerFinding instead of fixing it.\n' +
    '- Keep your mission current with TowerMission: task_done as you finish tasks, note for decisions, blocker when stuck.\n' +
    '- Ambiguity is escalated, not guessed: if the mission and its Context leave substantive doubt about what to build, TowerSend(to="tower", subject="clarify-request", body=what needs pinning down) BEFORE acting — the tower relays to the human; you never ask the user directly.\n\n' +
    `# When the mission is done\n` +
    "1. `git add` + `git commit` your mission's changes in the worktree (source files only — no build outputs).\n" +
    `2. Before completing, call TowerInbox once and incorporate anything new into the delivery — TowerComplete refuses while unread messages wait in your inbox. Re-read your mission too (TowerMission(id="${mission.id}") with no patch fields): the tower may have changed its tasks mid-flight.\n` +
    '3. Call TowerComplete(report=what you changed and why, reconciled against the mission tasks item by item — the reviewer maps each task to your diff). It records completed and stores review-request to the tower in one protocol flow — do not substitute a TowerMission status patch or a manual TowerSend.\n' +
    '4. Finish with a structured final summary: files changed, key decisions, open follow-ups.' +
    extra
  );
}

export function buildReviewerBriefing(input: ReviewerBriefingInput): string {
  const { name, target, reviewBase } = input;
  const missionSection =
    input.missionText !== undefined
      ? `# Mission under review — verify the diff against this intent, not only against code health\n\n${input.missionText.trim()}\n\n`
      : '';
  const reviewRequest =
    input.author !== undefined ? findReviewRequest(input.towerInbox ?? [], input.author) : undefined;
  const selfReportSection =
    reviewRequest !== undefined
      ? `# The author's own account (their review-request to the tower)\n${reviewRequest.body.trim()}\n\n`
      : '';
  const checklist =
    input.missionText !== undefined
      ? '1. Intent — does the diff deliver the mission above? Map every task to the changes; healthy code that answers the wrong requirement or silently drops a task is a finding, not a pass.\n2. Security\n3. Data integrity\n4. Performance\n5. Error handling\n6. Code quality\n\n'
      : '1. Security\n2. Data integrity\n3. Performance\n4. Error handling\n5. Code quality\n\n';
  return (
    `You are "${name}", a tower reviewer agent in a multi-agent workspace.\n\n` +
    `# Your assignment\n` +
    `Review branch "${target}" against base "${reviewBase}".\n` +
    `- Work read-only in the main checkout (${input.repoRoot}): \`git diff ${reviewBase}...${target}\`, \`git log ${reviewBase}..${target}\`, and read files as needed.\n` +
    '- Do NOT modify any code.\n\n' +
    missionSection +
    selfReportSection +
    reviewHistorySection(input.reviews ?? []) +
    `# Review checklist (in priority order)\n` +
    checklist +
    `# When done — TowerReview is the only mandatory protocol step\n` +
    `1. Submit your verdict with TowerReview: { target: "${target}", status: "clean" | "p1-Nitems" | "p2-Nitems", merge: "merge" | "fix-then-merge" | "hold", findings, checks, decision }. Only a clean review with merge verdict "merge" on the exact branch tip lets the tower merge. Standard review-result notifications are stored automatically — do not send a second manual TowerSend.\n` +
    'Then finish with a structured summary of the review.' +
    additionalInstructions(input.instructions)
  );
}

export function workerHistorySection(input: WorkerHistoryInput): string {
  const { mission, latestReview } = input;
  const predecessor =
    mission.owner !== undefined && mission.owner !== input.name ? mission.owner : undefined;
  const reviewRequest =
    predecessor !== undefined ? findReviewRequest(input.towerInbox ?? [], predecessor) : undefined;
  if (latestReview === undefined && reviewRequest === undefined) return '';
  const parts = [
    '# Previous work on this branch',
    'An earlier worker already ran on this branch — continue from its work instead of starting over, and address the review verdict below rather than re-opening what it already settled.',
  ];
  if (latestReview !== undefined) {
    parts.push(
      `## Latest review — round ${String(latestReview.round)} by ${latestReview.reviewer}: ${latestReview.status}, merge verdict "${latestReview.merge}"`,
      reviewExcerpt(latestReview),
    );
  }
  if (reviewRequest !== undefined) {
    parts.push(
      "## The previous worker's review-request to the tower",
      truncateSection(reviewRequest.body.trim(), REVIEW_EXCERPT_MAX_CHARS),
    );
  }
  return `${parts.join('\n\n')}\n\n`;
}

export function reviewHistorySection(reviews: readonly BriefingReview[]): string {
  if (reviews.length === 0) return '';
  const recent = reviews.slice(-REVIEW_HISTORY_ROUNDS);
  const omitted = reviews.length - recent.length;
  const parts = [
    '# Review history on this branch',
    'Earlier review rounds already ran on this branch — verify their findings against the current tip instead of reporting them again; re-report only what still reproduces.',
  ];
  if (omitted > 0) {
    parts.push(
      `(${String(omitted)} earlier round(s) omitted — the full record lives in ${REVIEWS_DIR}/.)`,
    );
  }
  for (const review of recent) {
    parts.push(
      `## Round ${String(review.round)} by ${review.reviewer}: ${review.status}, merge verdict "${review.merge}"`,
      reviewExcerpt(review),
    );
  }
  return `${parts.join('\n\n')}\n\n`;
}

function workplaceSection(input: WorkerBriefingInput): string {
  const { mission, worktreePath } = input;
  return (
    `# Your workplace\n` +
    `- Your private git worktree: ${worktreePath}\n` +
    `- Your branch: ${mission.branch} (base: ${input.base})\n` +
    (mission.spawnBase !== undefined
      ? `- Your branch starts from snapshot commit ${mission.spawnBase.slice(0, 7)}: the base checkout's uncommitted changes (WIP), captured at spawn so you can build on them. That commit is your foundation — never revert, amend, or claim it as your own work; your own commits go on top of it.\n`
      : '') +
    `- Your working directory is this worktree: relative paths resolve inside it and every bash command starts in it, so build, test, and commit there. A guard hard-denies any write/edit outside it; reads are unrestricted — you may read the main checkout (${input.repoRoot}) or another agent's worktree by absolute path when coordination calls for it.\n` +
    (mission.kind === 'survey'
      ? `- Scope — what you investigate (read-only; reserves nothing): ${mission.scope.join(', ')}\n\n`
      : `- Scope — the only files you may change: ${mission.scope.join(', ')}\n\n`)
  );
}

function reviewExcerpt(review: BriefingReview): string {
  return truncateSection(review.body.trim(), REVIEW_EXCERPT_MAX_CHARS);
}

function additionalInstructions(instructions: string | undefined): string {
  return instructions !== undefined && instructions.trim().length > 0
    ? `\n\n# Additional instructions from the tower\n${instructions.trim()}`
    : '';
}
