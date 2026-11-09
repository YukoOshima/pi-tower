import { TowerProtocolError } from './errors.ts';
import type {
  TowerMilestone,
  TowerMilestoneStatus,
  TowerMilestoneValidationSpec,
  TowerMission,
  TowerMissionKind,
  TowerMissionOrigin,
  TowerObjective,
  TowerObjectiveAutopilotState,
  TowerObjectiveLimits,
  TowerObjectiveMode,
  TowerObjectiveStatus,
  TowerState,
  TowerValidationKind,
  TowerValidationRound,
} from './types.ts';

export const DEFAULT_MAX_VALIDATION_ROUNDS = 3;
export const DEFAULT_MAX_FEATURE_ATTEMPTS = 3;
export const TOWER_VALIDATION_KINDS: readonly TowerValidationKind[] = [
  'scrutiny',
  'user-testing',
  'commands',
];
export const TOWER_OBJECTIVE_MODES: readonly TowerObjectiveMode[] = ['interactive', 'headless'];

export interface TowerValidationSettings {
  readonly skipScrutiny?: boolean;
  readonly skipUserTesting?: boolean;
}

export type TowerObjectiveBlockCode =
  | 'no-objective'
  | 'not-executing'
  | 'no-milestones'
  | 'milestone-not-passed'
  | 'open-feature'
  | 'final-validation-failed'
  | 'final-validation-stale';

export interface TowerObjectiveBlock {
  readonly code: TowerObjectiveBlockCode;
  readonly detail: string;
}

export interface TowerObjectiveCompletion {
  readonly ready: boolean;
  readonly blocks: readonly TowerObjectiveBlock[];
}

export interface TowerValidationKindProgress {
  readonly kind: TowerValidationKind;
  readonly required: boolean;
  readonly rounds: number;
  readonly failedRounds: number;
  readonly latest?: TowerValidationRound;
}

export interface TowerMilestoneProgress {
  readonly id: string;
  readonly title: string;
  readonly order: number;
  readonly status: TowerMilestoneStatus;
  readonly current: boolean;
  readonly final: boolean;
  readonly features: readonly string[];
  readonly openFeatures: readonly string[];
  readonly mergedFeatures: readonly string[];
  readonly requiredKinds: readonly TowerValidationKind[];
  readonly commands: readonly string[];
  readonly kinds: readonly TowerValidationKindProgress[];
  readonly validationCommit?: string;
  readonly validationStale: boolean;
  readonly failedOnTip: readonly TowerValidationKind[];
  readonly readyForValidation: boolean;
}

export interface TowerObjectiveEvaluation {
  readonly objectiveId?: string;
  readonly status?: TowerObjectiveStatus;
  readonly baseTip: string;
  readonly currentMilestone?: string;
  readonly milestones: readonly TowerMilestoneProgress[];
  readonly completion: TowerObjectiveCompletion;
}

export class TowerObjectiveCompletionError extends TowerProtocolError {
  readonly blocks: readonly TowerObjectiveBlock[];

  constructor(objectiveId: string, blocks: readonly TowerObjectiveBlock[]) {
    super(
      `objective ${objectiveId} cannot complete yet — ${blocks.map((block) => `${block.code}: ${block.detail}`).join('; ')}`,
    );
    this.name = 'TowerObjectiveCompletionError';
    this.blocks = blocks;
  }
}

export function isTerminalObjectiveStatus(status: TowerObjectiveStatus): boolean {
  return status === 'completed' || status === 'blocked';
}

export function isObjectiveOpen(objective: TowerObjective | undefined): boolean {
  return objective !== undefined && !isTerminalObjectiveStatus(objective.status);
}

export function canPlanObjective(objective: TowerObjective | undefined): boolean {
  return !isObjectiveOpen(objective) || objective?.status === 'planning';
}

function isOpenFeature(mission: Pick<TowerMission, 'status'>): boolean {
  return mission.status !== 'merged' && mission.status !== 'abandoned';
}

function idNumber(id: string, prefix: string): number {
  if (!id.startsWith(prefix)) return 0;
  const n = Number.parseInt(id.slice(prefix.length), 10);
  return Number.isNaN(n) ? 0 : n;
}

export function sortedMilestones(objective: TowerObjective): TowerMilestone[] {
  return objective.milestones.toSorted(
    (a, b) => a.order - b.order || idNumber(a.id, 'MS') - idNumber(b.id, 'MS'),
  );
}

export function findMilestone(
  objective: TowerObjective | undefined,
  milestoneId: string,
): TowerMilestone | undefined {
  return objective?.milestones.find((milestone) => milestone.id === milestoneId);
}

export function currentMilestone(objective: TowerObjective): TowerMilestone | undefined {
  return sortedMilestones(objective).find((milestone) => milestone.status !== 'passed');
}

export function finalMilestone(objective: TowerObjective): TowerMilestone | undefined {
  return sortedMilestones(objective).at(-1);
}

export function milestoneMissions(state: TowerState, milestoneId: string): TowerMission[] {
  return state.missions.filter((mission) => mission.milestone === milestoneId);
}

export function objectiveMissions(state: TowerState): TowerMission[] {
  const objective = state.objective;
  if (objective === undefined) return [];
  const ids = new Set(objective.milestones.map((milestone) => milestone.id));
  return state.missions.filter(
    (mission) => mission.milestone !== undefined && ids.has(mission.milestone),
  );
}

export function validationCommands(objective: TowerObjective, milestone: TowerMilestone): string[] {
  const commands = [...milestone.validation.commands];
  if (finalMilestone(objective)?.id === milestone.id) commands.push(...objective.acceptanceCommands);
  return [...new Set(commands)];
}

export function requiredValidationKinds(
  objective: TowerObjective,
  milestone: TowerMilestone,
  settings: TowerValidationSettings = {},
): TowerValidationKind[] {
  const kinds: TowerValidationKind[] = [];
  if (milestone.validation.scrutiny !== false && settings.skipScrutiny !== true) kinds.push('scrutiny');
  if (milestone.validation.userTesting !== false && settings.skipUserTesting !== true) {
    kinds.push('user-testing');
  }
  if (validationCommands(objective, milestone).length > 0) kinds.push('commands');
  return kinds;
}

export function contractRevisionOf(objective: TowerObjective): number {
  return objective.contractRevision ?? 0;
}

export function roundContractRevision(round: TowerValidationRound): number {
  return round.contractRevision ?? 0;
}

export function latestValidationRound(
  milestone: TowerMilestone,
  kind: TowerValidationKind,
  commit?: string,
  revision?: number,
): TowerValidationRound | undefined {
  let latest: TowerValidationRound | undefined;
  for (const round of milestone.rounds) {
    if (round.kind !== kind) continue;
    if (commit !== undefined && round.validatedCommit !== commit) continue;
    if (revision !== undefined && roundContractRevision(round) !== revision) continue;
    if (latest === undefined || round.round >= latest.round) latest = round;
  }
  return latest;
}

export function failedValidationRounds(milestone: TowerMilestone, kind: TowerValidationKind): number {
  return milestone.rounds.filter((round) => round.kind === kind && round.verdict === 'fail').length;
}

export function nextValidationRound(milestone: TowerMilestone, kind: TowerValidationKind): number {
  const rounds = milestone.rounds.filter((round) => round.kind === kind).map((round) => round.round);
  return Math.max(0, ...rounds) + 1;
}

export function milestonePassesOn(
  objective: TowerObjective,
  milestone: TowerMilestone,
  commit: string,
  settings: TowerValidationSettings = {},
): boolean {
  return requiredValidationKinds(objective, milestone, settings).every(
    (kind) => latestValidationRound(milestone, kind, commit, contractRevisionOf(objective))?.verdict === 'pass',
  );
}

export function failedRoundsOn(
  objective: TowerObjective,
  milestone: TowerMilestone,
  commit: string,
  settings: TowerValidationSettings = {},
): TowerValidationRound[] {
  const revision = contractRevisionOf(objective);
  return requiredValidationKinds(objective, milestone, settings).flatMap((kind) =>
    milestone.rounds.filter(
      (round) =>
        round.kind === kind &&
        round.verdict === 'fail' &&
        round.validatedCommit === commit &&
        roundContractRevision(round) === revision,
    ),
  );
}

export function latestFailingKinds(
  objective: TowerObjective,
  milestone: TowerMilestone,
  commit: string,
  settings: TowerValidationSettings = {},
): TowerValidationKind[] {
  return requiredValidationKinds(objective, milestone, settings).filter(
    (kind) => latestValidationRound(milestone, kind, commit, contractRevisionOf(objective))?.verdict === 'fail',
  );
}

export function finalPassBroken(
  objective: TowerObjective,
  milestone: TowerMilestone,
  baseTip: string,
  settings: TowerValidationSettings = {},
): 'failed' | 'stale' | undefined {
  if (milestone.status !== 'passed' || finalMilestone(objective)?.id !== milestone.id) return undefined;
  if (latestFailingKinds(objective, milestone, baseTip, settings).length > 0) return 'failed';
  if (milestone.validationCommit !== baseTip || !milestonePassesOn(objective, milestone, baseTip, settings)) {
    return 'stale';
  }
  return undefined;
}

export function deriveMilestoneStatus(
  objective: TowerObjective,
  milestone: TowerMilestone,
  settings: TowerValidationSettings = {},
): TowerMilestoneStatus {
  if (milestone.status !== 'validating' && milestone.status !== 'failed') return milestone.status;
  const commit = milestone.validationCommit;
  if (commit === undefined) return milestone.status;
  const required = requiredValidationKinds(objective, milestone, settings);
  const failing = required.filter(
    (kind) => latestValidationRound(milestone, kind, commit, contractRevisionOf(objective))?.verdict === 'fail',
  );
  if (failing.length > 0) {
    return failing.some(
      (kind) => failedValidationRounds(milestone, kind) >= objective.limits.maxValidationRounds,
    )
      ? 'blocked'
      : 'failed';
  }
  if (milestone.status === 'failed') return 'failed';
  return milestonePassesOn(objective, milestone, commit, settings) ? 'passed' : 'validating';
}

function milestoneProgress(
  state: TowerState,
  objective: TowerObjective,
  milestone: TowerMilestone,
  baseTip: string,
  settings: TowerValidationSettings,
  currentId: string | undefined,
  finalId: string | undefined,
): TowerMilestoneProgress {
  const features = milestoneMissions(state, milestone.id);
  const openFeatures = features.filter(isOpenFeature).map((mission) => mission.id);
  const required = requiredValidationKinds(objective, milestone, settings);
  const failedOnTip = [
    ...new Set(failedRoundsOn(objective, milestone, baseTip, settings).map((round) => round.kind)),
  ];
  const kinds = TOWER_VALIDATION_KINDS.filter(
    (kind) => required.includes(kind) || milestone.rounds.some((round) => round.kind === kind),
  ).map(
    (kind): TowerValidationKindProgress => ({
      kind,
      required: required.includes(kind),
      rounds: milestone.rounds.filter((round) => round.kind === kind).length,
      failedRounds: failedValidationRounds(milestone, kind),
      latest:
        milestone.validationCommit === undefined
          ? undefined
          : latestValidationRound(milestone, kind, milestone.validationCommit, contractRevisionOf(objective)),
    }),
  );
  return {
    id: milestone.id,
    title: milestone.title,
    order: milestone.order,
    status: milestone.status,
    current: milestone.id === currentId,
    final: milestone.id === finalId,
    features: features.map((mission) => mission.id),
    openFeatures,
    mergedFeatures: features.filter((mission) => mission.status === 'merged').map((mission) => mission.id),
    requiredKinds: required,
    commands: validationCommands(objective, milestone),
    kinds,
    validationCommit: milestone.validationCommit,
    validationStale:
      (milestone.status === 'validating' || milestone.status === 'passed') &&
      milestone.validationCommit !== undefined &&
      milestone.validationCommit !== baseTip,
    failedOnTip,
    readyForValidation:
      milestone.status === 'active' &&
      features.length > 0 &&
      openFeatures.length === 0 &&
      failedOnTip.length === 0,
  };
}

export function evaluateObjective(
  state: TowerState,
  baseTip: string,
  settings: TowerValidationSettings = {},
): TowerObjectiveEvaluation {
  const objective = state.objective;
  if (objective === undefined) {
    return {
      baseTip,
      milestones: [],
      completion: {
        ready: false,
        blocks: [{ code: 'no-objective', detail: 'no objective exists — draft one first' }],
      },
    };
  }
  const ordered = sortedMilestones(objective);
  const current = currentMilestone(objective);
  const final = ordered.at(-1);
  const milestones = ordered.map((milestone) =>
    milestoneProgress(state, objective, milestone, baseTip, settings, current?.id, final?.id),
  );
  const blocks: TowerObjectiveBlock[] = [];
  if (objective.status !== 'executing') {
    blocks.push({
      code: 'not-executing',
      detail: `objective ${objective.id} is ${objective.status}, not executing`,
    });
  }
  if (ordered.length === 0) {
    blocks.push({ code: 'no-milestones', detail: `objective ${objective.id} has no milestones` });
  }
  for (const milestone of ordered) {
    if (milestone.status === 'passed') continue;
    blocks.push({
      code: 'milestone-not-passed',
      detail: `milestone ${milestone.id} "${milestone.title}" is ${milestone.status}`,
    });
  }
  for (const mission of objectiveMissions(state)) {
    if (!isOpenFeature(mission)) continue;
    blocks.push({
      code: 'open-feature',
      detail: `feature ${mission.id} (milestone ${mission.milestone ?? '?'}) is ${mission.status}`,
    });
  }
  if (final?.status === 'passed') {
    const commit = final.validationCommit;
    const failing = latestFailingKinds(objective, final, baseTip, settings);
    if (failing.length > 0) {
      blocks.push({
        code: 'final-validation-failed',
        detail: `final milestone ${final.id} failed ${failing.join(', ')} on the base tip ${baseTip.slice(0, 7)} — plan a fix into ${final.id}`,
      });
    } else if (commit !== baseTip) {
      blocks.push({
        code: 'final-validation-stale',
        detail: `final milestone ${final.id} passed on ${commit === undefined ? 'no recorded commit' : commit.slice(0, 7)} but the base tip is ${baseTip.slice(0, 7)} — re-validate it on the current tip`,
      });
    } else if (!milestonePassesOn(objective, final, commit, settings)) {
      blocks.push({
        code: 'final-validation-stale',
        detail: `final milestone ${final.id} has no passing round on ${commit.slice(0, 7)} for every required kind (${requiredValidationKinds(objective, final, settings).join(', ')}) — re-validate it`,
      });
    }
  }
  return {
    objectiveId: objective.id,
    status: objective.status,
    baseTip,
    currentMilestone: current?.id,
    milestones,
    completion: { ready: blocks.length === 0, blocks },
  };
}

export function estimateObjectiveRuns(state: TowerState): number {
  const objective = state.objective;
  if (objective === undefined) return 0;
  const features = objectiveMissions(state).filter((mission) => mission.status !== 'abandoned');
  return features.length + 2 * objective.milestones.length;
}

export function objectiveApprovalProblems(state: TowerState, objective: TowerObjective): string[] {
  const problems: string[] = [];
  if (objective.goal.trim().length === 0) problems.push('the goal is empty');
  if (objective.definitionOfDone.length === 0) {
    problems.push('the definition of done has no items');
  }
  const first = sortedMilestones(objective)[0];
  if (first === undefined) {
    problems.push('there are no milestones');
  } else if (
    !milestoneMissions(state, first.id).some(
      (mission) => mission.kind === 'build' && mission.status !== 'abandoned',
    )
  ) {
    problems.push(
      `the first milestone ${first.id} "${first.title}" has no build feature — plan at least one with TowerPlan(milestone=${first.id})`,
    );
  }
  return problems;
}

export interface TowerMilestoneValidationInput {
  readonly scrutiny?: boolean;
  readonly userTesting?: boolean;
  readonly commands?: readonly string[];
  readonly qaInstructions?: string;
}

export interface TowerMilestoneInput {
  readonly id?: string;
  readonly title?: string;
  readonly description?: string;
  readonly validation?: TowerMilestoneValidationInput;
}

export interface TowerObjectiveLimitsInput {
  readonly maxValidationRounds?: number;
  readonly maxFeatureAttempts?: number;
  readonly maxWallTimeMs?: number | null;
  readonly maxCostUsd?: number | null;
}

export interface TowerObjectiveDraftInput {
  readonly title: string;
  readonly goal?: string;
  readonly definitionOfDone?: readonly string[];
  readonly acceptanceCommands?: readonly string[];
  readonly milestones?: readonly TowerMilestoneInput[];
  readonly notes?: readonly string[];
  readonly limits?: TowerObjectiveLimitsInput;
}

export interface TowerObjectiveUpdateInput {
  readonly title?: string;
  readonly goal?: string;
  readonly definitionOfDone?: readonly string[];
  readonly acceptanceCommands?: readonly string[];
  readonly milestones?: readonly TowerMilestoneInput[];
  readonly removeMilestones?: readonly string[];
  readonly milestoneOrder?: readonly string[];
  readonly notes?: readonly string[];
  readonly limits?: TowerObjectiveLimitsInput;
}

export interface TowerObjectiveUpdateResult {
  readonly objective: TowerObjective;
  readonly contractChanged: boolean;
  readonly changes: readonly string[];
  readonly reopened: readonly string[];
}

function cleanList(items: readonly string[] | undefined): string[] {
  return (items ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function sameSpec(a: TowerMilestoneValidationSpec, b: TowerMilestoneValidationSpec): boolean {
  return (
    a.scrutiny === b.scrutiny &&
    a.userTesting === b.userTesting &&
    a.qaInstructions === b.qaInstructions &&
    sameList(a.commands, b.commands)
  );
}

function positiveInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TowerProtocolError(`objective limit ${name} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

function positiveNumber(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) {
    throw new TowerProtocolError(`objective limit ${name} must be a positive number, got ${String(value)}`);
  }
  return value;
}

function buildLimits(
  input: TowerObjectiveLimitsInput | undefined,
  base?: TowerObjectiveLimits,
): TowerObjectiveLimits {
  const limits: TowerObjectiveLimits = {
    maxValidationRounds:
      positiveInteger(input?.maxValidationRounds, 'maxValidationRounds') ??
      base?.maxValidationRounds ??
      DEFAULT_MAX_VALIDATION_ROUNDS,
    maxFeatureAttempts:
      positiveInteger(input?.maxFeatureAttempts, 'maxFeatureAttempts') ??
      base?.maxFeatureAttempts ??
      DEFAULT_MAX_FEATURE_ATTEMPTS,
  };
  const wallTimeInput = input?.maxWallTimeMs;
  const wallTime =
    wallTimeInput === null
      ? undefined
      : (positiveInteger(wallTimeInput, 'maxWallTimeMs') ?? base?.maxWallTimeMs);
  if (wallTime !== undefined) limits.maxWallTimeMs = wallTime;
  const costInput = input?.maxCostUsd;
  const cost = costInput === null ? undefined : (positiveNumber(costInput, 'maxCostUsd') ?? base?.maxCostUsd);
  if (cost !== undefined) limits.maxCostUsd = cost;
  return limits;
}

export function buildValidationSpec(
  input: TowerMilestoneValidationInput | undefined,
  base?: TowerMilestoneValidationSpec,
): TowerMilestoneValidationSpec {
  const spec: TowerMilestoneValidationSpec = {
    scrutiny: input?.scrutiny ?? base?.scrutiny ?? true,
    userTesting: input?.userTesting ?? base?.userTesting ?? true,
    commands: input?.commands !== undefined ? cleanList(input.commands) : [...(base?.commands ?? [])],
  };
  const qaInstructions =
    input?.qaInstructions !== undefined ? input.qaInstructions.trim() : base?.qaInstructions;
  if (qaInstructions !== undefined && qaInstructions.length > 0) spec.qaInstructions = qaInstructions;
  return spec;
}

function nextObjectiveNumber(state: TowerState): number {
  const ids = [
    ...(state.objective === undefined ? [] : [state.objective.id]),
    ...(state.objectiveHistory ?? []).map((objective) => objective.id),
  ];
  return Math.max(0, ...ids.map((id) => idNumber(id, 'O'))) + 1;
}

function nextMilestoneNumber(state: TowerState): number {
  const objectives = [
    ...(state.objective === undefined ? [] : [state.objective]),
    ...(state.objectiveHistory ?? []),
  ];
  const ids = [
    ...objectives.flatMap((objective) => [
      ...objective.milestones.map((milestone) => milestone.id),
      ...(objective.removedMilestones ?? []),
    ]),
    ...state.missions.flatMap((mission) => (mission.milestone === undefined ? [] : [mission.milestone])),
    ...state.roster.agents.flatMap((agent) => (agent.milestoneId === undefined ? [] : [agent.milestoneId])),
  ];
  return Math.max(0, ...ids.map((id) => idNumber(id, 'MS'))) + 1;
}

function milestoneTitle(input: TowerMilestoneInput): string {
  const title = input.title?.trim() ?? '';
  if (title.length === 0) {
    throw new TowerProtocolError('every new milestone needs a non-blank title');
  }
  return title;
}

function newMilestone(id: string, order: number, input: TowerMilestoneInput): TowerMilestone {
  const description = input.description?.trim();
  return {
    id,
    title: milestoneTitle(input),
    ...(description !== undefined && description.length > 0 ? { description } : {}),
    order,
    validation: buildValidationSpec(input.validation),
    status: 'pending',
    rounds: [],
  };
}

export function buildObjective(
  state: TowerState,
  input: TowerObjectiveDraftInput,
  now: string,
): TowerObjective {
  const title = input.title.trim();
  if (title.length === 0) {
    throw new TowerProtocolError('an objective needs a non-blank title');
  }
  let next = nextMilestoneNumber(state);
  const milestones = (input.milestones ?? []).map((item, index) => {
    if (item.id !== undefined) {
      throw new TowerProtocolError(
        `drafted milestone "${item.title ?? item.id}" must not carry an id — the tower assigns milestone ids`,
      );
    }
    const id = `MS${String(next)}`;
    next += 1;
    return newMilestone(id, index + 1, item);
  });
  return {
    id: `O${String(nextObjectiveNumber(state))}`,
    title,
    goal: input.goal?.trim() ?? '',
    definitionOfDone: cleanList(input.definitionOfDone),
    acceptanceCommands: cleanList(input.acceptanceCommands),
    status: 'planning',
    milestones,
    limits: buildLimits(input.limits),
    createdAt: now,
    notes: cleanList(input.notes),
  };
}

interface EffectiveContract {
  readonly scrutiny: boolean;
  readonly userTesting: boolean;
  readonly qaInstructions?: string;
  readonly commands: readonly string[];
}

function effectiveContract(objective: TowerObjective, milestone: TowerMilestone): EffectiveContract {
  return {
    scrutiny: milestone.validation.scrutiny,
    userTesting: milestone.validation.userTesting,
    qaInstructions: milestone.validation.qaInstructions,
    commands: validationCommands(objective, milestone),
  };
}

function contractGrew(before: EffectiveContract, after: EffectiveContract): boolean {
  return (
    (after.scrutiny && !before.scrutiny) ||
    (after.userTesting && (!before.userTesting || after.qaInstructions !== before.qaInstructions)) ||
    after.commands.some((command) => !before.commands.includes(command))
  );
}

function contractDiffers(before: EffectiveContract, after: EffectiveContract): boolean {
  return (
    before.scrutiny !== after.scrutiny ||
    before.userTesting !== after.userTesting ||
    before.qaInstructions !== after.qaInstructions ||
    !sameList(before.commands, after.commands)
  );
}

function reopenChangedMilestones(before: TowerObjective, after: TowerObjective): string[] {
  const reopened: string[] = [];
  for (const milestone of after.milestones) {
    const previous = findMilestone(before, milestone.id);
    if (previous === undefined) continue;
    const was = effectiveContract(before, previous);
    const now = effectiveContract(after, milestone);
    const reopen =
      milestone.status === 'passed'
        ? contractGrew(was, now)
        : milestone.status !== 'pending' && milestone.status !== 'active' && contractDiffers(was, now);
    if (!reopen) continue;
    milestone.status = 'active';
    delete milestone.passedAt;
    reopened.push(milestone.id);
  }
  return reopened;
}

export function forwardDependencies(state: TowerState, objective: TowerObjective): string[] {
  const orders = new Map(objective.milestones.map((milestone) => [milestone.id, milestone.order]));
  const byId = new Map(state.missions.map((mission) => [mission.id, mission]));
  const pairs: string[] = [];
  for (const mission of state.missions) {
    if (!isOpenFeature(mission) || mission.milestone === undefined) continue;
    const own = orders.get(mission.milestone);
    if (own === undefined) continue;
    for (const depId of mission.deps) {
      const dep = byId.get(depId);
      if (dep === undefined || !isOpenFeature(dep) || dep.milestone === undefined) continue;
      const theirs = orders.get(dep.milestone);
      if (theirs !== undefined && theirs > own) {
        pairs.push(`${mission.id} (${mission.milestone}) → ${dep.id} (${dep.milestone})`);
      }
    }
  }
  return pairs;
}

export function applyObjectiveUpdate(
  state: TowerState,
  input: TowerObjectiveUpdateInput,
): TowerObjectiveUpdateResult {
  const before = state.objective;
  if (before === undefined) {
    throw new TowerProtocolError('there is no objective to update — draft one first');
  }
  if (before.status === 'completed') {
    throw new TowerProtocolError(
      `objective ${before.id} is completed and can no longer change — draft a new objective instead`,
    );
  }
  const next = structuredClone(before);
  const changes: string[] = [];
  let contractChanged = false;

  if (input.title !== undefined) {
    const title = input.title.trim();
    if (title.length === 0) throw new TowerProtocolError('an objective needs a non-blank title');
    if (title !== next.title) {
      next.title = title;
      changes.push('title');
    }
  }
  if (input.goal !== undefined && input.goal.trim() !== next.goal) {
    next.goal = input.goal.trim();
    changes.push('goal');
    contractChanged = true;
  }
  if (input.definitionOfDone !== undefined) {
    const definitionOfDone = cleanList(input.definitionOfDone);
    if (!sameList(definitionOfDone, next.definitionOfDone)) {
      next.definitionOfDone = definitionOfDone;
      changes.push('definitionOfDone');
      contractChanged = true;
    }
  }
  if (input.acceptanceCommands !== undefined) {
    const acceptanceCommands = cleanList(input.acceptanceCommands);
    if (!sameList(acceptanceCommands, next.acceptanceCommands)) {
      next.acceptanceCommands = acceptanceCommands;
      changes.push('acceptanceCommands');
      contractChanged = true;
    }
  }
  if (input.limits !== undefined) {
    const limits = buildLimits(input.limits, next.limits);
    if (JSON.stringify(limits) !== JSON.stringify(next.limits)) {
      next.limits = limits;
      changes.push('limits');
    }
  }

  const removed = [...new Set(cleanList(input.removeMilestones))];
  for (const id of removed) {
    if (findMilestone(next, id) === undefined) {
      throw new TowerProtocolError(`objective ${next.id} has no milestone "${id}" to remove`);
    }
    const attached = milestoneMissions(state, id).filter((mission) => mission.status !== 'abandoned');
    if (attached.length > 0) {
      throw new TowerProtocolError(
        `milestone ${id} cannot be removed — features ${attached.map((mission) => mission.id).join(', ')} are attached to it; abandon them first (TowerMission status=abandoned) or keep the milestone`,
      );
    }
  }
  if (removed.length > 0) {
    next.milestones = next.milestones.filter((milestone) => !removed.includes(milestone.id));
    next.removedMilestones = [...(next.removedMilestones ?? []), ...removed];
    changes.push(`removed:${removed.join('+')}`);
    contractChanged = true;
  }

  const appended: TowerMilestoneInput[] = [];
  for (const item of input.milestones ?? []) {
    if (item.id === undefined) {
      appended.push(item);
      continue;
    }
    const milestone = findMilestone(next, item.id);
    if (milestone === undefined) {
      throw new TowerProtocolError(
        `objective ${next.id} has no milestone "${item.id}" — omit the id to append a new milestone`,
      );
    }
    if (item.title !== undefined) {
      const title = milestoneTitle(item);
      if (title !== milestone.title) {
        milestone.title = title;
        changes.push(`${milestone.id}.title`);
      }
    }
    if (item.description !== undefined) {
      const description = item.description.trim();
      if (description !== (milestone.description ?? '')) {
        if (description.length > 0) milestone.description = description;
        else delete milestone.description;
        changes.push(`${milestone.id}.description`);
      }
    }
    if (item.validation !== undefined) {
      const validation = buildValidationSpec(item.validation, milestone.validation);
      if (!sameSpec(validation, milestone.validation)) {
        milestone.validation = validation;
        changes.push(`${milestone.id}.validation`);
        contractChanged = true;
      }
    }
  }

  let sequence = sortedMilestones(next);
  if (input.milestoneOrder !== undefined) {
    const order = cleanList(input.milestoneOrder);
    const known = sequence.map((milestone) => milestone.id);
    if (
      order.length !== known.length ||
      new Set(order).size !== order.length ||
      order.some((id) => !known.includes(id))
    ) {
      throw new TowerProtocolError(
        `milestoneOrder must list every existing milestone exactly once (${known.join(', ')}), got ${order.join(', ') || '(none)'}`,
      );
    }
    if (!sameList(order, known)) {
      sequence = order.map((id) => findMilestone(next, id)!);
      changes.push(`reordered:${order.join('+')}`);
      contractChanged = true;
    }
  }
  let number = nextMilestoneNumber(state);
  for (const item of appended) {
    const milestone = newMilestone(`MS${String(number)}`, 0, item);
    number += 1;
    sequence.push(milestone);
    changes.push(`appended:${milestone.id}`);
  }
  sequence.forEach((milestone, index) => {
    milestone.order = index + 1;
  });
  next.milestones = sequence;
  if (input.milestoneOrder !== undefined || removed.length > 0) {
    const forward = forwardDependencies(state, next);
    if (forward.length > 0) {
      throw new TowerProtocolError(
        `this milestone order would make open features wait for open features of a later milestone: ${forward.join(', ')} — a later milestone's features start only after the earlier milestones pass, so those dependencies could never be met; re-plan the affected features first (abandon them and plan them again without the dependency, or into another milestone), then reorder`,
      );
    }
  }

  const notes = cleanList(input.notes);
  if (notes.length > 0) {
    next.notes.push(...notes);
    changes.push('notes');
  }

  const reopened = reopenChangedMilestones(before, next);
  if (contractChanged) next.contractRevision = contractRevisionOf(next) + 1;
  if (contractChanged && next.approvedAt !== undefined) {
    if (before.status === 'blocked' || before.status === 'paused') next.approvalRequiresHuman = true;
    next.status = 'awaiting-approval';
    next.approvalReason = 'contract-changed';
    delete next.approvedBy;
    delete next.approvedAt;
    delete next.pausedReason;
    delete next.blockedReason;
  }
  return { objective: next, contractChanged, changes, reopened };
}

export interface TowerObjectiveAutopilotPatch {
  readonly progressKey?: string;
  readonly progressAt?: string;
  readonly stallWakes?: number;
  readonly addWakeKeys?: readonly string[];
}

export function applyAutopilotPatch(
  objective: TowerObjective,
  patch: TowerObjectiveAutopilotPatch,
): TowerObjectiveAutopilotState {
  if (
    patch.stallWakes !== undefined &&
    (!Number.isSafeInteger(patch.stallWakes) || patch.stallWakes < 0)
  ) {
    throw new TowerProtocolError(
      `autopilot stallWakes must be a non-negative integer, got ${String(patch.stallWakes)}`,
    );
  }
  const autopilot = (objective.autopilot ??= { stallWakes: 0, wakeKeys: [] });
  if (patch.progressKey !== undefined) autopilot.progressKey = patch.progressKey;
  if (patch.progressAt !== undefined) autopilot.progressAt = patch.progressAt;
  if (patch.stallWakes !== undefined) autopilot.stallWakes = patch.stallWakes;
  for (const key of patch.addWakeKeys ?? []) {
    if (!autopilot.wakeKeys.includes(key)) autopilot.wakeKeys.push(key);
  }
  return autopilot;
}

export interface TowerPlanPlacementInput {
  readonly title: string;
  readonly kind?: TowerMissionKind;
  readonly milestone?: string;
  readonly origin?: TowerMissionOrigin;
}

export interface TowerPlanPlacement {
  readonly milestone?: TowerMilestone;
  readonly origin?: TowerMissionOrigin;
  readonly reopens: boolean;
}

function describeMilestones(objective: TowerObjective): string {
  const milestones = sortedMilestones(objective);
  return milestones.length > 0
    ? milestones.map((milestone) => `${milestone.id} ${milestone.status}`).join(', ')
    : 'none yet — add one with TowerObjective update';
}

export function planPlacement(
  state: TowerState,
  item: TowerPlanPlacementInput,
  context: { readonly baseTip?: string; readonly settings?: TowerValidationSettings } = {},
): TowerPlanPlacement {
  const objective = state.objective;
  if (item.origin !== undefined && item.origin !== 'plan' && item.origin !== 'fix') {
    throw new TowerProtocolError(
      `mission "${item.title}" origin must be plan | fix, got "${String(item.origin)}"`,
    );
  }
  const milestoneId = item.milestone?.trim() ?? '';
  if (milestoneId.length === 0) {
    if (item.origin !== undefined) {
      throw new TowerProtocolError(
        `mission "${item.title}" sets origin "${item.origin}" without a milestone — origin applies only to features planned into a milestone`,
      );
    }
    if (objective !== undefined && isObjectiveOpen(objective) && (item.kind ?? 'build') === 'build') {
      throw new TowerProtocolError(
        `objective ${objective.id} is ${objective.status} — build mission "${item.title}" must name the milestone it belongs to (milestones: ${describeMilestones(objective)}); plan it with milestone=<id>`,
      );
    }
    return { reopens: false };
  }
  if (objective === undefined) {
    throw new TowerProtocolError(
      `mission "${item.title}" names milestone "${milestoneId}" but there is no objective — omit the milestone, or draft an objective first`,
    );
  }
  if (objective.status === 'completed') {
    throw new TowerProtocolError(
      `objective ${objective.id} is completed — mission "${item.title}" cannot join milestone "${milestoneId}"; plan it without a milestone or draft a new objective`,
    );
  }
  const milestone = findMilestone(objective, milestoneId);
  if (milestone === undefined) {
    throw new TowerProtocolError(
      `objective ${objective.id} has no milestone "${milestoneId}" (milestones: ${describeMilestones(objective)})`,
    );
  }
  const brokenFinal =
    context.baseTip !== undefined &&
    finalPassBroken(objective, milestone, context.baseTip, context.settings) !== undefined;
  if (milestone.status === 'passed' && !brokenFinal) {
    const current = currentMilestone(objective);
    throw new TowerProtocolError(
      `milestone ${milestone.id} "${milestone.title}" already passed validation — plan "${item.title}" into ${current === undefined ? 'a new milestone' : `the current milestone ${current.id} "${current.title}"`}, or append a milestone with TowerObjective update if the work belongs after it`,
    );
  }
  const reopens =
    brokenFinal ||
    milestone.status === 'failed' ||
    milestone.status === 'validating' ||
    milestone.status === 'blocked';
  return { milestone, origin: item.origin ?? (reopens ? 'fix' : 'plan'), reopens };
}

export function validationResultSubject(
  milestoneId: string,
  round: Pick<TowerValidationRound, 'kind' | 'round' | 'verdict' | 'failures'>,
): string {
  const failures = round.failures.length;
  const detail =
    round.verdict === 'fail' ? ` (${String(failures)} failure${failures === 1 ? '' : 's'})` : '';
  return `validation ${milestoneId} ${round.kind} r${String(round.round)}: ${round.verdict}${detail}`;
}

export interface TowerValidationOutcome {
  readonly previousStatus: TowerMilestoneStatus;
  readonly status: TowerMilestoneStatus;
  readonly counted: boolean;
  readonly objectiveBlocked: boolean;
}

export function applyValidationRound(
  objective: TowerObjective,
  milestone: TowerMilestone,
  round: TowerValidationRound,
  settings: TowerValidationSettings = {},
): TowerValidationOutcome {
  const previousStatus = milestone.status;
  milestone.rounds.push(round);
  const status = deriveMilestoneStatus(objective, milestone, settings);
  milestone.status = status;
  if (status === 'passed' && previousStatus !== 'passed') milestone.passedAt = round.date;
  let objectiveBlocked = false;
  if (status === 'blocked' && previousStatus !== 'blocked' && !isTerminalObjectiveStatus(objective.status)) {
    const max = objective.limits.maxValidationRounds;
    const exhausted = TOWER_VALIDATION_KINDS.filter(
      (kind) =>
        failedValidationRounds(milestone, kind) >= max &&
        latestValidationRound(milestone, kind, milestone.validationCommit, contractRevisionOf(objective))?.verdict === 'fail',
    );
    objective.status = 'blocked';
    objective.blockedReason = `milestone ${milestone.id} "${milestone.title}" failed ${exhausted.map((kind) => `${kind} validation ${String(failedValidationRounds(milestone, kind))} times`).join(' and ')} — maxValidationRounds is ${String(max)}`;
    delete objective.pausedReason;
    objectiveBlocked = true;
  }
  return {
    previousStatus,
    status,
    counted:
      (previousStatus === 'validating' || previousStatus === 'failed') &&
      round.validatedCommit === milestone.validationCommit &&
      roundContractRevision(round) === contractRevisionOf(objective),
    objectiveBlocked,
  };
}

export type TowerMilestoneOrderOf = (mission: Pick<TowerMission, 'milestone'>) => number | undefined;

export function milestoneOrderOf(state: TowerState): TowerMilestoneOrderOf {
  const objective = state.objective;
  if (objective === undefined || objective.status === 'completed') return () => undefined;
  const orders = new Map(objective.milestones.map((milestone) => [milestone.id, milestone.order]));
  return (mission) => (mission.milestone === undefined ? undefined : orders.get(mission.milestone));
}
