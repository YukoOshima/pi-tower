import { describe, expect, it } from 'vitest';

import {
  TOWER_COMPLETE_DESCRIPTION,
  TOWER_FINDING_DESCRIPTION,
  TOWER_INBOX_DESCRIPTION,
  TOWER_INIT_DESCRIPTION,
  TOWER_MERGE_DESCRIPTION,
  TOWER_MISSION_DESCRIPTION,
  TOWER_OBJECTIVE_DESCRIPTION,
  TOWER_PARAMETER_DESCRIPTIONS,
  TOWER_PLAN_DESCRIPTION,
  TOWER_REBASE_DESCRIPTION,
  TOWER_RESUME_DESCRIPTION,
  TOWER_REVIEW_DESCRIPTION,
  TOWER_SEND_DESCRIPTION,
  TOWER_SPAWN_DESCRIPTION,
  TOWER_STATUS_DESCRIPTION,
  TOWER_TASK_OUTPUT_DESCRIPTION,
  TOWER_TASK_STOP_DESCRIPTION,
  TOWER_TASKS_DESCRIPTION,
  TOWER_TEARDOWN_DESCRIPTION,
  TOWER_TOOL_DESCRIPTIONS,
  TOWER_VALIDATE_DESCRIPTION,
  towerSpawnDescription,
} from '../../src/prompts/index.ts';

const TOOL_NAMES = [
  'TowerInit',
  'TowerPlan',
  'TowerSpawn',
  'TowerMerge',
  'TowerRebase',
  'TowerTeardown',
  'TowerComplete',
  'TowerSend',
  'TowerInbox',
  'TowerFinding',
  'TowerReview',
  'TowerMission',
  'TowerStatus',
  'TowerResume',
  'TowerTasks',
  'TowerTaskOutput',
  'TowerTaskStop',
  'TowerObjective',
  'TowerValidate',
];

describe('TOWER_TOOL_DESCRIPTIONS', () => {
  it('describes exactly the nineteen tower tools by their registered names', () => {
    expect(Object.keys(TOWER_TOOL_DESCRIPTIONS)).toEqual(TOOL_NAMES);
  });

  it('maps every tool to its exported constant', () => {
    expect(TOWER_TOOL_DESCRIPTIONS).toEqual({
      TowerInit: TOWER_INIT_DESCRIPTION,
      TowerPlan: TOWER_PLAN_DESCRIPTION,
      TowerSpawn: TOWER_SPAWN_DESCRIPTION,
      TowerMerge: TOWER_MERGE_DESCRIPTION,
      TowerRebase: TOWER_REBASE_DESCRIPTION,
      TowerTeardown: TOWER_TEARDOWN_DESCRIPTION,
      TowerComplete: TOWER_COMPLETE_DESCRIPTION,
      TowerSend: TOWER_SEND_DESCRIPTION,
      TowerInbox: TOWER_INBOX_DESCRIPTION,
      TowerFinding: TOWER_FINDING_DESCRIPTION,
      TowerReview: TOWER_REVIEW_DESCRIPTION,
      TowerMission: TOWER_MISSION_DESCRIPTION,
      TowerStatus: TOWER_STATUS_DESCRIPTION,
      TowerResume: TOWER_RESUME_DESCRIPTION,
      TowerTasks: TOWER_TASKS_DESCRIPTION,
      TowerTaskOutput: TOWER_TASK_OUTPUT_DESCRIPTION,
      TowerTaskStop: TOWER_TASK_STOP_DESCRIPTION,
      TowerObjective: TOWER_OBJECTIVE_DESCRIPTION,
      TowerValidate: TOWER_VALIDATE_DESCRIPTION,
    });
  });

  it('keeps every description trimmed, non-empty, and separated by single blank lines', () => {
    for (const [name, text] of Object.entries(TOWER_TOOL_DESCRIPTIONS)) {
      expect(text.trim(), name).toBe(text);
      expect(text.length, name).toBeGreaterThan(80);
      expect(text, name).not.toMatch(/\n{3,}/);
    }
  });
});

describe('upstream tower tool descriptions', () => {
  it.each([
    [
      'TowerInit',
      TOWER_INIT_DESCRIPTION,
      [
        'Initialize a tower multi-agent workspace in the current repository.',
        'Only the user can enable it (`/tower on`); the agent can never enter tower mode by itself.',
        'Idempotent — an existing workspace is reported, never reset.',
        'roster entries the previous session spawned are retired (their agent ids cannot be resumed across sessions)',
        'only stale branches must rebase onto the new base before merging',
        'merges stay blocked until the checkout is switched to the base',
      ],
    ],
    [
      'TowerPlan',
      TOWER_PLAN_DESCRIPTION,
      [
        'Write tasks as verifiable check items',
        'copy the key sentences into `context` verbatim (when in doubt, include it)',
        'scopes of build missions must be pairwise disjoint or serialized by a dependency',
        'Titles must be printable ASCII English',
        'Plan once, then spawn one worker per mission with TowerSpawn.',
        'Scope globs do not capture semantic dependencies',
      ],
    ],
    [
      'TowerSpawn',
      TOWER_SPAWN_DESCRIPTION,
      [
        'Spawn a tower worker, reviewer, or validator as a background subagent and register it in the tower roster.',
        'the agent must submit its verdict via TowerReview',
        'pass model only when the user explicitly requests a model for this spawn; do not infer a selection from mission text or instructions',
        'A choice applies only to this new spawn: it does not change running or resumed agents and is not persisted on the mission.',
        'a worker respawned onto a reviewed branch gets the latest review round',
        "the tool captures them as a snapshot commit that becomes the mission branch's first commit",
        'Reviewers are one-shot: after diagnosing the previous round, give a fresh reviewer a new name instead of resuming a roster agent.',
        'Normal merge-bound reviews use this independent reviewer path.',
      ],
    ],
    [
      'TowerMerge',
      TOWER_MERGE_DESCRIPTION,
      [
        'Merge a tower mission branch into the base branch (--no-ff).',
        'Hard gate, enforced by the store',
        '`hold` and `fix-then-merge` are never approval',
        'otherwise `stale-base` — run TowerRebase for the mission first',
        "a merge never flips a historical mission's state",
        'it is aborted automatically — the checkout is never left mid-merge',
        'the result reports the workspace ready for TowerTeardown',
      ],
    ],
    [
      'TowerRebase',
      TOWER_REBASE_DESCRIPTION,
      [
        "- Refuses while the mission's worker is mid-turn or the worktree has uncommitted changes",
        'failed abort or recovery is reported as recovery-required',
        'Only the tower runs this tool; a worker rebases only when the tower asks it to.',
      ],
    ],
    [
      'TowerTeardown',
      TOWER_TEARDOWN_DESCRIPTION,
      [
        '(`live agent: <name>`) — this protection cannot be overridden, not even with force;',
        '- it contains uncommitted changes (`uncommitted changes`) — removed only when force is set.',
        'a dry run changes nothing on disk or in state',
        'Tower mode stays active after teardown',
        'is always kept as the audit trail',
      ],
    ],
    [
      'TowerComplete',
      TOWER_COMPLETE_DESCRIPTION,
      [
        'The tower and reviewers cannot use this tool.',
        'stores a `review-request` to the tower',
        'stores `survey-summary` instead',
        'A failed check writes no notification.',
        'delivers the report to the tower as a degraded completion message',
      ],
    ],
    [
      'TowerSend',
      TOWER_SEND_DESCRIPTION,
      [
        'Sending to yourself or to an unknown name is rejected — the error lists the known names.',
        'the in-flight tool call finishes first, steering never aborts it',
        'TowerComplete and TowerReview store their standard notifications automatically; do not repeat those with a manual TowerSend.',
        'a caller whose roster entry was lost is re-registered as a placeholder named after its agent id',
      ],
    ],
    [
      'TowerInbox',
      TOWER_INBOX_DESCRIPTION,
      [
        'only messages actually returned are acknowledged',
        'so keep reading until it reaches zero',
        'always finish every unread page before completing',
      ],
    ],
    [
      'TowerFinding',
      TOWER_FINDING_DESCRIPTION,
      ['Use this for anything notable OUTSIDE your mission scope — fixing it directly would violate scope isolation.'],
    ],
    [
      'TowerReview',
      TOWER_REVIEW_DESCRIPTION,
      [
        'A tower-submitted review is exceptional break-glass and must explicitly record reviewer=tower and the reason',
        'Closed missions never wake their former author.',
        'only a clean review with merge=merge on the exact tip is merge-ready; hold and fix-then-merge are not approval.',
      ],
    ],
    [
      'TowerMission',
      TOWER_MISSION_DESCRIPTION,
      [
        '"completed" means awaiting review, not done',
        'only TowerMerge records merged after its merge gate succeeds',
        'the tower is exempt from this check',
        'Tower only: status=abandoned gives a mission up without merging',
      ],
    ],
    [
      'TowerStatus',
      TOWER_STATUS_DESCRIPTION,
      [
        'Worker runtime that cannot be observed authoritatively is shown as unknown, not idle.',
        'report the history loss to the user when you see either',
        'rather than mechanically after every wake',
      ],
    ],
  ])('%s keeps its protocol sentences', (_name, text, sentences) => {
    for (const sentence of sentences) expect(text).toContain(sentence);
  });
});

describe('pi adaptations of upstream descriptions', () => {
  it('describes three configurable spawn roles instead of the secondary pool', () => {
    expect(TOWER_SPAWN_DESCRIPTION).toContain(
      "The allowed choices are the three configurable roles — orchestrator (also accepted as primary: the tower's own model), worker, and reviewer — plus any optional pool aliases configured for the tower, not arbitrary provider/model ids.",
    );
    expect(TOWER_SPAWN_DESCRIPTION).toContain(
      'When model is omitted, workers use the worker model and reviewers use the reviewer model, each falling back to the orchestrator model when unset; the role models come from tower.json, environment variables, or CLI flags.',
    );
    expect(TOWER_SPAWN_DESCRIPTION).not.toContain('[default]');
  });

  it('states where spawned workers and reviewers run', () => {
    expect(TOWER_SPAWN_DESCRIPTION).toContain(
      "starts the worker's session with that worktree as its working directory",
    );
    expect(TOWER_SPAWN_DESCRIPTION).toContain('the reviewer works read-only in the main checkout');
  });

  it('routes duplicate worker names to TowerResume', () => {
    expect(TOWER_SPAWN_DESCRIPTION).toContain(
      'If a worker name is already registered, resume it with TowerResume(agent="<name>", prompt="...") instead of spawning a duplicate — TowerResume always runs it in the background.',
    );
  });

  it('routes urgent directives through TowerTaskStop and TowerResume', () => {
    expect(TOWER_SEND_DESCRIPTION).toContain(
      '(no running task — resume the agent with TowerResume to deliver it)',
    );
    expect(TOWER_SEND_DESCRIPTION).toContain(
      'stop the recipient with TowerTaskStop and resume it with the message via TowerResume instead',
    );
  });
});

describe('towerSpawnDescription', () => {
  it('returns the static description when no model list is rendered', () => {
    expect(towerSpawnDescription()).toBe(TOWER_SPAWN_DESCRIPTION);
    expect(towerSpawnDescription('   \n')).toBe(TOWER_SPAWN_DESCRIPTION);
  });

  it('appends the rendered model list after a blank line', () => {
    const models =
      'Available models (pass via model):\n- orchestrator (= anthropic/claude-opus)\n- worker [worker default]: anthropic/claude-haiku';
    expect(towerSpawnDescription(`${models}\n`)).toBe(`${TOWER_SPAWN_DESCRIPTION}\n\n${models}`);
  });
});

describe('pi agent-management tool descriptions', () => {
  it('describes TowerResume as an always-background roster resume with its refusals', () => {
    for (const sentence of [
      'Resume a tower worker from the roster with a new prompt',
      'Pass `agent` as the worker\'s roster name (e.g. "agent-build") or its agent id — not a task id — and `prompt` as the message it receives next.',
      'The resume always runs in the background',
      'resume only for a transient cause (lost contact, timeout, OOM), and fix or escalate a systematic cause (code or environment defect) to the human before any revive',
      'The tool refuses, and starts no agent, when:',
      '- the agent is still running — redirect it with TowerSend instead',
      '- its branch is leased by a TowerMerge or TowerRebase in progress — retry after that operation finishes;',
      '- it is a reviewer — reviewers are one-shot',
      '- the human stopped it — an agent stopped by the human is dead by intent and is never resumed',
      'agent ids cannot be resumed across sessions',
    ]) {
      expect(TOWER_RESUME_DESCRIPTION).toContain(sentence);
    }
  });

  it('describes TowerTasks as a read-only listing of background agents', () => {
    expect(TOWER_TASKS_DESCRIPTION).toContain("List the tower's background agents");
    expect(TOWER_TASKS_DESCRIPTION).toContain('instead of guessing names or ids');
    expect(TOWER_TASKS_DESCRIPTION).toContain('`active_only=false`');
    expect(TOWER_TASKS_DESCRIPTION).toContain('This tool is read-only');
  });

  it('describes TowerTaskOutput as a non-blocking snapshot that must not be polled', () => {
    expect(TOWER_TASK_OUTPUT_DESCRIPTION).toContain('Retrieve a non-blocking snapshot');
    expect(TOWER_TASK_OUTPUT_DESCRIPTION).toContain('never call it in a tight loop');
  });

  it('describes TowerTaskStop as destructive and status-only for finished agents', () => {
    expect(TOWER_TASK_STOP_DESCRIPTION).toContain('Stop a running tower agent (worker or reviewer).');
    expect(TOWER_TASK_STOP_DESCRIPTION).toContain('- Stopping is destructive');
    expect(TOWER_TASK_STOP_DESCRIPTION).toContain('an agent stopped by the human is never resumed');
    expect(TOWER_TASK_STOP_DESCRIPTION).toContain(
      '- If the agent has already finished, this tool simply returns its current status.',
    );
  });
});

describe('TOWER_PARAMETER_DESCRIPTIONS', () => {
  it('covers every tool and describes every parameter with text', () => {
    expect(Object.keys(TOWER_PARAMETER_DESCRIPTIONS)).toEqual(TOOL_NAMES);
    for (const [tool, parameters] of Object.entries(TOWER_PARAMETER_DESCRIPTIONS)) {
      for (const [name, text] of Object.entries(parameters)) {
        expect(text.trim().length, `${tool}.${name}`).toBeGreaterThan(0);
      }
    }
    expect(TOWER_PARAMETER_DESCRIPTIONS.TowerStatus).toEqual({});
  });

  it('keeps upstream parameter wording', () => {
    expect(TOWER_PARAMETER_DESCRIPTIONS.TowerComplete.report).toBe(
      'Full completion report for the tower and the next review round',
    );
    expect(TOWER_PARAMETER_DESCRIPTIONS.TowerReview.status).toBe(
      'Verdict: "clean", or "p1-Nitems" / "p2-Nitems" with the number of findings at that priority',
    );
    expect(TOWER_PARAMETER_DESCRIPTIONS.TowerMission.task_drop_reason).toBe(
      'Mandatory with task_drop: why the task is legitimately descoped',
    );
    expect(TOWER_PARAMETER_DESCRIPTIONS.TowerSend.to).toBe(
      'Recipient: a roster agent name, "tower", or "all" (broadcast)',
    );
  });

  it('describes the spawn model choice in terms of the three roles', () => {
    const model = TOWER_PARAMETER_DESCRIPTIONS.TowerSpawn.model;
    expect(model).toContain('"Available models"');
    expect(model).toContain('"orchestrator" (or "primary")');
    expect(model).toContain('"worker", "reviewer", or a configured pool alias');
    expect(model).toContain('Pass this only when the user explicitly requests a model');
    expect(model).toContain('each falling back to the orchestrator model when unset');
  });

  it('names the identities the agent-management tools accept', () => {
    expect(TOWER_PARAMETER_DESCRIPTIONS.TowerResume.agent).toContain('not a task id');
    expect(TOWER_PARAMETER_DESCRIPTIONS.TowerTaskOutput.agent).toContain(
      'Roster name, agent id, or task id',
    );
    expect(TOWER_PARAMETER_DESCRIPTIONS.TowerTaskStop.agent).toContain(
      'Roster name, agent id, or task id',
    );
    expect(TOWER_PARAMETER_DESCRIPTIONS.TowerTasks.active_only).toContain('default true');
  });
});
