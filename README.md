# pi-tower

English | [简体中文](README.zh-CN.md)

**Droid-style Missions for the [pi coding agent](https://github.com/earendil-works/pi), run in parallel.**

Run `/mission`, describe what you want built, and answer a few questions. The orchestrator plans the work as milestones of small features, and you approve the plan. A swarm of workers then builds the features of each milestone at the same time, each on its own git branch and worktree. An independent reviewer checks every feature before it merges, validators check every milestone, and whatever fails is fixed until the whole plan passes. The orchestrator, the workers and the reviewers each run on a model you choose.

You use it the way you use [Factory's Droid Missions](https://docs.factory.com/missions/overview). The one difference: Droid builds the features one after another, while pi-tower builds the features of a milestone in parallel, to finish sooner.

pi-tower is built on a port of the Tower multi-agent mode of [Kimi Code](https://github.com/MoonshotAI/kimi-code). Its `/tower` commands are still there for direct control; see [Advanced](#advanced).

> [!WARNING]
> Workers, reviewers and validators run unattended. They never ask you to approve individual actions. Read [Safety and resource cost](#safety-and-resource-cost) before you start.

## Quick start

```sh
pi install git:github.com/YukoOshima/pi-tower
cd /path/to/project
git switch main        # the branch that should receive the work
pi
```

1. *Optional:* choose a model for each role in `~/.pi/agent/tower.json` (see [Choose the models](#choose-the-models)). Without it, every role uses your current pi model.
2. Run `/mission`. It shows the orchestrator, worker, reviewer and validator models and asks what you want to build.
3. Describe the goal in a normal message.
4. Answer the orchestrator's questions. It then plans every milestone, each split into features that run in parallel.
5. Approve the plan in the dialog, or with `/mission approve`.
6. Watch Mission Control above the editor. Talk to the orchestrator at any time; `/mission pause` and `/mission resume` stop and restart new work.
7. When every milestone has passed validation, the mission completes and its worktrees are removed. Check the result on your branch, then leave with `/mission exit`.

[Your first mission](#your-first-mission) walks through each step.

## Contents

- [Quick start](#quick-start)
- [Installation](#installation)
- [Choose the models](#choose-the-models)
- [Your first mission](#your-first-mission)
- [`/mission` commands](#mission-commands)
- [Headless missions](#headless-missions)
- [pi-tower and Droid Missions](#pi-tower-and-droid-missions)
- [Advanced](#advanced)
  - [How a mission runs](#how-a-mission-runs)
  - [Tower mode: the `/tower` layer](#tower-mode-the-tower-layer)
  - [`/tower` command reference](#tower-command-reference)
  - [Configuration](#configuration)
  - [Tool reference](#tool-reference)
  - [Safety and resource cost](#safety-and-resource-cost)
  - [Known limitations](#known-limitations)
  - [Differences from kimi-code Tower](#differences-from-kimi-code-tower)
- [Development](#development)
- [License and credits](#license-and-credits)

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

There is no experiment flag to turn on. Loading the extension is the opt-in. Its tools stay inactive, and hidden from the model, until you run `/mission` (or `/tower on`).

A mission needs a git repository with at least one commit and a checked-out branch. That branch receives the work.

For unattended runs, the package also ships the `pi-tower` command (`bin/pi-tower.js`, Node 22.19 or newer); see [Headless missions](#headless-missions).

## Choose the models

A mission has three roles, plus an optional fourth. Each can run on a model of its own:

| Role | What it does | When it is not set |
| --- | --- | --- |
| `orchestrator` | Your pi session while mission mode is on: it interviews you, plans, answers your messages and decides what to do about failures | The session's current model (whatever `/model` selected) |
| `worker` | Builds one feature in its own worktree | The orchestrator's model and thinking level |
| `reviewer` | Reviews every finished feature before it can merge | The orchestrator's model and thinking level |
| `validator` | Optional: validates every milestone | The reviewer's model and thinking level, or the orchestrator's when no reviewer is set |

Set them in `~/.pi/agent/tower.json`. Every key is optional:

```json
{
  "orchestrator": "anthropic/claude-opus-5-5:high",
  "worker": "anthropic/claude-sonnet-5-5",
  "reviewer": "openai/gpt-5.5:high",
  "validator": "openai/gpt-5.5:xhigh"
}
```

A model is written `provider/modelId`, optionally followed by a thinking level such as `:high`. `pi --list-models` lists the models your pi can use.

- `/mission` shows the model of every role when you enter mission mode, and Mission Control shows them while the mission runs.
- `/mission models` shows every role with its thinking level and the place it was set, and lists problems such as missing credentials.
- `/mission models worker anthropic/claude-sonnet-5-5:medium` changes a role without editing the file, and `/mission models worker --clear` removes it again.
- For a single run, pi flags (`pi --tower-worker-model …`) and environment variables (`PI_TOWER_WORKER_MODEL=…`) override the file.
- While mission mode is on, your pi session runs on the orchestrator model. `/mission exit` switches it back.

[Configuration](#configuration) describes every setting, including a project-level `tower.json`, a pool of extra models, limits and budgets.

## Your first mission

This walkthrough adds a CSV and JSON export to `shop`, a small Node CLI. [`examples/mission.md`](examples/mission.md) holds the same goal as a complete mission file.

### 1. Enter mission mode

Start pi in the repository, on the branch that should receive the work, and run `/mission`:

```text
Mission mode
  Orchestrator  anthropic/claude-opus-5-5 · high  (global tower.json)
  Worker        anthropic/claude-sonnet-5-5       (global tower.json)
  Reviewer      openai/gpt-5.5 · high             (global tower.json)
  Validator     openai/gpt-5.5 · xhigh            (global tower.json)
  Base branch   main (tower workspace initialized now) · features run in parallel (up to 256 agents)
  Change a model with /mission models <role> <provider/model[:thinking]>
What do you want to build? Describe the goal. I'll ask a few questions, then propose a plan for your approval.
```

- Each role shows its model, its thinking level and where it was set. A validator without a model of its own shows `same as reviewer` (or `same as orchestrator`).
- The first `/mission` in a repository creates the `.tower/` workspace and records the current branch as the base, the branch the features merge into. pi-tower adds `.tower/` to `.git/info/exclude`, so its state is never committed.
- At most 256 agents run at the same time; `maxRunningAgents` in [`tower.json`](#configuration) lowers the limit.
- Mission mode turns tower mode on: the footer shows `tower: on` and `mission: waiting for your goal`.

### 2. Describe the goal

Your next message is the goal of the mission. It can be one sentence or a whole spec:

```text
Add a --format csv|json option to `shop report`; the table output must not change; npm test must pass
```

- A message that is just `@path/to/file.md` reads the goal from that file, for example `@examples/mission.md`.
- `/mission <goal>` and `/mission @<file>` skip the header and start planning at once.
- A slash command is never taken as the goal.

### 3. Answer the orchestrator's questions

Before it plans anything, the orchestrator interviews you, a few questions at a time:

- what done looks like;
- what is out of scope;
- how a user will try the result;
- which commands prove it, such as tests, builds or scripts;
- constraints such as the stack, compatibility, or code to leave alone.

Answer in normal messages. It skips what your goal already answers and pushes back on vague points. If you tell it the goal is complete as written, it plans without asking.

Then it drafts the plan:

- a goal, a definition of done, and acceptance commands when a command can prove the result;
- ordered milestones, each a validation checkpoint that leaves the product working;
- the features of **every** milestone, planned up front. The features of a milestone run in parallel, so the orchestrator splits each milestone into as many small features as the work allows, gives them separate files, and makes a feature wait for another one only when it needs that feature's merged code.

### 4. Approve the plan

When the plan is ready, you get the full approval request:

```text
Mission O1 "CSV and JSON export for shop report" is ready for your approval.

Goal: Add a --format option to shop report so the monthly report can be exported as CSV or JSON; the table output stays as it is.

Definition of done:
1. shop report --format csv writes RFC 4180 CSV with a header row
2. shop report --format json writes a JSON array of the same rows
3. shop report without --format prints exactly what it prints today
4. npm test and npm run typecheck pass

Acceptance commands (run on the final milestone): `npm ci && npm run typecheck && npm test`

Milestones — validation checkpoints, in order; the features of a milestone run in parallel:
1. MS1 "Serializers" — 2 features, both in parallel: M1 "CSV serializer", M2 "JSON serializer"
   CSV and JSON serializers for report rows, with unit tests.
   validation: scrutiny · commands `npm ci && npm test`
2. MS2 "CLI options and docs" — 3 features (2 start in parallel, 1 after its deps merge): M3 "--format option", M4 "--output option" (after M3), M5 "README for report export"
   validation: scrutiny · user-testing · commands `npm ci && npm run typecheck && npm test`

Assumptions and notes:
- Assumed: --output overwrites an existing file.

Estimated runs: ≈ 9 (5 features + 2 × 2 milestones). This is a floor, not a ceiling: failed validations add fix features and further validation rounds.

To approve, use the approval dialog or run: /mission approve
Only you can approve — the orchestrator cannot. To change the plan, tell the orchestrator what to change; it updates the plan and asks for approval again.
```

O1 is the mission, MS1 and MS2 are its milestones, and M1 to M5 are its features. Then a dialog asks for your decision:

```text
Mission O1 "CSV and JSON export for shop report" — plan ready (2 milestones · 5 features). Approve it?
  Not yet — keep planning
  Approve and start mission
```

- The dialog opens on **Not yet — keep planning**, so pressing Enter alone never approves. To approve, press ↓ and then Enter. You can also close the dialog and run `/mission approve`.
- Typing or pasting while the dialog is open closes it, and the text goes to the editor, so a stray keystroke cannot approve the plan. For half a second after it opens, the dialog also ignores ↑, ↓ and Enter, so a keypress meant for something else cannot approve it either.
- The dialog waits until the orchestrator has finished its turn, the editor is empty, no other extension's dialog is open, and the keyboard has been quiet for 2 seconds.
- To change the plan, say what to change in a normal message. The orchestrator updates the plan and asks again, with a new dialog. When the contract changed after an approval, the dialog says **plan revised** and its second option reads **Approve the revised plan**.
- Only you can approve. The orchestrator has no tool for it.

Once you approve, the mission starts:

```text
Mission O1 approved — executing
"CSV and JSON export for shop report" starts now: milestone MS1 "Serializers" is active and its features run in parallel. Mission Control above the editor follows it; /mission shows the details and /mission pause stops new work.
```

### 5. Watch Mission Control

From here the autopilot, plain code rather than a model, does the mechanics. It starts a worker for every feature of the current milestone whose dependencies have merged, sends each finished feature to an independent reviewer, merges what passes the merge gate, runs the milestone's validation, and moves on to the next milestone. The orchestrator is woken only when judgment is needed, for example to plan fixes after a failed validation.

Mission Control sits above the editor and refreshes as the mission moves:

```text
🔵 Mission O1 CSV and JSON export for shop report · executing · 37m 00s · $4.37
✅ MS1 Serializers   🔵 MS2 CLI options and docs (1/3 merged)
🔵 M4 --output option — worker ap-w-M4-1 running
🟢 M5 README for report export — in review · ap-r-M5-1
✅ M3 --format option — merged
agents: 1 worker · 1 reviewer · 0 validators running · limit 256
models: orchestrator claude-opus-5-5 · worker claude-sonnet-5-5 · reviewer gpt-5.5 · validator gpt-5.5
next: 2 features of MS2 in flight — validation starts once all are merged
```

From the top: the mission with its status, elapsed time and cost (and the budget, when you set one), the milestones, the features of the current milestone with their state and agent, the running agents, the models, and the next step. The footer mirrors it in one line: `mission O1 executing · MS2 1/3 merged · 2 agents`.

The panel never takes more than 10 lines. When a milestone has more features than fit, the last feature line says how many more there are, and `/mission` lists them all. A model is shown without its provider unless two roles use the same model id from different providers. When the models do not fit on one line, in a narrow terminal or with long model ids, they take two roles per row, or one role per row:

```text
models: orchestrator claude-opus-5-5 · worker claude-sonnet-5-5
        reviewer gpt-5.5 · validator gpt-5.5
```

`/mission` prints the full view, without starting a model turn:

```text
Mission Control
## Models
Orchestrator  anthropic/claude-opus-5-5 · high  (global tower.json)
Worker        anthropic/claude-sonnet-5-5       (global tower.json)
Reviewer      openai/gpt-5.5 · high             (global tower.json)
Validator     openai/gpt-5.5 · xhigh            (global tower.json)

# Mission O1 — CSV and JSON export for shop report
🔵 executing · elapsed 37m 00s · cost $4.37 · approved by human
Goal: Add a --format option to shop report so the monthly report can be exported as CSV or JSON; the table output stays as it is.

## Milestones
✅ MS1 Serializers — passed · features 3/3 merged (1 fix) · scrutiny r2 pass · commands r2 pass
🔵 MS2 CLI options and docs — active · features 1/3 merged · validation: scrutiny · user-testing · commands `npm ci && npm run typecheck && npm test`

## Current milestone MS2 — features (run in parallel)
- ✅ M3 --format option — merged
- 🔵 M4 --output option — active · worker ap-w-M4-1
- 🟢 M5 README for report export — completed

## Live agents (2)
- ap-w-M4-1 — worker · M4 --output option
- ap-r-M5-1 — reviewer · feat/readme-for-report-export

## Next
2 of 3 features of MS2 still open, running in parallel — validation starts once every feature is merged or abandoned.

## Commands
/mission pause [reason] — pause: running agents finish their turn, nothing new starts
/mission agents — list the agents; /mission stop <agent> stops one
/mission models — show or change the models
Talk to the orchestrator in plain language at any time
/mission exit — leave mission mode (agents keep running)
```

Here the first scrutiny round of MS1 failed. The orchestrator planned the fix feature M6, and the second round passed on the new tip of `main`.

### 6. Steer, pause and resume

The orchestrator stays your conversation partner while the mission runs. Tell it what you see, add a constraint, or ask it to re-plan, in plain language, at any time. A change to the contract after approval, such as the goal, the definition of done or the validation of a milestone, needs your approval again.

- `/mission pause [reason]` stops new work. Running agents finish their current turn.
- `/mission resume` continues a paused or blocked mission with the limits from your current settings.
- `/mission agents` lists the workers, reviewers and validators. `/mission stop <agent>` stops one for good: nobody resumes or replaces it unless you say so.

A mission pauses by itself when a budget you set runs out, and it blocks when it cannot converge: a validation kind keeps failing, or the work stalls. You get the reason and the latest failures. Raise the budget in `tower.json`, or answer the orchestrator and tell it what to change, then run `/mission resume`.

### 7. Done

When the last milestone has passed validation on the current tip of your branch, the mission completes, and you get a summary:

```text
Mission O1 "CSV and JSON export for shop report" is complete: every milestone passed validation, and the final validation ran on main at 3f9c2e1.

- MS1 "Serializers" — passed (scrutiny r2, commands r2)
- MS2 "CLI options and docs" — passed (scrutiny r1, user-testing r1, commands r1)

Features: 6 merged (1 fix). Elapsed: 1h 01m. Cost: $7.92.

Definition of done, verified by the validators:
1. shop report --format csv writes RFC 4180 CSV with a header row
2. shop report --format json writes a JSON array of the same rows
3. shop report without --format prints exactly what it prints today
4. npm test and npm run typecheck pass

The result is on main. The mission worktrees are cleaned up automatically unless objective.autoTeardown is off — then /tower teardown removes them; branches and .tower/comms/ stay as the audit trail. /mission starts the next mission.

Automatic teardown: removed 6 worktree(s), kept 0.
- removed .tower/worktrees/wt-1
- removed .tower/worktrees/wt-2
…
```

Check the result on your branch (`git log --graph`, your tests), then leave with `/mission exit`. `/mission` starts the next mission.

The automatic teardown removes the worktrees of the merged and abandoned features and any leftover validation worktrees. It never forces anything:

- It keeps a worktree with uncommitted changes, a worktree where an agent still runs, and the worktree of a feature that is still open. The notice lists each one it kept. A validator that is still finishing keeps its validation worktree until it ends, and the tower removes that worktree then, or when pi shuts down first, as at the end of a headless run.
- A worktree that `git status` reports as clean is removed with everything in it, **including git-ignored files** such as `node_modules`, build output or a local `.env`. Everything committed stays on the feature's branch.
- Branches and the `.tower/comms/` records always stay.

To keep the worktrees, set `"objective": { "autoTeardown": false }` in `tower.json`, and run `/tower teardown` when you want them gone.

## `/mission` commands

| Command | What it does |
| --- | --- |
| `/mission` | Enters mission mode: turns tower mode on, switches the session to the orchestrator model, shows the models and asks for the goal. While a mission is open, it shows Mission Control instead. |
| `/mission <goal>` | Plans a mission for this goal right away. For a goal whose first word is a subcommand, such as "stop …", run `/mission` first and then type the goal. |
| `/mission @<file>` | The same, with the goal read from a file. The path is relative to pi's working directory. |
| `/mission approve` | Approves the plan and starts the mission |
| `/mission pause [reason]` | Pauses the mission: running agents finish their turn, and nothing new starts |
| `/mission resume` | Resumes a paused or blocked mission with the limits from the current settings |
| `/mission models` | Shows the role and pool models, where each was set, any problems, and the objective settings |
| `/mission models <role\|alias> <provider/model[:thinking]> [--project]` | Sets the model of a role (`orchestrator`, `worker`, `reviewer`, `validator`) or pool alias in the global `tower.json`, or in the project's file with `--project` |
| `/mission models <role\|alias> --clear [--project]` | Removes that setting again |
| `/mission agents` | Lists the workers, reviewers and validators with their status, model and assignment |
| `/mission stop <agent>` | Stops a running worker, reviewer or validator, by name, agent id or task id. This is a human stop: nobody resumes or replaces it unless you say so. |
| `/mission exit` | Leaves mission mode. Tower mode turns off and the session switches back to its previous model. Running agents keep running, and `.tower/` stays on disk. `/mission off` does the same. |
| `/mission help` | Shows the usage (`--help` and `-h` work too) |

- `/missions` is the same command.
- Between commands, talk to the orchestrator in plain language.
- A new goal is refused while a mission awaits approval, executes or is paused. While the mission is still planning, a new goal revises it. After it completed or blocked, a new goal starts the next mission.
- Subcommands are case-insensitive, and tab completion covers them, agent names and model targets.
- Near-miss words such as `status`, `start`, `quit`, `accept`, `continue`, `model` or `list` are refused with a "did you mean" hint instead of becoming a one-word goal.
- A new orchestrator model set with `/mission models` applies the next time mission mode starts: run `/mission exit` and `/mission`, or switch the session now with `/model`.
- Mission mode is saved in the pi session. Continuing the session (`pi -c`, `/resume`, `/reload`) brings it back, together with tower mode.
- `/mission approve`, `pause`, `resume`, `models`, `agents` and `stop` do exactly what their `/tower` counterparts do; see [the `/tower` layer](#tower-mode-the-tower-layer).

## Headless missions

`pi-tower exec --mission` runs a mission unattended: in CI, from a scheduled job, or in a terminal you walk away from. It is Droid's spelling of `pi-tower run`:

```sh
pi-tower exec --mission -f mission.md --auto-approve
```

The run starts pi in RPC mode in your repository, turns tower mode on, hands the mission file over with `/tower objective --headless`, and follows the mission until it ends. In a headless run the orchestrator plans without asking questions. It decides open points itself, records each assumption as a note on the mission, and requests approval. The run's own lines say *objective*, the Tower name of a mission (see [Advanced](#advanced)).

`pi-tower --help` prints this usage:

```text
Usage: pi-tower run -f <objective.md> [--auto-approve] [--timeout <ms>] [--cwd <dir>] [--pi <path>]
                    [--orchestrator-model <ref>] [--worker-model <ref>] [--reviewer-model <ref>]
                    [--validator-model <ref>] [-- <extra pi args>]
       pi-tower exec --mission -f <mission.md> [run options]
       pi-tower --help | --version
```

| Option | Meaning |
| --- | --- |
| `-f`, `--file <path>` | The mission file (Markdown). Required. [`examples/mission.md`](examples/mission.md) is a complete one. |
| `--auto-approve` | Approves the plan without a human: the run sends `/tower approve --auto`, which is recorded as an automatic approval. Without it, the run stops at the plan with exit code 3. |
| `--timeout <ms>` | Gives up after this many milliseconds, at most 2147483647 (exit code 2) |
| `--cwd <dir>` | The repository to run in. Default: the current directory. |
| `--pi <path>` | The pi executable: a path, or a command looked up on `PATH`. Default: `pi`. |
| `--orchestrator-model <ref>`, `--worker-model <ref>`, `--reviewer-model <ref>`, `--validator-model <ref>` | The model of that role for this run, as `provider/modelId[:thinkingLevel]`. Each reaches pi as `--tower-<role>-model`, so it wins over `PI_TOWER_<ROLE>_MODEL`, over `tower.json`, and over a `--tower-<role>-model` passed after `--`. A role without such a flag keeps its configured model. |
| `--mission` | Required by `exec`; `run` accepts it and ignores it |
| `-- <args>` | Passes everything after `--` to pi unchanged |

Relative paths resolve against the current directory. A malformed model ref, a missing value or an unknown option exits with code 4 and prints the usage. `pi-tower --version` prints the version.

| Exit code | Meaning |
| --- | --- |
| `0` | The mission completed |
| `1` | The mission is blocked or paused (for example by a budget), pi exited after the run started, or `/tower approve --auto` failed for a reason other than those of exit code 3 |
| `2` | Timeout (`--timeout`) |
| `3` | The plan needs approval: `--auto-approve` was not given, or only a human may approve this plan because its contract changed while it was blocked or paused. The plan is printed. Approve it in pi with `/mission approve`, or re-run with `--auto-approve` where that is allowed. |
| `4` | Usage or startup error: bad arguments, a missing mission file or directory, pi did not start, pi has no `/tower` command, or `/tower on` or `/tower objective` failed |
| `130` / `143` | Interrupted by SIGINT / SIGTERM. pi is stopped first; a second signal kills it. |

What the run does:

1. It starts `pi --mode rpc` in the repository, followed by your extra arguments and the role model flags. The checked-out branch becomes the base, so check out a branch first.
2. It sends `/tower on`, then `/tower models`, and prints one line per role with its model, thinking level and source. If the reply cannot be read, it prints one `role models unavailable (…) — continuing` line instead.
3. For every problem that `/tower models` lists, such as a model pi does not know or a provider without credentials, it prints a `model warning:` line on stderr. The run goes on and the exit codes stay the same, but pi refuses to spawn an agent whose model cannot be used, so fix the model first.
4. It sends `/tower objective --headless @<absolute path of the file>`. If the workspace already has a mission that awaits approval or is executing, the run follows that one instead and does not send the file again. A paused one ends the run at once with exit code 1: resume it in pi with `/mission resume`, then start the run again to follow it.
5. It reads `.tower/comms/state.json` every second and prints a line whenever the mission or one of its milestones changes state.
6. When the mission awaits approval, it prints the plan. With `--auto-approve` it approves and goes on. Without it, it gives the tower two more polls to approve the plan itself (through `objective.autoApprove`), follows the mission if it does, and otherwise exits with 3.
7. It ends when the mission completes, blocks or pauses, when pi exits, on timeout, or on a signal. pi is always stopped before the run exits.

An end-to-end example, with the worker model set for this run only. Keep the mission file outside the repository, because untracked files in the main checkout can end up in feature branches:

```sh
cd ~/work/shop
git switch main
pi-tower exec --mission -f ~/missions/csv-export.md --auto-approve --timeout 14400000 \
  --worker-model anthropic/claude-sonnet-5-5:medium
echo "exit code: $?"
```

The output looks like this, with the plan shortened:

```text
[pi-tower +0s] started pi (pi --mode rpc) in /home/you/work/shop
[pi-tower +2s] > /tower on
[pi-tower +2s] pi: Tower mode: ON
[pi-tower +2s] > /tower models
[pi-tower +2s] orchestrator model: anthropic/claude-opus-5-5 · thinking: high (configured) · source: /home/you/.pi/agent/tower.json (global)
[pi-tower +2s] worker model: anthropic/claude-sonnet-5-5 · thinking: medium (configured) · source: --tower-worker-model
[pi-tower +2s] reviewer model: openai/gpt-5.5 · thinking: high (configured) · source: /home/you/.pi/agent/tower.json (global)
[pi-tower +2s] validator model: openai/gpt-5.5 · thinking: xhigh (configured) · source: /home/you/.pi/agent/tower.json (global)
[pi-tower +2s] > /tower objective --headless @/home/you/missions/csv-export.md
[pi-tower +2s] pi: Objective handed to the tower (headless)
[pi-tower +2s] objective handed to the orchestrator: /home/you/missions/csv-export.md
[pi-tower +2s] waiting for the orchestrator to draft the objective
[pi-tower +48s] O1 planning — MS1 pending · MS2 pending
[pi-tower +2m31s] O1 awaiting-approval — MS1 pending · MS2 pending — features 0/5 done
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
      - M3 --format option
      - M4 --output option
      - M5 README for report export
  notes:
    - Assumed: --output overwrites an existing file.
  estimated runs: 9 (features + 2 × milestones)
[pi-tower +2m31s] > /tower approve --auto
[pi-tower +2m31s] pi: Objective O1 approved — executing
[pi-tower +2m31s] auto-approved the plan of O1 (--auto-approve)
[pi-tower +2m32s] O1 executing — MS1 active · MS2 pending — features 0/5 done
[pi-tower +16m05s] O1 executing — MS1 validating · MS2 pending — features 2/5 done
[pi-tower +21m40s] O1 executing — MS1 failed · MS2 pending — features 2/5 done
[pi-tower +23m02s] O1 executing — MS1 active · MS2 pending — features 2/6 done
[pi-tower +30m12s] O1 executing — MS1 validating · MS2 pending — features 3/6 done
[pi-tower +34m49s] O1 executing — MS1 passed · MS2 pending — features 3/6 done
[pi-tower +34m50s] O1 executing — MS1 passed · MS2 active — features 3/6 done
[pi-tower +52m19s] O1 executing — MS1 passed · MS2 validating — features 6/6 done
[pi-tower +1h00m] O1 executing — MS1 passed · MS2 passed — features 6/6 done
[pi-tower +1h01m] O1 completed — MS1 passed · MS2 passed — features 6/6 done
[pi-tower +1h01m] objective O1 "CSV and JSON export for shop report" completed
exit code: 0
```

A role whose model cannot be used gets a warning on stderr right after the role lines, for example after a typo in `--worker-model`:

```text
[pi-tower +2s] model warning: worker: model "anthropic/claude-sonet-5-5" (set by --tower-worker-model) is not in pi's model registry — check the provider/modelId (pi --list-models shows them)
```

**Getting the command.** `pi-tower` is the package's `bin/pi-tower.js` and needs Node 22.19 or newer. From a checkout, run `node /path/to/pi-tower/bin/pi-tower.js exec --mission …`. A global npm install of the package puts `pi-tower` on your `PATH`.

**Loading the extension.** The pi that the run starts loads pi-tower the same way your interactive sessions do: as an installed pi package, or with `-e`, which you pass after `--`, as in `pi-tower exec --mission -f mission.md -- -e /path/to/pi-tower/src/index.ts`. Do not combine both. pi would load the extension twice and rename its commands, and the run stops with exit code 4.

The run passes your environment to pi, so `PI_TOWER_CONFIG` and the `PI_TOWER_*_MODEL` variables work as usual, for example to give a run its own `tower.json`. Dialogs that nobody can answer are cancelled. The runner writes no files itself: it only reads the state file. Progress goes to stdout, warnings and errors go to stderr.

When you take over a headless mission in pi, a plain `/mission approve` or `/mission resume` switches it back to interactive mode, so the orchestrator asks you again instead of deciding alone.

For unattended runs, set `maxWallTimeMs` and `maxCostUsd` in the [objective settings](#the-objective-section) and use `--timeout` as the outer limit. Approve with `--auto-approve` and leave `objective.autoApprove` off: the flag acts only during this run, while the setting approves every plan, in your interactive sessions too (see [Known limitations](#known-limitations)). When both are on, the run follows the mission after whichever approval comes first.

## pi-tower and Droid Missions

Using pi-tower is the same as using [Droid Missions](https://docs.factory.com/missions/overview). What differs is how the features run.

| | Droid Missions | pi-tower |
| --- | --- | --- |
| Start | `/missions` (or `/mission`) | `/mission` (or `/missions`) |
| Models | Orchestrator, worker and validation worker models | Orchestrator, worker, reviewer and validator models, shown when you enter mission mode and in Mission Control, and changed with `/mission models` |
| Planning | Droid asks clarifying questions, then plans features organized into milestones | The same: an interview first, then the features of every milestone, planned up front |
| Approval | You approve the plan | The same, in a dialog or with `/mission approve`. Only you can approve. |
| Mission Control | Progress across features and milestones, which agents work on what, time and cost | The same: a live panel above the editor, and `/mission` for the full view |
| Validation | Scrutiny and user-testing validators at the end of each milestone; `skipScrutiny` and `skipUserTesting` turn them off | The same, plus a `commands` kind: the milestone's commands and the acceptance commands must exit with 0 |
| Fixes | A failed validation leads to fix features | The same, until every milestone passes |
| Steering | Pause the orchestrator, tell it what you see, re-plan, resume | The same: `/mission pause`, plain messages, `/mission resume` |
| Headless | `droid exec --mission -f mission.md [--worker-model … --validator-model …]` | `pi-tower exec --mission -f mission.md [--worker-model … --validator-model …]` |
| Run estimate | features + 2 × milestones, a floor | The same, shown in the approval request |
| **Features of a milestone** | **One after another** (Factory's docs list parallel execution as an open question) | **In parallel, as a swarm**: every feature gets its own git worktree, branch and worker, up to `maxRunningAgents` agents at a time |

Running features side by side needs a few safeguards that a serial run can do without, and pi-tower adds them:

- every feature gets an independent reviewer and has to pass a merge gate before it merges, so one parallel branch cannot silently break the base;
- the orchestrator gives the features of a milestone separate files, and features whose files overlap run one after the other;
- scrutiny validation looks for broken seams between the features that were built side by side;
- the budgets `maxCostUsd` and `maxWallTimeMs` pause a mission, and a stall watchdog blocks it instead of letting it spin.

## Advanced

Everything below is the machinery under `/mission`. You need it to tune limits and budgets, to drive the tower yourself, or to understand an edge case.

**Names.** `/mission` is a layer over Tower, the multi-agent mode that pi-tower ports from Kimi Code. Tower has its own names for the same things:

| `/mission` says | Tower says | Ids |
| --- | --- | --- |
| mission | objective: `TowerObjective`, `/tower objective`, the `objective` section of `tower.json` | `O1`, `O2`, … |
| milestone | milestone | `MS1`, `MS2`, … |
| feature | mission: one unit of work with its own branch, worktree, worker and review (`TowerPlan`, `TowerMission`) | `M1`, `M2`, … |

The notices a mission sends you use the `/mission` names, and so does this part of the README. The Tower names appear where a tool, a command, a setting or a Tower reply uses them.

### How a mission runs

A plain tower run ends when the orchestrator decides the work is done. A mission ends only when its validation contract is met.

#### What it guarantees

- **You approve the plan.** The orchestrator turns your request into a contract: a goal, a definition of done, optional acceptance commands, and ordered milestones, each with its own validation. No feature starts before you approve the plan, in the dialog or with `/mission approve`, unless you turned on automatic approval yourself. The orchestrator cannot approve for you: none of its tools can.
- **Every milestone is validated.** When all features of a milestone are merged (or abandoned), validators check the integrated result on one exact commit, the tip of the base branch.
- **Failures get fixed.** A failed validation goes back to the orchestrator, which plans fix features into the same milestone. Once they merge, validation runs again on the new tip. This repeats until the milestone passes.
- **Completion is gated.** The mission completes only when every milestone has passed, no feature is still open, and the final milestone passed on the current base tip. Nobody can mark it done otherwise, the orchestrator included.
- **The contract stays yours.** Changing it after approval (the goal, the definition of done, the acceptance commands, a milestone's validation, removing or reordering milestones) sends the plan back to you for approval. Appending milestones at the end and adding notes do not.
- **It stops instead of spinning.** A validation kind that keeps failing, a stall that the orchestrator cannot resolve, or a used-up budget blocks or pauses the mission, and you are told why.

**Parallel execution.** pi-tower starts every feature of the current milestone whose dependencies are met at the same time, up to `maxRunningAgents`. Each feature is an ordinary tower mission with its own branch and worktree, its own worker, an independent reviewer, and the merge gate. Milestones still run in order: the next one starts only after the previous one has passed.

#### Lifecycle

A mission moves through these states:

| Status | What happens | How it moves on |
| --- | --- | --- |
| `planning` | The orchestrator interviews you, drafts the contract and plans the features of every milestone. In a headless run, it does this alone. | The orchestrator requests approval. That needs a goal, at least one definition-of-done item, at least one milestone, and at least one build feature in the first milestone. |
| `awaiting-approval` | The plan waits for you. You get the approval request and, in mission mode, the approval dialog. | The dialog, `/mission approve`, or an automatic approval you configured |
| `executing` | The autopilot drives the work, milestone by milestone | It completes through the gate. `/mission pause` or a budget pauses it, and it blocks when the work cannot converge. |
| `paused` | Nothing new starts. Running agents finish their current turn. | `/mission resume` |
| `blocked` | Nothing new starts, and you are told why | You decide: answer the orchestrator or have it change the plan, then run `/mission resume`. Or start a new mission. |
| `completed` | Every milestone passed, and the final validation is on the current base tip. The worktrees are torn down unless `autoTeardown` is off. | Start the next one with `/mission` |

Milestones have their own states. A milestone is `pending` until it becomes current, `active` while its features run, and `validating` while its validation runs. Then it is `passed`, or `failed`, which reopens it for fix features, or `blocked` once one validation kind has failed `maxValidationRounds` times. The current milestone is the first one that has not passed. The orchestrator plans the features of every milestone before it asks for approval, but a feature starts only when its milestone is current. A current milestone without features wakes the orchestrator to plan them.

- **One mission at a time.** A workspace has at most one open mission. A new goal is accepted when there is none, when the previous one is completed or blocked (it is archived when the new one is drafted), and while the open one is still planning (the orchestrator then revises it). It is refused while a mission is awaiting approval, executing or paused.
- **Resuming.** `/mission resume` works on a paused or blocked mission. It first reloads the mission's limits from your current [objective settings](#the-objective-section), so raise a budget, or `maxValidationRounds` for a milestone that blocked on failed validations, in `tower.json` before you resume: the failed rounds are not reset, so otherwise the next failure of that kind blocks the mission again. It also resets the stall counter and reopens a blocked milestone so that the orchestrator can plan fixes. A mission that was never approved goes back to planning.
- **Mission mode off.** The autopilot runs only while tower mode is on. After `/mission exit` or `/tower off`, an executing mission does not advance until you run `/mission` or `/tower on` again.

#### Validation

Every milestone says which kinds of validation it needs. When all of its features are merged or abandoned, the required kinds start together on the current base tip.

| Kind | Run by | What it checks | Required when |
| --- | --- | --- | --- |
| `scrutiny` | A validator agent | Reviews the milestone's merged changes against the tasks of every feature and the definition of done, looks for broken seams between the features that were built in parallel, and runs typecheck, lint and tests | The milestone's `scrutiny` switch is on (the default) and `skipScrutiny` is off |
| `user-testing` | A validator agent | Uses the product the way a user would, following the milestone's QA instructions: CLI runs, scripts, HTTP calls. Every deviation is a failure with steps to reproduce it. | The milestone's `user_testing` switch is on (the default) and `skipUserTesting` is off |
| `commands` | The tower itself, with no model | Runs the milestone's commands, plus the mission's acceptance commands on the final milestone. It passes when every command exits with 0. | The milestone has at least one command to run |

A milestone passes when the latest round of every required kind passed on the same commit. A milestone that requires no kind passes as soon as its features are merged or abandoned.

> [!IMPORTANT]
> Validation commands run mechanically in a fresh, detached checkout of the base tip, without installed dependencies or build output. Each command must bring its own setup: write `npm ci && npm test`, not `npm test`.

The commands run one after another, each in its own `bash -c` started at the root of that checkout, so `cd` and exported variables do not carry over from one command to the next. Every command runs, even after an earlier one failed. Each one gets 15 minutes before its process group is killed. Its stdin is `/dev/null`, and the environment adds `CI=1`, `TERM=dumb`, `NO_COLOR=1` and similar variables. The last 4000 characters of each command's output go into the validation report.

Validator agents work in a detached validation worktree, `.tower/worktrees/val-<milestone>-<kind>-r<round>`, checked out at the commit they validate. They may install dependencies, build and start the product there, but they cannot change files: they have no `write` or `edit` tool, and such calls are vetoed. Each validator reports its verdict exactly once with `TowerValidate`, and its worktree is removed afterwards. Every round, the mechanical ones included, is recorded under `.tower/comms/validations/`.

- Rounds are numbered per milestone and kind. A kind that failed on a commit does not run again on that commit: the next round needs a new base tip, normally a merged fix.
- When the failed rounds of one kind reach `maxValidationRounds` (default 3), the milestone blocks, and so does the mission.
- When the base moves while a milestone is validating, or after the final milestone passed, validation runs again on the new tip. Rounds on an older commit are stale.
- When the contract changes, only rounds recorded under the current contract decide whether a milestone passes. Failed rounds still count toward `maxValidationRounds`, whatever the contract or commit they ran on.

#### Autopilot and orchestrator

After approval, the **autopilot** drives the mechanics. It is plain code, not a model. It reacts to every change of the tower state, to every agent that ends, to inbox messages, and to a watchdog timer. It acts only through the same tower operations that the orchestrator uses, so every rule still applies: no merge without a clean independent review on the exact branch tip, and no change outside a feature's scope.

The autopilot:

- starts a worker for each feature of the current milestone whose dependencies are merged or abandoned, up to `maxRunningAgents`;
- spawns a reviewer for each review request on the current branch tip;
- resumes an idle worker that received review findings or has a rebase conflict to resolve;
- nudges a worker that went idle before finishing its feature (it neither called `TowerComplete` nor reported a blocker, and is not waiting for the answer to a message it sent) to finish it, report what blocks it, or ask, once per branch tip;
- replaces a worker that failed or timed out with a fresh one on the same branch, up to `maxFeatureAttempts` workers per feature, and likewise a reviewer or validator that ended without a result; it never replaces an agent you stopped;
- rebases stale branches and merges the branches that pass the gate;
- starts validation: it spawns the validators and runs the commands;
- advances to the next milestone, completes the mission through the gate, and then tears its worktrees down unless `autoTeardown` is off;
- pauses the mission when a budget is used up, and blocks it after too many failed validation rounds or stall wakes.

The orchestrator is woken only for judgment, with one of these reasons:

- `plan-milestone`: the current milestone has no features yet;
- `validation-failed`: plan fix features from the failures;
- `blocker`: a worker reported a blocker or asked a question;
- `feature-attempts-exhausted`: a feature used up its worker attempts;
- `worker-idle`: a worker went idle again without finishing after it was nudged (in manual mode at once, since nobody nudges it);
- `worker-stopped`: you stopped the worker of a feature, so the orchestrator asks you how to continue;
- `merge-blocked`: the merge gate is blocked for a reason that needs judgment, such as files outside the feature's scope;
- `rebase-conflict`: a conflict that no worker can take over;
- `review-stuck` and `validation-stuck`: reviewers or validators keep ending without a result, or you stopped one;
- `stalled`: nothing has moved for `stallTimeoutMs`.

Each wake is sent once per situation. While the autopilot drives an executing mission, the mechanical events of its features reach the orchestrator as context without starting a model turn: agents that end, review requests and survey summaries, review results, and validation results. Only the autopilot's own wakes and the messages that need judgment, such as a worker's question, start a turn, so the orchestrator spends tokens on judgment only. When the same autopilot action is refused on three ticks in a row, the orchestrator gets the exact error and a suggested remedy.

You stay in charge. Talk to the orchestrator as usual, stop an agent for good with `/mission stop <agent>` (the autopilot never replaces an agent you stopped), or stop all new work with `/mission pause`.

**Manual mode.** With `"objective": { "autopilot": false }` in `tower.json`, the orchestrator drives feature execution itself, as in a plain tower run: it spawns workers and reviewers, resumes and replaces workers, rebases and merges with the tower tools, and every agent end and inbox message starts its turn as before. Validation, milestone advancement, completion with its teardown, the watchdog, the budgets and the judgment wakes stay automatic.

#### Watchdog, stall wakes and budgets

- **Watchdog.** Besides reacting to events, the autopilot checks the mission every `watchdogIntervalMs` (default 60 seconds).
- **Stall wakes.** The mission stalls when nothing has changed for `stallTimeoutMs` (default 3 minutes) while no agent or validation is running and the orchestrator is idle. "Nothing" covers the features, the branch tips, the reviews, the validation rounds, the base tip and the inbox. The orchestrator is then woken to re-evaluate. After `maxStallWakes` (default 3) stall wakes in a row without progress, the mission blocks.
- **Headless planning.** In a headless run, a mission that stays in planning without progress for `stallTimeoutMs` gets a wake that tells the orchestrator to finish the plan and request approval.
- **Budgets.** `maxWallTimeMs` counts from the first approval. `maxCostUsd` counts the cost that pi reports for every tower agent and for the orchestrator's own turns, so it is only as accurate as the prices pi knows for your models. When either is reached, the mission pauses and you are notified. To go on, raise or remove the limit in `tower.json` and run `/mission resume`. Both are unset by default.

`maxValidationRounds`, `maxFeatureAttempts`, `maxWallTimeMs` and `maxCostUsd` are copied into the mission when it is drafted, and `/mission resume` refreshes them. The orchestrator cannot change them.

#### Restarts

A mission lives in git and in `.tower/comms/state.json`, so it survives a restart of pi. Agents do not (see [Stop, teardown, and restart](#stop-teardown-and-restart)). When tower mode comes back on with an executing mission, through `/mission` or `/tower on` in a new pi process or a continued session, the autopilot picks the mission up at once:

- each feature whose worker was lost gets a fresh worker on its existing branch, which continues from where the branch history shows it stopped. This counts as a new attempt toward `maxFeatureAttempts`;
- validations cut short by the restart run again, and their leftover validation worktrees are removed;
- reviews, merges and milestones continue from the recorded state.

A paused mission stays paused until `/mission resume`, and a mission awaiting approval still waits for you; the dialog does not open again for it, so approve it with `/mission approve`. In manual mode, the orchestrator replaces lost workers itself, as in a plain tower run.

#### Driving a mission with `/tower` commands

The `/mission` commands share their implementation with these `/tower` commands:

| Command | What it does |
| --- | --- |
| `/tower objective [--headless] <text \| @file>` | Hands a goal to the orchestrator, as text or from a file (`@path`, relative to pi's working directory), and returns at once while the orchestrator plans. Tower mode must be on. Without `--headless` it does what `/mission <goal>` does. With `--headless`, the orchestrator plans without asking questions: it decides open points itself, records each assumption as a note on the mission, and requests approval. `pi-tower exec --mission` and `pi-tower run` use this. |
| `/tower objective status` | Shows the mission dashboard without a model turn: the view `/mission` shows below its models |
| `/tower approve [--auto]` | Approves the plan of the mission that awaits approval. Its current milestone becomes active, and the autopilot starts. `--auto` records the approval as automatic instead of human; this is what `--auto-approve` sends. After a contract change while the mission was blocked or paused, only a plain `/tower approve` is accepted. |
| `/tower pause [reason]` | Pauses the executing mission. Running agents finish their current turn, and nothing new starts. |
| `/tower resume` | Resumes a paused or blocked mission, after reloading its limits from the current objective settings |

They work in plain tower mode (`/tower on`) too, without mission mode. There is then no approval dialog and no Mission Control panel: approve with `/tower approve` or `/mission approve`. The `/tower` replies keep their wording, such as `Objective O1 approved — executing`, while the notices of a mission say `Mission O1`.

Two tools exist for missions only:

- **`TowerObjective`** (orchestrator only) manages the mission with the actions `draft`, `update`, `request-approval`, `status` and `block`. It has no approve action and no complete action, and it cannot change the limits.
- **`TowerValidate`** (validators only) submits a validator's verdict for its milestone and kind: `pass` or `fail`, with failures, checks and evidence. A validator calls it exactly once.

Two existing tools gain mission parameters. `TowerPlan` takes a `milestone` for every feature (required for build missions while a mission is open) and an `origin` of `plan` or `fix`. `TowerSpawn` takes `kind: "validator"` with a `milestone` and a `validation_kind` (`scrutiny` or `user-testing`), which the orchestrator uses to recover a stuck validation. See the [Tool reference](#tool-reference).

### Tower mode: the `/tower` layer

`/mission` runs on Tower, and you can also use Tower directly, the way Kimi Code does: turn it on with `/tower on` and steer a free-form run with messages, with no plan to approve and no milestones to validate. In this section, *mission* has its Tower meaning: one unit of work with its own branch and worktree, which `/mission` calls a feature.

#### When Tower fits

Use Tower when the work can run in parallel and you accept the extra token consumption and disk usage.

Good candidates:

- The task splits into fairly independent missions, each with a clear way to verify it, so parallel work saves waiting time.
- The requirements are still moving, and you expect to add input, redirect work, or change priorities often.
- You want every change reviewed carefully, with its own branch and its own review.

Choose `/mission` when you can say up front what done means and how to check it, and you want the work to go on until those checks pass. Steer a free-form tower run with messages when you are still exploring.

#### Quick start with `/tower`

```sh
cd /path/to/project
git status        # check out the local branch that should receive the work
pi
```

1. Run `/tower on`. The footer shows `tower: on`, and the main session switches to your orchestrator model if you configured one.
2. Describe the work as a normal message, for example: "Split the checkout documentation update into independent missions, test each one, and merge only branches that pass independent review."
3. Follow the progress with `/tower status` and `/tower agents`. The tower wakes up by itself when a worker finishes or a message arrives, so you do not need to poll.
4. Check the merged result yourself: `git status`, `git log --graph`, and your tests.
5. Run `/tower teardown` to remove the finished worktrees, then `/tower off`.

#### Run a workflow

This section describes a free-form tower run, steered by your messages. A `/mission` uses the same workspace, branches, reviews and merge gate; [How a mission runs](#how-a-mission-runs) describes what it adds.

**Before you start.** Check out the local branch that should receive the changes, and inspect the working tree:

```sh
cd /path/to/project
git status
```

Start pi in the top-level directory of the repository. Tower creates its workspace (`.tower/`) in pi's working directory.

Tower merges only into a local branch, never into a remote-tracking ref or a tag. If the branch you pass to `/tower <base-branch>` does not exist, Tower creates it from the current checkout; in the interactive UI it asks you to confirm first. The safest choice is an existing branch with a clean working tree.

> [!WARNING]
> Tower may snapshot uncommitted and untracked files into worker branches. When it creates a new base branch, it commits those changes to that branch. In a directory that is not a git repository yet, Tower runs `git init` and makes an initial commit with the existing files; `/mission` refuses to start there instead. Check for secrets and large files first. Tower adds `.tower/` to `.git/info/exclude`, so its own state is never committed.

**Steps:**

1. **Turn Tower on.** In most cases run `/tower on`. This command only turns the mode on. It sends no task. On the first initialization the tower records the current local branch as the base. Later activations reuse the recorded base.

   If HEAD is detached (no branch is checked out), or you want another base, run `/tower <base-branch>` instead, for example `/tower feature/my-objective`.

2. **Describe the task.** Type the task as a normal chat message, and say how to verify the work and what counts as done. The tower initializes `.tower/`, plans missions, and starts every worker whose dependencies are satisfied. A plan whose dependencies form a cycle, a mission that depends on itself included, is refused before anything is written, and the refusal names the cycle, for example `M1 -> M2 -> M1`. When a worker finishes or a message reaches the tower's inbox, the tower resumes by itself. If the tower is busy at that moment, the wake-up waits until its current turn ends.

3. **Let the work run in the background.** Each worker works and commits on its own branch, in its own worktree. The tower assigns independent reviewers, rebases when needed, and merges approved missions in dependency order. Answer the tower when it asks about scope or priority.

4. **Verify the merged result.** Inspect `git status`, the history of the base branch and the final diff, and run the tests or acceptance checks you care about. These checks are only a baseline. They do not replace your own acceptance.

5. **Clean up and exit.** Once every mission is merged or abandoned, run `/tower teardown` to remove the mission worktrees that can be removed, then `/tower off` to leave tower mode. [Stop, teardown, and restart](#stop-teardown-and-restart) explains how these actions differ.

#### Check status and intervene

You do not need to know the worker protocol to watch and steer Tower.

- **Read the dashboard.** `/tower` or `/tower status` reads the current state directly and does not start a model turn. It shows the base, missions, the roster (with each agent's model), the review gate, the inbox count, the concurrency budget, and recent activity. While there is a `/mission`, it adds a one-line summary of it.
- **Follow a `/mission`.** `/mission` and `/tower objective status` show its dashboard, also without a model turn: the status, elapsed time and cost, every milestone with its features and validation rounds, the live agents, and the next expected step.
- **Redirect work.** While Tower is on, send a normal message to add constraints, change priorities, or ask for a summary. When the tower relays a message to a running worker, the worker sees it at its next step boundary. The tool call in flight is never interrupted.
- **Inspect or stop an agent.** `/tower agents` lists the workers, reviewers and validators of this session with their status, model, thinking level and assignment. `/tower stop <agent>` stops a running one. A worker, reviewer or validator you stop is *dead by intent*: the tower does not resume, reassign, or replace it unless you say so. The autopilot of an executing `/mission` respects this too: it never replaces an agent you stopped and wakes the orchestrator instead (`worker-stopped`, `review-stuck` or `validation-stuck`), which asks you how to continue. Agents that fail or time out are still replaced, up to `maxFeatureAttempts` agents (the first one included).
- **Change the base.** Run `/tower <base-branch>` again. Tower re-checks the open missions against the new base, and only stale branches need a rebase. The main checkout must be on the recorded base before anything is merged.
- **Read the diagnostics.** pi-tower writes its own diagnostics, such as failed notifications and errors from extensions inside agent sessions, to `.tower/pi-tower.log`. Before `.tower/` exists they go to `pi-tower.log` in the pi agent directory.

Each workspace has exactly one tower. If another running pi process owns this workspace's tower, `/tower on` and `/mission` are refused and name that session and its process id. Turn tower mode off in that process first, or quit it. Once the owning process is gone, the next `/tower on` or `/mission` takes the workspace over.

#### Merges and rebases

Before it merges a mission, Tower checks the following:

- The mission is complete, with no open tasks or blockers, and its workers are idle.
- The branch contains the current base.
- There is a valid clean review with a `merge` recommendation, normally from an independent reviewer, on the exact branch tip.
- Every changed file is inside the mission scope, and every dependency is merged or abandoned.
- The main checkout is on the recorded base and has no uncommitted changes in the files the merge would touch.

Merges use `--no-ff`. If git reports a conflict, the merge is aborted, so the checkout is never left half-merged.

When the base moves on, Tower can rebase a mission branch onto the new base inside its worktree, as long as the worker is idle and the worktree is clean. A rebase without conflicts keeps the existing clean review bound to the branch. On a conflict, the rebase is aborted and the mission goes back to its worker.

Leave merges and rebases to Tower and do not run extra git integration commands yourself. Do not edit files under `.tower/comms/` by hand: status, notifications and merge checks depend on those records. Reading branches and worktrees is fine.

#### Stop, teardown, and restart

These actions clean up different things:

| Action | What it does | What remains |
| --- | --- | --- |
| `/mission exit` or `/tower off` | Leaves mission mode and tower mode in this session and switches back to the model you used before. Background agents keep running and no files are removed. The autopilot stops, so an executing mission does not advance until tower mode is on again. | `.tower/`, mission branches and worktrees |
| `/tower teardown` | Asks the tower to remove the mission worktrees that are safe to remove and report the result. Worktrees of running agents are always kept. Worktrees with uncommitted changes are kept unless the removal is forced. A clean worktree is removed together with its git-ignored files. A completed `/mission` runs the same teardown by itself unless `autoTeardown` is off. | Mission branches and the `.tower/comms/` audit records. Tower mode stays on. |
| Quit pi, or replace the session with `/new`, `/resume`, `/fork`, `/clone` or `/reload` | Stops every worker, reviewer and validator of the tower. They have to be spawned again later. | The `.tower/` state on disk, branches and worktrees |

The tower's own hints follow the automatic teardown. While a `/mission` is open, the `TowerMerge` result after the last open mission merges and the `TowerStatus` dashboard tell the orchestrator not to run `TowerTeardown`: with `autoTeardown` on, the autopilot tears the worktrees down when the `/mission` completes, and with it off, nothing should be torn down before then. Without an open `/mission`, they say the finished worktrees are ready for `TowerTeardown`.

Tower mode is saved in the pi session, and so is mission mode. When you continue that session (`pi -c`, `/resume`, `/reload`), tower mode comes back on, with mission mode if it was on, unless another running pi process owns the workspace by then. In that case it turns off with a warning.

Agents do not survive a restart. After pi restarts, missions and worktrees are still there, but the workers and reviewers of the previous run are gone. The tower spawns fresh workers under new names. `TowerResume` refuses old agents with a clear message. When a different session takes the workspace over, the previous session's roster entries are retired. An executing `/mission` continues by itself once tower mode is back on; see [Restarts](#restarts).

### `/tower` command reference

| Command | What it does |
| --- | --- |
| `/tower` or `/tower status` | Shows the compact tower status without a model turn |
| `/tower on` | Turns tower mode on: activates the tower tools, adopts an existing `.tower/` workspace, and switches to the orchestrator model. It sends no task. An executing `/mission` continues at once. |
| `/tower <base-branch>` | Turns tower mode on if it is off, and makes this local branch the base: a new workspace is initialized with it, an existing one is re-anchored to it. A missing branch is created from the current checkout, and uncommitted changes are committed onto it. In the interactive UI, pi-tower asks before it creates a branch. |
| `/tower off` | Turns tower mode off, leaves mission mode, and switches back to the previous model. Agents keep running and `.tower/` stays, but the autopilot stops. The tower tools remain available, but `TowerInit`, `TowerPlan`, `TowerSpawn` and `TowerObjective` (except its `status` action) refuse until tower mode is on again. |
| `/tower teardown` | Asks the tower, in a normal message, to run `TowerTeardown` and report what it did. Tower mode stays on. |
| `/tower models` | Shows the role and pool models, their sources, the config files, any problems, and the objective settings |
| `/tower models <role\|alias> <provider/modelId[:thinking]> [--project]` | Sets a role or pool model in the global `tower.json`, or in the project file with `--project` |
| `/tower models <role\|alias> --clear [--project]` | Removes a role or pool model |
| `/tower agents` | Lists this session's workers, reviewers and validators, including finished ones, with status, model and assignment |
| `/tower stop <agent>` | Stops a running worker, reviewer or validator, given its roster name, agent id or task id. This is a human stop: the tower never resumes, reassigns or replaces it unless you say so, and neither does the autopilot of a `/mission`, which wakes the orchestrator instead. |
| `/tower objective [--headless] <text \| @file>` | Hands a `/mission` goal to the orchestrator, inline or from a file. Tower mode must be on, and no other mission may be awaiting approval, executing or paused. `--headless` plans without questions. See [Driving a mission with `/tower` commands](#driving-a-mission-with-tower-commands). |
| `/tower objective status` | Shows the mission dashboard without a model turn |
| `/tower approve [--auto]` | Approves the plan of the mission awaiting approval. `--auto` records an automatic approval. |
| `/tower pause [reason]` | Pauses the executing mission: running agents finish their turn, and nothing new starts |
| `/tower resume` | Resumes a paused or blocked mission, after reloading its limits from the current objective settings |
| `/tower help` | Shows the usage of every subcommand (`--help` and `-h` work too) |

Subcommands are case-insensitive. The base branch keeps its case. Tab completion covers subcommands, agent names, model targets, the `--clear`/`--project` options, `objective status`/`--headless`, and `approve --auto`.

Common slips are refused with a "did you mean" hint instead of being taken as a branch name:

- the near-miss words `model`, `config`, `configure`, `agent`, `task`, `tasks`, `list`, `ls`, `start`, `enable`, `disable`, `stat`, `state`, `kill`, `objectives`, `goal`, `approval`, `accept`, `unpause` and `continue`;
- extra words after a subcommand that takes none, such as `/tower on now`;
- base branch names with spaces.

A near-miss word that names an existing local branch is not refused. With a local `config` branch, `/tower config` makes `config` the base like any other `/tower <base-branch>`, and re-anchors a workspace that records another base. Only a near-miss word without such a branch is refused, so a slip never creates a new branch.

Only you can turn tower mode on, with `/mission` or `/tower on`. The model cannot enable it by itself.

### Configuration

#### `tower.json`

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

- The orchestrator plans and merges on Claude Opus with thinking `high`.
- Workers build on Claude Sonnet with thinking `medium`.
- Reviewers use a model from another vendor with thinking `high`, which gives an independent second opinion.
- Validators use the same vendor's model with thinking `xhigh`, for slower and more thorough checks.
- The pool adds one extra model, `fast`. The tower uses it only for a spawn you explicitly ask it for.
- At most 4 agents run at the same time, and each run is stopped after one hour.
- A mission pauses 4 hours after its first approval or once it has cost $40, whichever comes first, and the orchestrator is woken after 5 quiet minutes instead of 3.

Replace the model ids with ones your pi can use. `pi --list-models` lists them.

| Key | Value | Default |
| --- | --- | --- |
| `orchestrator` | Model spec for the main session while tower mode is on | The session's current model |
| `worker` | Model spec for workers | Inherits the orchestrator, including its thinking level |
| `reviewer` | Model spec for reviewers | Inherits the orchestrator, including its thinking level |
| `validator` | Model spec for the validators of a mission | Inherits the reviewer, including its thinking level, or the orchestrator when no reviewer is set |
| `models` | Pool: an object that maps an alias to a model spec | No pool |
| `maxRunningAgents` | Positive integer: the most workers, reviewers and validators that may run at the same time | `256` |
| `agentTimeoutMs` | Positive integer, at most 2147483647: the wall-clock limit of one worker, reviewer or validator run, in milliseconds | `7200000` (2 hours) |
| `objective` | Object: the mission settings, described in [The `objective` section](#the-objective-section) | All defaults |

A **model spec** has one of two forms:

- A string `"provider/modelId[:thinkingLevel]"`, for example `"anthropic/claude-sonnet-5-5:high"`.
- An object `{ "model": "provider/modelId[:thinkingLevel]", "thinkingLevel": "...", "description": "..." }`. Only `model` is required. `description` is shown to the tower in the list of models it may choose from.

Rules for model specs and the file:

- Thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`. Without a level, pi's default thinking level for the model is used.
- A `:suffix` counts as a thinking level only if it is one of these words. Any other suffix stays part of the model id.
- Set the thinking level once: either as the `:suffix` or as `thinkingLevel`, not both.
- Pool aliases are 1 to 64 characters long. They contain letters, digits, `.`, `_` and `-`, and start with a letter or a digit. `primary`, `orchestrator`, `worker`, `reviewer` and `validator` are reserved, in any letter case.
- The file is plain JSON, so comments are not allowed. Unknown keys are rejected with the list of allowed keys, inside the `objective` section too. An empty file counts as `{}`.

#### The `objective` section

The optional `objective` object tunes how missions run. Every key is optional.

| Key | Value | Default | What it does |
| --- | --- | --- | --- |
| `autopilot` | `true` or `false` | `true` | The autopilot drives feature execution. `false` selects [manual mode](#autopilot-and-orchestrator). |
| `autoApprove` | `true` or `false` | `false` | Approves plans automatically, recorded as an automatic approval, and no approval dialog opens. A contract changed while the mission was blocked or paused still needs a human. Keep it off for interactive use; see [Known limitations](#known-limitations). |
| `maxValidationRounds` | Positive integer | `3` | Failed rounds of one validation kind after which the milestone and the mission block |
| `maxFeatureAttempts` | Positive integer | `3` | Worker spawns per feature. It also caps the reviewers per branch tip and the validators per milestone, kind and commit that may end without a result before the orchestrator is woken. |
| `watchdogIntervalMs` | Positive integer, at most 2147483647 | `60000` (1 minute) | How often the watchdog checks the mission |
| `stallTimeoutMs` | Positive integer, at most 2147483647 | `180000` (3 minutes) | How long nothing may change before a stall wake |
| `maxStallWakes` | Positive integer | `3` | Stall wakes in a row without progress before the mission blocks |
| `maxWallTimeMs` | Positive integer, at most 2147483647 | unset | Pauses the mission this many milliseconds after its first approval |
| `maxCostUsd` | Positive number | unset | Pauses the mission once its recorded cost reaches this many US dollars |
| `skipScrutiny` | `true` or `false` | `false` | Never requires `scrutiny` validation |
| `skipUserTesting` | `true` or `false` | `false` | Never requires `user-testing` validation |
| `autoTeardown` | `true` or `false` | `true` | When a mission completes, the autopilot removes its finished worktrees, as `TowerTeardown` does without force: it keeps the worktrees of running agents, those with uncommitted changes and those of open features, and it removes a clean worktree together with its git-ignored files. The completion notice lists the outcome. With `false`, every worktree stays until `/tower teardown`. |

`maxValidationRounds`, `maxFeatureAttempts`, `maxWallTimeMs` and `maxCostUsd` are copied into a mission when it is drafted, and `/mission resume` copies them again; the orchestrator cannot change them. The other keys take effect as soon as the configuration is reloaded, except `watchdogIntervalMs`, which applies the next time tower mode turns on. `/mission models` and `/tower models` show every key with its value and source, but they do not edit them: edit the section in `tower.json` by hand.

#### Where settings come from

| Source | Sets | Notes |
| --- | --- | --- |
| `--tower-orchestrator-model`, `--tower-worker-model`, `--tower-reviewer-model`, `--tower-validator-model` | One role each | pi command-line flags, string spec. `pi-tower exec --mission` passes its `--<role>-model` options this way. |
| `PI_TOWER_ORCHESTRATOR_MODEL`, `PI_TOWER_WORKER_MODEL`, `PI_TOWER_REVIEWER_MODEL`, `PI_TOWER_VALIDATOR_MODEL` | One role each | Environment variables, string spec |
| `<project>/.pi/tower.json` | Any key | Read only when pi trusts the project (see `/trust`). An untrusted project's file is ignored, and `/tower models` says so. |
| `<agentDir>/tower.json` | Any key | Global file. The agent directory is `~/.pi/agent` unless `PI_CODING_AGENT_DIR` moves it. |
| `PI_TOWER_CONFIG=<path>` | — | Replaces the path of the global file. `~/` is expanded, and relative paths resolve against the current directory. |

Precedence, from highest to lowest:

- **Roles:** flag, then environment variable, then the project file, then the global file. A role that is still unset falls back as described in [Choose the models](#choose-the-models): the orchestrator falls back to the session model, the worker and reviewer inherit the orchestrator, and the validator inherits the reviewer when one is configured and the orchestrator otherwise.
- **`models`:** the pools of the global and project files are merged. A project alias replaces a global alias with the same name.
- **`maxRunningAgents` and `agentTimeoutMs`:** the project file wins over the global file. There is no flag or environment variable for them.
- **`objective`:** key by key, the project file wins over the global file, so a project can override one key and keep the others from the global file. There is no flag or environment variable for them.

For example, this run takes the orchestrator and worker from `tower.json` but overrides two roles for this run only:

```sh
PI_TOWER_WORKER_MODEL=anthropic/claude-haiku-5-5 pi --tower-reviewer-model openai/gpt-5.5:xhigh
```

pi-tower reads the configuration when the session starts, each time tower mode turns on, each time you run `/mission`, and each time you run `/mission models` or `/tower models`. While tower mode is already on, `/tower on` changes nothing. After editing `tower.json` by hand, run `/mission models` to reload it. Spawns then use the new settings without a restart.

The sources are checked together. One invalid value in any of them, such as a typo in a flag, an environment variable or either file, makes the whole configuration fail to load. Until you fix it:

- every spawn is refused, and `/mission models` shows the error;
- the session start and turning tower mode on (`/mission`, `/tower on`) warn "Tower model configuration could not be loaded: …", and the `/mission` header shows the error in place of the models;
- tower mode still turns on, but the session keeps its current model.

#### `/tower models`

`/tower models` and `/mission models` show the model, thinking level and source of every role and pool alias, followed by the objective settings. They also show the status of both config files and list problems, such as a model that is not in pi's model registry or a provider without credentials. If a file does not parse, they show the error instead. Here, `examples/tower.json` is the global file and `PI_TOWER_REVIEWER_MODEL=openai/gpt-5.5:high` is set:

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
autoTeardown         true      default
```

Without a `validator` entry, its row reads `inherited from reviewer` (or `inherited from orchestrator` when no reviewer is configured either).

You can also change the model configuration from inside pi, with `/mission models` or `/tower models`:

```text
/mission models worker anthropic/claude-sonnet-5-5:medium   # set a role in the global tower.json
/mission models validator openai/gpt-5.5:xhigh              # give the validators a model of their own
/mission models fast anthropic/claude-haiku-5-5             # set (or add) the pool alias "fast"
/mission models reviewer openai/gpt-5.5:high --project      # write <project>/.pi/tower.json instead
/mission models reviewer --clear                            # remove the setting again
```

- The target is `orchestrator` (or its alias `primary`), `worker`, `reviewer`, `validator`, or a pool alias. `models.<alias>` works as well.
- Writes are atomic, and an object entry keeps its `description`.
- After a write, pi-tower reloads the configuration, and the next spawn uses it.
- pi-tower warns you when a higher-precedence source (a flag, an environment variable or the project file) still overrides the value you wrote, or when you write to the file of an untrusted project.
- Changing the orchestrator while tower mode is on does not switch the running session. Run `/mission exit` and `/mission` (or `/tower off` and `/tower on`), or use `/model`.

#### The session model follows the mode

If an orchestrator is configured by a file, an environment variable or a flag, turning tower mode on (`/mission` or `/tower on`) switches the main session to that model and its thinking level. `/mission exit` or `/tower off` switches back to the model and thinking level you had before. If you changed the model yourself with `/model` in the meantime, pi-tower leaves your choice alone.

- If the orchestrator model is not in pi's registry or has no credentials, or the configuration does not load, tower mode still turns on. You get a warning, and the session keeps its current model.
- Without a configured orchestrator, the session's own model is the orchestrator and nothing is switched.

#### Choosing a model for one spawn

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
- in `/mission agents`, `/tower agents` and `TowerTasks` (`model: … · thinking: …`);
- in the roster of `/tower status`;
- in the activity log (`spawn … model=… thinking=…`).

An agent keeps its model for its whole life. A resumed worker continues on the model it was spawned with.

#### Compared with Kimi Code

| | Kimi Code Tower | pi-tower |
| --- | --- | --- |
| Tower (main agent) | Primary model | `orchestrator` (default: the session model) |
| Worker default | `[secondary_model] default_model`, else the primary model | `worker` (default: the orchestrator) |
| Reviewer default | Always the primary model | `reviewer` (default: the orchestrator) |
| Validator default | — (no missions) | `validator` (default: the reviewer, else the orchestrator) |
| Choice for one spawn | `primary` or a pool alias | `orchestrator`/`primary`, `worker`, `reviewer`, `validator`, or a pool alias |
| Where to configure | `config.toml` (`[secondary_model]`) | `tower.json` (global or project), environment variables, flags, `/mission models`, `/tower models` |
| Switching the main model | — | Turning tower mode on switches to the orchestrator, turning it off switches back |

With Kimi Code, you cannot give reviewers a model different from the tower's without asking for it on every spawn. With pi-tower, all three roles are independent settings, and so is the optional validator.

### Tool reference

pi-tower has 19 tools. The orchestrator gets 17 of them. Workers and reviewers get 7, and `TowerComplete` exists only for them. Validators get 5, and `TowerValidate` exists only for them.

**Orchestrator tools.** They become active with `/mission` or `/tower on`, and only the main session has them.

| Tool | Purpose |
| --- | --- |
| `TowerInit` | Initializes (or adopts) the `.tower/` workspace and records the base branch |
| `TowerPlan` | Splits the work into missions with ids, branches, scopes, tasks and dependencies. A plan whose dependencies form a cycle is refused. While a `/mission` is open, each feature also names its `milestone` and an `origin` of `plan` or `fix`. |
| `TowerSpawn` | Starts a worker for a mission in its own worktree, a reviewer for a branch, or a validator for a validating milestone (`milestone`, `validation_kind`), with the role model or an explicit choice |
| `TowerMerge` | Merges a mission branch into the base (`--no-ff`) once the merge gate passes |
| `TowerRebase` | Rebases a stale mission branch onto the current base inside its worktree |
| `TowerTeardown` | Removes finished mission worktrees (dry run, exclude and force options), keeping branches and `.tower/comms/` |
| `TowerSend` | Sends an inbox message to an agent, to the tower, or to `all`. A running agent gets it at its next step. |
| `TowerInbox` | Reads the inbox page by page and acknowledges only the messages it returns |
| `TowerFinding` | Files a structured finding (bug, improve, vuln, idea) about something outside a mission's scope |
| `TowerReview` | Submits a review verdict. The tower uses it only as an exceptional break-glass. |
| `TowerMission` | Reads or updates a mission: status, notes, blockers, done or dropped tasks, scope |
| `TowerStatus` | Shows the full dashboard: the `/mission`, missions, awaiting spawns, dead workers, roster, review gate, inbox, concurrency, activity |
| `TowerResume` | Continues a stopped or finished worker in the background with a new prompt. The worker keeps its context. Validators cannot be resumed. |
| `TowerTasks` | Lists the background workers, reviewers and validators with status, model and assignment |
| `TowerTaskOutput` | Shows a snapshot of one agent: status, latest text, recent tool calls, usage, final message |
| `TowerTaskStop` | Stops a running worker, reviewer or validator. The tower can resume a worker it stopped itself. |
| `TowerObjective` | Manages the `/mission`: `draft`, `update`, `request-approval`, `status` and `block`. There is no approve and no complete action. |

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

### Safety and resource cost

Worktrees isolate writes, but they are not a security sandbox.

- Workers can read the repository and run tools with your permissions, and they never ask for approval.
- Workers, reviewers and validators run headless. They cannot spawn subagents: pi-tower is not loaded inside them, and their tool list contains no subagent tool.
- The validation commands of a mission come from the plan you approve, and the tower runs them with your permissions, unattended. Read them in the approval request before you approve.
- When a mission completes, its clean worktrees are removed together with their git-ignored files. Do not keep anything you need only in a feature's worktree, or set `autoTeardown` to `false`.
- Mission scopes, merge checks and the guards below are process rules, not security boundaries.

pi-tower adds three guards:

- **Bash guard.** It is active while the workspace has an owner, and it checks the bash calls of the orchestrator and of every worker, reviewer and validator. An agent's calls are checked against the workspace the tower is bound to, which the agent cannot change. It blocks:
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
- Mission Control and `/tower status` show the running agents and the limit without starting a model turn.
- A run that exceeds `agentTimeoutMs` (default 2 hours) ends as timed out, and the tower is notified.
- A mission takes at least one agent run per feature and two per milestone, and every failed validation adds fix features and validation rounds. Bound it with `maxCostUsd` and `maxWallTimeMs` in the [objective settings](#the-objective-section).

Start with a small mission, or a few independent missions in a free-form run, and keep an eye on the cost in Mission Control.

### Known limitations

- **Automatic teardown deletes git-ignored files.** A completed mission removes every clean feature worktree with everything in it, including git-ignored files such as `node_modules`, build output or a local `.env`. Committed work is safe on its branch. Set `"objective": { "autoTeardown": false }` to keep the worktrees.
- **Do not run Kimi Code's Tower and pi-tower on one repository at the same time.** Both use the same `.tower/` workspace format, but Kimi Code does not record the process id of the session that owns the workspace, and pi-tower treats an owner without a running process as gone. So `/mission` or `/tower on` in pi-tower adopts a workspace that a Kimi Code session is still using and retires that session's whole roster: its agents are no longer tower participants, and their tower tools refuse. Close one tower before you start the other on the same repository.
- **pi started inside a worktree works on the outer workspace.** A directory inside a feature's worktree that is not a git repository of its own counts as part of that worktree, so pi started there uses the outer workspace, as the feature's worker does. Only a separate git repository nested in a worktree gets a workspace of its own. Start pi for other work outside `.tower/worktrees/`.
- **A worktree that lost its `.git` link escapes the bash guard for `git reset --hard`.** The guard lets git commands run inside a feature's worktree, because there they touch only that worktree. If the worktree's `.git` link file is deleted, git run there finds the main checkout's repository instead, and a plain `git reset --hard` resets the main checkout and discards its uncommitted changes. The guard does not block this. Agents have no reason to delete `.git`, but keep uncommitted work out of the main checkout while a mission runs.
- **Auto-approval and blocked missions.** With `"objective": { "autoApprove": true }`, the orchestrator could draft a fresh mission after one blocked, and that mission would be approved automatically. This restarts the wall-time and cost budgets without you. Keep `autoApprove` off for interactive use. The headless runner exits with code 1 on a blocked mission before this can happen.
- **The approval dialog needs mission mode.** It opens only in an interactive session where `/mission` is on, and not again for a plan that already awaited approval when mission mode started, for example after a restart. Approve such a plan with `/mission approve`.
- **The approval dialog can still take over one of pi's built-in selectors.** It waits while another extension's dialog is open, and for half a second after it opens it ignores ↑, ↓ and Enter, so a keypress already on its way cannot approve. pi 1.5.0 reports nothing about its built-in selectors, such as `/model`, though. If you have been idle in one of them for 2 seconds or more when the plan becomes ready, the approval dialog replaces it, and a ↓ then Enter pressed half a second or more later approves the plan. While a plan may be due, read the title before you confirm a selection.
- **Validation commands bring their own setup.** They run in a fresh, detached checkout without installed dependencies or build output, so every command must include its setup, for example `npm ci && npm test`.
- **Failed validation rounds are never reset.** They count toward `maxValidationRounds` across commits, contract changes and `/mission resume`. Before you resume a mission that blocked on failed validations, raise `maxValidationRounds` in `tower.json`; otherwise the next failure of that kind blocks it again.
- **No browser for user-testing.** User-testing validators have no browser or GUI tooling. Their behavioural QA relies on what bash can drive: CLIs, HTTP calls and scripts.
- **One-second commit timestamps.** To decide whether a review request covers the current branch tip, the autopilot compares commit timestamps, which have a resolution of one second. This is harmless: reviewers always review the real tip.
- **Node 22 is untested for `pi-tower`.** The command was developed and tested on Node 26 only. Its code paths for Node 22.x are untested.

### Differences from kimi-code Tower

pi-tower ports Kimi Code's Tower: the protocol store, the 13 Tower tools, their descriptions and refusals, the worker and reviewer briefings, the reminders, the merge gate and the status dashboard. Where pi works differently, pi-tower adapts. Each item below matches the code as shipped.

**Missions**

- **An addition of pi-tower.** Kimi Code's Tower has no missions in the `/mission` sense: no objectives, milestones, validators, autopilot, approval dialog or Mission Control. `/mission`, `/missions`, `TowerObjective`, `TowerValidate`, the `validator` role, `/tower objective`, `/tower approve`, `/tower pause`, `/tower resume` and the `pi-tower` command exist only in pi-tower. Underneath, the ported protocol is unchanged: every feature of a mission is an ordinary tower mission with the same review and merge gate.
- **Nothing changes without a mission.** In a workspace that never starts one, missions, reviews, merges and the state files work exactly as in pi-tower 0.1.

**Models**

- **Three role models instead of two.** `orchestrator`, `worker` and `reviewer` can each be set separately, plus a pool, and missions add an optional `validator`. In Kimi Code, the tower and reviewers share the primary model, and workers default to `[secondary_model]`.
- **Configuration.** Settings come from `tower.json` (global, or project if trusted), `PI_TOWER_*_MODEL`, `--tower-*-model`, `/mission models` and `/tower models`, instead of `config.toml`.
- **The session model follows the mode.** Turning tower mode on switches the session to the orchestrator model, and turning it off switches back.
- **The `model` parameter of `TowerSpawn` always exists.** Its choices are the roles and pool aliases. Kimi Code hides the parameter when there is no pool.
- **Thinking levels.** They come from a `:level` suffix or `thinkingLevel` per model, else pi's default. Kimi Code uses `default_effort`.
- **Validation per spawn.** An unknown model or missing credentials refuse the spawn, and `/tower models` lists the problem. Kimi Code fails at session start instead.
- **Limits.** The concurrency cap is `maxRunningAgents` in `tower.json` instead of `max_running_tasks`. The run timeout is `agentTimeoutMs` instead of `[subagent] timeout_ms`, and it must be positive, so there is no "0 = no timeout". The defaults are the same: 256 agents and 2 hours.

**Enabling Tower**

- **No experiment flag and no telemetry.** There is no `KIMI_CODE_EXPERIMENTAL_TOWER` or `[experimental] tower`. Installing or loading the extension is the opt-in, and the tools stay inactive until `/mission` or `/tower on`. No `tower_mode_enter`/`tower_mode_exit` events are sent anywhere. The activity log in `.tower/comms/log/` is the only record.
- **No mode exclusivity with Goal, Plan or swarm.** pi has no such built-in modes. While tower mode is on, the orchestrator is blocked from these tools: `todo`, `todo_write`, `TodoWrite`, `TodoList`, `subagent` and `AgentSwarm`, for example when another extension provides them. Every other tool is untouched. Kimi Code also blocks `CreateGoal` and goal activation through `UpdateGoal`, which pi does not have.

**Agents**

- **Agent tools.** Kimi Code uses its generic `Agent` (resume), `TaskList`, `TaskOutput` and `TaskStop` tools and the `/tasks` panel. pi has none of these. pi-tower adds `TowerResume`, `TowerTasks`, `TowerTaskOutput` and `TowerTaskStop`, plus `/tower agents` and `/tower stop <agent>` (and their `/mission` twins).
- **Resumes.** `TowerResume` always runs in the background, and a resumed run counts against the concurrency limit.
- **Workers run inside their worktree.** A worker's session uses its worktree as the working directory. In Kimi Code, workers run in the main checkout with absolute paths. Reviewers use the main checkout in both. Validators, which exist only in pi-tower, work in a detached validation worktree.
- **Agent tool set.** Workers get `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` and the 7 agent Tower tools. Kimi Code workers also get web, todo, cron, wait and MCP tools. pi does not ship the first four, and agent sessions do not load pi's built-in MCP support.
- **Agent sessions.** They load your pi settings, skills, context files and configured extensions, except pi-tower itself. Only the tools listed above are enabled in them. Their transcripts are stored in `.tower/agents/`.
- **Reviewers cannot write.** They get no `write`/`edit` at all. Kimi Code gives reviewers write tools and relies on their briefing.
- **Approvals.** pi has no per-action approval prompts. Agent sessions run headless, so an extension that needs an interactive confirmation cannot ask for it inside a worker.
- **Long commands.** pi's `bash` tool has no background mode, so the worker role prompt asks workers to use timeouts and check their inbox between long steps.

**Restarts and ownership**

- **No resume after a restart.** After `/reload` or `pi -c`, the roster survives but the agent runs do not. `TowerResume` refuses with "not running in this process — the tower restarted", and the tower spawns a fresh worker under a new name. A new session retires the old roster entries instead. pi-tower does not reopen the stored agent transcripts.
- **One tower per workspace, across processes.** Ownership is recorded with the owner's process id. `/tower on` and `/mission` are refused while another live pi process owns the workspace. A dead owner, or a session that pi replaced in the same process, is taken over. As in Kimi Code, quitting does not release ownership; the next session adopts the workspace. Kimi Code records no owner process id, so pi-tower cannot tell whether a Kimi Code session still owns a workspace; see [Known limitations](#known-limitations).

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
| S3 | the full lifecycle of a free-form tower run | mandatory |
| S8 | the guards and vetoes | mandatory |
| S4 | the review rework loop | optional |
| S7 | a human stop with `/tower stop` | optional |
| S13 | the `maxRunningAgents=1` concurrency budget | optional |
| S15 | a mission end to end: the human approves the plan, two features run in parallel, a failing acceptance check forces a fix feature, the milestone is validated again on the new base tip, and only then does the mission complete | mandatory |
| S16 | a headless `pi-tower run --auto-approve`: exit code 0, the mission completed, no file in your agent directory changed, no process left behind | mandatory |
| S17 | restart continuation: pi is killed while a worker runs; after `/tower on` in a new pi, the autopilot gives the feature a fresh worker on its branch and the mission completes | optional |
| S18 | mission mode, the Droid-style flow: `/mission` lists the role models and asks for the goal, the orchestrator interviews the human before it requests approval, the approval dialog's default option keeps planning, `/mission approve` starts the mission, Mission Control shows two features running at once, the automatic teardown removes every feature's worktree on completion, and `/mission exit` restores the starting model | mandatory |
| S19 | a headless `pi-tower exec --mission -f … --auto-approve` with the four role model flags and a `tower.json` that names no model: every role's model line names its flag (`--tower-<role>-model`) as the source, no model warning appears, and the mission completes | mandatory |

The seven scenarios S1 to S13 run by default. The five mission scenarios S15 to S19 run only when you select them, by id or with the `objective` keyword: `--scenarios=objective` runs the five, and `--scenarios=all,objective` runs all twelve. The run exits with 1 when a selected scenario fails or your pi settings changed, and with 2 when it hits the global timeout.

The mission scenarios work on a small Node CLI repository. They assert on durable records and deterministic output, never on model prose: `state.json`, the activity log, the validation and review files, the roster, git (the tip of `main`, its history and its files), the timestamps, working directories and tool calls recorded in agent transcripts, the prompts recorded in the session files, the status line, panel and dialogs that pi reports over RPC, and deterministic command output (the progress lines of `pi-tower run` and `pi-tower exec --mission`, slash-command replies, and the record the S15 and S18 acceptance scripts keep of their runs). In S15 the acceptance command is a script outside the repository. Its first run in the tower's `commands` validation fails and names a missing deliverable (`docs/USAGE.md`), and later runs pass only once a fix delivered it, so every run goes through the fix loop. In S18 the scripted human sends fixed answers whenever the orchestrator stops without requesting approval, and picks the dialog's default option by its position, never by reading the orchestrator's text. All five also check that each milestone validation starts within 15 seconds of the merge that produced its commit, and that the autopilot never launches the same agent twice.

```sh
npm run test:e2e:pi -- --selfcheck
npm run test:e2e:pi
PI_TOWER_E2E_SCENARIOS=S1,S2,S3,S8 npm run test:e2e:pi -- --report=e2e-report.md
npm run test:e2e:pi -- --scenarios=objective --report=e2e-objective.md
```

`--selfcheck` runs only the offline checks and starts no session. It still calls `pi --version`, so `pi` must be on your `PATH`. It checks the wake parser against this checkout and prints whether each role model can be told apart from pi's default model and from the starting session model.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_TOWER_E2E_CHECKOUT` | this checkout | The pi-tower checkout whose `src/index.ts` is loaded |
| `PI_TOWER_E2E_PI` | `pi` | The pi binary |
| `PI_TOWER_E2E_ORCHESTRATOR_MODEL` | `byteplus-gateway/claude-sonnet-5-5:low` | Orchestrator model |
| `PI_TOWER_E2E_WORKER_MODEL` | `byteplus-gateway/claude-haiku-5-5:low` | Worker model |
| `PI_TOWER_E2E_REVIEWER_MODEL` | `byteplus-gateway/claude-opus-5-5:low` | Reviewer model |
| `PI_TOWER_E2E_VALIDATOR_MODEL` | the reviewer model | Validator model of the mission scenarios |
| `PI_TOWER_E2E_SESSION_MODEL` | `byteplus-gateway/claude-haiku-5-5:low` | Session model before `/tower on`. It must differ from the orchestrator model, so the switch is observable. |
| `PI_TOWER_E2E_SCENARIOS` | `all` | Comma-separated scenario ids such as `S1,S3`, or the keywords `all` (S1 to S13) and `objective` (S15 to S19). `--scenarios=S1,S3` does the same. |
| `PI_TOWER_E2E_TIMEOUT_MS` | `4500000` (75 minutes), plus the timeouts of the selected mission scenarios | Timeout for the whole run |
| `PI_TOWER_E2E_SCENARIO_TIMEOUT_MS` | `1200000` (20 minutes); 55, 40, 45, 50 and 40 minutes for S15, S16, S17, S18 and S19 | Timeout for each scenario. When set, it applies to every scenario. |
| `PI_TOWER_E2E_KEEP` | unset | `1` keeps the run directory with its repositories and logs. `--keep` does the same. |
| `PI_TOWER_E2E_VERBOSE` | unset | `1` echoes the output of the pi processes. `--verbose` does the same. |
| `PI_TOWER_E2E_REPORT` | unset | Writes the Markdown report to this path. `--report=<path>` does the same. |

Models use the `provider/modelId[:thinking]` form. The orchestrator, worker and reviewer models must be three distinct provider/model ids, or the run refuses to start; the validator model may repeat one of them. The defaults name a `byteplus-gateway` provider, so set the model variables to models that your pi setup can reach. The run uses the providers and credentials of that setup.

A run spends real tokens. A default run of the seven scenarios S1 to S13 takes about 6–7 minutes and costs roughly $1.1–1.5 with the default sonnet, haiku and opus models at low thinking. The five mission scenarios add about 6–7 minutes and $1.8–1.9. Each caps its mission with `maxCostUsd` and `maxWallTimeMs` in its own `tower.json` (6, 4, 5, 5 and 4 dollars for S15 to S19), and the report lists the wall time and cost of every scenario. The latest `--scenarios=all,objective` run with these defaults passed all 12 scenarios and all 160 checks (S18: 21 of 21) in 778 seconds, for $3.05.

The run never modifies your pi settings. Every pi process gets its own `tower.json` (through `PI_TOWER_CONFIG`) and its own session directory inside the run directory. Each one starts with `--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-context-files` and `--offline`. The runner fingerprints `settings.json` and `tower.json` in your agent directory (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`) before and after the run, and fails the run if either changed. S16 and S19 go further around their headless runs: each hashes every file in the agent directory before and after, and checks that no process is left with its working directory or command line under the scenario's run directory. On Linux this process check reads `/proc`. Without procfs, as on macOS, it takes the command lines from `ps` and, when `lsof` is installed, the working directories from `lsof`. If `ps` fails as well, the report records the check as not applicable in a note instead of passing it.

## License and credits

pi-tower is released under the [MIT License](LICENSE), Copyright (c) 2026 YukoOshima.

pi-tower is a port of the Tower mode of [Kimi Code](https://github.com/MoonshotAI/kimi-code) by Moonshot AI. Its protocol, tool descriptions, prompts and tests are derived from that project, which is also [MIT-licensed](https://github.com/MoonshotAI/kimi-code/blob/main/LICENSE) (Copyright (c) 2026 Moonshot AI). Both notices are in [LICENSE](LICENSE). Thanks to the Kimi Code team for the original design. The `/mission` workflow follows [Factory's Droid Missions](https://docs.factory.com/missions/overview).
