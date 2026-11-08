# pi-tower

[English](README.md) | 简体中文

**pi-tower** 把 [Kimi Code](https://github.com/MoonshotAI/kimi-code) 的 Tower 多 Agent 协作模式移植到了 [pi coding agent](https://github.com/earendil-works/pi)，并补上了 Kimi Code 缺少的一项能力：**orchestrator（编排者）**、**worker** 和 **reviewer** 可以分别使用不同的模型。

开启 Tower 模式后，pi 的 main agent 会成为 Tower，也就是 orchestrator。它把较大的开发任务拆成多个 mission（子任务），为每个 mission 在后台启动一个 worker。每个 mission 都有独立的 git branch 和 worktree。Tower 把完成的 branch 交给独立的 reviewer 审查，只合并通过合并检查的 branch。worker 运行期间，你可以随时和 Tower 对话：查看进展、补充约束、调整优先级，或者停止某个 Agent。

Tower 既不是普通的 subagent 调用，也不是 swarm。它需要你显式开启，会把状态保存在仓库里（`.tower/`），并提供合并检查和清理命令。Tower 的优势在**及时响应**和**并行开发**。

> [!WARNING]
> worker 和 reviewer 会无人值守地运行，不会逐项请求你的审批。开始之前请先阅读[安全边界与资源开销](#安全边界与资源开销)。

## 目录

- [三个角色，三个模型](#三个角色三个模型)
- [安装](#安装)
- [快速开始](#快速开始)
- [适用场景](#适用场景)
- [从启动到合并](#从启动到合并)
- [查看状态并干预](#查看状态并干预)
- [合并与 rebase 规则](#合并与-rebase-规则)
- [停止、清理与重启](#停止清理与重启)
- [模型配置](#模型配置)
- [命令参考](#命令参考)
- [工具参考](#工具参考)
- [安全边界与资源开销](#安全边界与资源开销)
- [与 kimi-code Tower 的差异](#与-kimi-code-tower-的差异)
- [开发](#开发)
- [许可证与致谢](#许可证与致谢)

## 三个角色，三个模型

Kimi Code 的 Tower 只有两个模型配置：主模型（primary model）同时用于 Tower 和所有 reviewer；可选的 `[secondary_model]` 用来设置 worker 的默认模型。pi-tower 为每个角色提供独立的配置：

| 角色 | 使用者 | 未配置时 |
| --- | --- | --- |
| `orchestrator` | Tower 模式开启期间的 pi 主会话：规划、传递消息、合并 | 当前会话的模型（即 `/model` 选中的模型） |
| `worker` | 为 mission 派发的每个 worker | 继承 orchestrator 的模型和思考等级 |
| `reviewer` | 每个独立 reviewer | 继承 orchestrator 的模型和思考等级 |

你还可以定义一个具名模型池（`models`）。只有在你明确要求时，Tower 才会在某一次派发中使用池里的模型。

最简配置写在 `~/.pi/agent/tower.json` 中：

```json
{
  "orchestrator": "anthropic/claude-opus-5-5:high",
  "worker": "anthropic/claude-sonnet-5-5",
  "reviewer": "openai/gpt-5.5:high"
}
```

用 `/tower models` 检查结果：它会列出每个角色实际使用的模型，以及每项配置的来源。Tower 模式开启时，主会话会切换到 orchestrator 模型；`/tower off` 会把它切换回来。所有配置项见[模型配置](#模型配置)。

## 安装

需要 [pi](https://github.com/earendil-works/pi) 和 git。pi-tower 基于 pi 1.5.0 开发和测试。

以 pi package 的形式安装，会写入你的个人 pi 设置（`~/.pi/agent/settings.json`）：

```sh
pi install git:github.com/YukoOshima/pi-tower
```

- 加上 `-l` 则只为当前项目安装。这会写入 `.pi/settings.json`，pi 要在你信任该项目之后才会加载它。
- 如果只想试用一次、不做任何安装，可以运行 `pi -e git:github.com/YukoOshima/pi-tower`。

从本地 checkout 运行：

```sh
git clone https://github.com/YukoOshima/pi-tower.git
cd pi-tower
npm install
pi -e ./src/index.ts
```

在其他项目中使用时，传入绝对路径：`pi -e /path/to/pi-tower/src/index.ts`。

不需要打开任何实验开关：加载这个扩展本身就是启用。在你运行 `/tower on` 之前，它的工具都处于未激活状态，模型也看不到它们。

## 快速开始

```sh
cd /path/to/project
git status        # 先切换到最终接收改动的本地 branch
pi
```

1. 输入 `/tower on`。底部状态栏会显示 `tower: on`；如果你配置了 orchestrator 模型，主会话会切换到该模型。
2. 像平常对话一样输入开发目标，例如："把结算文档更新拆成相互独立的 mission，分别测试，只合并通过独立 review 的 branch。"
3. 用 `/tower status` 和 `/tower agents` 跟进进展。worker 完成任务或收到消息时，Tower 会自动继续处理，不用你反复查询。
4. 自己检查合并结果：`git status`、`git log --graph`，以及你的测试。
5. 输入 `/tower teardown` 清理已完成的 worktree，再输入 `/tower off`。

## 适用场景

是否使用 Tower，主要看任务能否并行，以及你是否接受更多的 token 消耗和磁盘占用。

一些合适的场景：

- 任务可以拆成多个相对独立、验证方式明确的 mission，并行推进能省去等待时间。
- 需求仍在变化，需要频繁传达新要求、调整方向或优先级。
- 希望每次改动都被仔细审核，有独立的 branch 和对应的 review。

## 从启动到合并

### 开始之前

先切换到最终接收改动的本地 branch，并检查工作区状态：

```sh
cd /path/to/project
git status
```

请在仓库的顶层目录中启动 pi。Tower 会在 pi 的工作目录中创建它的工作区（`.tower/`）。

Tower 只能合并到本地 branch，不能合并到 remote-tracking ref 或 tag。如果 `/tower <base-branch>` 指定的 branch 不存在，Tower 会基于当前 checkout 创建它。使用已有 branch 并保持工作区干净，是最稳妥的做法。

> [!WARNING]
> Tower 可能把未提交和未跟踪的文件快照到 worker branch 中；创建新的 base branch 时，会把这些改动提交到该 branch。对于还不是 Git 仓库的目录，Tower 会执行 `git init`，并把现有文件纳入初始 commit。开始前请确认其中没有机密文件或超大文件。Tower 会把 `.tower/` 加入 `.git/info/exclude`，因此它自己的状态永远不会被提交。

### 步骤

1. **开启 Tower。** 通常直接输入 `/tower on` 即可。这个命令只开启 Tower 模式，不会发送任务目标。第一次初始化时，Tower 会把当前本地 branch 记录为 base；以后开启时沿用已记录的 base。

   如果当前是 detached HEAD（未检出任何 branch），或者需要换一个 base，请改用 `/tower <base-branch>`，例如 `/tower feature/my-objective`。

2. **发送开发目标。** 像平常对话一样输入任务，并说明如何验证、什么情况下算完成。Tower 会初始化 `.tower/`、规划 mission，并启动所有依赖已经满足的 worker。worker 完成任务或 Tower 的 inbox 收到消息时，Tower 会自动继续处理；如果 Tower 当时正忙，这次唤醒会等到它当前的轮次结束。

3. **让任务在后台推进。** 每个 worker 在自己的 branch 和 worktree 中工作并提交。Tower 会安排独立 reviewer，必要时 rebase，并按依赖顺序合并通过审核的 mission。Tower 询问任务范围或优先级时，请及时回复。

4. **验收合并结果。** 检查 `git status`、base branch 的提交历史和最终 diff，并运行你关心的测试或验收命令。这些检查只是基础保障，不能替代你自己的验收。

5. **清理并退出。** 所有 mission 都已合并或放弃后，先输入 `/tower teardown` 清理可以移除的 mission worktree，再输入 `/tower off` 退出 Tower 模式。这些操作的区别见[停止、清理与重启](#停止清理与重启)。

## 查看状态并干预

你不需要了解 worker 之间的通讯协议，也能查看和干预 Tower。

- **查看状态面板。** `/tower` 或 `/tower status` 会直接读取当前状态，不会触发模型轮次。可以看到 base、mission、roster（含每个 Agent 的模型）、review 检查、inbox 数量、并发预算和近期活动。
- **调整任务方向。** Tower 开启期间，直接发送普通消息即可补充约束、调整优先级或要求总结。Tower 把消息转给正在运行的 worker 后，worker 会在下一步看到它，正在执行的工具调用不会被打断。
- **检查或停止 Agent。** `/tower agents` 列出本会话的 worker 和 reviewer，以及它们的状态、模型、思考等级和 mission。`/tower stop <agent>` 停止一个正在运行的 Agent。你主动停止的 worker 或 reviewer 视为有意终止：除非你另有指示，Tower 不会恢复、改派或替换它。
- **切换 base。** 再次输入 `/tower <base-branch>`。Tower 会按新 base 重新检查现有 mission，只有落后的 branch 需要 rebase。合并之前，主 checkout 必须位于记录的 base 上。

每个工作区只能有一个 Tower。如果另一个正在运行的 pi 进程已经拥有本工作区的 Tower，`/tower on` 会被拒绝，并显示对方的会话和进程号。请先在那个进程中关闭 Tower 模式，或者退出那个进程。拥有者进程结束后，下一次 `/tower on` 会接管该工作区。

## 合并与 rebase 规则

合并 mission 之前，Tower 会检查以下各项：

- mission 已完成，没有未完成的任务或 blocker，相关 worker 都已空闲。
- branch 已包含当前的 base。
- 存在一份有效的 clean review，合并建议为 `merge`，通常来自独立 reviewer，并且针对 branch 的当前最新提交。
- 每个改动的文件都在 mission 范围内，所有依赖都已合并或放弃。
- 主 checkout 位于记录的 base 上，且合并会涉及的文件中没有未提交的改动。

合并使用 `--no-ff`。如果 git 报告冲突，合并会被中止，checkout 不会停留在合并到一半的状态。

base 更新后，只要 worker 空闲且 worktree 干净，Tower 就可以在对应 worktree 中把 mission branch rebase 到新 base。无冲突时，原有 clean review 的绑定会保留；发生冲突时，rebase 会被中止，并交回 worker 处理。

合并和 rebase 都交给 Tower 完成，不要另外手动执行 git 整合命令。不要手动编辑 `.tower/comms/` 下的文件：状态、通知和合并检查都依赖这些记录。只读地查看 branch 和 worktree 没有问题。

## 停止、清理与重启

这些操作的清理范围不同：

| 操作 | 作用 | 保留内容 |
| --- | --- | --- |
| `/tower off` | 退出当前会话的 Tower 模式，并切换回 `/tower on` 之前使用的模型。后台 Agent 继续运行，不会删除任何文件。 | `.tower/`、mission branch 和 worktree |
| `/tower teardown` | 让 Tower 移除可以安全移除的 mission worktree 并报告结果。正在运行的 Agent 的 worktree 一律保留；有未提交改动的 worktree 除非强制，否则也会保留。 | mission branch 和 `.tower/comms/` 审计记录；Tower 模式保持开启 |
| 退出 pi，或用 `/new`、`/resume`、`/fork`、`/reload` 替换当前会话 | 停止 Tower 的所有 worker 和 reviewer，之后需要重新派发 | 磁盘上的 `.tower/` 状态、branch 和 worktree |

Tower 模式会保存在 pi 会话中。继续该会话时（`pi -c`、`/resume`、`/reload`），Tower 模式会自动恢复；但如果此时另一个正在运行的 pi 进程已经拥有该工作区，Tower 模式会关闭并给出警告。

Agent 无法跨重启存活。pi 重启后，mission 和 worktree 仍然保留，但上一次运行中的 worker 和 reviewer 已经结束。Tower 会用新名字派发新的 worker；`TowerResume` 会以清晰的提示拒绝恢复旧 Agent。当另一个会话接管工作区时，原会话的 roster 条目会被注销。

## 模型配置

### `tower.json`

pi-tower 从 `tower.json` 读取配置。下面是 [`examples/tower.json`](examples/tower.json)：

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

逐行说明：

- Tower 用 Claude Opus 规划和合并，思考等级为 `high`。
- worker 用 Claude Sonnet 开发，思考等级为 `medium`。
- reviewer 使用另一家厂商的模型，思考等级为 `high`，提供独立的第二意见。
- 模型池额外提供一个模型 `fast`。只有你明确要求时，Tower 才会在某次派发中使用它。
- 最多同时运行 4 个 worker 和 reviewer，每次运行最长一小时。

请把模型 id 换成你的 pi 可以使用的模型，`pi --list-models` 会列出它们。

| 配置项 | 取值 | 默认值 |
| --- | --- | --- |
| `orchestrator` | Tower 模式开启期间主会话的模型规格 | 当前会话的模型 |
| `worker` | worker 的模型规格 | 继承 orchestrator，包括思考等级 |
| `reviewer` | reviewer 的模型规格 | 继承 orchestrator，包括思考等级 |
| `models` | 模型池：从别名到模型规格的映射对象 | 无模型池 |
| `maxRunningAgents` | 正整数：同时运行的 worker 和 reviewer 的上限 | `256` |
| `agentTimeoutMs` | 正整数，最大 2147483647：单次 worker 或 reviewer 运行的时长上限，单位毫秒 | `7200000`（2 小时） |

**模型规格**有两种写法：

- 字符串 `"provider/modelId[:thinkingLevel]"`，例如 `"anthropic/claude-sonnet-5-5:high"`。
- 对象 `{ "model": "provider/modelId[:thinkingLevel]", "thinkingLevel": "...", "description": "..." }`。只有 `model` 是必填项。`description` 会出现在 Tower 可选择的模型列表中。

模型规格和配置文件的规则：

- 思考等级可选 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。不指定时使用 pi 为该模型设定的默认思考等级。
- 只有当 `:` 后缀正好是上述等级之一时，才会被当作思考等级；其他后缀仍属于模型 id。
- 思考等级只能设置一次：要么用 `:` 后缀，要么用 `thinkingLevel`，不能同时使用。
- 模型池别名长度为 1 到 64 个字符，可以包含字母、数字、`.`、`_` 和 `-`，并且必须以字母或数字开头。`primary`、`orchestrator`、`worker` 和 `reviewer` 是保留名，不区分大小写。
- 文件是纯 JSON，不能写注释。未知配置项会被拒绝，并列出允许的配置项。空文件视为 `{}`。

### 配置来源

| 来源 | 可设置 | 说明 |
| --- | --- | --- |
| `--tower-orchestrator-model`、`--tower-worker-model`、`--tower-reviewer-model` | 各对应一个角色 | pi 命令行参数，字符串形式的模型规格 |
| `PI_TOWER_ORCHESTRATOR_MODEL`、`PI_TOWER_WORKER_MODEL`、`PI_TOWER_REVIEWER_MODEL` | 各对应一个角色 | 环境变量，字符串形式的模型规格 |
| `<project>/.pi/tower.json` | 所有配置项 | 仅当 pi 信任该项目时才读取（见 `/trust`）。未受信任项目的文件会被忽略，`/tower models` 会注明这一点。 |
| `<agentDir>/tower.json` | 所有配置项 | 全局文件。agent 目录默认为 `~/.pi/agent`，可通过 `PI_CODING_AGENT_DIR` 修改。 |
| `PI_TOWER_CONFIG=<path>` | — | 替换全局文件的路径。支持 `~/` 展开，相对路径基于当前目录解析。 |

优先级从高到低：

- **角色：** 命令行参数，其次是环境变量，然后是项目文件，最后是全局文件。仍未设置的角色按开头表格中的规则回退：orchestrator 回退到会话模型，worker 和 reviewer 继承 orchestrator。
- **`models`：** 全局文件和项目文件的模型池会合并；同名别名以项目文件为准。
- **`maxRunningAgents` 和 `agentTimeoutMs`：** 项目文件优先于全局文件，没有对应的命令行参数或环境变量。

例如，下面这次运行从 `tower.json` 读取 orchestrator 和 worker，但仅在本次运行中覆盖两个角色：

```sh
PI_TOWER_WORKER_MODEL=anthropic/claude-haiku-5-5 pi --tower-reviewer-model openai/gpt-5.5:xhigh
```

pi-tower 在会话启动时读取配置，此后每次运行 `/tower models` 都会重新读取。手动编辑 `tower.json` 之后，运行一次 `/tower models` 即可重新加载，之后的派发无需重启就会使用新配置。

### `/tower models`

`/tower models` 会列出每个角色和模型池别名的模型、思考等级和来源，还会显示两个配置文件的状态，并列出存在的问题，例如模型不在 pi 的模型注册表中，或者 provider 没有凭据。如果文件无法解析，则会显示解析错误。下面的示例中，`examples/tower.json` 是全局文件，同时设置了 `PI_TOWER_REVIEWER_MODEL=openai/gpt-5.5:high`：

```text
role          model                        thinking             source
orchestrator  anthropic/claude-opus-5-5    high (configured)    /home/you/.pi/agent/tower.json (global)
worker        anthropic/claude-sonnet-5-5  medium (configured)  /home/you/.pi/agent/tower.json (global)
reviewer      openai/gpt-5.5               high (configured)    env PI_TOWER_REVIEWER_MODEL
models.fast   anthropic/claude-haiku-5-5   pi default           /home/you/.pi/agent/tower.json (global)

global config: /home/you/.pi/agent/tower.json (loaded)
project config: /home/you/work/shop/.pi/tower.json (not found)
```

也可以直接在 pi 中修改配置：

```text
/tower models worker anthropic/claude-sonnet-5-5:medium     # 在全局 tower.json 中设置一个角色
/tower models fast anthropic/claude-haiku-5-5               # 设置（或新增）模型池别名 "fast"
/tower models reviewer openai/gpt-5.5:high --project        # 改为写入 <project>/.pi/tower.json
/tower models reviewer --clear                              # 再次移除该配置
```

- 目标可以是 `orchestrator`（或其别名 `primary`）、`worker`、`reviewer`，或者模型池别名，也可以写成 `models.<alias>`。
- 写入是原子的，对象形式的条目会保留它的 `description`。
- 写入后，pi-tower 会重新加载配置，下一次派发就会使用新配置。
- 如果写入的值仍被更高优先级的来源（命令行参数、环境变量或项目文件）覆盖，或者写入的是未受信任项目的文件，pi-tower 会给出警告。
- Tower 模式开启期间修改 orchestrator，不会切换正在运行的会话。请先 `/tower off` 再 `/tower on`，或者使用 `/model`。

### `/tower on` 和 `/tower off` 会切换会话模型

如果通过配置文件、环境变量或命令行参数配置了 orchestrator，`/tower on` 会把主会话切换到该模型及其思考等级；`/tower off` 会切换回之前的模型和思考等级。如果你在此期间用 `/model` 自行换过模型，pi-tower 会尊重你的选择，不做切换。

- 如果 orchestrator 模型不在 pi 的注册表中或没有凭据，Tower 模式仍会开启，但会给出警告，会话保持当前模型。
- 如果没有配置 orchestrator，会话本身的模型就是 orchestrator，不会发生切换。

### 为单次派发选择模型

默认情况下，worker 使用 `worker` 模型，reviewer 使用 `reviewer` 模型。如果想让某个 Agent 使用其他模型，用普通消息告诉 Tower 即可：

- "派发审查 feat/checkout-docs 的 reviewer 时，使用 worker 模型。"
- "让 agent-docs 使用 fast 模型。"
- "这个 reviewer 用 primary。"

可选值只有 `orchestrator`（或其别名 `primary`）、`worker`、`reviewer`，以及你的 `models` 模型池中的别名。其他 provider/model id 都会被拒绝，错误信息会列出允许的选择。如果需要其他模型，请先把它加入 `models`。

- 只有你明确要求时，Tower 才会指定模型。
- 选择只作用于本次新派发的 Agent：不会改变正在运行或已恢复的 Agent，也不会保存给后续派发。
- Tower 的 `TowerSpawn` 工具中的模型列表会显示每个可选项及其模型和说明，配置变化后会自动刷新。
- 如果所选模型 pi 不认识或没有凭据，派发会被拒绝，并说明原因。

每个 Agent 使用的模型都可以查到：

- 派发结果中（`model: …`）；
- `/tower agents` 和 `TowerTasks` 中（`model: … · thinking: …`）；
- `/tower status` 的 roster 中；
- 活动日志中（`spawn … model=… thinking=…`）。

Agent 在整个生命周期内都使用同一个模型；恢复后的 worker 会继续使用派发时的模型。

### 与 Kimi Code 的对比

| | Kimi Code Tower | pi-tower |
| --- | --- | --- |
| Tower（main agent） | 主模型 | `orchestrator`（默认：会话模型） |
| worker 默认模型 | `[secondary_model] default_model`，否则为主模型 | `worker`（默认：orchestrator） |
| reviewer 默认模型 | 始终为主模型 | `reviewer`（默认：orchestrator） |
| 单次派发可选 | `primary` 或模型池别名 | `orchestrator`/`primary`、`worker`、`reviewer` 或模型池别名 |
| 配置位置 | `config.toml`（`[secondary_model]`） | `tower.json`（全局或项目）、环境变量、命令行参数、`/tower models` |
| 切换主会话模型 | — | `/tower on` 切换到 orchestrator，`/tower off` 切换回来 |

在 Kimi Code 中，如果想让 reviewer 使用与 Tower 不同的模型，只能在每次派发时单独指定。在 pi-tower 中，三个角色都是相互独立的配置。

## 命令参考

| 命令 | 作用 |
| --- | --- |
| `/tower` 或 `/tower status` | 显示精简的 Tower 状态，不触发模型轮次 |
| `/tower on` | 开启 Tower 模式：激活 Tower 工具、接管已有的 `.tower/` 工作区，并切换到 orchestrator 模型。不会发送任务目标。 |
| `/tower <base-branch>` | 若 Tower 模式未开启则开启它，并把该本地 branch 设为 base：新工作区会以它初始化，已有工作区会重新锚定到它。branch 不存在时会基于当前 checkout 创建，并把未提交的改动提交到该 branch。 |
| `/tower off` | 关闭 Tower 模式并切换回之前的模型。Agent 继续运行，`.tower/` 保留。Tower 工具仍然可用，但在重新开启之前，`TowerInit`、`TowerPlan` 和 `TowerSpawn` 会拒绝执行。 |
| `/tower teardown` | 以普通消息请 Tower 执行 `TowerTeardown` 并报告结果。Tower 模式保持开启。 |
| `/tower models` | 显示角色和模型池的模型、来源、配置文件状态以及存在的问题 |
| `/tower models <role\|alias> <provider/modelId[:thinking]> [--project]` | 在全局 `tower.json` 中设置角色或模型池模型；加上 `--project` 则写入项目文件 |
| `/tower models <role\|alias> --clear [--project]` | 移除角色或模型池模型 |
| `/tower agents` | 列出本会话的 worker 和 reviewer（包括已结束的），以及状态、模型和 mission |
| `/tower stop <agent>` | 停止一个正在运行的 worker 或 reviewer，可以传入 roster 名称、agent id 或 task id。这是人为停止：除非你另有指示，Tower 不会恢复、改派或替换它。 |

子命令不区分大小写，base branch 保留原有大小写。Tab 补全支持子命令、Agent 名称、模型目标以及 `--clear`/`--project` 选项。

只有你可以开启 Tower 模式，模型无法自行开启。

## 工具参考

pi-tower 共有 17 个工具。orchestrator 拥有其中 16 个；worker 和 reviewer 拥有 7 个，其中 `TowerComplete` 只有它们才有。

**orchestrator 工具。** 运行 `/tower on` 后激活，只有主会话拥有。

| 工具 | 用途 |
| --- | --- |
| `TowerInit` | 初始化（或接管）`.tower/` 工作区，并记录 base branch |
| `TowerPlan` | 把目标拆成 mission，包括 id、branch、范围、任务和依赖 |
| `TowerSpawn` | 为 mission 在独立 worktree 中启动 worker，或为某个 branch 启动 reviewer，使用角色模型或明确指定的模型 |
| `TowerMerge` | 通过合并检查后，把 mission branch 合并到 base（`--no-ff`） |
| `TowerRebase` | 在 mission 的 worktree 中把落后的 branch rebase 到当前 base |
| `TowerTeardown` | 移除已完成的 mission worktree（支持 dry run、exclude 和 force），保留 branch 和 `.tower/comms/` |
| `TowerSend` | 向某个 Agent、Tower 或 `all` 发送 inbox 消息；正在运行的 Agent 会在下一步收到 |
| `TowerInbox` | 分页读取 inbox，只确认实际返回的消息 |
| `TowerFinding` | 针对 mission 范围之外的问题提交结构化 finding（bug、improve、vuln、idea） |
| `TowerReview` | 提交 review 结论；Tower 只能在特殊情况下作为破例手段使用 |
| `TowerMission` | 读取或更新 mission：状态、备注、blocker、完成或放弃的任务、范围 |
| `TowerStatus` | 显示完整的状态面板：mission、待派发、已死亡的 worker、roster、review 检查、inbox、并发、活动 |
| `TowerResume` | 用新的提示在后台继续一个已停止或已结束的 worker，保留它原有的上下文 |
| `TowerTasks` | 列出后台的 worker 和 reviewer，以及状态、模型和分工 |
| `TowerTaskOutput` | 查看某个 Agent 的快照：状态、最新文本、最近的工具调用、用量、最终消息 |
| `TowerTaskStop` | 停止一个正在运行的 worker 或 reviewer；Tower 自己停止的 worker 之后可以恢复 |

**worker 和 reviewer 工具。** 只存在于 Agent 会话中。

| 工具 | 用途 |
| --- | --- |
| `TowerComplete` | 仅限 worker：完成 mission，并为 Tower 保存 review 请求（或 survey 总结） |
| `TowerFinding` | 提交 finding，而不是去修改 mission 范围之外的内容 |
| `TowerInbox` | 读取来自 Tower 和其他 Agent 的消息 |
| `TowerMission` | 读取 mission；worker 只能更新自己的 mission |
| `TowerReview` | reviewer：为分配的 branch 提交结论 |
| `TowerSend` | 给 Tower 或其他 Agent 发消息 |
| `TowerStatus` | 读取状态面板 |

此外，worker 还拥有 pi 的 `read`、`bash`、`edit`、`write`、`grep`、`find` 和 `ls` 工具；reviewer 拥有 `read`、`bash`、`grep`、`find` 和 `ls`，没有 `write` 和 `edit`。

Tower 模式关闭期间，`TowerInit`、`TowerPlan` 和 `TowerSpawn` 会拒绝执行；其他工具照常工作，因此未完成的合并和消息仍然可以处理完。

## 安全边界与资源开销

worktree 只能隔离写入，不能当作安全沙箱。

- worker 可以读取仓库内容，并以你的权限运行工具，而且不会请求审批。
- worker 和 reviewer 以无界面方式运行。它们无法再派发 subagent：pi-tower 不会在它们内部加载，它们的工具列表里也没有 subagent 工具。
- mission 范围和合并检查只是流程约束，不是安全边界。

pi-tower 提供三道防护：

- **Bash 防护。** 只要工作区有拥有者就会生效，检查 orchestrator 以及每个 worker 和 reviewer 的 bash 调用。它会拦截：
  - 对 `.tower/comms` 执行的 `rm`；
  - 对 `.tower` 或包含它的目录执行的递归 `rm`；
  - 作用范围覆盖主 checkout、且带有 force 和 `-x`/`-X` 的 `git clean`；
  - 在主 checkout 中执行的 `git reset --hard`。

  同样的命令在 mission worktree 内是允许的。如果命令中出现 `rm`、`git clean` 或 `git reset`，而解析器无法安全地分析它（例如用了命令替换或 heredoc，或者要删除的路径依赖某个变量），为保险起见会直接拦截。这道防护只针对上述命令，其他破坏性命令不会被拦截，这一点与 Kimi Code 相同。它只检查 pi 的 `bash` 工具，不检查 Windows 上的 `powershell` 工具。
- **写入防护。** worker 在自己的 worktree 之外调用 `write` 和 `edit` 会被拒绝。
- **只读 reviewer。** reviewer 没有 `write` 和 `edit` 工具。

资源开销：

- 每个 worker 和 reviewer 都有独立的模型上下文，会分别消耗 token。Tower 的规划、消息传递、故障恢复和合并轮次也会产生消耗。Agent 越多，配额、CPU 和磁盘压力越大。
- `maxRunningAgents` 限制同时运行的 worker 和 reviewer 数量；未配置时上限为 256。
- 当 provider 返回限流（HTTP 429）时，上限会自动收缩，新的派发会暂停约一分钟。
- `/tower status` 会显示当前的预算和正在运行的 Agent 数量，而且不会启动模型轮次。
- 运行时间超过 `agentTimeoutMs`（默认 2 小时）的 Agent 会以超时结束，Tower 会收到通知。

建议先拆少量相互独立的 mission，完成后及时清理 worktree，释放磁盘空间。

## 与 kimi-code Tower 的差异

pi-tower 移植了 Kimi Code 的 Tower：协议存储、13 个 Tower 工具及其说明和拒绝提示、worker 和 reviewer 的任务简报、提醒、合并检查和状态面板。凡是 pi 与 Kimi Code 不同的地方，pi-tower 都做了适配。以下每一项都与实际发布的代码一致。

**模型**

- **三个角色模型，而不是两个。** `orchestrator`、`worker` 和 `reviewer` 可以分别配置，另外还有模型池。在 Kimi Code 中，Tower 和 reviewer 共用主模型，worker 默认使用 `[secondary_model]`。
- **配置方式。** 配置来自 `tower.json`（全局，或受信任项目中的项目文件）、`PI_TOWER_*_MODEL`、`--tower-*-model` 和 `/tower models`，而不是 `config.toml`。
- **会话模型随模式切换。** `/tower on` 把会话切换到 orchestrator 模型，`/tower off` 再切换回来。
- **`TowerSpawn` 始终提供 `model` 参数。** 可选值为各角色和模型池别名。Kimi Code 在没有模型池时会隐藏该参数。
- **思考等级。** 每个模型的思考等级来自 `:level` 后缀或 `thinkingLevel`，否则使用 pi 的默认值。Kimi Code 使用 `default_effort`。
- **按次派发校验。** 模型未知或缺少凭据时，该次派发会被拒绝，`/tower models` 也会列出问题。Kimi Code 则会在会话启动时直接报错。
- **限制项。** 并发上限是 `tower.json` 中的 `maxRunningAgents`，而不是 `max_running_tasks`；运行超时是 `agentTimeoutMs`，而不是 `[subagent] timeout_ms`，且必须为正数，因此没有"0 表示不限时"。默认值相同：256 个 Agent、2 小时。

**启用方式**

- **没有实验开关，也没有遥测。** 没有 `KIMI_CODE_EXPERIMENTAL_TOWER` 或 `[experimental] tower`。安装或加载扩展本身就是启用，在 `/tower on` 之前工具都处于未激活状态。不会向任何地方发送 `tower_mode_enter`/`tower_mode_exit` 事件；`.tower/comms/log/` 中的活动日志是唯一的记录。
- **没有与 Goal、Plan 或 swarm 模式的互斥。** pi 没有这些内置模式。Tower 模式开启期间，orchestrator 无法使用以下工具：`todo`、`todo_write`、`TodoWrite`、`TodoList`、`subagent` 和 `AgentSwarm`（例如由其他扩展提供时）。其他工具不受影响。Kimi Code 还会拦截 `CreateGoal` 以及通过 `UpdateGoal` 激活 goal，pi 没有这些工具。

**Agent**

- **Agent 管理工具。** Kimi Code 使用通用的 `Agent`（resume）、`TaskList`、`TaskOutput`、`TaskStop` 工具和 `/tasks` 面板，pi 都没有。pi-tower 新增了 `TowerResume`、`TowerTasks`、`TowerTaskOutput` 和 `TowerTaskStop`，以及 `/tower agents` 和 `/tower stop <agent>`。
- **恢复。** `TowerResume` 总是在后台运行，恢复后的运行同样占用并发名额。
- **worker 在自己的 worktree 中运行。** worker 会话以它的 worktree 作为工作目录。在 Kimi Code 中，worker 在主 checkout 中运行并使用绝对路径。两者的 reviewer 都在主 checkout 中运行。
- **Agent 工具集。** worker 拥有 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls` 以及 7 个 Agent 端 Tower 工具。Kimi Code 的 worker 还有网页、todo、cron、等待类工具和 MCP 工具：前四类 pi 没有内置，Agent 会话也不会加载 pi 内置的 MCP 支持。
- **Agent 会话。** 它们会加载你的 pi 设置、skill、上下文文件以及已配置的扩展（pi-tower 自身除外），但只启用上面列出的工具。会话记录保存在 `.tower/agents/` 中。
- **reviewer 不能写入。** reviewer 完全没有 `write`/`edit`。Kimi Code 的 reviewer 有写入工具，只靠任务简报约束。
- **审批。** pi 没有逐项操作的审批提示。Agent 会话以无界面方式运行，因此需要交互确认的扩展无法在 worker 中弹出确认。
- **长时间命令。** pi 的 `bash` 工具没有后台模式，因此 worker 的角色提示会要求它们设置超时，并在长步骤之间检查 inbox。

**重启与所有权**

- **重启后无法恢复 Agent。** 在 `/reload` 或 `pi -c` 之后，roster 仍然保留，但 Agent 的运行不会保留。`TowerResume` 会以 "not running in this process — the tower restarted" 拒绝，Tower 会用新名字派发新的 worker。如果是新会话，则会直接注销旧的 roster 条目。pi-tower 不会重新打开已保存的 Agent 会话记录。
- **跨进程的单一 Tower。** 所有权会连同拥有者的进程号一起记录。另一个存活的 pi 进程拥有工作区时，`/tower on` 会被拒绝；已结束的拥有者，或者在同一进程中被 pi 替换掉的会话，会被接管。与 Kimi Code 一样，退出时不会释放所有权，下一个会话会接管该工作区。

**通知与防护**

- **wake 轮次不会被取消。** 你输入消息时，Kimi Code 会取消正在运行的 inbox wake 轮次，之后再重新排队。pi-tower 不这样做：你的消息会在下一步插入正在运行的轮次，wake 也不会丢失。
- **限流反馈。** orchestrator 和 Agent 收到的 HTTP 429 限流响应会收缩并发预算，并暂停新的派发。
- **Bash 防护的解析器。** Kimi Code 用 tree-sitter 解析命令。pi-tower 使用自己的保守解析器，不引入额外依赖，凡是无法安全分析的受防护命令一律拦截。拦截提示与 Kimi Code 相同。

## 开发

```sh
npm install
npm run typecheck
npm test
```

扩展入口是 `src/index.ts`，在 `package.json` 的 `pi.extensions` 中声明。

## 许可证与致谢

pi-tower 以 [MIT 许可证](LICENSE)发布，Copyright (c) 2026 YukoOshima。

pi-tower 移植自 Moonshot AI 的 [Kimi Code](https://github.com/MoonshotAI/kimi-code) 中的 Tower 模式。它的协议、工具说明、提示词和测试都源自该项目，该项目同样采用 [MIT 许可证](https://github.com/MoonshotAI/kimi-code/blob/main/LICENSE)（Copyright (c) 2026 Moonshot AI）。两份许可声明都收录在 [LICENSE](LICENSE) 中。感谢 Kimi Code 团队的原创设计。
