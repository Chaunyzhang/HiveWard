import { describe, expect, it } from "vitest";
import type { ChatStreamEvent } from "@hiveward/shared";
import { GatewayOpenClawAdapter, formatAgentMessage, readAgentTranscriptMessages } from "./gateway-adapter";

describe("gateway adapter transcript extraction", () => {
  it("updates native session titles through the official sessions.patch label field", async () => {
    const adapter = new GatewayOpenClawAdapter({
      url: "ws://127.0.0.1:1",
      origin: "http://127.0.0.1:1",
      locale: "zh-CN",
      requestTimeoutMs: 1,
      agentStartTimeoutMs: 1
    });
    const requests: Array<{ method: string; params?: unknown }> = [];
    const fakeSession = {
      request: async (method: string, params?: unknown) => {
        requests.push({ method, params });
        return {
          entry: {
            key: "agent:main:main",
            label: "Renamed chat"
          }
        };
      }
    };
    (adapter as unknown as {
      withSession: <T>(operation: (session: typeof fakeSession) => Promise<T>) => Promise<T>;
    }).withSession = (operation) => operation(fakeSession);

    const result = await adapter.updateChatSessionTitle({
      sessionKey: "agent:main:main",
      title: " Renamed chat "
    });

    expect(requests).toEqual([
      {
        method: "sessions.patch",
        params: {
          key: "agent:main:main",
          label: "Renamed chat"
        }
      }
    ]);
    expect(result).toEqual({
      sessionKey: "agent:main:main",
      title: "Renamed chat"
    });
  });

  it("keeps chat streams open for the accepted Gateway run id", async () => {
    const adapter = new GatewayOpenClawAdapter({
      url: "ws://127.0.0.1:1",
      origin: "http://127.0.0.1:1",
      locale: "zh-CN",
      requestTimeoutMs: 1,
      agentStartTimeoutMs: 50
    });
    let chatHandler: ((payload: unknown) => void) | undefined;
    const fakeSession = {
      request: async (method: string) => {
        if (method === "sessions.patch") return {};
        if (method === "chat.send") {
          setTimeout(() => {
            chatHandler?.({
              runId: "gateway-run-accepted",
              sessionKey: "agent:main:main",
              state: "final",
              message: { content: "final blueprint proposal" }
            });
          }, 0);
          return {
            runId: "gateway-run-accepted",
            status: "accepted"
          };
        }
        throw new Error(`Unexpected method ${method}.`);
      },
      onEvent: (eventName: string, handler: (payload: unknown) => void) => {
        expect(eventName).toBe("chat");
        chatHandler = handler;
        return () => {
          chatHandler = undefined;
        };
      }
    };
    (adapter as unknown as { getSession: () => Promise<typeof fakeSession> }).getSession = async () => fakeSession;
    const events: ChatStreamEvent[] = [];

    await adapter.streamChatMessage(
      {
        sessionKey: "agent:main:main",
        message: "Generate a blueprint proposal.",
        attachments: [],
        idempotencyKey: "local-request-id",
        timeoutMs: 100
      },
      (event) => events.push(event)
    );

    expect(events.find((event) => event.type === "started")).toMatchObject({
      type: "started",
      runId: "gateway-run-accepted"
    });
    expect(events.find((event) => event.type === "done")).toMatchObject({
      type: "done",
      runId: "gateway-run-accepted",
      output: "final blueprint proposal"
    });
  });

  it("shows only the user's original message when reading Hiveward chat history", async () => {
    const adapter = new GatewayOpenClawAdapter({
      url: "ws://127.0.0.1:1",
      origin: "http://127.0.0.1:1",
      locale: "zh-CN",
      requestTimeoutMs: 1,
      agentStartTimeoutMs: 1
    });
    const fakeSession = {
      request: async () => ({
        messages: [
          {
            id: "message-1",
            role: "user",
            content: [
              "Hiveward role scope:",
              "- mode: CEO (company command role)",
              "",
              "Hiveward inbox submit protocol:",
              "- Chat has no implicit side effects.",
              "",
              "User message:",
              "再创建一个x的热点收集，生成html的蓝图"
            ].join("\n")
          }
        ]
      })
    };
    (adapter as unknown as {
      withSession: <T>(operation: (session: typeof fakeSession) => Promise<T>) => Promise<T>;
    }).withSession = (operation) => operation(fakeSession);

    await expect(adapter.getSessionMessages("agent:main:main")).resolves.toEqual([
      {
        id: "message-1",
        role: "user",
        content: "再创建一个x的热点收集，生成html的蓝图",
        createdAt: expect.any(String)
      }
    ]);
  });

  it("hides the current HiveWard appointment prompt when reading chat history", async () => {
    const adapter = new GatewayOpenClawAdapter({
      url: "ws://127.0.0.1:1",
      origin: "http://127.0.0.1:1",
      locale: "zh-CN",
      requestTimeoutMs: 1,
      agentStartTimeoutMs: 1
    });
    const fakeSession = {
      request: async () => ({
        messages: [
          {
            id: "message-1",
            role: "user",
            content: [
              "HiveWard appointment:",
              "You are the external harness agent powering the HiveWard role seat \"CEO\".",
              "",
              "Installed external skill:",
              "- name: hiveward-ceo",
              "",
              "User message:",
              "你好你是谁"
            ].join("\n")
          }
        ]
      })
    };
    (adapter as unknown as {
      withSession: <T>(operation: (session: typeof fakeSession) => Promise<T>) => Promise<T>;
    }).withSession = (operation) => operation(fakeSession);

    await expect(adapter.getSessionMessages("agent:main:main")).resolves.toEqual([
      {
        id: "message-1",
        role: "user",
        content: "你好你是谁",
        createdAt: expect.any(String)
      }
    ]);
  });

  it("returns the final visible assistant output instead of an intermediate message", () => {
    const result = readAgentTranscriptMessages([
      { role: "user", content: "Hiveward node run: node-run-1\nDo the work." },
      { role: "assistant", content: "I will check the source material first." },
      { role: "tool", content: [{ type: "tool_result", content: [{ type: "text", text: "{\"raw\":true}" }] }] },
      { role: "assistant", content: "# Final brief\n\nUse this complete result downstream." }
    ], "node-run-1");

    expect(result?.output).toBe("# Final brief\n\nUse this complete result downstream.");
  });

  it("does not use tool output when the assistant has no final text", () => {
    const result = readAgentTranscriptMessages([
      { role: "user", content: "Hiveward node run: node-run-2\nResearch this." },
      { role: "assistant", content: "I will search first." },
      { role: "tool", content: [{ type: "tool_result", content: [{ type: "text", text: "{\"headline\":\"first\"}" }] }] },
      { role: "tool", result: { file: "D:/HiveWard/tmp/page.html", kind: "html" } },
      { role: "assistant", content: "completed" }
    ], "node-run-2");

    expect(result?.output).toBeUndefined();
  });

  it("does not invent a status summary when no visible output exists", () => {
    const result = readAgentTranscriptMessages([
      { role: "user", content: "Hiveward node run: node-run-3\nRun." },
      { role: "assistant", content: "completed" }
    ], "node-run-3");

    expect(result?.output).toBeUndefined();
  });

  it("keeps the assistant output when a later compaction message follows it", () => {
    const result = readAgentTranscriptMessages([
      { role: "user", content: "Hiveward node run: node-run-4\nBuild the page." },
      { role: "assistant", content: "Final page written to workspace." },
      { role: "system", content: "Compaction" }
    ], "node-run-4");

    expect(result?.output).toBe("Final page written to workspace.");
  });

  it("does not treat an unrelated terminal session as the current node output", () => {
    const result = readAgentTranscriptMessages([
      { role: "user", content: "Hiveward node run: node-run-previous\nBuild the page." },
      { role: "assistant", content: "Previous node result." },
      { role: "system", content: "Compaction" }
    ], "node-run-current");

    expect(result).toBeUndefined();
  });

  it("formats upstream output as readable handoff text for the next agent", () => {
    const message = formatAgentMessage({
      blueprintRunId: "run-1",
      nodeRunId: "node-run-2",
      source: "openclaw",
      agentName: "writer",
      prompt: "Write from upstream.",
      input: {
        upstream: [
          {
            nodeId: "brief",
            nodeLabel: "1. News Research",
            nodeRunId: "node-run-1",
            status: "succeeded",
            output: "# Brief\n\nFull upstream content.",
            runtimeRef: {
              source: "openclaw",
              sourceId: "task-1",
              sourceUpdatedAt: "2026-05-21T00:00:00.000Z",
              taskId: "task-1",
              runId: "run-oc-1",
              sessionKey: "agent:main:main"
            }
          }
        ]
      },
      tools: []
    });

    expect(message).toContain("上游最终输出（完整原文）");
    expect(message).toContain("### 1. 1. News Research");
    expect(message).toContain("# Brief\n\nFull upstream content.");
    expect(message).toContain("runId=run-oc-1");
    expect(message).not.toContain("\"upstream\"");
  });

  it("omits run markers and input context when no task input is provided", () => {
    const message = formatAgentMessage({
      blueprintRunId: "chat-1",
      nodeRunId: "chat-node-1",
      source: "openclaw",
      agentName: "main",
      prompt: "Current user message:\nhi",
      input: undefined,
      tools: []
    });

    expect(message).toBe("Current user message:\nhi");
    expect(message).not.toContain("Hiveward blueprint run");
    expect(message).not.toContain("Hiveward node run");
    expect(message).not.toContain("\u8f93\u5165\u4e0a\u4e0b\u6587");
    expect(message).not.toContain("\u5176\u4ed6\u4e0a\u4e0b\u6587");
  });
});
