import { Type, type Static } from 'typebox';

import { TOWER_PARAMETER_DESCRIPTIONS } from '../../prompts/index.ts';
import {
  sortedMilestones,
  type TowerMilestoneInput,
  type TowerMilestoneValidationInput,
  type TowerObjective,
  type TowerObjectiveUpdateInput,
} from '../../protocol/index.ts';
import { stringEnum } from '../support.ts';

const DESCRIPTIONS = TOWER_PARAMETER_DESCRIPTIONS.TowerObjective;

export const TOWER_OBJECTIVE_ACTIONS = [
  'draft',
  'update',
  'request-approval',
  'status',
  'block',
] as const;

export type TowerObjectiveAction = (typeof TOWER_OBJECTIVE_ACTIONS)[number];

export const TowerObjectiveMilestoneSchema = Type.Object(
  {
    id: Type.Optional(Type.String({ description: DESCRIPTIONS.milestone_id })),
    title: Type.String({ description: DESCRIPTIONS.milestone_title }),
    description: Type.Optional(Type.String({ description: DESCRIPTIONS.milestone_description })),
    scrutiny: Type.Optional(Type.Boolean({ description: DESCRIPTIONS.milestone_scrutiny })),
    user_testing: Type.Optional(Type.Boolean({ description: DESCRIPTIONS.milestone_user_testing })),
    commands: Type.Optional(Type.Array(Type.String(), { description: DESCRIPTIONS.milestone_commands })),
    qa_instructions: Type.Optional(Type.String({ description: DESCRIPTIONS.milestone_qa_instructions })),
  },
  { additionalProperties: false },
);

export const TowerObjectiveToolInputSchema = Type.Object(
  {
    action: stringEnum(TOWER_OBJECTIVE_ACTIONS, DESCRIPTIONS.action),
    title: Type.Optional(Type.String({ description: DESCRIPTIONS.title })),
    goal: Type.Optional(Type.String({ description: DESCRIPTIONS.goal })),
    definition_of_done: Type.Optional(
      Type.Array(Type.String(), { description: DESCRIPTIONS.definition_of_done }),
    ),
    acceptance_commands: Type.Optional(
      Type.Array(Type.String(), { description: DESCRIPTIONS.acceptance_commands }),
    ),
    milestones: Type.Optional(
      Type.Array(TowerObjectiveMilestoneSchema, { description: DESCRIPTIONS.milestones }),
    ),
    note: Type.Optional(Type.String({ description: DESCRIPTIONS.note })),
    reason: Type.Optional(Type.String({ description: DESCRIPTIONS.reason })),
  },
  { additionalProperties: false },
);

export type TowerObjectiveMilestoneItem = Static<typeof TowerObjectiveMilestoneSchema>;
export type TowerObjectiveToolInput = Static<typeof TowerObjectiveToolInputSchema>;

const PLAN_FIELDS = [
  'title',
  'goal',
  'definition_of_done',
  'acceptance_commands',
  'milestones',
  'note',
] as const;

function givenFields(
  input: TowerObjectiveToolInput,
  fields: readonly (keyof TowerObjectiveToolInput)[],
): string[] {
  return fields.filter((field) => input[field] !== undefined);
}

export function towerObjectiveInputProblem(input: TowerObjectiveToolInput): string | undefined {
  const action = input.action as string;
  if (!(TOWER_OBJECTIVE_ACTIONS as readonly string[]).includes(action)) {
    return `TowerObjective action must be ${TOWER_OBJECTIVE_ACTIONS.join(' | ')}, got "${action}" — there is no approve or complete action: only the human approves, and completion is automatic`;
  }
  if (input.action === 'draft' || input.action === 'update') {
    if (input.reason !== undefined) {
      return `TowerObjective action="${input.action}" does not take reason — reason belongs to action="block"; record decisions and assumptions with note`;
    }
    if (input.action === 'draft' && input.title === undefined) {
      return 'TowerObjective action="draft" needs a title';
    }
    if (input.action === 'update' && givenFields(input, PLAN_FIELDS).length === 0) {
      return `TowerObjective action="update" needs at least one field to change: ${PLAN_FIELDS.join(', ')}`;
    }
    return milestoneItemsProblem(input.milestones ?? []);
  }
  if (input.action === 'block') {
    const extra = givenFields(input, PLAN_FIELDS);
    if (extra.length > 0) {
      return `TowerObjective action="block" takes only reason — got ${extra.join(', ')}; change the plan with action="update" instead`;
    }
    if ((input.reason ?? '').trim().length === 0) {
      return 'TowerObjective action="block" needs a reason — why the objective cannot converge and what the human has to decide; the human is notified with it';
    }
    return undefined;
  }
  const extra = givenFields(input, [...PLAN_FIELDS, 'reason']);
  return extra.length > 0
    ? `TowerObjective action="${input.action}" takes no other parameters — got ${extra.join(', ')}; change the plan with action="update" first`
    : undefined;
}

function milestoneItemsProblem(items: readonly TowerObjectiveMilestoneItem[]): string | undefined {
  const seen = new Set<string>();
  for (const item of items) {
    if (item.id === undefined) continue;
    const id = item.id.trim();
    if (id.length === 0) {
      return `milestone "${item.title}" has a blank id — omit id for a new milestone, or pass the id of an existing one`;
    }
    if (seen.has(id)) {
      return `milestone ${id} appears more than once in milestones — list every milestone exactly once`;
    }
    seen.add(id);
  }
  return undefined;
}

export function milestoneInput(item: TowerObjectiveMilestoneItem): TowerMilestoneInput {
  const validation: TowerMilestoneValidationInput = {
    ...(item.scrutiny === undefined ? {} : { scrutiny: item.scrutiny }),
    ...(item.user_testing === undefined ? {} : { userTesting: item.user_testing }),
    ...(item.commands === undefined ? {} : { commands: item.commands }),
    ...(item.qa_instructions === undefined ? {} : { qaInstructions: item.qa_instructions }),
  };
  return {
    ...(item.id === undefined ? {} : { id: item.id.trim() }),
    title: item.title,
    ...(item.description === undefined ? {} : { description: item.description }),
    ...(Object.keys(validation).length === 0 ? {} : { validation }),
  };
}

export type TowerMilestoneSlot =
  | { readonly id: string }
  | { readonly appended: number };

export interface TowerObjectiveUpdatePlan {
  readonly input: TowerObjectiveUpdateInput;
  readonly slots?: readonly TowerMilestoneSlot[];
}

export function planObjectiveUpdate(
  objective: TowerObjective,
  input: TowerObjectiveToolInput,
): TowerObjectiveUpdatePlan {
  const fields: TowerObjectiveUpdateInput = {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.goal === undefined ? {} : { goal: input.goal }),
    ...(input.definition_of_done === undefined ? {} : { definitionOfDone: input.definition_of_done }),
    ...(input.acceptance_commands === undefined
      ? {}
      : { acceptanceCommands: input.acceptance_commands }),
    ...(input.note === undefined ? {} : { notes: [input.note] }),
  };
  const items = input.milestones;
  if (items === undefined) return { input: fields };
  const current = sortedMilestones(objective).map((milestone) => milestone.id);
  const listed = items.flatMap((item) => (item.id === undefined ? [] : [item.id.trim()]));
  const removed = current.filter((id) => !listed.includes(id));
  const kept = current.filter((id) => listed.includes(id));
  const keptOrder = listed.filter((id) => current.includes(id));
  const reordered = keptOrder.some((id, index) => id !== kept[index]);
  let appended = 0;
  const slots = items.map((item): TowerMilestoneSlot => {
    if (item.id !== undefined) return { id: item.id.trim() };
    appended += 1;
    return { appended: appended - 1 };
  });
  const firstNew = slots.findIndex((slot) => 'appended' in slot);
  const insertsBeforeExisting =
    firstNew !== -1 && slots.slice(firstNew).some((slot) => 'id' in slot);
  return {
    input: {
      ...fields,
      milestones: items.map(milestoneInput),
      ...(removed.length > 0 ? { removeMilestones: removed } : {}),
      ...(reordered ? { milestoneOrder: keptOrder } : {}),
    },
    ...(insertsBeforeExisting ? { slots } : {}),
  };
}

export function appendedMilestoneIds(changes: readonly string[]): string[] {
  return changes.flatMap((change) =>
    change.startsWith('appended:') ? [change.slice('appended:'.length)] : [],
  );
}

export function resolveMilestoneSlots(
  slots: readonly TowerMilestoneSlot[],
  appendedIds: readonly string[],
): string[] | undefined {
  const appendedCount = slots.filter((slot) => 'appended' in slot).length;
  if (appendedCount !== appendedIds.length) return undefined;
  return slots.map((slot) => ('id' in slot ? slot.id : appendedIds[slot.appended]!));
}
