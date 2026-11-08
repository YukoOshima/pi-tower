# pi-tower

English | [简体中文](README.zh-CN.md)

**pi-tower** brings the Tower multi-agent mode of [Kimi Code](https://github.com/MoonshotAI/kimi-code) to the [pi coding agent](https://github.com/earendil-works/pi), and adds one thing Kimi Code lacks: the **orchestrator**, the **workers** and the **reviewers** each get their own model.

Once tower mode is on, pi's main agent becomes the *tower*, which is the orchestrator. It splits a larger development task into missions (subtasks) and starts a worker for each mission in the background. Every mission has its own git branch and worktree. The tower sends each finished branch to an independent reviewer and merges only the branches that pass its merge gate. While the workers run, you keep talking to the tower: check progress, add constraints, change priorities, or stop an agent at any time.

Tower is neither an ordinary subagent call nor a swarm. You turn it on explicitly. It keeps its state in the repository (`.tower/`), and it comes with merge checks and cleanup commands. Its strengths are **responsiveness** and **parallel development**.

> [!WARNING]
> Workers and reviewers run unattended. They never ask you to approve individual actions. Read [Safety and resource cost](#safety-and-resource-cost) before you start.

## Contents

- [Three models, one per role](#three-models-one-per-role)
- [Installation](#installation)
- [Quick start](#quick-start)
- [When Tower fits](#when-tower-fits)
- [Run a workflow](#run-a-workflow)
- [Check status and intervene](#check-status-and-intervene)
- [Merges and rebases](#merges-and-rebases)
- [Stop, teardown, and restart](#stop-teardown-and-restart)
- [Model configuration](#model-configuration)
- [Command reference](#command-reference)
- [Tool reference](#tool-reference)
- [Safety and resource cost](#safety-and-resource-cost)
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

## Quick start

```sh
cd /path/to/project
git status        # check out the local branch that should receive the work
pi
```

1. Run `/tower on`. The footer shows `tower: on`, and the main session switches to your orchestrator model if you configured one.
2. Type your objective as a normal message, for example: "Split the checkout documentation update into independent missions, test each one, and merge only branches that pass independent review."
3. Follow the progress with `/tower status` and `/tower agents`. The tower wakes up by itself when a worker finishes or a message arrives, so you do not need to poll.
4. Check the merged result yourself: `git status`, `git log --graph`, and your tests.
5. Run `/tower teardown` to remove the finished worktrees, then `/tower off`.

## When Tower fits

Use Tower when the work can run in parallel and you accept the extra token consumption and disk usage.

Good candidates:

- The task splits into fairly independent missions, each with a clear way to verify it, so parallel work saves waiting time.
- The requirements are still moving, and you expect to add input, redirect work, or change priorities often.
- You want every change reviewed carefully, with its own branch and its own review.

## Run a workflow

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

1. **Turn Tower on.** In most cases run `/tower on`. This command only turns the mode on. It sends no objective. On the first initialization the tower records the current local branch as the base. Later activations reuse the recorded base.

   If HEAD is detached (no branch is checked out), or you want another base, run `/tower <base-branch>` instead, for example `/tower feature/my-objective`.

2. **Send the objective.** Type the task as a normal chat message, and say how to verify the work and what counts as done. The tower initializes `.tower/`, plans missions, and starts every worker whose dependencies are satisfied. When a worker finishes or a message reaches the tower's inbox, the tower resumes by itself. If the tower is busy at that moment, the wake-up waits until its current turn ends.

3. **Let the work run in the background.** Each worker works and commits on its own branch, in its own worktree. The tower assigns independent reviewers, rebases when needed, and merges approved missions in dependency order. Answer the tower when it asks about scope or priority.

4. **Verify the merged result.** Inspect `git status`, the history of the base branch and the final diff, and run the tests or acceptance checks you care about. These checks are only a baseline. They do not replace your own acceptance.

5. **Clean up and exit.** Once every mission is merged or abandoned, run `/tower teardown` to remove the mission worktrees that can be removed, then `/tower off` to leave tower mode. [Stop, teardown, and restart](#stop-teardown-and-restart) explains how these actions differ.

## Check status and intervene

You do not need to know the worker protocol to watch and steer Tower.

- **Read the dashboard.** `/tower` or `/tower status` reads the current state directly and does not start a model turn. It shows the base, missions, the roster (with each agent's model), the review gate, the inbox count, the concurrency budget, and recent activity.
- **Redirect work.** While Tower is on, send a normal message to add constraints, change priorities, or ask for a summary. When the tower relays a message to a running worker, the worker sees it at its next step boundary. The tool call in flight is never interrupted.
- **Inspect or stop an agent.** `/tower agents` lists the workers and reviewers of this session with their status, model, thinking level and mission. `/tower stop <agent>` stops a running one. A worker or reviewer you stop is *dead by intent*: the tower does not resume, reassign, or replace it unless you say so.
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
| `/tower off` | Leaves tower mode in this session and switches back to the model you used before `/tower on`. Background agents keep running and no files are removed. | `.tower/`, mission branches and worktrees |
| `/tower teardown` | Asks the tower to remove the mission worktrees that are safe to remove and report the result. Worktrees of running agents are always kept. Worktrees with uncommitted changes are kept unless the removal is forced. | Mission branches and the `.tower/comms/` audit records. Tower mode stays on. |
| Quit pi, or replace the session with `/new`, `/resume`, `/fork` or `/reload` | Stops every worker and reviewer of the tower. They have to be spawned again later. | The `.tower/` state on disk, branches and worktrees |

Tower mode is saved in the pi session. When you continue that session (`pi -c`, `/resume`, `/reload`), tower mode comes back on, unless another running pi process owns the workspace by then. In that case it turns off with a warning.

Agents do not survive a restart. After pi restarts, missions and worktrees are still there, but the workers and reviewers of the previous run are gone. The tower spawns fresh workers under new names. `TowerResume` refuses old agents with a clear message. When a different session takes the workspace over, the previous session's roster entries are retired.

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
  "models": {
    "fast": {
      "model": "anthropic/claude-haiku-5-5",
      "description": "cheap and quick: docs, small fixes, surveys"
    }
  },
  "maxRunningAgents": 4,
  "agentTimeoutMs": 3600000
}
```

Line by line:

- The tower plans and merges on Claude Opus with thinking `high`.
- Workers build on Claude Sonnet with thinking `medium`.
- Reviewers use a model from another vendor with thinking `high`, which gives an independent second opinion.
- The pool adds one extra model, `fast`. The tower uses it only for a spawn you explicitly ask it for.
- At most 4 workers and reviewers run at the same time, and each run is stopped after one hour.

Replace the model ids with ones your pi can use. `pi --list-models` lists them.

| Key | Value | Default |
| --- | --- | --- |
| `orchestrator` | Model spec for the main session while tower mode is on | The session's current model |
| `worker` | Model spec for workers | Inherits the orchestrator, including its thinking level |
| `reviewer` | Model spec for reviewers | Inherits the orchestrator, including its thinking level |
| `models` | Pool: an object that maps an alias to a model spec | No pool |
| `maxRunningAgents` | Positive integer: the most workers and reviewers that may run at the same time | `256` |
| `agentTimeoutMs` | Positive integer, at most 2147483647: the wall-clock limit of one worker or reviewer run, in milliseconds | `7200000` (2 hours) |

A **model spec** has one of two forms:

- A string `"provider/modelId[:thinkingLevel]"`, for example `"anthropic/claude-sonnet-5-5:high"`.
- An object `{ "model": "provider/modelId[:thinkingLevel]", "thinkingLevel": "...", "description": "..." }`. Only `model` is required. `description` is shown to the tower in the list of models it may choose from.

Rules for model specs and the file:

- Thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`. Without a level, pi's default thinking level for the model is used.
- A `:suffix` counts as a thinking level only if it is one of these words. Any other suffix stays part of the model id.
- Set the thinking level once: either as the `:suffix` or as `thinkingLevel`, not both.
- Pool aliases are 1 to 64 characters long. They contain letters, digits, `.`, `_` and `-`, and start with a letter or a digit. `primary`, `orchestrator`, `worker` and `reviewer` are reserved, in any letter case.
- The file is plain JSON, so comments are not allowed. Unknown keys are rejected with the list of allowed keys. An empty file counts as `{}`.

### Where settings come from

| Source | Sets | Notes |
| --- | --- | --- |
| `--tower-orchestrator-model`, `--tower-worker-model`, `--tower-reviewer-model` | One role each | pi command-line flags, string spec |
| `PI_TOWER_ORCHESTRATOR_MODEL`, `PI_TOWER_WORKER_MODEL`, `PI_TOWER_REVIEWER_MODEL` | One role each | Environment variables, string spec |
| `<project>/.pi/tower.json` | Any key | Read only when pi trusts the project (see `/trust`). An untrusted project's file is ignored, and `/tower models` says so. |
| `<agentDir>/tower.json` | Any key | Global file. The agent directory is `~/.pi/agent` unless `PI_CODING_AGENT_DIR` moves it. |
| `PI_TOWER_CONFIG=<path>` | — | Replaces the path of the global file. `~/` is expanded, and relative paths resolve against the current directory. |

Precedence, from highest to lowest:

- **Roles:** flag, then environment variable, then the project file, then the global file. A role that is still unset falls back as described in the table at the top: the orchestrator falls back to the session model, and the worker and reviewer inherit the orchestrator.
- **`models`:** the pools of the global and project files are merged. A project alias replaces a global alias with the same name.
- **`maxRunningAgents` and `agentTimeoutMs`:** the project file wins over the global file. There is no flag or environment variable for them.

For example, this run takes the orchestrator and worker from `tower.json` but overrides two roles for this run only:

```sh
PI_TOWER_WORKER_MODEL=anthropic/claude-haiku-5-5 pi --tower-reviewer-model openai/gpt-5.5:xhigh
```

pi-tower reads the configuration when the session starts, on every `/tower on`, and each time you run `/tower models`. After editing `tower.json` by hand, run `/tower models` to reload it. Spawns then use the new settings without a restart.

The sources are checked together. One invalid value in any of them, such as a typo in a flag, an environment variable or either file, makes the whole configuration fail to load. Until you fix it:

- every spawn is refused, and `/tower models` shows the error;
- the session start and `/tower on` warn "Tower model configuration could not be loaded: …";
- `/tower on` still turns tower mode on, but the session keeps its current model.

### `/tower models`

`/tower models` shows the model, thinking level and source of every role and pool alias. It also shows the status of both config files and lists problems, such as a model that is not in pi's model registry or a provider without credentials. If a file does not parse, it shows the error instead. Here, `examples/tower.json` is the global file and `PI_TOWER_REVIEWER_MODEL=openai/gpt-5.5:high` is set:

```text
role          model                        thinking             source
orchestrator  anthropic/claude-opus-5-5    high (configured)    /home/you/.pi/agent/tower.json (global)
worker        anthropic/claude-sonnet-5-5  medium (configured)  /home/you/.pi/agent/tower.json (global)
reviewer      openai/gpt-5.5               high (configured)    env PI_TOWER_REVIEWER_MODEL
models.fast   anthropic/claude-haiku-5-5   pi default           /home/you/.pi/agent/tower.json (global)

global config: /home/you/.pi/agent/tower.json (loaded)
project config: /home/you/work/shop/.pi/tower.json (not found)
```

You can also change the configuration from inside pi:

```text
/tower models worker anthropic/claude-sonnet-5-5:medium     # set a role in the global tower.json
/tower models fast anthropic/claude-haiku-5-5               # set (or add) the pool alias "fast"
/tower models reviewer openai/gpt-5.5:high --project        # write <project>/.pi/tower.json instead
/tower models reviewer --clear                              # remove the setting again
```

- The target is `orchestrator` (or its alias `primary`), `worker`, `reviewer`, or a pool alias. `models.<alias>` works as well.
- Writes are atomic, and an object entry keeps its `description`.
- After a write, pi-tower reloads the configuration, and the next spawn uses it.
- pi-tower warns you when a higher-precedence source (a flag, an environment variable or the project file) still overrides the value you wrote, or when you write to the file of an untrusted project.
- Changing the orchestrator while tower mode is on does not switch the running session. Run `/tower off` and `/tower on`, or use `/model`.

### `/tower on` and `/tower off` switch the session model

If an orchestrator is configured by a file, an environment variable or a flag, `/tower on` switches the main session to that model and its thinking level. `/tower off` switches back to the model and thinking level you had before. If you changed the model yourself with `/model` in the meantime, pi-tower leaves your choice alone.

- If the orchestrator model is not in pi's registry or has no credentials, or the configuration does not load, tower mode still turns on. You get a warning, and the session keeps its current model.
- Without a configured orchestrator, the session's own model is the orchestrator and nothing is switched.

### Choosing a model for one spawn

By default, workers run on the `worker` model and reviewers on the `reviewer` model. To use a different model for one agent, ask the tower in a normal message:

- "Spawn the reviewer for feat/checkout-docs with the worker model."
- "Use the fast model for agent-docs."
- "Run this reviewer on primary."

The allowed choices are `orchestrator` (or its alias `primary`), `worker`, `reviewer`, and the aliases of your `models` pool. Any other provider/model id is refused, and the error lists the allowed choices. Add the model to `models` first if you need it.

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
| Choice for one spawn | `primary` or a pool alias | `orchestrator`/`primary`, `worker`, `reviewer`, or a pool alias |
| Where to configure | `config.toml` (`[secondary_model]`) | `tower.json` (global or project), environment variables, flags, `/tower models` |
| Switching the main model | — | `/tower on` switches to the orchestrator, `/tower off` switches back |

With Kimi Code, you cannot give reviewers a model different from the tower's without asking for it on every spawn. With pi-tower, all three roles are independent settings.

## Command reference

| Command | What it does |
| --- | --- |
| `/tower` or `/tower status` | Shows the compact tower status without a model turn |
| `/tower on` | Turns tower mode on: activates the tower tools, adopts an existing `.tower/` workspace, and switches to the orchestrator model. It sends no objective. |
| `/tower <base-branch>` | Turns tower mode on if it is off, and makes this local branch the base: a new workspace is initialized with it, an existing one is re-anchored to it. A missing branch is created from the current checkout, and uncommitted changes are committed onto it. In the interactive UI, pi-tower asks before it creates a branch. |
| `/tower off` | Turns tower mode off and switches back to the previous model. Agents keep running and `.tower/` stays. The tower tools remain available, but `TowerInit`, `TowerPlan` and `TowerSpawn` refuse until tower mode is on again. |
| `/tower teardown` | Asks the tower, in a normal message, to run `TowerTeardown` and report what it did. Tower mode stays on. |
| `/tower models` | Shows the role and pool models, their sources, the config files and any problems |
| `/tower models <role\|alias> <provider/modelId[:thinking]> [--project]` | Sets a role or pool model in the global `tower.json`, or in the project file with `--project` |
| `/tower models <role\|alias> --clear [--project]` | Removes a role or pool model |
| `/tower agents` | Lists this session's workers and reviewers, including finished ones, with status, model and mission |
| `/tower stop <agent>` | Stops a running worker or reviewer, given its roster name, agent id or task id. This is a human stop: the tower never resumes, reassigns or replaces it unless you say so. |
| `/tower help` | Shows the usage of every subcommand (`--help` and `-h` work too) |

Subcommands are case-insensitive. The base branch keeps its case. Tab completion covers subcommands, agent names, model targets and the `--clear`/`--project` options.

Common slips are refused with a "did you mean" hint instead of being taken as a branch name: near-miss words such as `/tower model`, `/tower agent`, `/tower start` or `/tower kill`, extra words after a subcommand that takes none, and base branch names with spaces.

Only you can turn tower mode on. The model cannot enable it by itself.

## Tool reference

pi-tower has 17 tools. The orchestrator gets 16 of them. Workers and reviewers get 7, and `TowerComplete` exists only for them.

**Orchestrator tools.** They become active with `/tower on`, and only the main session has them.

| Tool | Purpose |
| --- | --- |
| `TowerInit` | Initializes (or adopts) the `.tower/` workspace and records the base branch |
| `TowerPlan` | Splits the objective into missions with ids, branches, scopes, tasks and dependencies |
| `TowerSpawn` | Starts a worker for a mission in its own worktree, or a reviewer for a branch, with the role model or an explicit choice |
| `TowerMerge` | Merges a mission branch into the base (`--no-ff`) once the merge gate passes |
| `TowerRebase` | Rebases a stale mission branch onto the current base inside its worktree |
| `TowerTeardown` | Removes finished mission worktrees (dry run, exclude and force options), keeping branches and `.tower/comms/` |
| `TowerSend` | Sends an inbox message to an agent, to the tower, or to `all`. A running agent gets it at its next step. |
| `TowerInbox` | Reads the inbox page by page and acknowledges only the messages it returns |
| `TowerFinding` | Files a structured finding (bug, improve, vuln, idea) about something outside a mission's scope |
| `TowerReview` | Submits a review verdict. The tower uses it only as an exceptional break-glass. |
| `TowerMission` | Reads or updates a mission: status, notes, blockers, done or dropped tasks, scope |
| `TowerStatus` | Shows the full dashboard: missions, awaiting spawns, dead workers, roster, review gate, inbox, concurrency, activity |
| `TowerResume` | Continues a stopped or finished worker in the background with a new prompt. The worker keeps its context. |
| `TowerTasks` | Lists the background workers and reviewers with status, model and assignment |
| `TowerTaskOutput` | Shows a snapshot of one agent: status, latest text, recent tool calls, usage, final message |
| `TowerTaskStop` | Stops a running worker or reviewer. The tower can resume a worker it stopped itself. |

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

Besides these, workers get pi's `read`, `bash`, `edit`, `write`, `grep`, `find` and `ls` tools. Reviewers get `read`, `bash`, `grep`, `find` and `ls`, with no `write` or `edit`.

While tower mode is off, `TowerInit`, `TowerPlan` and `TowerSpawn` refuse. The other tools keep working, so pending merges and messages can still be finished.

## Safety and resource cost

Worktrees isolate writes, but they are not a security sandbox.

- Workers can read the repository and run tools with your permissions, and they never ask for approval.
- Workers and reviewers run headless. They cannot spawn subagents: pi-tower is not loaded inside them, and their tool list contains no subagent tool.
- Mission scopes and merge checks are process rules, not security boundaries.

pi-tower adds three guards:

- **Bash guard.** It is active while the workspace has an owner, and it checks the bash calls of the orchestrator and of every worker and reviewer. It blocks:
  - `rm` on `.tower/comms`;
  - recursive `rm` on `.tower` or on a directory that contains it;
  - `git clean` with force and `-x`/`-X` when it covers the main checkout;
  - `git reset --hard` in the main checkout.

  The same commands are allowed inside a mission worktree. A command that mentions `rm`, `git clean` or `git reset` is blocked as a precaution when the parser cannot analyze it safely, for example because it uses command substitution or a heredoc, or because a path it would delete depends on a variable. The guard models only these commands, so other destructive commands are not caught, the same as in Kimi Code. It checks pi's `bash` tool only; the Windows `powershell` tool is not guarded.
- **Write guard.** A worker's `write` and `edit` calls outside its own worktree are denied.
- **Read-only reviewers.** Reviewers have no `write` or `edit` tools.

Resource cost:

- Every worker and reviewer has its own model context and consumes tokens separately. The tower's planning, message routing, recovery and merge turns also consume tokens. More agents put more pressure on your quota, CPU and disk.
- `maxRunningAgents` limits how many workers and reviewers run at the same time. Without a value the limit is 256.
- When a provider answers with a rate limit (HTTP 429), the limit shrinks to fit and new spawns pause for about a minute.
- `/tower status` shows the current budget and the number of running agents without starting a model turn.
- A run that exceeds `agentTimeoutMs` (default 2 hours) ends as timed out, and the tower is notified.

Start with a few independent missions, and remove finished worktrees to get disk space back.

## Differences from kimi-code Tower

pi-tower ports Kimi Code's Tower: the protocol store, the 13 Tower tools, their descriptions and refusals, the worker and reviewer briefings, the reminders, the merge gate and the status dashboard. Where pi works differently, pi-tower adapts. Each item below matches the code as shipped.

**Models**

- **Three role models instead of two.** `orchestrator`, `worker` and `reviewer` can each be set separately, plus a pool. In Kimi Code, the tower and reviewers share the primary model, and workers default to `[secondary_model]`.
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
- **Workers run inside their worktree.** A worker's session uses its worktree as the working directory. In Kimi Code, workers run in the main checkout with absolute paths. Reviewers use the main checkout in both.
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

The extension entry point is `src/index.ts`, declared under `pi.extensions` in `package.json`.

## License and credits

pi-tower is released under the [MIT License](LICENSE), Copyright (c) 2026 YukoOshima.

pi-tower is a port of the Tower mode of [Kimi Code](https://github.com/MoonshotAI/kimi-code) by Moonshot AI. Its protocol, tool descriptions, prompts and tests are derived from that project, which is also [MIT-licensed](https://github.com/MoonshotAI/kimi-code/blob/main/LICENSE) (Copyright (c) 2026 Moonshot AI). Both notices are in [LICENSE](LICENSE). Thanks to the Kimi Code team for the original design.
