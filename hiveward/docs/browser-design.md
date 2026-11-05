# HiveWard Agent 内嵌浏览器方案探索

> 本文是调研与小实验结论，不代表已经实施。目标是让 Agent 独立完成看数据、导报表、后台上架、发内容等浏览器工作；登录和验证码仍由老板处理，发布、支付、改价等仍由老板授权。

## 结论先行

1. **继续用现有 `WebContentsView + Electron session + CDP`，不要换外部浏览器，也不要再写一套 Playwright 控制器。** 现有栈已具备持久登录、标签、后台运行、截图和基础操作；缺的是身份模型、动作结果契约及若干复杂页面能力。
2. **「业务」「浏览器身份」「标签」「操作者」必须拆开。** 浏览器身份拥有不可变的 partition；业务只保存默认身份，允许下单时另选。已有业务 partition 原样接管，不能通过改名或复制 cookie 来迁移。
3. **第一期闭环一件只读型运营活：导出报表。** 沿用 `hiwd web`，补旧身份兼容映射和 `will-download` 结果即可做到「打开已登录后台 → 导出 → 等到文件 → 返回路径并读表汇总」。MCP、拟人轨迹、示教都不是这个闭环的前置条件。
4. **优先抽取仓库主引擎已有实现。** OOPIF、文件选择器、下载、对话框队列、动作效果和 Agent 光标均已有代码；不要形成第二套平行语义。架构文档也要求保留 HiveWard 的业务 profile 与确认码边界，并避免两套实现同时控制同一 WebContents（`docs/hiveward/ARCHITECTURE.md:68-78`）。
5. **扩展能力前先补授权链路。** 当前确认码原语可用，但 `by` 可伪造、Agent 可调用决策答复入口、风险识别只覆盖部分动作；不能把现状当成完整安全边界，详见第 7 节。

## 本轮实验边界与索引

- 环境：macOS arm64，仓库 Electron **43.8.4**，Chromium **150.0.7871.250**。
- 全部窗口 `show:false`；只访问动态端口上的 `127.0.0.1` / `localhost` 本地页面；未访问真实网站，未读取或改动 HiveWard 真数据；未做 Windows/Linux 验收。
- 所有脚本、partition、下载和结果都在 `/tmp/browser-spike/`。行号引用均指本次阅读时的工作区。

| 实验 | 文件 | 覆盖 |
| --- | --- | --- |
| 身份与后台 | `/tmp/browser-spike/identity.mjs`；`identity-write-results.json`、`identity-read-results.json` | 直接复用当前 `BrowserTabs`，测 cookie、重启、弹窗、下载、权限、代理解析、后台截图、并行标签 |
| 指纹与输入 | `/tmp/browser-spike/fp-input-spike.js`；`fp-input-results.json` | UA、UAData、Sec-CH-UA、webdriver、鼠标、滚轮、键盘、拖拽、hover |
| 产品名 UA 对照 | `/tmp/browser-spike/brand-ua.cjs`；`brand-ua-native.json`、`brand-ua-clean.json` | `app.setName('HiveWard')` 后 native/clean 对照 |
| 复杂页面 | `/tmp/browser-spike/hard-spike.cjs`；`hard-results.json` | OOPIF、shadow DOM、富文本、日期、虚拟滚动、对话框、上传、canvas 编号截图 |

实验脚本启动时发现一个与产品无关的脚手架问题：这版 Electron 的实验 `.mjs` 主入口使用顶层 `await` 会等不到 `ready`；改成 CommonJS 或 `app.whenReady().then(main)` 后正常。因此后续实验均使用 `.cjs` 或非顶层等待启动。

## 当前调用链（作为后续方案的单一执行内核）

```text
Agent → hiwd web → /api/browser/tabs… → browser-routes/automationRoutes
      → 每个 WebContents 的 session + Promise queue → CDP → 页面
```

- `hiwd web` 的参数、默认选页和 CLI 输出在 `hiveward/server/hiwd.mjs:367-528`；`web` 分发入口在 `hiveward/server/hiwd.mjs:718-724`。
- 桌面路由在 `hiveward/desktop/browser-routes.mjs:18-40`，挂进 bridge 的位置在 `hiveward/desktop/engine.mjs:151,223-238`。
- 基础自动化动作是 `snapshot/click/fill/type/press/select/check/uncheck/hover/scroll/upload/get/eval/wait`（`hiveward/desktop/automation.mjs:11-12,190-280`）。
- 同一标签的自动化请求串行，session 以 WebContents 为键（`hiveward/desktop/automation.mjs:283-295`）。
- 网页端本机走 IPC、远程走 HTTP；类型与适配器在 `hiveward/web/src/lib/desktop.ts:6-20,78-113,131-163`，preload 只暴露标签管理能力（`hiveward/desktop/preload.cjs:13-25`）。

## 1. 多浏览器身份

### 现状

- 当前 `profile` 通常就是业务 id，映射为 `persist:hiveward-<profile>`；同一 profile 共用 cookie/存储，不同 profile 隔离（`hiveward/desktop/browser.mjs:1-6,56-63`）。
- HTTP 只允许 profile 为 1–64 位字母、数字、`-`、`_`（`hiveward/desktop/browser-routes.mjs:22-26`）。
- 普通 `target=_blank` / 新标签意图转为 HiveWard 标签并继承 profile/by；带 features、frameName 等依赖 `window.opener` 的请求保留原生子窗口，并复用 HiveWard 的安全窗口和 origin-bar 策略。
- UI 新建标签不传 profile，所以都落到 `default`；没有身份选择器或业务默认身份（`hiveward/web/src/features/browser/agent-browser.tsx:54-59,137-147`）。
- 没有应用层下载目录、权限或代理配置；现有网络策略只有 URL 阻断（`hiveward/desktop/browser.mjs:61`）。

### 方案

建立独立的身份注册表，显示名与存储键永远分离：

```text
BrowserIdentity {
  id, name, partition,             // id/name 可展示；partition 创建后不可变
  downloadDirectory, proxyId,
  permissionGrants                 // 按 origin + permission 保存
}
Business.defaultBrowserIdentityId  // 只存 id，不拥有 cookie
Tab.identityId / openerTabId / createdBy / controller
```

- **旧身份零搬迁：** `shop` 映射为 `{id:'legacy-shop', partition:'persist:hiveward-shop'}`；`default` 同理。新身份可用 `browser_<uuid>`，partition 用 `persist:hiveward-browser-<uuid>`。不要重命名 `Partitions/hiveward-shop`，也不要复制 cookie 数据库。
- `hiwd web open --profile shop` 保留为旧别名；新增 `--identity <id>`。缺省时按当前业务默认身份，无业务上下文才用全局默认。业务重合时允许显式选任何已有身份。
- 改身份名、改业务默认身份都只改注册表。已有 WebContents 不能原地换 session；换身份必须新开标签，并明确提示不要混用账号。
- 弹窗按 HiveWard 的意图分类分流：普通链接开标签；需要 opener 的 OAuth 使用同 session 原生子窗口，子窗口递归应用同一策略。后台标签创建的原生弹窗保持隐藏，不抢老板焦点。
- **兼容边界：** 原生弹窗不在 HiveWard 标签列表中，Agent 不能把它当普通标签控制；具体站点的 `postMessage`、重定向和关闭行为仍需实机验收。
- 每个身份设置独立下载目录；权限按身份 + origin 默认拒绝/询问；代理在创建该身份页面之前设置，运行中改代理要重建连接并提示影响。

### 用到的 Electron / CDP 接口

- `session.fromPartition(partition)`、`WebContentsView.webPreferences.partition`；持久目录由 Electron 管理。
- `webContents.setWindowOpenHandler`、`did-create-window`、`overrideBrowserWindowOptions.webPreferences.partition`。
- `session.setDownloadPath()`、`session.on('will-download')`、`DownloadItem.setSavePath()/getSavePath()/once('done')`。
- `session.setPermissionRequestHandler()` 与 `setPermissionCheckHandler()` 必须成对处理；摄像头还受 macOS/Windows 系统授权影响。
- `session.setProxy()`、`resolveProxy()`；变更时可用 `closeAllConnections()` 避免旧连接复用。代理凭据不进身份 JSON 明文，也不通过 MCP 返回。
- 主引擎已有可抽取的权限/下载/UA 安装器（`src/main/browser/browser-session-partition-policies.ts:69-91,140-170,183-299`）和 popup 同 partition 处理（`src/main/browser/browser-route-guest-popups.ts:183-205`）。

### 实验结论（贴关键输出）

直接运行当前 `BrowserTabs` 得到：

```json
{
  "shopCookie": "spike_identity=alpha",
  "financeCookie": "spike_identity=beta",
  "differentSessions": true,
  "sameSessionAfterReopen": true,
  "popup": [
    {"kind":"window-open","profile":"shop","by":"agent-a","cookie":"spike_identity=alpha"},
    {"kind":"target-blank","profile":"shop","by":"agent-a","cookie":"spike_identity=alpha"}
  ],
  "partitionDirectory": ["hiveward-finance", "hiveward-shop"]
}
```

另一个 Electron 进程复用同一 `/tmp` userData 后仍读到：

```json
{"cookies":{"shop":"spike_identity=alpha","finance":"spike_identity=beta"}}
```

这证明应保留旧 partition 本身，而不是迁移 cookie。两个身份还分别完成下载：

```text
shop    → completed /tmp/browser-spike/downloads/shop/report-shop.csv
finance → completed /tmp/browser-spike/downloads/finance/report-finance.csv
```

权限处理器对 shop 允许、finance 拒绝，实测分别为：

```json
{"shop":{"notification":"granted","camera":"granted"},
 "finance":{"notification":"denied","camera":"NotAllowedError: Permission denied"}}
```

代理只做了配置/解析验证，没有发外部流量：

```text
shop    → PROXY 127.0.0.1:31001
finance → PROXY 127.0.0.1:31002
```

### 风险

- partition 一旦变化，cookie、IndexedDB、localStorage、Service Worker 等都会像换浏览器一样消失；身份注册表需要备份、唯一约束和损坏时 fail-closed。
- 同身份多标签仍共享 cookie/localStorage；标签隔离不等于账号隔离。
- OAuth 的 opener 兼容、系统媒体权限、代理鉴权和远程电脑路径都需要单独验收；`resolveProxy` 正确不代表完整代理链路已验收。
- `by` 只是创建者标签，不是访问控制，不能据此决定谁能使用某身份。

**工作量：中。** 旧身份映射、默认选择和下载目录是中偏小；OAuth opener 原生兼容与完整权限/代理 UI 会把它推到中等。

## 2. 指纹：UA、Client Hints 与 webdriver

### 现状

- `hiveward/desktop/browser.mjs` 没有自己设置 UA 或 `navigator.webdriver`。
- 但 HiveWard 主进程已在任何 session 创建前初始化进程级 UA（`src/main/startup/main-process-preflight.ts:263-266`）；缺省模式是 `clean`（`src/main/browser/browser-identity-mode-record.ts:92-103`）。
- `cleanElectronUserAgent()` 会移除 Electron 和宿主产品 token（`src/main/browser/browser-process-user-agent.ts:15-24,27-41`）。所以不能拿裸 Electron 的 UA 直接断言当前 HiveWard 的默认线上行为。

### 方案

- **推荐目标只定义为「不暴露 Electron/HiveWard，所有观察面自洽」，不要定义为「不可检测」或「绕过验证码/风控」。**
- 继续复用进程级 `app.userAgentFallback` 的 early clean；新 session、标签、iframe、worker、弹窗都用同一身份。若按身份/标签覆盖，则在第一次导航前用 `session.setUserAgent()` 或 `webContents.setUserAgent()`，并用 CDP `Network.enable` + `Network.setUserAgentOverride({userAgent,userAgentMetadata})` 同步 UAData 与请求头。
- `userAgentMetadata` 至少同步 `brands/fullVersionList/fullVersion/platform/platformVersion/architecture/bitness/model/mobile/wow64`。当前 clean UA 的字符串像同版本 Chrome，但默认 UAData 仍只有 Chromium 品牌，**不等于官方 Google Chrome 的完整品牌列表**。
- 若业务确实要求声明为同版本 Google Chrome，应从同版本真实 Chrome 采集参考值，再填入包含 Google Chrome 的 brands/fullVersionList；不能硬编码本轮 `150`/平台版本后长期使用。优先保持自洽的 Chromium 身份，除非有明确兼容理由。
- 不要给 `navigator.webdriver` 打补丁；实测挂 debugger 前后本来就是 `false`。
- 可复用主引擎的 UA 清理和 wire identity 代码（`src/main/browser/browser-session-ua.ts:64-117`），包括它已有的登录例外思路；不要只改 JS 值而漏掉请求头或子上下文。

### 用到的 Electron / CDP 接口

`app.userAgentFallback`、`session.setUserAgent()`、`webContents.setUserAgent()`、`webContents.debugger.attach('1.3')`、`Network.setUserAgentOverride`、`navigator.userAgentData.getHighEntropyValues()`，以及本地服务器的 `Accept-CH` / 请求头记录。

### 实验结论（贴关键输出）

裸 Electron 默认：

```text
navigator.userAgent = … Chrome/150.0.7871.250 Electron/43.8.4 Safari/537.36
HTTP User-Agent     = 同上
navigator.webdriver：debugger attach 前 false，attach 后 false
```

默认 UAData/高熵值为 `Chromium v150`、`macOS`、`arm`、`64`、`150.0.7871.250`，不含 Electron/HiveWard。服务器返回 `Accept-CH` 后实际收到：

```text
Sec-CH-UA: "Not;A=Brand";v="8", "Chromium";v="150"
Sec-CH-UA-Mobile: ?0
Sec-CH-UA-Platform: "macOS"
```

本轮首访、同源 fetch、二次导航均未观察到高熵 `Sec-CH-*` 请求头；只能确认上述低熵头和 JS 高熵值，不能声称高熵 wire header 已验证。

模拟产品命名后的 native/clean 对照：

```text
native：… (KHTML, like Gecko) HiveWard/43.8.4 Chrome/150.0.7871.250 Electron/43.8.4 Safari/537.36
clean ：… (KHTML, like Gecko) Chrome/150.0.7871.250 Safari/537.36
```

clean 后服务器 UA 与上述低熵 CH 也均无 HiveWard/Electron。`Network.setUserAgentOverride` 同样使 navigator UA、HTTP UA、UAData 和已观察低熵头一致。另一个重要时机结果：**对已创建的 WebContents 晚调 `session.setUserAgent()` 没生效；在新窗口创建前调用才生效。**

### 风险

- UA 只是众多浏览器特征之一；即便这些字段一致，也不代表图形、媒体、扩展、行为等特征与官方 Chrome 完全相同。
- 改 UA 可能破坏 OAuth/登录；主引擎已有 Google 登录例外，不应为了“统一好看”删掉（`src/main/browser/browser-tab-identity.ts:19-43`）。
- 本轮没有启动真实 HiveWard 数据目录做线上验收，也没有和官方 Chrome 做逐字段差分；实施时用一次性本地测试实例补跨 iframe/worker/popup 回归。

**工作量：中。** 默认 clean 已存在；主要工作在跨上下文一致性、测试和兼容例外，而不是删一个 UA 子串。

## 3. 像真人的输入：以可靠性为目标，不做反检测承诺

### 现状

- 点击是元素中心点的一次 `mouseMoved → mousePressed → mouseReleased`，没有轨迹、随机落点或按压间隔（`hiveward/desktop/automation.mjs:102-119`）。
- `fill/type` 使用 `Input.insertText`；`press` 才使用 `dispatchKeyEvent`（`hiveward/desktop/automation.mjs:121-129,208-224`）。
- 滚动实际是 `Runtime.evaluate(window.scrollBy…)`，只滚主窗口，不产生目标元素上的 wheel 输入（`hiveward/desktop/automation.mjs:246-253`）。
- 已有 hover；没有拖拽、组合键、元素内滚动或点击后遮挡验证。

### 方案

- **点击：** 重新解析 ref，`scrollIntoView`，在可见矩形内留边距后随机选点；做 3–12 段短轨迹、短暂按下/释放。点击前用 `elementFromPoint/elementsFromPoint` 检查遮挡，点击后返回 URL、弹窗、下载和页面 diff，而不是只回 `{ok:true}`。
- **滚轮：** 把鼠标移到目标容器可见点，发送多次 `Input.dispatchMouseEvent({type:'mouseWheel',deltaX,deltaY})`；每轮后等待渲染并重新 snapshot。保留 JS 滚动只作为明确的只读定位兜底，不能混称真人滚轮。
- **文字：** 长文本、中文、emoji 默认 `Input.insertText`；快捷键、掩码输入、自动补全和依赖 keydown 的控件才逐字 `dispatchKeyEvent`。逐键需正确提供 `key/code/windowsVirtualKeyCode/text/unmodifiedText` 和 modifiers；中文不要伪装成英文键序列。
- **拖拽：** `mousePressed(buttons:1)` 后分段 `mouseMoved`，最后 `mouseReleased`；覆盖 HTML5 drag 与普通 pointer 拖拽。文件上传仍优先文件 input，不模拟从 Finder/资源管理器拖文件。
- **hover 菜单：** 移到目标后等待菜单出现，再重新 snapshot 菜单项；不要沿用 hover 前的 ref。
- **节奏：** 本地实验无法得出真实网站的“安全速度”。建议起始默认值为动作间隔 300–900ms、逐键 50–140ms、短轨迹 80–250ms，再按站点 playbook 调整；导航/渲染优先等待条件，不用固定长 sleep。节奏是为了减少误操作和请求突发，不承诺规避平台风控。

### 用到的 Electron / CDP 接口

`Input.dispatchMouseEvent`（move/press/release/mouseWheel）、`Input.dispatchKeyEvent`、`Input.insertText`、`Runtime.callFunctionOn`、`DOM.resolveNode`、`Page.captureScreenshot`。主引擎已有指针状态、拖拽和按当前指针滚动的实现，可抽取（`src/main/browser/agent-browser/agent-browser-bridge-pointer-commands.ts:116-200`）。

### 实验结论（贴关键输出）

```json
{
  "randomClick": {"point":[366.629,140.731],"clickCountBefore":0,"clickCountAfter":1},
  "mouseWheel": {"deltaY":240,"scrollTopBefore":0,"scrollTopAfter":240},
  "hoverMenu": {"hoverMatches":true,"menuVisible":true},
  "drag": {"dropData":"local-drag-payload","success":true},
  "eventTrust": {"total":73,"trusted":73,"untrusted":0}
}
```

事件序列差异是选择输入方式的关键：

```text
逐字 dispatchKeyEvent('Ab?') → keydown → keypress → beforeinput → input → keyup
insertText('中文🙂XY')       → beforeinput → input（inputType=insertText），无键盘事件
```

二者输入结果都正确；CDP 产生的上述鼠标、键盘、滚轮、拖拽事件均为 `isTrusted=true`。

### 风险

- `isTrusted=true` 只说明事件由浏览器信任，不代表业务一定接受，也不代表操作“像人”。
- 随机落点不能替代可见性/遮挡检查；iframe 还要先换算 frame 坐标。
- 固定随机延迟既降低吞吐量，也不能证明安全；必须设置总时限、取消和动作后断言。
- 发送文字后应读回 value/text；富文本还要检查编辑器内部状态是否接受，而非只看 DOM 一闪而过。

**工作量：中。** 基础原语小；坐标修正、拖拽矩阵、动作效果与站点回归是主要成本。

## 4. 运营场景里的硬骨头

### 4.1 文件下载 / 导出报表

- **现状：** 没有 `hiwd web download`、下载事件或路径结果；上传动作不等于下载（`hiveward/server/hiwd.mjs:387-413`）。
- **方案：** 每个身份 session 安装唯一 `will-download` 处理器，用事件里的 WebContents 找 tab/identity；同步决定不覆盖的保存路径，监听 `updated/done`。新增 `download <ref> --out <允许目录内路径>`：先登记 claim，再点击，等待开始和完成；非命令触发的下载也进入统一下载列表。
- **接口：** `session.setDownloadPath`、`will-download`、`item.setSavePath/getSavePath/getFilename/getReceivedBytes/getTotalBytes/cancel`。复用 `src/main/browser/agent-browser/agent-browser-bridge-page-commands.ts:122-171` 的 claim/等待语义和 `src/main/browser/browser-manager-download-creation.ts:227-277` 的状态处理。
- **实验：** 两个身份均 `state=completed`，路径分别落在各自目录，读回 CSV 内容正确。
- **风险：** 文件名冲突、永不结束、跨电脑路径不存在、报表含敏感数据。默认目录设边界，远程要显式传文件；导出通常只读，但页面若把导出当付费/发送操作仍需确认。
- **工作量：中。**

### 4.2 文件选择框

- **现状：** 已有绝对路径校验和 `DOM.setFileInputFiles`，但 ref 必须直接指向可见/AX 可得的 file input（`hiveward/desktop/automation.mjs:255-269`）；点击“上传”按钮后的隐藏 input 不一定能选。
- **方案：** 直接 input 继续走现有路径；按钮场景先 `Page.setInterceptFileChooserDialog({enabled:true})`，点击后等 `Page.fileChooserOpened`，用其 `backendNodeId` 和 frame `sessionId` 设置文件。远程先把文件传到目标电脑，不假设两边绝对路径相同。
- **实验：** 本地 36 字节文件设置成功，页面读到完整内容，`input/change` 均触发且 `isTrusted=true`。
- **风险：** 文件根目录授权、多文件/目录差异、change 后自动上传。upload 也必须经过风险闸，不能因没有点击“发布”就绕过。
- **工作量：中。** 可复用 `src/main/browser/agent-browser/agent-browser-bridge-interaction-commands.ts:64-145`。

### 4.3 alert / confirm / beforeunload

- **现状：** 当前 CDP session 未启用 Page，也没有对话框状态/命令；可能阻塞后续动作（`hiveward/desktop/automation.mjs:26-57`）。
- **方案：** `Page.enable` 后把 `Page.javascriptDialogOpening` 变成结构化状态并暂停该 tab 队列；提供 `dialog accept|dismiss`。alert 读取后关闭；confirm 按实际副作用判断授权；beforeunload 默认取消并交给老板，避免丢未保存内容。可复用主引擎的队列阻断语义（`src/main/browser/agent-browser/agent-browser-bridge-queue.ts:97-200`），但不要照搬“自动接受普通 dialog”的策略（`src/main/browser/cdp-debugger-events.ts:16-24`）。
- **接口：** `Page.javascriptDialogOpening`、`Page.handleJavaScriptDialog`；窗口关闭还需处理 Electron `will-prevent-unload`。
- **实验：** alert/confirm 均观察并处理成功；confirm accept 后返回 true。beforeunload 用 `accept:false` 后页面保持原 URL，`Page.navigate` 返回 `net::ERR_ABORTED`，没有卡死。
- **风险：** 不确定动作是否已生效时不能自动重试；confirm 的文案可能包含发布/支付授权。
- **工作量：中。**

### 4.4 跨域 iframe / OOPIF

- **现状：** 当前只取根 AX tree；坐标操作遇到非 top frame 直接报「暂不支持」（`hiveward/desktop/automation.mjs:102-109,131-163`）。
- **方案：** `Target.setAutoAttach({autoAttach:true,flatten:true,waitForDebuggerOnStart:false})`，在 `Target.attachedToTarget` 保存 iframe `sessionId`；snapshot 合并根/子 AX tree，ref 同时记录 `sessionId + backendDOMNodeId`。所有 resolve、读取、上传和输入都路由到对应 session；detach 时失效。
- **接口：** `Target.setAutoAttach/attachedToTarget/detachedFromTarget`、`debugger.sendCommand(method,params,sessionId)`、`Accessibility.getFullAXTree`。直接抽取 `src/main/browser/snapshot-engine.ts:25-29,54-83,111-116` 与 `src/main/browser/cdp-debugger-lifecycle.ts:53-63,85-99`。
- **实验：** 根 `127.0.0.1` AX 有 10 节点且不含子按钮；`localhost` OOPIF 子 session 的 AX 有 9 节点，包含 `Cross-site child action`。
- **风险：** 子 frame 坐标是 frame-local，要逐层换算并考虑边框、滚动、缩放和 devicePixelRatio；子树加载/销毁会使 ref 失效。仅合并 AX 不等于已经能正确点击。
- **工作量：大。**

### 4.5 Shadow DOM

- **现状：** 当前依赖 AX `backendDOMNodeId`，没有专门 piercing 或测试；不能宣称支持 closed root（`hiveward/desktop/automation.mjs:80-100,131-162`）。
- **方案：** open shadow 优先沿用 AX → backendNodeId；DOM 兜底用 `DOM.getDocument({depth:-1,pierce:true})`。事件路径/录制使用 `event.composedPath()`。closed root 不保证 DOM 访问，退到 AX 或截图坐标，失败就停下。
- **实验：** open shadow 内 `Shadow action` 进入 AX tree，`DOM.resolveNode` 得 `button#inside`；坐标点击成功且 `isTrusted=true`。
- **风险：** 嵌套 shadow、closed shadow、shadow 内 iframe 要分别测；`elementFromPoint` 遮挡判断需穿透 open root。
- **工作量：中。**

### 4.6 富文本编辑器与日期选择器

- **现状：** `fill` 接受 contenteditable，但拒绝 `input[type=date]`；自定义编辑器/日期弹层没有专门策略（`hiveward/desktop/automation.mjs:208-221`）。
- **方案：** 富文本沿用 focus → 选择 → Backspace → `Input.insertText`，再验证 text/value 和必要的状态；工具栏、@提及仍用真实点击/按键。自定义日期弹层用 AX 点选；原生 date 增加语义动作 `set_date`，优先分段键入，站点不接受时才用原生 value setter + input/change，并明确它是程序化填值。
- **实验：** contenteditable 成功写入 `Hello 插入了`，beforeinput/input 均 trusted。相同 `insertText` 思路对 date 失败，value 仍空；原生 setter 成功设为 `2026-11-03` 且 validity=true，但合成 input/change 均 `isTrusted=false`。
- **风险：** ProseMirror/Lexical 等内部模型、输入法、本地化日期格式、时区和禁用日期；setter 成功不代表框架已接受。
- **工作量：中。**

### 4.7 虚拟滚动长列表

- **现状：** 当前 scroll 只滚 window；AX snapshot 不会天然得到未渲染行。
- **方案：** 对滚动容器发 wheel，逐屏 snapshot，按稳定业务键去重；以 `scrollTop/scrollHeight` 和连续两轮无新行判断到底。长报表优先用站点导出，不靠几千次 DOM 抓取拼数据。
- **实验：** wheel 前 AX/DOM 都是行 0–5；后都是 12–17，`scrollTop=240`，没有混入未渲染行。
- **风险：** 列表会复用 DOM 节点，backendNodeId 会指向另一行业务数据；每屏必须重取 ref，不能把“已读 DOM 节点数”当总记录数。
- **工作量：中。**

### 4.8 Canvas 页面

- **现状：** 有普通 PNG 截图，没有编号标注或坐标动作（`hiveward/desktop/browser.mjs:152-165`）。
- **方案：** `Page.captureScreenshot` 后按候选区域或规则网格画编号框，返回图片和 `number → CSS rect`；Agent 用编号选择，再转成页面 CSS 坐标点击。复用现有截图 annotation 契约（`src/shared/runtime-browser-contracts.ts:58-72`），不要另造一套编号格式。
- **实验：** 生成并回读了 `/tmp/browser-spike/hard-canvas-annotated.png`；点击 cell 5 成功，canvas 收到 `(122,122)` 且 trusted。相对内容区预期 `(120,120)` 的 2px 差来自 canvas border，证明必须用内容矩形而非外框猜坐标。
- **风险：** 截图像素与 CSS 像素的 scale、border、滚动、iframe 偏移；canvas 没有语义树，低置信度或高风险按钮必须让老板看标注图确认。
- **工作量：中。**

### 4.9 后台标签页截图

- **现状：** 已关闭 `backgroundThrottling`，非活动标签通过 `setVisible(false)` 隐藏但继续挂载；只有 active 标签且网页面板给出有效 bounds 时才显示，截图有 `capturePage` 和 CDP 兜底。
- **方案：** 把截图/动作按 tab 路由，不为了 Agent 操作激活标签或抢老板焦点；补从未渲染、renderer crash、超时回归。
- **实验：** 非 active 标签和整个浏览器 bounds=null 后均得到非空 PNG；两者 `40367 bytes、2200×1520`，回读可见「后台标签截图 / OFFSCREEN OK」。改为原生隐藏后需重新做实机回归。
- **风险：** 后台动画、WebGL、系统休眠和从没出过帧的页面仍可能不同；截图必须有超时且不能依赖可见窗口。
- **工作量：小。**

### 4.10 多个 Agent 同时各开各的标签

- **现状：** 每 tab 自动化有 Promise queue；不同 tab 可并行。CLI 默认选当前 handle 最近打开的页面，UI 按 `by` 过滤（`hiveward/desktop/automation.mjs:283-295`、`hiveward/server/hiwd.mjs:440-452`、`hiveward/web/src/features/browser/agent-browser.tsx:13-20`）。但全局只有一个 active，`--tab` 可操作别人的页面，导航/截图/人的输入不在同一队列。
- **方案：** tabId 是执行路由，active 只是显示状态；每个 tab 一个控制 lease 和统一动作队列。不同 tab 可并行，同一「身份 + origin + 账号」的写操作流程串行；纯读页面可并行。老板接管优先级最高。HTTP/MCP 按可信调用者校验 tab/identity 权限，不能信请求体里的 `by`。
- **实验：** `Promise.all` 同时打开 agent-concurrent-a/shop 与 agent-concurrent-b/finance，分别读到 alpha/beta，身份和归属没有串线。
- **风险：** 同账号站点全局状态、购物车、草稿和限流仍会互相影响；并行不是默认越多越好，需要每身份并发上限和资源回收。
- **工作量：中。**

**第 4 节总工作量：大。** 不必一次全做；按真实站点遇到的阻塞逐项抽取主引擎能力。

## 5. Agent 怎么调：保留 CLI，增加同源 MCP 适配器

### 现状

- `hiwd web` 已完整覆盖基础动作，支持 `--tab`、`--confirm` 和跨电脑 `--on`（`hiveward/server/hiwd.mjs:367-528,573-605`）。新 Agent 的首句话会附 `agent-browser.md` 路径（`hiveward/server/hiwd.mjs:904-916`）。
- 仓库已有通用 MCP 配置、stdio/HTTP 会话和跨机桥；`hiwd mcp config` 会打印 Claude Code / Codex / Kimi 的接入命令（`hiveward/server/mcp-cli.mjs:265-350`）。
- **没有现成 Browser MCP server。** 通用 MCP 验收只覆盖 echo fixture 的 initialize/tools/list/tools/call（`hiveward/server/tests/mcp-acceptance.mjs:249-277,332-353`），不能当成三家客户端浏览器接入已验收。

### 方案：两者都保留，共用一套服务

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| 继续只有 `hiwd web` | 已可用、无需客户端配置；shell 易审计；天然适合脚本和远程 `--on`；截图直接给路径 | 每次进程/HTTP 开销；引号、多行文本和前导 `-` 易错；自由文本输出不如结构化 schema；默认选页依赖 handle；错误/进度/图片契约弱 |
| 增加 Browser MCP | 三家原生工具发现和参数校验；结构化错误、图片、下载/对话框状态；连接级默认身份/tab；少 shell quoting 错误；便于细粒度工具授权 | 新 lifecycle/schema/version 和客户端兼容工作；工具清单占上下文；截图可能很大；配置/重连/远程身份传播复杂；MCP 本身不提供安全授权 |

建议新增本地 stdio `hiwd web-mcp`，但它和 CLI 都只是薄适配器，调用同一内部 browser service/HTTP 契约。首批 tools 只封装现有受控动作及下载/对话框，**不暴露裸 CDP，也不开放无限制 eval**。snapshot 限制行数/字节，截图返回受控图片内容或路径，错误稳定使用 `stale_ref`、`needs_confirmation`、`owner_in_control` 等 code。

MCP 连接必须从启动环境/可信桥上下文获得 Agent handle；不得让模型传 `by` 自称身份。现有跨机 MCP 服务端只知道机器成员，不会自动带终端 handle（`hiveward/server/mcp-websocket.mjs:153-159`），stdio 子进程也只是继承 App/bridge 环境（`hiveward/server/mcp-sessions.mjs:125-139`），所以远程 Browser MCP 在补可信身份传播前不应开放。

### 用到的 Electron / CDP 接口

MCP 层不直接新增 Electron/CDP 调用；复用第 1–4 节同一 browser service。传输复用现有 stdio/WebSocket 管理和 `claude|codex|kimi mcp add …` 配置输出。

### 实验结论

本轮未启动三家真实客户端，也未连接真 App 做 MCP 实验；这是有意的边界。静态事实足以决定架构：通用桥已存在，Browser MCP 只是新适配层，不应另写 CDP 执行内核。实施后必须用三家各做一次 initialize/tools/list/tools/call、图片返回、确认码拒绝和断线重连验收。

### 风险

- 双入口最容易出现行为漂移和安全绕过；风险判断、确认码、tab queue 只能在共享内核实现一次。
- 不能把通用 MCP 的机器级鉴权误当 Agent 级身份；不能把 `by` 参数当凭证。
- 大 AX tree/截图会撑爆上下文；需要截断、delta 和按需读取。

**工作量：中。** 本地 stdio 适配器不大；三家验收、远程可信身份和图片/事件契约是主要工作。

## 6. 老板接手、Agent 状态、光标与示教

### 现状

- 本机老板看到的就是实际 WebContentsView，能直接点击输入（`hiveward/web/src/features/browser/agent-browser.tsx:13-20,159-163`）；指南也明确老板可接手、登录交给老板（`hiveward/docs/agent-browser.md:3-4,47`）。
- 标签已有 `by/loading/active/openedAt`，但 UI 只画 loading 点和标题，没有「谁在控制/正在做什么」（`hiveward/desktop/browser.mjs:30-43`、`hiveward/web/src/features/browser/agent-browser.tsx:106-135`）。
- 没有正式接管锁、「我来/还给 Agent」或示教/playbook。人工输入与 Agent queue 不互斥。
- 普通 React 浮层不能简单盖在原生浏览器视图上；当前检测到浮层会把浏览器隐藏（`hiveward/web/src/lib/desktop.ts:196-235`）。
- 主引擎已有 Agent 活动 lease、20 秒 idle 和光标「先到再动」握手，可复用语义（`src/main/browser/browser-agent-activity.ts:14-40,61-112,130-200`）。

### 方案

**先做控制状态，再做视觉增强：**

1. 标签增加 `identityId`、`agentName`、`controller={kind,id,since}`、`lastAction`、`activityState`。标签上显示身份名和 Agent 名；老板页面显示「老板控制中」。
2. 「我来」只从经过 `isCockpit` 校验的桌面 IPC 发起；等当前原子动作到安全边界后取得 owner lease，拒绝该 tab 新 Agent 动作并返回 `owner_in_control`，清理排队动作。老板登录/验证码期间不会自动交还。
3. 「还给 Agent」释放 lease、使所有 ref 失效并要求重新 snapshot；Agent 收到控制权事件后继续。远程页面目前只是每秒截图（`hiveward/web/src/features/browser/agent-browser.tsx:165-180`），远程真人接管需要另行转发可信输入，不能把本地能力当成已有。
4. Agent 光标复用主引擎的事件：CDP mouse 参数 → 页面 CSS 坐标 + viewport → renderer 光标。若当前 WebContentsView 层级无法直接复用 renderer overlay，优先用 `Page.startScreencast` 的 Agent 观看模式 + React 光标；老板点「我来」再切回真实视图。不要向业务 DOM 注入光标，避免污染页面和录制；透明点击穿透子窗口只作为跨平台原型备选。
5. 光标只表现 Agent 的输入，不伪造老板鼠标位置；没有鼠标移动的 fill/select 也可先显示目标框。动作完成/失败/Agent 断线要清理状态。

**示教做成「可编辑、可验证的站点手册」，不是脆弱像素宏：**

- 录制老板一次接管时的导航、点击、输入、选择、等待、下载和对话框；目标保存 `role/name/nth`、必要 CSS 兜底、frame URL 规则、截图和结果断言。临时 `e1` ref 不能入 playbook，因为导航/DOM 更新会失效（`hiveward/desktop/automation.mjs:19-25,131-162`）。
- 页面监听需通过 `Page.addScriptToEvaluateOnNewDocument` 安装到主 frame 和各 OOPIF；CDP Input 只有发送接口，不能靠它观察老板的原生鼠标。 shadow 目标记录 `composedPath()`。
- 默认不记录输入值，密码/token/验证码永远不记录；老板保存时把非密值显式改成参数。确认码、cookie、请求头不进入 playbook。
- 播放时重新 snapshot 并解析定位器，校验 origin、页面文案和结果；页面不符就停。发布/支付/改价步骤每次都重新请求老板授权，录制时的确认不继承。
- 手册同时保留人可读步骤和机器步骤；Agent 可根据新 AX tree 找等价元素，而非无条件按固定坐标回放。

### 用到的 Electron / CDP 接口

桌面 IPC + `isCockpit`、tab lease/queue、`Page.startScreencast/screencastFrame`、`Page.addScriptToEvaluateOnNewDocument`、`Page.frameNavigated`、`Target` 子 session、`Runtime.evaluate`（仅受控录制脚本）、现有 Agent activity/cursor 事件。

### 实验结论

本轮未做人机争用、远程接管或录制实验；这些涉及真实交互状态，不能用本地 CDP 输入实验冒充已验证。可复用性有源码证据：主引擎已经在 Agent command lease 内发布活动、等待光标落点后再发输入。第 3/4 节实验证明了后续可记录的点击、上传、下载和对话框都有可观察结果，但尚不构成 playbook 回放验证。

### 风险

- 老板与 Agent 同时点同一表单可能重复发布；接管必须先于任何示教/光标美化。
- 隐藏窗口截图观看模式有帧率/带宽成本；透明 overlay 有平台差异。
- 录制最容易泄露秘密、录制站点 DOM 噪音或把一次偶然时序固化为错误步骤；默认脱敏、人工编辑、逐步断言和每次高风险重新授权是硬要求。

**工作量：大。** 标签状态与「我来/还给 Agent」是中型子项目；可靠跨 frame 示教和可维护 playbook 是大型子项目。

## 7. 安全底线保持并补齐

### 现状

- 指南要求只读操作可放手做，发布/提交/改价等要停，登录/验证码交老板（`hiveward/docs/agent-browser.md:25-49`）。
- 工具层对高风险 click、表单 Enter、部分 eval 返回 428 `needs_confirmation`（`hiveward/desktop/automation.mjs:165-196`）。
- 确认码一次性、30 分钟、绑定 handle、只存内存（`hiveward/server/confirmations.mjs:1-22`）；老板答复时签发并发回 Agent（`hiveward/server/dispatches.mjs:218-245`）。
- 但静态阅读发现四个不能忽略的缺口：
  1. open 请求直接接受 `body.by`，消费确认码时取的是标签创建者而不是已认证调用者（`hiveward/desktop/browser-routes.mjs:22-27`、`hiveward/desktop/automation.mjs:288-293`）。
  2. Agent 可运行 `hiwd decide`（`hiveward/server/hiwd.mjs:1093-1107`），决策 resolve 路由没有老板身份校验（`hiveward/server/business-routes.mjs:447-496`）；这意味着「Agent 自己造不出码」在完整调用链上并不成立。
  3. 任何答复都会发码，确认码未绑定 decision、tab、origin 或具体动作（`hiveward/server/dispatches.mjs:225-230`、`hiveward/server/confirmations.mjs:8-21`）。
  4. RISKY 只是名称/脚本启发式；upload、select/check 触发的副作用、iframe Enter 等未统一覆盖（`hiveward/desktop/automation.mjs:170-187`）。

以上安全缺口只做静态审查，**没有在真实数据上利用或验证**。

### 方案

- **老板专属通道：** 决策 resolve/发码只接受经过 `isCockpit` 验证的桌面 IPC，或独立的 owner capability；Agent、普通 CLI、MCP 和 LAN 转发均不能调用。复用 `hiveward/desktop/engine.mjs:83-103` 的发送者校验思路。
- **授权绑定：** 只在老板明确同意时发码；绑定 `decisionId + handle + identityId + tabId + origin + actionFingerprint + expiry`，一次性消费。执行时重新计算动作指纹；页面/目标/参数变了就拒绝并要求重新确认。
- **统一入口：** CLI、MCP、playbook、弹窗子 frame、文件上传和坐标点击全部经过同一 policy gate。任何适配器都不能直接拿裸 `cdp()` 绕过。初版 MCP 不开放 eval；保留的 eval 也不能只凭正则声称安全。
- **风险语义：** 除了按钮关键词，还识别 form submit、文件 change 后上传、快捷键提交和坐标动作目标。无法判断是否副作用时，对已知运营流程准备到最后一步并停下；不要假装能静态识别所有网站写操作。
- **登录边界：** 登录、密码、验证码、两步验证只进入老板接管模式；Agent 不读取密码管理器/钥匙串，不保存秘密到 playbook，不用 UA/输入轨迹规避验证码。
- **数据边界：** 上传/下载限定老板授权的根目录；远程显式传文件；权限默认 deny/ask；日志和 MCP 输出不记录 cookie、密码、token、确认码和敏感输入值。
- **控制权：** owner lease 高于 Agent；老板接管时阻止 Agent 新动作。同 tab 永远一个控制者，避免重复提交。

### 用到的 Electron / CDP 接口

继续用 `consumeConfirmation` 的一次性消费原语，但扩展记录字段；桌面 `ipcMain.handle` + `isCockpit` 负责老板决定；共享 automation queue 负责执行前再次校验。不要为安全另加页面脚本绕过现有路由。

### 实验结论

仓库已有本地历史验收：无码点击 Publish 为 **428**，有效码为 **200**，重放为 **428**（`docs/hiveward/evidence/phase2-confirmation.json:1-30`；验收说明在 `docs/hiveward/PHASE2-PROGRESS.md:53-59`）。这证明确认码的一次性 MVP 能工作，但不覆盖本轮发现的「谁能答复/发码」和动作绑定问题。本轮没有新增真实发布/支付实验。

### 风险

- 任何基于按钮名字的 gate 都有漏判；高风险业务应使用明确 playbook 步骤/最终确认页，而不是只依赖正则。
- owner capability 若暴露给 Agent 会重新形成自助授权；远程 IPC、LAN 转发和 MCP 是重点审查面。
- 更严格绑定会让页面变化后必须重新确认，这是有意的安全成本。

**工作量：大。** 这是所有新入口上线前的基础工作，不应留到示教或全功能 MCP 之后。

## 分阶段实施顺序

### 第 0 期：安全与契约前置（必须先做）

1. 决策答复改成老板专属通道；禁止 Agent/CLI/MCP/LAN 自助发码。
2. `by` 改为可信调用者写入，补 tab/identity 访问检查；所有自动化入口统一 queue 和 policy gate。
3. 定义稳定错误码、动作效果、下载/对话框结果；补真实 TTL、一次性、owner、绑定动作测试。

**完成标准：** Agent 无法答复自己的待决策；有效授权只能用于老板看到的那个动作，换 tab/origin/参数或重放均失败。

### 第 1 期：最快闭环一件真实运营活——导出报表

1. 建身份注册表和旧 profile 别名，旧 `persist:hiveward-<业务>` 原样使用；业务默认身份 + 开标签时可选。
2. 保持 `hiwd web`，新增受控下载命令/事件和每身份下载目录；动作结果带新标签/下载/URL 变化。
3. 为本次目标站点补最小必要能力：普通点击、等待、读表已够用；只有真的用到日期控件才加 `set_date`，不要提前做全套输入仿真。
4. 用本地 fixture 做自动回归，再用老板已登录的测试后台做一次人工监督验收。

**完成标准：** Agent 从业务默认身份打开已登录报表页，点导出，等待完成，返回实际文件路径，并读取 CSV 给出汇总；老板不用碰浏览器，全程无发布类副作用。

### 第 2 期：覆盖常见后台的可靠性

按站点实际阻塞排序抽取主引擎能力：文件选择器 → 对话框队列 → OOPIF → open shadow → 富文本/日期 → 元素 wheel/虚拟列表 → 拖拽。canvas 编号截图作为视觉兜底，不作为所有页面的默认控制方式。

**完成标准：** 同一套契约在本地复杂 fixture 和目标站点通过；后台运行不抢焦点；失败能说明是 stale ref、dialog、download 还是 owner 接管。

### 第 3 期：MCP 与老板控制体验

1. 在共享 browser service 上加本地 stdio Browser MCP，三家逐一验收；远程身份传播未完成前不开跨机写操作。
2. 标签显示 Agent/身份/当前动作，完成「我来 / 还给 Agent」owner lease。
3. 复用 Agent activity/cursor；根据当前原生视图层级选择 screencast + React overlay，不污染业务 DOM。

### 第 4 期：示教与 playbook

最后做录制、脱敏、参数化、人工编辑、定位器重解析和结果断言。高风险步骤永不继承上次授权；先用于单站点单流程，再逐步推广。

## 明确不在近期承诺的事项

- 不承诺“和 Chrome 所有指纹完全相同”、反检测或绕过验证码。
- 不因为保留了原生 `window.opener` 就承诺所有 OAuth 流程；仍需逐站点验收。
- 不把 AX tree 当成虚拟列表的全量数据，不把 canvas 当成可读 DOM。
- 不在未补可信 Agent 身份前开放远程 Browser MCP 写操作。
- 不用固定延迟、随机轨迹或 playbook 回放替代动作后验证和老板授权。
