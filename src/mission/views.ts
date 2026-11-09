import { TOWER_ROLES, type TowerResolvedModel, type TowerResolvedModels, type TowerRole } from '../config/index.ts';
import type { TowerObjective } from '../protocol/index.ts';
import {
  MISSION_GOAL_QUESTION,
  MISSION_LABEL_WIDTH,
  MISSION_MODELS_HINT,
  MISSION_MODELS_NOT_LOADED,
  MISSION_ROLE_LABELS,
  missionBaseLine,
  missionCommandsFor,
  missionModelMissing,
  missionModelSource,
  missionModelsLoadError,
  missionPlanningLine,
  missionPreviousLine,
} from './texts.ts';

export interface MissionModelsView {
  readonly resolved?: TowerResolvedModels;
  readonly loadError?: string;
}

export interface MissionHeaderInput {
  readonly models: MissionModelsView;
  readonly base: string;
  readonly initialized: boolean;
  readonly maxRunningAgents: number;
  readonly previous?: TowerObjective;
}

export interface MissionControlInput {
  readonly models: MissionModelsView;
  readonly objective: TowerObjective;
  readonly statusMarkdown: string;
}

interface ModelCell {
  readonly label: string;
  readonly model?: string;
  readonly note: string;
}

export function missionModelLines(view: MissionModelsView): string[] {
  if (view.loadError !== undefined) return [labelled('Models', missionModelsLoadError(view.loadError))];
  if (view.resolved === undefined) return [labelled('Models', MISSION_MODELS_NOT_LOADED)];
  const resolved = view.resolved;
  const cells = TOWER_ROLES.map((role) => modelCell(role, resolved.roles[role]));
  const width = Math.max(0, ...cells.map((cell) => cell.model?.length ?? 0));
  return cells.map((cell) =>
    labelled(cell.label, cell.model === undefined ? cell.note : `${cell.model.padEnd(width)}  (${cell.note})`),
  );
}

export function renderMissionHeader(input: MissionHeaderInput): string {
  return [
    ...missionModelLines(input.models).map(indent),
    indent(labelled('Base branch', missionBaseLine(input.base, input.initialized, input.maxRunningAgents))),
    indent(MISSION_MODELS_HINT),
    ...(input.previous === undefined ? [] : [missionPreviousLine(input.previous)]),
    MISSION_GOAL_QUESTION,
  ].join('\n');
}

export function renderMissionPlanning(models: MissionModelsView, goal: string): string {
  return [...missionModelLines(models).map(indent), missionPlanningLine(goal)].join('\n');
}

export function renderMissionControl(input: MissionControlInput): string {
  return [
    ['## Models', ...missionModelLines(input.models)].join('\n'),
    input.statusMarkdown,
    ['## Commands', ...missionCommandsFor(input.objective.status)].join('\n'),
  ].join('\n\n');
}

function modelCell(role: TowerRole, resolved: TowerResolvedModel): ModelCell {
  const label = MISSION_ROLE_LABELS[role];
  if (role === 'validator' && resolved.origin.kind === 'inherited') {
    return { label, note: missionModelSource(resolved.origin) };
  }
  const binding = resolved.binding;
  if (binding === undefined) return { label, note: missionModelMissing(role) };
  return {
    label,
    model: binding.thinkingLevel === undefined ? binding.model : `${binding.model} · ${binding.thinkingLevel}`,
    note: missionModelSource(resolved.origin),
  };
}

function labelled(label: string, value: string): string {
  return `${label.padEnd(MISSION_LABEL_WIDTH)}${value}`;
}

function indent(line: string): string {
  return `  ${line}`;
}
