import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SDKMessage, Query } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadEvent, ThreadOptions, TurnOptions, Usage } from "@openai/codex-sdk";
import { ClaudeAgentSdkRuntime, type ClaudeQueryFn } from "./claude-runtime";
import { CliAgentSdkRuntime, type CliCommandInput, type RunCliCommand } from "./cli-runtime";
import { CodexAgentSdkRuntime, type CodexClientLike, type CodexThreadLike } from "./codex-runtime";
import { mapClaudePermission, mapClaudeTools, mapCodexSandbox } from "./permissions";
import { buildPromptEnvelope, toCodexOutputSchema, validateOutputSchema } from "./prompt-envelope";
import { AgentSdkTaskRegistry } from "./task-registry";
import { readAgentSdkRuntimeOptions } from "./types";

describe("agent SDK runtime", () => {
  it("builds a stable prompt envelope without secret values", () => {
    const envelope = buildPromptEnvelope({
      blueprintRunId: "run-1",
      nodeRunId: "node-run-1",
      source: "claude",
      agentName: "reviewer",
      prompt: "Review the change.",
      skillIds: ["hiveward-leader"],
      input: {
        z: 1,
        a: {
          token: "secret-token",
          value: "visible"
        }
      },
      tools: []
    });

    expect(envelope).toContain("Blueprint run: run-1");
    expect(envelope).toContain("Selected skills:");
    expect(envelope).toContain("- hiveward-leader");
    expect(envelope).toContain('"a"');
    expect(envelope).toContain('"z"');
    expect(envelope).toContain("<redacted>");
    expect(envelope).not.toContain("secret-token");
    expect(envelope.indexOf('"a"')).toBeLessThan(envelope.indexOf('"z"'));
  });

  it("converts optional Codex output schema properties to nullable required fields", () => {
    const schema = {
      type: "object",
      required: ["status"],
      properties: {
        status: { type: "string" },
        handoffJson: { type: ["object", "null"] },
        nextSlot: { type: "integer" },
        reason: { type: "string" }
      }
    };

    expect(toCodexOutputSchema(schema)).toEqual({
      type: "object",
      required: ["status", "handoffJson", "nextSlot", "reason"],
      additionalProperties: false,
      properties: {
        status: { type: "string" },
        handoffJson: { type: ["object", "null"], additionalProperties: false, properties: {}, required: [] },
        nextSlot: { type: ["integer", "null"] },
        reason: { type: ["string", "null"] }
      }
    });
    expect(validateOutputSchema('{"status":"complete","handoffJson":{},"nextSlot":null,"reason":null}', schema)).toBe(true);
  });

  it("maps permission profiles to provider SDK settings", () => {
    expect(mapClaudePermission("read_only")).toBe("dontAsk");
    expect(mapClaudeTools("read_only", ["repo.test"])).not.toContain("Bash(npm test:*)");
    expect(mapClaudeTools("workspace_write", ["repo.test"])).toContain("Bash(npm test:*)");
    expect(mapCodexSandbox("read_only")).toBe("read-only");
    expect(mapCodexSandbox("workspace_write")).toBe("workspace-write");
  });

  it("defaults SDK task timeout to one hour", () => {
    const options = readAgentSdkRuntimeOptions(createWorkspace(), { HIVEWARD_AGENT_SDK_MAX_CONCURRENCY: "2" });
    expect(options.defaultTimeoutMs).toBe(3_600_000);
  });

  it("fails Claude tasks that request unsupported network or web search policy changes", async () => {
    const workspace = createWorkspace();
    let claudeCalled = false;
    const runtime = new ClaudeAgentSdkRuntime(
      new AgentSdkTaskRegistry(2),
      { defaultTimeoutMs: 60_000, workspaceRoot: workspace },
      () => {
        claudeCalled = true;
        return fakeClaudeQuery([])({ prompt: "" });
      }
    );

    const started = await runtime.startTask(
      createStartInput({
        source: "claude",
        workingDirectory: workspace,
        runtimeAccessPolicy: {
          filesystem: "read_only",
          network: "disabled",
          webSearch: "live"
        }
      })
    );
    const result = await runtime.waitForTask({
      nodeRunId: "node-run-1",
      taskId: started.taskId,
      runId: started.runId,
      sessionKey: started.sessionKey,
      source: "claude"
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("does not support requested access policy axes: network, webSearch");
    expect(claudeCalled).toBe(false);
  });

  it("maps Codex runtime access policy axes into native thread options", async () => {
    const workspace = createWorkspace({ git: true });
    let threadOptions: ThreadOptions | undefined;
    const runtime = new CodexAgentSdkRuntime(
      new AgentSdkTaskRegistry(2),
      { defaultTimeoutMs: 60_000, workspaceRoot: workspace },
      () => fakeCodexClient({
        threadId: "codex-policy-thread",
        onStartThread: (options) => {
          threadOptions = options;
        },
        finalResponse: "policy ok",
        usage: null
      })
    );

    const started = await runtime.startTask(
      createStartInput({
        source: "codex",
        workingDirectory: workspace,
        runtimeAccessPolicy: {
          filesystem: "workspace_write",
          network: "disabled",
          webSearch: "live"
        }
      })
    );
    const result = await runtime.waitForTask({
      nodeRunId: "node-run-1",
      taskId: started.taskId,
      runId: started.runId,
      sessionKey: started.sessionKey,
      source: "codex"
    });

    expect(result.status).toBe("succeeded");
    expect(threadOptions).toMatchObject({
      sandboxMode: "workspace-write",
      networkAccessEnabled: false,
      webSearchMode: "live"
    });
  });

  it("starts Claude through the SDK without a platform auth precheck", async () => {
    const workspace = createWorkspace();
    let options: Parameters<ClaudeQueryFn>[0]["options"];
    const runtime = new ClaudeAgentSdkRuntime(
      new AgentSdkTaskRegistry(2),
      { defaultTimeoutMs: 60_000, workspaceRoot: workspace },
      (params) => {
        options = params.options;
        return fakeClaudeQuery([
          {
            type: "result",
            subtype: "success",
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            num_turns: 1,
            result: "ok",
            stop_reason: null,
            total_cost_usd: 0,
            usage: {},
            modelUsage: {},
            permission_denials: [],
            uuid: "uuid-auth-owned-by-sdk",
            session_id: "claude-session-auth-owned-by-sdk"
          } as unknown as SDKMessage
        ])(params);
      }
    );

    const started = await runtime.startTask(
      createStartInput({ source: "claude", workingDirectory: workspace, skillIds: ["hiveward-leader"] })
    );
    const result = await runtime.waitForTask({
      nodeRunId: "node-run-1",
      taskId: started.taskId,
      runId: started.runId,
      sessionKey: started.sessionKey,
      source: "claude"
    });

    expect(started.status).toBe("running");
    expect(started.source).toBe("claude");
    expect(options?.skills).toEqual(["hiveward-leader"]);
    expect(result.status).toBe("succeeded");
  });

  it("fails SDK nodes before provider calls when modelId is missing", async () => {
    const workspace = createWorkspace({ git: true });
    let claudeCalled = false;
    let codexCalled = false;
    const claudeRuntime = new ClaudeAgentSdkRuntime(
      new AgentSdkTaskRegistry(2),
      { defaultTimeoutMs: 60_000, workspaceRoot: workspace },
      () => {
        claudeCalled = true;
        return fakeClaudeQuery([])({ prompt: "" });
      }
    );
    const codexRuntime = new CodexAgentSdkRuntime(
      new AgentSdkTaskRegistry(2),
      { defaultTimeoutMs: 60_000, workspaceRoot: workspace },
      () => {
        codexCalled = true;
        return fakeCodexClient({ threadId: "unused", finalResponse: "unused", usage: null });
      }
    );

    const claudeStarted = await claudeRuntime.startTask(
      createStartInput({ source: "claude", workingDirectory: workspace, modelId: undefined })
    );
    const codexStarted = await codexRuntime.startTask(
      createStartInput({ source: "codex", workingDirectory: workspace, modelId: undefined })
    );

    expect(claudeStarted.status).toBe("failed");
    expect(claudeStarted.error).toContain("model_not_configured");
    expect(codexStarted.status).toBe("failed");
    expect(codexStarted.error).toContain("model_not_configured");
    expect(claudeCalled).toBe(false);
    expect(codexCalled).toBe(false);
  });

  it("normalizes a Claude SDK success result", async () => {
    const workspace = createWorkspace();
    const runtime = new ClaudeAgentSdkRuntime(
      new AgentSdkTaskRegistry(2),
      { defaultTimeoutMs: 60_000, workspaceRoot: workspace },
      fakeClaudeQuery([
        {
          type: "result",
          subtype: "success",
          duration_ms: 1,
          duration_api_ms: 1,
          is_error: false,
          num_turns: 1,
          result: "{\"ok\":true}",
          stop_reason: null,
          total_cost_usd: 0.001234,
          usage: {},
          modelUsage: {
            "claude-test": {
              inputTokens: 10,
              outputTokens: 5,
              cacheReadInputTokens: 2,
              cacheCreationInputTokens: 3,
              webSearchRequests: 0,
              costUSD: 0.001234,
              contextWindow: 200000,
              maxOutputTokens: 4096
            }
          },
          permission_denials: [],
          uuid: "uuid-1",
          session_id: "claude-session-1"
        } as unknown as SDKMessage
      ])
    );

    const started = await runtime.startTask(
      createStartInput({
        source: "claude",
        workingDirectory: workspace,
        outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }
      })
    );
    const result = await runtime.waitForTask({
      nodeRunId: "node-run-1",
      taskId: started.taskId,
      runId: started.runId,
      sessionKey: started.sessionKey,
      source: "claude"
    });

    expect(result.status).toBe("succeeded");
    expect(result.source).toBe("claude");
    expect(result.sessionKey).toBe("claude-session-1");
    expect(result.output).toBe("{\"ok\":true}");
    expect(result.usage?.inputTokens).toBe(15);
    expect(result.usage?.outputTokens).toBe(5);
  });

  it("normalizes a Codex SDK success result", async () => {
    const workspace = createWorkspace({ git: true });
    let threadOptions: ThreadOptions | undefined;
    let turnOptions: TurnOptions | undefined;
    const runtime = new CodexAgentSdkRuntime(
      new AgentSdkTaskRegistry(2),
      { defaultTimeoutMs: 60_000, workspaceRoot: workspace },
      () => fakeCodexClient({
        threadId: "codex-thread-1",
        onStartThread: (options) => {
          threadOptions = options;
        },
        onRun: (_prompt, options) => {
          turnOptions = options;
        },
        finalResponse: "{\"ok\":true}",
        usage: {
          input_tokens: 11,
          cached_input_tokens: 7,
          output_tokens: 13,
          reasoning_output_tokens: 17
        }
      })
    );

    const started = await runtime.startTask(
      createStartInput({
        source: "codex",
        permissionProfile: "workspace_write",
        workingDirectory: workspace,
        outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }
      })
    );
    const result = await runtime.waitForTask({
      nodeRunId: "node-run-1",
      taskId: started.taskId,
      runId: started.runId,
      sessionKey: started.sessionKey,
      source: "codex"
    });

    expect(threadOptions?.workingDirectory).toBe(workspace);
    expect(threadOptions?.model).toBe("test-model");
    expect(threadOptions?.sandboxMode).toBe("workspace-write");
    expect(threadOptions?.approvalPolicy).toBe("never");
    expect(turnOptions?.outputSchema).toEqual({
      type: "object",
      required: ["ok"],
      additionalProperties: false,
      properties: { ok: { type: "boolean" } }
    });
    expect(result.status).toBe("succeeded");
    expect(result.source).toBe("codex");
    expect(result.sessionKey).toBe("codex-thread-1");
    expect(result.usage?.inputTokens).toBe(18);
    expect(result.usage?.outputTokens).toBe(30);
  });

  it("streams Codex chat through a read-only native thread by default", async () => {
    const workspace = createWorkspace({ git: true });
    let threadOptions: ThreadOptions | undefined;
    let turnOptions: TurnOptions | undefined;
    const runtime = new CodexAgentSdkRuntime(
      new AgentSdkTaskRegistry(2),
      { defaultTimeoutMs: 60_000, workspaceRoot: workspace },
      () => fakeCodexClient({
        threadId: "codex-thread-chat",
        onStartThread: (options) => {
          threadOptions = options;
        },
        onRunStreamed: (_prompt, options) => {
          turnOptions = options;
        },
        streamEvents: [
          { type: "thread.started", thread_id: "codex-thread-chat" },
          { type: "item.completed", item: { id: "item-1", type: "agent_message", text: "hello from codex" } },
          {
            type: "turn.completed",
            usage: {
              input_tokens: 3,
              cached_input_tokens: 2,
              output_tokens: 5,
              reasoning_output_tokens: 7
            }
          }
        ],
        finalResponse: "unused",
        usage: null
      })
    );
    const events: unknown[] = [];

    await runtime.streamChatMessage(
      {
        source: "codex",
        sessionKey: "",
        message: "Hello",
        attachments: [{ id: "a1", name: "note.txt", mediaType: "text/plain", size: 4, text: "note" }],
        modelId: "test-model",
        thinking: "high",
        idempotencyKey: "chat-1"
      },
      (event) => events.push(event)
    );

    expect(threadOptions).toMatchObject({
      workingDirectory: workspace,
      model: "test-model",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      webSearchEnabled: false,
      modelReasoningEffort: "high"
    });
    expect(turnOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(events).toEqual([
      expect.objectContaining({ type: "started", source: "codex", status: "running" }),
      { type: "delta", text: "hello from codex" },
      expect.objectContaining({
        type: "done",
        source: "codex",
        status: "succeeded",
        sessionKey: "codex-thread-chat",
        output: "hello from codex",
        usage: expect.objectContaining({ inputTokens: 5, outputTokens: 12 })
      })
    ]);
  });

  it("opts Codex chat into full local access when requested", async () => {
    const workspace = createWorkspace({ git: true });
    let threadOptions: ThreadOptions | undefined;
    const runtime = new CodexAgentSdkRuntime(
      new AgentSdkTaskRegistry(2),
      { defaultTimeoutMs: 60_000, workspaceRoot: workspace },
      () => fakeCodexClient({
        threadId: "codex-thread-full-access",
        onStartThread: (options) => {
          threadOptions = options;
        },
        finalResponse: "done",
        usage: null
      })
    );

    await runtime.streamChatMessage(
      {
        source: "codex",
        sessionKey: "",
        message: "Hello",
        attachments: [],
        modelId: "test-model",
        permissionMode: "full_access",
        idempotencyKey: "chat-full-access"
      },
      () => undefined
    );

    expect(threadOptions).toMatchObject({
      sandboxMode: "danger-full-access",
      networkAccessEnabled: true,
      webSearchMode: "live",
      webSearchEnabled: true
    });
  });

  it("emits Codex runtime events and streams official agent message updates", async () => {
    const workspace = createWorkspace({ git: true });
    const runtime = new CodexAgentSdkRuntime(
      new AgentSdkTaskRegistry(2),
      { defaultTimeoutMs: 60_000, workspaceRoot: workspace },
      () => fakeCodexClient({
        threadId: "codex-thread-chat-events",
        streamEvents: [
          { type: "thread.started", thread_id: "codex-thread-chat-events" },
          { type: "item.started", item: { id: "reason-1", type: "reasoning", text: "Inspecting files" } },
          {
            type: "item.updated",
            item: {
              id: "cmd-1",
              type: "command_execution",
              command: "rg stream",
              aggregated_output: "apps/web/src/components/ChatPage.tsx",
              status: "in_progress"
            }
          },
          { type: "item.started", item: { id: "msg-1", type: "agent_message", text: "Hel" } },
          { type: "item.updated", item: { id: "msg-1", type: "agent_message", text: "Hello" } },
          { type: "item.completed", item: { id: "msg-1", type: "agent_message", text: "Hello" } },
          {
            type: "turn.completed",
            usage: {
              input_tokens: 3,
              cached_input_tokens: 0,
              output_tokens: 2,
              reasoning_output_tokens: 1
            }
          }
        ],
        finalResponse: "unused",
        usage: null
      })
    );
    const events: unknown[] = [];

    await runtime.streamChatMessage(
      {
        source: "codex",
        sessionKey: "",
        message: "Hello",
        attachments: [],
        modelId: "test-model",
        thinking: "medium",
        idempotencyKey: "chat-events-1"
      },
      (event) => events.push(event)
    );

    expect(events).toEqual([
      expect.objectContaining({ type: "started", source: "codex", status: "running" }),
      expect.objectContaining({
        type: "runtime_state",
        source: "codex",
        phase: "thinking",
        label: "reasoning"
      }),
      expect.objectContaining({
        type: "runtime_state",
        source: "codex",
        phase: "command",
        label: "rg stream"
      }),
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
      expect.objectContaining({
        type: "done",
        source: "codex",
        status: "succeeded",
        output: "Hello",
        usage: expect.objectContaining({ inputTokens: 3, outputTokens: 3 })
      })
    ]);
  });

  it("maps Codex minimal chat reasoning to low for tool-compatible native threads", async () => {
    const workspace = createWorkspace({ git: true });
    let threadOptions: ThreadOptions | undefined;
    const runtime = new CodexAgentSdkRuntime(
      new AgentSdkTaskRegistry(2),
      { defaultTimeoutMs: 60_000, workspaceRoot: workspace },
      () => fakeCodexClient({
        threadId: "codex-thread-minimal",
        onStartThread: (options) => {
          threadOptions = options;
        },
        streamEvents: [],
        finalResponse: "",
        usage: null
      })
    );

    await runtime.streamChatMessage(
      {
        source: "codex",
        sessionKey: "",
        message: "Hello",
        attachments: [],
        modelId: "test-model",
        thinking: "minimal",
        idempotencyKey: "chat-minimal"
      },
      () => undefined
    );

    expect(threadOptions?.modelReasoningEffort).toBe("low");
  });

  it("streams Claude Code chat with the selected role skill enabled", async () => {
    const workspace = createWorkspace();
    let options: Parameters<ClaudeQueryFn>[0]["options"];
    const runtime = new ClaudeAgentSdkRuntime(
      new AgentSdkTaskRegistry(2),
      { defaultTimeoutMs: 60_000, workspaceRoot: workspace },
      (params) => {
        options = params.options;
        return fakeClaudeQuery([
          {
            type: "result",
            subtype: "success",
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            num_turns: 1,
            result: "hello from claude",
            stop_reason: null,
            total_cost_usd: 0,
            usage: {},
            modelUsage: {},
            permission_denials: [],
            uuid: "uuid-chat",
            session_id: "claude-session-chat"
          } as unknown as SDKMessage
        ])(params);
      }
    );
    const events: unknown[] = [];

    await runtime.streamChatMessage(
      {
        source: "claude",
        sessionKey: "claude-session-existing",
        message: "Hello",
        attachments: [],
        modelId: "inherit",
        thinking: "medium",
        idempotencyKey: "chat-2",
        skillIds: ["hiveward-leader"]
      },
      (event) => events.push(event)
    );

    expect(options).toMatchObject({
      cwd: workspace,
      permissionMode: "dontAsk",
      tools: ["Read", "Glob", "Grep", "LS"],
      allowedTools: ["Read", "Glob", "Grep", "LS"],
      resume: "claude-session-existing",
      settingSources: ["user", "project"],
      skills: ["hiveward-leader"],
      effort: "medium"
    });
    expect(options).not.toHaveProperty("allowDangerouslySkipPermissions");
    expect(options?.model).toBeUndefined();
    expect(events).toEqual([
      expect.objectContaining({ type: "started", source: "claude", status: "running" }),
      { type: "delta", text: "hello from claude" },
      expect.objectContaining({
        type: "done",
        source: "claude",
        status: "succeeded",
        sessionKey: "claude-session-chat",
        output: "hello from claude"
      })
    ]);
  });

  it("opts Claude Code chat into full local access when requested", async () => {
    const workspace = createWorkspace();
    let options: Parameters<ClaudeQueryFn>[0]["options"];
    const runtime = new ClaudeAgentSdkRuntime(
      new AgentSdkTaskRegistry(2),
      { defaultTimeoutMs: 60_000, workspaceRoot: workspace },
      (params) => {
        options = params.options;
        return fakeClaudeQuery([
          {
            type: "result",
            subtype: "success",
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            num_turns: 1,
            result: "done",
            stop_reason: null,
            total_cost_usd: 0,
            usage: {},
            modelUsage: {},
            permission_denials: [],
            uuid: "uuid-full-access",
            session_id: "claude-session-full-access"
          } as unknown as SDKMessage
        ])(params);
      }
    );

    await runtime.streamChatMessage(
      {
        source: "claude",
        sessionKey: "",
        message: "Hello",
        attachments: [],
        modelId: "inherit",
        permissionMode: "full_access",
        idempotencyKey: "chat-claude-full-access"
      },
      () => undefined
    );

    expect(options).toMatchObject({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true
    });
  });

  it("streams Claude Code official partial messages and runtime progress events", async () => {
    const workspace = createWorkspace();
    let options: Parameters<ClaudeQueryFn>[0]["options"];
    const runtime = new ClaudeAgentSdkRuntime(
      new AgentSdkTaskRegistry(2),
      { defaultTimeoutMs: 60_000, workspaceRoot: workspace },
      (params) => {
        options = params.options;
        return fakeClaudeQuery([
          {
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
            parent_tool_use_id: null,
            uuid: "partial-1",
            session_id: "claude-session-chat"
          } as unknown as SDKMessage,
          {
            type: "tool_progress",
            tool_use_id: "tool-1",
            tool_name: "Read",
            parent_tool_use_id: null,
            elapsed_time_seconds: 2,
            uuid: "tool-progress-1",
            session_id: "claude-session-chat"
          } as unknown as SDKMessage,
          {
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
            parent_tool_use_id: null,
            uuid: "partial-2",
            session_id: "claude-session-chat"
          } as unknown as SDKMessage,
          {
            type: "result",
            subtype: "success",
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            num_turns: 1,
            result: "Hello",
            stop_reason: null,
            total_cost_usd: 0,
            usage: {},
            modelUsage: {},
            permission_denials: [],
            uuid: "uuid-chat",
            session_id: "claude-session-chat"
          } as unknown as SDKMessage
        ])(params);
      }
    );
    const events: unknown[] = [];

    await runtime.streamChatMessage(
      {
        source: "claude",
        sessionKey: "",
        message: "Hello",
        attachments: [],
        modelId: "inherit",
        thinking: "medium",
        idempotencyKey: "chat-claude-events"
      },
      (event) => events.push(event)
    );

    expect(options).toMatchObject({
      includePartialMessages: true,
      includeHookEvents: true
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "started", source: "claude", status: "running" }),
      { type: "delta", text: "Hel" },
      expect.objectContaining({
        type: "runtime_state",
        source: "claude",
        phase: "tool",
        label: "Read"
      }),
      { type: "delta", text: "lo" },
      expect.objectContaining({
        type: "done",
        source: "claude",
        status: "succeeded",
        output: "Hello"
      })
    ]);
  });

  it("maps Claude Code chat thinking controls to native SDK options", async () => {
    const workspace = createWorkspace();
    const capturedOptions: Array<Parameters<ClaudeQueryFn>[0]["options"]> = [];
    const runtime = new ClaudeAgentSdkRuntime(
      new AgentSdkTaskRegistry(2),
      { defaultTimeoutMs: 60_000, workspaceRoot: workspace },
      (params) => {
        capturedOptions.push(params.options);
        return fakeClaudeQuery([
          {
            type: "result",
            subtype: "success",
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            num_turns: 1,
            result: "ok",
            stop_reason: null,
            total_cost_usd: 0,
            usage: {},
            modelUsage: {},
            permission_denials: [],
            uuid: "uuid-chat",
            session_id: "claude-session-chat"
          } as unknown as SDKMessage
        ])(params);
      }
    );

    await runtime.streamChatMessage(
      {
        source: "claude",
        sessionKey: "",
        message: "Adaptive",
        attachments: [],
        modelId: "inherit",
        thinking: "adaptive",
        idempotencyKey: "chat-adaptive"
      },
      () => undefined
    );
    await runtime.streamChatMessage(
      {
        source: "claude",
        sessionKey: "",
        message: "Off",
        attachments: [],
        modelId: "inherit",
        thinking: "off",
        idempotencyKey: "chat-off"
      },
      () => undefined
    );
    await runtime.streamChatMessage(
      {
        source: "claude",
        sessionKey: "",
        message: "Minimal",
        attachments: [],
        modelId: "inherit",
        thinking: "minimal",
        idempotencyKey: "chat-minimal"
      },
      () => undefined
    );

    expect(capturedOptions[0]).toMatchObject({ thinking: { type: "adaptive" } });
    expect(capturedOptions[0]?.effort).toBeUndefined();
    expect(capturedOptions[1]).toMatchObject({ thinking: { type: "disabled" } });
    expect(capturedOptions[1]?.effort).toBeUndefined();
    expect(capturedOptions[2]?.thinking).toBeUndefined();
    expect(capturedOptions[2]?.effort).toBe("low");
  });

  it("rejects Codex output that does not match outputSchema", async () => {
    const workspace = createWorkspace({ git: true });
    const runtime = new CodexAgentSdkRuntime(
      new AgentSdkTaskRegistry(2),
      { defaultTimeoutMs: 60_000, workspaceRoot: workspace },
      () => fakeCodexClient({
        threadId: "codex-thread-2",
        finalResponse: "{\"ok\":\"no\"}",
        usage: null
      })
    );

    const started = await runtime.startTask(
      createStartInput({
        source: "codex",
        workingDirectory: workspace,
        outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }
      })
    );
    const result = await runtime.waitForTask({
      nodeRunId: "node-run-1",
      taskId: started.taskId,
      runId: started.runId,
      sessionKey: started.sessionKey,
      source: "codex"
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("invalid_output");
  });

  it("streams Google CLI chat through Gemini headless mode and resumes native sessions", async () => {
    const workspace = createWorkspace();
    const calls: CliCommandInput[] = [];
    const runtime = new CliAgentSdkRuntime(
      new AgentSdkTaskRegistry(2),
      { defaultTimeoutMs: 60_000, workspaceRoot: workspace },
      "google",
      fakeCliRunner(calls, { stdout: "hello from gemini" })
    );
    const events: unknown[] = [];

    await runtime.streamChatMessage(
      {
        source: "google",
        sessionKey: "gemini-session-existing",
        message: "Hello",
        attachments: [],
        modelId: "gemini-2.5-pro",
        permissionMode: "full_access",
        idempotencyKey: "chat-google-1"
      },
      (event) => events.push(event)
    );

    expect(calls[0]).toMatchObject({
      command: "gemini",
      cwd: workspace
    });
    expect(calls[0]?.args).toEqual([
      "--resume",
      "gemini-session-existing",
      "--model",
      "gemini-2.5-pro",
      "--approval-mode",
      "yolo",
      "--prompt",
      "Hello"
    ]);
    expect(events).toEqual([
      expect.objectContaining({ type: "started", source: "google", status: "running" }),
      { type: "delta", text: "hello from gemini" },
      expect.objectContaining({
        type: "done",
        source: "google",
        status: "succeeded",
        sessionKey: "gemini-session-existing",
        output: "hello from gemini"
      })
    ]);
  });

  it("does not invent resumable native session ids for CLI chat output without a session id", async () => {
    const workspace = createWorkspace();
    const calls: CliCommandInput[] = [];
    const runtime = new CliAgentSdkRuntime(
      new AgentSdkTaskRegistry(2),
      { defaultTimeoutMs: 60_000, workspaceRoot: workspace },
      "google",
      fakeCliRunner(calls, { stdout: "hello without native session" })
    );
    const events: unknown[] = [];

    await runtime.streamChatMessage(
      {
        source: "google",
        sessionKey: "",
        message: "Hello",
        attachments: [],
        modelId: "gemini-2.5-pro",
        permissionMode: "safe",
        idempotencyKey: "chat-google-new"
      },
      (event) => events.push(event)
    );

    expect(calls[0]?.args).not.toContain("--resume");
    expect(events).toEqual([
      expect.objectContaining({ type: "started", source: "google", status: "running", sessionKey: "" }),
      { type: "delta", text: "hello without native session" },
      expect.objectContaining({
        type: "done",
        source: "google",
        status: "succeeded",
        sessionKey: "",
        output: "hello without native session"
      })
    ]);
  });

  it("streams Cursor chat from stream-json output and carries native session ids", async () => {
    const workspace = createWorkspace();
    const calls: CliCommandInput[] = [];
    const runtime = new CliAgentSdkRuntime(
      new AgentSdkTaskRegistry(2),
      { defaultTimeoutMs: 60_000, workspaceRoot: workspace },
      "cursor",
      fakeCliRunner(calls, {
        stdout: [
          JSON.stringify({ type: "system", subtype: "init", session_id: "cursor-session-existing", model: "gpt-5" }),
          JSON.stringify({
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: "Hel" }] },
            session_id: "cursor-session-existing"
          }),
          JSON.stringify({
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: "lo" }] },
            session_id: "cursor-session-existing"
          }),
          JSON.stringify({ type: "result", subtype: "success", result: "Hello", session_id: "cursor-session-existing" })
        ].join("\n")
      })
    );
    const events: unknown[] = [];

    await runtime.streamChatMessage(
      {
        source: "cursor",
        sessionKey: "cursor-session-existing",
        message: "Hello",
        attachments: [],
        modelId: "gpt-5",
        permissionMode: "full_access",
        idempotencyKey: "chat-cursor-1"
      },
      (event) => events.push(event)
    );

    expect(calls[0]).toMatchObject({
      command: "cursor-agent",
      cwd: workspace
    });
    expect(calls[0]?.args).toEqual([
      "--print",
      "--output-format",
      "stream-json",
      "--model",
      "gpt-5",
      "--resume",
      "cursor-session-existing",
      "--force",
      "Hello"
    ]);
    expect(events).toEqual([
      expect.objectContaining({ type: "started", source: "cursor", status: "running" }),
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
      expect.objectContaining({
        type: "done",
        source: "cursor",
        status: "succeeded",
        sessionKey: "cursor-session-existing",
        output: "Hello"
      })
    ]);
  });

  it("runs OpenCode tasks through the native CLI with workspace and model flags", async () => {
    const workspace = createWorkspace();
    const calls: CliCommandInput[] = [];
    const runtime = new CliAgentSdkRuntime(
      new AgentSdkTaskRegistry(2),
      { defaultTimeoutMs: 60_000, workspaceRoot: workspace },
      "opencode",
      fakeCliRunner(calls, { stdout: "{\"ok\":true}\n" })
    );

    const started = await runtime.startTask(
      createStartInput({
        source: "opencode",
        workingDirectory: workspace,
        modelId: "anthropic/claude-sonnet-4",
        outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }
      })
    );
    const result = await runtime.waitForTask({
      nodeRunId: "node-run-1",
      taskId: started.taskId,
      runId: started.runId,
      sessionKey: started.sessionKey,
      source: "opencode"
    });

    expect(calls[0]).toMatchObject({
      command: "opencode",
      cwd: workspace
    });
    expect(calls[0]?.args.slice(0, 6)).toEqual([
      "run",
      "--dir",
      workspace,
      "--model",
      "anthropic/claude-sonnet-4",
      "--title"
    ]);
    expect(calls[0]?.args.at(-1)).toContain("You are executing one Hiveward blueprint node.");
    expect(result.status).toBe("succeeded");
    expect(result.source).toBe("opencode");
    expect(result.output).toBe("{\"ok\":true}");
  });

  it("streams Hermes chat through single query mode and resumes native sessions", async () => {
    const workspace = createWorkspace();
    const calls: CliCommandInput[] = [];
    const runtime = new CliAgentSdkRuntime(
      new AgentSdkTaskRegistry(2),
      { defaultTimeoutMs: 60_000, workspaceRoot: workspace },
      "hermes",
      fakeCliRunner(calls, { stdout: "hello from hermes" })
    );
    const events: unknown[] = [];

    await runtime.streamChatMessage(
      {
        source: "hermes",
        sessionKey: "hermes-session-existing",
        message: "Hello",
        attachments: [],
        modelId: "hermes-env-default",
        permissionMode: "full_access",
        idempotencyKey: "chat-hermes-1",
        skillIds: ["hiveward-leader"]
      },
      (event) => events.push(event)
    );

    expect(calls[0]).toMatchObject({
      command: "hermes",
      cwd: workspace
    });
    expect(calls[0]?.args).toEqual([
      "--resume",
      "hermes-session-existing",
      "chat",
      "--model",
      "hermes-env-default",
      "--yolo",
      "-s",
      "hiveward-leader",
      "-q",
      "Hello"
    ]);
    expect(events).toEqual([
      expect.objectContaining({ type: "started", source: "hermes", status: "running" }),
      { type: "delta", text: "hello from hermes" },
      expect.objectContaining({
        type: "done",
        source: "hermes",
        status: "succeeded",
        sessionKey: "hermes-session-existing",
        output: "hello from hermes"
      })
    ]);
  });

  it("resolves stable Hermes profile ids to aliases inside the runtime layer", async () => {
    const workspace = createWorkspace();
    const calls: CliCommandInput[] = [];
    const runtime = new CliAgentSdkRuntime(
      new AgentSdkTaskRegistry(2),
      { defaultTimeoutMs: 60_000, workspaceRoot: workspace },
      "hermes",
      async (input) => {
        calls.push(input);
        if (input.command === "hermes" && input.args.join(" ") === "profile list") {
          return {
            stdout: [
              " Profile          Model                        Gateway      Alias        Distribution",
              " architect       hermes-profile-model-test     stopped      hermes-architect   -"
            ].join("\n"),
            stderr: "",
            exitCode: 0
          };
        }
        input.onStdout?.("{\"ok\":true}\n");
        return { stdout: "{\"ok\":true}\n", stderr: "", exitCode: 0 };
      }
    );

    const started = await runtime.startTask(
      createStartInput({
        source: "hermes",
        workingDirectory: workspace,
        modelId: "inherit",
        profileId: "architect",
        permissionProfile: "workspace_write",
        skillIds: ["hiveward-leader"],
        outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }
      })
    );
    const result = await runtime.waitForTask({
      nodeRunId: "node-run-1",
      taskId: started.taskId,
      runId: started.runId,
      sessionKey: started.sessionKey,
      source: "hermes"
    });

    expect(calls[0]).toMatchObject({
      command: "hermes",
      args: ["profile", "list"],
      cwd: workspace
    });
    expect(calls[1]).toMatchObject({
      command: "hermes-architect",
      cwd: workspace
    });
    expect(calls[1]?.args.slice(0, 4)).toEqual(["chat", "--yolo", "-s", "hiveward-leader"]);
    expect(calls[1]?.args.at(-2)).toBe("-q");
    expect(calls[1]?.args.at(-1)).toContain("You are executing one Hiveward blueprint node.");
    expect(result.status).toBe("succeeded");
    expect(result.source).toBe("hermes");
    expect(result.output).toBe("{\"ok\":true}");
  });

  it("does not infer Hermes profile aliases from local wrapper commands", async () => {
    const workspace = createWorkspace();
    const binDir = path.join(workspace, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, "hermes-architect"), "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(path.join(binDir, "hermes-architect"), 0o755);
    const calls: CliCommandInput[] = [];
    const runtime = new CliAgentSdkRuntime(
      new AgentSdkTaskRegistry(2),
      { defaultTimeoutMs: 60_000, workspaceRoot: workspace },
      "hermes",
      async (input) => {
        calls.push(input);
        if (input.command === "hermes" && input.args.join(" ") === "profile list") {
          return {
            stdout: [
              " Profile          Model                        Gateway      Alias        Distribution",
              " architect       hermes-profile-model-test     stopped      -              -"
            ].join("\n"),
            stderr: "",
            exitCode: 0
          };
        }
        input.onStdout?.("{\"ok\":true}\n");
        return { stdout: "{\"ok\":true}\n", stderr: "", exitCode: 0 };
      },
      { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` }
    );

    const started = await runtime.startTask(
      createStartInput({
        source: "hermes",
        workingDirectory: workspace,
        modelId: "inherit",
        profileId: "architect",
        permissionProfile: "workspace_write",
        outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }
      })
    );
    const result = await runtime.waitForTask({
      nodeRunId: "node-run-1",
      taskId: started.taskId,
      runId: started.runId,
      sessionKey: started.sessionKey,
      source: "hermes"
    });

    expect(calls).toHaveLength(1);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("does not have an executable alias");
  });

  it("does not accept Hermes aliases as platform profile ids", async () => {
    const workspace = createWorkspace();
    const calls: CliCommandInput[] = [];
    const runtime = new CliAgentSdkRuntime(
      new AgentSdkTaskRegistry(2),
      { defaultTimeoutMs: 60_000, workspaceRoot: workspace },
      "hermes",
      async (input) => {
        calls.push(input);
        if (input.command === "hermes" && input.args.join(" ") === "profile list") {
          return {
            stdout: [
              " Profile          Model                        Gateway      Alias        Distribution",
              " architect       hermes-profile-model-test     stopped      hermes-architect   -"
            ].join("\n"),
            stderr: "",
            exitCode: 0
          };
        }
        input.onStdout?.("{\"ok\":true}\n");
        return { stdout: "{\"ok\":true}\n", stderr: "", exitCode: 0 };
      }
    );

    const started = await runtime.startTask(
      createStartInput({
        source: "hermes",
        workingDirectory: workspace,
        modelId: "inherit",
        profileId: "hermes-architect",
        permissionProfile: "workspace_write",
        outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }
      })
    );
    const result = await runtime.waitForTask({
      nodeRunId: "node-run-1",
      taskId: started.taskId,
      runId: started.runId,
      sessionKey: started.sessionKey,
      source: "hermes"
    });

    expect(calls).toHaveLength(1);
    expect(result.status).toBe("failed");
    expect(result.error).toContain('Hermes profile "hermes-architect" was not found');
  });
});

function createStartInput(
  overrides: Partial<Parameters<ClaudeAgentSdkRuntime["startTask"]>[0]> = {}
): Parameters<ClaudeAgentSdkRuntime["startTask"]>[0] {
  return {
    blueprintRunId: "blueprint-run-1",
    nodeRunId: "node-run-1",
    source: "claude",
    agentName: "agent",
    prompt: "Return a result.",
    modelId: "test-model",
    permissionProfile: "read_only",
    workingDirectory: createWorkspace(),
    timeoutMs: 60_000,
    input: { upstream: [] },
    tools: [],
    ...overrides
  };
}

function createWorkspace(options: { git?: boolean } = {}): string {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "hiveward-sdk-"));
  if (options.git) {
    mkdirSync(path.join(workspace, ".git"));
  }
  return workspace;
}

function fakeClaudeQuery(messages: SDKMessage[]): ClaudeQueryFn {
  return () => (async function* () {
    for (const message of messages) {
      yield message;
    }
  })() as unknown as Query;
}

function fakeCodexClient({
  threadId,
  finalResponse,
  usage,
  onStartThread,
  onRun,
  onRunStreamed,
  streamEvents
}: {
  threadId: string;
  finalResponse: string;
  usage: Usage | null;
  onStartThread?: (options?: ThreadOptions) => void;
  onRun?: (prompt: string, options?: TurnOptions) => void;
  onRunStreamed?: (prompt: string, options?: TurnOptions) => void;
  streamEvents?: ThreadEvent[];
}): CodexClientLike {
  const thread: CodexThreadLike = {
    id: threadId,
    async run(prompt: string, options?: TurnOptions) {
      onRun?.(prompt, options);
      return {
        finalResponse,
        usage
      };
    },
    async runStreamed(prompt: string, options?: TurnOptions) {
      onRunStreamed?.(prompt, options);
      return {
        events: (async function* () {
          for (const event of streamEvents ?? []) {
            yield event;
          }
        })()
      };
    }
  };

  return {
    startThread(options?: ThreadOptions) {
      onStartThread?.(options);
      return thread;
    },
    resumeThread(_id: string, options?: ThreadOptions) {
      onStartThread?.(options);
      return thread;
    }
  };
}

function fakeCliRunner(
  calls: CliCommandInput[],
  result: { stdout: string; stderr?: string; exitCode?: number }
): RunCliCommand {
  return async (input) => {
    calls.push(input);
    input.onStdout?.(result.stdout);
    return {
      stdout: result.stdout,
      stderr: result.stderr ?? "",
      exitCode: result.exitCode ?? 0
    };
  };
}
