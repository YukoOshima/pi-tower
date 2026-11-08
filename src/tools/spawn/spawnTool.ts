import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  REVIEW_HISTORY_ROUNDS,
  REVIEW_REQUEST_SCAN_LIMIT,
  TOWER_MAIN_AGENT_ONLY,
  TOWER_MODE_USER_ENABLED_ONLY,
  buildReviewerBriefing,
  buildWorkerBriefing,
  duplicateAgentRefusal,
  renderSpawnResult,
  spawnSnapshotNote,
  spawnTaskDescription,
  towerSpawnDescription,
  worktreeSetupWarning,
  type BriefingReview,
} from '../../prompts/index.ts';
import {
  GitError,
  MISSIONS_DIR,
  TOWER_NAME,
  TowerProtocolError,
  WORKTREES_DIR,
  isReservedTowerAgentName,
  missionFileName,
  parseFrontmatter,
  resolveMissionByBranch,
  type TowerInboxItem,
  type TowerMission,
  type TowerReviewInfo,
  type TowerRosterEntry,
  type TowerState,
  type TowerStore,
} from '../../protocol/index.ts';
import {
  isMainAgent,
  type TowerCaller,
  type TowerSpawnBinding,
  type TowerTool,
  type TowerToolHost,
  type TowerToolResult,
} from '../support.ts';
import {
  TowerSpawnToolInputSchema,
  towerSpawnInputProblem,
  type TowerSpawnToolInput,
} from './spawn.ts';

export function createTowerSpawnTool(
  host: TowerToolHost,
  caller: TowerCaller,
  modelLines?: string,
): TowerTool<typeof TowerSpawnToolInputSchema> {
  return {
    name: 'TowerSpawn',
    label: 'Tower Spawn',
    description: towerSpawnDescription(modelLines),
    parameters: TowerSpawnToolInputSchema,
    async run(args) {
      const problem = towerSpawnInputProblem(args);
      if (problem !== undefined) return { output: problem, isError: true };
      if (!isMainAgent(caller)) return { isError: true, output: TOWER_MAIN_AGENT_ONLY };
      try {
        return await spawn(host, args);
      } catch (error) {
        if (error instanceof TowerProtocolError || error instanceof GitError) {
          return { output: error.message, isError: true };
        }
        throw error;
      }
    },
  };
}

async function spawn(host: TowerToolHost, args: TowerSpawnToolInput): Promise<TowerToolResult> {
  if (!host.isActive) return { output: TOWER_MODE_USER_ENABLED_ONLY, isError: true };
  const store = host.store();
  const state = await store.load();

  if (args.name.trim().length === 0 || args.name.trim() !== args.name) {
    return {
      output: `tower agent name "${args.name}" must not be blank or carry surrounding whitespace`,
      isError: true,
    };
  }
  if (isReservedTowerAgentName(args.name)) {
    return {
      output: `tower agent name "${args.name}" is reserved by the tower protocol — pick a different name`,
      isError: true,
    };
  }

  const existing = store.findByName(state, args.name);
  if (existing !== undefined) {
    return { output: duplicateRefusal(host, args.name, existing), isError: true };
  }

  let mission: TowerMission | undefined;
  let reviewTarget: string | undefined;
  if (args.kind === 'worker') {
    const missionId = args.mission_id;
    if (missionId === undefined) return { output: 'worker spawns require mission_id', isError: true };
    mission = state.missions.find((candidate) => candidate.id === missionId);
    if (mission === undefined) {
      const known = state.missions.map((candidate) => candidate.id).join(', ');
      return {
        output: `unknown mission "${missionId}" — known missions: ${known.length > 0 ? known : '(none planned yet)'}`,
        isError: true,
      };
    }
    if (mission.status === 'merged' || mission.status === 'abandoned') {
      return {
        output: `mission ${mission.id} is ${mission.status} — terminal missions cannot spawn workers; no worktree or agent was created`,
        isError: true,
      };
    }
  } else {
    reviewTarget = args.review_target;
    if (reviewTarget === undefined) {
      return { output: 'reviewer spawns require review_target', isError: true };
    }
  }
  const leaseBranch = mission?.branch ?? reviewTarget;
  if (leaseBranch === undefined) {
    throw new TowerProtocolError('tower spawn could not resolve the branch lease');
  }

  const resolution = await host.resolveSpawnModel(args.kind, args.model);
  if (!resolution.ok) return { output: resolution.error, isError: true };
  const binding = resolution.binding;

  return host.withBranchLease(leaseBranch, async () => {
    const notes: string[] = [];
    if (mission !== undefined) {
      try {
        const added = await store.addWorktree(mission.worktree, mission.branch, state.base);
        if (added.spawnBase !== undefined) {
          await store.updateMission(
            TOWER_NAME,
            mission.id,
            { spawnBase: added.spawnBase },
            { silent: true },
          );
          mission = { ...mission, spawnBase: added.spawnBase };
          notes.push(spawnSnapshotNote(added.spawnBase));
        }
      } catch (error) {
        if (error instanceof TowerProtocolError) throw error;
        notes.push(worktreeSetupWarning(error instanceof Error ? error.message : String(error)));
      }
    }

    const reviewMission =
      reviewTarget !== undefined ? resolveMissionByBranch(state, reviewTarget) : undefined;
    const prompt =
      mission !== undefined
        ? await buildWorkerPrompt(store, state, args, mission)
        : await buildReviewerPrompt(store, state, args, reviewTarget ?? '', reviewMission);
    const description = spawnTaskDescription({
      name: args.name,
      ...(mission === undefined ? {} : { mission: { id: mission.id, title: mission.title } }),
      ...(reviewTarget === undefined ? {} : { reviewTarget }),
      ...(reviewMission === undefined ? {} : { reviewMissionId: reviewMission.id }),
    });
    const worktreePath =
      mission === undefined ? undefined : store.abs(join(WORKTREES_DIR, mission.worktree));

    const launched = await host.launchAgent({
      name: args.name,
      kind: args.kind,
      description,
      cwd: worktreePath ?? store.repoRoot,
      prompt,
      ...(binding === undefined ? {} : { binding }),
    });
    if (!launched.ok) return { output: launched.reason, isError: true };

    const launchedInfo = host.agentInfo(launched.agentId);
    const model = binding?.model ?? launchedInfo?.model;
    try {
      await store.registerSpawnedAgent(
        {
          name: args.name,
          agentId: launched.agentId,
          sessionId: host.sessionId,
          kind: args.kind,
          ...(mission === undefined ? {} : { missionId: mission.id }),
          ...(reviewTarget === undefined ? {} : { reviewTarget }),
          ...(reviewMission === undefined ? {} : { reviewMissionId: reviewMission.id }),
          ...(mission === undefined ? {} : { worktree: mission.worktree, branch: mission.branch }),
          ...(model === undefined ? {} : { model }),
          cwd: worktreePath ?? store.repoRoot,
          spawnedAt: new Date().toISOString(),
        },
        mission === undefined ? undefined : { id: mission.id, owner: args.name },
      );
    } catch (error) {
      await host.abortAgent(launched.agentId);
      throw error;
    }
    host.agentRegistered(launched.agentId);

    const settled = host.agentInfo(launched.agentId);
    if (settled !== undefined && settled.status !== 'running' && settled.status !== 'idle') {
      await store.markAgentDied(
        launched.agentId,
        settled.status,
        settled.stopReason,
        host.sessionId,
      );
    }
    const thinkingLevel = settled?.thinkingLevel ?? binding?.thinkingLevel;
    await store.appendLog(
      TOWER_NAME,
      'spawn',
      {
        name: args.name,
        kind: args.kind,
        agent: launched.agentId,
        mission: mission?.id,
        target: reviewTarget,
        model,
        thinking: thinkingLevel,
      },
      mission !== undefined ? join(MISSIONS_DIR, missionFileName(mission.id, mission.slug)) : undefined,
    );

    return {
      output: renderSpawnResult({
        name: args.name,
        kind: args.kind,
        agentId: launched.agentId,
        taskId: launched.taskId,
        ...(model === undefined ? {} : { model: describeModel(model, thinkingLevel) }),
        ...(mission === undefined || worktreePath === undefined
          ? { reviewTarget: reviewTarget ?? '' }
          : {
              mission: {
                id: mission.id,
                title: mission.title,
                branch: mission.branch,
                worktreePath,
              },
            }),
        notes,
      }),
    };
  });
}

function duplicateRefusal(host: TowerToolHost, name: string, existing: TowerRosterEntry): string {
  if (host.agentInfo(existing.agentId) === undefined && existing.sessionId === host.sessionId) {
    return `tower agent "${name}" is already registered (agent_id: ${existing.agentId}, kind: ${existing.kind}) but is not running in this process — the tower restarted, so it cannot be resumed; pick a new name and spawn a fresh ${existing.kind} instead`;
  }
  return duplicateAgentRefusal(name, existing);
}

export function describeModel(model: string, thinkingLevel: string | undefined): string {
  return thinkingLevel === undefined ? model : `${model} (thinking ${thinkingLevel})`;
}

export function bindingLabel(binding: TowerSpawnBinding): string {
  return describeModel(binding.model, binding.thinkingLevel);
}

async function readMissionText(store: TowerStore, mission: TowerMission): Promise<string> {
  return readFile(store.abs(join(MISSIONS_DIR, missionFileName(mission.id, mission.slug))), 'utf8');
}

async function readReviewBody(store: TowerStore, review: TowerReviewInfo): Promise<string> {
  return parseFrontmatter(await readFile(store.abs(review.file), 'utf8')).body;
}

function towerInbox(store: TowerStore): Promise<readonly TowerInboxItem[]> {
  return store.readInbox(TOWER_NAME, REVIEW_REQUEST_SCAN_LIMIT);
}

async function buildWorkerPrompt(
  store: TowerStore,
  state: TowerState,
  args: TowerSpawnToolInput,
  mission: TowerMission,
): Promise<string> {
  const missionText = await readMissionText(store, mission);
  const latest = mission.kind === 'survey' ? undefined : await store.latestReview(mission.branch);
  const predecessor =
    mission.owner !== undefined && mission.owner !== args.name ? mission.owner : undefined;
  return buildWorkerBriefing({
    name: args.name,
    mission: {
      id: mission.id,
      kind: mission.kind,
      branch: mission.branch,
      scope: mission.scope,
      ...(mission.spawnBase === undefined ? {} : { spawnBase: mission.spawnBase }),
      ...(mission.owner === undefined ? {} : { owner: mission.owner }),
    },
    missionText,
    worktreePath: store.abs(join(WORKTREES_DIR, mission.worktree)),
    repoRoot: store.repoRoot,
    base: state.base,
    ...(args.instructions === undefined ? {} : { instructions: args.instructions }),
    ...(latest === undefined ? {} : { latestReview: await briefingReview(store, latest) }),
    ...(predecessor === undefined || mission.kind === 'survey'
      ? {}
      : { towerInbox: await towerInbox(store) }),
  });
}

async function buildReviewerPrompt(
  store: TowerStore,
  state: TowerState,
  args: TowerSpawnToolInput,
  target: string,
  targetMission: TowerMission | undefined,
): Promise<string> {
  const reviewBase =
    targetMission !== undefined ? await store.diffBase(state, targetMission) : state.base;
  const author = targetMission?.owner;
  const reviews = await store.reviewsFor(target);
  const recentFrom = Math.max(0, reviews.length - REVIEW_HISTORY_ROUNDS);
  const briefingReviews: BriefingReview[] = [];
  for (const [index, review] of reviews.entries()) {
    briefingReviews.push(
      index < recentFrom ? { ...reviewHeader(review), body: '' } : await briefingReview(store, review),
    );
  }
  return buildReviewerBriefing({
    name: args.name,
    target,
    reviewBase,
    repoRoot: store.repoRoot,
    ...(targetMission === undefined
      ? {}
      : { missionText: await readMissionText(store, targetMission) }),
    ...(author === undefined ? {} : { author, towerInbox: await towerInbox(store) }),
    reviews: briefingReviews,
    ...(args.instructions === undefined ? {} : { instructions: args.instructions }),
  });
}

function reviewHeader(review: TowerReviewInfo): Omit<BriefingReview, 'body'> {
  return {
    round: review.round,
    reviewer: review.reviewer,
    status: review.status,
    merge: review.merge,
  };
}

async function briefingReview(store: TowerStore, review: TowerReviewInfo): Promise<BriefingReview> {
  return { ...reviewHeader(review), body: await readReviewBody(store, review) };
}
