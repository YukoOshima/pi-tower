import { truncateToWidth, type Component } from '@earendil-works/pi-tui';

import type { TowerResolvedModel, TowerResolvedModels } from '../config/index.ts';
import { formatDuration, formatUsd } from '../prompts/objectiveFormat.ts';
import {
  FEATURE_STATUS_MARKERS,
  MILESTONE_STATUS_MARKERS,
  OBJECTIVE_STATUS_MARKERS,
} from '../prompts/objectiveStatus.ts';
import {
  currentMilestone,
  sortedMilestones,
  type TowerMilestone,
  type TowerMission,
  type TowerMissionStatus,
  type TowerObjective,
  type TowerRosterEntry,
} from '../protocol/index.ts';
import { MISSION_PANEL_LINE_MAX_CHARS, MISSION_PANEL_MAX_LINES } from './constants.ts';
import { count, preview } from './texts.ts';

export interface MissionPanelInput {
  readonly objective: TowerObjective;
  readonly missions: readonly TowerMission[];
  readonly agents: readonly TowerRosterEntry[];
  readonly models?: TowerResolvedModels;
  readonly maxRunningAgents: number;
  readonly nowMs: number;
}

const MILESTONE_STRIP_MAX = 5;

const FEATURE_ORDER: Readonly<Record<TowerMissionStatus, number>> = {
  active: 0,
  completed: 1,
  blocked: 2,
  paused: 3,
  planned: 4,
  merged: 5,
  abandoned: 6,
};

export function renderMissionPanel(input: MissionPanelInput): string[] {
  const { objective } = input;
  const current = currentMilestone(objective);
  const fixed = [
    headline(input),
    milestoneStrip(input, current),
    agentsLine(input),
    ...(input.models === undefined ? [] : [modelsLine(input.models)]),
    `next: ${nextStep(input, current)}`,
  ];
  const features = current === undefined ? [] : featureLines(input, current, MISSION_PANEL_MAX_LINES - fixed.length);
  const [first = '', strip = '', ...rest] = fixed;
  return [first, strip, ...features, ...rest].map(clip);
}

export function missionPanelComponent(lines: readonly string[]): Component {
  return {
    render: (width) => lines.map((line) => ` ${truncateToWidth(line, Math.max(1, width - 2))}`),
    invalidate: () => undefined,
  };
}

export function renderMissionStatus(input: MissionPanelInput): string {
  const { objective } = input;
  const current = currentMilestone(objective);
  const parts = [`mission ${objective.id} ${statusLabel(objective)}`];
  if (current !== undefined && objective.status !== 'completed') {
    const features = featuresOf(input, current.id);
    const merged = features.filter((feature) => feature.status === 'merged').length;
    parts.push(features.length === 0 ? current.id : `${current.id} ${String(merged)}/${String(features.length)} merged`);
  }
  if (input.agents.length > 0) parts.push(count(input.agents.length, 'agent'));
  return parts.join(' · ');
}

function headline(input: MissionPanelInput): string {
  const { objective } = input;
  const facts = [
    `${OBJECTIVE_STATUS_MARKERS[objective.status]} Mission ${objective.id} ${preview(objective.title, 48)}`,
    statusLabel(objective),
  ];
  const started = parseTime(objective.startedAt);
  const maxCost = objective.limits.maxCostUsd;
  if (started === undefined) {
    facts.push('not started');
    if (maxCost !== undefined) facts.push(`budget ${formatUsd(maxCost)}`);
    return facts.join(' · ');
  }
  const ended = parseTime(objective.completedAt) ?? input.nowMs;
  const maxWall = objective.limits.maxWallTimeMs;
  facts.push(`${formatDuration(ended - started)}${maxWall === undefined ? '' : ` of ${formatDuration(maxWall)}`}`);
  facts.push(`${formatUsd(objective.usage?.costUsd ?? 0)}${maxCost === undefined ? '' : ` of ${formatUsd(maxCost)}`}`);
  return facts.join(' · ');
}

function milestoneStrip(input: MissionPanelInput, current: TowerMilestone | undefined): string {
  const milestones = sortedMilestones(input.objective);
  if (milestones.length === 0) return 'milestones: none yet';
  const items = milestones.map((milestone) => {
    const label = `${MILESTONE_STATUS_MARKERS[milestone.status]} ${milestone.id} ${preview(milestone.title, 24)}`;
    if (milestone.id !== current?.id || input.objective.status === 'completed') return label;
    const features = featuresOf(input, milestone.id);
    if (features.length === 0) return label;
    const merged = features.filter((feature) => feature.status === 'merged').length;
    return `${label} (${String(merged)}/${String(features.length)} merged)`;
  });
  if (items.length <= MILESTONE_STRIP_MAX) return items.join('   ');
  const at =
    current === undefined
      ? milestones.length - 1
      : Math.max(0, milestones.findIndex((milestone) => milestone.id === current.id));
  const start = Math.min(Math.max(0, at - 1), items.length - MILESTONE_STRIP_MAX);
  const end = start + MILESTONE_STRIP_MAX;
  return [
    ...(start > 0 ? [`… ${String(start)} earlier`] : []),
    ...items.slice(start, end),
    ...(end < items.length ? [`… ${String(items.length - end)} more`] : []),
  ].join('   ');
}

function featureLines(input: MissionPanelInput, current: TowerMilestone, room: number): string[] {
  const features = [...featuresOf(input, current.id)].sort(
    (a, b) => FEATURE_ORDER[a.status] - FEATURE_ORDER[b.status] || idNumber(a.id) - idNumber(b.id),
  );
  if (room <= 0) return [];
  if (features.length === 0) return [`no features planned for ${current.id} yet`];
  if (features.length <= room) return features.map((feature) => featureLine(input, feature));
  const shown = features.slice(0, Math.max(0, room - 1));
  return [
    ...shown.map((feature) => featureLine(input, feature)),
    `… ${count(features.length - shown.length, 'more feature')} — /mission shows all`,
  ];
}

function featureLine(input: MissionPanelInput, feature: TowerMission): string {
  return `${FEATURE_STATUS_MARKERS[feature.status]} ${feature.id} ${preview(feature.title, 40)} — ${featureState(input, feature)}`;
}

function featureState(input: MissionPanelInput, feature: TowerMission): string {
  const worker = input.agents.find((agent) => agent.kind === 'worker' && agent.missionId === feature.id);
  const reviewer = input.agents.find((agent) => agent.kind === 'reviewer' && agent.reviewMissionId === feature.id);
  const facts: string[] = [];
  switch (feature.status) {
    case 'planned': {
      const waiting = feature.deps.filter((dep) => {
        const status = input.missions.find((mission) => mission.id === dep)?.status;
        return status !== 'merged' && status !== 'abandoned';
      });
      facts.push(waiting.length > 0 ? `waits for ${waiting.join(', ')}` : 'queued');
      break;
    }
    case 'active':
      facts.push(worker === undefined ? 'active' : `worker ${worker.name} running`);
      break;
    case 'completed':
      facts.push(reviewer === undefined ? 'awaiting review' : `in review · ${reviewer.name}`);
      break;
    default:
      facts.push(feature.status);
  }
  if (feature.origin === 'fix') facts.push('fix');
  if (feature.attempts !== undefined && feature.attempts > 1) facts.push(`attempt ${String(feature.attempts)}`);
  return facts.join(' · ');
}

function agentsLine(input: MissionPanelInput): string {
  const kinds = (kind: TowerRosterEntry['kind'], noun: string): string =>
    count(input.agents.filter((agent) => agent.kind === kind).length, noun);
  return `agents: ${kinds('worker', 'worker')} · ${kinds('reviewer', 'reviewer')} · ${kinds('validator', 'validator')} running · limit ${String(input.maxRunningAgents)}`;
}

function modelsLine(models: TowerResolvedModels): string {
  const { orchestrator, worker, reviewer, validator } = models.roles;
  const validatorText =
    validator.origin.kind === 'inherited' ? `= ${validator.origin.from}` : shortModel(validator);
  return `models: orchestrator ${shortModel(orchestrator)} · worker ${shortModel(worker)} · reviewer ${shortModel(reviewer)} · validator ${validatorText}`;
}

function shortModel(resolved: TowerResolvedModel): string {
  return resolved.binding?.modelId ?? '(none)';
}

function nextStep(input: MissionPanelInput, current: TowerMilestone | undefined): string {
  const { objective } = input;
  switch (objective.status) {
    case 'planning':
      return "answer the orchestrator's questions — it drafts the mission and proposes a plan";
    case 'awaiting-approval':
      return 'approve with /mission approve, or tell the orchestrator what to change';
    case 'paused':
      return `paused${objective.pausedReason === undefined ? '' : ` (${preview(objective.pausedReason, 60)})`} — /mission resume continues`;
    case 'blocked':
      return `blocked${objective.blockedReason === undefined ? '' : ` (${preview(objective.blockedReason, 60)})`} — /mission resume, or a new goal with /mission <goal>`;
    case 'completed':
      return 'done — /mission starts a new mission';
    case 'executing':
      return executingStep(input, current);
  }
}

function executingStep(input: MissionPanelInput, current: TowerMilestone | undefined): string {
  if (current === undefined) return 'final validation passed — the mission completes';
  switch (current.status) {
    case 'failed':
      return `${current.id} failed validation — the orchestrator plans fixes`;
    case 'blocked':
      return `${current.id} is blocked — tell the orchestrator how to continue`;
    case 'validating':
      return `validating ${current.id}`;
    case 'pending':
      return `${current.id} starts next`;
    default: {
      const features = featuresOf(input, current.id);
      const open = features.filter((feature) => feature.status !== 'merged' && feature.status !== 'abandoned');
      if (features.length === 0) return `the orchestrator plans the features of ${current.id}`;
      if (open.length === 0) return `validation of ${current.id} starts`;
      return `${count(open.length, 'feature')} of ${current.id} in flight — validation starts once all are merged`;
    }
  }
}

function statusLabel(objective: TowerObjective): string {
  return objective.status.replace('-', ' ');
}

function featuresOf(input: MissionPanelInput, milestoneId: string): TowerMission[] {
  return input.missions.filter((mission) => mission.milestone === milestoneId);
}

function parseTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function idNumber(id: string): number {
  const parsed = Number.parseInt(id.replace(/^\D+/, ''), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function clip(line: string): string {
  return line.length > MISSION_PANEL_LINE_MAX_CHARS ? `${line.slice(0, MISSION_PANEL_LINE_MAX_CHARS - 1)}…` : line;
}
