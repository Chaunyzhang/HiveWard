import { nanoid } from "nanoid";
import { Codex, type ThreadEvent, type ThreadOptions, type TurnOptions, type Usage } from "@openai/codex-sdk";
import type {
  AgentTaskResult,
  ChatStreamEvent,
  RuntimeUsageFact,
  StartAgentTaskInput,
  StartedAgentTaskResult,
  WaitForAgentTaskInput
} from "@hiveward/shared";
import { formatAgentSdkError, formatAgentSdkProviderError, getErrorMessage, isAbortLikeError } from "./errors";
import { mapCodexSandbox, normalizeTaskRuntimeAccessPolicy } from "./permissions";
import { buildSdkChatPrompt, mapCodexReasoningEffort } from "./chat-envelope";
import { buildPromptEnvelope, toCodexOutputSchema, validateOutputSchema } from "./prompt-envelope";
import { runtimeLabelFromRecord } from "./runtime-state";
import { createTerminalTaskResult, AgentSdkTaskRegistry } from "./task-registry";
import type { AgentSdkChatStreamInput, AgentSdkRuntime } from "./types";
import { assertGitWorkspace, resolveSdkWorkingDirectory } from "./workspace";

export interface CodexThreadLike {
  readonly id: string | null;
  run(input: string, turnOptions?: TurnOptions): Promise<{ finalResponse: string; usage: Usage | null }>;
  runStreamed?(input: string, turnOptions?: TurnOptions): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
}

export interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread?(id: string, options?: ThreadOptions): CodexThreadLike;
}

export type CreateCodexClient = () => CodexClientLike;

export class CodexAgentSdkRuntime implements AgentSdkRuntime {
  private readonly createCodexClient: CreateCodexClient;

  constructor(
    private readonly registry: AgentSdkTaskRegistry,
    private readonly options: { defaultTimeoutMs: number; workspaceRoot: string },
    createCodexClient?: CreateCodexClient,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {
    this.createCodexClient = createCodexClient ?? (() => new Codex({ apiKey: this.env.CODEX_API_KEY }));
  }

  async streamChatMessage(input: AgentSdkChatStreamInput, onEvent: (event: ChatStreamEvent) => void): Promise<void> {
    const now = new Date().toISOString();
    const taskId = `codex-chat-${nanoid(10)}`;
    const runId = `codex-chat-run-${nanoid(10)}`;
    let sessionKey = input.sessionKey || `codex-chat-session-${nanoid(10)}`;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort("timeout"), normalizeTimeout(input.timeoutMs, this.options.defaultTimeoutMs));

    onEvent({
      type: "started",
      taskId,
      runId,
      sessionKey,
      source: "codex",
      status: "running",
      updatedAt: now
    });

    try {
      requireConfiguredModel(input.modelId);
      assertGitWorkspace(this.options.workspaceRoot, this.options.workspaceRoot);

      const codex = this.createCodexClient();
      const fullAccess = input.permissionMode === "full_access";
      const threadOptions: ThreadOptions = {
        model: input.modelId,
        workingDirectory: this.options.workspaceRoot,
        sandboxMode: fullAccess ? "danger-full-access" : mapCodexSandbox("read_only"),
        approvalPolicy: "never",
        networkAccessEnabled: fullAccess,
        webSearchMode: fullAccess ? "live" : "disabled",
        webSearchEnabled: fullAccess,
        modelReasoningEffort: mapCodexReasoningEffort(input.thinking)
      };
      const thread = input.sessionKey && codex.resumeThread
        ? codex.resumeThread(input.sessionKey, threadOptions)
        : codex.startThread(threadOptions);
      const prompt = buildSdkChatPrompt(input.message, input.attachments);
      const output = thread.runStreamed
        ? await this.runStreamedChatTurn(thread, prompt, { signal: abortController.signal }, onEvent, (nextSessionKey) => {
            sessionKey = nextSessionKey;
          })
        : await this.runBufferedChatTurn(thread, prompt, { signal: abortController.signal }, onEvent);

      sessionKey = thread.id ?? sessionKey;
      onEvent({
        type: "done",
        taskId,
        runId,
        sessionKey,
        source: "codex",
        status: "succeeded",
        output: output.text,
        usage: output.usage ? mapCodexUsage({ modelId: input.modelId }, output.usage) : undefined,
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      onEvent({
        type: "done",
        taskId,
        runId,
        sessionKey,
        source: "codex",
        status: isAbortLikeError(error) || abortController.signal.aborted ? "cancelled" : "failed",
        error: isAbortLikeError(error) || abortController.signal.aborted
          ? formatAgentSdkError("cancelled", "Run was cancelled.")
          : formatAgentSdkProviderError("Codex", error),
        updatedAt: new Date().toISOString()
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async startTask(input: StartAgentTaskInput): Promise<StartedAgentTaskResult> {
    const now = new Date().toISOString();
    const taskId = `codex-task-${nanoid(10)}`;
    const runId = `codex-run-${nanoid(10)}`;
    const sessionKey = `codex-session-${input.nodeRunId}`;

    let workingDirectory: string;
    try {
      requireConfiguredModel(input.modelId);
      workingDirectory = resolveSdkWorkingDirectory(input.workingDirectory, this.options.workspaceRoot);
      assertGitWorkspace(workingDirectory, this.options.workspaceRoot);
    } catch (error) {
      return this.failedStart(taskId, runId, sessionKey, getErrorMessage(error), now);
    }

    const timeoutMs = normalizeTimeout(input.timeoutMs, this.options.defaultTimeoutMs);
    const abortController = new AbortController();
    let timedOut = false;
    const final = this.registry.runWithConcurrency(() =>
      this.runCodexTask({
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
      provider: "codex",
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
      source: "codex",
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

  private async runCodexTask({
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
    const runtimeAccessPolicy = normalizeTaskRuntimeAccessPolicy(input, "codex");
    const permissionProfile = runtimeAccessPolicy.filesystem;
    let sessionKey = initialSessionKey;

    try {
      if (abortController.signal.aborted) {
        return this.cancelledResult(taskId, runId, sessionKey, isTimedOut());
      }

      const outputSchema = toCodexOutputSchema(input.outputSchema);
      const codex = this.createCodexClient();
      const thread = codex.startThread({
        model: input.modelId,
        workingDirectory,
        sandboxMode: mapCodexSandbox(permissionProfile),
        approvalPolicy: "never",
        networkAccessEnabled: runtimeAccessPolicy.network === "enabled",
        webSearchMode: runtimeAccessPolicy.webSearch
      });
      const turn = await thread.run(buildPromptEnvelope({ ...input, outputSchema }), {
        outputSchema,
        signal: abortController.signal
      });
      sessionKey = thread.id ?? sessionKey;

      if (!validateOutputSchema(turn.finalResponse, input.outputSchema)) {
        return createTerminalTaskResult({
          taskId,
          runId,
          sessionKey,
          source: "codex",
          status: "failed",
          error: formatAgentSdkError("invalid_output", "SDK output does not match outputSchema."),
          usage: mapCodexUsage(input, turn.usage)
        });
      }

      return {
        taskId,
        runId,
        sessionKey,
        source: "codex",
        status: "succeeded",
        output: turn.finalResponse,
        usage: mapCodexUsage(input, turn.usage),
        updatedAt: new Date().toISOString()
      };
    } catch (error) {
      if (isAbortLikeError(error) || abortController.signal.aborted) {
        return this.cancelledResult(taskId, runId, sessionKey, isTimedOut());
      }
      return createTerminalTaskResult({
        taskId,
        runId,
        sessionKey,
        source: "codex",
        status: "failed",
        error: formatAgentSdkProviderError("Codex", error)
      });
    }
  }

  private failedStart(taskId: string, runId: string, sessionKey: string, error: string, updatedAt: string): StartedAgentTaskResult {
    return {
      taskId,
      runId,
      sessionKey,
      source: "codex",
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
      source: "codex",
      status: "cancelled",
      error: timedOut ? formatAgentSdkError("timeout", "Run exceeded timeoutMs.") : formatAgentSdkError("cancelled", "Run was cancelled.")
    });
  }

  private async runBufferedChatTurn(
    thread: CodexThreadLike,
    prompt: string,
    turnOptions: TurnOptions,
    onEvent: (event: ChatStreamEvent) => void
  ): Promise<{ text: string; usage: Usage | null }> {
    const turn = await thread.run(prompt, turnOptions);
    if (turn.finalResponse) {
      onEvent({ type: "delta", text: turn.finalResponse });
    }
    return {
      text: turn.finalResponse,
      usage: turn.usage
    };
  }

  private async runStreamedChatTurn(
    thread: CodexThreadLike,
    prompt: string,
    turnOptions: TurnOptions,
    onEvent: (event: ChatStreamEvent) => void,
    onSessionKey: (sessionKey: string) => void
  ): Promise<{ text: string; usage: Usage | null }> {
    if (!thread.runStreamed) {
      return this.runBufferedChatTurn(thread, prompt, turnOptions, onEvent);
    }

    const { events } = await thread.runStreamed(prompt, turnOptions);
    let output = "";
    let usage: Usage | null = null;
    const agentMessageTexts = new Map<string, string>();
    for await (const event of events) {
      if (event.type === "thread.started") {
        onSessionKey(event.thread_id);
        continue;
      }
      if (event.type === "turn.completed") {
        usage = event.usage;
        continue;
      }
      if (event.type === "turn.failed") {
        throw new Error(event.error.message);
      }
      if (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") {
        continue;
      }
      if (event.item.type !== "agent_message") {
        onEvent(toCodexRuntimeState(event));
        continue;
      }
      if (!event.item.text) {
        continue;
      }
      agentMessageTexts.set(event.item.id, event.item.text);
      const nextOutput = Array.from(agentMessageTexts.values()).filter(Boolean).join("\n");
      if (nextOutput === output) {
        continue;
      }
      if (nextOutput.startsWith(output)) {
        onEvent({ type: "delta", text: nextOutput.slice(output.length) });
      } else {
        onEvent({ type: "delta", text: nextOutput, replace: true });
      }
      output = nextOutput;
    }
    return { text: output, usage };
  }
}

function toCodexRuntimeState(event: Extract<ThreadEvent, { type: "item.started" | "item.updated" | "item.completed" }>): ChatStreamEvent {
  return {
    type: "runtime_state",
    source: "codex",
    phase: codexRuntimePhaseForItem(event.item.type),
    label: runtimeLabelFromRecord(event.item as Record<string, unknown>, event.item.type)
  };
}

function codexRuntimePhaseForItem(itemType: string): Extract<ChatStreamEvent, { type: "runtime_state" }>["phase"] {
  if (itemType === "command_execution") return "command";
  if (
    itemType === "mcp_tool_call" ||
    itemType === "tool_use_summary" ||
    itemType === "web_search" ||
    itemType === "file_change" ||
    itemType.includes("tool")
  ) {
    return "tool";
  }
  return "thinking";
}

function requireConfiguredModel(modelId: string | undefined): void {
  if (!modelId?.trim()) {
    throw new Error(formatAgentSdkError("model_not_configured", "Codex agent node requires an explicit modelId."));
  }
}

function mapCodexUsage(input: { modelId?: string }, usage: Usage | null): RuntimeUsageFact {
  return {
    id: `usage-${nanoid(10)}`,
    modelId: input.modelId ?? "codex",
    inputTokens: usage ? usage.input_tokens + usage.cached_input_tokens : 0,
    outputTokens: usage ? usage.output_tokens + usage.reasoning_output_tokens : 0,
    costUsd: 0,
    recordedAt: new Date().toISOString()
  };
}

function normalizeTimeout(value: number | undefined, defaultValue: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : defaultValue;
}
