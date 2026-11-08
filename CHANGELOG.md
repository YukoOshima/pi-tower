# Changelog

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
