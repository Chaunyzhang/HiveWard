# 自建中转与 HiveWard 手机网页设计

> 本文是只读源码调研、手机宽度截图和设计建议，尚未实施，也没有连接或部署任何外部服务。
>
> 调研日期：2026-11-03；代码基线：`9956d0897e63`。工作区同时有其他 Agent 的未提交改动，行号指本轮读取时的工作区。临时截图和脚本只在 `/tmp`，没有写入真实 HiveWard 数据目录。

## 结论先行

1. **先用 Tailscale，Mac ↔ Windows 可以基本不改代码。** 现有自动发现不是 mDNS，而是 UDP 组播/广播；跨网段发现失效不妨碍 `hiwd machines invite <host:port>`。只要两端 overlay 地址双向可达，并放行明文 hello 端口和 TLS 端口，现有 SAS 核码、证书固定、逐对令牌、HTTP 和 WSS 都能继续用。
2. **HiveWard Cloud Relay 可复用，但不能原样变成 HiveWard 的组织互联。** 它已有 director/cell、出站 WebSocket、连接拼接、邀请/续接凭据和手机↔桌面 E2EE；业务 RPC 对中转不可见。但外层身份依赖仓库外的 HiveWard Auth，协议只接受 mobile scope 的 Runtime RPC，不是通用 HiveWard HTTPS/WSS 隧道。
3. **一台小云服务器从代码依赖上足够起步。** `combined` 角色 + SQLite + HTTPS/WSS 反向代理即可，不需要 Cloud Run、GCE、Cloud SQL、Terraform、fence broker 或 Push。它不是高可用方案，且当前上游启动配置还要求外部 Auth/JWKS；仅启动容器并不等于完整可用。
4. **不要把 `vendorServices` 直接改回 `true`。** 这个开关会同时重新启用一批官方云路径。应新增“仅自有中转”的配置，保留对 `onhiveward.dev`、`stably.ai` 等域名的阻断。
5. **身份只保留一套业务主键：电脑继续使用 `machine.json.id`。** LAN 证书指纹、Runtime 公钥/`relayHostId`、安装 ID 都是这台电脑的传输属性；手机是挂在某台电脑下的 `Device`，不是组织里的另一台 `Machine`，也不持有电脑间的网状 Bearer。
6. **推荐中转只转发端到端 TLS 字节。** 电脑间在隧道内继续跑现有自签证书 + 指纹固定 + Bearer；手机网页由桌面通过隧道提供 HTTPS/WSS，浏览器证书也在桌面终止。桌面必须用窄权限 DNS-01 签发证书，并用 CAA 禁止中转自行走 TLS-ALPN-01 取证。禁止中转终止业务 HTTPS，否则它能读取任务、对话、文件和复核请求，违背“只转发”。
7. **当前 `hiveward/web` 在手机宽度下不可用，不是微调断点就够。** 390px 实测仍显示 256px 左栏，主内容被挤成约 134px；架构图和任务正文不可读。首版应做同一 SPA 的单栏移动壳，优先待办/复核、任务、对话、只读文件，不搬桌面三栏和可缩放架构图。
8. **推送优先 Web Push，不做原生 APNs/FCM App。** 桌面可直接向浏览器订阅 endpoint 发送 Web Push，不必让自有中转保存通知正文。iOS/iPadOS 16.4+ 的主屏 web app 支持 Web Push，但有安装、授权和平台投递限制；本轮未做真机验收。

## 不可退让的边界

- 中转不生成任务、不保存业务真相、不代替执行端复核，也不成为组织成员。
- 电脑的数据仍由各自 `hiveward/server` 保存；Mac 的远程派单镜像仍只是投影，遵循 [跨电脑派活 / 控制设计](./cross-machine-design.md)。
- 中转可以看路由元数据，不能看业务明文；若某项实现让中转看到明文，就不能以“已有 HTTPS”为名验收。
- 不开放任意 TCP/HTTP 代理给未配对客户端；每条流都要有宿主、设备/机器授权、配额、超时和撤销。
- 不为了接自有服务重新启用 Stably/HiveWard 官方账号、更新器、遥测或 Push。

## 目标拓扑

```text
电脑 A（执行端/真相）                 电脑 B（执行端/真相）
  HiveWard HTTP/WSS + LAN 身份               HiveWard HTTP/WSS + LAN 身份
  端到端 TLS（原有 pin + Bearer）  ┐    ┌  端到端 TLS（原有 pin + Bearer）
                                  └────┘
                         自建 Relay：只拼接密文字节
                                      │
                            端到端 HTTPS/WSS │
                                      │
                               手机浏览器/PWA
                         （Device 授权，不是组织电脑）
```

同一 Relay 可以有两种适配器，但只有一种机器身份体系：

- **机器流**：Node 端通过出站 WSS 建立逻辑流，流内原样承载 A↔B 的 TLS 字节。
- **浏览器流**：公网 443 的 SNI/TCP 入口把原始 TLS 字节送入对应桌面的反向流，桌面终止 HTTPS/WSS。Relay 不持有该站点的 TLS 私钥。

## 1. 现有 HiveWard Cloud Relay 是什么

### 1.1 Director、cell 与连接拼接

`cloud/README.md:1-7` 已把职责说得很清楚：手机和桌面分别向 cell 建出站 WebSocket，cell 配对后拼接帧；director 分配 host 到 cell 并协调迁移。同一镜像由 `HIVEWARD_RELAY_ROLE=combined|director|cell` 决定角色，默认 `combined`（`cloud/apps/relay/src/config.ts:46-56`）。

一次手机经 Relay 连接桌面的顺序是：

1. 桌面向 Auth 换取短期 Relay JWT，再 `POST /v1/assign`；director 返回 `cellUrl`、assignment epoch 和签名 lease（`cloud/apps/relay/src/app.ts:424-471,698-705`）。
2. 桌面连接 cell 的 `/v1/host/control`，之后每条数据流另连 `/v1/host/data/:connId`（`cloud/apps/relay/src/relay-server.ts:740-868`）。
3. 手机先连 `/v1/connect/:relayHostId`，首帧 `relay-auth`；如果落在 director，会收到 `relay-moved` 后转到 cell（同文件 `:641-723`）。
4. cell 生成随机 `connId` 和 32 字节 `connTicket`，通过控制面让桌面开数据 socket；校验 ticket、generation 和 host 状态后调用 `wireSplice`（`cloud/apps/relay/src/host-session-registry.ts:910-947,1003-1024,1105-1155,1216-1268`）。
5. `splice-forwarder.ts:75-157` 只双向 `send`、排队、处理背压和关闭，没有业务解密。

`combined` 把自己当唯一 cell；独立 director 则必须从 `HIVEWARD_RELAY_CELLS_JSON` 读取 cell（`config.ts:302-334`）。单机不需要 director/cell 分离，也不需要区域迁移。

### 1.2 配对与长期凭据

桌面的 `hiveward://pair?code=...` 是 base64url JSON，不是单纯随机短码；通用字段有 `endpoint/deviceToken/publicKeyB64/scope`，手机 Relay offer 还可带 director/cell、assignment epoch、`relayHostId`、invite token/expiry 和 E2EE v2（`src/shared/pairing.ts:15-89`、`src/shared/mobile-relay-pairing-offer.ts:45-80`）。

- `relayHostId`：桌面 X25519 公钥的 SHA-256，再取 base64url 前 16 字符（`src/main/runtime/mobile-cloud-relay/relay-http-client.ts:85-87`）。
- invite：32 随机字节，Relay 数据库只存 SHA-256 hash；默认上限 10 分钟、5 次尝试（`cloud/apps/relay/src/credential-store.ts:169-206`、`cloud/packages/relay-contract/src/protocol-limits.ts:8-13`）。
- resume token：手机生成原文，桌面只向 Relay 安装 hash；默认 30 天，旧 token 可有 24 小时 grace（`mobile/src/transport/mobile-relay-credential-rotation.ts:24-56`、`credential-store.ts:388-477`）。
- 普通直连 Runtime/mobile device token 没有同一套 10 分钟过期语义；不能把普通 pairing URL 和 Relay invite 混为一谈。
- Relay offer 明确只允许 `scope:'mobile'`，`runtime` scope 带 Relay 会被拒绝（`mobile-relay-pairing-offer.ts:82-98`）。这也是 CLI/电脑间不能原样复用它的直接证据。

### 1.3 中转能否看到明文

**现有手机 Runtime RPC：业务密文不可见，路由元数据可见。**

手机每 socket 生成临时 X25519 keypair/nonce，固定二维码里的桌面长期公钥；transcript 绑定双方公钥、nonce、`transport:'relay'` 和 `relayHostId`。HKDF-SHA256 派生双向 key，帧用 NaCl `secretbox`（XSalsa20-Poly1305）和有序计数器保护（`src/shared/paired-e2ee-v2-client-session.ts:39-82`、`paired-e2ee-v2-key-schedule.ts:9-28`、`mobile-e2ee-v2-framing.ts:19-120`）。

桌面另有 X25519 私钥持有证明：cell 用桌面公钥加密 challenge，桌面回答 HMAC proof；这与 E2EE 业务帧、director 的 HS256 assignment lease 是不同密钥层（`host-session-registry.ts:1664-1717`、`assignment/assignment-lease.ts:32-59`）。

| 数据                                                                             | Relay 可见性                                         |
| -------------------------------------------------------------------------------- | ---------------------------------------------------- |
| RPC 文本、终端、业务二进制                                                       | 不可见明文，只看到 E2EE 密文                         |
| 手机 device token / Runtime 业务鉴权                                             | 在内层 E2EE 中，不应可见                             |
| host/device/cell ID、账号/JWT claims、invite/resume 外层凭据、IP、连接时长和流量 | 可见或由其数据库保存；token 持久化主要是 hash        |
| 通知标题/正文                                                                    | **Relay 看不到，但独立 Push gateway 能看到并持久化** |

Push 不是同一加密边界：`cloud/apps/push/src/push-delivery-message.ts:38-68` 含标题和正文，APNs/FCM 客户端直接组包；durable queue 的 `payload_json` 也保存内容（`durable-push-schema.ts:26-38`）。日志不记录正文不等于服务看不到正文。

## 2. 部署与 fork 配置

### 2.1 上游生产形态与单机最小形态

当前公开仓库只有运行时和契约；生产/预发 Terraform、backend、runbook 和部署 workflow 已移到私有 `Chaunyzhang/HiveWard-cloud`（`cloud/README.md:66-75`）。因此源码能证明“怎么运行”，不能证明官方线上现在怎样部署。

迁出前的历史快照显示：director 是 Cloud Run，cell 是 GCE MIG + HTTPS load balancer，数据在 Cloud SQL，密钥在 Secret Manager；Push 是独立 Cloud Run + PostgreSQL（提交 `307f0cdaeedc25ce0b3bae1cd96d66df914fa458` 的父版本）。这些是历史事实，不是最小部署的必需项。

**单机最小转发面：**

| 项目     | 最小选择                                                                           |
| -------- | ---------------------------------------------------------------------------------- |
| 进程     | 一个 `cloud/apps/relay` Node 24 进程或容器，`HIVEWARD_RELAY_ROLE=combined`             |
| 数据库   | 不设 `DATABASE_URL`，用 `HIVEWARD_RELAY_DATA_DIR` 持久目录中的 WAL SQLite              |
| TLS      | 一个受信任 CA 的域名 + 支持 WebSocket Upgrade、长连接的 HTTPS 反向代理             |
| Auth     | 自有 ES256 issuer/JWKS，以及桌面 access token → relay-token 的交换端点             |
| 签名     | 至少 32 字符的随机 `HIVEWARD_RELAY_ASSIGNMENT_SIGNING_KEY`                             |
| 可省组件 | 独立 director/cell、PostgreSQL、GCP、Terraform、GCS、fence broker、Push、connector |

Relay/Push Dockerfile 都是 digest 固定的 Node Alpine、非 root、监听 8080（`cloud/apps/relay/Dockerfile`、`cloud/apps/push/Dockerfile`）。Relay 本身没有 TLS 证书配置，非 loopback 外部 URL 要求 HTTPS（`config.ts:259-266`）。

注意三个限制：

1. 源码把 `combined` 注为 staging-only compatibility；可以做小规模单节点，但不能宣称继承生产 HA/迁移能力（`host-session-registry.ts:1621-1627`）。
2. `cloud/README.md:98-100` 说“只有 assignment key 必填”已过时。当前 schema 还要求 `HIVEWARD_RELAY_PUBLIC_URL`、`HIVEWARD_RELAY_CELL_URL`、`HIVEWARD_RELAY_AUTH_ISSUER`、`HIVEWARD_RELAY_JWKS_URL`、`HIVEWARD_RELAY_ADMIN_AUDIENCE`、`HIVEWARD_RELAY_DEPLOY_SERVICE_ACCOUNT`（`config.ts:46-89`）。
3. 本仓库没有完整 HiveWard Auth 应用。桌面还要求 cloud-linked profile、session 和 `capabilities.flags['relay.use'] === true`（`src/main/runtime/mobile-cloud-relay/relay-auth-context.ts:6-32`）。自有 Relay 之外必须补 Auth 契约，或按本文建议去掉这层账号依赖。

`combined` 时 PUBLIC_URL 与 CELL_URL 应使用同一外部 origin，避免桌面 host proof transcript 的 origin 不一致。管理员 API 仍绑定 Google OIDC；填过启动 schema 不等于已经换成通用自有 OIDC。

### 2.2 指向自己域名/证书的配置

桌面默认值和覆盖项集中在 `src/main/hiveward-profiles/profile-cloud-auth-config.ts:25-29,54-104`：

| 用途                              | 配置                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| API/Auth                          | `HIVEWARD_CLOUD_API_URL`、`HIVEWARD_CLOUD_AUTH_URL`                                                                   |
| 登录/session/refresh/capabilities | `HIVEWARD_CLOUD_AUTHORIZE_URL`、`HIVEWARD_CLOUD_SESSION_URL`、`HIVEWARD_CLOUD_REFRESH_URL`、`HIVEWARD_CLOUD_CAPABILITIES_URL` |
| profile/org/logout                | `HIVEWARD_CLOUD_PROFILE_URL`、`HIVEWARD_CLOUD_ORG_URL`、`HIVEWARD_CLOUD_LOGOUT_URL`                                       |
| Relay token / director            | `HIVEWARD_CLOUD_RELAY_TOKEN_URL`、`HIVEWARD_RELAY_URL`                                                                |
| Push                              | `HIVEWARD_PUSH_GATEWAY_URL`                                                                                       |
| OAuth client/scope                | `HIVEWARD_CLOUD_CLIENT_ID`、`HIVEWARD_CLOUD_AUTH_SCOPE`                                                               |

手机原生端从桌面 pairing offer 和 director response 获得 Relay 地址，不需要第二个硬编码 URL；WebSocket 强制 `wss:`。所查 Relay/Push 路径没有自定义 CA/证书文件/pin 配置，应使用系统信任的 TLS 证书。

**当前 fork 的第一道开关不是 URL，而是 `src/shared/hiveward-product.json:9` 的 `vendorServices:false`。** `getHiveWardCloudAuthConfig()` 在读取 URL 前就返回未配置（`profile-cloud-auth-config.ts:43-49`），Push 也不启动（`src/main/startup/main-process-push-startup.ts:9-24`）。

相关 git 历史：

| Commit                                     | 含义                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------- |
| `77b154d5dd7953adb49c04febcc7cfa1ff2a9baa` | 2026-07-14 加入桌面/手机 Relay transport                                         |
| `307f0cdaeedc25ce0b3bae1cd96d66df914fa458` | 2026-10-21 将部署配置移入私有 cloud operations 仓库                              |
| `884008dc33d645b2071216d4529dd17387740b80` | 2026-11-01 `Fork HiveWard as isolated HiveWard engine with vendor services disabled` |

`884008dc…` 引入的关闭点还包括：

- `src/shared/hiveward-policy.ts:4-33`：阻断 `onhiveward.dev`、`hiveward.dev`、`stably.ai`、`stablyai.com`、PostHog 和 GitHub 上的 `stablyai/` 路径；
- `src/main/startup/hiveward-network-policy.ts`、MainHttpClient、Electron/browser session guard：各网络层阻断；
- updater、诊断上传、遥测、云分享分别关闭。

**实施时新增自有 Relay 开关/配置，不要打开整个 vendorServices，也不要删除上述域名阻断。** 自有域名加入允许列表，官方域名继续 deny-by-default。

## 3. 桌面、手机 RPC 与 LAN 怎样合

### 3.1 桌面现有 Relay/RPC 路径

桌面窗口模式会启动 Relay service，并注册成 Runtime RPC 的 pairing provider；`serve` 路径没有同样调用（`src/main/startup/main-process-runtime-launch.ts:191-265`、`main-process-relay-startup.ts:10-36`）。连接有 token 续期、控制面续租、指数退避、系统 resume、半开检测和 cell 迁移，不需要另造一套重连框架。

直连和 Relay 数据流最终都进入同一个 `MobileSocketWiring`，再做 E2EE、设备认证和 RPC allowlist（`src/main/runtime/rpc/mobile-socket-wiring.ts:172-240`、`runtime-rpc-websocket-dispatch.ts:130-161`）。Relay 外层 `relayDeviceId` 还必须等于 Runtime registry 的真实设备，不能拿外层凭据任意选择设备身份。

关于 `mobile/README` 常说的 **6768**：当前代码的 `DEFAULT_WS_PORT=0`，实际端口由 listener 绑定结果决定；6768 是文档/显式 `--port` 场景，不应写死进新设计（`runtime-rpc-pairing-types.ts:20-29`、`ws-transport.ts:127-134`）。直连默认是明文 `ws://` + per-device token + 应用层 E2EE，不是浏览器可直接信任的自签 HTTPS。

CLI 的 `--pairing-code` / `--environment` 只读取直连 `endpoint/deviceToken/publicKeyB64`，然后直接开 WebSocket + E2EE；它不使用 director/cell/invite/resume（`src/shared/paired-runtime-connection.ts:18-32`、`src/cli/runtime/client.ts:78-184`）。

`hiveward/desktop` 目前只启动本机 bridge（默认 47615）、LAN 明文（默认 8788）和 LAN TLS（默认 8789）；没有把 HiveWard API 接到 Cloud Relay（`hiveward/desktop/engine.mjs:33-42,223-238`）。

### 3.2 LAN 已有哪些可复用能力

| 层       | 当前事实                                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| 发现     | IPv4 UDP `239.255.87.88:18889` 和 `255.255.255.255:18889`，3 秒 announce、15 秒过期；生产入口没有启动旧 Bonjour/mDNS |
| 手动邀请 | `hiwd machines invite <host:port>` → 本机 `POST /api/machines/invite {address}`，不依赖发现记录                      |
| hello    | 地址参数是明文 LAN 端口，缺省 8788；`GET /lan/hello` 返回机器 ID、候选证书指纹和 TLS 端口                            |
| 配对     | 邀请 capability + 双方 nonce commitment/reveal + 两屏 6 位 SAS；默认 120 秒，接收端限频                              |
| TLS      | 每机 P-256 自签证书，SHA-256 指纹固定；入站要求客户端证书，出站先核对 pin 再发 Bearer                                |
| 令牌     | 每对机器、每个方向独立 32 字节 token；没有 scope/过期，代表整台来源电脑                                              |
| 数据     | HTTPS `/api/m/<machineId>/...`、组织同步、终端/MCP WSS；执行端从认证 peer 取来源机器，不信 JSON 自报                 |
| 撤销     | 本地删除立即生效，离线成员通过持久队列和 tombstone 最终收敛；网络分区时不是全网瞬时撤销                              |

主要实现：`hiveward/server/lan-discovery.mjs:40-159`、`lan-organization.mjs:205-307,330-379,405-526`、`lan-invitation-verification.mjs:46-83`、`lan-certificate.mjs:36-95`、`lan-tls.mjs:20-120`、`lan.mjs:272-343,544-634`。

### 3.3 为什么不能把 Relay 当普通 HTTPS 反向代理

当前 `authenticate()` 同时检查实际 TLS socket、实际客户端证书指纹和该 peer 的 inbound Bearer。如果 Relay 终止 TLS，来源会变成 Relay，机器身份、远程唤醒、派单来源和复核授权都会失真（`lan.mjs:272-343`）。

因此正确接法是：

```text
A 的 pinnedRequest / WSS
  → A↔B 原有 TLS（含客户端证书）
    → Relay 逻辑字节流（只看到密文）
      → B 的 TLS server
```

Relay 永不成为 `peers.json` 成员，也永不持有 LAN Bearer。需要改的是 endpoint 获取和 Duplex 传输，不是组织授权语义。

当前邀请接收端还用 `req.socket.remoteAddress + 对声明的明文端口` 拼回调地址（`lan-organization.mjs:427-440`）。经代理后这个地址不再可靠；应给邀请和 peer 增加显式 `direct/relay` 逻辑 endpoint，不能继续猜 socket 来源。

### 3.4 一套身份，不抹掉不同密钥的职责

建议保留下面的权威关系：

```text
Organization（现有 organization.json.id）
  └─ Machine.id = machine.json.id             唯一业务/组织主键
       ├─ lanCertificateFingerprint            LAN TLS 属性
       ├─ runtimePublicKey / relayHostId       Runtime/Relay 属性
       ├─ installationId                       可选安装属性
       └─ Device[]                             手机、浏览器、CLI 客户端授权
```

- 不新增第二个“业务机器 ID”。Relay 路由记录必须指向同一个 `Machine.id`，`relayHostId` 只做传输别名。
- 本地桌面启动时可在同一受信进程里建立并持久化 machine ↔ 证书 ↔ Runtime 公钥绑定；跨机合并必须由 TLS+SAS 或 pinned Runtime 公钥证明，不能按机器名/IP/发现包自报合并。
- `runtimeId` 只是进程 incarnation，environment `id` 只是本机一条配置，Cloud org 也不等于 LAN org，均不能当组织机器主键。
- 手机不进 `Machine[]`，不参与 UDP 发现，不拿电脑间 `outboundToken`。手机访问其他电脑时，由已配对主机按 delegated grant 对单一目标 Machine 做单跳 `/api/m` 代理；目标与操作必须明示授权，被代理请求不得再次转发。
- UI 可统一显示一台设备，但撤销要分别落实到桌面 session、Runtime device、Relay 外层凭据和 Push 订阅；全部确认后才显示“已解除控制”。

## 4. 第 0 步：Tailscale 过渡

### 4.1 现有代码能否直接用

**能，条件是双向 IP 可达；本轮只依据代码和现有测试，没有实际安装 Tailscale 或做 Mac/Windows 实机验收。**

1. 两端获得稳定的 overlay IP 或 MagicDNS 名。
2. Tailscale ACL 和系统防火墙允许两端互访 TCP 8788、8789。8788 只公开 hello；邀请、令牌交换和业务流量走 8789。
3. A 执行：

   ```bash
   hiwd machines invite <B 的 overlay 地址>:8788
   ```

   这里填明文 hello 端口，不是 TLS 端口；TLS 端口由 hello 返回。

4. 两端在网页核对相同 6 位码，B 接受。当前 CLI 不列 incoming invitation/核码，纯 CLI 不能跳过这个人工确认。
5. 后续 `hiwd ... --on B`、网页电脑切换、HTTP 文件流和 WSS 都使用保存的 pin/token，不需要 UDP 18889。

可复用 `lan-organization.test.mjs` 的手动地址邀请、三机 mesh、离线分发/撤销测试，以及 `lan-tls.test.mjs` 的主动 MITM、pin、明文拒绝和 WSS 测试；但这些不能冒充真实 Tailscale/Windows 验收。

### 4.2 限制与最小补项

- 自动 UDP 发现跨网段通常不可用；这不是阻断项，不要再造一套发现协议。
- 当前 decision/callback 流程要求双向可达，单向“A 能连 B”不够。
- 已保存地址变化时，没有发现就缺少地址迁移，也没有单独“编辑成员地址”API。使用稳定 overlay IP/DNS 名，首版无需改代码。
- 撤销仍是逐端送达；应展示 `pendingRemovals`，不能承诺离线节点即时失效。
- **不要把 5180 开发实例或桌面 debug 端口暴露给手机/公网。** 开发实例有 `/api/app/eval`、`/api/app/quit` 等高权限路由，且 Vite 未配置对外 host。第 0 步只验收电脑互联。

建议第 0 步只补一份操作 runbook 和真实双机验收；若纯 CLI 是硬需求，再单独加“列出邀请并显示 SAS”的只读 CLI，不绕开核码。

## 5. 手机网页现状与最小产品

### 5.1 390px 实测

使用现有 `127.0.0.1:5180` 开发实例，Playwright Chromium 模拟 `390×844`、`isMobile+touch`，只访问 localhost；未改代码、未写业务数据、未发出外部请求。截图：

- `/tmp/hwp-mobile-home.png`
- `/tmp/hwp-mobile-tasks.png`
- 脚本/日志：`/tmp/hwp-mobile-capture.mjs`、`/tmp/hwp-mobile-capture.log`

两个页面 `innerWidth=390`、`scrollWidth=390`，但没有横向滚动不代表适配成功：固定左栏仍占约 256px，右侧只剩约 134px。架构图被压成窄条，任务页主要只看得见时间和图标，正文不可读。

代码原因与截图一致：

- `AppShell` 永远是 Rail + 中栏 + 右侧 SidePanel；Rail 固定 `w-64`，右栏默认打开且宽 400、最小 300（`hiveward/web/src/components/layout/app-shell.tsx:16-34`、`rail.tsx:129-136`、`stores/workspace.ts:69-131`）。
- 已有 `useIsMobile()`（`<768px`），但业务壳没有使用；只有通用 shadcn Sidebar 会切 Sheet。
- 画布面向桌面拖动/滚轮/缩放，卡片固定宽度，fit 最小仍可缩到 30%；手机上即使缩放也不等于可读（`topology-canvas.tsx:354-524,570-646`）。
- 小屏输入 16px、部分卡片换行、Markdown 溢出处理可以复用；点击区、hover 操作、safe area 和触摸手势仍缺。

### 5.2 首版页面范围

沿用 `hiveward/web` 的 React SPA、TanStack Query、`hiveward/shared/api.ts` 和机器 scoped 请求，不另做一套业务数据层；新增移动单栏壳和明确深链。

| 优先级 | 页面          | 复用                                                         | 必做改造                                                        |
| ------ | ------------- | ------------------------------------------------------------ | --------------------------------------------------------------- |
| P0     | 连接/设备登录 | 配对确认视觉、`/401` 错误样式                                | 新 pairing/login 路由、宿主选择、401 return URL、撤销后的失效页 |
| P0     | 待办/交活复核 | `DecisionList/Card`、`AskStack`、`QuestionCard`、`ReviewBar` | 独立轻量查询；`decision/task` 深链；一次一张卡、大触摸区        |
| P0     | 任务          | `TaskFeed`、汇报全文、状态/复核                              | 从完整 `Workbench` 抽出；服务端 limit/cursor；任务详情 URL      |
| P0     | 对话          | `AgentConsole/ChatView`、send/interrupt、会话提问            | 单栏顶栏、键盘/安全区、按打开页面加载；真终端可后置             |
| P0     | 文件查看      | `FileViewer`、文本/Markdown/图片/PDF/媒体、Range             | `machine+root+path` 可寻址路由；首版只读/下载，不做编辑器       |
| P1     | 架构信息      | topology 数据                                                | 先做只读业务→Agent→状态列表；不搬可缩放画布                     |

首版不做机器配对管理、设置、文件写入、终端创建/关闭和完整桌面工作台。所有新界面文案仍用 `tr('中文原文')`，同步补 `hiveward/web/src/lib/i18n-en.ts`。

当前任务路由也会挂整套 Workbench 查询，首页还轮询 overview/topology/tasks/decisions/terminals；移动端应只请求当前页数据，否则弱网流量和耗电都不可接受。文件路径、任务展开和决策目前多是组件 state，必须先有可定位 URL，推送点击才有落点。

## 6. 手机网页传输、鉴权与弱网

### 6.1 三条实现路径的选择

| 路径                                                            | 中转明文边界                                    | 代价                                                              | 结论                                           |
| --------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------- |
| A. 纯 TCP Relay，桌面终止 HTTPS/WSS                             | 不可见；静态 JS 也从桌面经 TLS 来               | 每台桌面需要浏览器可信证书、SNI 路由和防恶意 Relay 取证的 DNS/CAA | **推荐**，保留 HiveWard HTTP、Range、媒体和 WS |
| B. 浏览器跑 Runtime E2EE，经现有 WSS Relay，再新增 HiveWard RPC | 业务 RPC 可对中转不可见，但要另保护静态 JS 来源 | outer relay/resume、浏览器存储、HiveWard RPC、文件/媒体流都要适配 | 仅作 A 受阻时的备选                            |
| C. Relay 终止 HTTPS，再转发桌面                                 | **全部业务明文可见**                            | 基础设施最简单                                                    | **排除**                                       |

当前仓库的 Runtime Web 浏览器代码在本地 `main` ref 中，HiveWard 分支没有 `src/renderer/`；可复用的是共享 E2EE、配对和桌面 RPC 思路，不能说手机浏览器 Relay 已经现成。尤其 Runtime scope Relay offer 被禁止，浏览器 direct handshake 也没有 invite/resume/director 流程。

推荐 A 的必要条件：

- 每台桌面使用独立公网 FQDN，例如 `<machine>.nodes.relay.example.com`，A/AAAA 指向 Relay；手机 URL 不使用 IP。
- Relay 新增原始 TCP/SNI 入口，只按预先授权的固定 `SNI → Machine.id/宿主反向流` 映射转发，不允许客户端指定任意上游，也不能终止桌面这条 TLS。
- 控制面 WSS 与网页若共用 443，必须使用不同 SNI：Relay 只终止控制面域名 TLS，桌面域名始终原样转发。每个浏览器连接有独立逻辑流、背压、半关闭、超时和并发/带宽配额。
- 桌面新增仅供远程网页的 HTTPS/WSS listener，不复用自签 LAN 证书直接给浏览器。
- 每台桌面只持有自己主机名的证书私钥，通过**窄权限 DNS-01 委派**签发/续期；Relay 和 DNS 凭证分离，不能让 Relay 或所有桌面共享 wildcard 私钥。
- 权威 DNS 必须为主机名配置 CAA：只允许指定 CA，并将验证方式限制为 `dns-01`；CA 支持时再绑定 `accounturi`。否则恶意 Relay 控制 A/AAAA 和 443 后可自行回答 TLS-ALPN-01，取得公开受信证书并解密业务，单靠“桌面终止 TLS”不能抵御这种失陷。
- 手机 URL 始终使用 HTTPS；pairing token 放 fragment，导入后立刻 `history.replaceState` 清掉。
- 静态 bundle、API、文件字节、WebSocket 都由桌面同源提供。若 JS 由不可信中转托管，即使 RPC 有 E2EE，恶意 JS 仍能偷走全部数据。

### 6.2 手机 Device 身份与会话

复用现有 Runtime `DeviceRegistry` 的 `deviceId/scope/grants/revision`、活动连接撤销，以及 Runtime Web 的不可导出 Ed25519 WebCrypto 私钥/IndexedDB 思路；不把手机塞进 LAN `peers.json`。

建议配对与登录流程：

1. 桌面本机 UI 生成短期、一次性手机邀请，二维码包含桌面 HTTPS URL、`Machine.id`、pinned Runtime 公钥和 invite；敏感参数只放 fragment。
2. 手机打开桌面经 Relay 提供的 HTTPS 页面，展示电脑名和 SAS/确认信息；用户在本机桌面和手机两边确认。
3. 浏览器生成设备签名私钥；桌面发随机 challenge，浏览器签名绑定 `challenge + origin + Machine.id + inviteId + publicKey`，验签后才把一次性邀请换成 `Device{id, hostMachineId, kind:'phone-browser', publicKey, revision}`。不支持安全持久化时只给 tab-session，不假装长期安全存储。
4. 桌面签发 **Secure + HttpOnly + SameSite=Strict** 的短期 session cookie，并绑定 deviceId/revision；写操作校验 Origin + CSRF。cookie 让 JSON、图片/PDF/下载和 WS 都能同源鉴权，不把 token 放进 URL/localStorage。
5. session 到期时由持久设备密钥签署新 challenge 并轮换 cookie；每次续期和请求都检查 `deviceId/revision/revoked`。tab-only 会话过期后重新配对，不自动恢复长期身份。
6. 桌面远程入口只代理手机 API 白名单：待办、任务、对话、复核、只读文件和必要终端流。默认拒绝 `/api/app/*`、机器管理、组织邀请、未授权 `/api/m`、文件写入和高权限 Runtime 方法；允许的单跳远程访问也必须来自 Device 的 delegated grant。
7. Relay/connector 不保管 LAN Bearer 或 HiveWard runtime authToken；桌面远程入口内部使用本机已有通道，并再次检查 Device 权限。

现有本机 bridge 只靠 loopback + Host/Origin 白名单，没有用户登录；`hiveward/web/src/routes/_authenticated` 也只是命名。新远程 listener 必须单独鉴权并保留现有 guard，不能通过关闭 Host/Origin 检查来“适配手机”。

### 6.3 离线、弱网与重连

首版语义：**读最后已知状态，写必须在线且结果明确。**

- 加 manifest、图标和最小 service worker，缓存版本化 app shell；业务快照按 device+machine 隔离并带 `collectedAt`，离线显示“最后更新于…”，不能把空响应当“没有任务”。
- 离线业务快照会增加丢手机后的本地泄漏面；默认只缓存壳，快照由老板显式开启，登出/下次发现撤销时清除。远程撤销不能擦除已经离线的手机存储。
- 不做隐式离线写队列。send/review/resolve 若响应不明，先重取服务端状态再允许重试；后续写操作加 request id/幂等键。
- 移动首页使用摘要响应和 limit/cursor；对话、屏幕、文件只在打开后加载，按页面可见性/前后台降频。
- 终端 WS 可复用现有指数退避和 snapshot 恢复；普通业务请求应有超时、取消和可见重试，不能沿用桌面高频全量轮询。
- 文件继续用 Range/chunk；首版上传/编辑不承诺断点续传或离线草稿。

## 7. 推送：优先 PWA Web Push

### 7.1 原生 APNs/FCM 需要什么

现有 `cloud/apps/push` 是原生 App 推送网关，不是现成 Web Push 服务：

- 手机通过 Expo 获取原生 APNs/FCM token并交给桌面；桌面用同一 X25519 host key 回答 challenge，换 24 小时 gateway session，再注册/删除设备和请求发送（`cloud/README.md:36-53`）。
- APNs：Apple Developer 的 `.p8` key、Key ID、Team ID、bundle ID/topic、entitlement 和 device token；gateway 用 HTTP/2 直连 Apple（`cloud/apps/push/src/config.ts:18-32,65-84`、`apns-client.ts:8-42`）。
- FCM：Firebase/Google 项目、匹配包名的 `google-services.json`、FCM HTTP v1 和 Google service account/OAuth；发送还有 collapse-key/离线合并限制（`fcm-client.ts`、`fcm-access-token.ts`）。
- 即使只做 iOS，当前 Push schema 仍要求 `HIVEWARD_PUSH_FCM_PROJECT_ID`；这是上游实现细节，不应带进新的纯 Web Push 设计。

这条路要求原生壳和相应开发者账号，不符合“不用 HiveWard React Native App”，本方案不采用。

### 7.2 Web Push 能否替代

**对“加到主屏的 HiveWard 网页”，可以作为首选；不能承诺等同原生 App 的所有后台行为。**

- iOS/iPadOS 16.4+ 支持主屏 web app 的 Web Push；需要 manifest、standalone 显示、service worker、用户主动授权，普通浏览器标签页不能按同样方式使用。
- 标准 Web Push 使用 VAPID 和浏览器返回的 subscription endpoint/keys。开发者不直接申请 APNs `.p8` 或自建 FCM 项目，也不需要付费 Apple Developer 账号；底层仍依赖 Apple/Google 等浏览器推送基础设施。
- 本轮未联网查平台最新文档，也未做真机测试；实施时必须用目标 iOS/Android 版本验证安装、授权、杀进程后投递、点击深链和撤销。
- 桌面离线时无法产生新通知；推送只能提示“回电脑取详情”，不是把任务真相搬到推送服务。

### 7.3 符合“服务器只转发”的通知链

```text
执行端发现 completed + awaiting / 新老板决策
  → 本机持久 notification outbox（去重、revision）
  → 桌面直接用 Web Push 加密发送到该手机的 subscription endpoint
  → service worker 展示泛化通知
  → notificationclick 打开 task/decision 深链
  → 手机经端到端 HTTPS 回桌面取详情
```

- 每台桌面生成并保管 VAPID 私钥和订阅，经手机已鉴权 HTTPS 注册/退订；**不必经过自有 Relay，也不复用会保存通知正文的 cloud/apps/push 队列**。
- service worker 处理 `pushsubscriptionchange`，应用启动时核对并续订；桌面收到 404/410 等永久失败时停用旧订阅并要求重新注册。重注册仍需 Device 鉴权，不能把旧订阅迁给另一设备。
- 桌面只向合法 HTTPS 公网推送 endpoint 发请求，优先按浏览器服务商 allowlist；禁止 loopback/私网目标和重定向，避免订阅接口变成任意出站 POST/SSRF 通道。
- payload 只放不透明通知 ID、目标 URL 和泛化标题，例如“HiveWard 有新的待办”；汇报正文、文件内容不放进 Apple/Google 可见的通知。
- 用 `deviceId + taskId + reviewRound + eventRevision` 去重；撤销设备时删除订阅、停止后续发送并关闭通知 session。
- 前台轮询仍是兜底；Web Push 只负责提醒，不作为业务状态来源。

## 8. 安全：中转被攻破与手机丢失

### 8.1 中转被攻破的最坏结果

在推荐的端到端 TLS 设计下，恶意 Relay 仍能：

- 拒绝服务、丢包、延迟、重放密文、切断某台电脑/手机；
- 观察 IP、SNI/机器路由 ID、在线时间、连接数、流量大小和通信对；
- 枚举/暴力尝试外层注册或邀请，消耗配额；
- 如果实现错误地让它终止 TLS 或托管可替换的 JS，则进一步读取/篡改所有业务数据——所以这两种实现被明确禁止。

它**不应能**（浏览器路径以桌面控制 DNS-01 且 CAA 禁止其他验证方式为前提）：

- 读取任务、对话、文件、LAN Bearer、设备 cookie 或复核内容；
- 在没有桌面私钥/有效证书时冒充桌面，或在没有内层设备授权时完成 RPC；若 CAA/DNS 控制缺失，恶意 Relay 可自行申请受信证书，这条保证不成立；
- 通过修改 `Machine.id` 路由声明取得组织成员资格；最终信任仍由 LAN pin+Bearer+SAS 或桌面 Device session 决定；
- 仅凭 Relay 数据库中的 token hash 恢复长期业务凭据。

现有 HiveWard Relay 的 E2EE 边界也遵循类似结论，但其 Push 例外必须记住：通知正文会经过 Push gateway。新设计把 Web Push 发送移到桌面，消除自有中转这一副本。

上线前必须有主动攻击测试：Relay 替换/注入/重放字节、伪造 host/device ID、错误证书、过期/撤销邀请、恶意 Origin、大包和慢流；还要模拟恶意 Relay 尝试 ACME 取证，确认 CAA/DNS 策略能拒绝。任何 bearer/cookie 在 pin/证书校验前发出都视为失败。

### 8.2 手机丢失后的撤销

权威动作在桌面，不是在手机上“删除主机”：

1. 老板在桌面设备列表选择撤销；桌面持久化 device revision/revoked 状态，立即拒绝 cookie、设备签名和 RPC，并关闭活动 socket。
2. 删除该设备的 Web Push 订阅，清理通知 outbox 中尚未发送项；若还有 Relay 外层 resume 凭据，进入持久 revoke outbox。
3. 清理该手机对应的 delegated child grant，避免它继续经主机访问其他电脑；LAN 电脑成员关系不变。
4. 若一台手机配对过多台电脑，首版逐主机撤销；后续可按稳定 phone public key 做全主机撤销 fan-out，但不能宣称单主机 API 已经是组织级即时撤销。
5. 手机本地清理只是配合。设备离线时已缓存的网页/快照无法远程擦除，所以首版默认不缓存业务正文，并建议系统锁屏/设备加密。

现有 `revokeMobileDevice()` 已有“持久撤销 + relay/push outbox + 删除 registry + 终止活动连接”的参考实现（`src/main/runtime/runtime-rpc/runtime-rpc-mobile-devices.ts:15-41`），应复用语义而不是另写只删 UI 记录的撤销。

## 9. 分步实施计划

工作量是有现有代码可复用前提下的人日粗估，不含购买/注册账号、等待证书或跨团队审批；每一步都要先通过本机隔离测试，再做真实双机/真机验收。

### 第 0 步：Tailscale 过渡（1–2 人日，生产代码可为 0）

**改动文件**

- 新增或更新一份操作 runbook；若允许并入本文，则只补本文的命令和验收记录。
- 可选：`hiveward/server/hiwd.mjs` 增加只读邀请列表/SAS 输出及测试；不是网络互通的前置条件。

**验收**

- 一台真实 Mac、一台真实 Windows 位于不同物理网络，只通过 Tailscale 地址互访。
- 禁止/屏蔽 UDP 18889 后，手动 invite 仍成功；两屏 SAS 相同，错误证书/错误核码被拒绝。
- 双向 `new/tell/read/review`、任务状态、文件流、终端 WSS 正常，执行端数据和真相不搬到 Mac。
- 移除成员后在线连接立即拒绝；离线成员恢复后收到撤销，`pendingRemovals` 最终归零。
- 防火墙只允许 8788/8789；没有公网端口映射，没有访问 Stably/HiveWard 官方服务。

### 第 1 步：自建单节点 Relay，先打通电脑（8–13 人日）

**1A：单机运行时与自有配置（2–3 人日）**

- 复用 `cloud/apps/relay/Dockerfile`、`config.ts`、`app.ts`、`relay-server.ts`、`host-session-registry.ts`、`splice-forwarder.ts` 和 `cloud/packages/relay-contract`。
- 增加单机部署样例/compose（拟新增，只使用 combined+SQLite）；反代支持长连接、背压、健康检查、持久卷和资源上限。
- 在 `src/main/hiveward-profiles/profile-cloud-auth-config.ts`、`src/shared/hiveward-product.json` 附近增加“自有 Relay only”配置，保留 `hiveward-policy.ts` 官方域名阻断。
- 若不采用 HiveWard 账号，新增窄的 Relay host enrollment/token 验证，绑定 `machine.json.id` 和桌面公钥；不要伪造一套 cloud profile/org/capabilities。

**1B：通用密文字节流与 LAN 适配（4–6 人日）**

- 在 Relay 契约中新增逻辑 byte lane：stream id、目标 Machine.id、generation、open/close/half-close、背压、配额和错误码；复用 splice，不解析 TLS 内容。
- 拟新增 `hiveward/server/lan-relay.mjs`，维护本机出站控制流、重连和逻辑 endpoint。
- 改 `hiveward/server/lan-tls.mjs`、`lan.mjs`：让 `pinnedRequest`、HTTP forward、WSS 能在 Relay Duplex 上继续跑原有 TLS；pin 成功前不得发送 Bearer。
- 改 `lan-organization.mjs`：邀请回调不再从 `remoteAddress` 猜地址；明确 direct/relay endpoint。
- 改 `hiveward/shared/api.ts` 只暴露传输状态/逻辑 endpoint，不新增第二套机器 ID。
- 改 `hiveward/desktop/engine.mjs` 和必要的 `src/main/hiveward/bridge-service.ts` 启动/停止 Relay client，沿用同一数据目录和机器身份。

**1C：攻击与故障测试（2–4 人日）**

- 测试放在 `cloud/apps/relay/src/*test.ts`、`hiveward/server/lan-relay.test.mjs`（拟新增）、现有 `lan-tls/lan-organization/terminal-websocket` 测试。
- 覆盖断线重连、桌面睡眠恢复、大文件、长 WSS、半关闭、慢客户端、重复 stream/generation、撤销、Relay 重启和 SQLite 恢复。
- 主动 MITM Relay 只能造成拒绝/断流，不能取得明文或冒充认证 peer。

**验收**

- 无 Tailscale、无公网入站端口的两台电脑，经唯一自有 VPS 完成邀请/SAS、`/api/m`、文件和 WSS。
- 在 Relay 抓包只能看到 TLS 密文和路由元数据；数据库没有 LAN token、任务、对话或文件正文。
- 关闭 Relay 不影响同 LAN 直连；恢复后队列不重复执行写操作。
- 全量运行 cloud 测试、相关 `hiveward/server` 测试和 Mac/Windows 实机验收；确认没有官方域名请求。
- 单机容量先做基线压测再定 VPS 规格；本调研不承诺具体并发数。

### 第 2 步：手机网页/PWA（14–22 人日）

**2A：浏览器 TLS 入口与 Device 鉴权（6–9 人日）**

- Relay 新增 SNI/raw-TCP web lane，复用第 1 步宿主注册和流状态机；固定授权 SNI 映射，增加公网 443 的每宿主连接/带宽配额。控制面和桌面域名分流，Relay 不终止桌面 TLS。
- `hiveward/server/hiveward-bridge.mjs` 或拟新增独立 remote-web listener：桌面终止 HTTPS/WSS、同源托管 `hiveward/web`、校验 Device session 和 API allowlist；不暴露现有开发 debug 路由。
- 增加每桌面 DNS-01 证书申请/续期，DNS 凭证只授单主机 TXT 权限且私钥只留桌面；配置 CAA `dns-01`（CA 支持时加 `accounturi`）。先用测试域名验证续期和恶意 Relay 取证失败；无法落实该边界就停止 A，重新评估 E2EE RPC 备选。
- `src/main/runtime` 复用 DeviceRegistry、设备签名和撤销；`hiveward/server` 增加 phone-browser device/session 的窄适配和过期/CSRF 检查。
- `hiveward/shared/api.ts` 定义 pairing、session、revoke、移动摘要和深链所需契约；不暴露 LAN Bearer。

**2B：移动单栏页面与深链（5–8 人日）**

- 改 `hiveward/web/src/components/layout/app-shell.tsx`、相关 Rail/SidePanel，加移动单栏壳和底部/顶部主导航。
- 改 `features/workbench/task-feed.tsx`、`features/decisions/*`、`features/live/*`、`review-bar.tsx`，抽出不依赖完整 Workbench 的待办/复核/任务/对话页面。
- 改 `features/files/file-viewer.tsx` 和路由，新增 `machine/root/path`、`task/decision/session` 深链；文件首版只读。
- 在 `hiveward/server/business-routes.mjs` 等现有入口增加移动摘要、limit/cursor 和权限过滤，不为手机复制业务数据库。
- 新文案全部 `tr()` 并补 `i18n-en.ts`；390px、430px、横屏和桌面回归都验收。

**2C：PWA 与弱网（3–5 人日）**

- 改 `hiveward/web/index.html`，新增 manifest/icons/service worker；只缓存可信静态壳，业务快照默认关闭。
- 改 `hiveward/web/src/main.tsx`、Query/API 层：401 回登录、请求取消、可见重试、最后更新时间和前后台降频。
- 拟新增手机路由与弱网测试；离线写一律不自动重放。

**验收**

- 手机不安装 HiveWard App，扫码/链接配对后加到主屏；重启浏览器仍只能访问已授权宿主和设备。
- Relay 抓包看不到 JS 业务响应、cookie、对话、复核和文件明文；替换 JS/证书会失败，恶意 Relay 的 ACME 取证也被 CAA/DNS 边界拒绝。
- 390px 下无被左栏挤压的内容，复核、答复、对话、下载可单手完成；桌面原 UI 不回归。
- 断网重连不会重复派单/复核；离线明确陈旧状态，登录失效和撤销后不能继续请求。
- 丢手机演练：撤销后已有 WS/HTTP 立即失效、 delegated 访问失效、推送停止；文档明确离线缓存不可远程擦除。
- iOS Safari 主屏和 Android Chromium 各做真实安装/鉴权/文件/WS 验收；桌面 HTTPS 证书自动续期不中断配对。

### 第 3 步：Web Push（4–6 人日）

**改动文件**

- `hiveward/server`：在现有 awaiting/review 观察点接独立老板通知 outbox；拟新增 `web-push.mjs`/订阅存储，复用 revision 和撤销语义，不复用会丢弃 owner 的 Agent-wake 分支。
- `hiveward/shared/api.ts`：订阅、退订、测试通知和深链契约。
- `hiveward/web`：service worker 的 `push`/`notificationclick`、权限引导、主屏安装说明和设置项；文案补中英文。
- 桌面端安全保存 VAPID 私钥；每台电脑直接向订阅 endpoint 发送，不经自有 Relay 保存正文。

**验收**

- 真实交活/提问只产生一条通知；杀进程/弱网恢复后点击落到正确 task/decision，重复点击不重复执行写操作。
- 通知不含汇报正文、文件内容或 LAN/device 秘密；Relay 数据库没有通知 payload。
- iOS 主屏 web app 和 Android PWA 验证授权、投递、折叠、点击、退订；不支持的平台仍可靠前台轮询。
- 撤销设备后不再发送；桌面离线时不产生虚假“已送达”。

## 10. 实施时的统一检查与未决验收

代码阶段按仓库规矩执行：

```bash
export PATH="$HOME/hiveward/.hiveward-tools/node_modules/.bin:$PATH"
cd ~/hiveward/hiveward/web && npx prettier --write src && npx tsc -b && npx eslint src --quiet
# 后台：对改过的 .mjs 执行 node_modules/.bin/oxfmt，并跑相关隔离测试
cd ~/hiveward && HIVEWARD_BACKGROUND_LAUNCH=1 pnpm check:code-quality:changed HEAD
```

本轮只新增本文和 `/tmp` 截图/脚本/日志。`lan-tls.test.mjs` 与 `lan-organization.test.mjs` 在 `/tmp` 隔离数据目录运行，结果为 `tests 12 / pass 12 / fail 0`；完整输出在 `/tmp/relay-mobile-lan-tests.log`。没有运行会写生产数据的测试，没有连接 Anthropic、OpenAI、GitHub、Stably/HiveWard 官方服务，也没有部署、注册账号或产生费用。

仍需在实施时验证、不能由源码调研代替的事项：

1. 真实 Tailscale Mac↔Windows 双向邀请、防火墙、撤销和 WSS。
2. 单 VPS 的容量、长时间连接、NAT/运营商网络和证书续期。
3. 每桌面窄权限 DNS-01、证书续期，以及 CAA 能否在选定 CA 上强制 `dns-01`/`accounturi`；这是推荐路径 A 的第一个安全验证点，未通过就不能承诺恶意 Relay 不可见明文。
4. iOS/Android 的目标版本、主屏安装、Web Push 后台行为和丢失设备场景。
5. 当前工作区有并行改动，实施前需重新读取相关文件，不能按本文行号盲改。
