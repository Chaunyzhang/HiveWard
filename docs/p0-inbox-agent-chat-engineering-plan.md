# P0 收件箱 Agent 对话工程文档

## 一句话目标

P0 要先把“收件箱里的每一封邮件”升级成有回复和讨论能力的底层线程。上层业务只负责往收件箱投递不同邮件：第一个 Agent 可以在任务说明缺失时发邮件提醒用户补齐用户提示词；后续任何勾选人工审批的 Agent 也可以主动发邮件，把流程停在它这里和人沟通。用户在同一套收件箱讨论界面里回复；如果这封邮件绑定到某个 Agent，平台就按该 Agent 节点已经配置好的 harness、模型、权限、skill、工作目录继续同一个 discussion session，流式输出普通讨论回复；用户明确点击“使用此方案”后，该 assistant 回复才成为候选方案，再批准时后续蓝图才继续跑。

这不是 skill 生成器，也不是外挂 skill runtime。HiveWard 仍然只是组织 Agent 使用各自挂载的 skill，并把上下游产物、人工判断和运行状态传递好。

## P0 范围

P0 包含三件事，按实现顺序排：

1. **收件箱底层讨论线程**：每一封收件箱邮件都有统一的回复、讨论、消息持久化和流式显示能力。不是某些邮件有对话、某些邮件没有对话。
2. **运行页只读实时输出**：蓝图运行页增加“实时工作”视图，展示节点正在做什么。运行页不允许对话，只展示流式状态和输出。
3. **上层邮件投递场景**：启动蓝图时如果没有本次任务说明，第一个 Agent 发一封提醒用户填写用户提示词的邮件；流程中任意勾选人工审批的 Agent 也可以发邮件请人判断、补充、选择或批准。

暂不包含：

- 做 skill 生成器、skill 拆解器或新的 skill contract runtime。
- 为并行候选做一套独立选择系统。并行候选优先通过蓝图里的汇总 Agent + 现有可选产物机制解决。
- 把“回复邮件”隐式等同于“批准邮件”。讨论和生命周期动作必须分开。

## 当前代码事实

### 已经有的基础

- 审批线程模型已经存在：`ApprovalThread`、`ApprovalRequest`、`ApprovalReply`、`ApprovalDecision` 在 `packages/shared/src/lifecycle.ts`。
- 收件箱前端已经是聊天形态：`ApprovalsPage` 和 `InboxConversationPanel` 在 `apps/web/src/components/WorkspacePages.tsx`，已有消息列表、输入框、pending 占位和“使用此方案”按钮。
- 普通 inbox item 已经有 `replies` 字段，说明“邮件可回复”不是只属于 approval request；只是现在普通 inbox item 的回复还不是统一 discussion runtime。
- 审批回复已经能显示到收件箱：`apps/web/src/lib/run-state.ts` 会把 `approvalReplies`、`approvalDecisions` 和 node output 里的 replies 合并成 `PendingApprovalItem.replies`。
- 节点审批等待状态已经保存候选回复：`AgentApprovalWaitingOutput` 在 `apps/api/src/worker/blueprintWorker.ts`，字段包括 `reviewOutput`、`replies`、`selectedReplyId`、`selectedOutput`。
- Agent 节点已经有人工审批配置；worker 的 `waitForAgentApproval(...)` 会把节点输出转成 `agent_proposal` approval request，并让 run 进入 `waiting_approval`。这说明“后续 Agent 主动发邮件给人看”这条产品路径已经有雏形。
- 选用方案已经存在：`selectApprovalReply` 会把某个 assistant reply 标为选中；批准时 `approveRun` / `applyApprovalRequest` 会把选中的内容送入后续流程。
- 普通聊天页已有流式能力：`streamHivewardChatSession` 在 `apps/api/src/routes/apiRouter.ts` 使用 `adapter.streamChatMessage`，前端 `ChatPage` 使用 `api.streamSessionChat` 消费 `ChatStreamEvent`。
- SDK/CLI runtime 已经有聊天流事件：`packages/adapter/src/sdk-runtime/*` 的 `streamChatMessage` 能发 `started`、`runtime_state`、`delta`、`done`。
- 蓝图运行页已经有 trace/timeline 基础：`BlueprintRunView.runTimeline`、`RunTimelineItem`、`appendRunTimelineItem` 已存在。

### 现在缺的关键点

- 当前收件箱 `reply` **不是对话执行**。`POST /api/approval-requests/:id/reply` 和 `POST /api/blueprint-runs/:runId/reply` 最终只走 `recordPendingReply` / `recordAgentApprovalComment`，它们只记录用户留言，不会调用 Agent。
- 当前收件箱还没有统一的 `InboxConversationThread` 抽象。前端通过 `kind: "approval" | "inbox"` 拼出一个会话视图，但后端事实仍分散在 `approval_threads`、`approval_replies`、`inbox_items.replies`、node output replies 里。
- `buildAgentApprovalReplyInput(...)` 已经写好了“人和 Agent 在审批暂停点继续开会”的输入结构，但当前回复路径没有真正用它去跑 Agent。
- 蓝图节点执行路径 `runAgentTask(...)` 目前是 `adapter.startAgentTask(...)` 后 `adapter.waitForAgentTask(...)`，只能拿最终结果，没有把 runtime 的 `delta` / `runtime_state` 传出来。
- 聊天页的流式 API 是 chat-session 级别，缺少 node task 的完整配置：`RuntimeChatStreamInput` 没有 `workingDirectory`、`tools`、`outputSchema`、完整 node input 等字段，不能直接替代蓝图节点执行。
- 启动 run 的 API 目前只有 `StartBlueprintRunRequest.startedBy`，`BlueprintRun` 也没有 run-level 用户提示词字段。

## 设计原则

1. **收件箱讨论是底层能力**  
   每一封邮件默认都有讨论线程和回复框。业务层只能决定“为什么发这封邮件、发给谁、是否需要批准、批准后怎么恢复流程”，不能决定“这封邮件有没有基本对话能力”。

2. **不要破坏现有 reply 契约**  
   `docs/approval-thread-contract.md` 明确规定 `reply` 是 message-only，不能隐式调用 harness、推进生命周期或重跑。P0 必须新增收件箱讨论 stream；如果邮件绑定 Agent，再由这个 stream 路由到 Agent 执行，而不是把 `/reply` 改成执行 Agent。

3. **对话绑定邮件线程，执行绑定邮件来源**  
   UI 层只知道当前在回复哪一封邮件。后端根据邮件来源解析讨论目标：Agent 节点邮件路由回对应 Agent；普通 inbox item 至少保存讨论；后续可路由到 Leader/CEO/Manager。收件箱里不显示 harness、模型、模式、角色、权限、思考强度等配置。

4. **平台只负责路由和状态，不替 Agent 写结论**  
   平台可以保存消息、运行状态、候选、选择和批准动作；Agent 输出什么、如何解释、是否形成报告，仍然由该节点 Agent 的 prompt、skill 和输出 schema 决定。

5. **聊天动作不等于候选或批准动作**  
   和 Agent 聊完只会产生新的 discussion assistant message。只有用户点击“使用此方案”时，该 assistant message 才成为当前候选；只有用户再点击“批准”，下游才继续。

6. **第一个 Agent 问需求只是上层投递场景**  
   run-level 用户提示词缺失时，第一个 Agent 发邮件提醒用户补齐任务说明；后续节点勾选人工审批时，对应 Agent 也可以发邮件请人判断、补充、选择或继续沟通。它们都使用同一个收件箱讨论底座。

## 后端方案

### 1. 新增 inbox-thread-bound stream API

新增接口：

```text
POST /api/inbox/threads/:threadType/:threadId/messages/stream
```

请求：

```ts
type InboxThreadType = "approval" | "inbox";

interface StreamInboxThreadMessageRequest {
  message: string;
}
```

响应复用现有 SSE 事件：

```ts
type StreamInboxThreadMessageEvent =
  | ChatStreamEvent
  | { type: "inbox_message_created"; messageId: string; threadType: InboxThreadType; threadId: string }
  | { type: "inbox_candidate_created"; replyId: string; threadType: InboxThreadType; threadId: string };
```

为什么新增路由：

- 收件箱讨论能力属于所有邮件，不属于某一个 approval kind。
- 保留 `/reply` 的留言语义。
- 前端不用判断“这封邮件有没有对话”，只需要把当前邮件线程发给统一讨论 API。
- 后端根据邮件来源决定是只保存讨论，还是继续调用绑定的 Agent/role。

### 2. 新增 worker/service 方法

建议新增一个收件箱讨论服务，`BlueprintWorker` 提供 Agent 节点邮件的执行入口：

```ts
streamInboxThreadMessage(input: {
  threadType: "approval" | "inbox";
  threadId: string;
  message: string;
  onEvent: (event: ChatStreamEvent) => void;
}): Promise<{
  threadType: "approval" | "inbox";
  threadId: string;
  userMessageId: string;
  assistantMessageId?: string;
}>;
```

当 thread 解析为 Agent 节点邮件时，内部再调用：

```ts
streamAgentMailDiscussion(input: {
  blueprint: BlueprintDefinition;
  run: BlueprintRun;
  approvalRequestId: string;
  message: string;
  onEvent: (event: ChatStreamEvent) => void;
}): Promise<{
  run: BlueprintRun;
  userReply: AgentApprovalReply;
  assistantReply?: AgentApprovalReply;
}>;
```

它负责：

1. 校验这封邮件仍允许讨论。
2. 先把用户消息保存进底层收件箱讨论线程。
3. 如果邮件没有绑定可执行 Agent/role，返回已保存消息，不推进生命周期。
4. 如果邮件绑定到 `agent_proposal` / `run_user_prompt` 对应的 Agent 节点，从 run archive 取 blueprint snapshot，找到对应 agent node。
5. 找到当前 `waiting_approval` 的 node run，确认 output 是 `AgentApprovalWaitingOutput`。
6. 同步追加用户消息到 Agent approval replies：
   - 写入 `approval_replies`，actor 为 `user`。
   - 同步写入 node output 的 `replies`，role 为 `user`。
7. 使用现有 `buildAgentApprovalReplyInput(originalInput, reviewOutput, replies, userReply)` 生成本轮对话 input。
8. 找到或创建该收件箱 thread 绑定的 discussion chat session，并把底层 harness 返回的 `nativeSessionId/sessionKey/threadId` 保存到 thread 的 discussion session 字段。
9. 使用节点原配置解析本轮讨论目标：
   - `source` 来自本次节点运行的 runtimeRef，缺失时使用 `node.runtimeId`
   - `agentId` / `profileId`
   - `modelId`
   - `permissionProfile` / `runtimeAccessPolicy`
   - `skillIds`
   - `prompt` 使用同一套 `resolveAgentPrompt(...)`
10. 调用 `adapter.streamChatMessage(...)`，如果 discussion session 已有 `nativeSessionId`，必须作为 `sessionKey` 传入，以 resume 同一个底层 harness session。
11. 把 `started` / `runtime_state` / `delta` / `done` 直接写给 SSE，前端按聊天页方式实时追加。
12. 成功后追加 assistant discussion reply：
   - 展示正文优先使用 `AgentOutputEnvelope.humanReportMd`
   - 没有 `humanReportMd` 时使用字符串输出
   - 再没有时格式化 JSON
   - 原始输出放进 `ApprovalReply.metadata.agentOutput`，不要丢
   - 同步写入 node output 的 `replies`，role 为 `assistant`
13. 调用 `migratePendingNodeApproval(...)` 刷新 approval body 和 ManagerMail 投影。
14. 不自动 approve，不自动 reject，不自动 select，不自动把普通 assistant reply 标成 candidate，仍然等待用户点击“使用此方案”或其他生命周期动作。

### 3. 收件箱 discussion session 生命周期

收件箱普通讨论不能把每轮回复实现为新的独立 `streamAgentTask`。每个可聊天 approval thread 至少要保存：

```ts
threadType: "approval" | "inbox";
threadId: string;
harnessId: HarnessId;
agentId?: string;
modelId?: string;
nativeSessionId?: string;
nativeSessionState?: "unknown" | "resumable" | "missing";
status: "active" | "ended" | "failed" | "native_missing";
createdAt: string;
updatedAt: string;
```

第一轮讨论没有 `nativeSessionId` 时创建或启动新的底层 chat session；后续同一封邮件必须优先用该 `nativeSessionId` resume。若 resume 失败，标记 `nativeSessionState = "missing"` 与 `status = "native_missing"`，并保留 HiveWard 已保存的 discussion history，后续再显式支持 `rebuildFromHivewardHistory`。

### 4. 增加 node task 流式能力

节点正式执行、重做、后台任务仍然可以使用 task 路径。运行页实时输出需要 runtime adapter 保持或扩展：

```ts
interface RuntimeAdapter {
  streamAgentTask?(
    input: StartAgentTaskInput,
    onEvent: (event: ChatStreamEvent) => void
  ): Promise<AgentTaskResult>;
}
```

实现策略：

- `codex-runtime.ts`：把 task 路径从 `thread.run(...)` 改为优先 `thread.runStreamed(...)`，复用现有 chat stream 的 `runtime_state` / `delta` 解析；不支持 streamed 时退回 final-only。
- `claude-runtime.ts`：当前 task 本来就在 `for await` SDK messages，只是没有 emit。把 chat 路径里 `readClaudePartialDeltaText` 和 `toClaudeRuntimeState` 抽成可复用函数，task 路径同步发事件。
- `cli-runtime.ts`：把 `runCliCommand` 支持 `onStdout` 的能力从 chat 路径下沉给 task 路径，复用已有 CLI stream parser。
- `MockRuntimeAdapter`：测试里发固定 `started`、`delta`、`done`。
- `UnavailableOpenClawAdapter`：保持抛错。

如果某个 provider 暂时只能 final-only，也要发：

```text
started -> runtime_state("running task") -> delta(final output, replace=true) -> done
```

这样前端体验一致，但不能伪造中间思考。

### 5. 并发和一致性

同一个 inbox discussion thread 同时只能有一个运行中的 stream。

建议加一个进程内 lock：

```ts
private readonly activeInboxThreadStreams = new Set<string>();
```

如果重复发送，返回 `409 inbox_discussion_in_progress`。P0 先做进程内即可；如果之后多 worker 需要跨进程锁，再落 SQLite process lock。

失败策略：

- 用户消息已经发送成功时保留。
- Agent 失败时写入一个 `ApprovalReply`，actor 为 `system` 或 `agent`，metadata 标记 `status: "failed"`，body 展示错误摘要。
- approval request 保持 pending。
- 不改 selected reply。

## 前端方案

### 1. API client

在 `apps/web/src/lib/api.ts` 增加：

```ts
streamInboxThreadMessage(
  threadType: "approval" | "inbox",
  threadId: string,
  input: StreamInboxThreadMessageRequest,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal
): Promise<void>
```

复用 `consumeChatStreamResponse(...)`。

### 2. 收件箱 UI

改 `ApprovalsPage` / `InboxConversationPanel`：

- 每一封收件箱邮件默认显示同一套讨论区和回复框。
- 发送按钮统一走 `streamInboxThreadMessage(...)`，由后端解析这封邮件背后的讨论目标。
- Agent 绑定邮件会出现 streaming assistant message；普通邮件至少会保存用户讨论消息。
- 发送后本地立即追加 user message。
- 创建 streaming assistant message，按 `delta` 实时更新。
- `runtime_state` 显示为轻量状态，例如“正在运行 Codex / 正在执行命令 / 正在生成回复”。
- `done` 后刷新 run view / approvals / approval threads，让服务端候选和本地消息对齐。
- 保留“使用此方案”和“批准”两个动作，不自动合并。

UI 上不增加：

- 模型选择
- harness 选择
- 角色选择
- 模式选择
- 权限选择
- 思考强度选择
- 蓝图/harness 展示面板

只显示：对话、状态、发送、停止、使用此方案、批准、驳回。是否展示“使用此方案 / 批准 / 驳回”由邮件能力决定，但讨论框是收件箱底层能力。

### 3. 可以抽出的复用代码

`ChatPage.tsx` 里有 `applyChatEvent(...)`。P0 可以把它提到一个小工具里，例如：

```text
apps/web/src/lib/chat-stream-events.ts
```

收件箱只复用事件处理，不复用聊天页的设置 UI。

## 运行页实时输出

### 当前基础

运行页已有 `runTimeline` 和 trace 构建逻辑，`WorkspacePages.tsx` 里会把 `node_started`、`node_output` 等 timeline item 显示出来。但它现在更像最终审计记录，不是实时工作流。

### P0 增量

新增 `RunTimelineItem.kind`：

```ts
| "node_runtime"
```

worker 在 `runAgentTask(...)` 接收到 stream event 时节流写入：

- `runtime_state`：写 `node_runtime`，title 是节点名 + runtime phase，body 是状态描述。
- `delta`：按 nodeRun 聚合到最近一条 `node_runtime`，最多保留最近 N 字符，避免 timeline 爆炸。
- `done`：最后补一条完成状态；最终报告仍然走已有 `node_output`。

前端运行页增加一个标签：

```text
实时工作 | 子节点输出 | 产物 | 审批
```

“实时工作”只读，不提供输入框。它展示：

- 当前正在跑的节点
- runtime 状态
- 最近输出片段
- 失败或取消原因

注意：这个功能不应把最终报告提前当成结果使用。只有节点完成后，`node_output` / artifact / human report 才是正式产物。

## 收件箱底层讨论与上层邮件投递

底层只有一个产品模型：每封邮件都有讨论线程。上层业务只是决定什么情况下创建邮件、邮件来自谁、需要什么动作。

上层第一批邮件来源：

1. **启动前任务澄清邮件**：run 没有 `userPrompt` 时，第一个 Agent 发邮件问清楚本次具体任务。
2. **流程中审批沟通邮件**：任意 Agent 节点勾选人工审批后，节点完成阶段性产物时主动发邮件，请人判断、补充、选择、重写或批准。

统一底层讨论生命周期：

```text
上层业务创建一封邮件
-> 创建 inbox discussion thread
-> run 进入 waiting_approval
-> 用户在收件箱回复和讨论
-> 如果邮件绑定 Agent/role，平台把回复路由给对应执行者
-> 执行者可生成一个或多个 candidate reply
-> 用户可选择 candidate
-> 如果邮件带审批动作，用户批准后平台把选中结果交给下游节点
```

平台只做确定性的事情：创建邮件、保存讨论、保存候选、保存选择、恢复调度。Agent 决定邮件正文怎么写、需要人判断什么、候选结果如何表达。

## 运行级用户提示词

运行级用户提示词是上层业务投递的一种邮件：如果 run 启动时缺少本次任务说明，第一个 Agent 发一封提醒/澄清邮件，让用户在收件箱底层讨论线程里补齐。

### 数据契约

扩展启动请求：

```ts
interface StartBlueprintRunRequest {
  startedBy?: string;
  userPrompt?: string;
  requireUserPrompt?: boolean; // 默认 true
}
```

扩展 run 持久化：

```ts
interface BlueprintRun {
  ...
  userPrompt?: string;
  userPromptSource?: "start_request" | "inbox_agent";
  userPromptCollectedByNodeId?: string;
}
```

SQLite 需要给 `runs` 表加 nullable 字段，file store/archive 也要保存。

### 缺失时怎么问

当 `requireUserPrompt !== false` 且 `userPrompt` 为空：

1. `startRun(...)` 不直接 `scheduleRun(...)`。
2. 找第一个可执行 agent node，作为 input collector。
3. 创建一个新的 approval request kind，建议叫：

```ts
"run_user_prompt"
```

4. 这封邮件归属第一个 Agent，而不是系统；它使用全局收件箱讨论能力，不是单独开一个特殊对话块。
5. 用户在这封邮件里用收件箱回复和讨论能力讲清楚本次任务。
6. Agent 产出“本次任务说明”候选。
7. 用户点击“使用此方案” + “批准”。
8. worker 把选中的文本写入 `run.userPrompt`，然后把 run 置回 `running` 并 `scheduleRun(...)`。

### 注入给后续节点

所有 Agent/Manager 节点输入都应该收到同一份 run-level prompt：

```ts
runContext: {
  userPrompt: run.userPrompt
}
```

Agent prompt 层增加一段明确说明：

```text
Run-level user prompt is the concrete task for this run. Use it as the task brief unless the node-specific input narrows it.
```

这属于 prompt-level 合同，不要用平台代码去改写用户提示词内容。

## 测试计划

### API / worker

- 每一封 approval / inbox 邮件都能通过统一 thread API 追加用户讨论消息。
- Agent 绑定邮件能根据 thread 找到 run、nodeRun、blueprint snapshot 和 agent node。
- Agent 绑定邮件传入的 `StartAgentTaskInput` 包含 node 的 `skillIds`、runtime、model、权限、tools、workingDirectory、outputSchema。
- `/reply` 仍然只留言，不调用 Agent。
- Agent-backed discussion 成功后同时写入收件箱 thread、`ApprovalReply` 和 node output replies。
- assistant candidate 可以被 `selectApprovalReply` 选中。
- 选中 candidate 后 approve，后续节点收到 selected output。
- Agent-backed discussion 失败不关闭 approval，不推进 run。
- 同一个 inbox thread 同时开两个 stream 时返回 409。
- run 缺少 userPrompt 且 requireUserPrompt 默认 true 时，创建 `run_user_prompt` gate，不调度后续节点。
- userPrompt gate 批准后，run 恢复 running，后续节点 input 有 `runContext.userPrompt`。

### adapter

- `streamAgentTask` 对 mock provider 发完整 `started -> delta -> done`。
- Codex task 在支持 `runStreamed` 时发 delta 和 runtime_state。
- Claude task 从 SDK stream 里发文本 delta 和 tool/runtime 状态。
- CLI task 能从 stdout 解析 delta。
- 不支持 stream 的 provider 退回 final-only，但事件顺序仍然稳定。

### web

- 每封收件箱邮件都有统一讨论区和回复框。
- 收件箱 Agent 绑定邮件发送消息后立即出现 user bubble 和 streaming assistant bubble。
- 收件箱流式 delta 能连续更新同一条 assistant message。
- `runtime_state` 能显示为轻量工作状态。
- 完成后出现“使用此方案”按钮，选中后仍需点批准才推进。
- 非 Agent 绑定邮件仍能保存讨论消息，不显示成“没有对话能力”。
- 运行页出现“实时工作”标签，并显示 node runtime item。

### 回归命令

```text
npm run typecheck -w @hiveward/shared
npm run typecheck -w @hiveward/api
npm run typecheck -w @hiveward/web
npx vitest run apps/api/src/worker/blueprintWorker.test.ts
npx vitest run apps/api/src/routes/apiRouter.test.ts --testNamePattern approval
npx vitest run apps/web/src/components/WorkspacePages.test.tsx --testNamePattern ApprovalsPage
npx vitest run apps/web/src/lib/run-state.test.ts
npx vitest run packages/adapter/src/sdk-runtime/sdk-runtime.test.ts
```

## 实现顺序

### P0-A：收件箱底层讨论线程

1. 增加 unified inbox thread API 类型和 web api client。
2. 增加 `/api/inbox/threads/:threadType/:threadId/messages/stream`。
3. 后端把 `approval_threads`、`approval_replies`、`inbox_items.replies` 统一投影成收件箱讨论线程。
4. 前端所有邮件详情页都显示同一套讨论区和回复框。
5. 测试普通 inbox item 和 approval mail 都能追加讨论消息。

### P0-B：Agent 绑定邮件的流式执行

1. 增加 `RuntimeAdapter.streamAgentTask`，先覆盖 mock + 一个 SDK runtime，其他 provider final-only fallback。
2. 增加 `BlueprintWorker.streamAgentMailDiscussion(...)`。
3. `streamInboxThreadMessage(...)` 解析到 Agent 绑定邮件时调用对应 Agent。
4. 收件箱前端接 stream event，复用聊天事件处理。
5. 测试“发消息 -> Agent 流式回复 -> 使用方案 -> 批准 -> 下游继续”。

### P0-C：运行页实时工作状态

1. 扩展 `RunTimelineItem.kind`。
2. worker 在普通节点执行时写入节流 runtime item。
3. 运行页加“实时工作”标签。
4. 保证 final report 和 artifact 仍然走现有正式产物链路。

### P0-D：运行级用户提示词邮件

1. 扩展 `StartBlueprintRunRequest` 和 `BlueprintRun`。
2. 加 SQLite/file store migration。
3. `startRun` 缺 userPrompt 时由第一个 Agent 创建 `run_user_prompt` 邮件，不调度主流程。
4. 复用 P0-A 的收件箱底层讨论和 P0-B 的 Agent 绑定执行来问清楚任务。
5. 批准后保存 `run.userPrompt` 并恢复主流程。
6. 所有节点 input 加 `runContext.userPrompt`。

### P0-E：流程中人工审批邮件对话化

1. 保留现有 Agent 节点 `approval.enabled` 配置。
2. 节点进入 `waitForAgentApproval(...)` 后，邮件正文仍由该节点产物/Agent 输出生成。
3. 这封邮件详情页使用 P0-A 的收件箱底层讨论和 P0-B 的 Agent 绑定执行，不再只是静态报告 + 留言。
4. 用户可以多轮沟通，直到有可选 assistant candidate。
5. 用户选中 candidate 并批准后，下游节点收到选中的结果。

## 最终用户看到的效果

用户启动一个固定蓝图，不用每次重新生成蓝图。

如果没填本次任务，第一位 Agent 会先发一封收件箱邮件问：“这次具体要我处理什么？”用户可以在邮件里连续聊几轮。聊清楚后，Agent 给出一份本次任务说明，用户点“使用此方案”并批准，整条蓝图才开始跑。

流程跑到任何勾选了人工审批的 Agent 节点时，这个 Agent 也可以主动发邮件。用户不会只看到一篇静态报告，而是可以在这封节点邮件里继续问这个 Agent：“这个方案换个角度行不行？”“再给我三个版本。”“这个风险怎么处理？”Agent 会按当前节点挂载的 skill 和配置实时回答。用户满意后选中其中一个回复，再批准进入后续节点。

运行页同时能看到每个节点的实时工作状态：哪个 Agent 在跑、正在调用什么 runtime、最近吐出了什么内容。用户不需要等最后突然出现一篇报告，流程会更像“多个 Agent 正在接力工作”，而不是黑盒等待。
