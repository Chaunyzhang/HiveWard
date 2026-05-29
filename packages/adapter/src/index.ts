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
    throw new Error(
      "OpenClaw Gateway configuration was not found. Set OPENCLAW_GATEWAY_URL or provide ~/.openclaw/openclaw.json."
    );
  }

  return new SdkRoutingRuntimeAdapter(new MockRuntimeAdapter(), sdkRuntime);
}

export { GatewayOpenClawAdapter } from "./gateway-adapter";
export { GatewayRequestError, GatewaySession } from "./gateway-client";
export { resolveGatewayAdapterConfig, type GatewayAdapterConfig } from "./gateway-config";
export { createAgentSdkRuntime, isAgentSdkProvider } from "./sdk-runtime";

function formatSourceLabel(source: HarnessId | RuntimeObjectSource): string {
  if (source === "codex") return "Codex";
  if (source === "claude" || source === "claudeCode") return "Claude Code";
  if (source === "google") return "Google CLI Beta";
  if (source === "cursor") return "Cursor CLI Beta";
  if (source === "opencode") return "OpenCode Beta";
  if (source === "hermes") return "Hermes Beta";
  return "OpenClaw";
}
