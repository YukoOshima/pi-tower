export type TowerToolName =
  | 'TowerInit'
  | 'TowerPlan'
  | 'TowerSpawn'
  | 'TowerMerge'
  | 'TowerRebase'
  | 'TowerTeardown'
  | 'TowerComplete'
  | 'TowerSend'
  | 'TowerInbox'
  | 'TowerFinding'
  | 'TowerReview'
  | 'TowerMission'
  | 'TowerStatus'
  | 'TowerResume'
  | 'TowerTasks'
  | 'TowerTaskOutput'
  | 'TowerTaskStop'
  | 'TowerObjective'
  | 'TowerValidate';

export const TOWER_INIT_DESCRIPTION = [
  'Initialize a tower multi-agent workspace in the current repository.',
  'Creates the .tower/ directory (comms state, inbox, findings, reviews, missions, activity log, worktree slots) that the full tower tool set operates on.',
  'Tower mode must already be active before you call this — while the mode is off this tool refuses, so ask the user to turn it on first. Only the user can enable it (`/tower on`); the agent can never enter tower mode by itself. Use tower only when a task is large enough to split across multiple parallel agents with isolated git worktrees and a review-gated merge protocol.',
  'Idempotent — an existing workspace is reported, never reset. Re-entering from a new CLI session adopts the workspace: roster entries the previous session spawned are retired (their agent ids cannot be resumed across sessions), while missions, worktrees, and the activity log carry over. Entering tower mode (`/tower on`) already runs this adoption; this tool stays the explicit way to re-assert it.',
  'Takes an optional `base`: the local branch that every mission forks from and merges back into (default: the branch currently checked out in the main worktree; a fresh init on a detached HEAD requires an explicit `base`). Missions, reviews, and the merge gate all evaluate against the recorded base. A re-init with no explicit base keeps the recorded one; a re-init with an explicit different base re-anchors the workspace to it — allowed anytime, even with open missions. Each open mission is then reported as up-to-date (its branch already contains the new base), stale (it does not and needs TowerRebase before merging), or no-branch (no branch exists yet); only stale branches must rebase onto the new base before merging. Only local branches are accepted (a remote-tracking ref such as "origin/main" cannot receive merges) — create a local branch first. When the base differs from the main checkout (or the checkout is detached), work proceeds normally but merges stay blocked until the checkout is switched to the base.',
].join('\n\n');

export const TOWER_PLAN_DESCRIPTION = [
  'Split the tower goal into missions. Each mission gets an id (M1, M2, …), a branch (feat/<slug>), and an isolated git worktree (.tower/worktrees/wt-N).',
  "Write tasks as verifiable check items — the worker ticks them off, the completion report reconciles against them item by item, and the reviewer maps every one to the diff. When the user's own words carry intent your paraphrase could lose, copy the key sentences into `context` verbatim (when in doubt, include it): context supplements your paraphrase, never replaces it, and travels with the mission into the worker and reviewer briefings. Do not paste the full conversation history into it.",
  'Rules enforced by the store: scopes of build missions must be pairwise disjoint or serialized by a dependency — for overlapping build scopes, the store auto-adds merge dependencies from later missions to earlier ones; workers still spawn and edit in parallel; survey missions are read-only and reserve no scope; deps must reference existing mission ids; and mission branches must be unique — a title whose slugged branch collides with any existing mission\'s branch (including abandoned or merged ones) or with an unowned local git branch is rejected, so rename the title and plan again. Titles must be printable ASCII English: a title containing any non-ASCII character (CJK, Cyrillic, Hangul, accented letters) is rejected outright, because non-ASCII text slugs to a generic word like "item" that collides across missions, while printable ASCII punctuation (spaces, "-", "_", "+") folds into the slug without losing words — include a unique identifier word (e.g. a business code like B010100). Plan once, then spawn one worker per mission with TowerSpawn. Requires an active tower workspace (run TowerInit first).',
  'Scope globs do not capture semantic dependencies; add explicit deps when a mission requires another mission to merge first.',
  'Objective mode: while an objective is open, every mission is a feature of exactly one milestone — pass milestone (e.g. "MS1") on each item; it is required then and must be omitted otherwise. The autopilot starts the features of the current milestone in parallel, each as soon as its deps are merged or abandoned (with the autopilot off, you spawn them yourself); features planned into later milestones wait until their milestone becomes current. After a failed validation, plan fix features into the milestone that failed with origin "fix" (default "plan"), one per failure or per tightly related group of failures: planning into a failed milestone reopens it, and validation re-runs once the fixes merge.',
].join('\n\n');

export const TOWER_SPAWN_DESCRIPTION = [
  'Spawn a tower worker, reviewer, or validator as a background subagent and register it in the tower roster.',
  "Workers: pass mission_id — the tool creates the mission worktree, starts the worker's session with that worktree as its working directory, marks the mission active with this worker as owner, and briefs the agent with the full mission text. Reviewers: pass review_target — the reviewer works read-only in the main checkout; when the branch belongs to a mission, the briefing carries the full mission text (title, tasks, and any verbatim user context) plus the author's own review-request when one is on file, so the review verifies intent against the mission, not only code health; the agent must submit its verdict via TowerReview.",
  'Validators (objective mode): pass kind="validator" with milestone and validation_kind ("scrutiny" or "user-testing"). The tool checks out a detached validation worktree at the current base tip and briefs the validator with the objective, the milestone\'s features and their tasks, the validated commit, and the failures of earlier rounds; the validator works read-only, never commits, and reports exactly once via TowerValidate. Validation starts automatically in both autopilot modes — the tower spawns validators itself; spawn one manually only to recover a round that keeps ending without a verdict (a validation-stuck wake). Validators are one-shot like reviewers: never resume one; every validation round gets a fresh validator under a new name.',
  "Model selection: pass model only when the user explicitly requests a model for this spawn; do not infer a selection from mission text or instructions. The allowed choices are the four configurable roles — orchestrator (also accepted as primary: the tower's own model), worker, reviewer, and validator — plus any optional pool aliases configured for the tower, not arbitrary provider/model ids. When model is omitted, workers use the worker model and reviewers use the reviewer model, each falling back to the orchestrator model when unset, and validators use the validator model, falling back to the reviewer model and then the orchestrator model; the role models come from tower.json, environment variables, or CLI flags. A choice applies only to this new spawn: it does not change running or resumed agents and is not persisted on the mission.",
  'When the branch already has history, the briefing carries it too: a worker respawned onto a reviewed branch gets the latest review round (verdict, findings, decision) and the previous worker\'s review-request, so rework continues from the verdict instead of starting cold; a reviewer gets the branch\'s earlier review rounds, so repeat findings are verified against the current tip rather than reported again. First spawns have no history sections. Note that a non-clean verdict flips a completed mission back to active — "completed" means awaiting review, while "merged" and "abandoned" are terminal.',
  "If the base checkout has uncommitted changes (staged, unstaged, or untracked) when a worker spawns, the tool captures them as a snapshot commit that becomes the mission branch's first commit — the worker starts from HEAD + that WIP instead of plain HEAD. The checkout itself is never touched (nothing is committed, staged, or stashed there), and the merge gate later diffs the branch from that snapshot while it remains part of the branch's history (falling back to the base branch once a rebase drops the snapshot commit), so the WIP is never mistaken for the worker's own scope. Snapshotting requires the main checkout to be on the recorded base branch: WIP sitting on a different branch (or a detached HEAD) belongs to that line of work, so the spawn is refused rather than mixing that content into the base — switch back to the base or commit/stash first. The snapshot only happens when the branch is first created; re-adding an existing branch reuses it as-is.",
  'The briefing prompt is assembled by this tool (worktree path, scope, protocol rules); use instructions only for extra context. If a worker name is already registered, resume it with TowerResume(agent="<name>", prompt="...") instead of spawning a duplicate — TowerResume always runs it in the background. Reviewers are one-shot: after diagnosing the previous round, give a fresh reviewer a new name instead of resuming a roster agent. Normal merge-bound reviews use this independent reviewer path.',
].join('\n\n');

export const TOWER_MERGE_DESCRIPTION = [
  'Merge a tower mission branch into the base branch (--no-ff).',
  'Hard gate, enforced by the store — the mission must be completed with no open tasks or blockers and every related worker observably idle; its latest applicable review must be "clean" with merge recommendation "merge" on the exact branch tip (`hold` and `fix-then-merge` are never approval; only a conflict-free TowerRebase can waive the tip binding), all dependency missions must be merged or abandoned, the branch must contain the current base tip (otherwise `stale-base` — run TowerRebase for the mission first), and every changed file must fall inside the mission\'s declared scope. Legacy clean reviews with no merge field retain their original compatibility. The merge also refuses when every mission record for the branch is closed (abandoned or already merged) — a merge never flips a historical mission\'s state; if the work must land, re-plan it under a fresh mission title. The scope diff starts from the mission\'s recorded spawn base while that spawn-time WIP snapshot commit is still in the branch\'s history, so the snapshot is not mistaken for a worker scope violation; once a rebase drops the snapshot (typically after the WIP lands on the base), the diff falls back to the base branch. On refusal, the error message tells you what to do next. After a merge, branches reported as conflicting must rebase onto the new base (TowerRebase, or the worker itself when it is mid-turn) before they can merge. If the git merge itself conflicts, it is aborted automatically — the checkout is never left mid-merge.',
  'The main checkout must be clean for the files the merge touches: uncommitted changes in any file the merge would overwrite refuse the merge, and nothing is merged — commit or stash those changes first, then retry. This matters especially when a mission branch carries a spawn-time WIP snapshot: those changes merge into the base history, so they must not also sit uncommitted in the checkout.',
  'When this merge closes the last open mission, the result reports the workspace ready for TowerTeardown.',
].join('\n\n');

export const TOWER_REBASE_DESCRIPTION = [
  "Rebase a mission branch onto the current base branch, inside the mission's own worktree.",
  "The tower uses this when `TowerMerge` refuses with `stale-base` (the base moved after the branch spawned) or after a merge reports branches that now conflict with the base. The rebase runs in the mission worktree on the base branch's latest commit:",
  [
    "- Refuses while the mission's worker is mid-turn or the worktree has uncommitted changes — rebasing under a running worker could race its edits.",
    '- Clean rebase → the branch tip moves; the old review keeps its exact-tip binding, but merge approval still requires a clean review with merge recommendation "merge" (never `hold` or `fix-then-merge`).',
    '- Conflict → only a rebase left in progress with actual unmerged paths is classified as a conflict: it is aborted with recovery postconditions checked, the files are reported, and the mission is marked blocked for the worker. Other errors are not mislabeled as conflicts; failed abort or recovery is reported as recovery-required.',
  ].join('\n'),
  'A rebase that drops the spawn-time WIP snapshot commit is expected — the diff then falls back to the base branch. Only the tower runs this tool; a worker rebases only when the tower asks it to.',
].join('\n\n');

export const TOWER_TEARDOWN_DESCRIPTION = [
  'Tear down the tower workspace after all missions are merged (or abandoned).',
  'Removes the mission worktrees and reports one line per worktree. A worktree is kept, with the reason in the report, when:',
  [
    '- its roster agent still has a running task in this session (`live agent: <name>`) — this protection cannot be overridden, not even with force;',
    '- it is named in exclude (`excluded`);',
    '- it contains uncommitted changes (`uncommitted changes`) — removed only when force is set.',
  ].join('\n'),
  'Worktrees git no longer knows are reported as already removed. Set dry_run to preview the exact remove/keep decisions with their reasons before committing to them; a dry run changes nothing on disk or in state.',
  'Tower mode stays active after teardown: the next objective starts with TowerInit, and the human turns the mode off explicitly with /tower off. The .tower/comms/ directory (state, inbox, findings, reviews, activity log) is always kept as the audit trail.',
].join('\n\n');

export const TOWER_COMPLETE_DESCRIPTION = [
  'Complete the mission owned by the calling tower worker and persist its standard completion notification in one locked protocol flow. The tower and reviewers cannot use this tool.',
  '`report` is required and must contain non-whitespace text. For a build mission, write the full implementation report, reconciled against every mission task; the tool records `completed` and stores a `review-request` to the tower. For a survey mission, report the complete investigation result; the tool records `completed` and stores `survey-summary` instead.',
  'Completion checks are part of the same flow: no open tasks or blockers, every unread inbox page read, a committed build diff, and a zero-diff survey branch. A failed check writes no notification. If notification storage fails after the mission was persisted, the result says so explicitly. Retrying with the same report reuses an already stored notification instead of silently writing a duplicate.',
  'If the tower state was lost (.tower/comms deleted while .tower/ survives), the mission record is gone, so no mission is marked completed: the tool recovers a minimal state stamped recoveredAt, delivers the report to the tower as a degraded completion message, and says so explicitly in the result.',
].join('\n\n');

export const TOWER_SEND_DESCRIPTION = [
  'Send an inbox message to a tower participant: a roster agent by name, "tower" (the control tower), or "all" (broadcast).',
  'Recipients read it with TowerInbox. Sending to yourself or to an unknown name is rejected — the error lists the known names.',
  'Delivery is push when the recipient is a roster agent mid-turn: the message is steered into its running turn as an injected directive, so it sees the new message at its next step boundary — the in-flight tool call finishes first, steering never aborts it — instead of at its next self-initiated inbox check. The tool result reports whether the message was steered, sits in the inbox of an idle agent, or is undeliverable (no running task — resume the agent with TowerResume to deliver it). If a directive genuinely cannot wait, stop the recipient with TowerTaskStop and resume it with the message via TowerResume instead — word the subject accordingly (e.g. "URGENT: stop and rebase") so the steer preview carries the priority. TowerComplete and TowerReview store their standard notifications automatically; do not repeat those with a manual TowerSend.',
  'If the tower state was lost (.tower/comms deleted while .tower/ survives), the send first recovers a minimal state stamped recoveredAt instead of failing, then delivers normally; a caller whose roster entry was lost is re-registered as a placeholder named after its agent id, and the result notes it.',
].join('\n\n');

export const TOWER_INBOX_DESCRIPTION =
  "Read your tower inbox: messages addressed to you plus broadcasts, newest first. The tower sees all messages. By default only the next unread page is returned, and only messages actually returned are acknowledged; the output reports how many unread messages remain, so keep reading until it reaches zero. Set include_read=true to look back through full history, including acknowledged messages; history pages also acknowledge only the messages they return. Full bodies are included — reply with TowerSend. The store refuses a roster agent's own TowerComplete while unread messages wait, so always finish every unread page before completing.";

export const TOWER_FINDING_DESCRIPTION = [
  'File a structured finding (bug / improve / vuln / idea) into .tower/comms/findings/ for the tower to route.',
  'Use this for anything notable OUTSIDE your mission scope — fixing it directly would violate scope isolation. Include enough detail that another agent can act on it without re-discovering the context.',
].join('\n\n');

export const TOWER_REVIEW_DESCRIPTION = [
  'Submit a review verdict for a branch you were assigned to review (via TowerSpawn review_target).',
  'The review is stamped with the current branch tip — if the branch moves afterwards, the tower must ask for a re-review before merging. Normal merge-bound reviews come from an assigned independent reviewer. A tower-submitted review is exceptional break-glass and must explicitly record reviewer=tower and the reason; it is not a convenience bypass. Only those reviewers (or the tower in that exceptional case) may submit; the round number is assigned automatically.',
  'The tool stores the standard review-result notifications in the same protocol flow: clean verdicts notify the tower; non-clean verdicts also notify a valid owner of an open mission, with a supervisory copy to the tower. Closed missions never wake their former author. Do not send a second manual TowerSend.',
  'The result lists the review file and actual recipients, then reports gate semantics: only a clean review with merge=merge on the exact tip is merge-ready; hold and fix-then-merge are not approval.',
].join('\n\n');

export const TOWER_MISSION_DESCRIPTION = [
  'Read or update a tower mission.',
  'With only an id, returns the mission view (status, tasks, blockers, notes). With patch fields, applies them: workers may only update the mission they own — the store rejects anything else. Use task_done to tick checklist items, task_drop (with task_drop_reason) to drop a legitimately descoped task — the reason is recorded in the mission notes and the activity log — note to log decisions, blocker when stuck (the tower watches for blocked missions).',
  'Status lifecycle: planned → active → completed → merged. "completed" means awaiting review, not done — the branch can still be sent back for rework: when a review with a non-clean verdict lands on the mission\'s branch, the store flips a completed mission back to active automatically (merged never flips; planned, blocked, and paused are left alone). Neither workers nor the tower can set status=merged through this tool: only TowerMerge records merged after its merge gate succeeds. Merged and abandoned are both terminal, so a generic patch cannot reopen either one. The store refuses the transition to completed while the mission has blockers or still has open (neither done nor dropped) tasks — the error identifies them — and, for build missions, while the mission branch has no committed diff vs its base. A survey mission may complete without a branch, but an existing survey branch must be zero-diff. A roster agent\'s own transition to completed is also refused while its inbox holds messages it has not read yet — the error names the unread count; read every unread page with TowerInbox and incorporate anything new into the delivery first (the tower is exempt from this check). Workers normally finish with TowerComplete(report), which runs these checks and stores the standard notification in the same lock; a generic status=completed patch remains the low-level compatibility operation.',
  'Tower only: status=abandoned gives a mission up without merging — its scope stops reserving files for TowerPlan, its dependents may merge, and its branch drops out of conflict checks. Use it for stale missions carried over from a previous session, or for work that will not land; abandoned missions stay in MISSIONS.md (🚫) as the audit trail and cannot be reopened.',
].join('\n\n');

export const TOWER_STATUS_DESCRIPTION =
  "Show the tower dashboard: missions (status/owner), the agent roster, and each unmerged mission's structured merge-gate state (ready/blocks with stable reason codes, selected review and exact-tip/clean-rebase-waived/stale-tip binding), your inbox message count, and the last activity log lines. Worker runtime that cannot be observed authoritatively is shown as unknown, not idle. Planned missions without a worker are called out in Awaiting spawn. If .tower/comms/state.json was deleted while .tower/ survives, this returns a state-lost report (and a recovered state is flagged with its recoveredAt marker) instead of failing — report the history loss to the user when you see either. Wakes already carry message references and a gate digest, so use this full dashboard for human-facing status or deeper diagnosis rather than mechanically after every wake.";

export const TOWER_RESUME_DESCRIPTION = [
  'Resume a tower worker from the roster with a new prompt: it continues its existing session and keeps its full prior context, so rework, delivered messages, and recovery pick up where it left off instead of starting cold.',
  'Pass `agent` as the worker\'s roster name (e.g. "agent-build") or its agent id — not a task id — and `prompt` as the message it receives next. The resume always runs in the background: the tool returns as soon as the run starts, the agent\'s completion arrives as a notification, and its inbox traffic wakes you, so continue with other work or end your turn instead of waiting or polling.',
  'Use it to deliver a message to a worker with no running turn (TowerSend reports it undeliverable), to continue a worker you stopped with TowerTaskStop, or to revive a worker whose run died. Diagnose a death first — its status, reason, and task state (TowerTasks, TowerTaskOutput, TowerStatus): resume only for a transient cause (lost contact, timeout, OOM), and fix or escalate a systematic cause (code or environment defect) to the human before any revive. A revived worker\'s in-flight tool call lost its result and may need to be redone — say so in the prompt (e.g. "Pick up where you left off; redo the last tool call if its result was never observed.").',
  'The tool refuses, and starts no agent, when:',
  [
    '- the agent is still running — redirect it with TowerSend instead; the message is steered into its running turn at the next step boundary;',
    '- its branch is leased by a TowerMerge or TowerRebase in progress — retry after that operation finishes;',
    '- it is a reviewer — reviewers are one-shot: after diagnosing the previous round, spawn a fresh reviewer with a new name via TowerSpawn;',
    '- the human stopped it — an agent stopped by the human is dead by intent and is never resumed; reassign or replace its work only when the human says so;',
    '- its roster entry was retired by a previous session — agent ids cannot be resumed across sessions; spawn a new worker for the mission with TowerSpawn.',
  ].join('\n'),
].join('\n\n');

export const TOWER_TASKS_DESCRIPTION = [
  "List the tower's background agents — workers and reviewers started by TowerSpawn or TowerResume — and their current status, including the roster name and agent id to pass to `TowerTaskOutput`, `TowerTaskStop`, or `TowerResume`.",
  'After context compaction, or whenever unsure which agents are running, call TowerTasks instead of guessing names or ids. By default only running agents are listed; with `active_only=false`, finished runs appear too (completed, failed, timed out, or stopped — including stops by the human); treat every agent that is not running as terminated for its last run.',
  'This tool is read-only and never wakes or changes an agent; it does not return agent output.',
].join('\n\n');

export const TOWER_TASK_OUTPUT_DESCRIPTION = [
  'Retrieve a non-blocking snapshot of a running or finished tower agent: its status, latest assistant text, recent tool calls, and usage — and, once a run has ended, its final message or stop reason.',
  "Use it after TowerSpawn or TowerResume to check progress, to read a finished agent's final message, or to diagnose a death before deciding whether to resume. Prefer automatic completion notifications and inbox wakes over polling: never call it in a tight loop, and when your next step depends on an agent finishing, end your turn — its completion notification wakes you.",
].join('\n\n');

export const TOWER_TASK_STOP_DESCRIPTION = [
  'Stop a running tower agent (worker or reviewer).',
  'Only use this when an agent must genuinely be cancelled — for an agent that is finishing normally, wait for its completion notification or inspect it with `TowerTaskOutput` instead of stopping it.',
  [
    'Guidelines:',
    "- Stopping is destructive: it aborts the agent's current run, its in-flight tool call loses its result, and it may leave partial side effects behind (uncommitted edits, a half-finished command). Use it with care.",
    '- To redirect a running agent, prefer TowerSend — the message is steered into its running turn at the next step boundary. Stop it and deliver the message with TowerResume only when a directive genuinely cannot wait.',
    '- The stop is recorded with its reason. A worker you stop can be resumed later with TowerResume; a reviewer is one-shot and is never resumed; an agent stopped by the human is never resumed.',
    '- If the agent has already finished, this tool simply returns its current status.',
  ].join('\n'),
].join('\n\n');

export const TOWER_OBJECTIVE_DESCRIPTION = [
  'Manage the tower objective: the end-to-end goal the fleet keeps working on until its validation contract is met. The objective is split into ordered milestones; the features of the current milestone run in parallel as ordinary tower missions (each with its own worker, independent review, and merge gate), and a milestone must pass validation before the next one starts. Orchestrator only — workers, reviewers, and validators cannot use this tool. At most one objective is open per workspace.',
  "The contract has four parts: a goal; a definition of done (verifiable items); optional acceptance commands (shell commands that must exit 0 on the final milestone); and ordered milestones, each with a validation spec — scrutiny (a validator reviews the milestone's merged diff against its features' tasks and runs typecheck/tests), user-testing (a validator exercises the product the way a user would, following qa_instructions), and commands (shell commands the tower runs itself, no model involved). Plan the features of a milestone with TowerPlan(milestone=\"MS1\").",
  'Actions:',
  [
    '- draft — create the objective while you plan it with the human: title, goal, definition_of_done, acceptance_commands, milestones, and optionally a first note. Refused while another objective is still open.',
    "- update — revise the plan: every draft field you pass replaces the stored one, and note appends a decision or assumption. milestones is the complete ordered list: keep a milestone by passing its id, add one by omitting the id, remove one by leaving it out. After approval, changing the contract (goal, definition_of_done, acceptance_commands, a milestone's validation spec, removing or reordering milestones) sends the objective back to awaiting-approval until the human approves again; appending milestones at the end and adding notes do not.",
    '- request-approval — hand the plan to the human. Requires a goal, at least one definition-of-done item, at least one milestone, and at least one build feature planned into the first milestone. The human receives the plan summary and an estimated run count (features + 2 × milestones) and approves with `/tower approve`.',
    '- status — show the objective dashboard: status, elapsed time, cost, every milestone with its features and validation rounds, live agents, and the next expected step.',
    '- block — stop the objective with reason when the work cannot converge (the same failure keeps coming back, or only the human can resolve it); the human is notified and decides whether to resume.',
  ].join('\n'),
  "There is no approve action: only the human approves (`/tower approve`), or auto-approval when the human configured it. Never approve, or claim approval, on the human's behalf. There is no complete action either: completion is automatic and gated — the objective completes only when every milestone has passed validation, no feature is still open, and the final milestone's passing rounds are stamped on the current base tip.",
  'Once approved, the autopilot drives the mechanics through the same tower tools and gates you use: it spawns workers, reviewers, and validators, rebases stale branches, merges gate-ready branches, starts validation, and advances milestones. With the autopilot off (objective.autopilot=false) you drive feature execution yourself — spawn workers and reviewers, rebase, merge — while validation start, milestone advancement, and completion stay automatic in both modes. You are woken only for judgment work — planning a milestone, planning fix features after a failed validation, answering blockers, routing conflicts and merge blocks, recovering stuck reviews and validations, and escalating to the human.',
].join('\n\n');

export const TOWER_VALIDATE_DESCRIPTION = [
  'Submit the verdict of the milestone validation you were assigned (via TowerSpawn kind="validator"). Validators only: workers, reviewers, and the orchestrator cannot use this tool, and the mechanical `commands` kind is recorded by the tower itself.',
  'Pass milestone (e.g. "MS1") and kind ("scrutiny" or "user-testing") exactly as your briefing names them; verdict "pass" only when every check in your briefing holds, otherwise "fail"; failures — one self-contained item per problem (what is wrong, where, how to reproduce, what was expected), at least one on fail and none on pass, because the orchestrator turns each failure into fix features; checks — what you verified; evidence — the commands you ran with their key output, and what you observed.',
  'The verdict is stamped with the commit your validation worktree was checked out at, as the next round for this milestone and kind (numbered automatically). The milestone passes only when the latest round of every required kind passes on the same commit; a round stamped on an older commit is stale, and validation re-runs on the new base tip.',
  'Call it exactly once, after you have finished checking. It writes the validation file under .tower/comms/validations/ and stores the standard validation-result notification to the tower in the same protocol flow — do not send a manual TowerSend. Your validation worktree is detached and read-only: never edit files or commit there; report problems as failures instead of fixing them.',
].join('\n\n');

export const TOWER_TOOL_DESCRIPTIONS: Readonly<Record<TowerToolName, string>> = {
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
};

export function towerSpawnDescription(modelLines?: string): string {
  const models = modelLines?.trim();
  return models === undefined || models.length === 0
    ? TOWER_SPAWN_DESCRIPTION
    : `${TOWER_SPAWN_DESCRIPTION}\n\n${models}`;
}
