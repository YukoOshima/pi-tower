# pi-tower

[English](README.md) | 简体中文

**pi-tower** 把 [Kimi Code](https://github.com/MoonshotAI/kimi-code) 的 Tower 多 Agent 协作模式移植到了 [pi coding agent](https://github.com/earendil-works/pi)，并补上了 Kimi Code 缺少的一项能力：**orchestrator（编排者）**、**worker** 和 **reviewer** 可以分别使用不同的模型。

开启 Tower 模式后，pi 的 main agent 会成为 Tower，也就是 orchestrator。它把较大的开发任务拆成多个 mission（子任务），为每个 mission 在后台启动一个 worker。每个 mission 都有独立的 git branch 和 worktree。Tower 把完成的 branch 交给独立的 reviewer 审查，只合并通过合并检查的 branch。worker 运行期间，你可以随时和 Tower 对话：查看进展、补充约束、调整优先级，或者停止某个 Agent。

Tower 既不是普通的 subagent 调用，也不是 swarm。它需要你显式开启，会把状态保存在仓库里（`.tower/`），并提供合并检查和清理命令。Tower 的优势在**及时响应**和**并行开发**。

**Objective 模式**（0.2 新增）让 Tower 一直推进，直到工作可以被验证地完成，思路与 [Factory 的 Droid Missions](https://docs.factory.com/missions/overview) 相同：你批准一份由里程碑和验证契约组成的计划，validator 逐个检查里程碑，每个失败都会变成修复任务，只有整份契约都满足时 objective 才算完成。区别在于执行方式：Missions 逐个完成 feature，pi-tower 则让同一个里程碑中的 feature 并行执行，每个 feature 都有自己的 git worktree、独立的 review 和合并检查。详见 [Objective 模式](#objective-模式)。

> [!WARNING]
> worker、reviewer 和 validator 会无人值守地运行，不会逐项请求你的审批。开始之前请先阅读[安全边界与资源开销](#安全边界与资源开销)。

## 目录

- [三个角色，三个模型](#三个角色三个模型)
- [安装](#安装)
- [快速开始](#快速开始)
- [Objective 模式](#objective-模式)
- [无人值守运行：`pi-tower run`](#无人值守运行pi-tower-run)
- [Droid Missions 与 pi-tower](#droid-missions-与-pi-tower)
- [适用场景](#适用场景)
- [从启动到合并](#从启动到合并)
- [查看状态并干预](#查看状态并干预)
- [合并与 rebase 规则](#合并与-rebase-规则)
- [停止、清理与重启](#停止清理与重启)
- [模型配置](#模型配置)
- [命令参考](#命令参考)
- [工具参考](#工具参考)
- [安全边界与资源开销](#安全边界与资源开销)
- [已知限制](#已知限制)
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

[Objective 模式](#objective-模式)还增加了第四个可选角色 `validator`，供验证里程碑的 Agent 使用。未配置时，validator 使用 reviewer 的模型和思考等级；如果 reviewer 也没有配置，则使用 orchestrator 的。只有想让验证使用单独的模型时，才需要配置它。

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
- 如果只想试用一次、不写入设置，可以运行 `pi -e git:github.com/YukoOshima/pi-tower`。

从本地 checkout 运行：

```sh
git clone https://github.com/YukoOshima/pi-tower.git
cd pi-tower
npm install
pi -e ./src/index.ts
```

在其他项目中使用时，传入绝对路径：`pi -e /path/to/pi-tower/src/index.ts`。

不需要打开任何实验开关：加载这个扩展本身就是启用。在你运行 `/tower on` 之前，它的工具都处于未激活状态，模型也看不到它们。

包里还带有用于无人值守运行的 `pi-tower` 命令（`bin/pi-tower.js`，需要 Node 22.19 或更高版本），见[无人值守运行](#无人值守运行pi-tower-run)。

## 快速开始

```sh
cd /path/to/project
git status        # 先切换到最终接收改动的本地 branch
pi
```

1. 输入 `/tower on`。底部状态栏会显示 `tower: on`；如果你配置了 orchestrator 模型，主会话会切换到该模型。
2. 像平常对话一样描述要做的事，例如："把结算文档更新拆成相互独立的 mission，分别测试，只合并通过独立 review 的 branch。"如果工作必须按照你批准的契约完成并通过验证，请改用 `/tower objective <要完成的事>` 交给 Tower，[Objective 模式](#objective-模式)一节有完整演示。
3. 用 `/tower status` 和 `/tower agents` 跟进进展（objective 还可以用 `/tower objective status`）。worker 完成任务或 Tower 收到消息时，Tower 会自动继续处理，不用你反复查询。
4. 自己检查合并结果：`git status`、`git log --graph`，以及你的测试。
5. 输入 `/tower teardown` 清理已完成的 worktree，再输入 `/tower off`。

## Objective 模式

普通的 Tower 运行在 orchestrator 认为工作完成时结束，而 **objective** 只有在它的验证契约得到满足时才结束。Objective 模式沿用了 [Factory 的 Droid Missions](https://docs.factory.com/missions/overview) 的思路：先商定计划，由你批准，然后整个 Agent 团队持续工作，逐个验证里程碑并修复失败项，直到全部通过。不同之处在于执行：同一个里程碑中的 feature 并行执行。

### 保证什么

- **计划由你批准。** orchestrator 会把你的需求整理成一份契约：目标（goal）、完成标准（definition of done）、可选的验收命令（acceptance commands），以及有序的里程碑（milestone），每个里程碑都有自己的验证要求。在你运行 `/tower approve` 之前，不会有任何 feature 开始执行，除非你自己开启了自动批准。orchestrator 无法替你批准：它的工具都做不到。
- **每个里程碑都会被验证。** 一个里程碑的所有 feature 都已合并（或放弃）后，validator 会在一个确定的 commit，也就是 base branch 的最新提交上，检查集成后的结果。
- **失败会被修复。** 验证失败的结果会交回 orchestrator，由它把修复用的 feature 规划进同一个里程碑。这些修复合并后，验证会在新的最新提交上重新运行，如此往复，直到里程碑通过。
- **完成有门槛。** 只有当每个里程碑都已通过、没有仍未关闭的 feature，并且最后一个里程碑是在当前 base 最新提交上通过的，objective 才会完成。除此之外，谁都无法把它标记为完成，orchestrator 也不例外。
- **契约始终由你掌控。** 批准之后修改契约（目标、完成标准、验收命令、某个里程碑的验证要求、删除里程碑或调整里程碑顺序），计划都会重新等待你的批准。在末尾追加里程碑、添加备注则不需要。
- **不会无休止地空转。** 某类验证反复失败、出现 orchestrator 无法解决的停滞，或者预算用尽时，objective 会被阻塞（blocked）或暂停，并告诉你原因。

**执行方式与 Droid Missions 的区别。** Missions 逐个完成 feature。pi-tower 会同时启动当前里程碑中所有依赖已满足的 feature，数量上限为 `maxRunningAgents`。每个 feature 都是一个普通的 Tower mission：有自己的 branch 和 worktree、自己的 worker、独立的 reviewer，并且要通过合并检查。里程碑之间仍按顺序执行：前一个通过之后，下一个才会开始。[Droid Missions 与 pi-tower](#droid-missions-与-pi-tower) 一节有详细对比。

### 五分钟上手

1. **在最终接收改动的 branch 上启动 pi**，然后用 `/tower on` 开启 Tower 模式。

2. **把 objective 交给 Tower**，可以直接写在命令里，也可以写在 Markdown 文件中，例如 [`examples/objective.md`](examples/objective.md)：

   ```text
   /tower objective Add a --format csv|json option to `shop report`; the table output must not change; npm test must pass
   /tower objective @docs/csv-export.md
   ```

   如果 `.tower/` 还不存在，这一步会创建它，并把当前 branch 记录为 base。接着 orchestrator 会问你：怎样才算完成、哪些不在范围内、用户会怎样试用结果、哪些命令能证明它可用。像平常对话一样回答即可。

3. **审阅计划。** orchestrator 起草契约，规划第一个里程碑的 feature，然后请你批准。你会收到类似下面的批准请求：

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

   想修改任何内容，直接用普通消息说明，orchestrator 会修订计划并再次请你批准。

4. **批准**：运行 `/tower approve`。从这时起由 autopilot 负责具体操作：启动 worker、把完成的 branch 交给 reviewer、合并通过检查的 branch、运行 validator，并推进到下一个里程碑。只有需要判断时才会唤醒 orchestrator。

5. **跟进。** `/tower objective status` 会显示状态面板，不触发模型轮次：

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

   在这个例子中，MS1 的第一轮 scrutiny 验证失败，orchestrator 规划了修复 feature M3，第二轮在新的最新提交上通过。整个过程中你都可以继续和 Tower 对话。`/tower pause` 停止启动新工作，`/tower resume` 继续执行。

6. **完成。** 最后一个里程碑在当前 base 最新提交上通过后，objective 就完成了，你会收到一份总结：每个里程碑及其通过的验证轮次、已合并的 feature、耗时和花费。自己检查结果后，运行 `/tower teardown` 和 `/tower off`。

如果 objective 被阻塞，你会收到原因和最近的失败项。告诉 orchestrator 要改什么，或者回答它的问题，然后运行 `/tower resume`。

### 生命周期

objective 会经历以下状态：

| 状态 | 发生什么 | 如何继续 |
| --- | --- | --- |
| `planning` | orchestrator 起草契约、规划 feature：交互时与你一起，无人值守运行时独自完成 | orchestrator 请求批准。前提是：有目标、至少一条完成标准、至少一个里程碑，并且第一个里程碑中至少有一个 build feature。 |
| `awaiting-approval` | 计划等待你批准，你会收到批准请求 | `/tower approve`，或者你配置的自动批准 |
| `executing` | autopilot 按里程碑推进工作 | 通过完成门槛后完成。`/tower pause` 或预算会让它暂停；工作无法收敛时会被阻塞。 |
| `paused` | 不再启动新工作，正在运行的 Agent 会完成当前轮次 | `/tower resume` |
| `blocked` | 不再启动新工作，并告诉你原因 | 由你决定：回答 orchestrator 或让它修改计划，然后运行 `/tower resume`；也可以开始一个新的 objective。 |
| `completed` | 所有里程碑都已通过，最终验证位于当前 base 最新提交上 | 用 `/tower objective` 开始下一个 |

里程碑也有自己的状态：在成为当前里程碑之前是 `pending`，feature 执行期间是 `active`，验证期间是 `validating`；之后变为 `passed`，或者变为 `failed`（重新开放，等待修复 feature），或者在某类验证失败达到 `maxValidationRounds` 次后变为 `blocked`。当前里程碑是第一个尚未通过的里程碑。后续里程碑的 feature 可以提前规划，但要等所属里程碑成为当前里程碑才会启动。当前里程碑还没有 feature 时，会唤醒 orchestrator 来规划。

- **同一时间只有一个 objective。** 每个工作区最多只有一个未结束的 objective。没有 objective、上一个已完成或已阻塞（起草新 objective 时会把它归档），或者当前的 objective 仍处于 planning（此时由 orchestrator 修订它）时，可以使用 `/tower objective`；objective 正在等待批准、执行中或已暂停时，该命令会被拒绝。
- **恢复。** `/tower resume` 适用于已暂停或已阻塞的 objective。它会先按当前的 [objective 配置](#objective-配置段)重新载入 objective 的限额，所以请在恢复之前先在 `tower.json` 中调高预算；如果里程碑是因验证失败次数过多而被阻塞，请调高 `maxValidationRounds`：失败轮数不会被清零，否则同类验证再失败一次，objective 就会再次被阻塞。它还会重置停滞计数，并重新开放被阻塞的里程碑，让 orchestrator 可以规划修复。从未被批准过的 objective 会回到 planning。
- **Tower 模式关闭时。** autopilot 只在 Tower 模式开启时运行。`/tower off` 之后，执行中的 objective 会停止推进，直到你重新开启 Tower 模式。

### 验证

每个里程碑都会声明自己需要哪几类验证。它的所有 feature 都已合并或放弃后，所需的各类验证会在当前 base 最新提交上同时开始。

| 类型 | 执行者 | 检查内容 | 何时需要 |
| --- | --- | --- | --- |
| `scrutiny` | validator Agent | 对照每个 feature 的任务和完成标准，审查该里程碑合并后的改动；检查并行开发的 feature 之间是否衔接出错；运行类型检查、lint 和测试 | 里程碑的 `scrutiny` 开关打开（默认）且 `skipScrutiny` 关闭 |
| `user-testing` | validator Agent | 按照里程碑的 QA 说明，像用户一样使用产品：运行 CLI、脚本，发送 HTTP 请求。任何偏差都会记为附带复现步骤的失败项。 | 里程碑的 `user_testing` 开关打开（默认）且 `skipUserTesting` 关闭 |
| `commands` | Tower 自身，不使用模型 | 运行里程碑的命令；在最后一个里程碑上还会运行 objective 的验收命令。所有命令都以 0 退出才算通过。 | 里程碑至少有一条要运行的命令 |

只有每个所需类型的最新一轮都在同一个 commit 上通过，里程碑才算通过。不需要任何验证类型的里程碑，会在其 feature 全部合并或放弃后立即通过。

> [!IMPORTANT]
> 验证命令会在 base 最新提交的一个全新、detached 的 checkout 中机械地运行，其中既没有安装好的依赖，也没有构建产物。每条命令都必须自带准备步骤：要写 `npm ci && npm test`，而不是 `npm test`。

这些命令依次运行，每条都在该 checkout 根目录下单独的 `bash -c` 中执行，因此 `cd` 和导出的环境变量不会带到下一条命令。即使前面的命令失败，后面的命令也都会运行。每条命令最多运行 15 分钟，超时后它的进程组会被杀掉。命令的 stdin 是 `/dev/null`，环境中会额外设置 `CI=1`、`TERM=dumb`、`NO_COLOR=1` 等变量。每条命令输出的最后 4000 个字符会写入验证报告。

validator Agent 在一个 detached 的验证 worktree（`.tower/worktrees/val-<milestone>-<kind>-r<round>`）中工作，它检出的正是要验证的 commit。validator 可以在其中安装依赖、构建并启动产品，但不能修改文件：它没有 `write` 和 `edit` 工具，这类调用也会被拦截。每个 validator 只用 `TowerValidate` 提交一次结论，之后它的 worktree 会被移除。每一轮验证（包括机械验证）都记录在 `.tower/comms/validations/` 下。

- 验证轮次按里程碑和类型分别编号。某类验证在一个 commit 上失败后，不会在同一个 commit 上再次运行：下一轮需要新的 base 最新提交，通常是合并了修复之后。
- 某类验证的失败轮数达到 `maxValidationRounds`（默认 3）时，里程碑会被阻塞，objective 也随之阻塞。
- 如果 base 在里程碑验证期间有了新提交，或者在最后一个里程碑通过之后又有新提交，验证会在新的最新提交上重新运行。旧 commit 上的轮次视为过期。
- 契约改变后，只有在当前契约下记录的轮次才决定里程碑是否通过；失败轮次无论来自哪份契约、哪个 commit，都仍计入 `maxValidationRounds`。

### Autopilot 与 orchestrator

批准之后，具体操作由 **autopilot** 驱动。autopilot 是普通代码，不是模型。它会响应 Tower 状态的每次变化、每个结束的 Agent、inbox 消息，以及一个看门狗定时器。它只通过 orchestrator 使用的同一套 Tower 操作来执行动作，因此所有规则依然有效：没有针对 branch 当前最新提交的独立 clean review 就不能合并，也不能改动 feature 范围之外的内容。

autopilot 会：

- 为当前里程碑中依赖已合并或已放弃的每个 feature 启动 worker，数量上限为 `maxRunningAgents`；
- 为 branch 当前最新提交上的每个 review 请求派发 reviewer；
- 恢复收到 review 意见或需要解决 rebase 冲突的空闲 worker；
- 当 worker 在完成 feature 之前就空闲下来（既没有调用 `TowerComplete`，也没有报告 blocker）时，提醒它完成任务或说明受阻原因，每个 branch 最新提交只提醒一次；
- 用同一 branch 上的新 worker 替换失败或超时的 worker，每个 feature 最多 `maxFeatureAttempts` 个 worker，但绝不替换你停止的 worker；
- rebase 落后的 branch，合并通过检查的 branch；
- 启动验证：派发 validator 并运行命令；
- 推进到下一个里程碑，并通过完成门槛完成 objective；
- 预算用尽时暂停 objective；验证失败轮数或停滞唤醒次数过多时阻塞它。

只有需要判断时才会唤醒 orchestrator，唤醒原因包括：

- `plan-milestone`：当前里程碑还没有 feature；
- `validation-failed`：根据失败项规划修复 feature；
- `blocker`：某个 worker 报告了 blocker 或提出了问题；
- `feature-attempts-exhausted`：某个 feature 用完了 worker 尝试次数；
- `worker-idle`：worker 被提醒之后，再次没有完成就空闲下来；
- `merge-blocked`：合并检查因需要判断的原因而受阻，例如改动了 feature 范围之外的文件；
- `rebase-conflict`：没有 worker 能接手的冲突；
- `review-stuck` 和 `validation-stuck`：reviewer 或 validator 一再没有给出结果就结束；
- `stalled`：已经有 `stallTimeoutMs` 没有任何进展。

每种情况只唤醒一次。autopilot 驱动执行中的 objective 时，各个 feature 的机械事件只会作为上下文送达 orchestrator，不会触发模型轮次：结束的 Agent、review 请求和 survey 总结、review 结果以及验证结果。只有 autopilot 自己发出的唤醒和需要判断的消息（例如 worker 的提问）才会触发轮次，因此 orchestrator 只为判断消耗 token。如果 autopilot 的同一个动作连续三次被拒绝，orchestrator 会收到确切的错误信息和建议的处理办法。

你始终掌握主动权：照常和 orchestrator 对话，用 `/tower stop <agent>` 永久停止某个 Agent（autopilot 绝不替换你停止的 worker），或者用 `/tower pause` 停止启动任何新工作。

**手动模式。** 在 `tower.json` 中设置 `"objective": { "autopilot": false }` 后，feature 的执行由 orchestrator 自己驱动，就像普通的 Tower 运行一样：它用 Tower 工具派发 worker 和 reviewer、恢复和替换 worker、rebase 和合并，每个结束的 Agent 和每条 inbox 消息也都会像以前一样触发它的轮次。验证、里程碑推进、完成、看门狗、预算和判断类唤醒仍然自动进行。

### 看门狗、停滞唤醒与预算

- **看门狗。** 除了响应事件，autopilot 还会每隔 `watchdogIntervalMs`（默认 60 秒）检查一次 objective。
- **停滞唤醒。** 如果 `stallTimeoutMs`（默认 3 分钟）内什么都没有变化，同时没有 Agent 或验证在运行、orchestrator 也处于空闲，objective 就被视为停滞。"什么都没有变化"涵盖 mission、branch 最新提交、review、验证轮次、base 最新提交和 inbox。此时会唤醒 orchestrator 重新评估。连续 `maxStallWakes`（默认 3）次停滞唤醒都没有带来进展，objective 就会被阻塞。
- **无人值守时的规划。** 无人值守运行中，如果 objective 停留在 planning 并且 `stallTimeoutMs` 内没有进展，会发出一次唤醒，要求 orchestrator 完成计划并请求批准。
- **预算。** `maxWallTimeMs` 从首次批准开始计时。`maxCostUsd` 统计 pi 为每个 Tower Agent 以及 orchestrator 自身轮次报告的花费，因此它的准确程度取决于 pi 掌握的模型价格。任一预算达到上限时，objective 会暂停并通知你。要继续，请在 `tower.json` 中调高或去掉该限额，然后运行 `/tower resume`。两者默认都不设置。

`maxValidationRounds`、`maxFeatureAttempts`、`maxWallTimeMs` 和 `maxCostUsd` 会在起草 objective 时复制进去，`/tower resume` 会刷新它们。orchestrator 无法修改这些值。

### 重启

objective 保存在 git 和 `.tower/comms/state.json` 中，因此能跨 pi 重启保留，而 Agent 不能（见[停止、清理与重启](#停止清理与重启)）。如果 Tower 模式重新开启时有一个执行中的 objective（在新的 pi 进程中运行 `/tower on`，或者继续原会话），autopilot 会立即接手：

- worker 丢失的每个 feature 都会在原有 branch 上得到一个新 worker，它会从 branch 历史显示的中断处继续。这会计为一次新的尝试，计入 `maxFeatureAttempts`；
- 因重启而中断的验证会重新运行，遗留的验证 worktree 会被移除；
- review、合并和里程碑都从记录的状态继续。

已暂停的 objective 会保持暂停，直到 `/tower resume`；等待批准的 objective 仍然等你批准。手动模式下，由 orchestrator 自己替换丢失的 worker，就像普通的 Tower 运行一样。

### Objective 命令与工具

| 命令 | 作用 |
| --- | --- |
| `/tower objective [--headless] <text \| @file>` | 把 objective 交给 orchestrator，可以直接给出文本，也可以从文件读取（`@path`，相对于 pi 的工作目录）。命令会立即返回，随后由 orchestrator 规划。Tower 模式必须已开启。使用 `--headless` 时，orchestrator 规划时不会提问：它自己决定未明确的问题，把每个假设记为 objective 的备注，然后请求批准。`pi-tower run` 使用的就是这个选项。 |
| `/tower objective status` | 显示 objective 状态面板，不触发模型轮次 |
| `/tower approve [--auto]` | 批准正在等待批准的 objective 的计划。它的当前里程碑变为 active，autopilot 开始工作。`--auto` 会把这次批准记录为自动批准而不是人工批准，`pi-tower run --auto-approve` 发送的就是它。如果契约是在 objective 被阻塞或暂停期间修改的，则只接受不带参数的 `/tower approve`。 |
| `/tower pause [reason]` | 暂停执行中的 objective。正在运行的 Agent 会完成当前轮次，不再启动新工作。 |
| `/tower resume` | 先按当前 objective 配置重新载入限额，再恢复已暂停或已阻塞的 objective |

objective 专用的工具有两个：

- **`TowerObjective`**（仅限 orchestrator）通过 `draft`、`update`、`request-approval`、`status` 和 `block` 这几个动作管理 objective。它没有批准动作，也没有完成动作，并且不能修改限额。
- **`TowerValidate`**（仅限 validator）提交 validator 对所负责的里程碑和验证类型的结论：`pass` 或 `fail`，附带失败项、检查项和证据。每个 validator 只调用一次。

另有两个已有工具增加了 objective 相关参数。`TowerPlan` 为每个 feature 增加 `milestone`（objective 未结束期间，build mission 必须填写）和 `origin`（`plan` 或 `fix`）。`TowerSpawn` 支持 `kind: "validator"`，并配合 `milestone` 和 `validation_kind`（`scrutiny` 或 `user-testing`）使用，orchestrator 用它来恢复卡住的验证。见[工具参考](#工具参考)。

## 无人值守运行：`pi-tower run`

`pi-tower run` 在无人值守的情况下运行一个 objective：可以放进 CI、定时任务，或者放在一个你不再盯着的终端里。它会在你的仓库中以 RPC 模式启动 pi，开启 Tower 模式，用 `/tower objective --headless` 交出一个 objective 文件，然后一直跟进到 objective 结束。在 headless 模式下，orchestrator 规划时不会提问：它自己决定未明确的问题，把每个假设记为 objective 的备注，然后请求批准。

```text
pi-tower run -f <objective.md> [--auto-approve] [--timeout <ms>] [--cwd <dir>] [--pi <path>] [-- <extra pi args>]
```

| 选项 | 含义 |
| --- | --- |
| `-f`, `--file <path>` | objective 文件（Markdown），必填 |
| `--auto-approve` | 无需人工即批准计划：运行器会发送 `/tower approve --auto`，记录为自动批准。不加这个选项时，运行会停在计划处，退出码为 3。 |
| `--timeout <ms>` | 超过这么多毫秒后放弃，最大 2147483647（退出码 2） |
| `--cwd <dir>` | 要运行的仓库，默认是当前目录 |
| `--pi <path>` | pi 可执行文件：一个路径，或在 `PATH` 中查找的命令，默认是 `pi` |
| `-- <args>` | 把 `--` 之后的所有参数原样传给 pi |

相对路径基于当前目录解析。`pi-tower --help` 显示用法，`pi-tower --version` 显示版本号。

| 退出码 | 含义 |
| --- | --- |
| `0` | objective 已完成 |
| `1` | objective 被阻塞或暂停（例如因为预算），运行开始后 pi 退出了，或者 `/tower approve --auto` 因退出码 3 以外的原因失败 |
| `2` | 超时（`--timeout`） |
| `3` | 计划需要批准：没有给出 `--auto-approve`，或者契约是在 objective 被阻塞或暂停期间修改的，因此只能由人工批准这份计划。计划会被打印出来。请在 pi 中用 `/tower approve` 批准；在允许的情况下，也可以加上 `--auto-approve` 重新运行。 |
| `4` | 用法或启动错误：参数错误、objective 文件或目录不存在、pi 没有启动、pi 没有 `/tower` 命令，或者 `/tower on`、`/tower objective` 执行失败 |
| `130` / `143` | 被 SIGINT / SIGTERM 中断。会先停止 pi；如果再收到一次信号，就直接杀掉它。 |

**获取命令。** `pi-tower` 就是包里的 `bin/pi-tower.js`，需要 Node 22.19 或更高版本。在本地 checkout 中可以运行 `node /path/to/pi-tower/bin/pi-tower.js run …`；用 npm 全局安装这个包之后，`pi-tower` 会出现在你的 `PATH` 中。

**加载扩展。** 运行器启动的 pi 加载 pi-tower 的方式与你的交互会话相同：作为已安装的 pi package，或者通过写在 `--` 之后的 `-e` 加载，例如 `pi-tower run -f objective.md -- -e /path/to/pi-tower/src/index.ts`。两种方式不要同时使用：pi 会把扩展加载两次并给它的命令改名，运行会以退出码 4 结束。

运行过程：

1. 在仓库中启动 `pi --mode rpc`，后面接上你的额外参数。当前检出的 branch 会成为 base，所以请先检出一个 branch。
2. 发送 `/tower on`，再发送 `/tower objective --headless @<文件的绝对路径>`。如果工作区中已经有一个等待批准或正在执行的 objective，就改为跟进它，不再重复发送文件。如果已有的 objective 处于暂停状态，运行会立即以退出码 1 结束：请先在 pi 中用 `/tower resume` 恢复它，再重新运行 `pi-tower run` 来跟进。
3. 每秒读取一次 `.tower/comms/state.json`，objective 或它的某个里程碑状态发生变化时打印一行。
4. objective 等待批准时打印计划。带 `--auto-approve` 时批准并继续，不带时以退出码 3 退出。
5. objective 完成、被阻塞或暂停时，或者 pi 退出、超时、收到信号时，运行结束。退出之前总会先停止 pi。

运行器会把你的环境变量传给 pi，因此 `PI_TOWER_CONFIG` 和 `PI_TOWER_*_MODEL` 照常有效，例如可以为某次运行单独指定一个 `tower.json`。无人能回答的对话框会被自动取消。运行器自己不写任何文件，只读取状态文件。进度输出到 stdout，警告和错误输出到 stderr。

如果你在 pi 中接手一个 headless objective，不带参数的 `/tower approve` 或 `/tower resume` 会把它切回交互模式，orchestrator 会重新向你提问，而不是自己做决定。

无人值守运行时，请在 [objective 配置](#objective-配置段)中设置 `maxWallTimeMs` 和 `maxCostUsd`，再用 `--timeout` 作为最外层的限制。请用 `--auto-approve` 批准，并让 `objective.autoApprove` 保持关闭：这个选项只在本次运行期间生效；两者同时开启时，它们可能同时去批准同一份计划，导致运行失败。

下面是一个端到端的例子。objective 文件请放在仓库之外，因为主 checkout 中未跟踪的文件可能会进入 worker branch：

```sh
cd ~/work/shop
git switch main
pi-tower run -f ~/objectives/csv-export.md --auto-approve --timeout 14400000
echo "exit code: $?"
```

[`examples/objective.md`](examples/objective.md) 是可以直接用于这次运行的完整 objective 文件。输出大致如下（计划部分有删节）：

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

## Droid Missions 与 pi-tower

Objective 模式借鉴了 [Factory 的 Droid Missions](https://docs.factory.com/missions/overview) 的流程：与人一起规划、批准、验证每个里程碑、修复直到通过。改变的是工作的执行方式。

| | Droid Missions | pi-tower objective 模式 |
| --- | --- | --- |
| 规划 | 与你一起：把 feature 分组到里程碑中 | 与你一起；无人值守运行时由 orchestrator 独自规划并记录假设。产出一份契约（目标、完成标准、验收命令）和有序的里程碑，里程碑中的 feature 就是 Tower mission |
| 批准 | 执行开始之前由你批准计划 | 只有你能批准（`/tower approve`），或者使用你配置的自动批准。orchestrator 没有批准用的工具；批准之后修改契约，需要你重新批准。 |
| 里程碑内的 feature | 逐个执行（Factory 的文档把并行执行列为仍在探索的问题） | 并行执行，每个都有自己的 git worktree 和 branch，上限为 `maxRunningAgents` |
| 每个 feature 的审查 | 由 validator 检查每个里程碑；文档中没有提到针对单个 feature 的独立 review | 每个 feature 合并前都要经过独立 reviewer 和合并检查，之后再验证整个里程碑 |
| 验证 | scrutiny 和 user-testing 两类 validator | 同样两类 validator，外加机械的 `commands` 类型：由 Tower 在不使用模型的情况下运行里程碑命令和验收命令，全部以 0 退出才算通过 |
| 修复循环 | 验证失败会产生修复 feature | 相同，直到所有里程碑都通过。某类验证失败达到 `maxValidationRounds` 次时，objective 会被阻塞，交由你决定。 |
| 限制 | feature 重试次数上限 | `maxFeatureAttempts`、`maxValidationRounds`、停滞看门狗，以及达到后会让 objective 暂停的时长和花费预算（`maxWallTimeMs`、`maxCostUsd`） |
| 无人值守 | `droid exec --mission -f mission.md` | `pi-tower run -f objective.md [--auto-approve]`，退出码有明确定义 |
| 模型 | orchestrator、worker 和验证 worker 的模型 | orchestrator、worker、reviewer 和 validator 的模型 |
| 运行次数估算 | feature 数 + 2 × 里程碑数 | 公式相同，显示在批准请求中 |

## 适用场景

是否使用 Tower，主要看任务能否并行，以及你是否接受更多的 token 消耗和磁盘占用。

一些合适的场景：

- 任务可以拆成多个相对独立、验证方式明确的 mission，并行推进能省去等待时间。
- 需求仍在变化，需要频繁传达新要求、调整方向或优先级。
- 希望每次改动都被仔细审核，有独立的 branch 和对应的 review。

如果你能事先说清怎样才算完成、该如何检查，并希望 Tower 一直推进到这些检查通过，就选择 objective 模式；如果还在探索，就用普通消息引导一次自由的 Tower 运行。

## 从启动到合并

本节介绍一次由你的消息引导的自由 Tower 运行。objective 使用同样的工作区、branch、review 和合并检查，[Objective 模式](#objective-模式)介绍了它额外提供的能力。

### 开始之前

先切换到最终接收改动的本地 branch，并检查工作区状态：

```sh
cd /path/to/project
git status
```

请在仓库的顶层目录中启动 pi。Tower 会在 pi 的工作目录中创建它的工作区（`.tower/`）。

Tower 只能合并到本地 branch，不能合并到 remote-tracking ref 或 tag。如果 `/tower <base-branch>` 指定的 branch 不存在，Tower 会基于当前 checkout 创建它；在交互界面中，创建前会先请你确认。使用已有 branch 并保持工作区干净，是最稳妥的做法。

> [!WARNING]
> Tower 可能把未提交和未跟踪的文件快照到 worker branch 中；创建新的 base branch 时，会把这些改动提交到该 branch。对于还不是 Git 仓库的目录，Tower 会执行 `git init`，并把现有文件纳入初始 commit。开始前请确认其中没有机密文件或超大文件。Tower 会把 `.tower/` 加入 `.git/info/exclude`，因此它自己的状态永远不会被提交。

### 步骤

1. **开启 Tower。** 通常直接输入 `/tower on` 即可。这个命令只开启 Tower 模式，不会发送任务。第一次初始化时，Tower 会把当前本地 branch 记录为 base；以后开启时沿用已记录的 base。

   如果当前是 detached HEAD（未检出任何 branch），或者需要换一个 base，请改用 `/tower <base-branch>`，例如 `/tower feature/my-objective`。

2. **描述任务。** 像平常对话一样输入任务，并说明如何验证、什么情况下算完成。Tower 会初始化 `.tower/`、规划 mission，并启动所有依赖已经满足的 worker。worker 完成任务或 Tower 的 inbox 收到消息时，Tower 会自动继续处理；如果 Tower 当时正忙，这次唤醒会等到它当前的轮次结束。

3. **让任务在后台推进。** 每个 worker 在自己的 branch 和 worktree 中工作并提交。Tower 会安排独立 reviewer，必要时 rebase，并按依赖顺序合并通过审核的 mission。Tower 询问任务范围或优先级时，请及时回复。

4. **验收合并结果。** 检查 `git status`、base branch 的提交历史和最终 diff，并运行你关心的测试或验收命令。这些检查只是基础保障，不能替代你自己的验收。

5. **清理并退出。** 所有 mission 都已合并或放弃后，先输入 `/tower teardown` 清理可以移除的 mission worktree，再输入 `/tower off` 退出 Tower 模式。这些操作的区别见[停止、清理与重启](#停止清理与重启)。

## 查看状态并干预

你不需要了解 worker 之间的通讯协议，也能查看和干预 Tower。

- **查看状态面板。** `/tower` 或 `/tower status` 会直接读取当前状态，不会触发模型轮次。可以看到 base、mission、roster（含每个 Agent 的模型）、review 检查、inbox 数量、并发预算和近期活动。存在 objective 时，还会多出一行 objective 摘要。
- **跟进 objective。** `/tower objective status` 显示 objective 状态面板，同样不触发模型轮次：状态、耗时和花费、每个里程碑及其 feature 和验证轮次、正在运行的 Agent，以及预期的下一步。
- **调整任务方向。** Tower 开启期间，直接发送普通消息即可补充约束、调整优先级或要求总结。Tower 把消息转给正在运行的 worker 后，worker 会在下一步看到它，正在执行的工具调用不会被打断。
- **检查或停止 Agent。** `/tower agents` 列出本会话的 worker、reviewer 和 validator，以及它们的状态、模型、思考等级和分工。`/tower stop <agent>` 停止一个正在运行的 Agent。你主动停止的 worker 或 reviewer 视为有意终止：除非你另有指示，Tower 不会恢复、改派或替换它。objective 执行期间，autopilot 也绝不会恢复或替换你停止的 worker；但如果某个 review 或验证仍然缺失，它会启动新的 reviewer 或 validator，最多 `maxFeatureAttempts` 个。如果你不希望启动任何新工作，请暂停 objective。
- **切换 base。** 再次输入 `/tower <base-branch>`。Tower 会按新 base 重新检查现有 mission，只有落后的 branch 需要 rebase。合并之前，主 checkout 必须位于记录的 base 上。
- **查看诊断日志。** pi-tower 会把自己的诊断信息（例如通知发送失败、Agent 会话中扩展报出的错误）写入 `.tower/pi-tower.log`；在 `.tower/` 创建之前，则写入 pi agent 目录下的 `pi-tower.log`。

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
| `/tower off` | 退出当前会话的 Tower 模式，并切换回 `/tower on` 之前使用的模型。后台 Agent 继续运行，不会删除任何文件。autopilot 会停止，因此执行中的 objective 在 Tower 模式重新开启之前不会推进。 | `.tower/`、mission branch 和 worktree |
| `/tower teardown` | 让 Tower 移除可以安全移除的 mission worktree 并报告结果。正在运行的 Agent 的 worktree 一律保留；有未提交改动的 worktree 除非强制，否则也会保留。如果有 objective，请在它完成之后再运行。 | mission branch 和 `.tower/comms/` 审计记录；Tower 模式保持开启 |
| 退出 pi，或用 `/new`、`/resume`、`/fork`、`/clone`、`/reload` 替换当前会话 | 停止 Tower 的所有 worker、reviewer 和 validator，之后需要重新派发 | 磁盘上的 `.tower/` 状态、branch 和 worktree |

Tower 模式会保存在 pi 会话中。继续该会话时（`pi -c`、`/resume`、`/reload`），Tower 模式会自动恢复；但如果此时另一个正在运行的 pi 进程已经拥有该工作区，Tower 模式会关闭并给出警告。

Agent 无法跨重启存活。pi 重启后，mission 和 worktree 仍然保留，但上一次运行中的 worker 和 reviewer 已经结束。Tower 会用新名字派发新的 worker；`TowerResume` 会以清晰的提示拒绝恢复旧 Agent。当另一个会话接管工作区时，原会话的 roster 条目会被注销。Tower 模式重新开启后，执行中的 objective 会自动继续，见[重启](#重启)。

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

逐行说明：

- Tower 用 Claude Opus 规划和合并，思考等级为 `high`。
- worker 用 Claude Sonnet 开发，思考等级为 `medium`。
- reviewer 使用另一家厂商的模型，思考等级为 `high`，提供独立的第二意见。
- objective 的 validator 使用同一家厂商的模型，思考等级为 `xhigh`，检查得更慢、更彻底。
- 模型池额外提供一个模型 `fast`。只有你明确要求时，Tower 才会在某次派发中使用它。
- 最多同时运行 4 个 Agent，每次运行最长一小时。
- objective 在首次批准 4 小时后，或者花费达到 40 美元时（以先到者为准）会暂停；连续 5 分钟没有进展（而不是默认的 3 分钟）才会唤醒 orchestrator。

请把模型 id 换成你的 pi 可以使用的模型，`pi --list-models` 会列出它们。

| 配置项 | 取值 | 默认值 |
| --- | --- | --- |
| `orchestrator` | Tower 模式开启期间主会话的模型规格 | 当前会话的模型 |
| `worker` | worker 的模型规格 | 继承 orchestrator，包括思考等级 |
| `reviewer` | reviewer 的模型规格 | 继承 orchestrator，包括思考等级 |
| `validator` | objective 中 validator 的模型规格 | 继承 reviewer，包括思考等级；没有配置 reviewer 时继承 orchestrator |
| `models` | 模型池：从别名到模型规格的映射对象 | 无模型池 |
| `maxRunningAgents` | 正整数：同时运行的 worker、reviewer 和 validator 的上限 | `256` |
| `agentTimeoutMs` | 正整数，最大 2147483647：单次 worker、reviewer 或 validator 运行的时长上限，单位毫秒 | `7200000`（2 小时） |
| `objective` | 对象：objective 模式的配置，见 [`objective` 配置段](#objective-配置段) | 全部使用默认值 |

**模型规格**有两种写法：

- 字符串 `"provider/modelId[:thinkingLevel]"`，例如 `"anthropic/claude-sonnet-5-5:high"`。
- 对象 `{ "model": "provider/modelId[:thinkingLevel]", "thinkingLevel": "...", "description": "..." }`。只有 `model` 是必填项。`description` 会出现在 Tower 可选择的模型列表中。

模型规格和配置文件的规则：

- 思考等级可选 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。不指定时使用 pi 为该模型设定的默认思考等级。
- 只有当 `:` 后缀正好是上述等级之一时，才会被当作思考等级；其他后缀仍属于模型 id。
- 思考等级只能设置一次：要么用 `:` 后缀，要么用 `thinkingLevel`，不能同时使用。
- 模型池别名长度为 1 到 64 个字符，可以包含字母、数字、`.`、`_` 和 `-`，并且必须以字母或数字开头。`primary`、`orchestrator`、`worker`、`reviewer` 和 `validator` 是保留名，不区分大小写。
- 文件是纯 JSON，不能写注释。未知配置项会被拒绝，并列出允许的配置项，`objective` 配置段内也是如此。空文件视为 `{}`。

### `objective` 配置段

可选的 `objective` 对象用来调整 [objective 模式](#objective-模式)，其中每一项都是可选的。

| 配置项 | 取值 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `autopilot` | `true` 或 `false` | `true` | 由 autopilot 驱动 feature 的执行。设为 `false` 即为[手动模式](#autopilot-与-orchestrator)。 |
| `autoApprove` | `true` 或 `false` | `false` | 自动批准计划，记录为自动批准。如果契约是在 objective 被阻塞或暂停期间修改的，仍然需要人工批准。交互使用时请保持关闭，见[已知限制](#已知限制)。 |
| `maxValidationRounds` | 正整数 | `3` | 某类验证的失败轮数达到这个值时，里程碑和 objective 会被阻塞 |
| `maxFeatureAttempts` | 正整数 | `3` | 每个 feature 最多派发几次 worker。它也限制没有给出结果就结束的 reviewer 数量（按 branch 最新提交计）和 validator 数量（按里程碑、验证类型和 commit 计），达到上限后会唤醒 orchestrator。 |
| `watchdogIntervalMs` | 正整数，最大 2147483647 | `60000`（1 分钟） | 看门狗检查 objective 的间隔 |
| `stallTimeoutMs` | 正整数，最大 2147483647 | `180000`（3 分钟） | 多长时间没有任何变化后发出停滞唤醒 |
| `maxStallWakes` | 正整数 | `3` | 连续多少次停滞唤醒仍无进展后阻塞 objective |
| `maxWallTimeMs` | 正整数，最大 2147483647 | 未设置 | 从首次批准起经过这么多毫秒后暂停 objective |
| `maxCostUsd` | 正数 | 未设置 | objective 记录的花费达到这么多美元后暂停它 |
| `skipScrutiny` | `true` 或 `false` | `false` | 一律不要求 `scrutiny` 验证 |
| `skipUserTesting` | `true` 或 `false` | `false` | 一律不要求 `user-testing` 验证 |
| `autoTeardown` | `true` 或 `false` | `false` | 会被接受并在 `/tower models` 中显示，但目前尚未使用：objective 完成后不会自动移除 worktree，请运行 `/tower teardown`。 |

`maxValidationRounds`、`maxFeatureAttempts`、`maxWallTimeMs` 和 `maxCostUsd` 会在起草 objective 时复制进去，`/tower resume` 会再次复制；orchestrator 无法修改它们。其他配置项在配置重新加载后立即生效，只有 `watchdogIntervalMs` 要到下次开启 Tower 模式时才生效。`/tower models` 会显示每一项的值和来源，但不能修改它们：请直接在 `tower.json` 中编辑这一段。

### 配置来源

| 来源 | 可设置 | 说明 |
| --- | --- | --- |
| `--tower-orchestrator-model`、`--tower-worker-model`、`--tower-reviewer-model`、`--tower-validator-model` | 各对应一个角色 | pi 命令行参数，字符串形式的模型规格 |
| `PI_TOWER_ORCHESTRATOR_MODEL`、`PI_TOWER_WORKER_MODEL`、`PI_TOWER_REVIEWER_MODEL`、`PI_TOWER_VALIDATOR_MODEL` | 各对应一个角色 | 环境变量，字符串形式的模型规格 |
| `<project>/.pi/tower.json` | 所有配置项 | 仅当 pi 信任该项目时才读取（见 `/trust`）。未受信任项目的文件会被忽略，`/tower models` 会注明这一点。 |
| `<agentDir>/tower.json` | 所有配置项 | 全局文件。agent 目录默认为 `~/.pi/agent`，可通过 `PI_CODING_AGENT_DIR` 修改。 |
| `PI_TOWER_CONFIG=<path>` | — | 替换全局文件的路径。支持 `~/` 展开，相对路径基于当前目录解析。 |

优先级从高到低：

- **角色：** 命令行参数，其次是环境变量，然后是项目文件，最后是全局文件。仍未设置的角色按开头表格中的规则回退：orchestrator 回退到会话模型，worker 和 reviewer 继承 orchestrator，validator 在配置了 reviewer 时继承 reviewer，否则继承 orchestrator。
- **`models`：** 全局文件和项目文件的模型池会合并；同名别名以项目文件为准。
- **`maxRunningAgents` 和 `agentTimeoutMs`：** 项目文件优先于全局文件，没有对应的命令行参数或环境变量。
- **`objective`：** 逐项比较，项目文件优先于全局文件，因此项目可以只覆盖其中一项，其余沿用全局文件。没有对应的命令行参数或环境变量。

例如，下面这次运行从 `tower.json` 读取 orchestrator 和 worker，但仅在本次运行中覆盖两个角色：

```sh
PI_TOWER_WORKER_MODEL=anthropic/claude-haiku-5-5 pi --tower-reviewer-model openai/gpt-5.5:xhigh
```

pi-tower 会在会话启动时、每次开启 Tower 模式（`/tower on`）时以及每次运行 `/tower models` 时读取配置；Tower 模式已经开启时再输入 `/tower on` 不会有任何变化。手动编辑 `tower.json` 之后，运行一次 `/tower models` 即可重新加载，之后的派发无需重启就会使用新配置。

所有来源会一起校验。只要其中任何一处有无效值（例如命令行参数、环境变量或任一配置文件中的拼写错误），整个配置都会加载失败。在修正之前：

- 所有派发都会被拒绝，`/tower models` 会显示错误信息；
- 会话启动和 `/tower on` 时会警告 "Tower model configuration could not be loaded: …"；
- `/tower on` 仍会开启 Tower 模式，但会话保持当前模型。

### `/tower models`

`/tower models` 会列出每个角色和模型池别名的模型、思考等级和来源，接着列出 objective 配置。它还会显示两个配置文件的状态，并列出存在的问题，例如模型不在 pi 的模型注册表中，或者 provider 没有凭据。如果文件无法解析，则会显示解析错误。下面的示例中，`examples/tower.json` 是全局文件，同时设置了 `PI_TOWER_REVIEWER_MODEL=openai/gpt-5.5:high`：

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

如果没有配置 `validator`，它那一行会显示 `inherited from reviewer`；如果 reviewer 也没有配置，则显示 `inherited from orchestrator`。

也可以直接在 pi 中修改模型配置：

```text
/tower models worker anthropic/claude-sonnet-5-5:medium     # 在全局 tower.json 中设置一个角色
/tower models validator openai/gpt-5.5:xhigh                # 为 validator 单独指定模型
/tower models fast anthropic/claude-haiku-5-5               # 设置（或新增）模型池别名 "fast"
/tower models reviewer openai/gpt-5.5:high --project        # 改为写入 <project>/.pi/tower.json
/tower models reviewer --clear                              # 再次移除该配置
```

- 目标可以是 `orchestrator`（或其别名 `primary`）、`worker`、`reviewer`、`validator`，或者模型池别名，也可以写成 `models.<alias>`。
- 写入是原子的，对象形式的条目会保留它的 `description`。
- 写入后，pi-tower 会重新加载配置，下一次派发就会使用新配置。
- 如果写入的值仍被更高优先级的来源（命令行参数、环境变量或项目文件）覆盖，或者写入的是未受信任项目的文件，pi-tower 会给出警告。
- Tower 模式开启期间修改 orchestrator，不会切换正在运行的会话。请先 `/tower off` 再 `/tower on`，或者使用 `/model`。

### `/tower on` 和 `/tower off` 会切换会话模型

如果通过配置文件、环境变量或命令行参数配置了 orchestrator，`/tower on` 会把主会话切换到该模型及其思考等级；`/tower off` 会切换回之前的模型和思考等级。如果你在此期间用 `/model` 自行换过模型，pi-tower 会尊重你的选择，不做切换。

- 如果 orchestrator 模型不在 pi 的注册表中、没有凭据，或者配置无法加载，Tower 模式仍会开启，但会给出警告，会话保持当前模型。
- 如果没有配置 orchestrator，会话本身的模型就是 orchestrator，不会发生切换。

### 为单次派发选择模型

默认情况下，worker 使用 `worker` 模型，reviewer 使用 `reviewer` 模型，validator 使用 `validator` 模型。如果想让某个 Agent 使用其他模型，用普通消息告诉 Tower 即可：

- "派发审查 feat/checkout-docs 的 reviewer 时，使用 worker 模型。"
- "让 agent-docs 使用 fast 模型。"
- "这个 reviewer 用 primary。"

可选值只有 `orchestrator`（或其别名 `primary`）、`worker`、`reviewer`、`validator`，以及你的 `models` 模型池中的别名。其他 provider/model id 都会被拒绝，错误信息会列出允许的选择。如果需要其他模型，请先把它加入 `models`。autopilot 派发时总是使用角色对应的模型。

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
| validator 默认模型 | —（没有 objective 模式） | `validator`（默认：reviewer，其次是 orchestrator） |
| 单次派发可选 | `primary` 或模型池别名 | `orchestrator`/`primary`、`worker`、`reviewer`、`validator` 或模型池别名 |
| 配置位置 | `config.toml`（`[secondary_model]`） | `tower.json`（全局或项目）、环境变量、命令行参数、`/tower models` |
| 切换主会话模型 | — | `/tower on` 切换到 orchestrator，`/tower off` 切换回来 |

在 Kimi Code 中，如果想让 reviewer 使用与 Tower 不同的模型，只能在每次派发时单独指定。在 pi-tower 中，三个角色都是相互独立的配置，可选的 validator 也一样。

## 命令参考

| 命令 | 作用 |
| --- | --- |
| `/tower` 或 `/tower status` | 显示精简的 Tower 状态，不触发模型轮次 |
| `/tower on` | 开启 Tower 模式：激活 Tower 工具、接管已有的 `.tower/` 工作区，并切换到 orchestrator 模型。不会发送任务。执行中的 objective 会立即继续。 |
| `/tower <base-branch>` | 若 Tower 模式未开启则开启它，并把该本地 branch 设为 base：新工作区会以它初始化，已有工作区会重新锚定到它。branch 不存在时会基于当前 checkout 创建，并把未提交的改动提交到该 branch。在交互界面中，创建 branch 之前会先征求你的确认。 |
| `/tower off` | 关闭 Tower 模式并切换回之前的模型。Agent 继续运行，`.tower/` 保留，但 autopilot 会停止。Tower 工具仍然可用，但在重新开启之前，`TowerInit`、`TowerPlan`、`TowerSpawn` 和 `TowerObjective`（`status` 动作除外）会拒绝执行。 |
| `/tower teardown` | 以普通消息请 Tower 执行 `TowerTeardown` 并报告结果。Tower 模式保持开启。 |
| `/tower models` | 显示角色和模型池的模型、来源、配置文件状态、存在的问题，以及 objective 配置 |
| `/tower models <role\|alias> <provider/modelId[:thinking]> [--project]` | 在全局 `tower.json` 中设置角色或模型池模型；加上 `--project` 则写入项目文件 |
| `/tower models <role\|alias> --clear [--project]` | 移除角色或模型池模型 |
| `/tower agents` | 列出本会话的 worker、reviewer 和 validator（包括已结束的），以及状态、模型和分工 |
| `/tower stop <agent>` | 停止一个正在运行的 worker、reviewer 或 validator，可以传入 roster 名称、agent id 或 task id。这是人为停止：除非你另有指示，Tower 不会恢复、改派或替换它。objective 执行期间，如果 review 或验证仍然缺失，autopilot 仍可能启动新的 reviewer 或 validator。 |
| `/tower objective [--headless] <text \| @file>` | 把 objective 交给 orchestrator，可以直接写文本，也可以从文件读取。Tower 模式必须已开启，并且没有其他 objective 处于等待批准、执行中或已暂停状态。`--headless` 表示规划时不提问。见 [Objective 命令与工具](#objective-命令与工具)。 |
| `/tower objective status` | 显示 objective 状态面板，不触发模型轮次 |
| `/tower approve [--auto]` | 批准正在等待批准的 objective 的计划。`--auto` 记录为自动批准。 |
| `/tower pause [reason]` | 暂停执行中的 objective：正在运行的 Agent 会完成当前轮次，不再启动新工作 |
| `/tower resume` | 先按当前 objective 配置重新载入限额，再恢复已暂停或已阻塞的 objective |
| `/tower help` | 显示所有子命令的用法（也可以用 `--help` 或 `-h`） |

子命令不区分大小写，base branch 保留原有大小写。Tab 补全支持子命令、Agent 名称、模型目标、`--clear`/`--project` 选项、`objective status`/`--headless`，以及 `approve --auto`。

常见的输入失误会被拒绝并给出 "did you mean" 提示，而不会被当作 branch 名称：

- 相近的词 `model`、`config`、`configure`、`agent`、`task`、`tasks`、`list`、`ls`、`start`、`enable`、`disable`、`stat`、`state`、`kill`、`objectives`、`goal`、`approval`、`accept`、`unpause` 和 `continue`；
- 在不接受参数的子命令后面多写的内容，例如 `/tower on now`；
- 含有空格的 base branch 名称。

如果相近的词正是一个已存在的本地 branch 的名称，则不会被拒绝。例如本地已有 `config` branch 时，`/tower config` 会像其他 `/tower <base-branch>` 一样把 `config` 设为 base；如果工作区已经记录了另一个 base，则重新锚定到 `config`。只有不存在同名本地 branch 的相近词才会被拒绝，因此输入失误不会创建新的 branch。

只有你可以开启 Tower 模式，模型无法自行开启。

## 工具参考

pi-tower 共有 19 个工具。orchestrator 拥有其中 17 个；worker 和 reviewer 拥有 7 个，其中 `TowerComplete` 只有它们才有；validator 拥有 5 个，其中 `TowerValidate` 只有 validator 才有。

**orchestrator 工具。** 运行 `/tower on` 后激活，只有主会话拥有。

| 工具 | 用途 |
| --- | --- |
| `TowerInit` | 初始化（或接管）`.tower/` 工作区，并记录 base branch |
| `TowerPlan` | 把工作拆成 mission，包括 id、branch、范围、任务和依赖。objective 期间，每个 feature 还要标明所属的 `milestone`，以及 `origin`（`plan` 或 `fix`）。 |
| `TowerSpawn` | 为 mission 在独立 worktree 中启动 worker，为某个 branch 启动 reviewer，或为正在验证的里程碑启动 validator（`milestone`、`validation_kind`），使用角色模型或明确指定的模型 |
| `TowerMerge` | 通过合并检查后，把 mission branch 合并到 base（`--no-ff`） |
| `TowerRebase` | 在 mission 的 worktree 中把落后的 branch rebase 到当前 base |
| `TowerTeardown` | 移除已完成的 mission worktree（支持 dry run、exclude 和 force），保留 branch 和 `.tower/comms/` |
| `TowerSend` | 向某个 Agent、Tower 或 `all` 发送 inbox 消息；正在运行的 Agent 会在下一步收到 |
| `TowerInbox` | 分页读取 inbox，只确认实际返回的消息 |
| `TowerFinding` | 针对 mission 范围之外的问题提交结构化 finding（bug、improve、vuln、idea） |
| `TowerReview` | 提交 review 结论；Tower 只能在特殊情况下作为破例手段使用 |
| `TowerMission` | 读取或更新 mission：状态、备注、blocker、完成或放弃的任务、范围 |
| `TowerStatus` | 显示完整的状态面板：objective、mission、待派发、已死亡的 worker、roster、review 检查、inbox、并发、活动 |
| `TowerResume` | 用新的提示在后台继续一个已停止或已结束的 worker，保留它原有的上下文。validator 不能恢复。 |
| `TowerTasks` | 列出后台的 worker、reviewer 和 validator，以及状态、模型和分工 |
| `TowerTaskOutput` | 查看某个 Agent 的快照：状态、最新文本、最近的工具调用、用量、最终消息 |
| `TowerTaskStop` | 停止一个正在运行的 worker、reviewer 或 validator；Tower 自己停止的 worker 之后可以恢复 |
| `TowerObjective` | 管理 objective：`draft`、`update`、`request-approval`、`status` 和 `block`。没有批准动作，也没有完成动作。 |

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

**validator 工具。** 只存在于 validator 会话中。

| 工具 | 用途 |
| --- | --- |
| `TowerValidate` | 仅限 validator：为分配给它的里程碑和验证类型提交结论（`pass` 或 `fail`，附带失败项、检查项和证据），只提交一次 |
| `TowerFinding` | 针对里程碑之外的问题提交 finding |
| `TowerInbox` | 读取来自 Tower 和其他 Agent 的消息 |
| `TowerSend` | 给 Tower 或其他 Agent 发消息 |
| `TowerStatus` | 读取状态面板 |

此外，worker 还拥有 pi 的 `read`、`bash`、`edit`、`write`、`grep`、`find` 和 `ls` 工具；reviewer 和 validator 拥有 `read`、`bash`、`grep`、`find` 和 `ls`，没有 `write` 和 `edit`。

Tower 模式关闭期间，`TowerInit`、`TowerPlan`、`TowerSpawn` 和 `TowerObjective`（`status` 动作除外）会拒绝执行；其他工具照常工作，因此未完成的合并和消息仍然可以处理完。

## 安全边界与资源开销

worktree 只能隔离写入，不能当作安全沙箱。

- worker 可以读取仓库内容，并以你的权限运行工具，而且不会请求审批。
- worker、reviewer 和 validator 以无界面方式运行。它们无法再派发 subagent：pi-tower 不会在它们内部加载，它们的工具列表里也没有 subagent 工具。
- objective 的验证命令来自你批准的计划，Tower 会以你的权限、在无人值守的情况下运行它们。批准之前，请在批准请求中读一遍这些命令。
- mission 范围、合并检查以及下面的几道防护都只是流程约束，不是安全边界。

pi-tower 提供三道防护：

- **Bash 防护。** 只要工作区有拥有者就会生效，检查 orchestrator 以及每个 worker、reviewer 和 validator 的 bash 调用。它会拦截：
  - 对 `.tower/comms` 执行的 `rm`；
  - 对 `.tower` 或包含它的目录执行的递归 `rm`；
  - 作用范围覆盖主 checkout、且带有 force 和 `-x`/`-X` 的 `git clean`；
  - 在主 checkout 中执行的 `git reset --hard`。

  同样的命令在 mission worktree 或验证 worktree 内是允许的。如果命令中出现 `rm`、`git clean` 或 `git reset`，而解析器无法安全地分析它（例如用了命令替换或 heredoc，或者要删除的路径依赖某个变量），为保险起见会直接拦截。这道防护只针对上述命令，其他破坏性命令不会被拦截，这一点与 Kimi Code 相同。它只检查 pi 的 `bash` 工具，不检查 Windows 上的 `powershell` 工具。

  由于它宁可多拦也不漏拦，一些无害的命令也会被拦下，例如 `source "$HOME/x" && rm -rf y`、`ENV=x bash script && rm -rf y`，或者在主 checkout 中运行的 `cd <worktree> || exit 1; git reset --hard`。把这类命令拆成几条更简单的命令即可避免。
- **写入防护。** worker 在自己的 worktree 之外调用 `write` 和 `edit` 会被拒绝。
- **只读 reviewer 和 validator。** reviewer 和 validator 都没有 `write` 和 `edit` 工具；对 validator 来说，`write` 或 `edit` 调用还会被直接拦截。

资源开销：

- 每个 worker、reviewer 和 validator 都有独立的模型上下文，会分别消耗 token。Tower 的规划、消息传递、故障恢复和合并轮次也会产生消耗。Agent 越多，配额、CPU 和磁盘压力越大。
- `maxRunningAgents` 限制同时运行的 worker、reviewer 和 validator 数量；未配置时上限为 256。机械的 `commands` 验证不占用这个名额。
- 当 provider 返回限流（HTTP 429）时，上限会自动收缩，新的派发会暂停约一分钟。
- `/tower status` 会显示当前的预算和正在运行的 Agent 数量，而且不会启动模型轮次。
- 运行时间超过 `agentTimeoutMs`（默认 2 小时）的 Agent 会以超时结束，Tower 会收到通知。
- 一个 objective 至少需要每个 feature 运行一次 Agent、每个里程碑运行两次，每次验证失败还会增加修复 feature 和验证轮次。请用 [objective 配置](#objective-配置段)中的 `maxCostUsd` 和 `maxWallTimeMs` 加以限制。

建议先拆少量相互独立的 mission，完成后及时清理 worktree，释放磁盘空间。

## 已知限制

- **自动批准与被阻塞的 objective。** 设置 `"objective": { "autoApprove": true }` 后，一个 objective 被阻塞之后，orchestrator 可能会起草一个新的 objective，而它会被自动批准。这会在没有你参与的情况下重新开始计算时长和花费预算。交互使用时请保持 `autoApprove` 关闭。无人值守运行器在 objective 被阻塞时会以退出码 1 退出，不会走到这一步。
- **验证命令需要自带准备步骤。** 它们在一个全新的 detached checkout 中运行，没有安装好的依赖，也没有构建产物，因此每条命令都必须包含准备步骤，例如 `npm ci && npm test`。
- **验证失败轮数不会清零。** 无论换了几个 commit、契约是否修改过、是否执行过 `/tower resume`，失败轮次都会计入 `maxValidationRounds`。恢复一个因验证失败而被阻塞的 objective 之前，请先在 `tower.json` 中调高 `maxValidationRounds`，否则同类验证再失败一次，它就会再次被阻塞。
- **user-testing 没有浏览器。** user-testing validator 没有浏览器或 GUI 工具，行为测试只能依靠 bash 能驱动的东西：CLI、HTTP 请求和脚本。
- **commit 时间戳精度为一秒。** autopilot 通过比较 commit 时间戳来判断某个 review 请求是否覆盖 branch 当前的最新提交，而时间戳的精度只有一秒。这不会造成问题：reviewer 审查的始终是真正的最新提交。
- **`pi-tower` 在 Node 22 上未经测试。** 这个命令只在 Node 26 上开发和测试过，Node 22.x 下的代码路径尚未测试。
- **`autoTeardown` 目前不起作用。** 这个配置项会被接受和显示，但 objective 完成后不会自动移除 worktree。请运行 `/tower teardown`。

## 与 kimi-code Tower 的差异

pi-tower 移植了 Kimi Code 的 Tower：协议存储、13 个 Tower 工具及其说明和拒绝提示、worker 和 reviewer 的任务简报、提醒、合并检查和状态面板。凡是 pi 与 Kimi Code 不同的地方，pi-tower 都做了适配。以下每一项都与实际发布的代码一致。

**Objective 模式**

- **pi-tower 新增的能力。** Kimi Code 的 Tower 没有 objective、里程碑、validator 或 autopilot。`TowerObjective`、`TowerValidate`、`validator` 角色、`/tower objective`、`/tower approve`、`/tower pause`、`/tower resume` 和 `pi-tower run` 都只存在于 pi-tower 中。底层移植的协议没有改变：objective 的每个 feature 都是一个普通 mission，经过同样的 review 和合并检查。
- **没有 objective 时一切照旧。** 在从未开始过 objective 的工作区中，mission、review、合并和状态文件都与 pi-tower 0.1 完全相同。

**模型**

- **三个角色模型，而不是两个。** `orchestrator`、`worker` 和 `reviewer` 可以分别配置，另外还有模型池；objective 模式还增加了可选的 `validator`。在 Kimi Code 中，Tower 和 reviewer 共用主模型，worker 默认使用 `[secondary_model]`。
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
- **worker 在自己的 worktree 中运行。** worker 会话以它的 worktree 作为工作目录。在 Kimi Code 中，worker 在主 checkout 中运行并使用绝对路径。两者的 reviewer 都在主 checkout 中运行。validator 只存在于 pi-tower 中，它在 detached 的验证 worktree 中工作。
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

`npm test` 运行离线的 vitest 测试套件，不需要模型或网络，也不会启动 pi。其中唯一的 live runtime 测试只有在设置 `PI_TOWER_LIVE=1` 时才会运行（模型由 `PI_TOWER_LIVE_MODEL` 指定），否则跳过。

扩展入口是 `src/index.ts`，在 `package.json` 的 `pi.extensions` 中声明。

### 端到端实测

`npm run test:e2e:pi` 用真实模型检验 pi-tower。它以 RPC 模式启动真实的 `pi` 进程，加载本 checkout 中的扩展，并在临时运行目录（`pi-tower-e2e-*`）里用一次性的 git 仓库驱动它们。

| 场景 | 检查内容 | 报告标记 |
| --- | --- | --- |
| S1 | 三个角色各用一个不同的模型 | mandatory（必选） |
| S2 | 命令接口与模式生命周期 | mandatory（必选） |
| S3 | 一个目标从开始到结束的完整生命周期 | mandatory（必选） |
| S8 | 防护与拦截 | mandatory（必选） |
| S4 | 审查返工循环 | optional（可选） |
| S7 | 通过 `/tower stop` 进行人工停止 | optional（可选） |
| S13 | `maxRunningAgents=1` 的并发预算 | optional（可选） |

默认运行全部七个场景。任一选中的场景失败或你的 pi 设置被改动时，退出码为 1；达到全局超时时退出码为 2。

```sh
npm run test:e2e:pi -- --selfcheck
npm run test:e2e:pi
PI_TOWER_E2E_SCENARIOS=S1,S2,S3,S8 npm run test:e2e:pi -- --report=e2e-report.md
```

`--selfcheck` 只执行离线检查，不启动任何会话。它仍会调用 `pi --version`，所以 `pi` 必须在 `PATH` 中。它会基于本 checkout 检查 wake 解析器，并输出每个角色的模型能否与 pi 的默认模型以及起始会话模型区分开。

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `PI_TOWER_E2E_CHECKOUT` | 本 checkout | 要加载其 `src/index.ts` 的 pi-tower checkout |
| `PI_TOWER_E2E_PI` | `pi` | pi 可执行文件 |
| `PI_TOWER_E2E_ORCHESTRATOR_MODEL` | `byteplus-gateway/claude-sonnet-5-5:low` | orchestrator 模型 |
| `PI_TOWER_E2E_WORKER_MODEL` | `byteplus-gateway/claude-haiku-5-5:low` | worker 模型 |
| `PI_TOWER_E2E_REVIEWER_MODEL` | `byteplus-gateway/claude-opus-5-5:low` | reviewer 模型 |
| `PI_TOWER_E2E_SESSION_MODEL` | `byteplus-gateway/claude-haiku-5-5:low` | `/tower on` 之前的会话模型。必须与 orchestrator 模型不同，才能观察到模型切换。 |
| `PI_TOWER_E2E_SCENARIOS` | `all` | 逗号分隔的场景编号，例如 `S1,S3`。`--scenarios=S1,S3` 的效果相同。 |
| `PI_TOWER_E2E_TIMEOUT_MS` | `4500000`（75 分钟） | 整次运行的超时时间 |
| `PI_TOWER_E2E_SCENARIO_TIMEOUT_MS` | `1200000`（20 分钟） | 每个场景的超时时间 |
| `PI_TOWER_E2E_KEEP` | 未设置 | 设为 `1` 时保留运行目录及其中的仓库和日志。`--keep` 的效果相同。 |
| `PI_TOWER_E2E_VERBOSE` | 未设置 | 设为 `1` 时回显各 pi 进程的输出。`--verbose` 的效果相同。 |
| `PI_TOWER_E2E_REPORT` | 未设置 | 把 Markdown 报告写到该路径。`--report=<path>` 的效果相同。 |

模型采用 `provider/modelId[:thinking]` 格式。orchestrator、worker 和 reviewer 的模型必须是三个不同的 provider/model id，否则运行不会开始。默认值使用名为 `byteplus-gateway` 的 provider，请把这些模型变量设成你的 pi 配置能访问的模型；运行时使用该配置中的 provider 和凭据。

每次运行都会消耗真实的 token：使用默认的 sonnet、haiku 和 opus 模型（low thinking）时，一次完整运行约需 6 分钟，花费约 1.1–1.3 美元。

端到端实测不会修改你的 pi 设置。每个 pi 进程都在运行目录中拥有自己的 `tower.json`（通过 `PI_TOWER_CONFIG` 指定）和会话目录，并以 `--no-extensions`、`--no-skills`、`--no-prompt-templates`、`--no-context-files` 和 `--offline` 启动。运行前后，runner 会记录 agent 目录（`~/.pi/agent`，或 `PI_CODING_AGENT_DIR`）中 `settings.json` 和 `tower.json` 的指纹；任一文件发生变化，本次运行即判为失败。

## 许可证与致谢

pi-tower 以 [MIT 许可证](LICENSE)发布，Copyright (c) 2026 YukoOshima。

pi-tower 移植自 Moonshot AI 的 [Kimi Code](https://github.com/MoonshotAI/kimi-code) 中的 Tower 模式。它的协议、工具说明、提示词和测试都源自该项目，该项目同样采用 [MIT 许可证](https://github.com/MoonshotAI/kimi-code/blob/main/LICENSE)（Copyright (c) 2026 Moonshot AI）。两份许可声明都收录在 [LICENSE](LICENSE) 中。感谢 Kimi Code 团队的原创设计。
