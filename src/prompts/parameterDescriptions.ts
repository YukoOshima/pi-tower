import type { TowerToolName } from './toolDescriptions.ts';

export const TOWER_PARAMETER_DESCRIPTIONS = {
  TowerInit: {
    base: 'Local branch that missions fork from and merge back into (e.g. "develop"). Defaults to the branch currently checked out in the main worktree. On an existing workspace an explicit base re-anchors it — allowed anytime, even with open missions, whose branches then rebase onto the new base before merging. Remote-tracking refs (e.g. "origin/main") and tags are not accepted — create a local branch first.',
  },
  TowerPlan: {
    title:
      'Short mission title; becomes the branch/worktree slug. Printable ASCII English only — any non-ASCII character is rejected. Include a unique identifier word (a business code, a module name, a ticket id).',
    scope:
      'Files/globs this mission may touch (e.g. "src/build/**"). Scopes of different build missions should be disjoint; when they overlap, the store auto-adds a dependency that serializes their merges.',
    tasks:
      'Checklist the worker will tick off via TowerMission task_done — write each task as a verifiable item a reviewer can map to the diff',
    context:
      "The user's own key sentences about this mission, copied verbatim — the tower's paraphrase supplements them, never replaces them. Fill this whenever the requirement could be misread; never paste the full conversation history.",
    deps: 'Mission ids (e.g. "M1") that must merge before this one can merge',
    kind: '"survey" = read-only investigation: the scope is informational and reserves nothing (other missions may overlap it), the worker must not change code, and closing it needs no review or git merge. Default "build".',
  },
  TowerSpawn: {
    name: 'Unique tower name for the agent (e.g. "agent-build", "reviewer-a"). Used for inbox addressing and mission ownership.',
    kind: 'workers execute a mission in their worktree; reviewers review one branch',
    model:
      'Model for this new spawn: one of the choices listed under "Available models" in this tool description — "orchestrator" (or "primary") for the tower\'s own model, "worker", "reviewer", or a configured pool alias. Pass this only when the user explicitly requests a model; when omitted, workers use the worker model and reviewers use the reviewer model, each falling back to the orchestrator model when unset.',
    mission_id: 'Required for workers: the mission id (e.g. "M1") from TowerPlan',
    review_target: 'Required for reviewers: the branch to review (e.g. "feat/vulkan-build")',
    instructions: 'Extra tower instructions appended to the generated briefing',
  },
  TowerMerge: {
    branch: 'The mission branch to merge into the base branch (e.g. "feat/vulkan-build")',
  },
  TowerRebase: {
    mission: 'Mission id (e.g. "M3") whose branch should be rebased onto the current base',
  },
  TowerTeardown: {
    force:
      'Remove worktrees even when they contain uncommitted changes — a worktree whose roster agent is still running is kept regardless',
    exclude: 'Worktree names to keep — they are skipped and reported, whatever their state',
    dry_run:
      'Print the would-remove / would-keep list with reasons without changing anything on disk or in state',
  },
  TowerComplete: {
    report: 'Full completion report for the tower and the next review round',
  },
  TowerSend: {
    to: 'Recipient: a roster agent name, "tower", or "all" (broadcast)',
    subject: 'One-line subject; keep it greppable',
    body: 'Full message body (markdown)',
    scope: 'Optional scope tag (e.g. the mission id)',
    action: 'Optional action tag for machine routing',
    consent_ref: 'Optional reference to a consent/approval record this message relies on',
  },
  TowerInbox: {
    limit: 'Max messages to return (default 20), newest first',
    include_read:
      'Include previously acknowledged messages for history lookup; only returned messages are acknowledged',
  },
  TowerFinding: {
    type: 'Finding category',
    title: 'Short finding title',
    summary: 'What was found, in a sentence or two',
    location: 'File/symbol the finding concerns',
    details: 'Full details: evidence, reproduction, impact',
    suggested_fix: 'What you would do about it',
  },
  TowerReview: {
    target: 'The branch you were assigned to review',
    status:
      'Verdict: "clean", or "p1-Nitems" / "p2-Nitems" with the number of findings at that priority',
    merge: 'Merge recommendation for the tower',
    findings: 'Full findings text (markdown); write "none" when clean',
    checks: 'Checklist items you verified (e.g. "tests pass", "no secrets")',
    decision: 'The reasoning behind your verdict',
  },
  TowerMission: {
    id: 'Mission id (e.g. "M1")',
    status:
      'New lifecycle status. Workers may update only their own mission. "abandoned" is tower-only and gives the mission up without merging. "merged" cannot be set here; only TowerMerge records it after the merge gate succeeds. Merged and abandoned are terminal and cannot be reopened by a generic patch.',
    note: 'Append a decision-log note',
    blocker: 'Report a blocker (also sets status to blocked)',
    clear_blockers: 'Clear all recorded blockers',
    task_done: 'Mark the first open task containing this text as done',
    task_drop:
      'Mark the first open task containing this text as dropped — the escape hatch for legitimately descoped tasks; requires task_drop_reason and is recorded in the mission notes and the activity log',
    task_drop_reason: 'Mandatory with task_drop: why the task is legitimately descoped',
    scope:
      'Tower only: replace the mission scope globs (picomatch — `**` crosses directories). Logged; widens what the merge gate accepts.',
  },
  TowerStatus: {},
  TowerResume: {
    agent:
      'Roster name (e.g. "agent-build") or agent id of the tower worker to resume — not a task id. Reviewers and agents stopped by the human are refused.',
    prompt:
      'The message the resumed worker receives as its next turn — what to pick up, deliver, or redo; it keeps its full prior context',
  },
  TowerTasks: {
    active_only: 'Whether to list only running agents (default true).',
  },
  TowerTaskOutput: {
    agent: 'Roster name, agent id, or task id of the tower agent to inspect.',
  },
  TowerTaskStop: {
    agent: 'Roster name, agent id, or task id of the running tower agent to stop.',
    reason: 'Short reason recorded when the agent is stopped.',
  },
} as const satisfies Readonly<Record<TowerToolName, Readonly<Record<string, string>>>>;
