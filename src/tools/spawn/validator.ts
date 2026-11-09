import { buildValidatorBriefing } from '../../prompts/validatorBriefing.ts';
import {
  contractRevisionOf,
  findMilestone,
  finalMilestone,
  isAncestor,
  latestValidationRound,
  milestoneMissions,
  requiredValidationKinds,
  sortedMilestones,
  type TowerMilestone,
  type TowerObjective,
  type TowerState,
  type TowerStore,
  type TowerValidationSettings,
  type TowerValidationWorktree,
} from '../../protocol/index.ts';
import type { TowerValidatorKind } from '../validate/validate.ts';

const NOTHING_CREATED = 'no worktree or agent was created';

export function validationSpawnLease(milestoneId: string, kind: TowerValidatorKind): string {
  return `validation:${milestoneId}:${kind}`;
}

export function validationSpawnInProgress(milestoneId: string, kind: TowerValidatorKind): string {
  return `another TowerSpawn is already starting the ${milestoneId} ${kind} validator — one validator per milestone and kind at a time; check TowerTasks once it finishes; ${NOTHING_CREATED}`;
}

export type TowerValidationTarget =
  | { readonly ok: true; readonly objective: TowerObjective; readonly milestone: TowerMilestone }
  | { readonly ok: false; readonly error: string };

export function resolveValidationTarget(
  state: TowerState,
  milestoneId: string,
  kind: TowerValidatorKind,
  settings: TowerValidationSettings,
  activeAgentIds: ReadonlySet<string>,
): TowerValidationTarget {
  const objective = state.objective;
  if (objective?.status !== 'executing') {
    return {
      ok: false,
      error: `validator spawns need an executing objective — ${objective === undefined ? 'there is no objective' : `objective ${objective.id} is ${objective.status}`}; ${NOTHING_CREATED}`,
    };
  }
  const milestone = findMilestone(objective, milestoneId);
  if (milestone === undefined) {
    const known = sortedMilestones(objective).map((candidate) => `${candidate.id} ${candidate.status}`);
    return {
      ok: false,
      error: `objective ${objective.id} has no milestone "${milestoneId}" (milestones: ${known.join(', ') || 'none'}); ${NOTHING_CREATED}`,
    };
  }
  const commit = milestone.validationCommit;
  if (milestone.status !== 'validating' || commit === undefined) {
    return {
      ok: false,
      error: `milestone ${milestone.id} is ${milestone.status}, not validating — validators are spawned only while a milestone validates (validation starts on the base tip once every feature is merged or abandoned); ${NOTHING_CREATED}`,
    };
  }
  const required = requiredValidationKinds(objective, milestone, settings);
  if (!required.includes(kind)) {
    return {
      ok: false,
      error: `milestone ${milestone.id} does not require ${kind} validation (required: ${required.join(', ') || 'none'}); ${NOTHING_CREATED}`,
    };
  }
  const decided = latestValidationRound(milestone, kind, commit, contractRevisionOf(objective));
  if (decided !== undefined) {
    return {
      ok: false,
      error: `milestone ${milestone.id} already has a ${kind} verdict on ${commit.slice(0, 7)} (round ${String(decided.round)} by ${decided.validator}: ${decided.verdict}) — a kind is validated once per commit and contract; it re-runs when the base tip moves; ${NOTHING_CREATED}`,
    };
  }
  const running = state.roster.agents.find(
    (agent) =>
      agent.kind === 'validator' &&
      agent.milestoneId === milestone.id &&
      agent.validationKind === kind &&
      agent.validatedCommit === commit &&
      activeAgentIds.has(agent.agentId),
  );
  if (running !== undefined) {
    return {
      ok: false,
      error: `validator "${running.name}" is still running the ${milestone.id} ${kind} validation on ${commit.slice(0, 7)} — wait for its verdict; spawn a fresh validator only to recover a round that ended without one; ${NOTHING_CREATED}`,
    };
  }
  return { ok: true, objective, milestone };
}

export interface ValidatorPromptInput {
  readonly name: string;
  readonly kind: TowerValidatorKind;
  readonly instructions?: string;
}

export async function buildValidatorPrompt(
  store: TowerStore,
  state: TowerState,
  target: { readonly objective: TowerObjective; readonly milestone: TowerMilestone },
  prepared: TowerValidationWorktree,
  input: ValidatorPromptInput,
): Promise<string> {
  const { objective, milestone } = target;
  const diffBase = await validatorDiffBase(store, objective, milestone, prepared.commit);
  return buildValidatorBriefing({
    name: input.name,
    validationKind: input.kind,
    round: prepared.round,
    objective,
    milestone,
    finalMilestone: finalMilestone(objective)?.id === milestone.id,
    features: milestoneMissions(state, milestone.id),
    validatedCommit: prepared.commit,
    ...(diffBase === undefined ? {} : { diffBase }),
    worktreePath: prepared.path,
    repoRoot: store.repoRoot,
    base: state.base,
    ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
  });
}

async function validatorDiffBase(
  store: TowerStore,
  objective: TowerObjective,
  milestone: TowerMilestone,
  commit: string,
): Promise<string | undefined> {
  const previous = sortedMilestones(objective)
    .filter((candidate) => candidate.order < milestone.order)
    .at(-1);
  const base = previous?.status === 'passed' ? previous.validationCommit : undefined;
  if (base === undefined || base === commit) return undefined;
  const ancestor = await isAncestor(store.repoRoot, base, commit).catch(() => false);
  return ancestor ? base : undefined;
}
