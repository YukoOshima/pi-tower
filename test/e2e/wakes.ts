import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface WakeReference {
  readonly from: string;
  readonly subject: string;
  readonly messageId?: string;
  readonly file?: string;
  readonly sentAt?: string;
  readonly mission?: string;
  readonly line: string;
}

export interface InboxWake {
  readonly references: readonly WakeReference[];
  readonly omitted: number;
  readonly digestMissions: readonly string[];
}

const REFERENCE_LINE = /^- (.+?): "([^"]*)"(?: \((.*)\))?$/;
const DIGEST_LINE = /^- (M\d+): gate=/;

export function parseInboxWake(text: string): InboxWake {
  const lines = text.split('\n');
  const digestAt = lines.indexOf('Gate digest:');
  const body = digestAt < 0 ? lines : lines.slice(0, digestAt);
  const references = body.flatMap((line): WakeReference[] => {
    const match = REFERENCE_LINE.exec(line);
    if (match === null) return [];
    const fields: Record<string, string> = {};
    for (const part of (match[3] ?? '').split(', ')) {
      const eq = part.indexOf('=');
      if (eq > 0) fields[part.slice(0, eq)] = part.slice(eq + 1);
    }
    return [{ from: match[1] ?? '', subject: match[2] ?? '', ...fields, line }];
  });
  return {
    references,
    omitted: Number(/omitted=(\d+)/.exec(lines[0] ?? '')?.[1] ?? 0),
    digestMissions: digestAt < 0 ? [] : lines.slice(digestAt + 1).flatMap((line) => DIGEST_LINE.exec(line)?.[1] ?? []),
  };
}

const BATCHED_WAKE_FIXTURE = [
  '2 new tower inbox messages — 2 reference(s), omitted=0. Read and route with TowerInbox; this wake does not acknowledge them.',
  '- agent-four: "review-request" (messageId=msg-m2, file=.tower/comms/inbox/20261109-agent-four-tower-review-request.md, sentAt=2026-11-08T20:55:34.854Z, mission=M2)',
  '- agent-gamma: "review-request" (messageId=msg-m1, file=.tower/comms/inbox/20261109-agent-gamma-tower-review-request.md, sentAt=2026-11-08T20:55:35.532Z, mission=M1)',
  'Gate digest:',
  '- M2: gate=BLOCKED reasons=worker-busy',
  '- M1: gate=BLOCKED reasons=no-review',
].join('\n');

type RenderInboxWake = (input: {
  readonly items: readonly { readonly from: string; readonly subject: string; readonly messageId?: string; readonly file?: string; readonly sentAt?: string; readonly missionId?: string }[];
  readonly gateDigest?: readonly string[];
}) => string;

function expectBatch(label: string, wake: InboxWake, missions: readonly string[], problems: string[]): void {
  const found = wake.references.filter((reference) => reference.subject === 'review-request').map((reference) => reference.mission);
  for (const mission of missions) {
    if (!found.includes(mission)) problems.push(`${label}: review-request for ${mission} not parsed (got ${found.join(',') || 'none'})`);
    if (!wake.digestMissions.includes(mission)) problems.push(`${label}: gate digest for ${mission} not parsed`);
  }
}

export async function selfCheckWakeParser(checkout: string): Promise<{ readonly ok: boolean; readonly lines: readonly string[] }> {
  const problems: string[] = [];
  const lines: string[] = [];
  expectBatch('batched wake fixture', parseInboxWake(BATCHED_WAKE_FIXTURE), ['M1', 'M2'], problems);
  lines.push('batched wake fixture: two review-requests 0.7s apart in one wake, as in the reviewer-e2e-1 run (ids illustrative)');
  const source = join(checkout, 'src', 'prompts', 'notifications.ts');
  if (existsSync(source)) {
    const { renderInboxWake } = (await import(pathToFileURL(source).href)) as { renderInboxWake: RenderInboxWake };
    const rendered = renderInboxWake({
      items: [
        { from: 'agent-a', subject: 'review-request', messageId: 'id-1', file: '.tower/comms/inbox/a.md', sentAt: '2026-01-01T00:00:00.000Z', missionId: 'M1' },
        { from: 'agent-b', subject: 'review-request', messageId: 'id-2', file: '.tower/comms/inbox/b.md', sentAt: '2026-01-01T00:00:01.000Z', missionId: 'M2' },
        { from: 'agent-c', subject: 'survey-summary', messageId: 'id-3', missionId: 'M3' },
      ],
      gateDigest: ['- M1: gate=BLOCKED reasons=no-review', '- M2: gate=BLOCKED reasons=no-review'],
    });
    const wake = parseInboxWake(rendered);
    expectBatch('product renderInboxWake', wake, ['M1', 'M2'], problems);
    const survey = wake.references.find((reference) => reference.subject === 'survey-summary');
    if (survey?.mission !== 'M3' || survey.messageId !== 'id-3') problems.push('product renderInboxWake: survey-summary reference not parsed');
    if (wake.references.find((reference) => reference.mission === 'M1')?.messageId !== 'id-1') problems.push('product renderInboxWake: messageId not parsed');
    lines.push(`product renderInboxWake from ${source} (3 references in one wake)`);
  } else {
    lines.push(`product formatter ${source} not found — contract case skipped`);
  }
  return { ok: problems.length === 0, lines: problems.length === 0 ? lines : problems };
}
