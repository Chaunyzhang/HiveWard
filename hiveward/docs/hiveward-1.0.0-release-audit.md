# HiveWard 1.0.0 断开供应商服务与更新施工报告

审计与施工日期：2026-11-03 至 2026-11-04。分支：`hiveward`。本表按老板审阅后的决定更新为实际结果。大索引已移到 `/tmp/hiveward-1.0.0-audit-index.tsv`，不进入仓库。`mobile/`、`cloud/` 本轮未修改。

## 当前结论

桌面源码中的 Orca / Stably 远程服务、启动任务和入口已按下表删除，更新源固定为 `Chaunyzhang/HiveWard` 正式 Releases。保留 `hiveward-policy` 网址拦截作为补充防线。

**按当前源码，HiveWard 启动和日常使用不应主动连接任何 Orca / Stably 地址。** 没有对已安装 App 做流量验收：本单禁止构建、安装、启动或退出真实 App，已安装的旧包也不会因源码修改自动改变。最终验证使用 mock、本地服务和 `/tmp`，清除实例定位环境并增加真实端口 / 资料目录防护。早期测试隔离事故见下文。

## 逐项实际结果

“源码位置”同时包含已删除文件的原位置，便于对照 `git diff`，不表示它们仍存在。

| 项目 | 原来连哪 / 原行为 | 实际结果 | 源码位置 |
| --- | --- | --- | --- |
| 正式版更新 | GitHub `stablyai/orca` | **已换**：只认 `Chaunyzhang/HiveWard` 的正式版本，拒绝 draft、prerelease，semver 必须更高 | `config/electron-builder.config.cjs`、`config/dev-app-update.yml`、`src/main/updater.ts`、`src/main/updater/hiveward-release.ts` |
| 多渠道更新 / 指定旧构建 | Orca hourly、daily、adhoc、perf 等入口 | **已删**渠道选择、旧构建入口、回退逻辑、相应 IPC / RPC / 设置与测试 | 原 `src/main/updater-*`、`src/main/updater/*`、`src/shared/release-channel.ts` |
| 更新说明 | `onorca.dev/changelog`、`whats-new/changelog.json` | **已换**为当前 HiveWard Release 的正文和链接 | `hiveward-release.ts`、设置 `update-row.tsx` |
| 云端更新催促 | `onorca.dev/whats-new/nudge.json` | **已删**远程活动、定时任务和状态字段 | 原 updater nudge 模块 |
| PostHog | `us.i.posthog.com` | **已删**SDK、初始化、采集调用、专用事件注册 / schema、配置、提示入口和注入校验脚本；`package.json`、打包依赖和 lockfile 不再包含 `posthog-node` | 原 `src/main/telemetry/`；仅保留 RPC / 启动契约、本地用量和错误分类等共享定义 |
| 崩溃上传 | 自建反馈 / 诊断上传；未发现桌面 Sentry DSN | **已删**提交链路和 IPC / 入口；**留**本地崩溃日志、恢复判断和 Crashpad（无 submitURL，`uploadToServer: false`） | `src/main/crash-reporting/`、原 `src/main/ipc/crash-reporting*` |
| 反馈 / 图片 / 诊断上传 | `www.onorca.dev/v1/feedback`、注入的诊断 token 地址 | **已删**提交、附件、上传凭证、IPC、构建注入及相关发布 workflow | 原 `src/main/ipc/feedback*`、observability 上传模块、`electron.vite.config.ts` |
| Stably 登录 | `login.onorca.dev` | **已删**OAuth / refresh / session / profile 云实现；**留**本地资料和用户自己的 Agent 登录 | 原 `src/main/orca-profiles/profile-cloud-*` |
| 云中继 | `relay.onorca.dev` 和 cell 地址 | **已删**桌面供应商中继与登录依赖；**留**本机、局域网配对和用户选择的远程主机 | 原 `src/main/runtime/mobile-cloud-relay/`、pairing RPC |
| 云连接器 | `connector.onorca.dev` | **已删**客户端、启动接线、RPC 与 CLI 入口；**留**本地 MCP | 原 `src/main/connector-cloud/`、runtime connector 方法 |
| 云推送 | `push.onorca.dev` | **已删**注册 / 发送服务、启动任务、空适配器、RPC；**留**本地通知、局域网通知事件和在线状态 | 原 `src/main/runtime/push/`；`runtime-mobile-notification-controller.ts`、notifications RPC |
| 云分享 / 深链 | `share.onorca.dev`、`app.orca.dev`、`orca://` 分享 | **已删**供应商上传、导入与深链捕获，分享 CLI / RPC；**留**本地 artifact 和系统文件打开 | 原 `artifact-cloud-*`、skill-share、publisher intent、startup open-url |
| 插件安全名单 / 安装计数 | `onorca.dev/plugins/kill-list.json`、`stats.json` | **已删**远程获取、计数、定时刷新与服务；**留**本地审核 / 权限判断 | 原 plugin catalog 远程服务，`main-process-plugins.ts` |
| 插件市场 / 自动种子 | `stablyai/orca-plugins`、community plugins、multipass recipes | **已删**内置供应商市场、自动种子、远程更新、市场 IPC 与深链；**留**随包插件和本地目录运行 | 原 marketplace、catalog-service、auto-updater、community seed |
| 技能安装 | `stablyai/orca` | **已换**为 HiveWard 仓库和当前构建 commit 的技能内容 | `src/shared/agent-feature-install-commands.ts` |
| 插件 schema / 模板帮助 | raw GitHub Stably 仓库 / 旧作者文档 | **已换**schema 到 HiveWard 的 `hiveward` 分支下真实 `docs/schemas/plugins/` 路径；模板中不存在的作者文档链接**已删**；示例使用本仓真实 `examples/plugins/` | `plugin-json-schema.ts`、`plugin-template-files.ts`、`bundled-skill-guides.ts` |
| Agent 状态规则热更新 | Release 专用 tag 下的规则文件 | **已删**远程获取、缓存覆盖和启动 / 定时任务；**留**随包规则和用户明确指定的本地规则 | 原 `agent-state-rules-live-update.ts`、desktop / orcad 启动 |
| WSL 策略热更新 | `wsl-hosts-policy-stable/next` | **已删**远程策略、缓存覆盖及任务；**留**本地 WSL 检查、迁移、安全限制，不再使用旧云缓存控制功能 | 原 `wsl-hosts-policy-live-update.ts`、WSL startup |
| 求 star | GitHub `stablyai/orca` | **已删**求 star、查询、设置和接口 | 原 `src/main/star-nag/`、GitHub orca-star |
| 旧文档 / 功能宣传 | `www.onorca.dev/docs/...` | **已删**宣传内容、资源、下载脚本和入口；兼容序列化的内部类型仍留 | 原 feature-wall tiles、workflows 内容、`resources/onboarding/feature-wall/` |
| homepage / author / UA | Orca / Stably 信息 | **已换**HiveWard 主页、作者、Linux maintainer、链接预览 UA；**留**历史版权与许可证 | 根 `package.json`、builder、link-preview |
| 帮助菜单 / 协议 | 当前本地菜单；`hiveward-engine` 注册 | **留**本地菜单和内部 scheme；旧供应商深链**已删**，不接管 Orca 协议 | `src/main/hiveward/hiveward-menu.ts`、协议注册 |
| CLI 安装 / Windows 注册 | HiveWard CLI、本机 PATH / NSIS / WSL / hooks | **留**HiveWard 本地机制；不安装 `orca` 命令，不修改 `/usr/local/bin/orca`；Windows CLI 可见品牌**已换** | `src/main/cli/`、`config/nsis/`、`native/windows-cli-launcher/` |
| Windows Agent hook 品牌 | `native/windows-agent-hook/build.rs` 中 Stably 可见元信息 | **待并行负责人处理**：该文件已有他人修改，本单未覆盖；内部 assembly / bundle 标识按决定保留 | `native/windows-agent-hook/` |
| 活跃 CI / 发布配置 | Stably 发布仓库、旧渠道、诊断注入 | **已删 / 已换**旧供应商发布 workflow，剩余 workflow 未发现 Stably 发布目的地；发布脚本默认仓库改 HiveWard | `.github/workflows/`、`config/scripts/` |
| mobile / cloud 源码 | 独立移动与云端服务 | **留、延期**，源码按决定不动。需纠正一个打包细节：原始目录不直接装入包，但 builder 仍包含由移动端构建的 `out/mobile-web/**` 本地网页；本轮没有更改这项打包范围，也未验收移动网页的对外行为，不能把桌面主窗口结论扩大到移动端 | `mobile/`、`cloud/` |
| 开发审计工具 | 独立 `config/audit-tools` 的 react-doctor 传递依赖含 Sentry | **留**：不进入桌面依赖，执行审计时使用 `--no-telemetry`；主包没有 Sentry SDK | `config/audit-tools/pnpm-lock.yaml` |
| 测试假数据 / 历史引用 | 旧 issue、假 URL、许可证 | **留**不执行联网的历史证据与兼容样例；不是活跃服务 | 测试 fixtures、历史文档、patch 注释 |
| 本地后台 / 局域网 | loopback、mDNS、用户选择的远程电脑 | **留**，不属于供应商云 | `hiveward/server/`、desktop engine、SSH / runtime |
| 出口地区 / 用户第三方 | Cloudflare、用户配置的提供商 / 网站 | **留**，详见下表；不能声称完全离线 | exit-region probe、各第三方集成 |

## 1.0.0 版本与兼容

- 根和 `hiveward/package.json` 均为 `1.0.0`，CLI stamp、runtime metadata、握手仍读取本产品版本来源。
- SQLite App 门槛调整为 HiveWard `1.0.0`，外部产品身份拒绝；旧 `1.4.214` 作为已继承资料的回归样本。
- SSH 托管 host 激活记录增加可选产品身份和版本线；明确 Orca 记录拒绝覆盖。未标产品的旧记录必须从实际安装包核实 `HiveWard`、`app.hiveward`、`hiveward-runtime.json` 三项标记，才能作为继承版本迁移；仅凭 `1.4.214` 数字不放行。无法读取 / 核实即保留原安装，强制更新也不能绕过。新包始终标记正式 HiveWard 版本线，防止将来真正的 1.4.214 被当成继承旧版而降级。远程更新可用性复用相同准入判断。
- 不按“所有 1.4.x 都旧”判断：HiveWard 将来也可以发布 1.4.x。桌面更新只取自家仓库，旧 Orca 缓存 / 旧渠道逻辑已删除。
- 协议整数、数据库迁移编号、插件能力范围和 schema 不随 App 版本重置。

## 更新与发版实现

启动检查一次、之后每六小时检查，自动开关默认开；设置可手动检查、查看 Release 正文、下载并确认重启。GET `/api/updates` 仅读状态；动作使用 POST，局域网调用不能更新另一台电脑。确认包含版本和实际运行时中的工作 Agent 数量，去重句柄并覆盖完整终端列表；读取失败不当作零，安装前人数变化要求重新确认。

Mac 不依赖 Squirrel.Mac：本地 electron-updater 源码把 ZIP 交给原生 Squirrel，而当前包默认 ad-hoc，不能保证满足原生签名升级要求。本轮没有冒险安装两代真实包验证该失败；已实现独立替换路径。下载仅允许自家发布路径及 GitHub 资源跳转，按 `latest-mac.yml` 校验 SHA-512 / 大小 / 架构 / 版本；解压前检查路径和越界链接，之后检查产品、版本和签名。独立脚本等进程退出，同卷准备后重命名替换，系统打开命令失败时恢复旧包并留下日志；尚未做真实 App 启动健康验收。

发版顺序为目录包 → 校验原部署模板 → 签嵌套文件 → 仅同步签名影响的 Mac 原生文件哈希 → 校验模板 → 封装最终 App → ZIP → SHA-512 清单，始终 `--publish never`。JS 等非签名内容变化仍拒绝，不通过重算哈希掩盖。上传规则见 `hiveward/docs/release-1.0.0.md`。Windows 走 GitHub + 无签名 NSIS，已移除 SignPath 发布者设置；系统可能显示 SmartScreen / 未知发布者提示，需 Windows 实机验收。

## 保留的内部标识

| 类别 | 保留例子 | 理由 |
| --- | --- | --- |
| 产品资料 | `app.hiveward`、`HiveWard`、`HiveWard-Dev`、keychain `OPC Engine` | 不迁移或误删真实数据 |
| 环境变量 | `ORCA_*`、`HIVEWARD_*` | 内部兼容名；被删服务专用读取随实现删除 |
| IPC / 协议 | `hiveward-engine`、保留功能的 IPC / RPC 名、协议整数 | 不批量破坏兼容；已删功能的方法连消费者删除 |
| 模块 / 本地路径 | `orca-runtime`、`orcad`、`~/.orca/agent-hooks` | 内部标识，不联网，不删用户 hooks |
| native 身份 | `com.stablyai.orca*`、`StablyAI.*` assembly / target | 本地兼容 / TCC 边界，按决定不改 |
| 插件能力 | `engines.orca`、pluginApi、内部 publisher / bundled key | 能力版本独立于 App 版本 |
| 状态结构 | node kind、schema、迁移号、旧本地资料标记 | 不改拓扑契约，不借清理重置数据 |

## 装好的新包还会主动访问哪里

| 触发 | 外部地址范围 |
| --- | --- |
| 自动更新默认开：启动与每六小时 | `api.github.com/repos/Chaunyzhang/HiveWard/releases/latest`；检查结果只读到自家 Release |
| 用户下载更新 | `github.com/Chaunyzhang/HiveWard/releases/download/...`，以及 GitHub 的 `release-assets.githubusercontent.com` / `objects.githubusercontent.com` 资源跳转 |
| 出口地区检测 | `www.cloudflare.com/cdn-cgi/trace`、`one.one.one.one`、`cloudflare-dns.com` 等现有探测目标 |
| 用户启用 / 配置第三方后 | AI 提供商的认证 / 额度刷新、代码托管和工单服务、语音模型下载、浏览器网站 / Google 登录、已安装扩展的更新、用户选定远程电脑。部分集成会在启用后按原条件后台刷新，不是每次都需要点击 |

除必须保留的自家 GitHub 更新检查外，外网行为属于出口检测或用户启用的第三方功能；**没有 Orca / Stably 的主动调用链**。测试中的旧域名、历史文档和保留的本地标识不代表网络请求。

## 测试隔离事故与修正

早期 CLI 子进程忽略了测试指定的 `ORCA_USER_DATA_PATH`，使用父终端继承的 `HIVEWARD_USER_DATA_PATH`，确实收到过真实实例的旧 RPC 参数错误。这轮整体测试和旧 HEAD 对照结果已作废，不能用它们宣称验证通过。该次检查在参数验证阶段拒绝，但没有足够证据保证所有早期子进程都没有已读标记或诊断记录副作用；没有擅自回滚、恢复或清空真实资料。

现已修复显式资料路径的优先级，保留原环境变量兼容，并加入回归测试。最终测试清空 `ORCA_*` / `HIVEWARD_*` 定位变量，禁止连接 `47615` / `8787` 和真实资料目录，在 `/tmp/hiveward-release-verification` 使用源码快照及独立编译的 CLI。没有编译、安装或退出 App，没有执行 CLI 安装脚本。隔离脚本为 `/tmp/hiveward-clean-test.py` 和 `/tmp/hiveward-offline.cjs`。

## 修改文件范围

- 更新：`src/main/updater.ts`、`src/main/updater/hiveward-*.ts`、`src/main/window/main-window-updater.ts`、`hiveward/server/updates.mjs` 及测试。
- 最小接线：`src/main/hiveward/bridge-service.ts`、`hiveward/desktop/engine.mjs`、`hiveward/shared/api.ts`（仅追加更新契约）。
- 设置：`hiveward/web/src/features/settings/general/update-row.tsx`、对应测试、`general/index.tsx` 和 `hiveward/web/src/lib/i18n-en.ts`。
- 发布：根 / hiveward `package.json`、`pnpm-lock.yaml`、builder / NSIS / dev-app-update 配置、`config/scripts/hiveward/release-mac.mjs`、`sign-app.mjs` / `sign-mac-deployment-template.mjs`、打包资源校验脚本和测试、保留主题的资源校验值。
- 兼容：`src/shared/profile-state-build-compatibility.ts`、managed-server 激活记录 / 准入、SSH 托管更新可用性、`src/cli/runtime/metadata.ts` 与相应测试。
- 删除服务涉及 `src/main`、`src/shared`、`src/cli`、旧 renderer 入口、资源、CI；实际分组见上表。旧事件采集与注册已删除，本地已有状态的兼容字段不借此迁移或清空。
- 文档：本报告、`hiveward/docs/release-1.0.0.md`、根 `CHANGELOG.md`。大索引仍在 `/tmp`。

## 测试运行配置

仓库的 Vitest 配置位于 `config/vitest.config.ts`。直接 `npx vitest run` 未自动加载它，会缺全局 AppEnvironment / SecretStore 初始化和 `--expose-gc`，并重复选择部分 `.spec.ts`；初轮 690 失败及对应 HEAD 对照只能作为该直接命令的原始记录，不能直接当成产品失败计数。最终整体检查显式追加 `--config config/vitest.config.ts --browser.enabled=false`。早期真实实例环境污染的问题独立存在，仍按上文披露。

## 验证

施工主线已完成，但整体验证尚未达到可发版状态；不把 HEAD 或其他并行工作的失败当成通过。原始输出保存在 `/tmp/hiveward-*.log`。

| 检查 | 关键输出 / 证据 |
| --- | --- |
| 更新、下载校验、安装脚本与产品 / 版本兼容 | `23 files / 322 tests passed`；`/tmp/hiveward-configured-update-identity-final.log` |
| 删除云入口后的功能与 IPC 回归 | `8 files / 81 passed / 1 skipped`；`/tmp/hiveward-deletion-tests-final.log` |
| 保留的插件与本地安装 | `12 files / 95 tests passed`；`/tmp/hiveward-plugin-install-final.log` |
| 打包资源校验（只测试临时目录） | `1 file / 3 tests passed`；`/tmp/hiveward-packaged-resources-final.log` |
| 本地契约 | `8 files / 82 tests passed`；`/tmp/hiveward-remaining-local-contracts-final.log`；额外旧中继组 `306 pass / 3 timeout`，超时组单跑 `9 passed`（15 秒测试上限，生产代码未改），见 `/tmp/hiveward-local-incumbent-retest.log` |
| 删除旧 UI 后的消费者 / 插件类型 | `2 files / 8 tests passed`；`/tmp/hiveward-removed-ui-consumers-final.log`；只保留现有 CLI / 终端 / 权限文本校验 |
| 后台全量 | `231 tests / 230 pass / 0 fail / 1 skipped`；`/tmp/hiveward-server-clean-final.log` |
| 更新确认 UI | `1 file / 2 tests passed`；`/tmp/hiveward-web-tests-final.log` |
| 全量类型检查 | `pnpm typecheck`、`pnpm typecheck:node`；`/tmp/hiveward-typecheck-final.log`、`/tmp/hiveward-typecheck-node-final.log` |
| 网页 | Prettier `All matched files use Prettier code style!`；`tsc -b`、`eslint src --quiet` 退出 0；`/tmp/hiveward-web-*-final.log` |
| main / shared 全量 | 显式加载配置的隔离全量已完成：7,627 文件中 169 失败；JSON：76,135 通过、640 失败、1,344 跳过，不能宣称通过。见 `/tmp/hiveward-configured-all-final.json` |
| 全量后的定向修复 | WSL 身份夹具、命令品牌与已删除云入口引用：`8 files / 95 tests passed`，见 `/tmp/hiveward-full-regression-repairs.log`；旧 UI 消费者 / 类型另 `2 files / 8 passed` |
| 隔离脚本的假 DNS 误拦 | 新测试脚本只允许 `.test` 的自定义解析最终指向 loopback，6 个链接预览用例通过，见 `/tmp/hiveward-link-preview-isolated-final.log`；生产网络限制未放宽 |
| 最终签名与部署模板 | `2 files / 3 tests passed`，原生签名字节更新后校验通过，其他脚本变化仍拒绝；`/tmp/hiveward-signing-final.log` |
| 未关闭失败清单 | `/tmp/hiveward-1.0.0-test-failures.md`：逐文件保留原始失败、后续修复和受保护区域；没有将剩余失败统称为基线或忽略 |
| 辅助 HEAD 对照 | 只重跑初轮失败文件；按唯一文件 / 用例名，626 项在 HEAD 也失败、54 项在 HEAD 通过、6 项无对照。对照不证明 HEAD 全量通过；旧的环境污染对照作废；这份对照也未加载仓库 Vitest 配置，不能据此给产品归责 |
| 代码质量门禁 | 最后修改后复跑，结果见 `/tmp/hiveward-quality-final.log` |

未构建、安装、退出真实 App，未发 Release / tag / push / commit，未主动回滚真实 userData，未向 `/Applications` 或 `/usr/local/bin/orca` 写入。Mac 替换脚本只在 `/tmp` 模拟，Windows 仍需无签名 NSIS 实机验收。浏览器运行时返回无可用浏览器，设置块只有 DOM 交互证据，没有安装包截图。
