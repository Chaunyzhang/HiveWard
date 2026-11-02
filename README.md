<h1 align="center">HiveWard</h1>

<p align="center">
  <strong>一个人的公司，一群 Agent 打工。</strong><br/>
  调度 Claude Code、Codex、Kimi 的 Agent 工作台：业务、项目、Leader Agent、下属，一张图看清谁在干什么。
</p>

---

## 它是什么

HiveWard 是给「一人公司」老板用的桌面驾驶舱。你登记几块**业务**（就是几个文件夹：视频、电商、某个 App……），每块业务下面分几个**项目**，每个项目由一个 **Leader Agent** 带，Leader Agent 再派下属干活。你在 HiveWard 里看进度、回答待办、直接跟任何一个 Agent 说话。

- **Agent 架构图**：电脑 → 业务 → 项目 → Leader Agent → 下属。每个 Agent 用颜色标出五种状态：干活蓝、完成绿、故障红、等待橙黄、空闲灰。
- **原生终端里的 Agent**：每个 Agent 都跑在真终端里，可以切成「对话」看，也可以切成「终端」直接操作。在输入栏按 Esc 或点停止键就能打断它。
- **业务与项目**：
  - 业务就是登记的文件夹，自动认出项目自己的名字和 logo。
  - 项目由老板自己分，不套模板，可以指定子目录。比如视频一个选题一个项目，App 分「运营」「构建」。
- **待办与汇报**：Agent 需要你决定的事集中在待办里；下属干完活的汇报自动回填到任务上。
- **时间线**：派活、汇报、待办、开关终端、项目变动都记下来，按业务、项目筛。
- **局域网组织**：同一局域网里打开 HiveWard 的电脑会自动出现，点「加入组织」，对方屏幕上同意后两台就配对好了。之后在任意一台都能看、能控制另一台的 Agent。
- **出口地区安全底线**：Claude Code、Codex 只在出口地区合规的电脑上启动，测不出出口时也不开。
- **`opc` 命令行**：Agent 自己也能用它开下属、派活、看进度、操作内嵌浏览器、跨电脑执行（`--on <电脑>`）。
- **内嵌浏览器**：Agent 能在 HiveWard 里的真浏览器上操作网页。发布、提交这类不可撤回的动作要老板给确认码。

正在做：Windows 版、局域网通道加密、跨电脑文件访问、跨电脑剪贴板。

## 现状

- 目前只在 macOS（Apple Silicon）上打包和日常使用。
- 这是早期版本，接口和数据格式还会变。
- 本仓库之前的旧版本已经封存在 [`legacy`](../../tree/legacy) 分支，旧的发布标签保留不动。

## 从源码构建

需要 Node.js 和 pnpm。

```bash
pnpm install
(cd opc/web && pnpm install && pnpm build)
pnpm build
pnpm exec electron-builder --config config/electron-builder.config.cjs --mac --arm64 --dir --publish never
```

开发模式：

```bash
pnpm dev
```

## 目录

| 目录                      | 内容                                                                         |
| ------------------------- | ---------------------------------------------------------------------------- |
| `opc/web`                 | HiveWard 的界面（React + Vite），唯一的界面                                  |
| `opc/server`              | HiveWard 后台：业务 / 项目、派单、时间线、局域网组织、出口地区、`opc` 命令行 |
| `opc/shared/api.ts`       | 前后端接口约定                                                               |
| `opc/desktop`             | 桌面端胶水：内嵌浏览器、窗口截图、引擎接入                                   |
| `src/main/opc`            | 主进程里 HiveWard 自己的部分：菜单、通知、出口地区环境、终端流               |
| 其余 `src/`、`config/` 等 | 来自 Orca 的执行层，见下文                                                   |

## 基于 Orca

HiveWard 基于开源项目 [Orca](https://github.com/stablyai/orca)（MIT 许可，Copyright (c) 2026 Lovecast Inc.）改写。Orca 原来的界面已经从源码里删掉，HiveWard 只把它当作底下的执行层。

**来自 Orca，基本保留或小改的部分：**

- Electron 桌面外壳和主进程框架：窗口、单实例、托盘、自动更新、打包和签名配置（`src/main`、`config/`）。
- 终端引擎：PTY 守护进程、终端会话和句柄、终端输出流、xterm 及其补丁。我们修过句柄稳定性，也去掉了空 shell。
- 运行时 RPC、仓库和 worktree 管理、编排（任务 / 派发 / worker）。HiveWard 的后台通过它们开终端、读画面、派活。
- Agent 启动与识别：识别终端里跑的是 Claude Code / Codex 等，读它们的状态。
- 内嵌浏览器和浏览器扩展支持（`src/browser-preload` 等）。
- `mobile/`、`cloud/`、`native/`、`docs/site/` 等目录原样来自 Orca，HiveWard 目前没有使用或改写。

**HiveWard 自己写的部分：**

- 全部界面（`opc/web`）。Orca 的渲染界面和 preload 已从源码删除，不做兼容。
- 后台（`opc/server`）：
  - 业务 → 项目 → Leader Agent 的组织模型、派单记录和汇报回填；
  - 架构图数据、时间线、项目识别（名字和 logo）；
  - 局域网发现与组织加入、出口地区检测与拦截；
  - `opc` 命令行。
- 主进程里的 HiveWard 部分（`src/main/opc`）：中文菜单、系统通知、邀请确认、出口地区环境探测。
- HiveWard 品牌、图标和打包产物名。

Orca 的 MIT 许可和版权声明保留在 [LICENSE](LICENSE) 里。

## 许可

MIT，见 [LICENSE](LICENSE)。
