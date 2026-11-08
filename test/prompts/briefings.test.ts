import { describe, expect, it } from 'vitest';

import {
  REVIEW_EXCERPT_MAX_CHARS,
  REVIEW_HISTORY_ROUNDS,
  REVIEW_REQUEST_SCAN_LIMIT,
  buildReviewerBriefing,
  buildSpawnBriefing,
  buildWorkerBriefing,
  findReviewRequest,
  reviewHistorySection,
  truncateSection,
  workerHistorySection,
  type BriefingMission,
  type BriefingReview,
  type WorkerBriefingInput,
} from '../../src/prompts/index.ts';
import type { TowerInboxItem } from '../../src/protocol/types.ts';

const REPO = '/work/repo';
const WORKTREE = `${REPO}/.tower/worktrees/wt-1`;

const MISSION_TEXT = [
  '# Mission M1: Docs polish',
  '',
  "## Context — the user's own words, verbatim",
  '',
  'Keep the tone friendly. Do not document internals.',
  '',
  '## Tasks',
  '- [ ] rewrite the intro',
  '',
].join('\n');

const BUILD: BriefingMission = {
  id: 'M1',
  kind: 'build',
  branch: 'feat/docs-polish',
  scope: ['docs/**', 'README.md'],
};

function inboxItem(from: string, subject: string, body: string, index = 0): TowerInboxItem {
  return {
    messageId: `msg-${String(index)}`,
    file: `.tower/comms/inbox/${String(index)}.md`,
    from,
    to: 'tower',
    subject,
    sentAt: `2026-11-08T00:00:${String(index).padStart(2, '0')}.000Z`,
    body,
  };
}

function review(round: number, reviewer: string, body: string): BriefingReview {
  return { round, reviewer, status: 'p2-1items', merge: 'fix-then-merge', body };
}

function worker(overrides: Partial<WorkerBriefingInput> = {}): WorkerBriefingInput {
  return {
    name: 'agent-docs',
    mission: BUILD,
    missionText: MISSION_TEXT,
    worktreePath: WORKTREE,
    repoRoot: REPO,
    base: 'main',
    ...overrides,
  };
}

describe('truncateSection', () => {
  it('keeps short text and cuts long text with a marker', () => {
    expect(truncateSection('abc', 3)).toBe('abc');
    expect(truncateSection('abcd', 3)).toBe('abc\n…(truncated)');
  });

  it('uses the upstream limits', () => {
    expect(REVIEW_EXCERPT_MAX_CHARS).toBe(8000);
    expect(REVIEW_HISTORY_ROUNDS).toBe(5);
    expect(REVIEW_REQUEST_SCAN_LIMIT).toBe(50);
  });
});

describe('findReviewRequest', () => {
  it('returns the newest review-request from the author', () => {
    const inbox = [
      inboxItem('agent-docs', 'status update', 'not this', 3),
      inboxItem('agent-other', 'review-request', 'not this either', 2),
      inboxItem('agent-docs', 'review-request: M1 docs', 'newest', 1),
      inboxItem('agent-docs', 'review-request', 'older', 0),
    ];
    expect(findReviewRequest(inbox, 'agent-docs')?.body).toBe('newest');
    expect(findReviewRequest(inbox, 'agent-missing')).toBeUndefined();
  });

  it('only scans the newest fifty tower messages', () => {
    const noise = Array.from({ length: REVIEW_REQUEST_SCAN_LIMIT }, (_, index) =>
      inboxItem('agent-other', 'chatter', 'noise', index),
    );
    const inbox = [...noise, inboxItem('agent-docs', 'review-request', 'too old', 99)];
    expect(findReviewRequest(inbox, 'agent-docs')).toBeUndefined();
  });
});

describe('buildWorkerBriefing — build missions', () => {
  it('briefs the worker with the mission context and the clarify-first discipline', () => {
    const prompt = buildWorkerBriefing(worker());
    expect(prompt.startsWith('You are "agent-docs", a tower worker agent in a multi-agent workspace.\n\n')).toBe(true);
    expect(prompt).toContain(`# Your mission\n\n${MISSION_TEXT.trim()}\n\n`);
    expect(prompt).toContain("## Context — the user's own words, verbatim");
    expect(prompt).toContain('Keep the tone friendly. Do not document internals.');
    expect(prompt).toContain('Ambiguity is escalated, not guessed');
    expect(prompt).toContain('subject="clarify-request"');
    expect(prompt).toContain('File it with TowerFinding instead of fixing it.');
  });

  it('briefs the worker to read the inbox and re-read its mission before completing', () => {
    const prompt = buildWorkerBriefing(worker());
    expect(prompt).toContain('# When the mission is done');
    expect(prompt).toContain('call TowerInbox once and incorporate anything new into the delivery');
    expect(prompt).toContain('TowerComplete refuses while unread messages wait in your inbox');
    expect(prompt).toContain('Re-read your mission too (TowerMission(id="M1") with no patch fields)');
    expect(prompt).toContain('Call TowerComplete(report=what you changed and why');
    expect(prompt).toContain('do not substitute a TowerMission status patch or a manual TowerSend');
    expect(prompt).not.toContain('Mark the mission completed: TowerMission');
    expect(prompt.endsWith('4. Finish with a structured final summary: files changed, key decisions, open follow-ups.')).toBe(true);
  });

  it('runs the worker inside its worktree', () => {
    const prompt = buildWorkerBriefing(worker());
    expect(prompt).toContain(`# Your workplace\n- Your private git worktree: ${WORKTREE}\n`);
    expect(prompt).toContain('- Your branch: feat/docs-polish (base: main)\n');
    expect(prompt).toContain(
      `- Your working directory is this worktree: relative paths resolve inside it and every bash command starts in it, so build, test, and commit there. A guard hard-denies any write/edit outside it; reads are unrestricted — you may read the main checkout (${REPO}) or another agent's worktree by absolute path when coordination calls for it.\n`,
    );
    expect(prompt).toContain('- Scope — the only files you may change: docs/**, README.md\n\n');
    expect(prompt).not.toContain('NOT your worktree');
    expect(prompt).not.toContain('`cd ');
  });

  it('describes a spawn-time WIP snapshot only when one exists', () => {
    expect(buildWorkerBriefing(worker())).not.toContain('snapshot commit');
    const prompt = buildWorkerBriefing(
      worker({ mission: { ...BUILD, spawnBase: '0123456789abcdef' } }),
    );
    expect(prompt).toContain(
      "- Your branch starts from snapshot commit 0123456: the base checkout's uncommitted changes (WIP)",
    );
    expect(prompt).toContain('never revert, amend, or claim it as your own work');
  });

  it('appends extra tower instructions only when they carry text', () => {
    expect(buildWorkerBriefing(worker({ instructions: '  \n ' }))).not.toContain(
      '# Additional instructions from the tower',
    );
    expect(buildWorkerBriefing(worker({ instructions: '  Use the fixtures.  ' }))).toMatch(
      /open follow-ups\.\n\n# Additional instructions from the tower\nUse the fixtures\.$/,
    );
  });
});

describe('workerHistorySection', () => {
  const latest: BriefingReview = {
    round: 1,
    reviewer: 'rev',
    status: 'p1-2items',
    merge: 'fix-then-merge',
    body: '  the kernel leaks memory\n\nfix the leak first  ',
  };
  const inbox = [inboxItem('agent-build', 'review-request', 'Built the kernel; all tasks ticked.')];
  const respawn = { ...BUILD, owner: 'agent-build' };

  it('briefs a respawned worker with the latest review round and the predecessor review-request', () => {
    const prompt = buildWorkerBriefing(
      worker({ name: 'agent-build-2', mission: respawn, latestReview: latest, towerInbox: inbox }),
    );
    expect(prompt).toContain('# Previous work on this branch');
    expect(prompt).toContain('continue from its work instead of starting over');
    expect(prompt).toContain(
      'Latest review — round 1 by rev: p1-2items, merge verdict "fix-then-merge"\n\nthe kernel leaks memory\n\nfix the leak first\n\n',
    );
    expect(prompt).toContain("The previous worker's review-request to the tower");
    expect(prompt).toContain('Built the kernel; all tasks ticked.');
    expect(prompt.indexOf('# Previous work on this branch')).toBeLessThan(
      prompt.indexOf('# Communication protocol'),
    );
  });

  it('briefs a respawned worker with the predecessor review-request even before any review landed', () => {
    const section = workerHistorySection({ name: 'agent-build-2', mission: respawn, towerInbox: inbox });
    expect(section).toContain('# Previous work on this branch');
    expect(section).toContain('Built the kernel; all tasks ticked.');
    expect(section).not.toContain('Latest review');
  });

  it('omits the history section for a first-time worker spawn', () => {
    expect(workerHistorySection({ name: 'agent-docs', mission: BUILD })).toBe('');
    expect(buildWorkerBriefing(worker())).not.toContain('# Previous work on this branch');
  });

  it('ignores the review-request of the worker being briefed', () => {
    const section = workerHistorySection({ name: 'agent-build', mission: respawn, towerInbox: inbox });
    expect(section).toBe('');
  });

  it('truncates long review excerpts and review-requests at 8000 characters', () => {
    const section = workerHistorySection({
      name: 'agent-build-2',
      mission: respawn,
      latestReview: { ...latest, body: 'r'.repeat(REVIEW_EXCERPT_MAX_CHARS + 1) },
      towerInbox: [inboxItem('agent-build', 'review-request', 'q'.repeat(REVIEW_EXCERPT_MAX_CHARS + 5))],
    });
    expect(section).toContain(`${'r'.repeat(REVIEW_EXCERPT_MAX_CHARS)}\n…(truncated)`);
    expect(section).toContain(`${'q'.repeat(REVIEW_EXCERPT_MAX_CHARS)}\n…(truncated)`);
    expect(section).not.toContain('r'.repeat(REVIEW_EXCERPT_MAX_CHARS + 1));
  });
});

describe('buildWorkerBriefing — survey missions', () => {
  const survey: BriefingMission = { id: 'M3', kind: 'survey', branch: 'feat/scan-apis', scope: ['src/**'] };

  it('briefs the survey worker to read the inbox before completing', () => {
    const prompt = buildWorkerBriefing(worker({ name: 'agent-scan', mission: survey }));
    expect(prompt).toContain(
      'You are "agent-scan", a tower worker agent in a multi-agent workspace, assigned a READ-ONLY survey mission.',
    );
    expect(prompt).toContain('# When the survey is done');
    expect(prompt).toContain('Call TowerInbox once and fold anything new into your summary');
    expect(prompt).toContain('Call TowerComplete(report=the full survey result)');
    expect(prompt).not.toContain('subject="survey-summary"');
    expect(prompt).toContain('your branch must end with zero commits');
    expect(prompt).toContain('if the mission leaves substantive doubt about what to investigate');
  });

  it('marks the scope as read-only and keeps the worktree as working directory', () => {
    const prompt = buildWorkerBriefing(worker({ name: 'agent-scan', mission: survey }));
    expect(prompt).toContain('- Scope — what you investigate (read-only; reserves nothing): src/**\n\n');
    expect(prompt).toContain('- Your working directory is this worktree');
    expect(prompt).not.toContain('the only files you may change');
  });

  it('carries no history section', () => {
    const prompt = buildWorkerBriefing(
      worker({ name: 'agent-scan', mission: { ...survey, owner: 'agent-old' }, latestReview: review(1, 'rev', 'x') }),
    );
    expect(prompt).not.toContain('# Previous work on this branch');
  });
});

describe('buildReviewerBriefing', () => {
  const base = {
    name: 'reviewer-a',
    target: 'feat/docs-polish',
    reviewBase: 'main',
    repoRoot: REPO,
  };

  it('briefs the reviewer with the mission text and the worker self-report', () => {
    const prompt = buildReviewerBriefing({
      ...base,
      missionText: MISSION_TEXT,
      author: 'agent-docs',
      towerInbox: [
        inboxItem('agent-docs', 'review-request', 'Rewrote the intro; tone kept friendly, internals left out.'),
      ],
    });
    expect(prompt).toContain('# Mission under review');
    expect(prompt).toContain('# Mission M1: Docs polish');
    expect(prompt).toContain('- [ ] rewrite the intro');
    expect(prompt).toContain('Keep the tone friendly. Do not document internals.');
    expect(prompt).toContain("# The author's own account");
    expect(prompt).toContain('Rewrote the intro; tone kept friendly, internals left out.');
    expect(prompt).toContain('1. Intent');
    expect(prompt).toContain('Standard review-result notifications are stored automatically');
    expect(prompt).not.toContain('Notify the author with TowerSend');
  });

  it('works read-only in the main checkout against the review base', () => {
    const prompt = buildReviewerBriefing({ ...base, reviewBase: 'abc1234' });
    expect(prompt.startsWith('You are "reviewer-a", a tower reviewer agent in a multi-agent workspace.\n\n')).toBe(true);
    expect(prompt).toContain('Review branch "feat/docs-polish" against base "abc1234".');
    expect(prompt).toContain(
      `- Work read-only in the main checkout (${REPO}): \`git diff abc1234...feat/docs-polish\`, \`git log abc1234..feat/docs-polish\`, and read files as needed.\n- Do NOT modify any code.`,
    );
    expect(prompt).toContain(
      '1. Submit your verdict with TowerReview: { target: "feat/docs-polish", status: "clean" | "p1-Nitems" | "p2-Nitems", merge: "merge" | "fix-then-merge" | "hold", findings, checks, decision }.',
    );
    expect(prompt).toContain('Only a clean review with merge verdict "merge" on the exact branch tip lets the tower merge.');
  });

  it('falls back to the generic checklist when the review target owns no mission', () => {
    const prompt = buildReviewerBriefing(base);
    expect(prompt).not.toContain('# Mission under review');
    expect(prompt).not.toContain("# The author's own account");
    expect(prompt).toContain('1. Security\n2. Data integrity');
    expect(prompt).not.toContain('Intent');
  });

  it('briefs the reviewer with the branch review history', () => {
    const prompt = buildReviewerBriefing({
      ...base,
      reviews: [review(1, 'rev-1', 'rename the helper\n\nsmall fix needed')],
    });
    expect(prompt).toContain('# Review history on this branch');
    expect(prompt).toContain('Round 1 by rev-1: p2-1items, merge verdict "fix-then-merge"');
    expect(prompt).toContain('rename the helper');
    expect(prompt).toContain('small fix needed');
    expect(prompt).not.toContain('omitted');
  });

  it('omits the review history section for the first review round', () => {
    expect(buildReviewerBriefing(base)).not.toContain('# Review history on this branch');
    expect(reviewHistorySection([])).toBe('');
  });

  it('keeps only the five latest rounds and points to the full record', () => {
    const rounds = Array.from({ length: 7 }, (_, index) =>
      review(index + 1, `rev-${String(index + 1)}`, `finding-${String(index + 1)}`),
    );
    const section = reviewHistorySection(rounds);
    expect(section).toContain(
      '(2 earlier round(s) omitted — the full record lives in .tower/comms/reviews/.)',
    );
    expect(section).not.toContain('Round 1 by');
    expect(section).not.toContain('Round 2 by');
    for (let round = 3; round <= 7; round += 1) {
      expect(section).toContain(`## Round ${String(round)} by rev-${String(round)}`);
      expect(section).toContain(`finding-${String(round)}`);
    }
    expect(section.endsWith('finding-7\n\n')).toBe(true);
  });

  it('appends extra tower instructions after the closing step', () => {
    expect(buildReviewerBriefing({ ...base, instructions: 'Focus on the parser.' })).toMatch(
      /Then finish with a structured summary of the review\.\n\n# Additional instructions from the tower\nFocus on the parser\.$/,
    );
  });
});

describe('buildSpawnBriefing', () => {
  it('dispatches on the spawn kind', () => {
    expect(buildSpawnBriefing({ kind: 'worker', ...worker() })).toBe(buildWorkerBriefing(worker()));
    const reviewer = { name: 'reviewer-a', target: 'feat/x', reviewBase: 'main', repoRoot: REPO };
    expect(buildSpawnBriefing({ kind: 'reviewer', ...reviewer })).toBe(buildReviewerBriefing(reviewer));
  });
});
