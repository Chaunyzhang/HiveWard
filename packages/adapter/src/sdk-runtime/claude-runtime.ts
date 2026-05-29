import { nanoid } from "nanoid";
import {
  query as claudeQuery,
  type Options,
  type Query,
  type SDKMessage,
  type SDKResultMessage
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentTaskResult,
  ChatStreamEvent,
  RuntimeUsageFact,
  StartAgentTaskInput,
  StartedAgentTaskResult,
  WaitForAgentTaskInput
} from "@hiveward/shared";
import { AgentSdkError, formatAgentSdkError, formatAgentSdkProviderError, getErrorMessage, isAbortLikeError } from "./errors";
import { mapClaudeAvailableTools, mapClaudePermission, mapClaudeTools, normalizeTaskRuntimeAccessPolicy } from "./permissions";
import { buildSdkChatPrompt, mapClaudeEffort, mapClaudeThinking } from "./chat-envelope";
import { buildPromptEnvelope, formatStructuredOutput, validateOutputSchema } from "./prompt-envelope";
import { isRecord, readString, runtimeLabelFromRecord } from "./runtime-state";
import { createTerminalTaskResult, AgentSdkTaskRegistry } from "./task-registry";
import type { AgentSdkChatStreamInput, AgentSdkRuntime } from "./types";
import { resolveSdkWorkingDirectory } from "./workspace";

export type ClaudeQueryFn = (params: { prompt: string; options?: Options }) => Query;

export class ClaudeAgentSdkRuntime implements AgentSdkRuntime {
  constructor(
    private readonly registry: AgentSdkTaskRegistry,
    private readonly options: { defaultTimeoutMs: number; workspaceRoot: string },
    private readonly queryFn: ClaudeQueryFn = claudeQuery
  ) {}

  async streamChatMessage(input: AgentSdkChatStreamInput, onEvent: (event: ChatStreamEvent) => void): Promise<void> {
    const now = new Date().toISOString();
    const taskId = `claude-chat-${nanoid(10)}`;
    const runId = `claude-chat-run-${nanoid(10)}`;
    let sessionKey = input.sessionKey || `claude-chat-session-${nanoid(10)}`;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort("timeout"), normalizeTimeout(input.timeoutMs, this.options.defaultTimeoutMs));

    onEvent({
      type: "started",
      taskId,
      runId,
      sessionKey,
      source: "claude",
      status: "running",
      updatedAt: now
    });

    try {
      const fullAccess = input.permissionMode === "full_access";
      const sdkOptions: Options = {
        abortController,
        cwd: this.options.workspaceRoot,
        model: normalizeClaudeModel(input.modelId),
        permissionMode: fullAccess ? "bypassPermissions" : mapClaudePermission("read_only"),
        ...(fullAccess
          ? { allowDangerouslySkipPermissions: true }
          : {
              tools: mapClaudeAvailableTools("read_only", []),
              allowedTools: mapClaudeTools("read_only", [])
            }),
        resume: input.sessionKey || undefined,
        settingSources: ["user", "project"],
        skills: input.skillIds?.length ? input.skillIds : undefined,
        thinking: mapClaudeThinking(input.thinking),
        effort: mapClaudeEffort(input.thinking),
        includePartialMessages: true,
        includeHookEvents: true
      };
      const prompt = buildSdkChatPrompt(input.message, input.attachments);
      let finalMessage: SDKResultMessage | undefined;
      let streamedOutput = "";

      for await (const message of this.queryFn({ prompt, options: sdkOptions })) {
        if (hasSessionId(message)) {
          sessionKey = message.session_id;
        }
        const deltaText = readClaudePartialDeltaText(message);
        if (deltaText) {
          streamedOutput = `${streamedOutput}${deltaText}`;
          onEvent({ type: "delta", text: deltaText });
          continue;
        }
        if (shouldEmitClaudeRuntimeEvent(message)) {
          onEvent(toClaudeRuntimeState(message));
          continue;
        }
        if (message.type === "result") {
          finalMessage = message;
        }
      }

      if (!finalMessage) {
        throw new Error(formatAgentSdkError("provider_error", "SDK did not return a result message."));
      }
      if (finalMessage.subtype !== "success") {
        onEvent({
          type: "done",
          taskId,
          runId,
          sessionKey,
          source: "claude",
          status: "failed",
          error: formatAgentSdkError("provider_error", finalMessage.errors.join("; ") || finalMessage.subtype),
          usage: mapClaudeUsage({ modelId: input.modelId }, finalMessage),
          updatedAt: new Date().toISOString()
        });
        return;
      }

      const output =
        finalMessage.structured_output === undefined
          ? finalMessage.result
          : formatStructuredOutput(finalMessage.structured_output);
      if (output && output !== streamedOutput) {
        if (!streamedOutput || output.startsWith(streamedOutput)) {
          onEvent({ type: "delta", text: output.slice(streamedOutput.length) });
        } else {
          onEvent({ type: "delta", text: output, replace: true });
        }
      }
      onEvent({
        type: "done",
        taskId,
        runId,
        sessionKey,
        source: "claude",
        status: "succeeded",
        output,
        usage: mapClaudeUsage({ modelId: input.modelId }, finalMessage),
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      onEvent({
        type: "done",
        taskId,
        runId,
        sessionKey,
        source: "claude",
        status: isAbortLikeError(error) || abortController.signal.aborted ? "cancelled" : "failed",
        error: isAbortLikeError(error) || abortController.signal.aborted
          ? formatAgentSdkError("cancelled", "Run was cancelled.")
          : formatAgentSdkProviderError("Claude Code", error),
        updatedAt: new Date().toISOString()
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async startTask(input: StartAgentTaskInput): Promise<StartedAgentTaskResult> {
    const now = new Date().toISOString();
    const taskId = `claude-task-${nanoid(10)}`;
    const runId = `claude-run-${nanoid(10)}`;
    const sessionKey = `claude-session-${input.nodeRunId}`;

    let workingDirectory: string;
    try {
      requireConfiguredModel(input.modelId);
      workingDirectory = resolveSdkWorkingDirectory(input.workingDirectory, this.options.workspaceRoot);
    } catch (error) {
      return this.failedStart(taskId, runId, sessionKey, getErrorMessage(error), now);
    }

    const timeoutMs = normalizeTimeout(input.timeoutMs, this.options.defaultTimeoutMs);
    const abortController = new AbortController();
    let timedOut = false;
    const final = this.registry.runWithConcurrency(() =>
      this.runClaudeTask({
        input,
        taskId,
        runId,
        initialSessionKey: sessionKey,
        workingDirectory,
        abortController,
        isTimedOut: () => timedOut
      })
    );
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort("timeout");
    }, timeoutMs);

    this.registry.register({
      taskId,
      runId,
      provider: "claude",
      nodeRunId: input.nodeRunId,
      blueprintRunId: input.blueprintRunId,
      sessionKey,
      startedAt: now,
      abortController,
      timeout,
      final
    });

    return {
      taskId,
      runId,
      sessionKey,
      source: "claude",
      status: "running",
      updatedAt: now
    };
  }

  waitForTask(input: WaitForAgentTaskInput): Promise<AgentTaskResult> {
    return this.registry.waitForTask(input);
  }

  cancelTask(input: WaitForAgentTaskInput): Promise<AgentTaskResult> {
    return this.registry.cancelTask(input);
  }

  private async runClaudeTask({
    input,
    taskId,
    runId,
    initialSessionKey,
    workingDirectory,
    abortController,
    isTimedOut
  }: {
    input: StartAgentTaskInput;
    taskId: string;
    runId: string;
    initialSessionKey: string;
    workingDirectory: string;
    abortController: AbortController;
    isTimedOut: () => boolean;
  }): Promise<AgentTaskResult> {
    let sessionKey = initialSessionKey;
    let finalMessage: SDKResultMessage | undefined;

    try {
      if (abortController.signal.aborted) {
        return this.cancelledResult(taskId, runId, sessionKey, isTimedOut());
      }

      const runtimeAccessPolicy = normalizeTaskRuntimeAccessPolicy(input, "claude");
      const permissionProfile = runtimeAccessPolicy.filesystem;
      const sdkOptions: Options = {
        abortController,
        cwd: workingDirectory,
        model: normalizeClaudeModel(input.modelId),
        permissionMode: mapClaudePermission(permissionProfile),
        tools: mapClaudeAvailableTools(permissionProfile, input.tools),
        allowedTools: mapClaudeTools(permissionProfile, input.tools),
        skills: input.skillIds?.length ? input.skillIds : undefined,
        outputFormat: input.outputSchema ? { type: "json_schema", schema: input.outputSchema } : undefined
      };

      for await (const message of this.queryFn({ prompt: buildPromptEnvelope(input), options: sdkOptions })) {
        if (hasSessionId(message)) {
          sessionKey = message.session_id;
        }
        if (message.type === "result") {
          finalMessage = message;
        }
      }
    } catch (error) {
      if (isAbortLikeError(error) || abortController.signal.aborted) {
        return this.cancelledResult(taskId, runId, sessionKey, isTimedOut());
      }
      if (error instanceof AgentSdkError) {
        return createTerminalTaskResult({
          taskId,
          runId,
          sessionKey,
          source: "claude",
          status: "failed",
          error: error.message
        });
      }
      return createTerminalTaskResult({
        taskId,
        runId,
        sessionKey,
        source: "claude",
        status: "failed",
        error: formatAgentSdkProviderError("Claude Code", error)
      });
    }

    if (!finalMessage) {
      return createTerminalTaskResult({
        taskId,
        runId,
        sessionKey,
        source: "claude",
        status: "failed",
        error: formatAgentSdkError("provider_error", "SDK did not return a result message.")
      });
    }

    if (finalMessage.subtype !== "success") {
      return createTerminalTaskResult({
        taskId,
        runId,
        sessionKey,
        source: "claude",
        status: "failed",
        error: formatAgentSdkError("provider_error", finalMessage.errors.join("; ") || finalMessage.subtype),
        usage: mapClaudeUsage(input, finalMessage)
      });
    }

    const output =
      finalMessage.structured_output === undefined
        ? finalMessage.result
        : formatStructuredOutput(finalMessage.structured_output);
    if (!validateOutputSchema(output, input.outputSchema)) {
      return createTerminalTaskResult({
        taskId,
        runId,
        sessionKey,
        source: "claude",
        status: "failed",
        error: formatAgentSdkError("invalid_output", "SDK output does not match outputSchema."),
        usage: mapClaudeUsage(input, finalMessage)
      });
    }

    return {
      taskId,
      runId,
      sessionKey,
      source: "claude",
      status: "succeeded",
      output,
      usage: mapClaudeUsage(input, finalMessage),
      updatedAt: new Date().toISOString()
    };
  }

  private failedStart(taskId: string, runId: string, sessionKey: string, error: string, updatedAt: string): StartedAgentTaskResult {
    return {
      taskId,
      runId,
      sessionKey,
      source: "claude",
      status: "failed",
      error,
      updatedAt
    };
  }

  private cancelledResult(taskId: string, runId: string, sessionKey: string, timedOut: boolean): AgentTaskResult {
    return createTerminalTaskResult({
      taskId,
      runId,
      sessionKey,
      source: "claude",
      status: "cancelled",
      error: timedOut ? formatAgentSdkError("timeout", "Run exceeded timeoutMs.") : formatAgentSdkError("cancelled", "Run was cancelled.")
    });
  }
}

function shouldEmitClaudeRuntimeEvent(message: SDKMessage): boolean {
  if (message.type === "assistant" || message.type === "user" || message.type === "result" || message.type === "stream_event") {
    return false;
  }
  return true;
}

function toClaudeRuntimeState(message: SDKMessage): ChatStreamEvent {
  return {
    type: "runtime_state",
    source: "claude",
    phase: claudeRuntimePhaseForMessage(message),
    label: claudeRuntimeLabelForMessage(message)
  };
}

function claudeRuntimePhaseForMessage(message: SDKMessage): Extract<ChatStreamEvent, { type: "runtime_state" }>["phase"] {
  const record = message as Record<string, unknown>;
  const subtype = readString(record.subtype);
  if (subtype === "command_execution") return "command";
  if (message.type === "tool_progress" || message.type.includes("tool") || subtype?.includes("tool")) return "tool";
  return "thinking";
}

function claudeRuntimeLabelForMessage(message: SDKMessage): string {
  const record = message as Record<string, unknown>;
  return runtimeLabelFromRecord(record, readString(record.subtype) ?? message.type);
}

function readClaudePartialDeltaText(message: SDKMessage): string | undefined {
  if (message.type !== "stream_event") return undefined;
  const streamEvent = (message as { event?: unknown }).event;
  if (!isRecord(streamEvent)) return undefined;
  const delta = streamEvent.delta;
  if (!isRecord(delta)) return undefined;
  if (delta.type === "text_delta") return readString(delta.text);
  return undefined;
}

function requireConfiguredModel(modelId: string | undefined): void {
  if (!modelId?.trim()) {
    throw new Error(formatAgentSdkError("model_not_configured", "Claude Code agent node requires an explicit modelId."));
  }
}

function normalizeClaudeModel(modelId: string | undefined): string | undefined {
  const trimmed = modelId?.trim();
  return !trimmed || trimmed === "inherit" ? undefined : trimmed;
}

function mapClaudeUsage(input: { modelId?: string }, result: SDKResultMessage): RuntimeUsageFact {
  const modelUsageEntries = Object.entries(result.modelUsage);
  const inputTokens = modelUsageEntries.reduce(
    (sum, [, usage]) => sum + usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens,
    0
  );
  const outputTokens = modelUsageEntries.reduce((sum, [, usage]) => sum + usage.outputTokens, 0);

  return {
    id: `usage-${nanoid(10)}`,
    modelId: input.modelId ?? modelUsageEntries[0]?.[0] ?? "claude",
    inputTokens: inputTokens || readUsageNumber(result.usage, ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]),
    outputTokens: outputTokens || readUsageNumber(result.usage, ["output_tokens"]),
    costUsd: Number(result.total_cost_usd.toFixed(6)),
    recordedAt: new Date().toISOString()
  };
}

function readUsageNumber(usage: unknown, keys: string[]): number {
  if (!usage || typeof usage !== "object") return 0;
  const record = usage as Record<string, unknown>;
  return keys.reduce((sum, key) => sum + (typeof record[key] === "number" ? record[key] : 0), 0);
}

function hasSessionId(message: SDKMessage): message is SDKMessage & { session_id: string } {
  return "session_id" in message && typeof message.session_id === "string";
}

function normalizeTimeout(value: number | undefined, defaultValue: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : defaultValue;
}
