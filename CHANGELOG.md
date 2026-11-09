# Changelog

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
- **Autopilot.** After approval, code rather than a model drives the mechanics, through the same tower operations and gates as the orchestrator. It spawns workers, reviewers and validators, resumes workers that have review findings or a rebase conflict, nudges workers that go idle without finishing, replaces failed or timed-out workers up to `maxFeatureAttempts` (never one a human stopped), rebases, merges, runs validation, advances milestones and completes the objective.
  - The orchestrator is woken only for judgment: `plan-milestone`, `validation-failed`, `blocker`, `feature-attempts-exhausted`, `worker-idle`, `merge-blocked`, `rebase-conflict`, `review-stuck`, `validation-stuck` and `stalled`. Agent ends, review traffic and validation results of objective features reach it as context without a model turn.
  - `"autopilot": false` selects manual mode: the orchestrator drives feature execution, while validation, milestones, completion, the watchdog and the budgets stay automatic.
- **Watchdog and budgets.** The autopilot also ticks every `watchdogIntervalMs`. After `stallTimeoutMs` without progress the orchestrator is woken, and `maxStallWakes` stall wakes in a row block the objective. `maxWallTimeMs` and `maxCostUsd` pause it; the cost counts every tower agent and the orchestrator's own turns.
- **Restart continuation.** An executing objective continues when tower mode comes back on: lost workers are replaced on their branches, interrupted validations run again, and leftover validation worktrees are removed.
- **Validator role.** An optional fourth model role, `validator`: `PI_TOWER_VALIDATOR_MODEL`, `--tower-validator-model`, `"validator"` in `tower.json`, and `/tower models validator`. When unset, it inherits the reviewer, then the orchestrator. Validators work read-only in a detached validation worktree at the validated commit and report once with `TowerValidate`.
- **Headless runner.** `pi-tower run -f <file> [--auto-approve] [--timeout <ms>] [--cwd <dir>] [--pi <path>] [-- <pi args>]`, the package's `pi-tower` bin, drives `pi --mode rpc` until the objective ends. Exit codes: 0 completed, 1 blocked or paused (or pi exited), 2 timeout, 3 approval needed, 4 usage or startup error, 130/143 on SIGINT/SIGTERM.
- **Tools.** `TowerObjective` for the orchestrator (`draft`, `update`, `request-approval`, `status`, `block`; no approve and no complete action) and `TowerValidate` for validators. `TowerPlan` takes `milestone` and `origin`, and `TowerSpawn` takes `kind: "validator"` with `milestone` and `validation_kind`. pi-tower now has 19 tools.
- **Commands.** `/tower objective`, `/tower objective status`, `/tower approve [--auto]`, `/tower pause [reason]` and `/tower resume`, with tab completion and near-miss hints.
- **Configuration.** A `tower.json` `"objective"` section with `autopilot`, `autoApprove`, `maxValidationRounds`, `maxFeatureAttempts`, `watchdogIntervalMs`, `stallTimeoutMs`, `maxStallWakes`, `maxWallTimeMs`, `maxCostUsd`, `skipScrutiny`, `skipUserTesting` and `autoTeardown`. The project file wins key by key. `/tower models` shows the validator and every objective setting with its source.
- **Docs.** README sections in English and Simplified Chinese on objective mode, headless runs, a comparison with Droid Missions and the known limitations, `examples/objective.md`, and an `examples/tower.json` with a validator and an objective section.

### Compatibility

- A workspace without an objective behaves as in 0.1.0, and its state files keep the 0.1.0 format: no new mission fields and no change to `MISSIONS.md`.
- `tower.json` files from 0.1.0 keep loading, with one exception: `validator` is now a reserved name, so a pool alias called `validator` must be renamed.
- The orchestrator has one more tool, `TowerObjective`, while tower mode is on.

### Known limitations

- With `objective.autoApprove` on, the orchestrator could draft a fresh objective after one blocked, and it would be approved automatically, which restarts the wall-time and cost budgets without a human. Keep `autoApprove` off for interactive use; the headless runner exits with 1 on a blocked objective first.
- Validation commands run in a fresh checkout without installed dependencies and must include their own setup, for example `npm ci && npm test`.
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
