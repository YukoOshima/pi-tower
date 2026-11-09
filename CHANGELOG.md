# Changelog

## [0.3.0] - 2026-11-10

Mission mode: `/mission` works like Factory's Droid Missions. You enter it, see the orchestrator, worker, reviewer and validator models, describe the goal, answer the orchestrator's questions, approve the plan, and follow the work in Mission Control until the mission completes and cleans up after itself. The one difference from Droid: the features of a milestone run in parallel, as a swarm. The `/tower` commands stay as the advanced, Kimi Code-compatible layer, with unchanged behaviour and replies.

### Added

- **`/mission` (alias `/missions`).** `/mission` turns tower mode on (with the same refusals as `/tower on`), switches the session to the orchestrator model, initializes the workspace on the current branch, and shows a header: the orchestrator, worker, reviewer and validator models with their thinking level and source (`same as reviewer` for an inherited validator), the base branch, the parallelism limit (`maxRunningAgents`), and "What do you want to build?".
  - The next plain message becomes the mission goal, with the effect of `/tower objective <text>`; a message that is just `@file` reads the goal from that file. `/mission <goal>` and `/mission @file` start planning directly.
  - A directory that is not a git repository, a repository without commits and a detached HEAD are refused with a hint.
  - With a mission open, `/mission` shows Mission Control instead: the models, the mission dashboard and the commands that fit its state.
  - Subcommands `approve`, `pause [reason]`, `resume`, `models [...]`, `agents`, `stop <agent>`, `exit` (alias `off`) and `help`, with tab completion and "did you mean" hints for near-miss words. They share their implementation with the `/tower` commands.
  - Mission mode is saved in the pi session and comes back with it. `/mission exit` and `/tower off` leave it.
- **Approval dialog.** When a plan awaits approval in mission mode, a dialog offers "Not yet — keep planning", the default, and "Approve and start mission" ("Approve the revised plan" after a contract change), so ↓ then Enter approves and Enter alone does not.
  - It opens once the orchestrator is idle, the editor is empty, no other extension's prompt is open (pi's `ui_prompt_start` and `ui_prompt_end` events), and the keyboard has been quiet for 2 seconds.
  - Typing or pasting while it is open closes it and moves the text to the editor. For the first 500 ms after it opens, it also swallows the keys that move or confirm a selection (↑, ↓ and Enter, as your pi keybindings define them), so a keystroke already on its way to another selector cannot approve.
  - `/mission approve` stays available. There is no dialog for headless missions, without a UI, or while `objective.autoApprove` would approve anyway.
- **Mission Control panel.** A live widget of at most 10 lines above the editor shows the mission with its status, elapsed time and cost (with the budgets when set), the milestones, the features of the current milestone with their state and agent, the running workers, reviewers and validators against the limit, the models, and the next step. The models take one line when they fit the terminal, otherwise two roles per row or one per row, and a model shows its provider only when two roles use the same model id from different providers. A footer status line mirrors it. It refreshes on tower state changes, throttled, and on a timer, and it clears on `/mission exit` and `/tower off`.
- **Droid-style planning.** In an interactive mission, the orchestrator interviews the human before drafting: done criteria, out of scope, user flows, verification commands and constraints. It pushes back on vague goals, plans the features of every milestone before it requests approval, and splits each milestone into as many small features with disjoint scopes as the work allows, so they run in parallel. It adds dependencies only where a feature needs another one's merged code, and it names fitting skills in a feature's context. Headless planning keeps its no-questions path.
- **Headless missions.** `pi-tower exec --mission -f <mission.md> [run options]` is Droid's spelling of `pi-tower run -f <file>`; `run` accepts `--mission` and ignores it, and `exec` without `--mission` exits 4.
  - `--orchestrator-model`, `--worker-model`, `--reviewer-model` and `--validator-model <provider/modelId[:thinkingLevel]>` set a role's model for the run. Each reaches pi as `--tower-<role>-model`, after the extra pi args, so it wins over `PI_TOWER_<ROLE>_MODEL`, `tower.json` and the same flag given after `--`. Malformed refs exit 4.
  - After `/tower on`, the run sends `/tower models` and prints one line per role with its model, thinking level and source, or one `role models unavailable (…) — continuing` line. Every problem in the reply's Problems section adds a `model warning:` line on stderr before the hand-over. The run continues, and the exit codes are unchanged.
- **Automatic teardown.** When a mission completes, the autopilot runs the teardown of `TowerTeardown`, never forced, in manual mode too. It removes the worktrees of merged and abandoned features and leftover validation worktrees, and keeps those of live agents, those with uncommitted changes and those of open features. Branches and `.tower/comms/` stay. The completion notice lists what was removed and kept, and the activity log records `autopilot teardown objective=… result=done removed=N kept=K`. A teardown that fails is reported but never undoes the completion.
- **Live end-to-end scenarios for mission mode.** `npm run test:e2e:pi -- --scenarios=objective` now runs five scenarios against real models, and `--scenarios=all,objective` runs all twelve.
  - S18 drives the Droid-style flow through pi's RPC mode: the `/mission` header with every role's model and source, the goal as the next message, the orchestrator's interview, the approval dialog (the harness picks the default option, which keeps planning), `/mission approve`, the status line and the Mission Control panel while two features run at once, validation, the automatic teardown and `/mission exit`. Its timeout is 50 minutes, and its mission is capped at $5.
  - S19 runs `pi-tower exec --mission -f … --auto-approve` with `--orchestrator-model`, `--worker-model`, `--reviewer-model` and `--validator-model`, and a `tower.json` that names no model. Every role's model line must name its flag as the source, before the hand-over and without a `model warning:` line. Its timeout is 40 minutes, and its mission is capped at $4. S16 shares its runner and gained the same checks.
  - The RPC client records every dialog pi opens, with its options and the answer. S2 expects the new refusal wording. S15 and S18 check the lifecycle only after the autopilot recorded the completion, because the automatic teardown now runs before that record. The headless scenarios note any worktree left after the run.
  - A `--scenarios=all,objective` run passed 12 of 12 scenarios and 160 of 160 checks in 778 seconds, for $3.05.
- **Docs.** The README in English and Simplified Chinese is restructured mission-first: install, the role models, a `/mission` walkthrough, the `/mission` and headless references and the Droid comparison come first, and the `/tower` layer and the internals move under Advanced. `examples/mission.md` is a Droid-style mission file.

### Changed

- **`objective.autoTeardown` defaults to `true`** and now works (see above). A clean worktree is removed together with its git-ignored files, such as `node_modules`, build output or a local `.env`. Set it to `false` to keep every worktree for `/tower teardown`.
- **Mission wording.** The approval request, the paused, blocked and completed notices, the auto-approval notices and the dashboard heading say "Mission O1" and point at `/mission approve`, `/mission resume` and `/mission`. The approval request names the dialog, and each milestone line says how many of its features run in parallel. The completion notice says that the mission worktrees are cleaned up automatically unless `objective.autoTeardown` is off.
- **Teardown hints.** While a mission is open, the `TowerMerge` result after the last open mission merges and the `TowerStatus` "Done" hint tell the orchestrator not to run `TowerTeardown`: the autopilot tears the worktrees down when the mission completes, or, with `autoTeardown` off, nothing is torn down before then. Without an open mission they still say the worktrees are ready for `TowerTeardown`. The `TowerTeardown` result tells the human to leave with `/mission exit or /tower off`.
- **Refusals and reminders.** The refusal while tower mode is off says that only the user can enable it, with `/mission or /tower on`. The full reminder limits "auto-wired dependencies order merges only" to work outside missions; inside a mission a feature starts only after its dependencies merge, auto-wired ones included.
- **`pi-tower` usage errors** print `pi-tower: <problem>`, the usage synopsis and `Run pi-tower --help for all options.` The exit codes are unchanged.
- **Examples.** `examples/objective.md` is now `examples/mission.md`.

### Fixed

- **Dependency cycles are refused.** `TowerPlan` accepted a plan whose dependencies formed a cycle, in one batch, through an existing open mission, or as a self-dependency, so its missions could never start or merge. The plan is now refused before anything is written, and the refusal names the cycle, for example `M1 -> M2 -> M1`. Dependencies on merged or abandoned missions never count, and auto-added scope dependencies never close a cycle.
- **A repository inside a tower worktree path keeps its own workspace.** pi-tower mapped every path below `.tower/worktrees/` to the enclosing workspace. pi started in an independent repository there, such as a throwaway test repository inside a feature's worktree, therefore took over the outer workspace: entering mission mode retired its whole roster, and leaving mission mode released its ownership. Such a path now maps to the outer workspace only when it lies in one of that workspace's own worktrees, whose `.git` link points into the workspace's git directory. A nested repository keeps its own `.tower/`. The bash guard still protects the outer workspace from a session in a nested repository, and it checks the calls of workers, reviewers and validators against the workspace the tower is bound to, which an agent cannot change.
- **Headless runs no longer leave a validation worktree behind.** `pi-tower run` and `pi-tower exec --mission` close pi as soon as the mission completes, and the automatic teardown keeps the worktree of a validator that is still finishing, so that worktree stayed registered. When pi shuts down, pi-tower now removes the validation worktrees of validators that no longer run, waiting at most 5 seconds; anything left is cleaned up the next time a session adopts the workspace.
- **Flaky tests.** Controller tests such as "requeues the batch when delivery fails…" and "records a death from a non-completed finished run" (`test/tower/controller.test.ts`) checked the state before the store write or delivery attempt they depend on had finished, and failed under CPU load. They now wait for that write or attempt itself, and so do the new approval-dialog tests.

### Compatibility

- Every `/tower` command keeps its behaviour and its replies. Workspaces, state files and `tower.json` files from 0.2.0 keep working.
- The one behaviour change for existing setups: a completed objective now tears its worktrees down. Set `"objective": { "autoTeardown": false }` to keep the 0.2.0 behaviour.

### Known limitations

- Automatic teardown deletes the git-ignored files of clean feature worktrees.
- Do not run Kimi Code's Tower and pi-tower on the same repository at the same time. They share the `.tower/` format, but Kimi Code records no owner process id, and pi-tower treats an owner without a running process as gone. `/mission` or `/tower on` then adopts a workspace that a Kimi Code session still uses and retires that session's roster.
- A directory inside a feature's worktree that is not a git repository of its own counts as part of that worktree, so pi started there uses the outer workspace. Only a separate git repository nested in a worktree gets its own workspace.
- The bash guard lets git commands run inside a feature's worktree. If that worktree's `.git` link file is deleted, git there finds the main checkout's repository, and a plain `git reset --hard` run in the worktree resets the main checkout and discards its uncommitted changes without being blocked.
- The approval dialog waits while another extension's prompt is open and swallows ↑, ↓ and Enter for 500 ms after it opens, but pi 1.5.0 reports nothing about its built-in selectors, such as `/model`. If you have been idle in one of them for 2 seconds or more when the plan becomes ready, the approval dialog replaces it, and a ↓ then Enter pressed 500 ms or more after that approves the plan.
- A plan that already awaited approval when mission mode started, for example after a restart, gets no dialog. Approve it with `/mission approve`.

## [0.2.0] - 2026-11-09

Objective mode: the tower keeps working on a plan you approved until every milestone has passed validation, in the style of Factory's Droid Missions. Unlike Missions, the features of a milestone run in parallel, each with its own worktree, independent review and merge gate.

### Added

- **Objective mode.** `/tower objective [--headless] <text | @file>` hands a goal to the orchestrator. It plans the goal with you, or alone with recorded assumptions when `--headless` is given, into a contract: a goal, a definition of done, optional acceptance commands, and ordered milestones, each with its own validation.
  - Only a human approves the plan with `/tower approve`, unless auto-approval is configured. The orchestrator has no approve tool. A contract change after approval needs a new approval; after a change made while the objective was blocked or paused, only a human approval is accepted.
  - The features of the current milestone run in parallel as ordinary tower missions. Milestones run in order.
  - Once a milestone's features are merged or abandoned, its validation runs on the base tip: `scrutiny` and `user-testing` validator agents, plus a mechanical `commands` kind that the tower runs without a model (the milestone's commands, and the acceptance commands on the final milestone).
  - Failures go back to the orchestrator, which plans fix features into the milestone, and validation runs again on the new tip until the milestone passes. A kind that fails `maxValidationRounds` times blocks the objective.
  - Completion is automatic and gated: every milestone passed, no feature is open, and the final validation is on the current base tip.
  - Lifecycle `planning → awaiting-approval → executing ⇄ paused → completed | blocked`, with `/tower objective status`, `/tower pause [reason]` and `/tower resume`.
- **Autopilot.** After approval, code rather than a model drives the mechanics, through the same tower operations and gates as the orchestrator. It spawns workers, reviewers and validators, resumes workers that have review findings or a rebase conflict, nudges workers that go idle without finishing, replaces failed or timed-out agents while fewer than `maxFeatureAttempts` agents have been used (never one a human stopped: for any stopped worker, reviewer or validator it wakes the orchestrator instead, which asks the human how to continue), rebases, merges, runs validation, advances milestones and completes the objective.
  - The orchestrator is woken only for judgment: `plan-milestone`, `validation-failed`, `blocker`, `feature-attempts-exhausted`, `worker-idle`, `worker-stopped`, `merge-blocked`, `rebase-conflict`, `review-stuck`, `validation-stuck` and `stalled`. Agent ends, review traffic and validation results of objective features reach it as context without a model turn.
  - `"autopilot": false` selects manual mode: the orchestrator drives feature execution, while validation, milestones, completion, the watchdog and the budgets stay automatic.
- **Watchdog and budgets.** The autopilot also ticks every `watchdogIntervalMs`. After `stallTimeoutMs` without progress the orchestrator is woken, and `maxStallWakes` stall wakes in a row block the objective. `maxWallTimeMs` and `maxCostUsd` pause it; the cost counts every tower agent and the orchestrator's own turns.
- **Restart continuation.** An executing objective continues when tower mode comes back on: lost workers are replaced on their branches, interrupted validations run again, and leftover validation worktrees are removed.
- **Validator role.** An optional fourth model role, `validator`: `PI_TOWER_VALIDATOR_MODEL`, `--tower-validator-model`, `"validator"` in `tower.json`, and `/tower models validator`. When unset, it inherits the reviewer, then the orchestrator. Validators work read-only in a detached validation worktree at the validated commit and report once with `TowerValidate`.
- **Headless runner.** `pi-tower run -f <file> [--auto-approve] [--timeout <ms>] [--cwd <dir>] [--pi <path>] [-- <pi args>]`, the package's `pi-tower` bin, drives `pi --mode rpc` until the objective ends. Exit codes: 0 completed, 1 blocked or paused (or pi exited), 2 timeout, 3 approval needed, 4 usage or startup error, 130/143 on SIGINT/SIGTERM.
- **Tools.** `TowerObjective` for the orchestrator (`draft`, `update`, `request-approval`, `status`, `block`; no approve and no complete action) and `TowerValidate` for validators. `TowerPlan` takes `milestone` and `origin`, and `TowerSpawn` takes `kind: "validator"` with `milestone` and `validation_kind`. pi-tower now has 19 tools.
- **Commands.** `/tower objective`, `/tower objective status`, `/tower approve [--auto]`, `/tower pause [reason]` and `/tower resume`, with tab completion and near-miss hints.
- **Configuration.** A `tower.json` `"objective"` section with `autopilot`, `autoApprove`, `maxValidationRounds`, `maxFeatureAttempts`, `watchdogIntervalMs`, `stallTimeoutMs`, `maxStallWakes`, `maxWallTimeMs`, `maxCostUsd`, `skipScrutiny`, `skipUserTesting` and `autoTeardown`. The project file wins key by key. `/tower models` shows the validator and every objective setting with its source.
- **Docs.** README sections in English and Simplified Chinese on objective mode, headless runs, a comparison with Droid Missions and the known limitations, `examples/objective.md`, and an `examples/tower.json` with a validator and an objective section.
- **Live end-to-end scenarios for objective mode.** `npm run test:e2e:pi -- --scenarios=objective` runs three new scenarios against real models: S15 (a failing acceptance check drives a fix feature until the objective completes), S16 (a headless `pi-tower run --auto-approve`) and S17 (restart continuation after pi is killed mid-feature). `PI_TOWER_E2E_VALIDATOR_MODEL` sets their validator model, the objective scenarios get their own timeouts, and the report shows the wall time and cost of every scenario. The default selection stays the seven 0.1.0 scenarios.
  - The harness is portable and cannot pass vacuously: without procfs, S16's leftover-process check falls back to `ps` (and `lsof` for working directories) or is reported as not applicable, and its process cleanup always runs; the validation-promptness check fails when a start on a merge commit, or on a commit that does not resolve, cannot be measured, or when no start could be measured at all; and `key=value` text inside an activity-log `detail=` no longer overwrites real fields.

### Compatibility

- A workspace without an objective behaves as in 0.1.0, and its state files keep the 0.1.0 format: no new mission fields and no change to `MISSIONS.md`.
- `tower.json` files from 0.1.0 keep loading, with one exception: `validator` is now a reserved name, so a pool alias called `validator` must be renamed.
- The orchestrator has one more tool, `TowerObjective`, while tower mode is on.

### Known limitations

- With `objective.autoApprove` on, the orchestrator could draft a fresh objective after one blocked, and it would be approved automatically, which restarts the wall-time and cost budgets without a human. Keep `autoApprove` off for interactive use; the headless runner exits with 1 on a blocked objective first.
- Validation commands run in a fresh checkout without installed dependencies and must include their own setup, for example `npm ci && npm test`.
- Failed validation rounds are never reset: they count toward `maxValidationRounds` across commits, contract changes and `/tower resume`. Raise `maxValidationRounds` in `tower.json` before resuming an objective that blocked on failed validations.
- User-testing validators have no browser or GUI tooling; behavioural QA uses CLIs, HTTP calls and scripts.
- Whether a review request covers the branch tip is decided with commit timestamps of one-second resolution. This is harmless: reviewers always review the real tip.
- The `pi-tower` bin was tested on Node 26 only; its Node 22.x code paths are untested.
- `autoTeardown` is accepted but not used yet.

## [0.1.0] - 2026-11-09

The first release. It ports the Tower multi-agent mode of [Kimi Code](https://github.com/MoonshotAI/kimi-code) to pi and gives the orchestrator, the workers and the reviewers separate models.

### Added

- **Three-role models.** The `orchestrator`, `worker` and `reviewer` models are set separately, and an optional named `models` pool can be added.
  - Sources, from highest to lowest precedence: `--tower-{orchestrator,worker,reviewer}-model`, `PI_TOWER_{ORCHESTRATOR,WORKER,REVIEWER}_MODEL`, the trusted project's `.pi/tower.json`, and the global `<agentDir>/tower.json` (or the file named by `PI_TOWER_CONFIG`).
  - Thinking levels are set with a `:level` suffix or `thinkingLevel`.
  - An unset worker or reviewer inherits the orchestrator, including its thinking level. An unset orchestrator falls back to the session model.
  - `maxRunningAgents` (default 256) and `agentTimeoutMs` (default 2 hours) set the limits.
- **Session model switching.** `/tower on` switches the main session to the orchestrator model, and `/tower off` switches back. If the configuration does not load, the session start and `/tower on` warn and the session keeps its model.
- **`/tower models`.** Shows, sets and clears role and pool models in the global or the project file, and warns when a write is shadowed or the project is untrusted.
- **Per-spawn model choice.** `TowerSpawn` accepts `orchestrator`/`primary`, `worker`, `reviewer` or a pool alias.
  - A spawn is refused when its model is unknown to pi or has no credentials.
  - The model of every agent shows in the spawn result, `/tower agents`, `TowerTasks`, the `/tower status` roster and the activity log.
- **The Kimi Code Tower protocol:**
  - missions with scopes, tasks, dependencies and verbatim user context;
  - git worktrees per mission, with snapshots of uncommitted base changes;
  - an inbox with push delivery into running agents, and findings;
  - review rounds bound to the branch tip;
  - the merge gate and `--no-ff` merges, rebases inside mission worktrees, and teardown;
  - recovery after a lost `state.json`.
- **17 tools.** The 13 Kimi Code Tower tools are ported with their descriptions and refusals. `TowerResume`, `TowerTasks`, `TowerTaskOutput` and `TowerTaskStop` take the place of Kimi Code's generic agent and task tools.
- **`/tower` command.** Subcommands: `on`, `off`, `status`, `teardown`, `<base-branch>`, `models`, `agents`, `stop <agent>` and `help`, with tab completion. Near-miss words and stray arguments are refused with a hint instead of becoming a base branch, and the interactive UI asks before `/tower <base-branch>` creates a new branch.
- **Worker and reviewer sessions** run as in-process pi sessions with the ported briefings and role prompt.
  - Workers work in their worktree. Reviewers work read-only in the main checkout.
  - Transcripts are stored in `.tower/agents/`.
  - An adaptive concurrency limit reacts to rate limits: provider 429 responses shrink the budget and pause new spawns.
- **Automatic wakes.** Inbox messages and finished or failed agents notify the orchestrator, with message references and merge-gate digests. Full and short tower-mode reminders keep the orchestrator on the protocol.
- **Guards:**
  - a bash guard for the orchestrator and all agents that protects `.tower/comms` and the main checkout from `rm`, `git clean -x/-X` and `git reset --hard`, using a conservative shell parser;
  - a write guard that keeps workers inside their worktree;
  - read-only reviewers;
  - todo and subagent tool vetoes while tower mode is on.
- **Ownership.** There is one tower per workspace across pi processes. Tower mode is restored with the pi session, and a dead owner is taken over.
- **Diagnostics.** pi-tower writes its diagnostics to `.tower/pi-tower.log`, or to `pi-tower.log` in the pi agent directory before `.tower/` exists.
- **Docs and license.** README in English and Simplified Chinese, an example `tower.json`, and the MIT license with the Kimi Code notice.
