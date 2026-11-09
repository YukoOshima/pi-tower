# pi-tower

English | [简体中文](README.zh-CN.md)

**pi-tower** brings the Tower multi-agent mode of [Kimi Code](https://github.com/MoonshotAI/kimi-code) to the [pi coding agent](https://github.com/earendil-works/pi), and adds one thing Kimi Code lacks: the **orchestrator**, the **workers** and the **reviewers** each get their own model.

Once tower mode is on, pi's main agent becomes the *tower*, which is the orchestrator. It splits a larger development task into missions (subtasks) and starts a worker for each mission in the background. Every mission has its own git branch and worktree. The tower sends each finished branch to an independent reviewer and merges only the branches that pass its merge gate. While the workers run, you keep talking to the tower: check progress, add constraints, change priorities, or stop an agent at any time.

Tower is neither an ordinary subagent call nor a swarm. You turn it on explicitly. It keeps its state in the repository (`.tower/`), and it comes with merge checks and cleanup commands. Its strengths are **responsiveness** and **parallel development**.

**Objective mode** (new in 0.2) makes the tower keep going until the job is verifiably done, in the style of [Factory's Droid Missions](https://docs.factory.com/missions/overview): you approve a plan of milestones with a validation contract, validators check every milestone, every failure becomes a fix, and the objective completes only when the whole contract holds. The difference is in the execution. Missions work through features one after another; pi-tower runs the features of a milestone in parallel, each in its own git worktree with its own independent review and merge gate. See [Objective mode](#objective-mode).

> [!WARNING]
> Workers, reviewers and validators run unattended. They never ask you to approve individual actions. Read [Safety and resource cost](#safety-and-resource-cost) before you start.

## Contents

- [Three models, one per role](#three-models-one-per-role)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Objective mode](#objective-mode)
- [Headless runs: `pi-tower run`](#headless-runs-pi-tower-run)
- [Droid Missions and pi-tower](#droid-missions-and-pi-tower)
- [When Tower fits](#when-tower-fits)
- [Run a workflow](#run-a-workflow)
- [Check status and intervene](#check-status-and-intervene)
- [Merges and rebases](#merges-and-rebases)
- [Stop, teardown, and restart](#stop-teardown-and-restart)
- [Model configuration](#model-configuration)
- [Command reference](#command-reference)
- [Tool reference](#tool-reference)
- [Safety and resource cost](#safety-and-resource-cost)
- [Known limitations](#known-limitations)
- [Differences from kimi-code Tower](#differences-from-kimi-code-tower)
- [Development](#development)
- [License and credits](#license-and-credits)

## Three models, one per role

Kimi Code's Tower has two model settings. The primary model runs the tower and every reviewer. An optional `[secondary_model]` sets the default for workers. pi-tower gives each role a setting of its own:

| Role | Used by | When it is not set |
| --- | --- | --- |
| `orchestrator` | The main pi session while tower mode is on: planning, routing messages, merging | The session's current model (whatever `/model` selected) |
| `worker` | Every worker spawned for a mission | The orchestrator's model and thinking level |
| `reviewer` | Every independent reviewer | The orchestrator's model and thinking level |

[Objective mode](#objective-mode) adds a fourth, optional role, `validator`, for the agents that validate milestones. When it is not set, validators use the reviewer's model and thinking level, or the orchestrator's when no reviewer is configured either. You only need it to give validation a model of its own.

You can also define a pool of named models (`models`). The tower uses a pool model for a single spawn when you ask for it.

A minimal setup goes in `~/.pi/agent/tower.json`:

```json
{
  "orchestrator": "anthropic/claude-opus-5-5:high",
  "worker": "anthropic/claude-sonnet-5-5",
  "reviewer": "openai/gpt-5.5:high"
}
```

Run `/tower models` to check the result. It shows the model each role gets and where each setting comes from. When tower mode turns on, the main session switches to the orchestrator model, and `/tower off` switches it back. Every setting is described in [Model configuration](#model-configuration).

## Installation

You need [pi](https://github.com/earendil-works/pi) and git. pi-tower is developed and tested against pi 1.5.0.

Install it as a pi package. This writes the package to your personal pi settings (`~/.pi/agent/settings.json`):

```sh
pi install git:github.com/YukoOshima/pi-tower
```

- Add `-l` to install it for the current project only. That writes `.pi/settings.json`, which pi loads after you trust the project.
- To try it for one run without adding it to your settings, use `pi -e git:github.com/YukoOshima/pi-tower`.

To run it from a local checkout:

```sh
git clone https://github.com/YukoOshima/pi-tower.git
cd pi-tower
npm install
pi -e ./src/index.ts
```

From any other project, pass the absolute path: `pi -e /path/to/pi-tower/src/index.ts`.

There is no experiment flag to turn on. Loading the extension is the opt-in. Its tools stay inactive, and hidden from the model, until you run `/tower on`.

For unattended runs, the package also ships the `pi-tower` command (`bin/pi-tower.js`, Node 22.19 or newer); see [Headless runs](#headless-runs-pi-tower-run).

## Quick start

```sh
cd /path/to/project
git status        # check out the local branch that should receive the work
pi
```

1. Run `/tower on`. The footer shows `tower: on`, and the main session switches to your orchestrator model if you configured one.
2. Describe the work as a normal message, for example: "Split the checkout documentation update into independent missions, test each one, and merge only branches that pass independent review." For work that must be finished and verified against a contract you approve, hand it over with `/tower objective <what you want done>` instead; [Objective mode](#objective-mode) walks through it.
3. Follow the progress with `/tower status` and `/tower agents` (and `/tower objective status` for an objective). The tower wakes up by itself when a worker finishes or a message arrives, so you do not need to poll.
4. Check the merged result yourself: `git status`, `git log --graph`, and your tests.
5. Run `/tower teardown` to remove the finished worktrees, then `/tower off`.

## Objective mode

A plain tower run ends when the orchestrator decides the work is done. An **objective** ends only when its validation contract is met. Objective mode follows the shape of [Factory's Droid Missions](https://docs.factory.com/missions/overview): you agree on a plan, you approve it, and the fleet keeps working, validating each milestone and fixing what fails, until everything checks out. What changes is the execution: the features of a milestone run in parallel.

### What it guarantees

- **You approve the plan.** The orchestrator turns your request into a contract: a goal, a definition of done, optional acceptance commands, and ordered milestones, each with its own validation. No feature starts before you run `/tower approve`, unless you turned on automatic approval yourself. The orchestrator cannot approve for you: none of its tools can.
- **Every milestone is validated.** When all features of a milestone are merged (or abandoned), validators check the integrated result on one exact commit, the tip of the base branch.
- **Failures get fixed.** A failed validation goes back to the orchestrator, which plans fix features into the same milestone. Once they merge, validation runs again on the new tip. This repeats until the milestone passes.
- **Completion is gated.** The objective completes only when every milestone has passed, no feature is still open, and the final milestone passed on the current base tip. Nobody can mark it done otherwise, the orchestrator included.
- **The contract stays yours.** Changing it after approval (the goal, the definition of done, the acceptance commands, a milestone's validation, removing or reordering milestones) sends the plan back to you for approval. Appending milestones at the end and adding notes do not.
- **It stops instead of spinning.** A validation kind that keeps failing, a stall that the orchestrator cannot resolve, or a used-up budget blocks or pauses the objective, and you are told why.

**How the execution differs from Droid Missions.** Missions work through features one after another. pi-tower starts every feature of the current milestone whose dependencies are met at the same time, up to `maxRunningAgents`. Each feature is an ordinary tower mission with its own branch and worktree, its own worker, an independent reviewer, and the merge gate. Milestones still run in order: the next one starts only after the previous one has passed. [Droid Missions and pi-tower](#droid-missions-and-pi-tower) compares the two in detail.

### Five-minute walkthrough

1. **Start pi on the branch that should receive the work**, and turn tower mode on with `/tower on`.

2. **Hand over the objective**, inline or from a Markdown file such as [`examples/objective.md`](examples/objective.md):

   ```text
   /tower objective Add a --format csv|json option to `shop report`; the table output must not change; npm test must pass
   /tower objective @docs/csv-export.md
   ```

   If `.tower/` does not exist yet, this creates it and records the current branch as the base. The orchestrator then asks you what done looks like, what is out of scope, how a user would try the result, and which commands prove it. Answer in normal messages.

3. **Review the plan.** The orchestrator drafts the contract, plans the features of the first milestone, and asks for your approval. You get an approval request like this one:

   ```text
   Objective O1 "CSV and JSON export for shop report" is ready for your approval.

   Goal: Add a --format option to shop report so the monthly report can be exported as CSV or JSON; the table output stays as it is.

   Definition of done:
   1. shop report --format csv writes RFC 4180 CSV with a header row
   2. shop report --format json writes a JSON array of the same rows
   3. shop report without --format prints exactly what it prints today
   4. npm test and npm run typecheck pass

   Acceptance commands (run on the final milestone): `npm ci && npm run typecheck && npm test`

   Milestones — in order; the features inside a milestone run in parallel:
   1. MS1 "Serializers" — 2 features: M1 "CSV serializer", M2 "JSON serializer"
      CSV and JSON serializers for report rows, with unit tests.
      validation: scrutiny · commands `npm ci && npm test`
   2. MS2 "CLI options and docs" — features are planned when it becomes current
      validation: scrutiny · user-testing · commands `npm ci && npm run typecheck && npm test`

   Assumptions and notes:
   - Assumed: --output overwrites an existing file.

   Estimated runs: ≈ 6 (2 features + 2 × 2 milestones). This is a floor, not a ceiling: failed validations add fix features and further validation rounds.

   To approve, run: /tower approve
   Only you can approve — the orchestrator cannot. To change the plan, tell the orchestrator what to change; it updates the plan and asks for approval again.
   ```

   To change anything, say so in a normal message. The orchestrator revises the plan and asks again.

4. **Approve** with `/tower approve`. From now on the autopilot does the mechanics: it starts the workers, sends finished branches to reviewers, merges what passes the gate, runs the validators and moves on to the next milestone. The orchestrator is woken only when judgment is needed.

5. **Watch.** `/tower objective status` shows the dashboard without starting a model turn:

   ```text
   Objective O1 — CSV and JSON export for shop report
   🔵 executing · elapsed 37m 00s · cost $4.37 of $25.00 · approved by human
   Goal: shop report prints the monthly sales report as a table. Add a --format option so the same report can be exported as CSV or JSON.

   ## Milestones
   ✅ MS1 Serializers — passed · features 3/3 merged (1 fix) · scrutiny r2 pass · commands r2 pass
   🔵 MS2 CLI options and docs — active · features 0/2 merged · validation: scrutiny · user-testing · commands `npm ci && npm run typecheck && npm test`

   ## Current milestone MS2 — features (run in parallel)
   - 🔵 M4 --format and --output options — active · worker ap-w-M4-1
   - 🟢 M5 README for report export — completed

   ## Live agents (2)
   - ap-w-M4-1 — worker · M4 --format and --output options
   - ap-r-M5-1 — reviewer · feat/readme-for-report-export

   ## Next
   2 of 2 features of MS2 still open, running in parallel — validation starts once every feature is merged or abandoned.
   ```

   Here the first scrutiny round of MS1 failed, the orchestrator planned the fix feature M3, and the second round passed on the new tip. You can keep talking to the tower the whole time. `/tower pause` stops new work, and `/tower resume` continues.

6. **Done.** When the final milestone has passed on the current base tip, the objective completes and you get a summary: every milestone with its passing rounds, the merged features, the elapsed time and the cost. Check the result yourself, then run `/tower teardown` and `/tower off`.

If the objective blocks instead, you get the reason and the latest failures. Tell the orchestrator what to change or answer its question, then run `/tower resume`.

### Lifecycle

An objective moves through these states:

| Status | What happens | How it moves on |
| --- | --- | --- |
| `planning` | The orchestrator drafts the contract and plans features, with you, or on its own in a headless run | The orchestrator requests approval. That needs a goal, at least one definition-of-done item, at least one milestone, and at least one build feature in the first milestone. |
| `awaiting-approval` | The plan waits for you, and you are notified with the approval request | `/tower approve`, or automatic approval if you configured it |
| `executing` | The autopilot drives the work, milestone by milestone | It completes through the gate. `/tower pause` or a budget pauses it, and it blocks when the work cannot converge. |
| `paused` | Nothing new starts. Running agents finish their current turn. | `/tower resume` |
| `blocked` | Nothing new starts, and you are told why | You decide: answer the orchestrator or have it change the plan, then run `/tower resume`. Or start a new objective. |
| `completed` | Every milestone passed, and the final validation is on the current base tip | Start the next one with `/tower objective` |

Milestones have their own states. A milestone is `pending` until it becomes current, `active` while its features run, and `validating` while its validation runs. Then it is `passed`, or `failed`, which reopens it for fix features, or `blocked` once one validation kind has failed `maxValidationRounds` times. The current milestone is the first one that has not passed. Features of later milestones can be planned early, but they start only when their milestone is current. A current milestone without features wakes the orchestrator to plan them.

- **One objective at a time.** A workspace has at most one open objective. `/tower objective` is accepted when there is none, when the previous one is completed or blocked (it is archived when the new one is drafted), and while the open one is still planning (the orchestrator then revises it). It is refused while an objective is awaiting approval, executing or paused.
- **Resuming.** `/tower resume` works on a paused or blocked objective. It first reloads the objective's limits from your current [objective settings](#the-objective-section), so raise a budget in `tower.json` before you resume. It also resets the stall counter and reopens a blocked milestone so that the orchestrator can plan fixes. An objective that was never approved goes back to planning.
- **Tower mode off.** The autopilot runs only while tower mode is on. After `/tower off`, an executing objective does not advance until you turn tower mode on again.

### Validation

Every milestone says which kinds of validation it needs. When all of its features are merged or abandoned, the required kinds start together on the current base tip.

| Kind | Run by | What it checks | Required when |
| --- | --- | --- | --- |
| `scrutiny` | A validator agent | Reviews the milestone's merged changes against the tasks of every feature and the definition of done, looks for broken seams between the features that were built in parallel, and runs typecheck, lint and tests | The milestone's `scrutiny` switch is on (the default) and `skipScrutiny` is off |
| `user-testing` | A validator agent | Uses the product the way a user would, following the milestone's QA instructions: CLI runs, scripts, HTTP calls. Every deviation is a failure with steps to reproduce it. | The milestone's `user_testing` switch is on (the default) and `skipUserTesting` is off |
| `commands` | The tower itself, with no model | Runs the milestone's commands, plus the objective's acceptance commands on the final milestone. It passes when every command exits with 0. | The milestone has at least one command to run |

A milestone passes when the latest round of every required kind passed on the same commit. A milestone that requires no kind passes as soon as its features are merged or abandoned.

> [!IMPORTANT]
> Validation commands run mechanically in a fresh, detached checkout of the base tip, without installed dependencies or build output. Each command must bring its own setup: write `npm ci && npm test`, not `npm test`.

The commands run one after another, each in its own `bash -c` started at the root of that checkout, so `cd` and exported variables do not carry over from one command to the next. Every command runs, even after an earlier one failed. Each one gets 15 minutes before its process group is killed. Its stdin is `/dev/null`, and the environment adds `CI=1`, `TERM=dumb`, `NO_COLOR=1` and similar variables. The last 4000 characters of each command's output go into the validation report.

Validator agents work in a detached validation worktree, `.tower/worktrees/val-<milestone>-<kind>-r<round>`, checked out at the commit they validate. They may install dependencies, build and start the product there, but they cannot change files: they have no `write` or `edit` tool, and such calls are vetoed. Each validator reports its verdict exactly once with `TowerValidate`, and its worktree is removed afterwards. Every round, the mechanical ones included, is recorded under `.tower/comms/validations/`.

- Rounds are numbered per milestone and kind. A kind that failed on a commit does not run again on that commit: the next round needs a new base tip, normally a merged fix.
- When the failed rounds of one kind reach `maxValidationRounds` (default 3), the milestone blocks, and so does the objective.
- When the base moves while a milestone is validating, or after the final milestone passed, validation runs again on the new tip. Rounds on an older commit are stale.
- When the contract changes, only rounds recorded under the current contract count.

### Autopilot and orchestrator

After approval, the **autopilot** drives the mechanics. It is plain code, not a model. It reacts to every change of the tower state, to every agent that ends, to inbox messages, and to a watchdog timer. It acts only through the same tower operations that the orchestrator uses, so every rule still applies: no merge without a clean independent review on the exact branch tip, and no change outside a feature's scope.

The autopilot:

- starts a worker for each feature of the current milestone whose dependencies are merged or abandoned, up to `maxRunningAgents`;
- spawns a reviewer for each review request on the current branch tip;
- resumes an idle worker that received review findings or has a rebase conflict to resolve;
- nudges a worker that went idle before finishing its feature (it neither called `TowerComplete` nor reported a blocker) to finish it or say what blocks it, once per branch tip;
- replaces a worker that failed or timed out with a fresh one on the same branch, up to `maxFeatureAttempts` workers per feature, but never a worker you stopped;
- rebases stale branches and merges the branches that pass the gate;
- starts validation: it spawns the validators and runs the commands;
- advances to the next milestone, and completes the objective through the gate;
- pauses the objective when a budget is used up, and blocks it after too many failed validation rounds or stall wakes.

The orchestrator is woken only for judgment, with one of these reasons:

- `plan-milestone`: the current milestone has no features yet;
- `validation-failed`: plan fix features from the failures;
- `blocker`: a worker reported a blocker or asked a question;
- `feature-attempts-exhausted`: a feature used up its worker attempts;
- `worker-idle`: a worker went idle again without finishing after it was nudged;
- `merge-blocked`: the merge gate is blocked for a reason that needs judgment, such as files outside the feature's scope;
- `rebase-conflict`: a conflict that no worker can take over;
- `review-stuck` and `validation-stuck`: reviewers or validators keep ending without a result;
- `stalled`: nothing has moved for `stallTimeoutMs`.

Each wake is sent once per situation. While the autopilot drives an executing objective, the mechanical events of its features reach the orchestrator as context without starting a model turn: agents that end, review requests and survey summaries, review results, and validation results. Only the autopilot's own wakes and the messages that need judgment, such as a worker's question, start a turn, so the orchestrator spends tokens on judgment only. When the same autopilot action is refused on three ticks in a row, the orchestrator gets the exact error and a suggested remedy.

You stay in charge. Talk to the orchestrator as usual, stop an agent for good with `/tower stop <agent>` (the autopilot never replaces a worker you stopped), or stop all new work with `/tower pause`.

**Manual mode.** With `"objective": { "autopilot": false }` in `tower.json`, the orchestrator drives feature execution itself, as in a plain tower run: it spawns workers and reviewers, resumes and replaces workers, rebases and merges with the tower tools, and every agent end and inbox message starts its turn as before. Validation, milestone advancement, completion, the watchdog, the budgets and the judgment wakes stay automatic.

### Watchdog, stall wakes and budgets

- **Watchdog.** Besides reacting to events, the autopilot checks the objective every `watchdogIntervalMs` (default 60 seconds).
- **Stall wakes.** The objective stalls when nothing has changed for `stallTimeoutMs` (default 3 minutes) while no agent or validation is running and the orchestrator is idle. "Nothing" covers the missions, the branch tips, the reviews, the validation rounds, the base tip and the inbox. The orchestrator is then woken to re-evaluate. After `maxStallWakes` (default 3) stall wakes in a row without progress, the objective blocks.
- **Headless planning.** In a headless run, an objective that stays in planning without progress for `stallTimeoutMs` gets a wake that tells the orchestrator to finish the plan and request approval.
- **Budgets.** `maxWallTimeMs` counts from the first approval. `maxCostUsd` counts the cost that pi reports for every tower agent and for the orchestrator's own turns, so it is only as accurate as the prices pi knows for your models. When either is reached, the objective pauses and you are notified. To go on, raise or remove the limit in `tower.json` and run `/tower resume`. Both are unset by default.

`maxValidationRounds`, `maxFeatureAttempts`, `maxWallTimeMs` and `maxCostUsd` are copied into the objective when it is drafted, and `/tower resume` refreshes them. The orchestrator cannot change them.

### Restarts

An objective lives in git and in `.tower/comms/state.json`, so it survives a restart of pi. Agents do not (see [Stop, teardown, and restart](#stop-teardown-and-restart)). When tower mode comes back on with an executing objective, through `/tower on` in a new pi process or a continued session, the autopilot picks the objective up at once:

- each feature whose worker was lost gets a fresh worker on its existing branch, which continues from where the branch history shows it stopped. This counts as a new attempt toward `maxFeatureAttempts`;
- validations cut short by the restart run again, and their leftover validation worktrees are removed;
- reviews, merges and milestones continue from the recorded state.

A paused objective stays paused until `/tower resume`, and an objective awaiting approval still waits for you. In manual mode, the orchestrator replaces lost workers itself, as in a plain tower run.

### Objective commands and tools

| Command | What it does |
| --- | --- |
| `/tower objective [--headless] <text \| @file>` | Hands an objective to the orchestrator, as text or from a file (`@path`, relative to pi's working directory), and returns at once while the orchestrator plans. Tower mode must be on. With `--headless`, the orchestrator plans without asking questions: it decides open points itself, records each assumption as a note on the objective, and requests approval. `pi-tower run` uses this. |
| `/tower objective status` | Shows the objective dashboard without a model turn |
| `/tower approve [--auto]` | Approves the plan of the objective that awaits approval. Its current milestone becomes active, and the autopilot starts. `--auto` records the approval as automatic instead of human; this is what `pi-tower run --auto-approve` sends. After a contract change while the objective was blocked or paused, only a plain `/tower approve` is accepted. |
| `/tower pause [reason]` | Pauses the executing objective. Running agents finish their current turn, and nothing new starts. |
| `/tower resume` | Resumes a paused or blocked objective, after reloading its limits from the current objective settings |

Two tools exist for objectives only:

- **`TowerObjective`** (orchestrator only) manages the objective with the actions `draft`, `update`, `request-approval`, `status` and `block`. It has no approve action and no complete action, and it cannot change the limits.
- **`TowerValidate`** (validators only) submits a validator's verdict for its milestone and kind: `pass` or `fail`, with failures, checks and evidence. A validator calls it exactly once.

Two existing tools gain objective parameters. `TowerPlan` takes a `milestone` for every feature (required for build missions while an objective is open) and an `origin` of `plan` or `fix`. `TowerSpawn` takes `kind: "validator"` with a `milestone` and a `validation_kind` (`scrutiny` or `user-testing`), which the orchestrator uses to recover a stuck validation. See the [Tool reference](#tool-reference).

## Headless runs: `pi-tower run`

`pi-tower run` runs an objective unattended: in CI, from a scheduled job, or in a terminal you walk away from. It starts pi in RPC mode in your repository, turns tower mode on, hands over an objective file with `/tower objective --headless`, and follows the objective until it ends. In headless mode the orchestrator plans without asking questions. It decides open points itself, records each assumption as a note on the objective, and requests approval.

```text
pi-tower run -f <objective.md> [--auto-approve] [--timeout <ms>] [--cwd <dir>] [--pi <path>] [-- <extra pi args>]
```

| Option | Meaning |
| --- | --- |
| `-f`, `--file <path>` | The objective file (Markdown). Required. |
| `--auto-approve` | Approves the plan without a human: the run sends `/tower approve --auto`, which is recorded as an automatic approval. Without it, the run stops at the plan with exit code 3. |
| `--timeout <ms>` | Gives up after this many milliseconds, at most 2147483647 (exit code 2) |
| `--cwd <dir>` | The repository to run in. Default: the current directory. |
| `--pi <path>` | The pi executable: a path, or a command looked up on `PATH`. Default: `pi`. |
| `-- <args>` | Passes everything after `--` to pi unchanged |

Relative paths resolve against the current directory. `pi-tower --help` prints the usage, and `pi-tower --version` the version.

| Exit code | Meaning |
| --- | --- |
| `0` | The objective completed |
| `1` | The objective is blocked or paused (for example by a budget), pi exited after the run started, or `/tower approve --auto` failed for a reason other than those of exit code 3 |
| `2` | Timeout (`--timeout`) |
| `3` | The plan needs approval: `--auto-approve` was not given, or only a human may approve this plan because its contract changed while it was blocked or paused. The plan is printed. Approve it with `/tower approve` in pi, or re-run with `--auto-approve` where that is allowed. |
| `4` | Usage or startup error: bad arguments, a missing objective file or directory, pi did not start, pi has no `/tower` command, or `/tower on` or `/tower objective` failed |
| `130` / `143` | Interrupted by SIGINT / SIGTERM. pi is stopped first; a second signal kills it. |

**Getting the command.** `pi-tower` is the package's `bin/pi-tower.js` and needs Node 22.19 or newer. From a checkout, run `node /path/to/pi-tower/bin/pi-tower.js run …`. A global npm install of the package puts `pi-tower` on your `PATH`.

**Loading the extension.** The pi that the run starts loads pi-tower the same way your interactive sessions do: as an installed pi package, or with `-e`, which you pass after `--`, as in `pi-tower run -f objective.md -- -e /path/to/pi-tower/src/index.ts`. Do not combine both. pi would load the extension twice and rename its commands, and the run stops with exit code 4.

What the run does:

1. It starts `pi --mode rpc` in the repository, followed by your extra arguments. The checked-out branch becomes the base, so check out a branch first.
2. It sends `/tower on`, then `/tower objective --headless @<absolute path of the file>`. If the workspace already has an objective that awaits approval or is executing, it follows that one instead and does not send the file again. A paused one ends the run at once with exit code 1: resume it in pi with `/tower resume`, then run `pi-tower run` again to follow it.
3. It reads `.tower/comms/state.json` every second and prints a line whenever the objective or one of its milestones changes state.
4. When the objective awaits approval, it prints the plan. With `--auto-approve` it approves and goes on; without it, it exits with 3.
5. It ends when the objective completes, blocks or pauses, when pi exits, on timeout, or on a signal. pi is always stopped before the run exits.

The run passes your environment to pi, so `PI_TOWER_CONFIG` and the `PI_TOWER_*_MODEL` variables work as usual, for example to give a run its own `tower.json`. Dialogs that nobody can answer are cancelled. The runner writes no files itself: it only reads the state file. Progress goes to stdout, warnings and errors go to stderr.

When you take over a headless objective in pi, a plain `/tower approve` or `/tower resume` switches it back to interactive mode, so the orchestrator asks you again instead of deciding alone.

For unattended runs, set `maxWallTimeMs` and `maxCostUsd` in the [objective settings](#the-objective-section) and use `--timeout` as the outer limit. Approve with `--auto-approve` and leave `objective.autoApprove` off: the flag acts only during this run, and when both are on, they can try to approve the same plan at once, which can fail the run.

An end-to-end example. Keep the objective file outside the repository, because untracked files in the main checkout can end up in worker branches:

```sh
cd ~/work/shop
git switch main
pi-tower run -f ~/objectives/csv-export.md --auto-approve --timeout 14400000
echo "exit code: $?"
```

[`examples/objective.md`](examples/objective.md) is a complete objective file for this run. The output looks like this, with the plan shortened:

```text
[pi-tower +0s] started pi (pi --mode rpc) in /home/you/work/shop
[pi-tower +2s] > /tower on
[pi-tower +2s] pi: Tower mode: ON
[pi-tower +2s] > /tower objective --headless @/home/you/objectives/csv-export.md
[pi-tower +2s] pi: Objective handed to the tower (headless)
[pi-tower +2s] objective handed to the orchestrator: /home/you/objectives/csv-export.md
[pi-tower +2s] waiting for the orchestrator to draft the objective
[pi-tower +48s] O1 planning — MS1 pending · MS2 pending
[pi-tower +2m31s] O1 awaiting-approval — MS1 pending · MS2 pending — features 0/2 done
Plan for O1 "CSV and JSON export for shop report" (awaiting-approval):
  goal: Add a --format option to shop report so the monthly report can be exported as CSV or JSON; the table output stays as it is.
  …
  milestones:
    MS1 Serializers — validation: scrutiny, commands (npm ci && npm test)
      CSV and JSON serializers for report rows, with unit tests.
      - M1 CSV serializer
      - M2 JSON serializer
    MS2 CLI options and docs — validation: scrutiny, user-testing, commands (npm ci && npm run typecheck && npm test)
      QA: Build with npm ci && npm run build, then run node dist/cli.js report --month 2026-10 with each --format.
      (no features planned yet)
  notes:
    - Assumed: --output overwrites an existing file.
  estimated runs: 6 (features + 2 × milestones)
[pi-tower +2m31s] > /tower approve --auto
[pi-tower +2m31s] pi: Objective O1 approved — executing
[pi-tower +2m31s] auto-approved the plan of O1 (--auto-approve)
[pi-tower +2m32s] O1 executing — MS1 active · MS2 pending — features 0/2 done
[pi-tower +16m05s] O1 executing — MS1 validating · MS2 pending — features 2/2 done
[pi-tower +21m40s] O1 executing — MS1 failed · MS2 pending — features 2/2 done
[pi-tower +23m02s] O1 executing — MS1 active · MS2 pending — features 2/3 done
[pi-tower +30m12s] O1 executing — MS1 validating · MS2 pending — features 3/3 done
[pi-tower +34m49s] O1 executing — MS1 passed · MS2 pending — features 3/3 done
[pi-tower +34m50s] O1 executing — MS1 passed · MS2 active — features 3/3 done
[pi-tower +52m19s] O1 executing — MS1 passed · MS2 validating — features 5/5 done
[pi-tower +1h00m] O1 executing — MS1 passed · MS2 passed — features 5/5 done
[pi-tower +1h01m] O1 completed — MS1 passed · MS2 passed — features 5/5 done
[pi-tower +1h01m] objective O1 "CSV and JSON export for shop report" completed
exit code: 0
```

## Droid Missions and pi-tower

Objective mode borrows the shape of [Factory's Droid Missions](https://docs.factory.com/missions/overview): plan with the human, approve, validate every milestone, fix until it holds. It changes how the work runs.

| | Droid Missions | pi-tower objective mode |
| --- | --- | --- |
| Planning | With you: features grouped into milestones | With you, or alone with recorded assumptions in a headless run: a contract (goal, definition of done, acceptance commands) and ordered milestones whose features are tower missions |
| Approval | You approve the plan before execution starts | Only you approve, with `/tower approve`, or an auto-approval you configured. The orchestrator has no tool to approve, and a contract change after approval needs your approval again. |
| Features of a milestone | One after another (Factory's docs list parallel execution as an open question) | In parallel, each in its own git worktree and branch, up to `maxRunningAgents` |
| Review of each feature | Validators check each milestone; no separate review per feature is documented | Each feature gets an independent reviewer and the merge gate before it merges, and the milestone is validated afterwards |
| Validation | Scrutiny and user-testing validators | Scrutiny and user-testing validators, plus a mechanical `commands` kind: milestone and acceptance commands that must exit with 0, run by the tower without a model |
| Fix loop | Failed validation leads to fix features | The same, until every milestone passes. A kind that fails `maxValidationRounds` times blocks the objective for you to decide. |
| Limits | A feature retry limit | `maxFeatureAttempts`, `maxValidationRounds`, a stall watchdog, and wall-time and cost budgets (`maxWallTimeMs`, `maxCostUsd`) that pause the objective |
| Headless | `droid exec --mission -f mission.md` | `pi-tower run -f objective.md [--auto-approve]`, with documented exit codes |
| Models | Orchestrator, worker and validation worker models | Orchestrator, worker, reviewer and validator models |
| Run estimate | features + 2 × milestones | The same formula, shown in the approval request |

## When Tower fits

Use Tower when the work can run in parallel and you accept the extra token consumption and disk usage.

Good candidates:

- The task splits into fairly independent missions, each with a clear way to verify it, so parallel work saves waiting time.
- The requirements are still moving, and you expect to add input, redirect work, or change priorities often.
- You want every change reviewed carefully, with its own branch and its own review.

Choose objective mode when you can say up front what done means and how to check it, and you want the tower to keep going until those checks pass. Steer a free-form run with messages when you are still exploring.

## Run a workflow

This section describes a free-form tower run, steered by your messages. An objective uses the same workspace, branches, reviews and merge gate; [Objective mode](#objective-mode) describes what it adds.

### Before you start

Check out the local branch that should receive the changes, and inspect the working tree:

```sh
cd /path/to/project
git status
```

Start pi in the top-level directory of the repository. Tower creates its workspace (`.tower/`) in pi's working directory.

Tower merges only into a local branch, never into a remote-tracking ref or a tag. If the branch you pass to `/tower <base-branch>` does not exist, Tower creates it from the current checkout; in the interactive UI it asks you to confirm first. The safest choice is an existing branch with a clean working tree.

> [!WARNING]
> Tower may snapshot uncommitted and untracked files into worker branches. When it creates a new base branch, it commits those changes to that branch. In a directory that is not a git repository yet, Tower runs `git init` and makes an initial commit with the existing files. Check for secrets and large files first. Tower adds `.tower/` to `.git/info/exclude`, so its own state is never committed.

### Steps

1. **Turn Tower on.** In most cases run `/tower on`. This command only turns the mode on. It sends no task. On the first initialization the tower records the current local branch as the base. Later activations reuse the recorded base.

   If HEAD is detached (no branch is checked out), or you want another base, run `/tower <base-branch>` instead, for example `/tower feature/my-objective`.

2. **Describe the task.** Type the task as a normal chat message, and say how to verify the work and what counts as done. The tower initializes `.tower/`, plans missions, and starts every worker whose dependencies are satisfied. When a worker finishes or a message reaches the tower's inbox, the tower resumes by itself. If the tower is busy at that moment, the wake-up waits until its current turn ends.

3. **Let the work run in the background.** Each worker works and commits on its own branch, in its own worktree. The tower assigns independent reviewers, rebases when needed, and merges approved missions in dependency order. Answer the tower when it asks about scope or priority.

4. **Verify the merged result.** Inspect `git status`, the history of the base branch and the final diff, and run the tests or acceptance checks you care about. These checks are only a baseline. They do not replace your own acceptance.

5. **Clean up and exit.** Once every mission is merged or abandoned, run `/tower teardown` to remove the mission worktrees that can be removed, then `/tower off` to leave tower mode. [Stop, teardown, and restart](#stop-teardown-and-restart) explains how these actions differ.

## Check status and intervene

You do not need to know the worker protocol to watch and steer Tower.

- **Read the dashboard.** `/tower` or `/tower status` reads the current state directly and does not start a model turn. It shows the base, missions, the roster (with each agent's model), the review gate, the inbox count, the concurrency budget, and recent activity. While there is an objective, it adds a one-line summary of it.
- **Follow an objective.** `/tower objective status` shows the objective dashboard, also without a model turn: the status, elapsed time and cost, every milestone with its features and validation rounds, the live agents, and the next expected step.
- **Redirect work.** While Tower is on, send a normal message to add constraints, change priorities, or ask for a summary. When the tower relays a message to a running worker, the worker sees it at its next step boundary. The tool call in flight is never interrupted.
- **Inspect or stop an agent.** `/tower agents` lists the workers, reviewers and validators of this session with their status, model, thinking level and assignment. `/tower stop <agent>` stops a running one. A worker or reviewer you stop is *dead by intent*: the tower does not resume, reassign, or replace it unless you say so. During an executing objective, the autopilot never resumes or replaces a worker you stopped. It does start a fresh reviewer or validator when a review or validation is still missing, up to `maxFeatureAttempts`; pause the objective if you want nothing new to start.
- **Change the base.** Run `/tower <base-branch>` again. Tower re-checks the open missions against the new base, and only stale branches need a rebase. The main checkout must be on the recorded base before anything is merged.
- **Read the diagnostics.** pi-tower writes its own diagnostics, such as failed notifications and errors from extensions inside agent sessions, to `.tower/pi-tower.log`. Before `.tower/` exists they go to `pi-tower.log` in the pi agent directory.

Each workspace has exactly one tower. If another running pi process owns this workspace's tower, `/tower on` is refused and names that session and its process id. Turn tower mode off in that process first, or quit it. Once the owning process is gone, the next `/tower on` takes the workspace over.

## Merges and rebases

Before it merges a mission, Tower checks the following:

- The mission is complete, with no open tasks or blockers, and its workers are idle.
- The branch contains the current base.
- There is a valid clean review with a `merge` recommendation, normally from an independent reviewer, on the exact branch tip.
- Every changed file is inside the mission scope, and every dependency is merged or abandoned.
- The main checkout is on the recorded base and has no uncommitted changes in the files the merge would touch.

Merges use `--no-ff`. If git reports a conflict, the merge is aborted, so the checkout is never left half-merged.

When the base moves on, Tower can rebase a mission branch onto the new base inside its worktree, as long as the worker is idle and the worktree is clean. A rebase without conflicts keeps the existing clean review bound to the branch. On a conflict, the rebase is aborted and the mission goes back to its worker.

Leave merges and rebases to Tower and do not run extra git integration commands yourself. Do not edit files under `.tower/comms/` by hand: status, notifications and merge checks depend on those records. Reading branches and worktrees is fine.

## Stop, teardown, and restart

These actions clean up different things:

| Action | What it does | What remains |
| --- | --- | --- |
| `/tower off` | Leaves tower mode in this session and switches back to the model you used before `/tower on`. Background agents keep running and no files are removed. The autopilot stops, so an executing objective does not advance until tower mode is on again. | `.tower/`, mission branches and worktrees |
| `/tower teardown` | Asks the tower to remove the mission worktrees that are safe to remove and report the result. Worktrees of running agents are always kept. Worktrees with uncommitted changes are kept unless the removal is forced. Run it once the objective, if any, has completed. | Mission branches and the `.tower/comms/` audit records. Tower mode stays on. |
| Quit pi, or replace the session with `/new`, `/resume`, `/fork`, `/clone` or `/reload` | Stops every worker, reviewer and validator of the tower. They have to be spawned again later. | The `.tower/` state on disk, branches and worktrees |

Tower mode is saved in the pi session. When you continue that session (`pi -c`, `/resume`, `/reload`), tower mode comes back on, unless another running pi process owns the workspace by then. In that case it turns off with a warning.

Agents do not survive a restart. After pi restarts, missions and worktrees are still there, but the workers and reviewers of the previous run are gone. The tower spawns fresh workers under new names. `TowerResume` refuses old agents with a clear message. When a different session takes the workspace over, the previous session's roster entries are retired. An executing objective continues by itself once tower mode is back on; see [Restarts](#restarts).

## Model configuration

### `tower.json`

pi-tower reads its settings from `tower.json`. This is [`examples/tower.json`](examples/tower.json):

```json
{
  "orchestrator": "anthropic/claude-opus-5-5:high",
  "worker": "anthropic/claude-sonnet-5-5:medium",
  "reviewer": {
    "model": "openai/gpt-5.5",
    "thinkingLevel": "high",
    "description": "independent second opinion from another vendor"
  },
  "validator": "openai/gpt-5.5:xhigh",
  "models": {
    "fast": {
      "model": "anthropic/claude-haiku-5-5",
      "description": "cheap and quick: docs, small fixes, surveys"
    }
  },
  "maxRunningAgents": 4,
  "agentTimeoutMs": 3600000,
  "objective": {
    "maxWallTimeMs": 14400000,
    "maxCostUsd": 40,
    "stallTimeoutMs": 300000
  }
}
```

Line by line:

- The tower plans and merges on Claude Opus with thinking `high`.
- Workers build on Claude Sonnet with thinking `medium`.
- Reviewers use a model from another vendor with thinking `high`, which gives an independent second opinion.
- Validators of an objective use the same vendor's model with thinking `xhigh`, for slower and more thorough checks.
- The pool adds one extra model, `fast`. The tower uses it only for a spawn you explicitly ask it for.
- At most 4 agents run at the same time, and each run is stopped after one hour.
- An objective pauses 4 hours after its first approval or once it has cost $40, whichever comes first, and the orchestrator is woken after 5 quiet minutes instead of 3.

Replace the model ids with ones your pi can use. `pi --list-models` lists them.

| Key | Value | Default |
| --- | --- | --- |
| `orchestrator` | Model spec for the main session while tower mode is on | The session's current model |
| `worker` | Model spec for workers | Inherits the orchestrator, including its thinking level |
| `reviewer` | Model spec for reviewers | Inherits the orchestrator, including its thinking level |
| `validator` | Model spec for the validators of an objective | Inherits the reviewer, including its thinking level, or the orchestrator when no reviewer is set |
| `models` | Pool: an object that maps an alias to a model spec | No pool |
| `maxRunningAgents` | Positive integer: the most workers, reviewers and validators that may run at the same time | `256` |
| `agentTimeoutMs` | Positive integer, at most 2147483647: the wall-clock limit of one worker, reviewer or validator run, in milliseconds | `7200000` (2 hours) |
| `objective` | Object: the settings of objective mode, described in [The `objective` section](#the-objective-section) | All defaults |

A **model spec** has one of two forms:

- A string `"provider/modelId[:thinkingLevel]"`, for example `"anthropic/claude-sonnet-5-5:high"`.
- An object `{ "model": "provider/modelId[:thinkingLevel]", "thinkingLevel": "...", "description": "..." }`. Only `model` is required. `description` is shown to the tower in the list of models it may choose from.

Rules for model specs and the file:

- Thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`. Without a level, pi's default thinking level for the model is used.
- A `:suffix` counts as a thinking level only if it is one of these words. Any other suffix stays part of the model id.
- Set the thinking level once: either as the `:suffix` or as `thinkingLevel`, not both.
- Pool aliases are 1 to 64 characters long. They contain letters, digits, `.`, `_` and `-`, and start with a letter or a digit. `primary`, `orchestrator`, `worker`, `reviewer` and `validator` are reserved, in any letter case.
- The file is plain JSON, so comments are not allowed. Unknown keys are rejected with the list of allowed keys, inside the `objective` section too. An empty file counts as `{}`.

### The `objective` section

The optional `objective` object tunes [objective mode](#objective-mode). Every key is optional.

| Key | Value | Default | What it does |
| --- | --- | --- | --- |
| `autopilot` | `true` or `false` | `true` | The autopilot drives feature execution. `false` selects [manual mode](#autopilot-and-orchestrator). |
| `autoApprove` | `true` or `false` | `false` | Approves plans automatically, recorded as an automatic approval. A contract changed while the objective was blocked or paused still needs a human. Keep it off for interactive use; see [Known limitations](#known-limitations). |
| `maxValidationRounds` | Positive integer | `3` | Failed rounds of one validation kind after which the milestone and the objective block |
| `maxFeatureAttempts` | Positive integer | `3` | Worker spawns per feature. It also caps the reviewers per branch tip and the validators per milestone, kind and commit that may end without a result before the orchestrator is woken. |
| `watchdogIntervalMs` | Positive integer, at most 2147483647 | `60000` (1 minute) | How often the watchdog checks the objective |
| `stallTimeoutMs` | Positive integer, at most 2147483647 | `180000` (3 minutes) | How long nothing may change before a stall wake |
| `maxStallWakes` | Positive integer | `3` | Stall wakes in a row without progress before the objective blocks |
| `maxWallTimeMs` | Positive integer, at most 2147483647 | unset | Pauses the objective this many milliseconds after its first approval |
| `maxCostUsd` | Positive number | unset | Pauses the objective once its recorded cost reaches this many US dollars |
| `skipScrutiny` | `true` or `false` | `false` | Never requires `scrutiny` validation |
| `skipUserTesting` | `true` or `false` | `false` | Never requires `user-testing` validation |
| `autoTeardown` | `true` or `false` | `false` | Accepted and shown by `/tower models`, but not used yet: a completed objective never removes worktrees by itself. Run `/tower teardown`. |

`maxValidationRounds`, `maxFeatureAttempts`, `maxWallTimeMs` and `maxCostUsd` are copied into an objective when it is drafted, and `/tower resume` copies them again; the orchestrator cannot change them. The other keys take effect as soon as the configuration is reloaded, except `watchdogIntervalMs`, which applies the next time tower mode turns on. `/tower models` shows every key with its value and source, but it does not edit them: edit the section in `tower.json` by hand.

### Where settings come from

| Source | Sets | Notes |
| --- | --- | --- |
| `--tower-orchestrator-model`, `--tower-worker-model`, `--tower-reviewer-model`, `--tower-validator-model` | One role each | pi command-line flags, string spec |
| `PI_TOWER_ORCHESTRATOR_MODEL`, `PI_TOWER_WORKER_MODEL`, `PI_TOWER_REVIEWER_MODEL`, `PI_TOWER_VALIDATOR_MODEL` | One role each | Environment variables, string spec |
| `<project>/.pi/tower.json` | Any key | Read only when pi trusts the project (see `/trust`). An untrusted project's file is ignored, and `/tower models` says so. |
| `<agentDir>/tower.json` | Any key | Global file. The agent directory is `~/.pi/agent` unless `PI_CODING_AGENT_DIR` moves it. |
| `PI_TOWER_CONFIG=<path>` | — | Replaces the path of the global file. `~/` is expanded, and relative paths resolve against the current directory. |

Precedence, from highest to lowest:

- **Roles:** flag, then environment variable, then the project file, then the global file. A role that is still unset falls back as described in the table at the top: the orchestrator falls back to the session model, the worker and reviewer inherit the orchestrator, and the validator inherits the reviewer when one is configured and the orchestrator otherwise.
- **`models`:** the pools of the global and project files are merged. A project alias replaces a global alias with the same name.
- **`maxRunningAgents` and `agentTimeoutMs`:** the project file wins over the global file. There is no flag or environment variable for them.
- **`objective`:** key by key, the project file wins over the global file, so a project can override one key and keep the others from the global file. There is no flag or environment variable for them.

For example, this run takes the orchestrator and worker from `tower.json` but overrides two roles for this run only:

```sh
PI_TOWER_WORKER_MODEL=anthropic/claude-haiku-5-5 pi --tower-reviewer-model openai/gpt-5.5:xhigh
```

pi-tower reads the configuration when the session starts, each time tower mode turns on (`/tower on` while it is off; while tower mode is already on, `/tower on` changes nothing), and each time you run `/tower models`. After editing `tower.json` by hand, run `/tower models` to reload it. Spawns then use the new settings without a restart.

The sources are checked together. One invalid value in any of them, such as a typo in a flag, an environment variable or either file, makes the whole configuration fail to load. Until you fix it:

- every spawn is refused, and `/tower models` shows the error;
- the session start and `/tower on` warn "Tower model configuration could not be loaded: …";
- `/tower on` still turns tower mode on, but the session keeps its current model.

### `/tower models`

`/tower models` shows the model, thinking level and source of every role and pool alias, followed by the objective settings. It also shows the status of both config files and lists problems, such as a model that is not in pi's model registry or a provider without credentials. If a file does not parse, it shows the error instead. Here, `examples/tower.json` is the global file and `PI_TOWER_REVIEWER_MODEL=openai/gpt-5.5:high` is set:

```text
role          model                        thinking             source
orchestrator  anthropic/claude-opus-5-5    high (configured)    /home/you/.pi/agent/tower.json (global)
worker        anthropic/claude-sonnet-5-5  medium (configured)  /home/you/.pi/agent/tower.json (global)
reviewer      openai/gpt-5.5               high (configured)    env PI_TOWER_REVIEWER_MODEL
validator     openai/gpt-5.5               xhigh (configured)   /home/you/.pi/agent/tower.json (global)
models.fast   anthropic/claude-haiku-5-5   pi default           /home/you/.pi/agent/tower.json (global)

global config: /home/you/.pi/agent/tower.json (loaded)
project config: /home/you/work/shop/.pi/tower.json (not found)

objective            value     source
autopilot            true      default
autoApprove          false     default
maxValidationRounds  3         default
maxFeatureAttempts   3         default
watchdogIntervalMs   60000     default
stallTimeoutMs       300000    /home/you/.pi/agent/tower.json (global)
maxStallWakes        3         default
maxWallTimeMs        14400000  /home/you/.pi/agent/tower.json (global)
maxCostUsd           40        /home/you/.pi/agent/tower.json (global)
skipScrutiny         false     default
skipUserTesting      false     default
autoTeardown         false     default
```

Without a `validator` entry, its row reads `inherited from reviewer` (or `inherited from orchestrator` when no reviewer is configured either).

You can also change the model configuration from inside pi:

```text
/tower models worker anthropic/claude-sonnet-5-5:medium     # set a role in the global tower.json
/tower models validator openai/gpt-5.5:xhigh                # give the validators a model of their own
/tower models fast anthropic/claude-haiku-5-5               # set (or add) the pool alias "fast"
/tower models reviewer openai/gpt-5.5:high --project        # write <project>/.pi/tower.json instead
/tower models reviewer --clear                              # remove the setting again
```

- The target is `orchestrator` (or its alias `primary`), `worker`, `reviewer`, `validator`, or a pool alias. `models.<alias>` works as well.
- Writes are atomic, and an object entry keeps its `description`.
- After a write, pi-tower reloads the configuration, and the next spawn uses it.
- pi-tower warns you when a higher-precedence source (a flag, an environment variable or the project file) still overrides the value you wrote, or when you write to the file of an untrusted project.
- Changing the orchestrator while tower mode is on does not switch the running session. Run `/tower off` and `/tower on`, or use `/model`.

### `/tower on` and `/tower off` switch the session model

If an orchestrator is configured by a file, an environment variable or a flag, `/tower on` switches the main session to that model and its thinking level. `/tower off` switches back to the model and thinking level you had before. If you changed the model yourself with `/model` in the meantime, pi-tower leaves your choice alone.

- If the orchestrator model is not in pi's registry or has no credentials, or the configuration does not load, tower mode still turns on. You get a warning, and the session keeps its current model.
- Without a configured orchestrator, the session's own model is the orchestrator and nothing is switched.

### Choosing a model for one spawn

By default, workers run on the `worker` model, reviewers on the `reviewer` model and validators on the `validator` model. To use a different model for one agent, ask the tower in a normal message:

- "Spawn the reviewer for feat/checkout-docs with the worker model."
- "Use the fast model for agent-docs."
- "Run this reviewer on primary."

The allowed choices are `orchestrator` (or its alias `primary`), `worker`, `reviewer`, `validator`, and the aliases of your `models` pool. Any other provider/model id is refused, and the error lists the allowed choices. Add the model to `models` first if you need it. The autopilot always spawns with the role model.

- The tower passes a model only when you ask for one explicitly.
- A choice applies only to that new agent. It does not change running or resumed agents and is not saved for later spawns.
- The model list in the tower's `TowerSpawn` tool shows every choice with its model and description. It is refreshed when the configuration changes.
- A spawn whose model is unknown to pi or has no credentials is refused, with the reason.

The model of every agent is visible:

- in the spawn result (`model: …`);
- in `/tower agents` and `TowerTasks` (`model: … · thinking: …`);
- in the roster of `/tower status`;
- in the activity log (`spawn … model=… thinking=…`).

An agent keeps its model for its whole life. A resumed worker continues on the model it was spawned with.

### Compared with Kimi Code

| | Kimi Code Tower | pi-tower |
| --- | --- | --- |
| Tower (main agent) | Primary model | `orchestrator` (default: the session model) |
| Worker default | `[secondary_model] default_model`, else the primary model | `worker` (default: the orchestrator) |
| Reviewer default | Always the primary model | `reviewer` (default: the orchestrator) |
| Validator default | — (no objective mode) | `validator` (default: the reviewer, else the orchestrator) |
| Choice for one spawn | `primary` or a pool alias | `orchestrator`/`primary`, `worker`, `reviewer`, `validator`, or a pool alias |
| Where to configure | `config.toml` (`[secondary_model]`) | `tower.json` (global or project), environment variables, flags, `/tower models` |
| Switching the main model | — | `/tower on` switches to the orchestrator, `/tower off` switches back |

With Kimi Code, you cannot give reviewers a model different from the tower's without asking for it on every spawn. With pi-tower, all three roles are independent settings, and so is the optional validator.

## Command reference

| Command | What it does |
| --- | --- |
| `/tower` or `/tower status` | Shows the compact tower status without a model turn |
| `/tower on` | Turns tower mode on: activates the tower tools, adopts an existing `.tower/` workspace, and switches to the orchestrator model. It sends no task. An executing objective continues at once. |
| `/tower <base-branch>` | Turns tower mode on if it is off, and makes this local branch the base: a new workspace is initialized with it, an existing one is re-anchored to it. A missing branch is created from the current checkout, and uncommitted changes are committed onto it. In the interactive UI, pi-tower asks before it creates a branch. |
| `/tower off` | Turns tower mode off and switches back to the previous model. Agents keep running and `.tower/` stays, but the autopilot stops. The tower tools remain available, but `TowerInit`, `TowerPlan`, `TowerSpawn` and `TowerObjective` (except its `status` action) refuse until tower mode is on again. |
| `/tower teardown` | Asks the tower, in a normal message, to run `TowerTeardown` and report what it did. Tower mode stays on. |
| `/tower models` | Shows the role and pool models, their sources, the config files, any problems, and the objective settings |
| `/tower models <role\|alias> <provider/modelId[:thinking]> [--project]` | Sets a role or pool model in the global `tower.json`, or in the project file with `--project` |
| `/tower models <role\|alias> --clear [--project]` | Removes a role or pool model |
| `/tower agents` | Lists this session's workers, reviewers and validators, including finished ones, with status, model and assignment |
| `/tower stop <agent>` | Stops a running worker, reviewer or validator, given its roster name, agent id or task id. This is a human stop: the tower never resumes, reassigns or replaces it unless you say so. During an objective, the autopilot may still start a fresh reviewer or validator for a missing review or validation. |
| `/tower objective [--headless] <text \| @file>` | Hands an objective to the orchestrator, inline or from a file. Tower mode must be on, and no other objective may be awaiting approval, executing or paused. `--headless` plans without questions. See [Objective commands and tools](#objective-commands-and-tools). |
| `/tower objective status` | Shows the objective dashboard without a model turn |
| `/tower approve [--auto]` | Approves the plan of the objective awaiting approval. `--auto` records an automatic approval. |
| `/tower pause [reason]` | Pauses the executing objective: running agents finish their turn, and nothing new starts |
| `/tower resume` | Resumes a paused or blocked objective, after reloading its limits from the current objective settings |
| `/tower help` | Shows the usage of every subcommand (`--help` and `-h` work too) |

Subcommands are case-insensitive. The base branch keeps its case. Tab completion covers subcommands, agent names, model targets, the `--clear`/`--project` options, `objective status`/`--headless`, and `approve --auto`.

Common slips are refused with a "did you mean" hint instead of being taken as a branch name:

- the near-miss words `model`, `config`, `configure`, `agent`, `task`, `tasks`, `list`, `ls`, `start`, `enable`, `disable`, `stat`, `state`, `kill`, `objectives`, `goal`, `approval`, `accept`, `unpause` and `continue`;
- extra words after a subcommand that takes none, such as `/tower on now`;
- base branch names with spaces.

A near-miss word that names an existing local branch is not refused. With a local `config` branch, `/tower config` makes `config` the base like any other `/tower <base-branch>`, and re-anchors a workspace that records another base. Only a near-miss word without such a branch is refused, so a slip never creates a new branch.

Only you can turn tower mode on. The model cannot enable it by itself.

## Tool reference

pi-tower has 19 tools. The orchestrator gets 17 of them. Workers and reviewers get 7, and `TowerComplete` exists only for them. Validators get 5, and `TowerValidate` exists only for them.

**Orchestrator tools.** They become active with `/tower on`, and only the main session has them.

| Tool | Purpose |
| --- | --- |
| `TowerInit` | Initializes (or adopts) the `.tower/` workspace and records the base branch |
| `TowerPlan` | Splits the work into missions with ids, branches, scopes, tasks and dependencies. During an objective, each feature also names its `milestone` and an `origin` of `plan` or `fix`. |
| `TowerSpawn` | Starts a worker for a mission in its own worktree, a reviewer for a branch, or a validator for a validating milestone (`milestone`, `validation_kind`), with the role model or an explicit choice |
| `TowerMerge` | Merges a mission branch into the base (`--no-ff`) once the merge gate passes |
| `TowerRebase` | Rebases a stale mission branch onto the current base inside its worktree |
| `TowerTeardown` | Removes finished mission worktrees (dry run, exclude and force options), keeping branches and `.tower/comms/` |
| `TowerSend` | Sends an inbox message to an agent, to the tower, or to `all`. A running agent gets it at its next step. |
| `TowerInbox` | Reads the inbox page by page and acknowledges only the messages it returns |
| `TowerFinding` | Files a structured finding (bug, improve, vuln, idea) about something outside a mission's scope |
| `TowerReview` | Submits a review verdict. The tower uses it only as an exceptional break-glass. |
| `TowerMission` | Reads or updates a mission: status, notes, blockers, done or dropped tasks, scope |
| `TowerStatus` | Shows the full dashboard: the objective, missions, awaiting spawns, dead workers, roster, review gate, inbox, concurrency, activity |
| `TowerResume` | Continues a stopped or finished worker in the background with a new prompt. The worker keeps its context. Validators cannot be resumed. |
| `TowerTasks` | Lists the background workers, reviewers and validators with status, model and assignment |
| `TowerTaskOutput` | Shows a snapshot of one agent: status, latest text, recent tool calls, usage, final message |
| `TowerTaskStop` | Stops a running worker, reviewer or validator. The tower can resume a worker it stopped itself. |
| `TowerObjective` | Manages the objective: `draft`, `update`, `request-approval`, `status` and `block`. There is no approve and no complete action. |

**Worker and reviewer tools.** They exist only inside agent sessions.

| Tool | Purpose |
| --- | --- |
| `TowerComplete` | Workers only: completes the mission and stores the review request (or survey summary) for the tower |
| `TowerFinding` | Files a finding instead of fixing something outside the mission scope |
| `TowerInbox` | Reads messages from the tower and other agents |
| `TowerMission` | Reads the mission. A worker can update only its own mission. |
| `TowerReview` | Reviewers: submits the verdict for the assigned branch |
| `TowerSend` | Messages the tower or another agent |
| `TowerStatus` | Reads the dashboard |

**Validator tools.** They exist only inside validator sessions.

| Tool | Purpose |
| --- | --- |
| `TowerValidate` | Validators only: submits the verdict (`pass` or `fail`, with failures, checks and evidence) for the assigned milestone and kind, exactly once |
| `TowerFinding` | Files a finding about a problem outside the milestone |
| `TowerInbox` | Reads messages from the tower and other agents |
| `TowerSend` | Messages the tower or another agent |
| `TowerStatus` | Reads the dashboard |

Besides these, workers get pi's `read`, `bash`, `edit`, `write`, `grep`, `find` and `ls` tools. Reviewers and validators get `read`, `bash`, `grep`, `find` and `ls`, with no `write` or `edit`.

While tower mode is off, `TowerInit`, `TowerPlan`, `TowerSpawn` and `TowerObjective` (except its `status` action) refuse. The other tools keep working, so pending merges and messages can still be finished.

## Safety and resource cost

Worktrees isolate writes, but they are not a security sandbox.

- Workers can read the repository and run tools with your permissions, and they never ask for approval.
- Workers, reviewers and validators run headless. They cannot spawn subagents: pi-tower is not loaded inside them, and their tool list contains no subagent tool.
- The validation commands of an objective come from the plan you approve, and the tower runs them with your permissions, unattended. Read them in the approval request before you approve.
- Mission scopes, merge checks and the guards below are process rules, not security boundaries.

pi-tower adds three guards:

- **Bash guard.** It is active while the workspace has an owner, and it checks the bash calls of the orchestrator and of every worker, reviewer and validator. It blocks:
  - `rm` on `.tower/comms`;
  - recursive `rm` on `.tower` or on a directory that contains it;
  - `git clean` with force and `-x`/`-X` when it covers the main checkout;
  - `git reset --hard` in the main checkout.

  The same commands are allowed inside a mission or validation worktree. A command that mentions `rm`, `git clean` or `git reset` is blocked as a precaution when the parser cannot analyze it safely, for example because it uses command substitution or a heredoc, or because a path it would delete depends on a variable. The guard models only these commands, so other destructive commands are not caught, the same as in Kimi Code. It checks pi's `bash` tool only; the Windows `powershell` tool is not guarded.

  Because it errs on the side of blocking, it also stops some harmless commands, for example `source "$HOME/x" && rm -rf y`, `ENV=x bash script && rm -rf y`, or `cd <worktree> || exit 1; git reset --hard` run from the main checkout. Splitting such a command into simpler ones avoids this.
- **Write guard.** A worker's `write` and `edit` calls outside its own worktree are denied.
- **Read-only reviewers and validators.** Reviewers and validators have no `write` or `edit` tools. For validators, a `write` or `edit` call is also vetoed outright.

Resource cost:

- Every worker, reviewer and validator has its own model context and consumes tokens separately. The tower's planning, message routing, recovery and merge turns also consume tokens. More agents put more pressure on your quota, CPU and disk.
- `maxRunningAgents` limits how many workers, reviewers and validators run at the same time. Without a value the limit is 256. The mechanical `commands` validation does not count against it.
- When a provider answers with a rate limit (HTTP 429), the limit shrinks to fit and new spawns pause for about a minute.
- `/tower status` shows the current budget and the number of running agents without starting a model turn.
- A run that exceeds `agentTimeoutMs` (default 2 hours) ends as timed out, and the tower is notified.
- An objective takes at least one agent run per feature and two per milestone, and every failed validation adds fix features and validation rounds. Bound it with `maxCostUsd` and `maxWallTimeMs` in the [objective settings](#the-objective-section).

Start with a few independent missions, and remove finished worktrees to get disk space back.

## Known limitations

- **Auto-approval and blocked objectives.** With `"objective": { "autoApprove": true }`, the orchestrator could draft a fresh objective after one blocked, and that objective would be approved automatically. This restarts the wall-time and cost budgets without you. Keep `autoApprove` off for interactive use. The headless runner exits with code 1 on a blocked objective before this can happen.
- **Validation commands bring their own setup.** They run in a fresh, detached checkout without installed dependencies or build output, so every command must include its setup, for example `npm ci && npm test`.
- **No browser for user-testing.** User-testing validators have no browser or GUI tooling. Their behavioural QA relies on what bash can drive: CLIs, HTTP calls and scripts.
- **One-second commit timestamps.** To decide whether a review request covers the current branch tip, the autopilot compares commit timestamps, which have a resolution of one second. This is harmless: reviewers always review the real tip.
- **Node 22 is untested for `pi-tower`.** The command was developed and tested on Node 26 only. Its code paths for Node 22.x are untested.
- **`autoTeardown` does nothing yet.** The key is accepted and shown, but a completed objective never removes worktrees by itself. Run `/tower teardown`.

## Differences from kimi-code Tower

pi-tower ports Kimi Code's Tower: the protocol store, the 13 Tower tools, their descriptions and refusals, the worker and reviewer briefings, the reminders, the merge gate and the status dashboard. Where pi works differently, pi-tower adapts. Each item below matches the code as shipped.

**Objective mode**

- **An addition of pi-tower.** Kimi Code's Tower has no objectives, milestones, validators or autopilot. `TowerObjective`, `TowerValidate`, the `validator` role, `/tower objective`, `/tower approve`, `/tower pause`, `/tower resume` and `pi-tower run` exist only in pi-tower. Underneath, the ported protocol is unchanged: every feature of an objective is an ordinary mission with the same review and merge gate.
- **Nothing changes without an objective.** In a workspace that never starts an objective, missions, reviews, merges and the state files work exactly as in pi-tower 0.1.

**Models**

- **Three role models instead of two.** `orchestrator`, `worker` and `reviewer` can each be set separately, plus a pool, and objective mode adds an optional `validator`. In Kimi Code, the tower and reviewers share the primary model, and workers default to `[secondary_model]`.
- **Configuration.** Settings come from `tower.json` (global, or project if trusted), `PI_TOWER_*_MODEL`, `--tower-*-model` and `/tower models`, instead of `config.toml`.
- **The session model follows the mode.** `/tower on` switches the session to the orchestrator model, and `/tower off` switches back.
- **The `model` parameter of `TowerSpawn` always exists.** Its choices are the roles and pool aliases. Kimi Code hides the parameter when there is no pool.
- **Thinking levels.** They come from a `:level` suffix or `thinkingLevel` per model, else pi's default. Kimi Code uses `default_effort`.
- **Validation per spawn.** An unknown model or missing credentials refuse the spawn, and `/tower models` lists the problem. Kimi Code fails at session start instead.
- **Limits.** The concurrency cap is `maxRunningAgents` in `tower.json` instead of `max_running_tasks`. The run timeout is `agentTimeoutMs` instead of `[subagent] timeout_ms`, and it must be positive, so there is no "0 = no timeout". The defaults are the same: 256 agents and 2 hours.

**Enabling Tower**

- **No experiment flag and no telemetry.** There is no `KIMI_CODE_EXPERIMENTAL_TOWER` or `[experimental] tower`. Installing or loading the extension is the opt-in, and the tools stay inactive until `/tower on`. No `tower_mode_enter`/`tower_mode_exit` events are sent anywhere. The activity log in `.tower/comms/log/` is the only record.
- **No mode exclusivity with Goal, Plan or swarm.** pi has no such built-in modes. While tower mode is on, the orchestrator is blocked from these tools: `todo`, `todo_write`, `TodoWrite`, `TodoList`, `subagent` and `AgentSwarm`, for example when another extension provides them. Every other tool is untouched. Kimi Code also blocks `CreateGoal` and goal activation through `UpdateGoal`, which pi does not have.

**Agents**

- **Agent tools.** Kimi Code uses its generic `Agent` (resume), `TaskList`, `TaskOutput` and `TaskStop` tools and the `/tasks` panel. pi has none of these. pi-tower adds `TowerResume`, `TowerTasks`, `TowerTaskOutput` and `TowerTaskStop`, plus `/tower agents` and `/tower stop <agent>`.
- **Resumes.** `TowerResume` always runs in the background, and a resumed run counts against the concurrency limit.
- **Workers run inside their worktree.** A worker's session uses its worktree as the working directory. In Kimi Code, workers run in the main checkout with absolute paths. Reviewers use the main checkout in both. Validators, which exist only in pi-tower, work in a detached validation worktree.
- **Agent tool set.** Workers get `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` and the 7 agent Tower tools. Kimi Code workers also get web, todo, cron, wait and MCP tools. pi does not ship the first four, and agent sessions do not load pi's built-in MCP support.
- **Agent sessions.** They load your pi settings, skills, context files and configured extensions, except pi-tower itself. Only the tools listed above are enabled in them. Their transcripts are stored in `.tower/agents/`.
- **Reviewers cannot write.** They get no `write`/`edit` at all. Kimi Code gives reviewers write tools and relies on their briefing.
- **Approvals.** pi has no per-action approval prompts. Agent sessions run headless, so an extension that needs an interactive confirmation cannot ask for it inside a worker.
- **Long commands.** pi's `bash` tool has no background mode, so the worker role prompt asks workers to use timeouts and check their inbox between long steps.

**Restarts and ownership**

- **No resume after a restart.** After `/reload` or `pi -c`, the roster survives but the agent runs do not. `TowerResume` refuses with "not running in this process — the tower restarted", and the tower spawns a fresh worker under a new name. A new session retires the old roster entries instead. pi-tower does not reopen the stored agent transcripts.
- **One tower per workspace, across processes.** Ownership is recorded with the owner's process id. `/tower on` is refused while another live pi process owns the workspace. A dead owner, or a session that pi replaced in the same process, is taken over. As in Kimi Code, quitting does not release ownership; the next session adopts the workspace.

**Notifications and guards**

- **A wake turn is never cancelled.** Kimi Code cancels a running inbox-wake turn when you type, then re-queues the wake. pi-tower does not do this. Your message is steered into the running turn at its next step boundary, and the wake is not lost.
- **Rate-limit feedback.** HTTP 429 responses from the orchestrator and from agents shrink the concurrency budget and pause new spawns.
- **Bash guard parser.** Kimi Code parses commands with tree-sitter. pi-tower uses its own conservative parser with no extra dependencies, and it blocks every guarded command it cannot analyze safely. The veto messages are the same as in Kimi Code.

## Development

```sh
npm install
npm run typecheck
npm test
```

`npm test` runs the offline vitest suite. It needs no model or network access and never starts pi. Its one live runtime test is skipped unless `PI_TOWER_LIVE=1` is set (the model comes from `PI_TOWER_LIVE_MODEL`).

The extension entry point is `src/index.ts`, declared under `pi.extensions` in `package.json`.

### Live end-to-end run

`npm run test:e2e:pi` checks pi-tower against real models. It starts real `pi` processes in RPC mode with the extension from this checkout, and drives them through throwaway git repositories in a temporary run directory (`pi-tower-e2e-*`).

| Scenario | What it checks | Report label |
| --- | --- | --- |
| S1 | three distinct models, one per role | mandatory |
| S2 | the command surface and the mode lifecycle | mandatory |
| S3 | a full objective lifecycle | mandatory |
| S8 | the guards and vetoes | mandatory |
| S4 | the review rework loop | optional |
| S7 | a human stop with `/tower stop` | optional |
| S13 | the `maxRunningAgents=1` concurrency budget | optional |

All seven run by default. The run exits with 1 when a selected scenario fails or your pi settings changed, and with 2 when it hits the global timeout.

```sh
npm run test:e2e:pi -- --selfcheck
npm run test:e2e:pi
PI_TOWER_E2E_SCENARIOS=S1,S2,S3,S8 npm run test:e2e:pi -- --report=e2e-report.md
```

`--selfcheck` runs only the offline checks and starts no session. It still calls `pi --version`, so `pi` must be on your `PATH`. It checks the wake parser against this checkout and prints whether each role model can be told apart from pi's default model and from the starting session model.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_TOWER_E2E_CHECKOUT` | this checkout | The pi-tower checkout whose `src/index.ts` is loaded |
| `PI_TOWER_E2E_PI` | `pi` | The pi binary |
| `PI_TOWER_E2E_ORCHESTRATOR_MODEL` | `byteplus-gateway/claude-sonnet-5-5:low` | Orchestrator model |
| `PI_TOWER_E2E_WORKER_MODEL` | `byteplus-gateway/claude-haiku-5-5:low` | Worker model |
| `PI_TOWER_E2E_REVIEWER_MODEL` | `byteplus-gateway/claude-opus-5-5:low` | Reviewer model |
| `PI_TOWER_E2E_SESSION_MODEL` | `byteplus-gateway/claude-haiku-5-5:low` | Session model before `/tower on`. It must differ from the orchestrator model, so the switch is observable. |
| `PI_TOWER_E2E_SCENARIOS` | `all` | Comma-separated scenario ids such as `S1,S3`. `--scenarios=S1,S3` does the same. |
| `PI_TOWER_E2E_TIMEOUT_MS` | `4500000` (75 minutes) | Timeout for the whole run |
| `PI_TOWER_E2E_SCENARIO_TIMEOUT_MS` | `1200000` (20 minutes) | Timeout for each scenario |
| `PI_TOWER_E2E_KEEP` | unset | `1` keeps the run directory with its repositories and logs. `--keep` does the same. |
| `PI_TOWER_E2E_VERBOSE` | unset | `1` echoes the output of the pi processes. `--verbose` does the same. |
| `PI_TOWER_E2E_REPORT` | unset | Writes the Markdown report to this path. `--report=<path>` does the same. |

Models use the `provider/modelId[:thinking]` form. The orchestrator, worker and reviewer models must be three distinct provider/model ids, or the run refuses to start. The defaults name a `byteplus-gateway` provider, so set the model variables to models that your pi setup can reach. The run uses the providers and credentials of that setup.

A run spends real tokens. A full run takes about 6 minutes and costs roughly $1.1–1.3 with the default sonnet, haiku and opus models at low thinking.

The run never modifies your pi settings. Every pi process gets its own `tower.json` (through `PI_TOWER_CONFIG`) and its own session directory inside the run directory. Each one starts with `--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-context-files` and `--offline`. The runner fingerprints `settings.json` and `tower.json` in your agent directory (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`) before and after the run, and fails the run if either changed.

## License and credits

pi-tower is released under the [MIT License](LICENSE), Copyright (c) 2026 YukoOshima.

pi-tower is a port of the Tower mode of [Kimi Code](https://github.com/MoonshotAI/kimi-code) by Moonshot AI. Its protocol, tool descriptions, prompts and tests are derived from that project, which is also [MIT-licensed](https://github.com/MoonshotAI/kimi-code/blob/main/LICENSE) (Copyright (c) 2026 Moonshot AI). Both notices are in [LICENSE](LICENSE). Thanks to the Kimi Code team for the original design.
