import type { TowerAgentKind } from '../protocol/types.ts';

export const WAKE_SUBJECT_PREVIEW_MAX = 120;
export const WAKE_BATCH_LIMIT = 6;
export const WAKE_DIGEST_LIMIT = 4;
export const STEER_SUBJECT_PREVIEW_MAX = 120;
export const AGENT_RESULT_PREVIEW_MAX_CHARS = 8000;

export const TOWER_TEARDOWN_PROMPT =
  'Tear down the tower: call TowerTeardown and report what it did. It refuses to destroy dirty worktrees unless forced.';

export const REVIEWER_SPAWN_GUIDANCE =
  'The reviewer runs detached in the background; its completion arrives as a notification. If it dies, diagnose first: check the death status/reason and task state. A reviewer is one-shot — do not resume it or another roster agent; after diagnosis, spawn a fresh reviewer only if the mission still needs one. A user-stopped reviewer is never replaced.';

export interface InboxWakeItem {
  readonly from: string;
  readonly subject: string;
  readonly messageId?: string;
  readonly file?: string;
  readonly sentAt?: string;
  readonly missionId?: string;
}

export interface InboxWakeInput {
  readonly items: readonly InboxWakeItem[];
  readonly omitted?: number;
  readonly recoveredAt?: string;
  readonly gateDigest?: readonly string[];
  readonly digestOmitted?: number;
}

export interface WakeDigestTargets {
  readonly missionIds: readonly string[];
  readonly omitted: number;
}

export interface WakeGateObservation {
  readonly ready: boolean;
  readonly blocks: readonly { readonly reason: string }[];
  readonly reviewBinding?: string;
}

export type WakeGateDigest =
  | WakeGateObservation
  | 'merged'
  | 'abandoned'
  | 'mission-missing'
  | 'unavailable';

export type TowerAgentEndStatus = 'completed' | 'failed' | 'stopped' | 'timed_out';

export interface TowerAgentNotificationInput {
  readonly name: string;
  readonly agentId: string;
  readonly taskId?: string;
  readonly kind: TowerAgentKind;
  readonly description: string;
  readonly status: TowerAgentEndStatus;
  readonly stopReason?: string;
  readonly stoppedByHuman?: boolean;
  readonly wallTimeMs: number;
  readonly result?: string;
}

export interface SpawnTaskDescriptionInput {
  readonly name: string;
  readonly mission?: { readonly id: string; readonly title: string };
  readonly reviewTarget?: string;
  readonly reviewMissionId?: string;
}

export interface SpawnResultInput {
  readonly name: string;
  readonly kind: TowerAgentKind;
  readonly agentId: string;
  readonly taskId?: string;
  readonly model?: string;
  readonly mission?: {
    readonly id: string;
    readonly title: string;
    readonly branch: string;
    readonly worktreePath: string;
  };
  readonly reviewTarget?: string;
  readonly notes?: readonly string[];
}

export function renderInboxWake(input: InboxWakeInput): string {
  const overflow = Math.max(0, input.items.length - WAKE_BATCH_LIMIT);
  const items = input.items.slice(overflow);
  const omitted = (input.omitted ?? 0) + overflow;
  const count = items.length + omitted;
  const countText =
    count === 1 ? '1 new tower inbox message' : `${String(count)} new tower inbox messages`;
  const lines = [
    `${countText} — ${String(items.length)} reference(s), omitted=${String(omitted)}. Read and route with TowerInbox; this wake does not acknowledge them.`,
  ];
  for (const item of items) {
    const references = [
      item.messageId !== undefined ? `messageId=${item.messageId}` : undefined,
      item.file !== undefined ? `file=${item.file}` : undefined,
      item.sentAt !== undefined ? `sentAt=${item.sentAt}` : undefined,
      item.missionId !== undefined ? `mission=${item.missionId}` : undefined,
    ].filter((reference) => reference !== undefined);
    lines.push(
      `- ${item.from}: "${previewSubject(item.subject, WAKE_SUBJECT_PREVIEW_MAX)}"${references.length > 0 ? ` (${references.join(', ')})` : ''}`,
    );
  }
  if (input.recoveredAt !== undefined) {
    lines.push(
      `⚠️ Tower state was recovered after a loss at ${input.recoveredAt} — missions, roster, and protocol history before that point are gone. Report the loss to the user instead of continuing silently.`,
    );
  }
  const digest = input.gateDigest ?? [];
  const digestOmitted = input.digestOmitted ?? 0;
  if (digest.length > 0 || digestOmitted > 0) {
    lines.push('Gate digest:', ...digest);
    if (digestOmitted > 0) lines.push(`- digest-omitted=${String(digestOmitted)}`);
  }
  return lines.join('\n');
}

export function wakeDigestTargets(items: readonly InboxWakeItem[]): WakeDigestTargets {
  const missionIds = [
    ...new Set(items.slice(-WAKE_BATCH_LIMIT).flatMap((item) => item.missionId ?? [])),
  ];
  return {
    missionIds: missionIds.slice(0, WAKE_DIGEST_LIMIT),
    omitted: Math.max(0, missionIds.length - WAKE_DIGEST_LIMIT),
  };
}

export function formatGateDigestLine(missionId: string, digest: WakeGateDigest): string {
  if (typeof digest === 'string') return `- ${missionId}: gate=${digest}`;
  return digest.ready
    ? `- ${missionId}: gate=READY reasons=none${digest.reviewBinding === undefined ? '' : ` binding=${digest.reviewBinding}`}`
    : `- ${missionId}: gate=BLOCKED reasons=${digest.blocks.map((block) => block.reason).join(',')}`;
}

export function renderSteerPreview(from: string, subject: string): string {
  return `[tower inbox] new message from ${from}: "${previewSubject(subject, STEER_SUBJECT_PREVIEW_MAX)}" — read it now with TowerInbox and act on it before continuing.`;
}

export function sendSteeredNote(to: string): string {
  return `note: ${to} is mid-turn — the message was steered into its running turn; it sees the directive at its next step boundary.`;
}

export function sendUndeliveredNote(to: string, kind: TowerAgentKind): string {
  return kind === 'worker'
    ? `note: ${to} has no running task in this session — the message sits in its inbox until you deliver it with TowerResume(agent="${to}", prompt="...")`
    : `note: ${to} has no running task in this session — the message sits in its inbox; a reviewer is one-shot and is never resumed, so spawn a fresh reviewer if the review still needs this input`;
}

export function formatWallTime(wallTimeMs: number): string {
  return `${(Math.max(0, wallTimeMs) / 1000).toFixed(3)} seconds`;
}

export function agentNotificationBody(input: TowerAgentNotificationInput): string {
  const reason = normalizeReason(input.stopReason);
  const baseLine =
    input.status === 'timed_out'
      ? `${input.description} timed out.`
      : input.status === 'stopped' && input.stoppedByHuman === true
        ? `${input.description} was stopped by user.`
        : reason !== undefined
          ? `${input.description} ${input.status === 'stopped' ? 'was stopped' : input.status}. Reason: ${reason}`
          : input.status === 'stopped'
            ? `${input.description} was stopped.`
            : `${input.description} ${input.status}.`;
  const timed = `Wall time: ${formatWallTime(input.wallTimeMs)}\n${baseLine}`;
  if (input.status === 'completed') return timed;
  return `${timed}\n\n${agentRecoveryGuidance(input)}`;
}

export function renderAgentNotification(input: TowerAgentNotificationInput): string {
  const sourceId = input.taskId ?? input.agentId;
  const lines = [
    `<notification id="task:${escapeXmlAttr(sourceId)}:${input.status}" category="task" type="task.${input.status}" source_kind="tower_agent" source_id="${escapeXmlAttr(sourceId)}" agent_id="${escapeXmlAttr(input.agentId)}" name="${escapeXmlAttr(input.name)}">`,
    `Title: Background ${input.kind} ${input.status}`,
    `Severity: ${input.status === 'completed' ? 'info' : 'warning'}`,
    agentNotificationBody(input),
  ];
  const result = input.result?.trim();
  if (result !== undefined && result.length > 0) lines.push(renderAgentResult(input.name, result));
  lines.push('</notification>');
  return lines.join('\n');
}

export function spawnTaskDescription(input: SpawnTaskDescriptionInput): string {
  if (input.mission !== undefined) {
    return `${input.mission.id} ${input.name}: ${input.mission.title}`;
  }
  return input.reviewMissionId !== undefined
    ? `${input.reviewMissionId} review: ${input.reviewTarget ?? ''}`
    : `review ${input.name}: ${input.reviewTarget ?? ''}`;
}

export function workerSpawnGuidance(name: string): string {
  return `The worker runs detached in the background; its completion arrives as a notification. Use TowerInbox/TowerStatus only when a decision needs them. If it dies, diagnose first: check why it died (the died entry's status/reason, its task state) before reviving. Resume with TowerResume(agent="${name}", prompt="...") or reassign its work only for a transient cause (lost contact, timeout, OOM); a systematic cause (code or environment defect) is fixed or escalated to the human before any revive. A user-stopped worker is never resumed, reassigned, or replaced.`;
}

export function spawnSnapshotNote(spawnBase: string): string {
  return `base snapshot: ${spawnBase.slice(0, 7)} — the base checkout had uncommitted changes; they are committed as the branch's first commit (the checkout itself was left untouched)`;
}

export function worktreeSetupWarning(message: string): string {
  return `worktree setup warning (continuing): ${message}`;
}

export function renderSpawnResult(input: SpawnResultInput): string {
  return [
    `name: ${input.name}`,
    `kind: ${input.kind}`,
    `agent_id: ${input.agentId}`,
    ...(input.taskId !== undefined ? [`task_id: ${input.taskId}`] : []),
    'status: running',
    ...(input.model !== undefined ? [`model: ${input.model}`] : []),
    ...(input.mission !== undefined
      ? [
          `mission: ${input.mission.id} — ${input.mission.title}`,
          `branch: ${input.mission.branch}`,
          `worktree: ${input.mission.worktreePath}`,
        ]
      : [`review_target: ${input.reviewTarget ?? ''}`]),
    ...(input.notes ?? []),
    '',
    input.kind === 'worker' ? workerSpawnGuidance(input.name) : REVIEWER_SPAWN_GUIDANCE,
  ].join('\n');
}

function agentRecoveryGuidance(input: TowerAgentNotificationInput): string {
  if (input.stoppedByHuman === true) {
    return `The human stopped this ${input.kind}, so it is dead by intent: never resume, reassign, or replace it unless the human says otherwise.`;
  }
  if (input.kind === 'reviewer') {
    return 'Diagnose first: check the death status/reason and task state. A reviewer is one-shot — do not resume it or another roster agent; after diagnosis, spawn a fresh reviewer only if the mission still needs one.';
  }
  const taskIdWarning =
    input.taskId !== undefined && input.taskId !== input.agentId
      ? [
          `Use the roster name ("${input.name}") or agent_id ("${input.agentId}"), NOT task_id ("${input.taskId}") — the two ids look alike but TowerResume accepts only a roster name or agent_id.`,
        ]
      : [];
  return [
    'Diagnose first: check why it died (its status/reason above and its task state via TowerTaskOutput) before reviving. Resume it or reassign its work only for a transient cause (lost contact, timeout, OOM); a systematic cause (code or environment defect) is fixed or escalated to the human before any revive.',
    `To recover or continue this worker, call TowerResume(agent="${input.name}", prompt="Pick up where you left off; redo the last tool call if its result was never observed.").`,
    ...taskIdWarning,
    'TowerResume always runs it in the background; its completion arrives as another notification.',
    'The worker retains its full prior context across the restart, but any in-flight tool call lost its result and may need to be redone.',
  ].join('\n');
}

function renderAgentResult(name: string, result: string): string {
  const truncated = result.length > AGENT_RESULT_PREVIEW_MAX_CHARS;
  return [
    `<agent-result chars="${String(result.length)}" truncated="${String(truncated)}">`,
    ...(truncated
      ? [
          `Showing the first ${String(AGENT_RESULT_PREVIEW_MAX_CHARS)} characters of the final message; read the rest with TowerTaskOutput(agent="${escapeXml(name)}").`,
        ]
      : []),
    escapeXml(truncated ? result.slice(0, AGENT_RESULT_PREVIEW_MAX_CHARS) : result),
    '</agent-result>',
  ].join('\n');
}

function previewSubject(subject: string, max: number): string {
  return subject.length > max ? `${subject.slice(0, max)}…` : subject;
}

function normalizeReason(reason: string | undefined): string | undefined {
  const trimmed = reason?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeXmlAttr(text: string): string {
  return escapeXml(text).replaceAll('"', '&quot;');
}
