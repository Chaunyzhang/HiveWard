import { nanoid } from "nanoid";
import type {
  RuntimeAgent,
  RuntimeChannel,
  RuntimeModel,
  RuntimeSessionSummary,
  RuntimeTaskSummary,
  RuntimeTool,
  RuntimeOverview,
  ChatHistoryMessage,
  ChatAttachment,
  ChatPermissionMode,
  ChatStreamEvent,
  ChatThinkingEffort,
  HarnessId,
  HarnessSkillId,
  RuntimeObjectSource,
  SendChannelInput,
  SendChannelResult,
  AgentTaskResult,
  StartAgentTaskInput,
  StartedAgentTaskResult,
  WaitForAgentTaskInput
} from "@hiveward/shared";
import { GatewayOpenClawAdapter } from "./gateway-adapter";
import { resolveGatewayAdapterConfig } from "./gateway-config";
import { createOpenClawGatewayNotConfiguredError } from "./runtime-errors";
import { createAgentSdkRuntime, isAgentSdkProvider, readAgentSdkRuntimeOptions, type AgentSdkRuntime } from "./sdk-runtime";

export interface RuntimeAdapter {
  listModels(): Promise<RuntimeModel[]>;
  listAgents(): Promise<RuntimeAgent[]>;
  listTools(): Promise<RuntimeTool[]>;
  listChannels(): Promise<RuntimeChannel[]>;
  listSessions(): Promise<RuntimeSessionSummary[]>;
  listTasks(): Promise<RuntimeTaskSummary[]>;
  getRuntimeOverview(): Promise<RuntimeOverview>;
  getSessionMessages(sessionKey: string): Promise<ChatHistoryMessage[]>;
  createChatSession(input: RuntimeChatSessionInput): Promise<RuntimeChatSessionResult>;
  updateChatSessionTitle(input: RuntimeChatSessionTitleInput): Promise<RuntimeChatSessionTitleResult>;
  streamChatMessage(input: RuntimeChatStreamInput, onEvent: (event: ChatStreamEvent) => void): Promise<void>;
  streamAgentTask(input: StartAgentTaskInput, onEvent: (event: ChatStreamEvent) => void): Promise<AgentTaskResult>;
  startAgentTask(input: StartAgentTaskInput): Promise<StartedAgentTaskResult>;
  waitForAgentTask(input: WaitForAgentTaskInput): Promise<AgentTaskResult>;
  sendChannelMessage(input: SendChannelInput): Promise<SendChannelResult>;
}

export interface RuntimeChatSessionInput {
  agentId?: string;
  parentSessionKey?: string;
}

export interface RuntimeChatSessionResult {
  sessionKey: string;
  sessionId?: string;
  title?: string;
}

export interface RuntimeChatSessionTitleInput {
  sessionKey: string;
  title: string;
}

export interface RuntimeChatSessionTitleResult {
  sessionKey: string;
  title: string;
}

export interface RuntimeChatStreamInput {
  sessionKey: string;
  source?: RuntimeObjectSource;
  message: string;
  attachments: ChatAttachment[];
  modelId?: string;
  thinking?: ChatThinkingEffort;
  permissionMode?: ChatPermissionMode;
  idempotencyKey: string;
  timeoutMs?: number;
  skillIds?: HarnessSkillId[];
}

export class MockRuntimeAdapter implements RuntimeAdapter {
  private readonly agentResults = new Map<string, AgentTaskResult>();

  async listModels(): Promise<RuntimeModel[]> {
    return [
      {
        id: "gpt-5.4",
        label: "GPT-5.4",
        provider: "OpenAI",
        supportsTools: true,
        contextWindow: 256000,
        thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"]
      },
      {
        id: "gpt-5.3-codex-spark",
        label: "GPT-5.3 Codex Spark",
        provider: "OpenAI",
        supportsTools: true,
        contextWindow: 128000,
        thinkingLevels: ["off", "minimal", "low", "medium", "high"]
      },
      {
        id: "local-reviewer",
        label: "Local Reviewer",
        provider: "Mock Local",
        supportsTools: false,
        contextWindow: 64000,
        thinkingLevels: ["off"]
      }
    ];
  }

  async listAgents(): Promise<RuntimeAgent[]> {
    return [
      {
        id: "main",
        label: "main",
        runtimeId: "mock",
        modelId: "gpt-5.4"
      }
    ];
  }

  async listTools(): Promise<RuntimeTool[]> {
    return [
      {
        id: "repo.search",
        label: "Repo Search",
        description: "Search files, symbols, and references in the connected workspace.",
        category: "code"
      },
      {
        id: "repo.test",
        label: "Repo Test",
        description: "Run scoped verification commands through the selected harness runtime.",
        category: "verification"
      },
      {
        id: "channel.send",
        label: "Channel Send",
        description: "Send delivery messages through configured runtime channels.",
        category: "communication"
      }
    ];
  }

  async listChannels(): Promise<RuntimeChannel[]> {
    return [
      { id: "slack", label: "Slack", status: "available" },
      { id: "discord", label: "Discord", status: "not_configured" },
      { id: "telegram", label: "Telegram", status: "disabled" }
    ];
  }

  async listSessions(): Promise<RuntimeSessionSummary[]> {
    const now = new Date().toISOString();
    return [
      { id: "session-demo-1", title: "Delivery planning console", updatedAt: now },
      { id: "session-demo-2", title: "Usage investigation", updatedAt: now }
    ];
  }

  async listTasks(): Promise<RuntimeTaskSummary[]> {
    const now = new Date().toISOString();
    return [
      { id: "task-demo-1", title: "Requirements Agent", status: "succeeded", updatedAt: now },
      { id: "task-demo-2", title: "Architecture Agent", status: "running", updatedAt: now }
    ];
  }

  async getRuntimeOverview(): Promise<RuntimeOverview> {
    const [sessions, tasks] = await Promise.all([this.listSessions(), this.listTasks()]);
    return { sessions, tasks };
  }

  async getSessionMessages(sessionKey: string): Promise<ChatHistoryMessage[]> {
    const now = new Date().toISOString();
    return [
      {
        id: `${sessionKey}:user-demo`,
        role: "user",
        content: "Mock runtime session history.",
        createdAt: now
      },
      {
        id: `${sessionKey}:assistant-demo`,
        role: "assistant",
        content: "This message came from the runtime adapter history surface.",
        createdAt: now
      }
    ];
  }

  async createChatSession(input: RuntimeChatSessionInput): Promise<RuntimeChatSessionResult> {
    const agentId = input.agentId?.trim() || "main";
    return {
      sessionKey: `agent:${agentId}:chat-${nanoid(8)}`,
      title: "New runtime chat"
    };
  }

  async updateChatSessionTitle(input: RuntimeChatSessionTitleInput): Promise<RuntimeChatSessionTitleResult> {
    return {
      sessionKey: input.sessionKey,
      title: input.title
    };
  }

  async streamChatMessage(input: RuntimeChatStreamInput, onEvent: (event: ChatStreamEvent) => void): Promise<void> {
    const now = new Date().toISOString();
    const runId = input.idempotencyKey;
    const source = input.source ?? "openclaw";
    onEvent({
      type: "started",
      taskId: runId,
      runId,
      sessionKey: input.sessionKey,
      source,
      status: "running",
      updatedAt: now
    });
    const adapterLabel = source === "openclaw" ? "runtime" : formatSourceLabel(source);
    onEvent({
      type: "delta",
      text: `main completed through ${adapterLabel} adapter. Prompt boundary stayed outside Hiveward runtime.`
    });
    onEvent({
      type: "done",
      taskId: runId,
      runId,
      sessionKey: input.sessionKey,
      source,
      status: "succeeded",
      output: `main completed through ${adapterLabel} adapter. Prompt boundary stayed outside Hiveward runtime.`,
      updatedAt: now
    });
  }

  async streamAgentTask(input: StartAgentTaskInput, onEvent: (event: ChatStreamEvent) => void): Promise<AgentTaskResult> {
    const started = await this.startAgentTask(input);
    onEvent({ ...started, type: "started" });
    if (started.status === "failed" || started.status === "cancelled") {
      const terminal: AgentTaskResult = { ...started, output: undefined, usage: undefined };
      onEvent(toAgentTaskDoneEvent(terminal));
      return terminal;
    }
    const result = await this.waitForAgentTask({
      nodeRunId: input.nodeRunId,
      taskId: started.taskId,
      runId: started.runId,
      sessionKey: started.sessionKey,
      source: started.source,
      agentId: input.agentId,
      modelId: input.modelId
    });
    const text = typeof result.output === "string" ? result.output : result.output === undefined ? "" : JSON.stringify(result.output, null, 2);
    if (text) {
      onEvent({ type: "delta", text });
    }
    onEvent(toAgentTaskDoneEvent(result, text || (typeof result.output === "string" ? result.output : undefined)));
    return result;
  }

  async startAgentTask(input: StartAgentTaskInput): Promise<StartedAgentTaskResult> {
    const now = new Date().toISOString();
    const taskId = `oc-task-${nanoid(8)}`;
    const runId = `oc-run-${nanoid(8)}`;
    const inputSize = JSON.stringify(input.input ?? {}).length;
    const outputTokens = Math.max(80, Math.round((input.prompt.length + inputSize) / 3));
    const inputTokens = Math.max(60, Math.round(input.prompt.length / 2));

    this.agentResults.set(taskId, {
      taskId,
      runId,
      sessionKey: `oc-session-${input.blueprintRunId}`,
      source: "openclaw",
      status: "succeeded",
      output: `${input.agentName} completed through runtime adapter. Prompt boundary stayed outside Hiveward runtime.`,
      error: undefined,
      usage: {
        id: `usage-${nanoid(8)}`,
        modelId: input.modelId ?? "gpt-5.4",
        inputTokens,
        outputTokens,
        costUsd: Number(((inputTokens + outputTokens) * 0.000002).toFixed(6)),
        recordedAt: now
      },
      updatedAt: now
    });

    return {
      taskId,
      runId,
      sessionKey: `oc-session-${input.blueprintRunId}`,
      source: "openclaw",
      status: "running",
      updatedAt: now
    };
  }

  async waitForAgentTask(input: WaitForAgentTaskInput): Promise<AgentTaskResult> {
    const result = this.agentResults.get(input.taskId);
    if (!result) {
      throw new Error(`Mock runtime task not found: ${input.taskId}`);
    }
    return result;
  }

  async sendChannelMessage(input: SendChannelInput): Promise<SendChannelResult> {
    return {
      deliveryId: `delivery-${input.channelId}-${nanoid(8)}`,
      status: "sent",
      updatedAt: new Date().toISOString()
    };
  }
}

export class UnavailableOpenClawAdapter implements RuntimeAdapter {
  async listModels(): Promise<RuntimeModel[]> {
    throw createOpenClawGatewayNotConfiguredError();
  }

  async listAgents(): Promise<RuntimeAgent[]> {
    throw createOpenClawGatewayNotConfiguredError();
  }

  async listTools(): Promise<RuntimeTool[]> {
    throw createOpenClawGatewayNotConfiguredError();
  }

  async listChannels(): Promise<RuntimeChannel[]> {
    throw createOpenClawGatewayNotConfiguredError();
  }

  async listSessions(): Promise<RuntimeSessionSummary[]> {
    throw createOpenClawGatewayNotConfiguredError();
  }

  async listTasks(): Promise<RuntimeTaskSummary[]> {
    throw createOpenClawGatewayNotConfiguredError();
  }

  async getRuntimeOverview(): Promise<RuntimeOverview> {
    throw createOpenClawGatewayNotConfiguredError();
  }

  async getSessionMessages(_sessionKey: string): Promise<ChatHistoryMessage[]> {
    throw createOpenClawGatewayNotConfiguredError();
  }

  async createChatSession(_input: RuntimeChatSessionInput): Promise<RuntimeChatSessionResult> {
    throw createOpenClawGatewayNotConfiguredError();
  }

  async updateChatSessionTitle(_input: RuntimeChatSessionTitleInput): Promise<RuntimeChatSessionTitleResult> {
    throw createOpenClawGatewayNotConfiguredError();
  }

  async streamChatMessage(_input: RuntimeChatStreamInput, _onEvent: (event: ChatStreamEvent) => void): Promise<void> {
    throw createOpenClawGatewayNotConfiguredError();
  }

  async streamAgentTask(_input: StartAgentTaskInput, _onEvent: (event: ChatStreamEvent) => void): Promise<AgentTaskResult> {
    throw createOpenClawGatewayNotConfiguredError();
  }

  async startAgentTask(_input: StartAgentTaskInput): Promise<StartedAgentTaskResult> {
    throw createOpenClawGatewayNotConfiguredError();
  }

  async waitForAgentTask(_input: WaitForAgentTaskInput): Promise<AgentTaskResult> {
    throw createOpenClawGatewayNotConfiguredError();
  }

  async sendChannelMessage(_input: SendChannelInput): Promise<SendChannelResult> {
    throw createOpenClawGatewayNotConfiguredError();
  }
}

export interface CreateRuntimeAdapterOptions {
  sdkWorkspaceRoot: string;
}

export class SdkRoutingRuntimeAdapter implements RuntimeAdapter {
  constructor(
    private readonly baseAdapter: RuntimeAdapter,
    private readonly sdkRuntime: AgentSdkRuntime
  ) {}

  listModels(): Promise<RuntimeModel[]> {
    return this.baseAdapter.listModels();
  }

  listAgents(): Promise<RuntimeAgent[]> {
    return this.baseAdapter.listAgents();
  }

  listTools(): Promise<RuntimeTool[]> {
    return this.baseAdapter.listTools();
  }

  listChannels(): Promise<RuntimeChannel[]> {
    return this.baseAdapter.listChannels();
  }

  listSessions(): Promise<RuntimeSessionSummary[]> {
    return this.baseAdapter.listSessions();
  }

  listTasks(): Promise<RuntimeTaskSummary[]> {
    return this.baseAdapter.listTasks();
  }

  getRuntimeOverview(): Promise<RuntimeOverview> {
    return this.baseAdapter.getRuntimeOverview();
  }

  getSessionMessages(sessionKey: string): Promise<ChatHistoryMessage[]> {
    return this.baseAdapter.getSessionMessages(sessionKey);
  }

  createChatSession(input: RuntimeChatSessionInput): Promise<RuntimeChatSessionResult> {
    return this.baseAdapter.createChatSession(input);
  }

  updateChatSessionTitle(input: RuntimeChatSessionTitleInput): Promise<RuntimeChatSessionTitleResult> {
    return this.baseAdapter.updateChatSessionTitle(input);
  }

  streamChatMessage(input: RuntimeChatStreamInput, onEvent: (event: ChatStreamEvent) => void): Promise<void> {
    return isAgentSdkProvider(input.source)
      ? this.sdkRuntime.streamChatMessage({ ...input, source: input.source }, onEvent)
      : this.baseAdapter.streamChatMessage(input, onEvent);
  }

  streamAgentTask(input: StartAgentTaskInput, onEvent: (event: ChatStreamEvent) => void): Promise<AgentTaskResult> {
    return isAgentSdkProvider(input.source)
      ? this.sdkRuntime.streamTask(input, onEvent)
      : this.baseAdapter.streamAgentTask(input, onEvent);
  }

  startAgentTask(input: StartAgentTaskInput): Promise<StartedAgentTaskResult> {
    return isAgentSdkProvider(input.source) ? this.sdkRuntime.startTask(input) : this.baseAdapter.startAgentTask(input);
  }

  waitForAgentTask(input: WaitForAgentTaskInput): Promise<AgentTaskResult> {
    return isAgentSdkProvider(input.source)
      ? this.sdkRuntime.waitForTask(input)
      : this.baseAdapter.waitForAgentTask(input);
  }

  sendChannelMessage(input: SendChannelInput): Promise<SendChannelResult> {
    return this.baseAdapter.sendChannelMessage(input);
  }
}

export function createRuntimeAdapter(options: CreateRuntimeAdapterOptions): RuntimeAdapter {
  const mode = (process.env.OPENCLAW_ADAPTER ?? "auto").trim().toLowerCase();
  const sdkRuntime = createAgentSdkRuntime(readAgentSdkRuntimeOptions(options.sdkWorkspaceRoot));
  if (mode === "mock") {
    return new SdkRoutingRuntimeAdapter(new MockRuntimeAdapter(), sdkRuntime);
  }

  const gatewayConfig = resolveGatewayAdapterConfig();
  if (gatewayConfig) {
    return new SdkRoutingRuntimeAdapter(new GatewayOpenClawAdapter(gatewayConfig), sdkRuntime);
  }

  if (mode === "real" || mode === "gateway") {
    throw createOpenClawGatewayNotConfiguredError();
  }

  return new SdkRoutingRuntimeAdapter(new UnavailableOpenClawAdapter(), sdkRuntime);
}

export { GatewayOpenClawAdapter } from "./gateway-adapter";
export { GatewayRequestError, GatewaySession } from "./gateway-client";
export { resolveGatewayAdapterConfig, type GatewayAdapterConfig } from "./gateway-config";
export { RuntimeAdapterError, isRuntimeAdapterError, type RuntimeAdapterErrorCode } from "./runtime-errors";
export { createAgentSdkRuntime, isAgentSdkProvider } from "./sdk-runtime";

function formatSourceLabel(source: HarnessId | RuntimeObjectSource): string {
  if (source === "codex") return "Codex";
  if (source === "claude" || source === "claudeCode") return "Claude Code";
  if (source === "google") return "Google CLI";
  if (source === "cursor") return "Cursor CLI";
  if (source === "opencode") return "OpenCode";
  if (source === "hermes") return "Hermes";
  return "OpenClaw";
}

function toAgentTaskDoneEvent(result: AgentTaskResult, output?: string): Extract<ChatStreamEvent, { type: "done" }> {
  return {
    type: "done",
    taskId: result.taskId,
    runId: result.runId,
    sessionKey: result.sessionKey,
    source: result.source,
    status: result.status,
    output,
    error: result.error,
    usage: result.usage,
    updatedAt: result.updatedAt
  };
}
