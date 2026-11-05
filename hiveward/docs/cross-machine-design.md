# 跨电脑派活 / 控制设计

> 本文是只读调研与本机双实例实验结论，尚未实施。目标场景：老板在 Mac 的 Claude Code（CEO / Leader 座位）向 Windows 上的 Worker 派活，随后看状态、对话和终端，复核并拿到交付文件。
>
> 代码基线：`5da79e02296`。行号均指本次阅读和实验时的工作区。

## 结论先行

1. **传输层大体已有，组织关系和回程没有。** `--on`、配对组织、TLS 证书固定、令牌鉴权、HTTP `/api/m/<机器>/…`、终端 WebSocket 代理都可复用；缺的是“哪个 Mac 座位派出了哪个 Windows 派单”的可信关系和 Mac 本地持久镜像。
2. **执行端继续拥有真相，Mac 只存远程派单镜像。** Windows 管终端、对话、hook、派单状态、复核和工作记录；Mac 的镜像用于组织图、离线卡片、通知路由和原派单方授权。不要把远程派单原样复制进 Mac 的 `dispatches.json`，本机观察器找不到终端时会把它误判失败（`hiveward/server/dispatches.mjs:398-425`）。
3. **不能靠删除两个 403 来开放 Agent 复核。** 当前代理会剥掉调用者头，直接删源端 guard 会让执行端把 Agent 当成老板。必须同时引入“认证 peer 的机器 id + 原派单方 id + 目标任务”的授权校验。
4. **不要开放远程 `inbox/wait` 来凑通知闭环。** 应由 Windows 把复核唤醒可靠地推入 Mac 的本机 `agent-wake` 队列；Mac 仍执行普通的 `hiwd inbox`。这也避开代理 30 秒超时和 inbox 单次最长 60 秒等待的冲突。
5. **草案中的文件方向对，但当前默认 `hiwd files put <文件> --on <Mac>` 实际会断。** 代理没有转发 `x-hiveward-filename`；显式给目标收件箱路径才能成功。文件传输和消息收件箱也尚未关联。
6. **本轮不是实际 Windows 验收。** 两个实例都跑在本机 macOS 上，B 只命名为 `Windows-B`；真实 Windows 路径、进程识别、终端流和打开文件仍需 Windows 侧验收。

## 本轮实验边界与复现材料

- 两个独立 bridge 子进程：A 的本机 / LAN / TLS 端口为 `55276/55277/55278`，B 为 `55279/55280/55281`；未使用或访问 47615。
- A、B 各用独立 `HIVEWARD_DATA_DIR`、`HOME`、假 HiveWard Unix socket 和动态端口；通过当前 `machines/invite` + `invitations/:id/accept` 完成配对。
- Worker 是只记录 `terminal.send` 的假 Agent 和假 Claude transcript，没有调用 Anthropic、OpenAI、GitHub 或任何外部网站。
- 实验脚本：`/tmp/hiveward-cross-machine-probe.mjs`；完整输出：`/tmp/hiveward-cross-machine-probe.log`；本次数据：`/tmp/hiveward-cross-machine-probe-pDKcKp`。实验结束后两个 bridge 和假 Agent 均已停止。
- 复现命令：

```bash
cd ~/hiveward
export PATH="$HOME/hiveward/.hiveward-tools/node_modules/.bin:$PATH"
TMPDIR=/tmp HIVEWARD_BACKGROUND_LAUNCH=1 node /tmp/hiveward-cross-machine-probe.mjs
```

## 现状逐项：通 / 断 / 缺

| 项目                            | 结论                               | 代码位置                                                                      | 实测 / 证据                                                                                                |
| ------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 配对和 `--on` 选择              | **通**                             | `hiveward/server/hiwd.mjs:573-605`；`hiveward/server/lan.mjs:344-382,496-574` | A 邀请、B 接受均为 200；后续 A 的请求能经 B 的真实 TLS 入口执行                                            |
| `new … --on B`                  | **通，但有跨平台缺口**             | `hiwd.mjs:877-918`；`hiveward-bridge.mjs:209-263`                                 | B 创建终端并收到首句，A 没有终端；Windows 未登记路径会在 Mac 本地被拒绝                                    |
| `tell … --on B`                 | **通**                             | `hiwd.mjs:202-238,861-875`                                                    | B 的假终端收到补充话，B 新增派单记录                                                                       |
| 远程状态 / 汇报                 | **通**                             | `business-routes.mjs:247-275`；`dispatches.mjs:110-156,312-530`               | A 经 `/api/m/B/api/tasks` 读到 `completed + awaiting`                                                      |
| Agent `review … --on B`         | **断**                             | `lan.mjs:353-359`；`task-review.mjs:113-145`                                  | 在 A 的代理入口直接 403，未到 B 的复核逻辑                                                                 |
| 老板远程复核                    | **通（网页 / owner HTTP 通道）**   | `business-routes.mjs:276-281`；`task-review.mjs:27-40,113-205`                | 同一待复核任务，无 Agent 头的请求经 A 代理得到 200，B 写工作记录并关闭 Worker                              |
| 交活通知回 Mac                  | **断，且通知落错机器**             | `agent-wake.mjs:275-387`；`hiveward-bridge.mjs:434-452`                           | A 收件箱为空；同一个 Mac session id 在 B 的本地收件箱收到了消息                                            |
| `inbox --on B`                  | **明确禁止，应继续禁止用于此方案** | `hiwd.mjs:609-641`                                                            | CLI 报“只能接收本机当前身份的消息”                                                                         |
| `topology --on B`               | **不是 hiwd 命令**                 | `hiwd-engine-forward.mjs:8-29,36-57`                                          | 路由阶段报“topology 不支持 --on”；应使用原始 topology API 或 `overview --on`                               |
| 跨机组织图                      | **缺**                             | `orchestration.mjs:567-583,620-837`；`web/.../workbench/index.tsx:78-147`     | A 的图没有 B Worker；B 的图有 Worker，但没有“来自 Mac-A”的机器关系                                         |
| 远程终端控制通道                | **代码已有，复用即可**             | `terminal-websocket.mjs:51-58,113-168`；`web/src/lib/hiveward-live.ts:42-174`     | 本轮实测 owner accept 触发了 B 的 close；WS 未另做一轮手工验收，已有 `lan-tls.test.mjs:260-272` 覆盖远程流 |
| 默认 `files put --on`           | **断**                             | `files-cli.mjs:235-268`；`lan.mjs:517-523`；`files.mjs:220-233`               | CLI exit 1：“需要 x-hiveward-filename 文件名”                                                              |
| 显式目标目录的 `files put --on` | **通**                             | 同上                                                                          | 指定 A 的隔离收件箱绝对路径后写入 28 字节，A 本地读到相同内容                                              |
| 文件与任务 / 通知绑定           | **缺**                             | `files.mjs:277-280`；`files-cli.mjs:235-268`                                  | 文件只写目标收件箱并记时间线，不会唤醒 Agent，也不带 task id                                               |

### 1. `new --on` 实际到了哪里

实测：

```text
hiwd new /tmp/…/windows-workspace claude 远程第一件事 --on B
exit 0
已开 claude @ B-project：term_b_1
第一句话已送达

A terminals = []
B terminals = [term_b_1]
A dispatches = []
B dispatches = [{
  id: dsp_fdc54e51,
  handle: term_b_1,
  by: {
    kind: claude-code,
    id: mac-leader-session,
    label: Claude Code,
    cwd: /private/tmp/…/mac-workspace
  },
  status: pending
}]
```

这证明终端和派单都只落在执行端，也证明 `by` 没有来源机器字段。还有三个静态缺口：

- `hiwd.mjs:893-903` 在发起端执行 `resolve()`、`existsSync()`。实测 `hiwd new 'C:\work\demo' claude --on B` 在创建前失败：

```text
hiwd: 没有可用目录「C:\work\demo」，可选：B-project
```

- `hiwd.mjs:42,911-913` 把 Mac 的 `hiveward/docs/agent-browser.md` 绝对路径拼进 Windows 首句，目标机上通常不存在。
- `hiwd.mjs:176-200` 的登记是 best-effort；没有首句的 `new` 不登记派单。发送、登记和未来的本机镜像写入都不是一个事务，镜像必须可重建、可修复，不能假设永不错漏。

### 2. `tell --on` 和状态读取

实测：

```text
hiwd tell term_b_1 补充：先写交付说明 --on B
exit 0
已发给 claude
```

假 Worker 交活后，A 通过 B 的 API 读到：

```json
{
  "id": "dsp_fdc54e51",
  "status": "completed",
  "report": { "summary": "已完成：Windows-B 交付说明已经写好。" },
  "review": { "state": "awaiting", "reviewer": "dispatcher", "round": 1 },
  "dispatchedBy": { "kind": "claude-code", "id": "mac-leader-session" }
}
```

所以“读状态”无需另做状态数据库；需要补的是 `dispatchedBy.machineId` 和 Mac 镜像中的组织归属。显式 `--on` 已能路由，`read/review/tell` 不带 `--on` 时尚不会查远程镜像。

### 3. 通知和 inbox 的实际断点

`observeDispatches()` 在采快照时发现待复核派单并调用 `reviewObserver`（`orchestration.mjs:382-384`；`dispatches.mjs:521-528`）。`agent-wake` 并不是发现“派单方在另一台电脑”，它只拿 `dispatch.by.id` 当本机收件人。

本轮同一个 `mac-leader-session` 的结果：

```text
A: hiwd inbox --timeout 0.01
没有新消息

B: 以同一个 session id 执行 hiwd inbox --timeout 0.01
下属交活了，等你复核：
- 远程第一件事（任务 id dsp_fdc54e51；B-project）
复核 dsp_fdc54e51：用 hiwd read …，再 hiwd review …

A: hiwd inbox --timeout 0.01 --on B
hiwd: hiwd inbox 只能接收本机当前身份的消息
```

通知文本也没有 Worker 所在机器。只把这段原文转发到 Mac 仍不够，因为其中的 `read/review` 会在 Mac 找任务；必须同时传 `taskMachineId` 或依赖镜像自动路由。

### 4. 复核：Agent 断、老板通

Agent 命令实测：

```text
hiwd review dsp_fdc54e51 --accept --on B
hiwd: Agent 不能跨电脑复核
```

第一道拦截在 A 的 `lan.mjs:353-359`，因此请求尚未到 B。即使绕过它，B 的 `task-review.mjs:123-125` 还会拒绝 remote Agent。

同一个任务改用 owner HTTP 通道（不带 Agent 头）经 A 代理：

```text
POST A /api/m/B/api/tasks/dsp_fdc54e51/review  {verdict:accept}
→ 200
→ task.review.state = accepted
→ record.id = wr_dsp_fdc54e51
→ B 的 Worker 终端关闭
```

因此草案里“老板随时可以”在**网页 / owner 通道**已有基础；`hiwd review` 则始终带 Agent 头，不能把它当作老板通道。工作记录和 accept 状态当前都只留在 B。

还需注意：`reviewCaller()` 仅凭头判断调用者，本机 Agent 授权只比较 `dispatch.by.id === caller.id`（`task-review.mjs:27-40,131-145`）。跨机后若不增加来源机器，B 上一个同 id 的本地 Agent 也可能被误认成 Mac 派单方。

### 5. 拓扑现状

`hiwd topology --on B` 的实测输出：

```text
hiwd: topology 不支持 --on（这是引擎命令，只能在本机执行）
```

`hiwd overview --on B` 和 `GET A /api/m/B/api/topology` 则可通。Worker 存活时，本轮原始拓扑简化为：

```text
A /api/topology:
  business:mac-workspace → ceo:mac-workspace
  （没有 term_b_1）

A /api/m/B/api/topology:
  business:windows-workspace
    → ceo:windows-workspace
    → leader:windows-workspace:unassigned
        → dispatch:term_b_1 [worker]
```

首页当前是对每台机器分别请求 topology 再按机器列绘制（`web/src/features/workbench/index.tsx:78-147`），电脑节点也是前端合成的 seat，不是后端 `TopologyNode.kind`（`topology-seats.ts:8-16,123`）。现有 `external/外援` 只表示同机跨业务借调（`orchestration.mjs:530-565,728-743`；`shared/api.ts:461-469`），不能复用成跨机器字段。

### 6. 文件交付现状

默认推送到 A 收件箱实测失败：

```text
B: hiwd files put /tmp/…/delivery.txt --on A
hiwd: 需要 x-hiveward-filename 文件名
```

原因是 CLI 用该请求头传默认文件名（`files-cli.mjs:249-263`），而转发层只保留 `content-type/content-length/accept`（`lan.mjs:517-523`）。先执行 `files roots --on A` 拿到隔离收件箱，再显式传目标目录则成功：

```text
hiwd files put /tmp/…/delivery.txt '/private/tmp/…/home-a/HiveWard 收件箱' --on A
/private/tmp/…/home-a/HiveWard 收件箱/delivery.txt  28 字节

A 本地读取：cross-machine fake delivery
```

所以文件通道本身可用，但“自动进入原派单方收件箱”目前不成立。目标端已有绝对路径、`..`、隐藏 / 系统目录、软链 / junction、共享根、大小和原子写入检查（`file-path-policy.mjs:16-77`；`file-shares.mjs:34-55,151-186`；`files.mjs:215-287`），应继续复用。

## 目标模型：执行端真相 + 派单方镜像

建议把“远程派单”定义为一个可复核 root 任务的投影，而不是把整份执行端数据库复制到 Mac。

### 执行端 B 的派单新增来源身份

在现有内部派单记录上增加：

```text
dispatch.by.machineId       // 原派单方所在机器；旧记录没有
```

B 不接受请求 JSON 自报这个字段：

- 本机派单由 B 写入自己的机器 id；
- 经 A → B 的 LAN 派单，由 B 用 `lan.authenticate(req)` 得到的 `peer.id` 覆盖为 A；
- 旧记录缺 `machineId` 时保持可读，但远程 Agent 复核和远程唤醒一律 fail-closed，不按机器名、IP 或 cwd 猜测。

`Task.dispatchedBy` 同步暴露 `machineId?: Id`，供 B 的图显示“来自哪台电脑”，也供 A 重建遗漏的镜像。现有 `by.kind/id/label/cwd` 保留；`cwd` 只是来源机器上的目录，不能再拿去和 B 的目录直接做包含判断。具体要改 `businessOf()`（`orchestration.mjs:513-527`）和 `dispatchLocation()`（`agent-wake.mjs:64-80`）：remote-origin 派单跳过来源 cwd，在 B 只按执行端 `project/projectId` 归属；A 的来源业务则由镜像决定。

### 派单方 A 新增独立镜像

新增 `hiveward/server/remote-dispatches.mjs` 和隔离数据文件 `remote-dispatches.json`，不要复用本机 `dispatches.json`：

```text
RemoteDispatchMirror {
  id,                       // 本地随机 id；权限判断不能只用这个 id
  machineId,                // 执行端 B 的不可变机器 id
  remoteDispatchId,         // B 的可复核 root dsp_ id
  terminal,                 // B 的终端 handle，可因关闭而只作历史引用
  dispatcher: { kind, id, label, cwd },
  origin: {
    parentNodeId?,          // 派单时 A 的 ceo:/leader: 节点
    businessId?, projectId?
  },
  execution: {
    project, projectId?     // 都是 B 的语义，不能与 A 的 projectId 混用
  },
  status?, report?, review?, remoteRecordId?,
  revision?,                 // B 为该 root 单调递增的版本，防止旧通知回滚新状态
  attachments?,              // 实际已经写入 A 的附件，不从汇报文本猜
  createdAt, updatedAt, lastSeenAt?
}
```

- `new/tell` 在执行端登记成功后，用返回的派单在 A upsert 镜像；镜像只按 B 返回 / 只读投影里的 `parent/root` 关联，不在 A 按“未验收”或同 handle 自行猜测。
- 当前 B 对 `completed/awaiting` 后再 `tell` 的真实建单路径可能形成新 root（`dispatches.mjs:59-73,381-395`）。若产品希望它仍算追加，必须另改 B 的建单逻辑并用真实 `recordDispatch/hiwd tell` 验收，不能只在镜像里合并。
- 镜像写入失败只影响投影，不回滚已经发出的终端输入；界面和 CLI 要报警并允许重试。
- A 可经 B 的只读派单投影校正 `parent/root` 和补建缺失镜像。若增加 `GET /api/dispatches`，必须按认证 peer 过滤来源，不能只信 `originMachineId` 查询参数。
- 镜像存关系及最后已知快照；实时状态仍以 B 的 `tasks/topology` 为准。复核通过后只记 `accepted` 和 `remoteRecordId`，工作记录仍由 B 保存，Mac 需要时经 `/api/m/B/records/<id>` 读取。

涉及文件：`hiwd.mjs`、`dispatches.mjs`、`business-routes.mjs`、`hiveward-bridge.mjs`、`orchestration.mjs`、新增 `remote-dispatches.mjs`、`shared/api.ts` 及对应测试。

## 草案第 1 条：活在哪台跑就由哪台管

**判断：方向正确，但“电脑 id + 对方派单 id + 终端 handle”还不够。** 至少还需原派单方的 `(kind,id)`、Mac 上级节点 / 业务归属、执行端项目路径，以及最后已知的 `review/report`；否则能画线却做不了通知接收者校验和原派单方复核。

还要先修远程创建的两个跨平台问题：

1. `hiwd new --on` 对未登记目录不得在 Mac 上 `resolve/existsSync`，把原路径交给 B，由 B 按自己的平台展开 / 校验并执行 `existsSync`、`ensureRepo`。`Machine.platform` 目前可能因手工配对或未发现而缺失（`lan.mjs:149-156`），不能把它当源端路径校验的前提。
2. 远程首句不能带 Mac 的 `browserGuide` 路径。由执行端补本机指引路径，或跨机提示只保留 `hiwd web` 等机器无关内容。

老板从拓扑「+」直接跨机创建不应混入第一步：现有 `worker-launch.mjs` 会使用当前机器的业务、项目和目录（`worker-launch.mjs:16-69`），不能只给请求塞一个 `machineId`。本方案先打通 Mac Claude Code 的 `new/tell --on`；UI 发起跨机派单另需选择“Windows 执行项目 / 目录”。

## 草案第 2 条：跨机架构图

**判断：可行，但应由 A 的镜像投影卡片，不要等 B 在线后克隆一个节点才记得关系。** 这样 Windows 离线时 Mac 仍能显示最后状态，也不会把 B 的业务 / 项目 id 错挂到 A。

### 后端契约

`TopologyNode` 增加与 `external` 正交的字段：

```text
execution?: {
  machineId: Id,
  dispatchId: Id             // B 的可复核 root 派单 id
}
dispatcherMachineId?: Id      // B 展示“谁派来的”；仅远程来源时带
```

- A 的镜像投影节点：`parentId` 是 A 的 CEO / Leader，`terminal` 是 B 的 handle，`execution` 指向 B。
- B 自己的 Worker 节点仍由 `orchestration.mjs` 生成，额外带 `dispatcherMachineId`，并按 `by.label` 显示派单方。
- `dispatchedWorker()` 还应暴露真实的 `dispatchId: d.id` 和 `taskId: d.id`。目前只有 `id: dispatch:<handle>`（`orchestration.mjs:567-583`），同终端多轮任务时不足以稳定定位复核任务，详情页也需要 `taskId` 读汇报（`agent-pane.tsx:50-53`）。
- A 的合成 `node.id` 按镜像 / root dispatch 稳定生成，不能继续只用 `dispatch:<terminal>`；它是 A 的布局键，不能兼任 B 的复核键。
- 不复用 `external`：跨业务外援与跨电脑执行可以同时成立，两个徽标应能共存。

### 前端合并和去重

在 `web/src/features/workbench/index.tsx:123-147` 附近抽一个纯函数：

1. 抽 Workbench 和左栏 Rail 共用的纯函数，输入各机器 `topology/tasks` 和远程镜像；Rail 目前独立构树（`rail.tsx:97-117`），不能只改画布。
2. 在 A 组按 `origin.parentNodeId` 合成远程 Worker，实时状态用 `(B, remoteDispatchId)` 精确匹配；执行端查询由镜像的 `execution.machineId` 派生，业务页只显示一台、fleet 排除离线机器时也不能因此停止查询 B 或删除卡片。
3. 全局图里若该远程卡已挂在 A 下，就从 B 的展示副本中去重；单独切到 B 时仍显示 B 的执行端卡，并用真实 dispatch join `dispatchedBy`，显示来源机器和派单方 label。
4. 去重后清理没有剩余子节点的“未归项目”和空 unregistered 根，但保留正式业务、CEO、项目和 Leader 空位。
5. B 离线时不清空 A 的镜像卡，按 `Machine.status` 显示离线及最后已知状态，在线计数不得沿用旧 `liveness:'live'`；离线卡能看最后汇报，发送、终端、复核、关闭禁用或明确报离线。
6. 所有键都使用 `(machineId, dispatchId)` 或 `(machineId, terminal)`，裸 handle / 裸任务 id 不当全局唯一键。

电脑节点继续由 `topology-seats.ts` 合成，不需要新增后端 `kind:'computer'`。平台图标可复用机器页 `win32 ? Monitor : Laptop` 的现有做法（`features/machines/machine-card.tsx:46-48`）。

### 虚线和卡片作用域

- 当前 `topology-layout.ts:145-223` 把所有线合并为一个 `layout.path`，`topology-canvas.tsx:258-273` 也只画一条实线 SVG path。要满足“跨机线虚线”，布局需分别输出本地 / 远程线段，远程 path 使用现有 wire 颜色加虚线；仅给卡片加 `border-dashed` 不够。
- 卡片可复用外援的虚线视觉，但文案应是独立的“Windows-B · 远程执行”和“来自 Mac-A · Claude Code”。所有新增界面文案包 `tr('中文原文')`，并在 `web/src/lib/i18n-en.ts` 补英文；颜色和字阶沿用现有 token。
- 当前整列包在一个 `MachineScope`（`topology-canvas.tsx:118-127`）。远程嫁接卡虽然画在 A 列，其状态和操作必须按 `execution.machineId` 另嵌 B 的 `MachineScope`，不能继承 A 列的作用域。

涉及文件：`shared/api.ts`、`orchestration.mjs`、`workbench/index.tsx`、`topology-canvas.tsx`、`topology-layout.ts`、`topology-seats.ts`、i18n 文件及拓扑投影测试。

## 草案第 3 条：Mac 卡片上的控制

**判断：传输层复用，主要改前端路由和作用域。**

- 对话、整屏、输入、中断、关闭已有带机器作用域的 HTTP 封装（`web/src/lib/hiveward-live.ts:42-174`）。
- 真终端 WebSocket 已识别 `/api/m/<机器>/…/stream` 并双向转发帧和键盘输入（`terminal-websocket.mjs:51-58,113-168`）。无需再发明一套“远程终端协议”，也不必把终端字节先持久化到 Mac。
- 打开远程卡时，`onOpen` 必须使用节点的 `execution.machineId`，而不是当前列 `g.id`（`topology-canvas.tsx:118-125`；`workbench/index.tsx:405-420`）。

现有通用会话入口还有五个必须一起修的作用域问题：

1. 会话查找必须是两阶段：URL 使用稳定的镜像 id，例如 `session=<mirror.id>&from=<A>`；先读 A 的镜像恢复来源标题和 `execution={machineId:B,dispatchId}`，再用它查 B 的 task / terminals。不能让 B 按 A 的合成节点 id 查 topology，也不能把 Mac 的 `businessId` 传给 B（`session-view.tsx:30-58,105-118`）。
2. 新增 search 字段要同步修改 `session-view.tsx:15-16`、`routes/_authenticated/index.tsx:5-18`、`routes/_authenticated/b/$businessId.tsx:5-36`，否则路由 schema 会丢弃它们。
3. `use-focused-session.ts:16-29` 必须消费同一份两阶段结果，按 execution 查 B 任务，不能在 B topology 找 A 的合成节点。标题和“Mac 业务 / 项目 / Leader”上下文来自 A 的镜像 / overview，终端和汇报来自 B；`use-seat-title.ts`、`agent-pane.tsx` 不应拿 A 的 businessId 去 B 重建来源关系。
4. `open-session.ts:10-30` 目前读了机器却没有把 `m` 写入 URL，应补齐；Rail 的链接、递归和选中判断也要优先使用 `n.execution.machineId`（`rail.tsx:60-63,649-653,685-690`），否则左栏会把远程卡打开成 A 会话。
5. 若集团任务列表也允许复核，`task-feed.tsx:85-93,233` 和 `review-bar.tsx:39-43` 必须按**执行机器**包 scope；执行机器来自查询来源或显式 execution，不能误用 `dispatchedBy.machineId`（那是派单方 A）。首版可以只承诺“从拓扑远程卡进入后复核”，但不能留下一个会打到本机的复核按钮。

复核成功后是否关闭 Worker 继续由 B 的现有座位规则决定；Mac 只更新镜像，不自行再关一次。远程 read / tell / stop / close / review 的错误应保留 B 的状态码和业务错误，不统一包装成“离线”；这不只涉及传输层，`hiveward-api.ts:60-63` 和 `hiveward-live.ts:30-36` 当前只抛 message，也需保留 `status/code`。

## 草案第 4 条：通知回程和自动路由

**判断：应改成“执行端可靠推送 → 派单方本机持久收件箱”，不是远程轮询 inbox。**

### 新的通知契约

B 的 `agent-wake.offerReview()` 看到 `dispatch.by.machineId !== B` 时，走组织通道向 A 投递，例如：

```text
POST A /api/remote-wakes
{
  deliveryId,                // 任务 + 轮次 + reportId；A 再按认证来源机器建命名空间
  taskId,
  revision,                  // B 对该 root 单调递增
  reviewRound,
  reportId,                  // 优先 transcript 消息 id；否则用汇报内容摘要，不只用时间戳
  title,
  businessName?, projectName?,
  recipient: { kind, id },   // A 上的原 session / terminal
  report?,                   // 供 A 更新最后已知镜像
  worker: { terminal }
}
```

安全与可靠性：

- A 从已认证 TLS peer 得到 `taskMachineId=B`，**忽略请求体自报的来源机器**。消息和本地去重键都以 `(taskMachineId, taskId)` 开头，不能靠裸 `dsp_ id` 或裸 `deliveryId` 跨机器去重。
- A 必须找到 `(peer.id=B, taskId)` 的本地镜像，并核对 `recipient` 与镜像的原派单方一致，才能写入；否则拒绝，避免组织内任意机器向任意本机会话塞复核消息。
- A 先原子持久化消息和镜像快照，再返回 200；相同 `(taskMachineId, deliveryId)` 重投只返回已有结果，不重复唤醒。镜像只接受更高 `revision`，迟到的 awaiting 不能回滚已 accepted / 新 rework；B 的 accept / rework 也通过同通道发状态更新或取消未消费唤醒。
- 当前 `reportKey` 只看 `reportedAt` 时会漏掉同时间戳的新内容（`agent-wake.mjs:90-93`；`dispatches.mjs:323-327`）。远程协议采用稳定的 `reportId`，本机通知也一并修正。
- B 收到 200 才标为 sent；A 离线或响应丢失时，B 保留持久队列并重试。解除组织成员后通道自然失效，任务仍留在 B 待复核，不能静默变成已通知。
- A 收到后放入现有本机 `agent-wake`：session 由本机 `hiwd inbox` 收，terminal 由本机 `terminal.send` 收。不要开放 `/api/m/B/inbox/wait`，也不要让 A 长轮询 B。
- 现有 `dropStale()` 只在 A 的本地 `dispatches.json` 查 task id，找不到就删（`agent-wake.mjs:135-150,199-206,340-346`）。必须改成按 `(taskMachineId, taskId)` 查远程镜像 / 最新远程状态，否则远程唤醒会在投递前被误删；accepted、rework 或新 report 到达时按 revision 撤销旧排队消息。

实现上给 `createAgentWakeService()` 注入一个基于现有 LAN member 通道的 `deliverRemote`，扩展其持久 recipient / delivery 状态和定时 flush；新增路由只允许认证 LAN 调用。`formatWakeMessages()` 增加“来自 Windows-B”和机器上下文（`agent-wake.mjs:47-61`）。

### `review / read / tell` 免手写 `--on`

在 `hiwd.mjs` 进入现有本机查询前增加本机镜像路由：

- 显式 `--on` 永远优先；
- `read/review <dsp_id>` 找到唯一镜像时，自动复用现有机器选择逻辑；本机和远程同 id 或多个镜像同时命中则报歧义，不能猜；
- `tell <handle>` 只有在本机没有精确终端且镜像唯一时才自动路由，否则要求显式 `--on`；
- 通知里展示机器名。自动路由落地后，通知命令可不写 `--on`；在这之前必须生成 `read/review … --on B`，否则一定找错机器。

涉及文件：`agent-wake.mjs`、`hiveward-bridge.mjs`、`lan.mjs` / 现有 member request、`remote-dispatches.mjs`、`hiwd.mjs`、`shared/api.ts` 和双实例测试。

## 草案第 5 条：跨电脑复核权限

**判断：可以放行，但必须同时改源端代理、执行端授权和派单来源字段；只改任何一处都不安全。**

### 推荐授权链路

A 上的 Agent 发起 `review <B任务id>` 时：

1. A 的本地路由按镜像找到 B；显式 `--on B` 也必须经过同样的 Agent 授权。
2. A 的 `/api/m/B/tasks/<id>/review` 入口读取本机 caller 头，要求镜像存在、`mirror.machineId === B`、`mirror.dispatcher.id === caller.id`。
3. 校验通过后，A 的 bridge 才为这一次转发附加 Agent caller 头；不要全局转发任意自定义身份头。
4. B 的 TLS 入口照常认证 peer，并把 `peer.id` 传入业务层。当前业务路由只收到 `{isLan}`（`hiveward-bridge.mjs:482,516-517`），需增加认证 peer 的机器 id。
5. B 的 `reviewTask()` 对远程 Agent 同时要求：
   - `peer.id === dispatch.by.machineId`；
   - `caller.id === dispatch.by.id`；
   - `caller.kind === 'agent'`，不能落入 owner 默认分支；
   - `dispatch.review.reviewer === 'dispatcher'`；
   - 任务仍为现有可复核状态，保留 `awaiting`、进行中拒绝和并发锁。
6. 对 remote-origin 派单，B 本机 Agent 也不能只凭相同 id 复核；没有认证 peer 且来源机器不是 B 时应 403。否则“同 id 的 B 本地 Agent”会绕过原派单方边界。
7. owner 通道独立保留，老板从 A 的网页可 accept / rework 任何待复核任务。复核审计中的 `Task.review.by`、`WorkRecord.reviewedBy` 增加 `machineId`，`dispatchedBy` 也保留来源机器，避免不同机器的同 id 无法区分。

这里的“身份核实”应写清楚边界：**TLS + 配对令牌核实的是来源机器；Agent / session id 沿用源机现有 caller 模型。** 它不是防止同源操作系统用户伪造环境变量的密码学 Agent 身份。如果未来要求 Agent 级不可伪造，应再加绑定 `taskId + dispatcherId + originMachineId` 的单任务 review capability；不能把普通 HTTP 头宣称为这种保证。

### 明确禁止的改法

- 不能只删 `lan.mjs` 的 403：转发层当前剥头，B 会把请求视为 owner。
- 不能只删 `task-review.mjs` 的 remote guard：源端仍会挡，且没有统一语义。
- 不能原样转发 `x-hiveward-dispatcher-id` 后只比较 id：这会允许同 id 冒充，也没有验证任务是否真由它派出。
- 不能信任请求 JSON 中的 `originMachineId`：必须以认证 peer 为准，并禁止多跳转发。

涉及文件：`lan.mjs`、`hiveward-bridge.mjs`、`business-routes.mjs`、`task-review.mjs`、`dispatches.mjs`、`remote-dispatches.mjs`、`shared/api.ts` 及安全矩阵测试。

## 草案第 6 条：文件交付

**判断：保留“Worker 主动 push 到派单方文件收件箱”的方向；先修默认 put，再补任务附件元数据。Mac 的 `open` 只打开已经落在 Mac 上的路径。**

### 最小可用闭环

1. 在 `lan.mjs` 只对 `/api/files/write` 转发 `x-hiveward-filename`，目标端继续使用现有 decode 和 basename 校验；不要因此放开所有自定义身份头。
2. B 在远程派单上下文中告诉 Worker 来源机器。Worker 先执行 `hiwd files put <成品> --task <B的派单id>`（另可提供 `--for-current-task`，按 B 的 `HIVEWARD_TERMINAL_HANDLE` 解析当前 root），CLI 自动路由到来源 A，不要求老板手写 `--on`。当前 `new` 先发送首句、后登记派单（`hiwd.mjs:907-917`），所以不能假设首句已经能带 task id；交付时用 `--for-current-task` 或先查当前任务。
3. `--task` 由 CLI 变成专用、受校验的 `x-hiveward-task-id`；A 成功写入并绑定后把真实路径 / hash 存在 **A 自己的镜像**。B 不需要知道 A 的路径，唤醒也只传任务和汇报；A 收到唤醒时关联镜像里已经存在的 attachments。
4. A 的 Agent / 老板看到 A 本地路径后再 `open`。绝不拿 B 的 Windows 路径直接在 Mac 打开，也不为“打开”发明远程 shell 命令。
5. 文件 put 本身仍不产生 Agent 消息；界面只在 A 已成功持久化并绑定后显示附件。通知顺序是“A 返回写入和绑定成功 → Worker 汇报 → B 推送复核唤醒”，Worker 不能只凭计划顺序就宣称已交付。

### 建议同阶段补的附件契约

给远程文件写入增加上述可选任务绑定。A 用认证 peer + task id 找到镜像，并在镜像中保存：

```text
attachments: [{
  name,
  path,                    // 必须是 A 实际写入的收件箱路径
  size,
  sha256?,
  receivedAt
}]
```

这样 Mac 卡片能显示并打开真实交付物，不必从自然语言汇报里猜路径。无镜像、机器不匹配或路径不在 A 收件箱时都拒绝绑定。默认同名冲突仍返回 409，不自动覆盖；Worker 应使用任务 id / 汇报轮次构造唯一文件名。当前只支持单文件、上限 2 GiB，目录 / 多文件交付需要显式多次 put 或后续单独设计，不在本单暗含承诺。

现有 `files.test.mjs:82-93` 的代理 fixture 几乎转发所有请求头，会掩盖生产 `lan.forward()` 丢掉 `x-hiveward-filename` 的问题。回归测试必须使用真实 header whitelist 或真实双 bridge，不能以这个全头转发替身作为修复证据。

涉及文件：`lan.mjs`、`files-cli.mjs`、`files.mjs`、`remote-dispatches.mjs`、`agent-wake.mjs`、`shared/api.ts` 和文件安全测试。

## 架构图文字示意

集团首页（A 为当前派单方）：

```text
[电脑：Mac-A]                                  [电脑：Windows-B]
     │                                               │
     └─ 业务：内容业务                                └─ Windows 本地业务 / 项目
            │                                               │
            └─ CEO / Leader：Claude Code                      └─ 本机下属 …
                   │
                   ├──── 本机 Worker                         （全局图中不重复画
                   │                                            被 A 嫁接的 Worker）
                   │
                   ┄┄┄┄ Worker：Claude Code                 ← 跨机虚线
                        [Windows-B · 远程执行]
                        [完成 · 待复核]
                        execution={machineId:B,
                                   dispatchId:dsp_fdc54e51}
```

单独切到 Windows-B 的执行端图：

```text
[电脑：Windows-B]
     └─ B-project / 未归项目
            └─ Worker：Claude Code
               [来自 Mac-A · Claude Code]
               dispatcherMachineId=A
```

Windows 离线时，A 仍根据镜像画：

```text
CEO / Leader：Claude Code
     ┄┄┄┄ Worker：Claude Code
          [Windows-B · 离线]
          [最后状态：完成 · 待复核]
```

“外援”继续表示跨业务原属关系；“远程执行”表示执行机器。一个 Worker 若同时满足两者，应同时显示两个独立标记。

## 分步实施与验收

### 第 1 步：来源身份、镜像和远程目录修正

改动：执行端派单写入可信 `by.machineId`；新增 Mac 镜像；`new/tell` 登记后 upsert；修 Windows 路径和首句指引。

验收：

- 双隔离实例 A → B `new/tell` 后，B 的派单含 `by.machineId=A`，A 只有镜像、没有本机 Worker 派单；重启 A 后镜像仍在。
- 镜像写入失败有可见错误且可补建；B 离线后 A 镜像不消失；解除成员后不能继续写。
- `C:\work\demo` 不再被 Mac 当成本地路径；目标不存在时由 B 返回错误。已登记项目、普通 folder workspace、带空格路径均覆盖。
- 新增 `remote-dispatches.test.mjs` 和真实双 bridge 集成测试，验证 `parent/root` 不会因 tell 产生重复 Worker。

### 第 2 步：组织图嫁接和 Mac 控制

改动：按镜像合成节点、全局去重、远程虚线 / 机器徽标；修节点级 `MachineScope`、session URL 和任务来源 scope。

验收：

- A 的 CEO / Leader 下出现 B Worker；B 的全局副本去重；B 单视图显示“来自 Mac-A”。
- B 离线 / 恢复、Worker accept 后关闭、同 handle 多任务、同时是跨业务外援时都不丢卡或错挂。
- 从 A 的远程卡分别完成 read、对话、终端输入、stop、rework、accept、close；断言所有 RPC 都落在 B，A 没有同名终端误操作。
- 老板 accept 后工作记录仍在 B，A 镜像显示 accepted 和远程 record id。
- 新增纯函数拓扑测试和组件测试；渲染验收用隐藏窗口 / CDP 截图，不抢桌面焦点。

### 第 3 步：复核通知回 Mac 和命令自动路由

改动：远程 wake 专用路由、双端持久幂等队列、A 本机 inbox / terminal 投递、镜像路由。

验收：

- B 交活后，A 的原 session 执行普通 `hiwd inbox` 收到一次；B 的同 id 本地 inbox 收不到这条远程派单通知。
- 消息标出来源 B；不带 `--on` 的 `read/review` 命中正确镜像，`tell` 在本机 / 远程同名时要求消除歧义。
- A 离线时 B 排队，恢复后只投递一次；模拟“A 已保存但响应丢失”不重复唤醒；不同 B/C 上相同任务 id 互不去重。
- 远程消息经过 `takeInbox` 和终端 flush 都不会被本地 `dropStale` 误删；旧 revision 不回滚 accepted，新 report / rework 能撤销旧唤醒。
- 无镜像、recipient 不符、伪造 taskMachineId、解除成员均失败；远程 `/inbox/wait` 仍 403。

### 第 4 步：放行可信原派单方复核

改动：源端镜像授权、受控身份头转发、执行端 peer + origin 校验、审计机器 id。

验收安全矩阵：

| 调用者                                          | 预期                           |
| ----------------------------------------------- | ------------------------------ |
| A 上原派单方，accept / rework 自己派到 B 的任务 | 200，状态和工作记录只在 B 改写 |
| A 上另一个 Agent                                | 403                            |
| 另一台已配对 C 上的 Agent                       | 403                            |
| B 本机使用相同 session id 的 Agent              | 403                            |
| 没有 `by.machineId` 的旧远程派单                | Agent 403，老板仍可复核        |
| A / B 网页老板通道                              | 200                            |
| 非 awaiting、并发复核、已接受重复请求           | 沿用现有 409 语义              |

另验证日志和 API 不泄露配对令牌，直接 LAN 请求不能靠自报来源机器绕过。

### 第 5 步：交付文件进入 Mac 收件箱

改动：修默认 filename 转发，补任务附件绑定和卡片打开入口。

验收：

- B 默认 `files put <文件> --on A` 成功；`files put <文件> --task <id>` / `--for-current-task` 自动路由到 A。A 的实际收件箱内容和 hash 与源文件一致，镜像附件指向 A 路径。
- 默认 put 回归必须走真实双 bridge 或生产 header whitelist，现有全头转发 fixture 不算通过证据。
- 路径遍历、UNC / ADS、隐藏 / 系统目录、软链 / junction、超限、同名覆盖继续按现有策略拒绝。
- 文件未持久化成功时不发“已交付”通知；复核通知到达后 A 能打开附件，B 原路径不会被拿去在 A 执行。
- 真实 Windows → macOS 至少跑一次上述链路；本机双 macOS 进程测试不能替代这一项。

## 每步通用检查

按实际改动范围运行：

```bash
export PATH="$HOME/hiveward/.hiveward-tools/node_modules/.bin:$PATH"

cd ~/hiveward/hiveward/web
npx prettier --write src
npx tsc -b
npx eslint src --quiet

cd ~/hiveward
node_modules/.bin/oxfmt <改过的 .mjs>
TMPDIR=/tmp HIVEWARD_BACKGROUND_LAUNCH=1 node --experimental-vm-modules --test hiveward/server/<相关>.test.mjs
HIVEWARD_BACKGROUND_LAUNCH=1 pnpm check:code-quality:changed HEAD
```

测试只用 `/tmp`、动态端口和假 Agent，不访问真实模型或外部域名，不读取 / 修改真实 `HiveWard` 数据，不操作正在运行的 47615 实例。

## 暂不做 / 尚未验证

- 不把执行端派单、工作记录双写成两台各自的权威副本；Mac 只做可重建投影。
- 不开放远程长轮询 inbox，不允许多跳 `/api/m`，不把配对机器认证夸大为密码学 Agent 身份认证。
- 第一期不扩展拓扑「+」为跨机创建；若要做，必须另选执行端业务 / 项目 / 目录。
- 本轮未做真实 Windows、真实模型、WebSocket 手工截屏或桌面打开文件验收；对应已有代码 / 测试不能替代最终跨 OS 验收。
- 现有 `agent-wake/dispatches/task-review` 只实现本机复核状态闭环，不实现上述任何跨机闭环；实施时需基于届时工作树重新核对行号与测试。
