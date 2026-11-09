import {
  TOWER_MAIN_AGENT_ONLY,
  TOWER_MODE_USER_ENABLED_ONLY,
  TOWER_OBJECTIVE_DESCRIPTION,
  type PromptValidationKind,
} from '../../prompts/index.ts';
import { approvalRequest, objectiveBlockedNotice } from '../../prompts/objectiveWakes.ts';
import {
  TowerProtocolError,
  currentMilestone,
  objectiveMissions,
  sortedMilestones,
  type TowerObjective,
  type TowerObjectiveLimitsInput,
  type TowerObjectiveUpdateResult,
  type TowerStore,
} from '../../protocol/index.ts';
import {
  isMainAgent,
  objectiveSettingsOf,
  runTowerTool,
  skippedValidationKinds,
  type TowerCaller,
  type TowerObjectiveSettingsView,
  type TowerTool,
  type TowerToolHost,
  type TowerToolResult,
} from '../support.ts';
import {
  TowerObjectiveToolInputSchema,
  appendedMilestoneIds,
  milestoneInput,
  planObjectiveUpdate,
  resolveMilestoneSlots,
  towerObjectiveInputProblem,
  type TowerObjectiveToolInput,
} from './objective.ts';
import { objectiveMilestoneLines, renderObjectiveDashboard } from './views.ts';

export function createTowerObjectiveTool(
  host: TowerToolHost,
  caller: TowerCaller,
): TowerTool<typeof TowerObjectiveToolInputSchema> {
  return {
    name: 'TowerObjective',
    label: 'Tower Objective',
    description: TOWER_OBJECTIVE_DESCRIPTION,
    parameters: TowerObjectiveToolInputSchema,
    async run(args) {
      if (!isMainAgent(caller)) return { isError: true, output: TOWER_MAIN_AGENT_ONLY };
      const problem = towerObjectiveInputProblem(args);
      if (problem !== undefined) return { output: problem, isError: true };
      return runTowerTool(async () => {
        if (args.action !== 'status' && !host.isActive) {
          return { output: TOWER_MODE_USER_ENABLED_ONLY, isError: true };
        }
        const settings = objectiveSettingsOf(host);
        const store = host.store();
        switch (args.action) {
          case 'draft':
            return draft(store, args, settings);
          case 'update':
            return update(store, args, settings);
          case 'request-approval':
            return requestApproval(store, settings);
          case 'status':
            return status(host, store, settings);
          case 'block':
            return block(store, args.reason ?? '');
        }
      });
    },
  };
}

export function objectiveLimitsFrom(settings: TowerObjectiveSettingsView): TowerObjectiveLimitsInput {
  return {
    maxValidationRounds: settings.maxValidationRounds,
    maxFeatureAttempts: settings.maxFeatureAttempts,
    ...(settings.maxWallTimeMs === undefined ? {} : { maxWallTimeMs: settings.maxWallTimeMs }),
    ...(settings.maxCostUsd === undefined ? {} : { maxCostUsd: settings.maxCostUsd }),
  };
}

async function draft(
  store: TowerStore,
  args: TowerObjectiveToolInput,
  settings: TowerObjectiveSettingsView,
): Promise<TowerToolResult> {
  const objective = await store.draftObjective({
    title: args.title ?? '',
    ...(args.goal === undefined ? {} : { goal: args.goal }),
    ...(args.definition_of_done === undefined ? {} : { definitionOfDone: args.definition_of_done }),
    ...(args.acceptance_commands === undefined
      ? {}
      : { acceptanceCommands: args.acceptance_commands }),
    ...(args.milestones === undefined ? {} : { milestones: args.milestones.map(milestoneInput) }),
    ...(args.note === undefined ? {} : { notes: [args.note] }),
    limits: objectiveLimitsFrom(settings),
  });
  const first = sortedMilestones(objective)[0];
  return {
    output: [
      `objective ${objective.id} drafted: "${objective.title}" — status ${objective.status}`,
      ...contractSummary(objective, skippedValidationKinds(settings)),
      '',
      first === undefined
        ? 'Next: add the ordered milestones with TowerObjective(action="update", milestones=[...]), plan the features of every milestone with TowerPlan(milestone=...), then hand the plan to the human with TowerObjective(action="request-approval").'
        : `Next: plan the features of every milestone up front, starting with TowerPlan(milestone="${first.id}") — small features with disjoint scopes, so each milestone runs them in parallel — refine the plan with TowerObjective(action="update"), then hand it to the human with TowerObjective(action="request-approval").`,
    ].join('\n'),
  };
}

async function update(
  store: TowerStore,
  args: TowerObjectiveToolInput,
  settings: TowerObjectiveSettingsView,
): Promise<TowerToolResult> {
  const state = await store.load();
  const before = state.objective;
  if (before === undefined) {
    throw new TowerProtocolError('there is no objective to update — draft one first');
  }
  const plan = planObjectiveUpdate(before, args);
  const first = await store.updateObjective(plan.input);
  let result: TowerObjectiveUpdateResult = first;
  if (plan.slots !== undefined) {
    const order = resolveMilestoneSlots(plan.slots, appendedMilestoneIds(first.changes));
    if (order === undefined) {
      return {
        isError: true,
        output: `objective ${first.objective.id} was updated (${first.changes.join(', ')}), but the new milestones could not be placed: the store did not report one appended milestone per new item — read the order with TowerObjective(action="status") and pass the complete ordered list again`,
      };
    }
    try {
      const second = await store.updateObjective({ milestoneOrder: order });
      result = {
        objective: second.objective,
        contractChanged: first.contractChanged || second.contractChanged,
        changes: [...first.changes, ...second.changes],
        reopened: [...new Set([...first.reopened, ...second.reopened])],
      };
    } catch (error) {
      if (!(error instanceof TowerProtocolError)) throw error;
      return {
        isError: true,
        output: `objective ${first.objective.id} was updated (${first.changes.join(', ')}) with the new milestones appended at the end, but moving them into place failed: ${error.message} — pass the complete ordered list again`,
      };
    }
  }
  const objective = result.objective;
  if (result.changes.length === 0) {
    return {
      output: `objective ${objective.id} unchanged — everything you passed already matches the stored plan (status ${objective.status})`,
    };
  }
  const lines = [
    `objective ${objective.id} updated: ${result.changes.join(', ')} — status ${objective.status}`,
  ];
  if (result.contractChanged && objective.approvalReason === 'contract-changed') {
    lines.push(
      `The validation contract changed after approval, so objective ${objective.id} is awaiting approval again: no new work starts until the human approves the revised plan in the approval dialog or with /mission approve. Tell the human what changed and why.`,
    );
  } else if (result.contractChanged && objective.status === 'awaiting-approval') {
    lines.push(
      `Objective ${objective.id} is awaiting approval and the human approves the plan as it is now: tell the human what changed — TowerObjective(action="request-approval") returns the revised approval request.`,
    );
  }
  if (result.reopened.length > 0) {
    lines.push(
      `Reopened for validation under the changed contract: ${result.reopened.join(', ')}.`,
    );
  }
  lines.push(...contractSummary(objective, skippedValidationKinds(settings)));
  return { output: lines.join('\n') };
}

async function requestApproval(
  store: TowerStore,
  settings: TowerObjectiveSettingsView,
): Promise<TowerToolResult> {
  const { objective, estimatedRuns } = await store.requestObjectiveApproval();
  const state = await store.load();
  const features = objectiveMissions(state).filter((mission) => mission.status !== 'abandoned');
  const text = approvalRequest({
    objective,
    milestones: objective.milestones,
    features,
    ...(objective.approvalReason === undefined ? {} : { approvalReason: objective.approvalReason }),
    notes: objective.notes,
    skipKinds: skippedValidationKinds(settings),
  });
  return {
    output: [
      `objective ${objective.id} is now awaiting approval (estimated runs ≈ ${String(estimatedRuns)}). Only the human approves — in the approval dialog or with /mission approve, or auto-approval when the human configured it; never approve or claim approval on the human's behalf. No feature starts before approval: end your turn after presenting the plan.`,
      '',
      'Approval request shown to the human:',
      '',
      text,
    ].join('\n'),
  };
}

async function status(
  host: TowerToolHost,
  store: TowerStore,
  settings: TowerObjectiveSettingsView,
): Promise<TowerToolResult> {
  const state = await store.load();
  const objective = state.objective;
  if (objective === undefined) {
    return {
      isError: true,
      output: 'there is no objective in this workspace — draft one with TowerObjective(action="draft", title=..., goal=..., definition_of_done=[...], milestones=[...])',
    };
  }
  return {
    output: renderObjectiveDashboard(state, objective, {
      activeAgentIds: host.activeAgentIds(),
      skipKinds: skippedValidationKinds(settings),
    }),
  };
}

async function block(store: TowerStore, reason: string): Promise<TowerToolResult> {
  const objective = await store.blockObjective(reason);
  const milestone = currentMilestone(objective);
  const failures =
    milestone === undefined
      ? []
      : milestone.rounds.filter((round) => round.verdict === 'fail').at(-1)?.failures ?? [];
  return {
    output: [
      `objective ${objective.id} is blocked — the autopilot starts no new work. The human decides how to continue and resumes with /mission resume. Notice for the human:`,
      '',
      objectiveBlockedNotice({
        objective,
        reason: objective.blockedReason ?? reason,
        ...(milestone === undefined
          ? {}
          : { milestone: { id: milestone.id, title: milestone.title, status: milestone.status } }),
        failures,
      }),
    ].join('\n'),
  };
}

function contractSummary(
  objective: TowerObjective,
  skipKinds: readonly PromptValidationKind[],
): string[] {
  return [
    `goal: ${objective.goal.length > 0 ? objective.goal : '(empty — set it with action="update")'}`,
    `definition of done: ${objective.definitionOfDone.length > 0 ? `${String(objective.definitionOfDone.length)} item(s)` : '(none yet — add at least one before request-approval)'}`,
    ...(objective.acceptanceCommands.length > 0
      ? [`acceptance commands: ${objective.acceptanceCommands.map((command) => `\`${command}\``).join(', ')}`]
      : []),
    'milestones (in order):',
    ...objectiveMilestoneLines(objective, skipKinds),
    ...(objective.notes.length > 0 ? [`notes: ${String(objective.notes.length)}`] : []),
  ];
}
