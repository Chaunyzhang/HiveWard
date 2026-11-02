# OPC

一人公司（OPC）的老板驾驶舱：每个业务由一个负责人 agent 带队，负责人通过 [Orca](https://github.com/stablyai/orca) 编排下属多智能体干活；这个后台负责开业务、派负责人、下目标、看进度、拍板。

- 设计：[docs/OPC-DESIGN.md](docs/OPC-DESIGN.md)
- 前后端接口契约：[shared/api.ts](shared/api.ts)
- 前端：[web/](web/)（基于 shadcn-admin，React 19 + Vite + TanStack）

## 桌面 App（推荐）

OPC 是一个 Electron 桌面 App：主进程里自带桥接服务（8787），窗口里有真浏览器。

```bash
cd desktop && pnpm install
pnpm dev      # 开发：窗口加载 vite（先在另一个终端 pnpm --dir web dev），改网页即时生效
pnpm start    # 使用：先打包网页，再由 App 自己托管
```

起 App 前先关掉单独跑的 `node server/orca-bridge.mjs`（端口会冲突）。

**浏览器**：侧栏「浏览器」。每个业务一份登录（档案），第一次登录你手动来，之后一直保持。
派出去的 Agent 用 `hiwd browser …` 操作同一批页面（见 [docs/agent-browser.md](docs/agent-browser.md)），
点开 Agent 的控制台有「浏览器」一档，看着它点。发布 / 提交 / 保存 / 删除 / 支付 / 发送这类操作工具层面直接拦下，
Agent 写【需要确认】停下，问题带截图进「待办」；你答复后它拿一次性确认码才能执行。

## 多台电脑（局域网互联）

每台 Mac 都装 OPC App，彼此平等，配对一次双向打通：

1. 在电脑 A 的 OPC →「电脑」点「生成配对码」；
2. 在电脑 B 的 OPC →「电脑」→ 附近的电脑里选中 A（发现不了就「手动输入地址」填 A 的 IP），输入配对码；
3. 之后顶栏会出现电脑切换器，切到哪台，整个驾驶舱（架构、任务、待办、现场、浏览器）看的就是哪台。

命令行：`hiwd machines` 列出电脑；任何子命令加 `--on <电脑名>` 就在那台上执行，比如 `hiwd new 玉石 codex "…" --on 工作室`。

- 本机接口 `127.0.0.1:8787` 只接受本机 OPC 页面和 hiwd 命令；其他电脑走 `:8788`，必须带配对时交换的令牌。
- 第一次打开时 macOS 可能问「是否允许 OPC 接受传入的网络连接」，选允许。
- 别的电脑上的浏览器只能看实时截图（真浏览器窗口在那台电脑的屏幕上），地址栏、前进后退、关标签照常可用。

## 前端开发

```bash
cd web
pnpm install
pnpm dev          # http://localhost:5180，默认读真实数据（先起 node server/orca-bridge.mjs）
```

`/api` 会代理到 `http://127.0.0.1:8787`。只想看界面效果：`VITE_API_MOCK=true pnpm dev` 用 src/mocks 的模拟数据。业务登记存在 `data/businesses.json`（不进 git）。

## 现场（直连 Orca）

「现场」页直接读写本机 Orca 的终端：看每个 Agent 的实时画面、往里打字、新开 Agent。

```bash
# 前提：Orca 应用已打开（或 orca serve 在跑）；项目已在 Orca 里登记（orca repo add --path <dir>）
node server/orca-bridge.mjs     # 本机 127.0.0.1:8787，网页的 /api 代理到这里
pnpm --dir web dev              # http://localhost:5180/live
```

画面是每秒读一次整屏（`terminal.read --screen`）；原因见 `docs/OPC-DESIGN.md` §9.1。

## 云端派单入口（Grok Bot → hiwd 命令）

Grok Bot 通过 Local Tools 在这台 Mac 上跑 `node ~/opc/server/hiwd.mjs …`，经桥接服务去看、去派本机的 Agent。本地你也可以直接用 Claude Code，不经过 Grok。

```bash
node server/hiwd.mjs agents                         # 有哪些终端 / Agent
node server/hiwd.mjs read codex -n 20               # 看它最近的对话
node server/hiwd.mjs tell codex "改完跑一遍测试"      # 对它说话
node server/hiwd.mjs new opc claude "把 X 做了，需要时派 codex/kimi"   # 新开一个负责人并派活
node server/hiwd.mjs stop codex                     # 中断
node server/hiwd.mjs status                         # 全局一屏：每块业务的总 Agent、任务、待决定
node server/hiwd.mjs tasks [opc] [--open] [-n 20]   # 任务列表，新的在前；只看没完成的加 --open
node server/hiwd.mjs task dsp_xxxx                  # 一个任务的全部：派单、补充、汇报
node server/hiwd.mjs decisions                      # 要老板决定的事（列选项、标推荐）
node server/hiwd.mjs decide dsp_xxxx "选 B"          # 替老板答复；和选项一字不差就算选该项
node server/hiwd.mjs assign opc "把 X 做了"          # 把活派给这块业务的总 Agent（老板卡同款）
```

`<agent>` 可以写 handle，也可以写标题 / 项目名里的一段字。`<业务>` 可以写业务名、业务 id 或项目目录名（不区分大小写，唯一前缀即可），`hiwd tasks` / `hiwd assign` 都用它来定位那一行。桥接服务地址可用 `OPC_BRIDGE` 覆盖。

每次 `hiwd new` / `hiwd tell` / `hiwd assign` 都会登记成一条任务（存 `data/dispatches.json`），记下是谁派的：在 Claude 桌面端会话里跑的记为「Claude 桌面端」，Grok Bot（xAI 的桌面 App）调用时自动认出来（看进程链里有没有 `Grok Bot.app`），按派活的目录归到业务；想固定绑到某块业务就设 `OPC_DISPATCHER=grok:<业务id>`（比如玉石的是 `grok:shop`）。给 Grok Bot 的使用说明在 [docs/grok-bot.md](docs/grok-bot.md)，整段贴给它就行。任务状态从 Agent 的对话记录自动推出（干活中 → 进行中，回话并停下 → 已汇报，最后一段话就是汇报），在工作台的架构图和任务列表里都能看到。

架构图是一张可拖动、可缩放的画布（按住空白处拖动，触控板左右滑动平移，捏合或 ⌘+滚轮缩放）：最上面是电脑（局域网里配对过、在线的电脑并排在一起，每台一列，任务和待办也合在一起、标明来自哪台），下面每块业务一行——**老板卡**（写着业务名，可以直接在上面给总 Agent 派任务）一条直线连到这块业务的**总 Agent**（Mac 上通常是 Claude Code），总 Agent 后面挂它的下属；这块业务的 **Grok Bot** 像并联的灯泡从这条直线上分出去再接回来，最近 30 分钟派过活就亮着。总 Agent 依次取：登记的负责人 → 老板卡（或 `hiwd assign`）开出来的 Agent → 在业务目录里派过活的 Claude Code 会话；都没有时，在老板卡上派第一个任务会自动开一个 Claude Code 当总 Agent。不属于任何业务的项目（比如 `~/opc`）也是一行，没有 Grok。
