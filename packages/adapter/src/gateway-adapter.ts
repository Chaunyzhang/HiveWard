import type {
  RuntimeAgent,
  RuntimeChannel,
  RuntimeModel,
  RuntimeSessionSummary,
  RuntimeTaskSummary,
  RuntimeTool,
  RuntimeUsageFact,
  RuntimeExecutionStatus,
  RuntimeOverview,
  ChatHistoryMessage,
  ChatStreamEvent,
  ChatThinkingEffort,
  SendChannelInput,
  SendChannelResult,
  AgentTaskResult,
  StartAgentTaskInput,
  StartedAgentTaskResult,
  WaitForAgentTaskInput,
} from "@hiveward/shared";
import { normalizeRuntimeAccessPolicy, runtimeAccessPolicySupportForRuntime } from "@hiveward/shared";
import type {
  RuntimeAdapter,
  RuntimeChatSessionInput,
  RuntimeChatSessionResult,
  RuntimeChatSessionTitleInput,
  RuntimeChatSessionTitleResult,
  RuntimeChatStreamInput,
} from "./index";
import type { GatewayAdapterConfig } from "./gateway-config";
import { GatewaySession } from "./gateway-client";
import { createGatewayId } from "./gateway-device";

export class GatewayOpenClawAdapter implements RuntimeAdapter {
  private sharedSession: GatewaySession | undefined;
  private sharedSessionPromise: Promise<GatewaySession> | undefined;
  private readonly inflightAgentTasks = new Map<string, InflightAgentTask>();

  constructor(private readonly config: GatewayAdapterConfig) {}

  async listModels(): Promise<RuntimeModel[]> {
    return this.withSession(async (session) => {
      const result = await session.request<{ models?: unknown[] }>("models.list", {});
      return (Array.isArray(result.models) ? result.models : []).map(mapModel).filter(isPresent);
    });
  }

  async listAgents(): Promise<RuntimeAgent[]> {
    return this.withSession(async (session) => {
      const result = await session.request<{ agents?: unknown[]; defaultId?: unknown }>("agents.list", {});
      return (Array.isArray(result.agents) ? result.agents : []).map((agent) => mapAgent(agent, result.defaultId)).filter(isPresent);
    });
  }

  async listTools(): Promise<RuntimeTool[]> {
    return this.withSession(async (session) => {
      const result = await session.request<{ groups?: unknown[] }>("tools.catalog", {});
      return (Array.isArray(result.groups) ? result.groups : []).flatMap((group) => mapToolGroup(group));
    });
  }

  async listChannels(): Promise<RuntimeChannel[]> {
    return this.withSession(async (session) => {
      const result = await session.request<Record<string, unknown>>("channels.status", {});
      const meta = Array.isArray(result.channelMeta) ? result.channelMeta : [];
      const order = Array.isArray(result.channelOrder) ? result.channelOrder : [];
      const labels = isRecord(result.channelLabels) ? result.channelLabels : {};
      const fromMeta = meta.map(mapChannelMeta).filter(isPresent);
      if (fromMeta.length > 0) return fromMeta;
      return order
        .filter((id): id is string => typeof id === "string")
        .map((id) => ({
          id,
          label: typeof labels[id] === "string" ? labels[id] : id,
          status: "available" as const,
        }));
    });
  }

  async listSessions(): Promise<RuntimeSessionSummary[]> {
    const sessions = await this.listSessionRecords();
    return sessions.map(mapSession).filter(isPresent);
  }

  async listTasks(): Promise<RuntimeTaskSummary[]> {
    const sessions = await this.listSessionRecords();
    return sessions.map(mapSessionTask).filter(isPresent);
  }

  async getRuntimeOverview(): Promise<RuntimeOverview> {
    const sessions = await this.listSessionRecords();
    return {
      sessions: sessions.map(mapSession).filter(isPresent),
      tasks: sessions.map(mapSessionTask).filter(isPresent),
    };
  }

  async getSessionMessages(sessionKey: string): Promise<ChatHistoryMessage[]> {
    return this.withSession(async (session) => {
      const history = await session.request<{ messages?: unknown[] }>("chat.history", {
        sessionKey,
        limit: 100,
        maxChars: agentTranscriptHistoryMaxChars,
      });
      return (Array.isArray(history.messages) ? history.messages : [])
        .map(mapChatHistoryMessage)
        .filter(isPresent);
    });
  }

  async createChatSession(input: RuntimeChatSessionInput): Promise<RuntimeChatSessionResult> {
    return this.withSession(async (session) => {
      const agentId = input.agentId?.trim() || "main";
      const parentSessionKey = input.parentSessionKey?.trim();
      const result = await session.request<Record<string, unknown>>("sessions.create", {
        agentId,
        ...(parentSessionKey ? { parentSessionKey } : {})
      });
      const sessionKey = readString(result.key);
      if (!sessionKey) {
        throw new Error("OpenClaw sessions.create returned no session key.");
      }
      const sessionId = readString(result.sessionId);
      const entry = isRecord(result.entry) ? result.entry : undefined;
      return {
        sessionKey,
        sessionId,
        title: readString(entry?.label) ?? sessionKey
      };
    });
  }

  async updateChatSessionTitle(input: RuntimeChatSessionTitleInput): Promise<RuntimeChatSessionTitleResult> {
    return this.withSession(async (session) => {
      const title = input.title.trim();
      const result = await session.request<Record<string, unknown>>("sessions.patch", {
        key: input.sessionKey,
        label: title
      });
      const entry = isRecord(result.entry) ? result.entry : result;
      return {
        sessionKey: readString(entry.key) ?? readString(entry.sessionKey) ?? input.sessionKey,
        title: readString(entry.label) ?? readString(entry.displayName) ?? title
      };
    });
  }

  async streamChatMessage(input: RuntimeChatStreamInput, onEvent: (event: ChatStreamEvent) => void): Promise<void> {
    const session = await this.getSession();
    const requestedRunId = createGatewayId(input.idempotencyKey);
    const knownRunIds = new Set([requestedRunId]);
    let activeRunId = requestedRunId;
    const startedAt = new Date().toISOString();
    let output = "";
    let lastUsage: RuntimeUsageFact | undefined;

    await this.patchChatSession(session, input);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      let unsubscribeChat: () => void = () => undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribeChat();
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };
      timer = setTimeout(() => {
        onEvent({
          type: "done",
          taskId: activeRunId,
          runId: activeRunId,
          sessionKey: input.sessionKey,
          source: "openclaw",
          status: "failed",
          output,
          error: "OpenClaw chat stream timed out before a final event.",
          usage: lastUsage,
          updatedAt: new Date().toISOString()
        });
        finish();
      }, input.timeoutMs ?? this.config.agentStartTimeoutMs);

      unsubscribeChat = session.onEvent("chat", (payload) => {
        const event = mapGatewayChatEvent(payload, knownRunIds, activeRunId, input.sessionKey, output, lastUsage);
        if (!event) return;
        if (event.type === "started" || event.type === "done") {
          knownRunIds.add(event.runId);
          activeRunId = event.runId;
        }
        if (event.type === "delta") {
          output = event.replace ? event.text : `${output}${event.text}`;
        }
        if (event.type === "done") {
          output = event.output ?? output;
          lastUsage = event.usage ?? lastUsage;
        }
        onEvent(event);
        if (event.type === "done") {
          finish();
        }
      });

      void session.request<Record<string, unknown>>("chat.send", {
        sessionKey: input.sessionKey,
        message: input.message,
        deliver: false,
        ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
        thinking: input.thinking,
        timeoutMs: input.timeoutMs,
        idempotencyKey: requestedRunId
      }).then((result) => {
        const acceptedRunId = readString(result.runId) ?? requestedRunId;
        knownRunIds.add(acceptedRunId);
        activeRunId = acceptedRunId;
        onEvent({
          type: "started",
          taskId: acceptedRunId,
          runId: acceptedRunId,
          sessionKey: input.sessionKey,
          source: "openclaw",
          status: "running",
          updatedAt: startedAt
        });
        const status = readString(result.status);
        if (status === "ok" || status === "error") {
          onEvent({
            type: "done",
            taskId: acceptedRunId,
            runId: acceptedRunId,
            sessionKey: input.sessionKey,
            source: "openclaw",
            status: status === "ok" ? "succeeded" : "failed",
            error: status === "error" ? readAgentResultOutput(result) ?? summarizeAgentResult(result) : undefined,
            updatedAt: new Date().toISOString()
          });
          finish();
        }
      }).catch((error) => {
        finish(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private async patchChatSession(session: GatewaySession, input: RuntimeChatStreamInput): Promise<void> {
    const patch: Record<string, unknown> = { key: input.sessionKey };
    if (input.modelId?.trim()) patch.model = input.modelId.trim();
    if (input.thinking?.trim()) patch.thinkingLevel = input.thinking.trim();
    if (Object.keys(patch).length === 1) return;
    await session.request<Record<string, unknown>>("sessions.patch", patch);
  }

  private async listSessionRecords(): Promise<unknown[]> {
    return this.withSession(async (session) => {
      const result = await session.request<{ sessions?: unknown[] }>("sessions.list", {
        limit: 20,
        includeGlobal: true,
        includeUnknown: true,
      });
      return Array.isArray(result.sessions) ? result.sessions : [];
    });
  }

  async startAgentTask(input: StartAgentTaskInput): Promise<StartedAgentTaskResult> {
    const session = await this.getSession();
    try {
      const idempotencyKey = createGatewayId(input.nodeRunId);
      const modelRef = await this.resolveModelRef(session, input.modelId);
      const lifecycle = session.requestLifecycle<Record<string, unknown>>(
        "agent",
        {
          message: formatAgentMessage(input),
          agentId: input.agentId ?? "main",
          provider: modelRef?.provider,
          model: modelRef?.model,
          deliver: false,
          bestEffortDeliver: true,
          label: input.agentName,
          idempotencyKey,
        },
        { acceptedTimeoutMs: this.config.agentStartTimeoutMs, finalTimeoutMs: null },
      );
      const tracker: InflightAgentTask = {
        final: lifecycle.final.finally(() => {
          this.inflightAgentTasks.delete(idempotencyKey);
          if (tracker.acceptedTaskId) {
            this.inflightAgentTasks.delete(tracker.acceptedTaskId);
          }
        }),
      };
      this.inflightAgentTasks.set(idempotencyKey, tracker);

      let accepted: Record<string, unknown>;
      try {
        accepted = await lifecycle.accepted;
      } catch (error) {
        if (isGatewayRequestTimeoutFor(error, "agent")) {
          return {
            taskId: idempotencyKey,
            runId: idempotencyKey,
            sessionKey: buildAgentMainSessionKey(input.agentId),
            source: "openclaw",
            status: "running",
            updatedAt: new Date().toISOString(),
          };
        }
        this.inflightAgentTasks.delete(idempotencyKey);
        throw error;
      }

      const runId = readString(accepted.runId) ?? idempotencyKey;
      const sessionKey = readString(accepted.sessionKey) ?? buildAgentMainSessionKey(input.agentId);
      const taskId = runId;
      const status = mapAcceptedExecutionStatus(readString(accepted.status));
      tracker.acceptedTaskId = taskId;
      if (taskId !== idempotencyKey) {
        this.inflightAgentTasks.set(taskId, tracker);
      }

      return {
        taskId,
        runId,
        sessionKey,
        source: "openclaw",
        status,
        error: status === "failed" ? summarizeAgentResult(accepted) : undefined,
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (isRecoverableGatewaySessionError(error)) {
        this.resetSharedSession(session);
      }
      throw error;
    }
  }

  async waitForAgentTask(input: WaitForAgentTaskInput): Promise<AgentTaskResult> {
    const inflight = this.inflightAgentTasks.get(input.taskId);
    const session = await this.getSession();
    if (!inflight) {
      const completion = await this.waitForTerminalSessionResult(session, input, () => false);
      return completion.result;
    }

    let stopFallback = false;
    // Some Gateway builds mark the backing session done without sending a final agent frame.
    const completion = await Promise.race([
      inflight.final.then((result) => ({ type: "gateway_final" as const, result })),
      this.waitForTerminalSessionResult(session, input, () => stopFallback)
    ]).finally(() => {
      stopFallback = true;
    });
    if (completion.type === "session_terminal") {
      this.inflightAgentTasks.delete(input.taskId);
      return completion.result;
    }

    const result = completion.result;
    const runId = readString(result.runId) ?? input.runId;
    const sessionKey = readString(result.sessionKey) ?? input.sessionKey;
    const ok = readString(result.status) !== "error";
    const fallbackModelId = readModelId(result) ?? input.modelId;
    const transcriptResult = ok ? await readAgentTranscriptResult(session, sessionKey, input.nodeRunId, fallbackModelId) : undefined;
    const transcriptError = transcriptResult?.error;
    const status = ok && !transcriptError ? "succeeded" : "failed";
    const usage = readUsageFact(result, fallbackModelId, runId) ?? transcriptResult?.usage;
    const output = status === "succeeded"
      ? transcriptResult?.output ?? readAgentResultOutput(result)
      : undefined;

    return {
      taskId: input.taskId,
      runId,
      sessionKey,
      source: "openclaw",
      status,
      output,
      error: transcriptError ?? (ok ? undefined : summarizeAgentResult(result)),
      usage,
      updatedAt: new Date().toISOString(),
    };
  }

  async sendChannelMessage(input: SendChannelInput): Promise<SendChannelResult> {
    return this.withSession(async (session) => {
      const result = await session.request<Record<string, unknown>>("send", {
        channel: input.channelId,
        to: input.target,
        message: input.body,
        idempotencyKey: createGatewayId(input.nodeRunId),
      });
      return {
        deliveryId: readString(result.id) ?? readString(result.messageId) ?? createGatewayId("delivery"),
        status: "sent",
        updatedAt: new Date().toISOString(),
      };
    });
  }

  private async withSession<T>(operation: (session: GatewaySession) => Promise<T>): Promise<T> {
    const session = await this.getSession();
    try {
      return await operation(session);
    } catch (error) {
      if (isRecoverableGatewaySessionError(error)) {
        this.resetSharedSession(session);
      }
      throw error;
    }
  }

  private async getSession(): Promise<GatewaySession> {
    if (this.sharedSession) {
      return this.sharedSession;
    }
    if (this.sharedSessionPromise) {
      return this.sharedSessionPromise;
    }

    const session = new GatewaySession(this.config);
    const promise = session.connect().then(() => {
      this.sharedSession = session;
      return session;
    }).catch((error) => {
      session.close();
      throw error;
    }).finally(() => {
      this.sharedSessionPromise = undefined;
    });

    this.sharedSessionPromise = promise;
    return promise;
  }

  private resetSharedSession(session?: GatewaySession): void {
    if (session && this.sharedSession && session !== this.sharedSession) {
      return;
    }
    this.sharedSession?.close();
    this.sharedSession = undefined;
    this.sharedSessionPromise = undefined;
  }

  private async resolveModelRef(
    session: GatewaySession,
    modelId: string | undefined,
  ): Promise<{ provider: string; model: string } | undefined> {
    if (!modelId) return undefined;
    if (modelId.includes("/")) {
      const [provider, model] = modelId.split("/", 2);
      return provider && model ? { provider, model } : undefined;
    }
    const result = await session.request<{ models?: unknown[] }>("models.list", {});
    const model = (Array.isArray(result.models) ? result.models : []).find((item) => {
      if (!isRecord(item)) return false;
      return item.id === modelId || `${item.provider}/${item.id}` === modelId;
    });
    if (!isRecord(model)) return undefined;
    const provider = readString(model.provider);
    const id = readString(model.id);
    return provider && id ? { provider, model: id } : undefined;
  }

  private async waitForTerminalSessionResult(
    session: GatewaySession,
    input: WaitForAgentTaskInput,
    shouldStop: () => boolean,
  ): Promise<{ type: "session_terminal"; result: AgentTaskResult }> {
    let terminalSeenAt: number | undefined;

    while (!shouldStop()) {
      await delay(agentTerminalPollIntervalMs);
      if (shouldStop()) break;

      const terminal = await this.readTerminalSession(session, input.sessionKey).catch(() => undefined);
      if (!terminal) continue;

      const transcript = await readAgentTranscriptResult(session, input.sessionKey, input.nodeRunId, input.modelId);
      if (!transcript?.foundRequest) {
        terminalSeenAt = undefined;
        continue;
      }
      if (transcript?.error) {
        return {
          type: "session_terminal",
          result: {
            taskId: input.taskId,
            runId: input.runId,
            sessionKey: input.sessionKey,
            source: input.source,
            status: "failed",
            error: transcript.error,
            usage: transcript.usage,
            updatedAt: terminal.updatedAt,
          },
        };
      }

      if (transcript?.output) {
        return {
          type: "session_terminal",
          result: {
            taskId: input.taskId,
            runId: input.runId,
            sessionKey: input.sessionKey,
            source: input.source,
            status: "succeeded",
            output: transcript.output,
            usage: transcript.usage,
            updatedAt: terminal.updatedAt,
          },
        };
      }

      if (terminal.status === "failed" || terminal.status === "cancelled") {
        return {
          type: "session_terminal",
          result: {
            taskId: input.taskId,
            runId: input.runId,
            sessionKey: input.sessionKey,
            source: input.source,
            status: terminal.status,
            error: `OpenClaw session ${terminal.status}.`,
            usage: transcript?.usage,
            updatedAt: terminal.updatedAt,
          },
        };
      }

      terminalSeenAt ??= Date.now();
      if (Date.now() - terminalSeenAt >= agentTerminalTranscriptGraceMs) {
        return {
          type: "session_terminal",
          result: {
            taskId: input.taskId,
            runId: input.runId,
            sessionKey: input.sessionKey,
            source: input.source,
            status: "succeeded",
            usage: transcript?.usage,
            updatedAt: terminal.updatedAt,
          },
        };
      }
    }

    return new Promise<never>(() => {});
  }

  private async readTerminalSession(
    session: GatewaySession,
    sessionKey: string,
  ): Promise<{ status: Exclude<RuntimeExecutionStatus, "queued" | "running">; updatedAt: string } | undefined> {
    const result = await session.request<{ sessions?: unknown[] }>("sessions.list", {
      limit: 20,
      includeGlobal: true,
      includeUnknown: true,
    });
    const record = (Array.isArray(result.sessions) ? result.sessions : []).find((candidate) => {
      if (!isRecord(candidate)) return false;
      const key = readString(candidate.key) ?? readString(candidate.sessionId);
      return key === sessionKey;
    });
    if (!isRecord(record)) return undefined;

    const status = mapGatewaySessionStatus(readString(record.status));
    if (status !== "succeeded" && status !== "failed" && status !== "cancelled") return undefined;
    return {
      status,
      updatedAt: dateFromMs(record.updatedAt),
    };
  }
}

interface InflightAgentTask {
  final: Promise<Record<string, unknown>>;
  acceptedTaskId?: string;
}

const agentTerminalPollIntervalMs = 5_000;
const agentTerminalTranscriptGraceMs = 30_000;

export function formatAgentMessage(input: StartAgentTaskInput): string {
  const skillSection = input.skillIds?.length
    ? ["Selected skills:", ...input.skillIds.map((skillId) => `- ${skillId}`)].join("\n")
    : undefined;
  const runtimeAccessSection = formatRuntimeAccessPolicySection(input);
  if (input.input === undefined) {
    return [input.prompt, skillSection ? "" : undefined, skillSection, runtimeAccessSection ? "" : undefined, runtimeAccessSection]
      .filter((section) => section !== undefined)
      .join("\n");
  }

  const formattedInput = formatAgentInput(input.input);
  return [
    `Hiveward blueprint run: ${input.blueprintRunId}`,
    `Hiveward node run: ${input.nodeRunId}`,
    "",
    input.prompt,
    skillSection ? "" : undefined,
    skillSection,
    runtimeAccessSection ? "" : undefined,
    runtimeAccessSection,
    formattedInput ? "" : undefined,
    formattedInput,
  ].filter((section) => section !== undefined).join("\n");
}

function formatRuntimeAccessPolicySection(input: StartAgentTaskInput): string | undefined {
  if (!input.runtimeAccessPolicy && !input.permissionProfile) return undefined;
  const policy = normalizeRuntimeAccessPolicy(input.runtimeAccessPolicy, input.permissionProfile);
  const support = runtimeAccessPolicySupportForRuntime("openclaw");
  return [
    "Runtime access policy:",
    `- filesystem: ${policy.filesystem} (${support.filesystem})`,
    `- network: ${policy.network} (${support.network})`,
    `- webSearch: ${policy.webSearch} (${support.webSearch})`
  ].join("\n");
}

function formatAgentInput(input: unknown): string {
  const record = isRecord(input) ? input : undefined;
  if (!record) {
    return ["输入上下文:", stringifyVisibleValue(input) ?? ""].join("\n");
  }

  const sections = ["输入上下文:"];
  sections.push(...formatManagerContext(record.manager));
  sections.push(...formatUpstreamSection(record.upstream));
  sections.push(...formatPreviousResults(record.previousResults));

  const remainingEntries = Object.entries(record).filter(([key]) => !["manager", "upstream", "previousResults"].includes(key));
  if (remainingEntries.length > 0) {
    sections.push("", "其他上下文:");
    for (const [key, value] of remainingEntries) {
      sections.push(`- ${key}: ${formatInlineValue(value)}`);
    }
  }

  return sections.join("\n");
}

function formatManagerContext(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const lines = ["", "管理器交接:"];
  for (const key of ["nodeLabel", "slot", "handoff", "maxHandoffs", "instructions"]) {
    if (value[key] !== undefined) lines.push(`- ${key}: ${formatInlineValue(value[key])}`);
  }
  return lines;
}

function formatUpstreamSection(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return ["", "上游最终输出: 无"];
  return ["", "上游最终输出（完整原文）:", ...value.flatMap((item, index) => formatUpstreamItem(item, index))];
}

function formatUpstreamItem(value: unknown, index: number): string[] {
  if (!isRecord(value)) return [``, `### 上游 ${index + 1}`, formatOutputBlock(value)];

  const label = readString(value.nodeLabel) ?? readString(value.nodeId) ?? `上游 ${index + 1}`;
  const lines = ["", `### ${index + 1}. ${label}`];
  for (const key of ["nodeId", "nodeRunId", "status"]) {
    if (value[key] !== undefined) lines.push(`- ${key}: ${formatInlineValue(value[key])}`);
  }
  const ref = formatRuntimeRef(value.runtimeRef ?? value.openclawRef);
  if (ref) lines.push(`- runtimeRef: ${ref}`);
  lines.push("输出:");
  lines.push(formatOutputBlock(value.output));
  return lines;
}

function formatPreviousResults(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  return ["", "前序槽位结果（完整原文）:", ...value.flatMap((item, index) => formatPreviousResult(item, index))];
}

function formatPreviousResult(value: unknown, index: number): string[] {
  if (!isRecord(value)) return ["", `### 前序结果 ${index + 1}`, formatOutputBlock(value)];
  const label = readString(value.nodeLabel) ?? readString(value.nodeId) ?? `前序结果 ${index + 1}`;
  const lines = ["", `### ${index + 1}. ${label}`];
  for (const key of ["handoff", "slot", "nodeId", "status"]) {
    if (value[key] !== undefined) lines.push(`- ${key}: ${formatInlineValue(value[key])}`);
  }
  if (value.error !== undefined) lines.push(`- error: ${formatInlineValue(value.error)}`);
  lines.push("输出:");
  lines.push(formatOutputBlock(value.output));
  return lines;
}

function formatRuntimeRef(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return ["taskId", "runId", "sessionKey"]
    .flatMap((key) => value[key] === undefined ? [] : [`${key}=${formatInlineValue(value[key])}`])
    .join(", ") || undefined;
}

function formatOutputBlock(value: unknown): string {
  const text = stringifyVisibleValue(value) ?? "";
  return [`<<<BEGIN OUTPUT>>>`, text, `<<<END OUTPUT>>>`].join("\n");
}

function formatInlineValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return stringifyVisibleValue(value) ?? "";
}

function mapModel(value: unknown): RuntimeModel | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value.id);
  const provider = readString(value.provider);
  if (!id || !provider) return undefined;
  const thinkingLevels = readModelThinkingLevels(value);
  return {
    id: `${provider}/${id}`,
    label: readString(value.name) ?? readString(value.alias) ?? id,
    provider,
    supportsTools: true,
    contextWindow: readNumber(value.contextWindow),
    ...(thinkingLevels ? { thinkingLevels } : {}),
  };
}

const baseThinkingLevels: ChatThinkingEffort[] = ["off", "minimal", "low", "medium", "high"];
const thinkingLevelRank: Record<ChatThinkingEffort, number> = {
  off: 0,
  minimal: 10,
  low: 20,
  medium: 30,
  high: 40,
  adaptive: 50,
  xhigh: 60,
  max: 70,
};

function readModelThinkingLevels(value: Record<string, unknown>): ChatThinkingEffort[] | undefined {
  const explicitLevels =
    readThinkingLevelList(value.thinkingLevels) ??
    readThinkingLevelList(value.thinkingOptions);
  if (explicitLevels?.length) return explicitLevels;

  const compat = isRecord(value.compat) ? value.compat : undefined;
  const supportedReasoningEfforts =
    readThinkingLevelList(compat?.supportedReasoningEfforts) ??
    readThinkingLevelList(value.supportedReasoningEfforts);
  if (supportedReasoningEfforts?.length) {
    return mergeThinkingLevels([...baseThinkingLevels, ...supportedReasoningEfforts]);
  }

  if (value.reasoning === false) return ["off"];
  if (value.reasoning === true || compat?.supportsReasoningEffort === true) return [...baseThinkingLevels];
  return undefined;
}

function readThinkingLevelList(value: unknown): ChatThinkingEffort[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const levels = value
    .map((entry) => {
      if (typeof entry === "string") return normalizeThinkingLevel(entry);
      if (!isRecord(entry)) return undefined;
      return normalizeThinkingLevel(
        readString(entry.id) ??
        readString(entry.value) ??
        readString(entry.reasoningEffort) ??
        readString(entry.label) ??
        readString(entry.name)
      );
    })
    .filter(isPresent);
  return levels.length > 0 ? mergeThinkingLevels(levels) : undefined;
}

function mergeThinkingLevels(levels: ChatThinkingEffort[]): ChatThinkingEffort[] {
  return [...new Set(levels)].sort((left, right) => thinkingLevelRank[left] - thinkingLevelRank[right]);
}

function normalizeThinkingLevel(value: string | undefined): ChatThinkingEffort | undefined {
  const key = value?.trim().toLowerCase();
  if (!key) return undefined;
  const collapsed = key.replace(/[\s_-]+/g, "");
  if (collapsed === "off" || collapsed === "none" || collapsed === "disabled") return "off";
  if (collapsed === "min" || collapsed === "minimal") return "minimal";
  if (collapsed === "low" || collapsed === "on" || collapsed === "enabled") return "low";
  if (collapsed === "medium" || collapsed === "med" || collapsed === "mid") return "medium";
  if (collapsed === "high") return "high";
  if (collapsed === "adaptive" || collapsed === "auto") return "adaptive";
  if (collapsed === "xhigh" || collapsed === "extrahigh") return "xhigh";
  if (collapsed === "max") return "max";
  return undefined;
}

function mapAgent(value: unknown, defaultId: unknown): RuntimeAgent | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value.id);
  if (!id) return undefined;
  const defaultAgentId = readString(defaultId);
  const runtime = isRecord(value.agentRuntime) ? value.agentRuntime : undefined;
  const model = isRecord(value.model) ? value.model : undefined;
  const modelId = readString(model?.primary);
  return {
    id,
    label: id === defaultAgentId ? `${id} (default)` : id,
    workspace: readString(value.workspace),
    runtimeId: readString(runtime?.id),
    modelId,
  };
}

function mapToolGroup(value: unknown): RuntimeTool[] {
  if (!isRecord(value)) return [];
  const category = readString(value.label) ?? readString(value.id) ?? "tools";
  const tools = Array.isArray(value.tools) ? value.tools : [];
  return tools.map((tool) => mapTool(tool, category)).filter(isPresent);
}

function mapTool(value: unknown, category: string): RuntimeTool | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value.id);
  if (!id) return undefined;
  return {
    id,
    label: readString(value.label) ?? id,
    description: readString(value.description) ?? "",
    category,
  };
}

function mapChannelMeta(value: unknown): RuntimeChannel | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value.id);
  if (!id) return undefined;
  return {
    id,
    label: readString(value.label) ?? id,
    status: "available",
  };
}

function mapSession(value: unknown): RuntimeSessionSummary | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value.key) ?? readString(value.sessionId);
  if (!id) return undefined;
  return {
    id,
    title: readString(value.displayName) ?? readString(value.label) ?? id,
    updatedAt: dateFromMs(value.updatedAt),
  };
}

function mapSessionTask(value: unknown): RuntimeTaskSummary | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value.key) ?? readString(value.sessionId);
  if (!id) return undefined;
  return {
    id,
    title: readString(value.displayName) ?? readString(value.label) ?? id,
    status: mapExecutionStatus(readString(value.status)),
    updatedAt: dateFromMs(value.updatedAt),
  };
}

function mapChatHistoryMessage(value: unknown, index: number): ChatHistoryMessage | undefined {
  if (!isRecord(value)) return undefined;
  const role = readString(value.role);
  if (role !== "user" && role !== "assistant") return undefined;
  const content = normalizeChatHistoryContent(role, extractMessageText(value).trim());
  if (!content) return undefined;
  return {
    id: readString(value.id) ?? readString(value.messageId) ?? `openclaw-message-${index}`,
    role,
    content,
    createdAt: dateFromTimestamp(value.createdAt ?? value.createdAtMs ?? value.updatedAt ?? value.updatedAtMs),
  };
}

function normalizeChatHistoryContent(role: "user" | "assistant", content: string): string {
  if (role !== "user") return content;
  const userMessageMarker = "\nUser message:\n";
  const markerIndex = content.lastIndexOf(userMessageMarker);
  if (markerIndex < 0) return content;

  const platformPrompt = content.slice(0, markerIndex);
  if (
    !platformPrompt.includes("Hiveward role scope:") &&
    !platformPrompt.includes("Hiveward inbox submit protocol:") &&
    !platformPrompt.includes("HiveWard appointment:") &&
    !platformPrompt.includes("Required external skill:")
  ) {
    return content;
  }
  return content.slice(markerIndex + userMessageMarker.length).trim();
}

function mapGatewayChatEvent(
  payload: unknown,
  knownRunIds: ReadonlySet<string>,
  fallbackRunId: string,
  fallbackSessionKey: string,
  currentOutput: string,
  currentUsage: RuntimeUsageFact | undefined,
): ChatStreamEvent | undefined {
  if (!isRecord(payload)) return undefined;
  const eventRunId = readString(payload.runId) ?? readString(payload.taskId) ?? readString(payload.id);
  if (eventRunId && !knownRunIds.has(eventRunId)) return undefined;
  const runId = eventRunId ?? fallbackRunId;
  const sessionKey = readString(payload.sessionKey) ?? fallbackSessionKey;
  const usage = readUsageFact(payload.usage ?? payload.message, undefined, runId) ?? currentUsage;
  const state = readString(payload.state);

  if (state === "delta") {
    const text = readRawString(payload.deltaText) ?? extractMessageText(payload.message);
    if (!text) return undefined;
    return {
      type: "delta",
      text,
      replace: payload.replace === true,
    };
  }

  if (state === "final") {
    const output = extractMessageText(payload.message).trim() || currentOutput;
    return {
      type: "done",
      taskId: runId,
      runId,
      sessionKey,
      source: "openclaw",
      status: "succeeded",
      output,
      usage,
      updatedAt: new Date().toISOString(),
    };
  }

  if (state === "aborted") {
    return {
      type: "done",
      taskId: runId,
      runId,
      sessionKey,
      source: "openclaw",
      status: "cancelled",
      output: extractMessageText(payload.message).trim() || currentOutput,
      usage,
      updatedAt: new Date().toISOString(),
    };
  }

  if (state === "error") {
    const error = readString(payload.errorMessage) ?? "OpenClaw chat failed.";
    return {
      type: "done",
      taskId: runId,
      runId,
      sessionKey,
      source: "openclaw",
      status: "failed",
      output: extractMessageText(payload.message).trim() || currentOutput,
      error,
      usage,
      updatedAt: new Date().toISOString(),
    };
  }

  return undefined;
}

function readAgentResultOutput(result: Record<string, unknown>): string | undefined {
  const summary = readString(result.summary);
  const inner = isRecord(result.result) ? result.result : undefined;
  const text =
    extractMessageText(inner?.text) ||
    extractMessageText(inner?.message) ||
    extractMessageText(result.result) ||
    extractMessageText(result.text) ||
    extractMessageText(result.message) ||
    extractMessageText(result.output);
  const richOutput = [summary, text].filter(Boolean).join("\n\n").trim();
  return isMeaningfulTranscriptText(richOutput) ? richOutput : undefined;
}

function summarizeAgentResult(result: Record<string, unknown>): string {
  const status = readString(result.status) ?? "ok";
  const richOutput = readAgentResultOutput(result);
  if (richOutput) return richOutput;
  const runId = readString(result.runId);
  return [`OpenClaw agent run ${status}.`, runId ? `runId: ${runId}` : undefined].filter(Boolean).join("\n");
}

const agentTranscriptHistoryMaxChars = 200_000;

async function readAgentTranscriptResult(
  session: GatewaySession,
  sessionKey: string,
  nodeRunId: string,
  fallbackModelId?: string,
): Promise<TranscriptReadResult | undefined> {
  try {
    const history = await session.request<{ messages?: unknown[] }>("chat.history", {
      sessionKey,
      limit: 50,
      maxChars: agentTranscriptHistoryMaxChars,
    });
    const messages = Array.isArray(history.messages) ? history.messages : [];
    return readAgentTranscriptMessages(messages, nodeRunId, fallbackModelId);
  } catch {
    return undefined;
  }
}

interface TranscriptOutputCandidate {
  role?: string;
  text: string;
  usage?: RuntimeUsageFact;
}

interface TranscriptReadResult {
  foundRequest: true;
  output?: string;
  error?: string;
  usage?: RuntimeUsageFact;
}

export function readAgentTranscriptMessages(
  messages: unknown[],
  nodeRunId: string,
  fallbackModelId?: string,
): TranscriptReadResult | undefined {
  const userIndex = findLastMessageIndex(messages, (message) => {
    if (!isRecord(message)) return false;
    const role = readString(message.role);
    return role === "user" && extractMessageText(message).includes(`Hiveward node run: ${nodeRunId}`);
  });
  if (userIndex < 0) return undefined;

  let finalAssistantOutput: TranscriptOutputCandidate | undefined;
  let latestUsage: RuntimeUsageFact | undefined;

  for (const message of messages.slice(userIndex + 1)) {
    if (!isRecord(message)) continue;
    const role = readString(message.role);
    if (role === "user") continue;

    const usage = readUsageFact(message, fallbackModelId);
    latestUsage = usage ?? latestUsage;

    const errorMessage = readString(message.errorMessage);
    if (errorMessage) return { foundRequest: true, error: errorMessage, usage };
    if (readString(message.stopReason) === "error") {
      return { foundRequest: true, error: "OpenClaw assistant stopped with an error before returning visible output.", usage };
    }

    const text = extractMessageText(message).trim();
    if (role !== "assistant") continue;
    if (!isMeaningfulTranscriptText(text)) {
      finalAssistantOutput = undefined;
      continue;
    }

    finalAssistantOutput = { role, text, usage };
  }

  if (finalAssistantOutput) {
    return { foundRequest: true, output: finalAssistantOutput.text, usage: finalAssistantOutput.usage ?? latestUsage };
  }

  return { foundRequest: true, ...(latestUsage ? { usage: latestUsage } : {}) };
}

function findLastMessageIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}

function extractMessageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(extractMessageText).filter(Boolean).join("\n");
  }
  if (!isRecord(value)) return "";

  const direct =
    readRawString(value.text) ??
    readRawString(value.message) ??
    readRawString(value.output);
  if (direct !== undefined) return direct;

  const content = extractMessageText(value.content);
  if (content) return content;

  for (const key of ["result", "data", "artifact", "artifacts"]) {
    const visible = stringifyVisibleValue(value[key]);
    if (visible) return visible;
  }
  return "";
}

function stringifyVisibleValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) || isRecord(value)) return JSON.stringify(value, null, 2);
  return undefined;
}

function isMeaningfulTranscriptText(value: string): boolean {
  const normalized = value.trim();
  return Boolean(normalized && normalized.toLowerCase() !== "completed");
}

function readUsageFact(value: unknown, fallbackModelId?: string, fallbackId?: string): RuntimeUsageFact | undefined {
  const candidate = findUsageRecord(value);
  if (!candidate) return undefined;

  const baseInputTokens =
    readNumberFromRecord(candidate, ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens", "tokensIn", "tokens_in"]) ?? 0;
  const cachedInputTokens =
    readNumberFromRecord(candidate, [
      "cachedInputTokens",
      "cached_input_tokens",
      "cacheReadInputTokens",
      "cache_read_input_tokens",
      "cacheCreationInputTokens",
      "cache_creation_input_tokens",
    ]) ?? 0;
  const inputTokens = baseInputTokens + cachedInputTokens;
  const outputTokens =
    readNumberFromRecord(candidate, ["outputTokens", "output_tokens", "completionTokens", "completion_tokens", "tokensOut", "tokens_out"]) ?? 0;
  const totalTokens = readNumberFromRecord(candidate, ["totalTokens", "total_tokens", "tokens", "tokenCount", "token_count"]);
  const normalizedOutputTokens = outputTokens || Math.max(0, (totalTokens ?? 0) - inputTokens);
  const modelId = readModelId(candidate) ?? readModelId(value) ?? fallbackModelId;

  if (!modelId || inputTokens + normalizedOutputTokens <= 0) return undefined;

  return {
    id: readString(candidate.id) ?? readString(candidate.usageId) ?? (fallbackId ? `usage-${fallbackId}` : createGatewayId("usage")),
    modelId,
    inputTokens,
    outputTokens: normalizedOutputTokens,
    costUsd: readNumberFromRecord(candidate, ["costUsd", "cost_usd", "costUSD", "usd", "cost", "totalCostUsd", "total_cost_usd"]) ?? 0,
    recordedAt: readUsageRecordedAt(candidate) ?? new Date().toISOString(),
  };
}

function findUsageRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;

  for (const key of ["usage", "tokenUsage", "usageMetadata", "usageStats", "metrics"]) {
    const candidate = value[key];
    if (looksLikeUsageRecord(candidate)) return candidate;
  }

  for (const key of ["result", "response", "message", "assistant", "metadata", "metrics"]) {
    const nested = findUsageRecord(value[key]);
    if (nested) return nested;
  }

  return looksLikeUsageRecord(value) ? value : undefined;
}

function looksLikeUsageRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return (
    readNumberFromRecord(value, [
      "inputTokens",
      "input_tokens",
      "promptTokens",
      "prompt_tokens",
      "outputTokens",
      "output_tokens",
      "completionTokens",
      "completion_tokens",
      "totalTokens",
      "total_tokens",
      "tokens",
      "tokenCount",
      "token_count",
    ]) !== undefined
  );
}

function readModelId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const direct =
    readString(value.modelId) ??
    readString(value.model_id) ??
    readString(value.model) ??
    readString(value.primaryModel) ??
    readString(value.primary_model);
  if (direct) return direct;

  const provider = readString(value.provider);
  const model = isRecord(value.model) ? readString(value.model.id) ?? readString(value.model.name) : undefined;
  return provider && model ? `${provider}/${model}` : undefined;
}

function readUsageRecordedAt(value: Record<string, unknown>): string | undefined {
  const direct = readString(value.recordedAt) ?? readString(value.recorded_at) ?? readString(value.createdAt) ?? readString(value.created_at);
  if (direct) return direct;
  const timestampMs = readNumber(value.timestampMs) ?? readNumber(value.timestamp_ms) ?? readNumber(value.createdAtMs);
  return timestampMs ? new Date(timestampMs).toISOString() : undefined;
}

function readNumberFromRecord(value: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const direct = readNumber(value[key]);
    if (direct !== undefined) return direct;
    if (typeof value[key] === "string") {
      const parsed = Number(value[key]);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function mapExecutionStatus(status: string | undefined): RuntimeTaskSummary["status"] {
  if (status === "running" || status === "queued" || status === "failed" || status === "cancelled") {
    return status;
  }
  return "succeeded";
}

function mapGatewaySessionStatus(status: string | undefined): RuntimeExecutionStatus | undefined {
  if (status === "queued" || status === "running" || status === "succeeded" || status === "failed" || status === "cancelled") {
    return status;
  }
  if (status === "accepted" || status === "processing" || status === "active") {
    return "running";
  }
  if (status === "done" || status === "complete" || status === "completed") {
    return "succeeded";
  }
  if (status === "error") {
    return "failed";
  }
  if (status === "aborted") {
    return "cancelled";
  }
  return undefined;
}

function mapAcceptedExecutionStatus(status: string | undefined): StartedAgentTaskResult["status"] {
  if (status === "running" || status === "queued" || status === "succeeded" || status === "failed" || status === "cancelled") {
    return status;
  }
  if (status === "accepted") {
    return "running";
  }
  return "running";
}

function buildAgentMainSessionKey(agentId: string | undefined): string {
  const normalizedAgentId = normalizeAgentId(agentId ?? "main");
  return `agent:${normalizedAgentId}:main`;
}

function normalizeAgentId(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/g, "").replace(/-+$/g, "").slice(0, 64) || "main";
}

function dateFromMs(value: unknown): string {
  const ms = readNumber(value);
  return new Date(ms ?? Date.now()).toISOString();
}

function dateFromTimestamp(value: unknown): string {
  const text = readString(value);
  if (text) {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return dateFromMs(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRawString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function isRecoverableGatewaySessionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes("Gateway is not connected") ||
    error.message.includes("Gateway connection closed") ||
    error.message.includes("Gateway connect timeout")
  );
}

function isGatewayRequestTimeoutFor(error: unknown, method: string): boolean {
  return error instanceof Error && error.message === `OpenClaw Gateway request timeout for ${method}.`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
