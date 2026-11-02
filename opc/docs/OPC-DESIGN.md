# OPC 后台设计 v0.1（以 Orca 为执行层）

> 状态：设计稿，未实现。依据本机 Orca 1.4.245 的 `orca-cli` / `orchestration` 指南。
> 标 ⚠️ 的是推断，必须在 P0 spike 中验证后才能写进代码。
> 独立仓库 `~/opc`；不复用 agent-switchboard 里的 `board/orca-observe` 和 `shared-repo/` 文件协议。

## 0. 一句话

**老板（你）→ OPC 后台 → 各业务负责人（Leader agent）→ Orca 编排 → 下属 agent。**
后台不自己做多智能体协作，协作全部交给 Orca 的 Run / Task / Dispatch / Gate；后台只负责"开业务、派负责人、下目标、看进度、拍板"。

## 1. 分层与职责边界

```
┌──────────────── WebUI（老板驾驶舱） ────────────────┐
│ 总览 · 业务详情 · 待我决定 · 时间线 · 设置           │
└───────────────▲─────────────────────┬──────────────┘
                │ SSE 推送             │ REST 指令
┌───────────────┴─────────────────────▼──────────────┐
│ OPC 后台（管理层）                                    │
│  ├ 采集器 Collector：轮询 orca --json → 状态缓存 + 事件 │
│  ├ 执行器 Commander：唯一的写入口，排队/幂等/审计       │
│  ├ 业务库 SQLite：业务、负责人席位、目标、指令、决策      │
│  └ HQ 中继终端：后台在 Orca 里的身份（见 §4）⚠️         │
└───────────────▲─────────────────────┬──────────────┘
                │ orca ... --json（execFile，不走 shell）
┌───────────────┴─────────────────────▼──────────────┐
│ Orca（执行层，状态真相源）                             │
│  业务工作区 ─ Leader（Coordinator，绑定一个 Run）      │
│             └ worker-start → 下属 agent（Dispatch）   │
└────────────────────────────────────────────────────┘
```

| 归 Orca 管（后台只读） | 归后台管（Orca 没有） |
| --- | --- |
| 工作区、终端、agent 存活 | 业务是什么、归谁、优先级 |
| Run / Task / Dispatch / Gate 状态 | 业务 ↔ 工作区 ↔ Leader ↔ Run 的映射 |
| 信箱消息、worker_done 结论 | 老板下过的指令、做过的决策（审计） |
| 当前终端画面 | 历史快照与指标（Orca 释放 worker 后不再保留现场） |
|  | Leader 简报模板、业务级规则 |

**铁律**：凡是 Orca 能回答的问题，后台不另存一份"真相"，只存缓存和历史。

## 2. 领域模型（后台 SQLite）

```text
Business      id, name, kind(git|folder), workspacePath, orcaRepoId,
              leaderAgent(claude|codex|...), leaderModel?, briefTemplateId,
              priority, status(active|paused|archived), createdAt

LeaderSeat    id, businessId, worktreeId, terminalHandle, launchOperationId,
              currentRunId?, state(launching|live|stale|replaced), startedAt
              -- 一个业务同一时间只有一个 live 席位；重启时旧席位标 replaced

Objective     id, businessId, runId?, title, brief, status(draft|sent|running|done|failed),
              createdAt, closedAt
              -- 对应一个 Orca Run；Run objective 以 "[obj:<id>]" 开头，靠它认领

Instruction   id, businessId, objectiveId?, kind(objective|followup|decision|nudge),
              body, orcaMessageId?, retryRequestId, delivery(pending|enqueued|failed),
              createdAt
              -- 老板发出的每一句话都落库，可重放

Decision      id, businessId, source(gate|escalation|question), orcaRef(gateId|messageId),
              question, options[], resolution?, resolvedAt?, state(pending|resolved|expired)

Event         id, ts, businessId?, type, ref, payload  -- 采集器 diff 出来的时间线
Snapshot      ts, kind, json                            -- 每 N 分钟留一份，供回看
```

## 3. 核心流程

### 3.1 开业务
1. 设置页填：名称、目录、类型、负责人 agent、简报模板。
2. git 目录 → `orca repo add --path <dir>`；非 git → 走 folder 工作区（⚠️ 确认 folder 的注册方式，候选 `project setup-existing-folder`）。
3. 写 `Business`。

### 3.2 派负责人
```
orca agent launch --agent <leaderAgent> --worktree id:<repoId>::<path> --prompt <渲染后的 Leader 简报> --json
```
- 存 `result.launch.outcome.handle` 和 `operationId` 到 `LeaderSeat`。
- 回包丢失：同参数 + `--retry-launch <operationId>` 重放，**绝不重新 launch**。
- `prompt.outcome` 为 `journaled` / `handed-to-terminal` 才算派出成功。

### 3.3 下目标（= 开一个 Run）
1. 后台建 `Objective(draft)`，渲染一段目标简报。
2. 投递给 Leader（见 §4 投递通道），要求它 `run-create --objective "[obj:<id>] <标题>"`。
3. 采集器在 `run-list` 里看到带 `[obj:<id>]` 的 Run → 回填 `runId`，状态 `running`。
4. Leader 按 orchestration 指南 `task-create` / `worker-start` 拆解派发。

### 3.4 汇报与拍板
- worker 的问题 → Leader 自己回答（`reply`），后台不插手，只在时间线显示。
- Leader 需要老板决定 → 两种通道之一（§4），进"待我决定"。
- 老板选完 → 后台回写 → Leader 继续。

### 3.5 负责人重启 / 交接
Run 是持久的。旧席位 `exited` 或上下文过长时：
`agent launch` 新 Leader，简报里带 `run-use --id <runId>` 接管，旧席位标 `replaced`。
只有拿到 `exited` 的正面证据才换人；`unverifiable` 只告警，不动手。

### 3.6 收尾
目标的全部 Task 结清（`task-list` 无未结项，`worker-list --terminal-state reclaimable` 为空）→ Leader 汇报 → 老板确认 → `Objective.done`。

## 4. 后台在 Orca 里的身份：两种方案

问题：后台进程不是 Orca 终端，而 `check`（读信箱）、`gate-list`（不带 `--run` 时）都要求调用方身份。
已确认：`gate-list` 在终端外不带 `--run` 会报 `no_active_sender_terminal`（旧看板就踩了这个）。

**方案 A：HQ 中继终端（推荐，⚠️ 待验证）**
- 后台建一个 OPC 总部工作区，`orca terminal create --worktree <hq> --title "OPC-HQ"` 起一个普通 shell，拿到 handle。
- `orca orchestration run-create --objective "OPC HQ" --from <hqHandle>` 建一个"老板信箱 Run"。
- Leader 简报写明：要老板决定的事 → `orchestration send --to run:<hqRunId> --type escalation|question`。
- 后台用 `check --terminal <hqHandle> --wait` 收信、`reply --from <hqHandle>` 回复。
- 好处：老板信箱是 Orca 原生的、有序（FIFO）、可确认（ack）、可回复，不用轮询所有 Run。

**方案 B：纯观察（兜底）**
- Leader 用 `gate-create` 提决策 + `worktree set --unread --comment` 引起注意。
- 后台轮询每个 Run 的 `gate-list --run <id> --status pending`。
- 回复走 `gate-resolve`（⚠️ 非 Coordinator 能否调用）或 `send --to run:<leaderRunId>` 让 Leader 自己 resolve。

两种方案下，**指令下行**都用 `orchestration send --to run:<leaderRunId> --type dispatch`，
并要求 Leader 的 `check --wait --types` 包含 `dispatch,status,question,escalation,worker_done`。
`send` 成功只代表入队；需要立即唤醒时追加一次 `terminal send` 提示"查收信箱"。

## 5. 后台结构

技术选型：**TypeScript（Node 22 + Fastify + better-sqlite3）+ React/Vite**。
前端模板：**[satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin)**（MIT；React 19 + Vite 8 + Tailwind 4 + shadcn/ui + TanStack Router/Query/Table + Zustand + Recharts），去掉 Clerk 鉴权，只留本机访问。

**开发分工**

| 部分 | 负责 agent | 范围 |
| --- | --- | --- |
| 复杂后端 | GPT（codex） | `orca/cli.ts`、Collector、Commander（幂等/重放/handle 失效恢复）、HQ 中继与信箱、P0 spike |
| 一般后端 | Kimi | 领域模型与 SQLite、REST/SSE 路由、简报模板渲染、审计与时间线查询 |
| 前端 | Claude | `web/` 全部页面与组件、前后端接口契约（`shared/api.ts`） |

接口契约先由 Claude 起草、后端确认，三方都以 `shared/api.ts` 为准。
理由：`orca agent-context --json` 输出命令 schema，可生成 TS 类型；前后端一种语言。

```text
~/opc/
  docs/                  本设计文档
  server/
    orca/cli.ts          execFile 封装：--json、15s 超时、ok/error 解析、并发上限 4
    orca/types.ts        由 agent-context + P0 fixtures 生成/手写
    collector/           分层轮询 + diff → Event，写缓存与 Snapshot
    commander/           所有写操作：队列、retry-request 幂等、审计落库
    domain/              Business / LeaderSeat / Objective / Instruction / Decision
    briefs/              Leader 简报模板（见 §7）
    api/                 REST + SSE
  web/                   React 驾驶舱
  fixtures/              P0 抓到的真实 JSON，测试用
```

**采集节奏**

| 数据 | 命令 | 间隔 |
| --- | --- | --- |
| 健康 | `status` | 5s |
| 工作区与 agent | `worktree ps` | 5s |
| 老板信箱（方案 A） | `check --terminal <hq> --wait --timeout-ms 30000` | 长轮询 |
| 各目标的任务 / worker / 审批 | `task-list --run`、`worker-list --run`、`gate-list --run` | 10s，只扫 running 的目标 |
| Run 列表 | `run-list` | 30s |
| Leader 实时画面 | `terminal read --screen` | 仅详情页打开时，3s |

**写操作清单（全部经 Commander，全部审计）**
`repo add`、`agent launch`、`orchestration send`、`reply`、`gate-resolve`、`terminal send`、`worktree set`。
危险操作（`worktree rm`、`terminal close`、`worker-stop/abandon`）P1–P2 不开放。

**容错规则**
- handle 在 Orca 重启后失效（`terminal_handle_stale`）→ 重新 `worktree ps` / `terminal list` 找新 handle，只用新的。
- 存活三态 `live / unverifiable / exited` 原样显示，`unverifiable` 不等于死。
- Orca 不可达 → 页面显示"执行层离线"，保留最后快照，不排队写操作。

## 6. WebUI 页面

取 Supabase 控制台的风格（中性灰、细边、冷静的小字号），结构按 OPC 自己的用途设计。

- **顶栏面包屑**：`OPC / 业务 ▾ / 目标（Orca Run）▾ [RUNNING]`，右侧 Orca 状态、⌘K 搜索、主题。
- **侧栏**：平时只露图标，鼠标移入展开成浮层；放总览、待办（打开抽屉）、时间线、全部业务（带待决定数与提醒点）、设置。
- **工作台**（首页与业务页共用，只放"集中处理"需要的三样）：
  1. **Agent 架构图**：老板 → 负责人 → 下属的横向树，每个下属写明正在做的任务、阶段与心跳；点负责人按业务过滤，点下属定位到它手上的任务。
  2. **待办**：要老板决定的事，一行一件，点开就地选选项、写附言，直接回复负责人。
  3. **任务与汇报**：受阻 / 失败排最前；已完成的任务直接展示下属的 worker_done 汇报摘要，点开看改动文件。
- 不放"agent 干了多少活"之类的工作量统计——老板关心做了什么，不关心做了多少。
- **视觉规则**：静止扁平（平涂，无阴影渐变）；可交互元素只在悬停 / 键盘聚焦时浮起，浮起不代表选中。正文 13–14px、辅助 11–12px，系统字体（SF Pro + 苹方）。颜色只表达状态。
- **框的规则**：每个大功能（Agent 架构 / 待办 / 任务与汇报）一个大框，大框里不再套小框。架构节点是细边卡片，悬停变灰并上浮；列表行是「隐藏的框」，静止无边，悬停才变灰显出来。浮层（抽屉、详情、展开的侧栏）和输入控件自带边界。任务面板右上角是分段切换：全部 / 受阻 / 进行中 / 已汇报，几个状态几栏。
- **待办的操作区**：选项一律是同级、等宽的整行按钮（建议项只多一个「建议」标记，不做实心），小窗口里最多 3 行、单行截断；下面是回复框 + 「自定义」按钮——回复框里的话点选项时作为附言带上，点「自定义」则作为自定义回复单独发送（ResolveDecisionRequest.custom）。选项超过 3 个或放不下，从「详情」进对话框处理，那里选项完整显示。
- **点击必须有结果**：架构图节点 → 打开该 Agent 详情（写的进度 / 名下任务 / 手上任务与汇报 / 终端画面）；侧栏点一项后收起。

## 7. Leader 简报模板（草稿）

```text
你是「{{business.name}}」的业务负责人，工作目录 {{business.workspacePath}}。
身份：Orca 编排 Coordinator。先运行 `orca skills get orchestration` 读取指南并严格遵守。

规则：
1. 每个目标建一个 Run：orca orchestration run-create --objective "[obj:{{objective.id}}] {{objective.title}}" --json
2. 拆成自包含的 Task（写清 Target / Change / Constraints / Ownership / Acceptance），用 worker-start 派给下属。
3. 等待时：orca orchestration check --wait --types "dispatch,status,question,escalation,worker_done" --timeout-ms 900000 --json
   types 为 dispatch 的消息来自老板，优先处理。
4. 需要老板决定（花钱、对外发布、改方向、超出授权）时：
   orca orchestration send --to run:{{hq.runId}} --type escalation --subject "<一句话>" --body "<背景+选项+你的建议>" --json
   然后继续做不依赖该决定的部分。
5. 每个关键节点更新卡片：orca worktree set --worktree current --comment "<一句话进度>" --json
6. 目标完成：向 run:{{hq.runId}} 发 status 汇报（结果、证据、遗留问题），然后等待新指令。

授权边界：{{business.authority}}
```

## 8. 分期

| 期 | 内容 | 完成标准 |
| --- | --- | --- |
| **P0 Spike**（半天） | 测试业务 + 测试 Leader 跑通一次最小目标 | §9 全部有结论；fixtures 落盘 |
| **P1 驾驶舱** | 业务登记、派负责人、总览/详情只读、时间线 | 能从网页开业务并看到负责人和下属实时状态 |
| **P2 闭环** | 下目标、发指令、待我决定（方案 A 或 B）、审计 | 一个目标从下达 → 拆解 → 拍板 → 结案全在网页完成 |
| **P3 扩展** | 历史指标、多机（`environment` 配对的远程 Orca）、`automations` 定时巡检 | 按需 |

## 9. P0 必须回答的问题

1. 终端外调用 `send --to run:<id>`（不带 `--from`）能否投递到 Leader 信箱？Leader 的 `check --wait` 能否被它唤醒？
2. 方案 A 可行性：`run-create --from <普通 shell 的 handle>` 能否成功？`check --terminal <hqHandle>` 能否在终端外消费？Leader（已绑定自己的 Run）能否 `send --to run:<hqRunId>`？
3. `gate-resolve` 能否由非 Coordinator 调用？
4. Leader 能否先后持有多个 Run（每个目标一个 Run），还是只能一个长期 Run？
5. 非 git 目录作为业务工作区的正确注册方式。
6. 抓取真实的 `task-list`、`worker-list`、`gate-list`、`check` JSON，存进 `fixtures/`。

## 9.1 P0 验证记录（2026-11-01，Orca 1.4.245）

结论：**OPC 可以作为第三方客户端直连本机 Orca 引擎，不需要抠源码。** 验证脚本在 `spike/`。

- **连接**：读 `~/Library/Application Support/orca/orca-runtime.json`（unix socket 路径 + authToken），每行发一个 JSON `{id, authToken, method, params}`。与 `orca` CLI 同路，无需配对。✅
- **开终端 / 起 Agent**：`terminal.create { worktree: "path:<项目>", command: "codex", presentation: "background" }`。项目必须先在 Orca 里登记（`orca repo add --path`），否则 `selector_not_found`。✅
- **打字**：`terminal.send { text, enter: true, agentPrompt: true }`，交互式 Codex 收到并执行。✅
- **看过程**：`terminal.read { screen: true }` 拿当前整屏；每秒一次，50 秒内画面变化 8 次，能看到「Explored → Read → 回答 → Worked for 6s」全过程。✅
- **状态**：`terminal.agentStatus` 干活时为 `working`，空闲时为 `null`，可用来判断「干完了」。✅
- **实时流 ❌（unix socket 上）**：`terminal.subscribe` 返回 `requires a streaming transport`。流式只开在 websocket（:6768）上，那条路要设备配对 + 端到端加密（手机 / Orca Web 用的协议）。
  - 现阶段用「每秒读一次整屏」替代，已够看得见在跑。
  - 要逐字实时，二选一：照 Orca（MIT）的客户端代码实现配对 + 加密握手；或在 OPC 里内嵌 Orca 自带的网页客户端（:6768 已在提供 `Orca Web`）。
- **注意**：Orca 的 websocket 监听在 `0.0.0.0:6768`（局域网可达，靠设备令牌 + 加密保护）；Orca 桌面版会自动更新，接口有变的风险，OPC 只在一个适配层里调用它。

### 9.1.1 真实数据接入补充验证（2026-11-01）

本次使用 `~/opc` 下新建的普通 shell，直接连接运行中的 Orca 1.4.245；没有操作原有终端或 8787 服务。

| P0 问题 | 实测结论 |
| --- | --- |
| `run-create --from <shell handle>` | 成功，普通 shell 可以成为 Run Coordinator。测试 Run 为 `run_e7e6d693bd02`。 |
| 终端外 `task-list --run` / `gate-list --run` | 成功，无需绑定当前终端。创建 gate 后任务从 `ready` 变为 `blocked`；`deps`、`options` 是 JSON 字符串；任务和 gate 时间可能是 SQLite UTC 格式，API 统一转换为 ISO 8601。 |
| 终端外 `gate-resolve` | 不可直接调用：RPC 即使带 `run` 仍报 `run_required`；CLI 不带 `--from` 同样返回 `run_required`。使用测试 Coordinator 的 `from` 才成功。OPC 因此通过 `orchestration.send` 向 `run:<id>` 转交选择，返回 `delivery: enqueued`，保留 `state: pending`，直到负责人实际 resolve。 |

原始证据：`fixtures/real-data-p0.json`、`fixtures/real-data-p0-cli.json`。额外用第二个自建 shell 创建真实 Dispatch，验证 `worker-list` / `worker-show` / `worker_done` 汇报映射，原始证据在 `fixtures/real-data-worker.json`。测试没有向其他人的终端投递任何输入。

实现与来源约定：

- `server/business.mjs` 只保存业务登记，位置为 `~/opc/data/businesses.json`，首次初始化指定的五个业务；负责人 handle 和关联 Run ID 存在同一文件。其余运行事实从 Orca 获取。
- `worker-list` 当前版本的存活和 provider 位于 `workers[].projection`，终端归属由 `worker-show.terminal` 的精确身份检查确认；普通前台 Agent 终端用 `term:<handle>` 标识，无任务时 `taskId` 留空字符串，拓扑省略 `taskId`。
- Orca 的六种任务 status 与 `TaskStatus` 同名。Run 没有 status，目标状态由任务推导：全完成为 done，有失败为 failed，其余为 running；进度是 completed 数 / 总数，不推测百分比。
- 后台发送者使用 `opc-owner`。它是发送身份，**不是可接收的 Orca 信箱**。已有老板 HQ 信箱时，用 `OPC_OWNER_MAILBOX=run:<HQ Run ID>`（或真实终端 handle）配置收件地址。只把发给此地址、且可通过业务 Run 或负责人关联的 escalation/question 列为老板待办；用 `reply` 回答。未配置时这部分为空，不把下属向负责人的问题冒充老板待办。本次用测试 Run 作为 HQ 地址实测了 question → HTTP resolve → reply。
- 没有真实来源的负责人为 null；目标、任务、下属、待办、recentEvents 返回空数组；authority 默认空字符串；model、comment、heartbeat、report、closedAt、hq、lastEvent 等无来源就省略。未知的必需字符串（如历史启动时间或未识别 agent）为空字符串，绝不填当前时间冒充历史时间。
- 新接口耗时上限 25 秒，单次 Orca RPC 上限 15 秒，新接口共用最多 4 路 RPC；聚合快照缓存 2.5 秒，并合并并发采集。修改后失效缓存。Orca 不可达统一返回 HTTP 503 / `orca_unavailable`。
- Orchestration 写 RPC 必须携带 `orchestrationContractVersion: 1` 和独立 `orchestrationRequestId`，否则实测报 `orchestration_migration_required`；这两个字段只加在 orchestration 调用上。

验收在 `OPC_PORT=8790 node server/orca-bridge.mjs` 的独立实例上进行；逐个 curl 验证目标接口，并验证畸形 JSON、未知 ID、重复登记及不可达错误（检查记录见 `fixtures/real-data-http-checks.json`）。新启动的 Codex 负责人为 live，负责人及 `term:` 下属 screen 均返回了真实对话 `items`。测试实例及本次新开的终端在验收后关闭，测试业务登记删除。测试 gate 已 resolve，测试任务已 completed；Orca 仅提供全局 reset，没有按 Run 删除的接口，因此保留已结束的测试 Run 和其历史记录，没有执行会删除其他业务数据的 reset。8787 服务不重启，本次未提交 Git。

## 10. 待老板决定

- ~~新代码放哪~~ → 已定：新开独立仓库 `~/opc`（2026-10-31）。
- ~~技术栈~~ → 已定：TS + React，前端基于 shadcn-admin；分工见 §5（2026-10-31）。
- 第一个接入的真实业务选哪个（建议选一个风险低、任务可拆的）。
