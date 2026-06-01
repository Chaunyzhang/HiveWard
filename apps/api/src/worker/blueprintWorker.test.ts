import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeAdapter, RuntimeChatSessionResult, RuntimeChatSessionTitleResult, RuntimeChatStreamInput } from "@hiveward/adapter";
import {
  type AgentNodeConfig,
  type AgentTaskResult,
  blueprintRunArchiveSchema,
  createActiveManagerNewsHtmlChaosBlueprint,
  createActiveManagerRemotionVideoChaosBlueprint,
  createManagerDrivenHtmlBlueprint,
  createRealThreeAgentBlueprint,
  type SendChannelInput,
  type SendChannelResult,
  type StartAgentTaskInput,
  type StartedAgentTaskResult,
  type WaitForAgentTaskInput,
  type BlueprintDefinition,
  type BlueprintEdge,
  type BlueprintNode,
  type BlueprintNodeRun,
  type BlueprintRunStatus,
  type ChatStreamEvent
} from "@hiveward/shared";
import { FileHivewardStore } from "../store/fileHivewardStore";
import type { HivewardStore } from "../store/hivewardStore";
import { SqliteHivewardStore } from "../store/sqlite/sqliteHivewardStore";
import { ApprovalService } from "../services/lifecycleApprovalService";
import { BlueprintWorker } from "./blueprintWorker";

class ScriptedAdapter implements RuntimeAdapter {
  readonly calls: StartAgentTaskInput[] = [];
  readonly chatCalls: RuntimeChatStreamInput[] = [];
  readonly chatSessionInputs: unknown[] = [];
  readonly waitCalls: WaitForAgentTaskInput[] = [];
  readonly sendCalls: SendChannelInput[] = [];

  constructor(
    private readonly startResults: StartedAgentTaskResult[],
    private readonly completionResults: Array<AgentTaskResult | Error | Promise<AgentTaskResult>>
  ) {}

  async listModels() {
    return [];
  }

  async listAgents() {
    return [];
  }

  async listTools() {
    return [];
  }

  async listChannels() {
    return [];
  }

  async listSessions() {
    return [];
  }

  async listTasks() {
    return [];
  }

  async getRuntimeOverview() {
    return {
      sessions: [],
      tasks: []
    };
  }

  async getSessionMessages() {
    return [];
  }

  async createChatSession(input: unknown): Promise<RuntimeChatSessionResult> {
    this.chatSessionInputs.push(input);
    return {
      sessionKey: `test-chat-session-${this.chatSessionInputs.length}`
    };
  }

  async updateChatSessionTitle(): Promise<RuntimeChatSessionTitleResult> {
    throw new Error("Chat session title updates are not used by blueprint worker tests.");
  }

  async streamChatMessage(input: RuntimeChatStreamInput, onEvent: (event: ChatStreamEvent) => void): Promise<void> {
    this.chatCalls.push(input);
    const now = new Date().toISOString();
    const result = await this.nextCompletionResult(input.idempotencyKey);
    const output = typeof result.output === "string" ? result.output : result.output === undefined ? undefined : JSON.stringify(result.output, null, 2);
    const sessionKey = result.sessionKey || input.sessionKey || `${input.source ?? "openclaw"}-chat-session-${this.chatCalls.length}`;
    onEvent({
      type: "started",
      taskId: result.taskId,
      runId: result.runId,
      sessionKey,
      source: result.source,
      status: "running",
      updatedAt: now
    });
    if (output) onEvent({ type: "delta", text: output });
    onEvent({
      type: "done",
      taskId: result.taskId,
      runId: result.runId,
      sessionKey,
      source: result.source,
      status: result.status,
      output,
      error: result.error,
      usage: result.usage,
      updatedAt: result.updatedAt
    });
  }

  async streamAgentTask(input: StartAgentTaskInput, onEvent: (event: ChatStreamEvent) => void): Promise<AgentTaskResult> {
    const started = await this.startAgentTask(input);
    onEvent({ ...started, type: "started" });
    const result = await this.waitForAgentTask({
      nodeRunId: input.nodeRunId,
      taskId: started.taskId,
      runId: started.runId,
      sessionKey: started.sessionKey,
      source: started.source,
      agentId: input.agentId,
      modelId: input.modelId
    });
    const output = typeof result.output === "string" ? result.output : result.output === undefined ? undefined : JSON.stringify(result.output, null, 2);
    if (output) onEvent({ type: "delta", text: output });
    onEvent(toTestDoneEvent(result, output));
    return result;
  }

  async startAgentTask(input: StartAgentTaskInput): Promise<StartedAgentTaskResult> {
    this.calls.push(input);
    const result = this.startResults.shift();
    if (!result) {
      throw new Error("No scripted agent start result available.");
    }
    return result;
  }

  async waitForAgentTask(input: WaitForAgentTaskInput): Promise<AgentTaskResult> {
    this.waitCalls.push(input);
    return this.nextCompletionResult(input.taskId);
  }

  private async nextCompletionResult(taskId: string): Promise<AgentTaskResult> {
    const matchingIndex = this.completionResults.findIndex((candidate) =>
      !(candidate instanceof Error) &&
      !(candidate instanceof Promise) &&
      candidate.taskId === taskId
    );
    const result = matchingIndex >= 0
      ? this.completionResults.splice(matchingIndex, 1)[0]
      : this.completionResults.shift();
    if (!result) {
      throw new Error("No scripted agent completion result available.");
    }
    if (result instanceof Promise) {
      return result;
    }
    if (result instanceof Error) {
      throw result;
    }
    return result;
  }

  async sendChannelMessage(input: SendChannelInput): Promise<SendChannelResult> {
    this.sendCalls.push(input);
    return {
      deliveryId: "delivery-1",
      status: "sent",
      updatedAt: new Date().toISOString()
    };
  }
}

class BlockingAdapter implements RuntimeAdapter {
  readonly calls: StartAgentTaskInput[] = [];
  readonly waitCalls: WaitForAgentTaskInput[] = [];
  private resolveCompletion?: (result: AgentTaskResult) => void;
  private readonly completion: Promise<AgentTaskResult>;

  constructor(private readonly startedResult: StartedAgentTaskResult) {
    this.completion = new Promise((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  async listModels() {
    return [];
  }

  async listAgents() {
    return [];
  }

  async listTools() {
    return [];
  }

  async listChannels() {
    return [];
  }

  async listSessions() {
    return [];
  }

  async listTasks() {
    return [];
  }

  async getRuntimeOverview() {
    return {
      sessions: [],
      tasks: []
    };
  }

  async getSessionMessages() {
    return [];
  }

  async createChatSession(): Promise<RuntimeChatSessionResult> {
    throw new Error("Chat session creation is not used by blueprint worker tests.");
  }

  async updateChatSessionTitle(): Promise<RuntimeChatSessionTitleResult> {
    throw new Error("Chat session title updates are not used by blueprint worker tests.");
  }

  async streamChatMessage(): Promise<void> {
    throw new Error("Chat stream is not used by blueprint worker tests.");
  }

  async streamAgentTask(input: StartAgentTaskInput, onEvent: (event: ChatStreamEvent) => void): Promise<AgentTaskResult> {
    const started = await this.startAgentTask(input);
    onEvent({ ...started, type: "started" });
    const result = await this.waitForAgentTask({
      nodeRunId: input.nodeRunId,
      taskId: started.taskId,
      runId: started.runId,
      sessionKey: started.sessionKey,
      source: started.source,
      agentId: input.agentId,
      modelId: input.modelId
    });
    const output = typeof result.output === "string" ? result.output : result.output === undefined ? undefined : JSON.stringify(result.output, null, 2);
    if (output) onEvent({ type: "delta", text: output });
    onEvent(toTestDoneEvent(result, output));
    return result;
  }

  async startAgentTask(input: StartAgentTaskInput): Promise<StartedAgentTaskResult> {
    this.calls.push(input);
    return this.startedResult;
  }

  async waitForAgentTask(input: WaitForAgentTaskInput): Promise<AgentTaskResult> {
    this.waitCalls.push(input);
    return this.completion;
  }

  async sendChannelMessage(): Promise<SendChannelResult> {
    return {
      deliveryId: "delivery-1",
      status: "sent",
      updatedAt: new Date().toISOString()
    };
  }

  complete(result: AgentTaskResult): void {
    this.resolveCompletion?.(result);
  }
}

function toTestDoneEvent(result: AgentTaskResult, output?: string): Extract<ChatStreamEvent, { type: "done" }> {
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

describe("BlueprintWorker", () => {
  it("persists a newly-created blank blueprint for the selected company", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-store-"));
    const storePath = path.join(tempDir, "hiveward-store.json");
    const store = new FileHivewardStore(storePath);
    await store.init();

    const blueprint = await store.createBlueprint({ name: "Launch review" });
    const blueprints = await store.listBlueprints();
    const index = JSON.parse(readFileSync(storePath, "utf8")) as {
      schema: string;
      blueprints?: unknown[];
      blueprintIndex?: Array<{ id: string; name: string }>;
    };
    const blueprintPath = path.join(tempDir, "blueprints", `${blueprint.id}.json`);

    expect(blueprint.id).toMatch(/^blueprint-/);
    expect(blueprint.companyId).toBe("company-hiveward-studio");
    expect(blueprint.name).toBe("Launch review");
    expect(blueprint.nodes).toEqual([]);
    expect(blueprints.some((item) => item.id === blueprint.id)).toBe(true);
    expect(existsSync(blueprintPath)).toBe(true);
    expect(index.schema).toBe("hiveward.store-index/v1");
    expect(index.blueprints).toBeUndefined();
    expect(index.blueprintIndex?.some((item) => item.id === blueprint.id && item.name === "Launch review")).toBe(true);

    const saved = await store.saveBlueprint({ ...blueprint, name: "Launch review v2" });
    const savedIndex = JSON.parse(readFileSync(storePath, "utf8")) as {
      blueprintIndex?: Array<{ id: string; name: string; version: number }>;
    };
    const savedBlueprint = JSON.parse(readFileSync(blueprintPath, "utf8")) as { name: string; version: number };
    expect(saved.name).toBe("Launch review v2");
    expect(savedBlueprint).toMatchObject({ name: "Launch review v2", version: 2 });
    expect(savedIndex.blueprintIndex?.find((item) => item.id === blueprint.id)).toMatchObject({
      name: "Launch review v2",
      version: 2
    });
  });

  it("marks the run failed and stops downstream execution when an agent result fails", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const storePath = path.join(tempDir, "hiveward-store.json");
    const store = new FileHivewardStore(storePath);
    await store.init();

    const blueprint = createRealThreeAgentBlueprint(new Date().toISOString(), "company-hiveward-studio");
    const worker = new BlueprintWorker(
      store,
      new ScriptedAdapter([
        createStartedAgentTask("task-1"),
        createStartedAgentTask("task-2")
      ], [
        createCompletedAgentTask("task-1", "succeeded", "brief ok"),
        createCompletedAgentTask("task-2", "failed", undefined, "output new_sensitive (1027)")
      ])
    );

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);

    expect(run.status).toBe("running");
    expect(view?.run.status).toBe("failed");
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "brief")?.status).toBe("succeeded");
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "brief")?.input).toMatchObject({
      upstream: [],
      agentWorkspace: expect.objectContaining({
        path: expect.stringContaining(path.join("blueprint-workspaces", blueprint.id, "agents"))
      })
    });
    const failedPlanRun = view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "plan");
    expect(failedPlanRun?.status).toBe("failed");
    expect(failedPlanRun?.input).toMatchObject({
      upstream: [expect.objectContaining({ nodeId: "brief", nodeLabel: "1. Brief", status: "succeeded", humanReportMd: "brief ok" })]
    });
    expect((failedPlanRun?.input as { upstream?: Array<Record<string, unknown>> } | undefined)?.upstream?.[0]).not.toHaveProperty("output");
    expect((failedPlanRun?.input as { upstream?: Array<{ nodeRunId?: string; runtimeRef?: { runId?: string } }> } | undefined)?.upstream?.[0])
      .toMatchObject({
        nodeRunId: expect.any(String),
        runtimeRef: expect.objectContaining({ runId: "task-1-run" })
      });
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "verify")?.status).toBe("skipped");
    expect(view?.events.some((event) => event.type === "blueprint.run.failed")).toBe(true);

    const archive = JSON.parse(readFileSync(path.join(tempDir, "runs", `${run.id}.json`), "utf8")) as {
      schema: string;
      run: { id: string; status: string };
      blueprintSnapshot: { id: string };
      nodeRuns: unknown[];
      events: unknown[];
    };
    const index = JSON.parse(readFileSync(storePath, "utf8")) as {
      nodeRuns?: unknown[];
      events?: unknown[];
      runIndex?: Array<{ id: string; status: string }>;
    };
    expect(archive.schema).toBe(blueprintRunArchiveSchema);
    expect(archive.run).toMatchObject({ id: run.id, status: "failed" });
    expect(archive.blueprintSnapshot.id).toBe(blueprint.id);
    expect(archive.nodeRuns.length).toBeGreaterThan(0);
    expect(archive.events.length).toBeGreaterThan(0);
    expect(index.nodeRuns).toBeUndefined();
    expect(index.events).toBeUndefined();
    expect(index.runIndex?.find((item) => item.id === run.id)?.status).toBe("failed");
  }, 20_000);

  it("writes node input and runtime ref to the run archive before the agent task finishes", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const storePath = path.join(tempDir, "hiveward-store.json");
    const store = new FileHivewardStore(storePath);
    await store.init();

    const blueprint = createBlueprint([createAgentNode("brief", "Brief")], []);
    const adapter = new BlockingAdapter(createStartedAgentTask("task-1"));
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const runningNode = await waitForNodeRun(store, run.id, "brief", (nodeRun) =>
      nodeRun.status === "running" && nodeRun.input !== undefined && nodeRun.runtimeRef?.taskId === "task-1"
    );
    const archiveWhileRunning = JSON.parse(readFileSync(path.join(tempDir, "runs", `${run.id}.json`), "utf8")) as {
      nodeRuns: Array<{ nodeId: string; status: string; input?: unknown; runtimeRef?: { taskId?: string; runId?: string } }>;
    };
    const agentWorkspace = (runningNode.input as {
      agentWorkspace?: { path?: string; artifactsPath?: string; tmpPath?: string };
    }).agentWorkspace;

    expect(runningNode.input).toMatchObject({
      upstream: [],
      agentWorkspace: {
        path: expect.stringContaining(path.join("blueprint-workspaces", blueprint.id, "agents")),
        artifactsPath: expect.stringContaining("artifacts"),
        tmpPath: expect.stringContaining("tmp")
      }
    });
    expect(existsSync(agentWorkspace?.path ?? "")).toBe(true);
    expect(existsSync(agentWorkspace?.artifactsPath ?? "")).toBe(true);
    expect(existsSync(agentWorkspace?.tmpPath ?? "")).toBe(true);
    expect(runningNode.runtimeRef).toMatchObject({ taskId: "task-1", runId: "task-1-run" });
    expect(archiveWhileRunning.nodeRuns.find((nodeRun) => nodeRun.nodeId === "brief")).toMatchObject({
      status: "running",
      input: expect.objectContaining({
        upstream: [],
        agentWorkspace: expect.objectContaining({
          path: expect.stringContaining(path.join("blueprint-workspaces", blueprint.id, "agents"))
        })
      }),
      runtimeRef: expect.objectContaining({ taskId: "task-1", runId: "task-1-run" })
    });

    adapter.complete(createCompletedAgentTask("task-1", "succeeded", "brief ok"));
    const view = await waitForRunTerminal(store, run.id);
    expect(view?.run.status).toBe("succeeded");
  }, 20_000);

  it("binds agent execution to a NodeExecutionSession and records visible transcript events", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-session-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createBlueprint([createAgentNode("brief", "Brief")], []);
    const adapter = new ScriptedAdapter([
      { ...createStartedAgentTask("task-session"), sessionKey: "native-session-1" }
    ], [
      { ...createCompletedAgentTask("task-session", "succeeded", "session ok"), sessionKey: "native-session-1" }
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);
    const nodeRun = view?.nodeRuns.find((candidate) => candidate.nodeId === "brief");
    if (!nodeRun) throw new Error("Expected brief node run.");

    const sessions = await store.listNodeExecutionSessions({ runId: run.id, nodeRunId: nodeRun.id });
    expect(sessions).toEqual([
      expect.objectContaining({
        nodeRunId: nodeRun.id,
        nodeId: "brief",
        harnessId: "openclaw",
        nativeSessionId: "native-session-1",
        policy: "refresh_per_run",
        status: "completed",
        runtimeRef: expect.objectContaining({
          taskId: "task-session",
          runId: "task-session-run",
          sessionKey: "native-session-1"
        })
      })
    ]);
    const session = sessions[0];
    if (!session) throw new Error("Expected execution session.");
    expect(view?.nodeExecutionSessions).toEqual([
      expect.objectContaining({ id: session.id, nativeSessionId: "native-session-1" })
    ]);
    const transcriptEvents = await store.listNodeSessionTranscriptEvents({ sessionId: session.id });
    expect(transcriptEvents).toHaveLength(4);
    expect(transcriptEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "runtime", kind: "runtime_started" }),
      expect.objectContaining({ role: "assistant", kind: "assistant_delta", content: "session ok" }),
      expect.objectContaining({ role: "runtime", kind: "runtime_done" }),
      expect.objectContaining({ role: "assistant", kind: "assistant_message", content: "session ok" })
    ]));
    expect(adapter.calls[0]?.nativeSessionId).toBeUndefined();
    expect(adapter.calls[0]?.executionSessionPolicy).toBe("refresh_per_run");
  }, 20_000);

  it("keeps agent output succeeded when a declared artifact path cannot be copied", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-artifact-fail-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createBlueprint([createAgentNode("builder", "Builder")], []);
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-missing-artifact")
    ], [
      createCompletedAgentTask("task-missing-artifact", "succeeded", {
        contractVersion: 2,
        humanReportMd: "## Builder report\n\nThe file path is invalid.",
        result: { attempted: true },
        artifacts: [{
          kind: "file",
          title: "Missing artifact",
          path: "definitely-missing-hiveward-artifact-file.txt"
        }]
      })
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);
    const nodeRun = view?.nodeRuns.find((candidate) => candidate.nodeId === "builder");

    expect(view?.run.status).toBe("succeeded");
    expect(nodeRun?.status).toBe("succeeded");
    expect(view?.agentHumanReports?.[0]?.bodyMd).toContain("The file path is invalid.");
    expect(view?.artifacts ?? []).toEqual([
      expect.objectContaining({
        kind: "json",
        title: "Missing artifact",
        downloadUrl: expect.stringContaining("/artifacts/")
      })
    ]);
    expect(view?.events.some((event) => event.message.includes("does not exist"))).toBe(false);
  });

  it("keeps resumed SDK agent nodes running when task lookup is temporarily unavailable", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const storePath = path.join(tempDir, "hiveward-store.json");
    const store = new FileHivewardStore(storePath);
    await store.init();

    const baseAgent = createAgentNode("brief", "Brief");
    const agent: BlueprintNode = {
      ...baseAgent,
      runtimeId: "codex" as const,
      config: {
        ...baseAgent.config,
        modelId: "test-model",
        permissionProfile: "read_only" as const
      }
    };
    const blueprint = createBlueprint([agent], []);
    const run = await store.createBlueprintRun(blueprint, "test-user");
    const runningRun = { ...run, status: "running" as const };
    await store.updateBlueprintRun(runningRun);

    const startedAt = new Date().toISOString();
    const nodeRun: BlueprintNodeRun = {
      id: "node-run-sdk-resume",
      blueprintRunId: run.id,
      blueprintId: blueprint.id,
      nodeId: "brief",
      nodeLabel: "Brief",
      nodeType: "agent",
      status: "running",
      queuedAt: startedAt,
      startedAt,
      input: { upstream: [] },
      runtimeRef: {
        source: "codex",
        sourceId: "codex-task-1",
        sourceUpdatedAt: startedAt,
        taskId: "codex-task-1",
        runId: "codex-task-1-run",
        sessionKey: "codex-thread-1"
      }
    };
    await store.upsertNodeRun(nodeRun);

    const missingTaskAdapter = new ScriptedAdapter([], [
      new Error("SDK task not found: codex-task-1")
    ]);
    const firstWorker = new BlueprintWorker(store, missingTaskAdapter, { nodeRunLeaseMs: 10 });
    await firstWorker.resumeActiveRuns();

    const stillRunningView = await waitForRunView(store, run.id, (view) =>
      view.events.some((event) => event.message.includes("is still running"))
    );
    expect(missingTaskAdapter.waitCalls).toHaveLength(1);
    expect(stillRunningView.run.status).toBe("running");
    expect(stillRunningView.nodeRuns.find((candidate) => candidate.id === nodeRun.id)?.status).toBe("running");
    expect(stillRunningView.events.some((event) => event.type === "blueprint.run.failed")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const recoveredAdapter = new ScriptedAdapter([], [
      createCompletedAgentTask("codex-task-1", "succeeded", "brief ok", undefined, "codex")
    ]);
    const secondWorker = new BlueprintWorker(store, recoveredAdapter);
    await secondWorker.resumeActiveRuns();

    const finalView = await waitForRunTerminal(store, run.id);
    expect(finalView?.run.status).toBe("succeeded");
    expect(finalView?.nodeRuns.find((candidate) => candidate.id === nodeRun.id)?.status).toBe("succeeded");
    expect(finalView?.events.some((event) => event.type === "blueprint.run.failed")).toBe(false);
  });

  it("cancels a running blueprint and ignores late agent completion", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createBlueprint([createAgentNode("brief", "Brief")], []);
    const adapter = new BlockingAdapter(createStartedAgentTask("task-1"));
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    await waitForNodeRun(store, run.id, "brief", (nodeRun) => nodeRun.status === "running");

    const cancelled = await worker.cancelRun(run);
    expect(cancelled.status).toBe("cancelled");

    const cancelledView = await store.getRunView(run.id);
    expect(cancelledView?.run.status).toBe("cancelled");
    expect(cancelledView?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "brief")?.status).toBe("cancelled");
    expect(cancelledView?.events.some((event) => event.type === "blueprint.run.cancelled")).toBe(true);

    adapter.complete(createCompletedAgentTask("task-1", "succeeded", "brief ok"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const finalView = await store.getRunView(run.id);
    expect(finalView?.run.status).toBe("cancelled");
    expect(finalView?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "brief")?.status).toBe("cancelled");
    expect(finalView?.nodeRuns.some((nodeRun) => nodeRun.status === "succeeded")).toBe(false);
  });

  it("closes stale open node runs when cancelling a terminal blueprint", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createBlueprint([createAgentNode("brief", "Brief")], []);
    const run = await store.createBlueprintRun(blueprint, "test-user");
    await store.upsertNodeRun({
      id: "node-run-stale",
      blueprintRunId: run.id,
      blueprintId: blueprint.id,
      nodeId: "brief",
      nodeLabel: "Brief",
      nodeType: "agent",
      status: "running",
      queuedAt: run.startedAt,
      startedAt: run.startedAt
    });
    const failedRun = {
      ...run,
      status: "failed" as const,
      endedAt: new Date().toISOString(),
      durationMs: 1
    };
    await store.updateBlueprintRun(failedRun);
    const worker = new BlueprintWorker(store, new ScriptedAdapter([], []));

    const normalized = await worker.cancelRun(failedRun);
    const view = await store.getRunView(run.id);

    expect(normalized.status).toBe("failed");
    expect(view?.run.status).toBe("failed");
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "brief")?.status).toBe("cancelled");
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "brief")?.error).toContain("terminal state");
  });

  it("keeps a succeeded terminal blueprint successful when closing stale open node runs", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createBlueprint([createAgentNode("final", "Final"), createAgentNode("stale", "Stale child")], []);
    const run = await store.createBlueprintRun(blueprint, "test-user");
    await store.upsertNodeRun({
      id: "node-run-final",
      blueprintRunId: run.id,
      blueprintId: blueprint.id,
      nodeId: "final",
      nodeLabel: "Final",
      nodeType: "agent",
      status: "succeeded",
      queuedAt: run.startedAt,
      startedAt: run.startedAt,
      endedAt: new Date().toISOString(),
      output: "final ok"
    });
    await store.upsertNodeRun({
      id: "node-run-stale",
      blueprintRunId: run.id,
      blueprintId: blueprint.id,
      nodeId: "stale",
      nodeLabel: "Stale child",
      nodeType: "agent",
      status: "running",
      queuedAt: run.startedAt,
      startedAt: run.startedAt
    });
    const succeededRun = {
      ...run,
      status: "succeeded" as const,
      endedAt: new Date().toISOString(),
      durationMs: 1
    };
    await store.updateBlueprintRun(succeededRun);
    const worker = new BlueprintWorker(store, new ScriptedAdapter([], []));

    const normalized = await worker.cancelRun(succeededRun);
    const view = await store.getRunView(run.id);

    expect(normalized.status).toBe("succeeded");
    expect(view?.run.status).toBe("succeeded");
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "stale")?.status).toBe("cancelled");
    expect(view?.finalResult?.state).toBe("available");
    expect(view?.finalResult?.failedNode).toBeUndefined();
    expect(view?.finalResult?.candidates[0]).toMatchObject({
      nodeId: "final",
      output: "final ok"
    });
  });

  it("fails an agent node that finishes without visible output", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createBlueprint([createAgentNode("brief", "Brief")], []);
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-1")
    ], [
      createCompletedAgentTask("task-1", "succeeded")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);
    const nodeRun = view?.nodeRuns.find((candidate) => candidate.nodeId === "brief");

    expect(view?.run.status).toBe("failed");
    expect(nodeRun?.status).toBe("failed");
    expect(nodeRun?.output).toBeUndefined();
    expect(nodeRun?.error).toContain("visible output");
  });

  it("records node runtime timeline without replacing the final node output", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createBlueprint([createAgentNode("brief", "Brief")], []);
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-runtime")
    ], [
      createCompletedAgentTask("task-runtime", "succeeded", "brief ok")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);
    const nodeRun = view?.nodeRuns.find((candidate) => candidate.nodeId === "brief");
    const runtimeItems = view?.runTimeline?.filter((item) => item.kind === "node_runtime") ?? [];

    expect(view?.run.status).toBe("succeeded");
    expect(nodeRun?.output).toBe("brief ok");
    expect(runtimeItems).toHaveLength(1);
    expect(runtimeItems[0]).toMatchObject({
      kind: "node_runtime",
      actorLabel: "brief",
      payloadRef: nodeRun?.id
    });
    expect(runtimeItems[0]?.body).toContain("recent_output");
    expect(runtimeItems[0]?.body).toContain("brief ok");
  });

  it("runs harness summary nodes through the selected harness with the default merge prompt", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const summary: BlueprintNode = {
      id: "summary",
      type: "summary",
      position: { x: 420, y: 180 },
      config: {
        label: "Summary",
        mode: "harness_summary",
        runtimeId: "codex",
        modelId: "gpt-5-codex"
      }
    };
    const blueprint = createBlueprint([
      createAgentNode("brief", "Brief"),
      summary
    ], [
      { id: "brief-summary", source: "brief", target: "summary", condition: "success" }
    ]);
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-brief"),
      createStartedAgentTask("task-summary", "codex")
    ], [
      createCompletedAgentTask("task-brief", "succeeded", "brief ready"),
      createCompletedAgentTask("task-summary", "succeeded", "merged brief", undefined, "codex")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);

    expect(view?.run.status).toBe("succeeded");
    expect(adapter.calls[1]).toMatchObject({
      source: "codex",
      agentId: undefined,
      agentName: "summary-agent",
      modelId: "gpt-5-codex",
      prompt: expect.stringContaining("structured merge")
    });
    expect((adapter.calls[1]?.input as { upstream?: Array<{ humanReportMd?: string }> }).upstream?.[0]?.humanReportMd).toBe("brief ready");
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "summary")?.output).toBe("merged brief");
  });

  it("uses a custom prompt for harness summary nodes when provided", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const summary: BlueprintNode = {
      id: "summary",
      type: "summary",
      position: { x: 120, y: 180 },
      config: {
        label: "Summary",
        mode: "harness_summary",
        runtimeId: "claude",
        modelId: "inherit",
        prompt: "Return an executive summary."
      }
    };
    const blueprint = createBlueprint([summary], []);
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-summary", "claude")
    ], [
      createCompletedAgentTask("task-summary", "succeeded", "executive summary", undefined, "claude")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);

    expect(view?.run.status).toBe("succeeded");
    expect(adapter.calls[0]).toMatchObject({
      source: "claude",
      agentId: undefined,
      agentName: "summary-agent",
      modelId: "inherit",
      prompt: expect.stringContaining("Return an executive summary.")
    });
    expect(adapter.calls[0]?.prompt).toContain("humanReportMd");
    expect(adapter.calls[0]?.prompt).toContain("AgentOutputEnvelope is a transport wrapper");
    expect(adapter.calls[0]?.prompt).toContain("HiveWard preserves your answer even if the shape is imperfect");
    expect(adapter.calls[0]?.prompt).toContain("humanReportMd is your free-form human answer");
    expect(adapter.calls[0]?.prompt).toContain("## 摘要");
    expect(adapter.calls[0]?.prompt).toContain("100-150");
    expect(adapter.calls[0]?.prompt).toContain("If this step created any deliverable");
    expect(adapter.calls[0]?.prompt).toContain("fill them: humanReportMd");
    expect(adapter.calls[0]?.prompt).toContain("do not describe internal program phases");
    expect(adapter.calls[0]?.prompt).toContain("real file path, browser URL, or exact artifacts[] reference");
    expect(adapter.calls[0]?.prompt).toContain("Top-level artifacts[] is a publication hint and link/address index");
    expect(adapter.calls[0]?.prompt).toContain("One step may declare many artifacts");
    expect(adapter.calls[0]?.prompt).toContain("For generated deliverables, create or update files and return path");
    expect(adapter.calls[0]?.prompt).toContain("Do not paste artifact source");
    expect(adapter.calls[0]?.outputSchema).toMatchObject({
      properties: {
        artifacts: {
          items: {
            properties: {
              content: { description: expect.stringContaining("Compatibility") },
              path: { description: expect.stringContaining("generated file") }
            }
          }
        }
      }
    });
  });

  it("records Agent approval replies without rerunning before approval", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const delivery = createAgentNode("delivery", "Delivery");
    delivery.config = {
      ...delivery.config,
      approval: {
        enabled: true
      },
      send: {
        enabled: true,
        channelId: "slack",
        target: "#engineering",
        bodyTemplate: "Blueprint {{blueprint.name}} completed: {{summary}}"
      }
    };
    const blueprint = createBlueprint([delivery], []);
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-1"),
      createStartedAgentTask("task-2")
    ], [
      createCompletedAgentTask("task-1", "succeeded", "draft answer"),
      createCompletedAgentTask("task-2", "succeeded", "final answer")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const waitingView = await waitForRunStatus(store, run.id, "waiting_approval");
    const waitingNode = waitingView.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery")!;

    expect(waitingNode.output).toMatchObject({
      approvalType: "agent",
      reviewOutput: "draft answer",
      replies: []
    });
    expect(adapter.sendCalls).toHaveLength(0);

    await worker.replyToApproval(blueprint, waitingView.run, waitingNode.id, "Use the final wording.");
    const repliedView = await waitForRunStatus(store, run.id, "waiting_approval");
    const repliedNode = repliedView.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery")!;
    const repliedOutput = repliedNode.output as {
      reviewOutput: string;
      replies: Array<{ role: string; body: string }>;
    };

    expect(repliedOutput.reviewOutput).toBe("draft answer");
    expect(repliedOutput.replies.map((reply) => reply.role)).toEqual(["user"]);
    expect(repliedOutput.replies.map((reply) => reply.body)).toEqual(["Use the final wording."]);
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.sendCalls).toHaveLength(0);

    await worker.approveRun(blueprint, repliedView.run, repliedNode.id, "Approved.");
    const finalView = await waitForRunTerminal(store, run.id);
    const finalNode = finalView?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery");

    expect(finalView?.run.status).toBe("succeeded");
    expect(finalNode).toMatchObject({
      status: "succeeded",
      output: {
          approvedOutput: "draft answer",
          approval: {
            status: "approved",
            comment: "Approved.",
            replies: [
              {
                role: "user",
                body: "Use the final wording."
              }
            ]
          }
        }
      });
    expect(adapter.sendCalls).toHaveLength(1);
    expect(adapter.sendCalls[0]).toMatchObject({
      channelId: "slack",
      target: "#engineering",
      blueprintRunId: run.id,
      nodeRunId: repliedNode.id
    });
    expect(adapter.sendCalls[0]?.body).toContain("Blueprint Test blueprint completed");
    expect(adapter.sendCalls[0]?.body).toContain("draft answer");
  });

  it("streams Agent approval discussion replies without publishing candidates or approving", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const delivery = createAgentNode("delivery", "Delivery");
    delivery.config = {
      ...delivery.config,
      approval: {
        enabled: true
      }
    };
    const blueprint = createBlueprint([delivery], []);
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-1"),
      createStartedAgentTask("task-2")
    ], [
      createCompletedAgentTask("task-1", "succeeded", "draft answer"),
      createCompletedAgentTask("task-2", "succeeded", {
        humanReportMd: "## Summary\n\nAlternative answer.",
        result: { status: "ready" }
      })
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const waitingView = await waitForRunStatus(store, run.id, "waiting_approval");
    const approvalRequest = waitingView.approvalRequests?.find((request) => request.kind === "agent_proposal");
    if (!approvalRequest?.threadId) throw new Error("Expected agent approval request.");
    const events: Array<{ type: string; text?: string; replyId?: string; messageId?: string }> = [];

    await worker.streamInboxThreadMessage({
      threadType: "approval",
      threadId: approvalRequest.threadId,
      message: "Generate a formal candidate with another version.",
      onEvent: (event) => events.push(event)
    });

    const replyView = await store.getRunView(run.id);
    const waitingNode = replyView?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery");
    const waitingOutput = waitingNode?.output as {
      approvalType: "agent";
      reviewOutput: string;
      replies: Array<{ id: string; role: string; body: string; canUseAsSolution?: boolean }>;
      selectedReplyId?: string;
    };

    expect(replyView?.run.status).toBe("waiting_approval");
    expect(waitingNode?.status).toBe("waiting_approval");
    expect(waitingOutput.reviewOutput).toBe("draft answer");
    expect(waitingOutput.selectedReplyId).toBeUndefined();
    expect(waitingOutput.replies.map((reply) => [reply.role, reply.body])).toEqual([
      ["user", "Generate a formal candidate with another version."],
      ["assistant", "## Summary\n\nAlternative answer."]
    ]);
    expect(waitingOutput.replies[1]?.canUseAsSolution).toBe(false);
    expect(events.map((event) => event.type)).toEqual([
      "inbox_message_created",
      "started",
      "delta",
      "done"
    ]);
    expect(events.some((event) => event.type === "inbox_candidate_created")).toBe(false);
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.chatCalls).toHaveLength(1);
    const deliveryConfig = delivery.config as AgentNodeConfig;
    expect(adapter.chatCalls[0]).toMatchObject({
      source: "openclaw",
      modelId: deliveryConfig.modelId,
      skillIds: deliveryConfig.skillIds
    });
    expect(adapter.chatCalls[0]?.message).toContain("Generate a formal candidate with another version.");

    await worker.selectApprovalReply(blueprint, replyView!.run, waitingNode!.id, waitingOutput.replies[1]!.id);
    const selectedView = await store.getRunView(run.id);
    const selectedNode = selectedView?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery");
    expect((selectedNode?.output as { selectedReplyId?: string }).selectedReplyId).toBe(waitingOutput.replies[1]?.id);
  });

  it("keeps ordinary Agent approval discussion replies as discussion until explicitly selected", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const delivery = createAgentNode("delivery", "Delivery");
    delivery.config = {
      ...delivery.config,
      approval: {
        enabled: true
      }
    };
    const blueprint = createBlueprint([delivery], []);
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-ordinary-1"),
      createStartedAgentTask("task-ordinary-2")
    ], [
      createCompletedAgentTask("task-ordinary-1", "succeeded", "draft answer"),
      createCompletedAgentTask("task-ordinary-2", "succeeded", {
        humanReportMd: "This version trades speed for more verification detail.",
        result: { status: "discussed" }
      })
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const waitingView = await waitForRunStatus(store, run.id, "waiting_approval");
    const approvalRequest = waitingView.approvalRequests?.find((request) => request.kind === "agent_proposal");
    if (!approvalRequest?.threadId) throw new Error("Expected agent approval request.");
    const events: Array<{ type: string; replyId?: string }> = [];

    await worker.streamInboxThreadMessage({
      threadType: "approval",
      threadId: approvalRequest.threadId,
      message: "Can you explain the tradeoff first?",
      onEvent: (event) => events.push(event)
    });

    const replyView = await store.getRunView(run.id);
    const waitingNode = replyView?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery");
    const waitingOutput = waitingNode?.output as {
      approvalType: "agent";
      replies: Array<{ id: string; role: string; body: string; canUseAsSolution?: boolean }>;
    };

    expect(replyView?.run.status).toBe("waiting_approval");
    expect(waitingOutput.replies.map((reply) => [reply.role, reply.body, reply.canUseAsSolution])).toEqual([
      ["user", "Can you explain the tradeoff first?", undefined],
      ["assistant", "This version trades speed for more verification detail.", false]
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "inbox_message_created",
      "started",
      "delta",
      "done"
    ]);
    expect(adapter.chatCalls[0]?.message).toContain("ordinary reply in a HiveWard inbox discussion");
    expect(adapter.chatCalls[0]?.message).toContain("Can you explain the tradeoff first?");
    expect(adapter.chatCalls[0]?.message).toContain("Do not approve, reject, rerun, schedule, complete");
    expect(adapter.chatCalls[0]?.message).not.toContain("HiveWard inbox discussion payload");
    expect(adapter.chatCalls[0]?.message).not.toContain("originalInput");
    const [thread] = await store.listApprovalThreads({ runId: run.id });
    const messages = await store.listChatMessages(thread!.discussionSession!.chatSessionId!);
    expect(messages[0]?.content).toBe("Can you explain the tradeoff first?");
    expect(messages[0]?.content).not.toContain("HiveWard inbox discussion payload");
    await worker.selectApprovalReply(blueprint, replyView!.run, waitingNode!.id, waitingOutput.replies[1]!.id);
    const selectedView = await store.getRunView(run.id);
    const selectedNode = selectedView?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery");
    expect((selectedNode?.output as { selectedReplyId?: string }).selectedReplyId).toBe(waitingOutput.replies[1]?.id);
  });

  it("resumes the same native discussion session for repeated Agent approval replies", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const delivery = createAgentNode("delivery", "Delivery");
    delivery.config = {
      ...delivery.config,
      approval: {
        enabled: true
      }
    };
    const blueprint = createBlueprint([delivery], []);
    const adapter = new ScriptedAdapter([
      { ...createStartedAgentTask("task-resume-initial"), sessionKey: "native-approval-session" }
    ], [
      { ...createCompletedAgentTask("task-resume-initial", "succeeded", "draft answer"), sessionKey: "native-approval-session" },
      { ...createCompletedAgentTask("task-resume-chat-1", "succeeded", "answer one"), sessionKey: "native-approval-session" },
      { ...createCompletedAgentTask("task-resume-chat-2", "succeeded", "answer two"), sessionKey: "native-approval-session" },
      { ...createCompletedAgentTask("task-resume-chat-3", "succeeded", "answer three"), sessionKey: "native-approval-session" }
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const waitingView = await waitForRunStatus(store, run.id, "waiting_approval");
    const approvalRequest = waitingView.approvalRequests?.find((request) => request.kind === "agent_proposal");
    if (!approvalRequest?.threadId) throw new Error("Expected agent approval request.");

    for (const message of ["First follow-up.", "Second follow-up.", "Third follow-up."]) {
      await worker.streamInboxThreadMessage({
        threadType: "approval",
        threadId: approvalRequest.threadId,
        message,
        onEvent: () => undefined
      });
    }

    expect(adapter.chatCalls.map((call) => call.sessionKey)).toEqual([
      "native-approval-session",
      "native-approval-session",
      "native-approval-session"
    ]);
    expect(adapter.calls).toHaveLength(1);
    const [thread] = await store.listApprovalThreads({ runId: run.id });
    expect(thread?.discussionSession).toMatchObject({
      threadType: "approval",
      threadId: approvalRequest.threadId,
      nativeSessionId: "native-approval-session",
      nativeSessionState: "resumable",
      status: "active"
    });
    const messages = await store.listChatMessages(thread!.discussionSession!.chatSessionId!);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    expect(messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
      "First follow-up.",
      "Second follow-up.",
      "Third follow-up."
    ]);
    expect(messages.some((message) => message.content.includes("HiveWard inbox discussion payload"))).toBe(false);
  });

  it("marks inbox discussion sessions native_missing when native resume fails", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const delivery = createAgentNode("delivery", "Delivery");
    delivery.config = {
      ...delivery.config,
      approval: {
        enabled: true
      }
    };
    const blueprint = createBlueprint([delivery], []);
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-missing-initial")
    ], [
      createCompletedAgentTask("task-missing-initial", "succeeded", "draft answer"),
      createCompletedAgentTask("task-missing-chat-1", "succeeded", "answer one"),
      createCompletedAgentTask("task-missing-chat-2", "failed", undefined, "Cannot resume thread: session not found")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const waitingView = await waitForRunStatus(store, run.id, "waiting_approval");
    const approvalRequest = waitingView.approvalRequests?.find((request) => request.kind === "agent_proposal");
    if (!approvalRequest?.threadId) throw new Error("Expected agent approval request.");

    await worker.streamInboxThreadMessage({
      threadType: "approval",
      threadId: approvalRequest.threadId,
      message: "First follow-up.",
      onEvent: () => undefined
    });
    await worker.streamInboxThreadMessage({
      threadType: "approval",
      threadId: approvalRequest.threadId,
      message: "Second follow-up.",
      onEvent: () => undefined
    });

    const [thread] = await store.listApprovalThreads({ runId: run.id });
    expect(thread?.discussionSession).toMatchObject({
      nativeSessionId: "agent:main:main",
      nativeSessionState: "missing",
      status: "native_missing"
    });
    const chatSession = await store.getChatSession(thread!.discussionSession!.chatSessionId!);
    expect(chatSession).toMatchObject({
      status: "native_missing",
      nativeSessionState: "missing"
    });
    const replies = await store.listApprovalReplies({ approvalRequestId: approvalRequest.id });
    expect(replies.at(-1)).toMatchObject({
      actor: "system",
      body: "Cannot resume thread: session not found"
    });
  });

  it("starts a fresh discussion session for the next blueprint run", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const delivery = createAgentNode("delivery", "Delivery");
    delivery.config = {
      ...delivery.config,
      approval: {
        enabled: true
      }
    };
    const blueprint = createBlueprint([delivery], []);
    const adapter = new ScriptedAdapter([
      { ...createStartedAgentTask("task-run-1-initial"), sessionKey: "native-run-1" },
      { ...createStartedAgentTask("task-run-2-initial"), sessionKey: "native-run-2" }
    ], [
      { ...createCompletedAgentTask("task-run-1-initial", "succeeded", "first draft"), sessionKey: "native-run-1" },
      { ...createCompletedAgentTask("task-run-1-chat", "succeeded", "first run answer"), sessionKey: "native-run-1" },
      { ...createCompletedAgentTask("task-run-2-initial", "succeeded", "second draft"), sessionKey: "native-run-2" },
      { ...createCompletedAgentTask("task-run-2-chat", "succeeded", "second run answer"), sessionKey: "native-run-2" }
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const firstRun = await worker.startRun(blueprint, "test-user");
    const firstWaiting = await waitForRunStatus(store, firstRun.id, "waiting_approval");
    const firstRequest = firstWaiting.approvalRequests?.find((request) => request.kind === "agent_proposal");
    if (!firstRequest?.threadId) throw new Error("Expected first approval request.");
    await worker.streamInboxThreadMessage({
      threadType: "approval",
      threadId: firstRequest.threadId,
      message: "Discuss first run.",
      onEvent: () => undefined
    });

    const secondRun = await worker.startRun(blueprint, "test-user");
    const secondWaiting = await waitForRunStatus(store, secondRun.id, "waiting_approval");
    const secondRequest = secondWaiting.approvalRequests?.find((request) => request.kind === "agent_proposal");
    if (!secondRequest?.threadId) throw new Error("Expected second approval request.");
    await worker.streamInboxThreadMessage({
      threadType: "approval",
      threadId: secondRequest.threadId,
      message: "Discuss second run.",
      onEvent: () => undefined
    });

    const firstThread = (await store.listApprovalThreads({ runId: firstRun.id }))[0];
    const secondThread = (await store.listApprovalThreads({ runId: secondRun.id }))[0];
    expect(firstThread?.discussionSession?.nativeSessionId).toBe("native-run-1");
    expect(secondThread?.discussionSession?.nativeSessionId).toBe("native-run-2");
    expect(adapter.chatCalls.map((call) => call.sessionKey)).toEqual([
      "native-run-1",
      "native-run-2"
    ]);
  });

  it("streams Agent approval discussion through the runtime that created the waiting node", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const delivery = createAgentNode("delivery", "Delivery");
    delivery.runtimeId = "opencode";
    delivery.config = {
      ...delivery.config,
      approval: {
        enabled: true
      }
    };
    const blueprint = createBlueprint([delivery], []);
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-runtime-1", "claude"),
      createStartedAgentTask("task-runtime-2", "claude")
    ], [
      createCompletedAgentTask("task-runtime-1", "succeeded", "draft answer", undefined, "claude"),
      createCompletedAgentTask("task-runtime-2", "succeeded", "claude follow-up", undefined, "claude")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const waitingView = await waitForRunStatus(store, run.id, "waiting_approval");
    const waitingNode = waitingView.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery");
    const approvalRequest = waitingView.approvalRequests?.find((request) => request.kind === "agent_proposal");
    if (!approvalRequest?.threadId || !waitingNode) throw new Error("Expected agent approval request.");
    const events: Array<{ type: string; source?: string }> = [];

    await worker.streamInboxThreadMessage({
      threadType: "approval",
      threadId: approvalRequest.threadId,
      message: "Use the same harness for this follow-up.",
      onEvent: (event) => events.push(event)
    });

    expect(adapter.calls[0]?.source).toBe("opencode");
    expect(waitingNode.runtimeRef?.source).toBe("claude");
    expect(adapter.chatCalls[0]?.source).toBe("claude");
    expect(events.find((event) => event.type === "started")?.source).toBe("claude");
    expect(events.find((event) => event.type === "done")?.source).toBe("claude");
  });

  it("streams requirement-plan approval discussion through the configured planning executor without approving", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createSelfIterationBlueprint({ maxRounds: 1, researchAgent: true, requirementAgent: true });
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-plan-chat-research"),
      createStartedAgentTask("task-plan-chat-plan"),
      createStartedAgentTask("task-plan-chat-discussion")
    ], [
      createCompletedAgentTask("task-plan-chat-research", "succeeded", "plan chat research"),
      createCompletedAgentTask("task-plan-chat-plan", "succeeded", "initial plan"),
      createCompletedAgentTask("task-plan-chat-discussion", "succeeded", "assistant plan reply")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const waiting = await waitForRunStatus(store, run.id, "waiting_approval");
    const requirement = waiting.approvalRequests?.find((request) => request.kind === "iteration_requirement_plan");
    if (!requirement?.threadId) throw new Error("Expected requirement approval.");
    const events: Array<{ type: string; replyId?: string }> = [];

    await worker.streamInboxThreadMessage({
      threadType: "approval",
      threadId: requirement.threadId,
      message: "Discuss a clearer acceptance criterion.",
      onEvent: (event) => events.push(event)
    });

    const replyView = await store.getRunView(run.id);
    const replies = await store.listApprovalReplies({ approvalRequestId: requirement.id });

    expect(replyView?.run.status).toBe("waiting_approval");
    expect(replyView?.approvalRequests?.find((request) => request.id === requirement.id)).toMatchObject({
      status: "pending"
    });
    expect(replyView?.approvalDecisions ?? []).toHaveLength(0);
    expect(replies.map((reply) => [reply.actor, reply.body])).toEqual([
      ["user", "Discuss a clearer acceptance criterion."],
      ["agent", "assistant plan reply"]
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "inbox_message_created",
      "started",
      "delta",
      "done"
    ]);
    expect(replies[1]?.metadata).toMatchObject({ inboxDiscussionMode: "reply", candidate: false });
    expect(adapter.calls.map((call) => call.agentName)).toEqual(["research", "requirements"]);
    expect(adapter.chatCalls).toHaveLength(1);
    expect(adapter.chatCalls[0]?.message).toContain("ordinary reply in a HiveWard inbox discussion");
    expect(adapter.chatCalls[0]?.message).toContain("Type: iteration_requirement_plan");
    expect(adapter.chatCalls[0]?.message).toContain("Discuss a clearer acceptance criterion.");
    expect(adapter.chatCalls[0]?.message).not.toContain("HiveWard inbox discussion payload");
    expect(adapter.chatCalls[0]?.message).not.toContain('"revisionFeedback"');
  });

  it("streams release-report approval discussion through the manager without starting the next round", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createSelfIterationBlueprint({ maxRounds: 1 });
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-report-chat-research"),
      createStartedAgentTask("task-report-chat-plan"),
      createStartedAgentTask("task-report-chat-build"),
      createStartedAgentTask("task-report-chat-release"),
      createStartedAgentTask("task-report-chat-discussion")
    ], [
      createCompletedAgentTask("task-report-chat-research", "succeeded", "report chat research"),
      createCompletedAgentTask("task-report-chat-plan", "succeeded", "report chat plan"),
      createCompletedAgentTask("task-report-chat-build", "succeeded", htmlArtifactOutput("report chat")),
      createCompletedAgentTask("task-report-chat-release", "succeeded", releaseReportOutput("report chat")),
      createCompletedAgentTask("task-report-chat-discussion", "succeeded", releaseReportOutput("report chat candidate"))
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const started = await waitForRunStatus(store, run.id, "waiting_approval");
    const requirement = started.approvalRequests?.find((request) => request.kind === "iteration_requirement_plan");
    const currentRun = await store.getBlueprintRun(run.id);
    if (!currentRun || !requirement) throw new Error("Expected requirement approval.");
    await worker.applyApprovalRequest(blueprint, currentRun, requirement.id, "approve");

    const reportView = await waitForRunView(store, run.id, (view) =>
      view.run.status === "waiting_approval" &&
      (view.approvalRequests ?? []).some((request) => request.kind === "manager_release_report" && request.status === "pending")
    );
    const report = reportView.approvalRequests?.find((request) =>
      request.kind === "manager_release_report" && request.status === "pending"
    );
    if (!report?.threadId) throw new Error("Expected release report approval.");
    const events: Array<{ type: string }> = [];

    await worker.streamInboxThreadMessage({
      threadType: "approval",
      threadId: report.threadId,
      message: "Discuss the verification language before I pass it.",
      onEvent: (event) => events.push(event)
    });

    const replyView = await store.getRunView(run.id);
    const replies = await store.listApprovalReplies({ approvalRequestId: report.id });

    expect(replyView?.run.status).toBe("waiting_approval");
    expect(replyView?.approvalRequests?.find((request) => request.id === report.id)).toMatchObject({
      status: "pending"
    });
    expect(replyView?.approvalDecisions?.map((decision) => decision.action)).toEqual(["approve"]);
    expect(replyView?.iterationRounds?.[0]).toMatchObject({ status: "report_pending" });
    expect(replies.map((reply) => [reply.actor, reply.body])).toEqual([
      ["user", "Discuss the verification language before I pass it."],
      ["manager", expect.stringContaining("report chat candidate release report written by the manager")]
    ]);
    expect(events.map((event) => event.type)).toEqual(["inbox_message_created", "started", "delta", "done"]);
    expect(replies[1]?.metadata).toMatchObject({ inboxDiscussionMode: "reply", candidate: false });
    expect(adapter.calls.map((call) => call.agentName)).toEqual(["manager", "manager", "builder", "manager"]);
    expect(adapter.chatCalls).toHaveLength(1);
    expect(adapter.chatCalls[0]?.message).toContain("ordinary reply in a HiveWard inbox discussion");
    expect(adapter.chatCalls[0]?.message).toContain("Type: manager_release_report");
    expect(adapter.chatCalls[0]?.message).toContain("Discuss the verification language before I pass it.");
    expect(adapter.chatCalls[0]?.message).not.toContain("HiveWard inbox discussion payload");
    expect(adapter.chatCalls[0]?.message).not.toContain('"revisionFeedback"');
  }, 30_000);

  it("keeps function-node approval replies as message-only when no executor is bound", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();
    const approvalService = new ApprovalService(store);
    const request = await approvalService.createRequest({
      kind: "function_node",
      title: "Manual function checkpoint",
      body: "Manual checkpoint body.",
      requestedBy: {
        type: "system",
        label: "Manual checkpoint"
      }
    });
    const adapter = new ScriptedAdapter([], []);
    const worker = new BlueprintWorker(store, adapter);
    const events: Array<{ type: string }> = [];

    await worker.streamInboxThreadMessage({
      threadType: "approval",
      threadId: request.threadId ?? request.id,
      message: "Leave this note only.",
      onEvent: (event) => events.push(event)
    });

    expect(events.map((event) => event.type)).toEqual(["inbox_message_created", "done"]);
    expect(adapter.calls).toHaveLength(0);
    expect((await store.getApprovalRequest(request.id))?.status).toBe("pending");
    expect(await store.listApprovalDecisions(request.id)).toEqual([]);
    expect(await store.listApprovalReplies({ approvalRequestId: request.id })).toEqual([
      expect.objectContaining({
        actor: "user",
        body: "Leave this note only."
      })
    ]);
  });

  it("keeps Agent approval rejection from rerunning or continuing the run", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const delivery = createAgentNode("delivery", "Delivery");
    delivery.config = {
      ...delivery.config,
      approval: {
        enabled: true
      }
    };
    const blueprint = createBlueprint([delivery], []);
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-agent-reject-1"),
      createStartedAgentTask("task-agent-reject-2")
    ], [
      createCompletedAgentTask("task-agent-reject-1", "succeeded", "draft answer"),
      createCompletedAgentTask("task-agent-reject-2", "succeeded", "implicit rerun answer")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const waitingView = await waitForRunStatus(store, run.id, "waiting_approval");
    const waitingNode = waitingView.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery")!;
    const approvalRequest = waitingView.approvalRequests?.find((request) => request.kind === "agent_proposal");
    if (!approvalRequest) throw new Error("Expected agent approval request.");

    await worker.applyApprovalRequest(blueprint, waitingView.run, approvalRequest.id, "reject", {
      comment: "Do not use this output."
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const rejectedView = await store.getRunView(run.id);
    const rejectedRequest = rejectedView?.approvalRequests?.find((request) => request.id === approvalRequest.id);
    const rejectedNode = rejectedView?.nodeRuns.find((nodeRun) => nodeRun.id === waitingNode.id);

    expect(rejectedView?.run.status).toBe("waiting_approval");
    expect(rejectedRequest).toMatchObject({ status: "rejected" });
    expect(rejectedNode).toMatchObject({
      status: "waiting_approval",
      output: expect.objectContaining({ reviewOutput: "draft answer" })
    });
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.sendCalls).toHaveLength(0);
  });

  it("reruns an Agent approval only through explicit request_changes", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const delivery = createAgentNode("delivery", "Delivery");
    delivery.config = {
      ...delivery.config,
      approval: {
        enabled: true
      }
    };
    const blueprint = createBlueprint([delivery], []);
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-agent-change-1"),
      createStartedAgentTask("task-agent-change-2")
    ], [
      createCompletedAgentTask("task-agent-change-1", "succeeded", "draft answer"),
      createCompletedAgentTask("task-agent-change-2", "succeeded", "revised answer")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const waitingView = await waitForRunStatus(store, run.id, "waiting_approval");
    const approvalRequest = waitingView.approvalRequests?.find((request) => request.kind === "agent_proposal");
    if (!approvalRequest) throw new Error("Expected agent approval request.");

    await worker.applyApprovalRequest(blueprint, waitingView.run, approvalRequest.id, "request_changes", {
      comment: "Regenerate with sources."
    });

    const revisedView = await waitForRunStatus(store, run.id, "waiting_approval");
    const originalRequest = revisedView.approvalRequests?.find((request) => request.id === approvalRequest.id);
    const revisedRequest = revisedView.approvalRequests
      ?.filter((request) => request.kind === "agent_proposal" && request.status === "pending")
      .at(-1);
    const revisedNode = revisedView.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery");

    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[1]?.input).toMatchObject({
      approvalRevision: expect.objectContaining({
        requestedChanges: "Regenerate with sources."
      })
    });
    expect(originalRequest).toMatchObject({
      status: "superseded",
      supersededByRequestId: revisedRequest?.id
    });
    expect(revisedRequest).toMatchObject({
      status: "pending",
      threadId: approvalRequest.threadId,
      replacesRequestId: approvalRequest.id,
      revision: 2
    });
    expect(revisedNode?.status).toBe("waiting_approval");
    expect(revisedNode?.output).toMatchObject({
      approvalType: "agent",
      reviewOutput: "revised answer"
    });
    expect(revisedView.approvalDecisions?.map((decision) => decision.action)).toEqual(["request_changes"]);
  });

  it("keeps original approval actionable when request_changes rerun fails or returns empty output", async () => {
    const cases: Array<{ label: string; result: AgentTaskResult }> = [
      { label: "failed", result: createCompletedAgentTask("task-agent-change-2", "failed", undefined, "model failed") },
      { label: "empty", result: createCompletedAgentTask("task-agent-change-2", "succeeded", undefined) }
    ];

    for (const testCase of cases) {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), `hiveward-worker-request-changes-${testCase.label}-`));
      const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
      await store.init();

      const delivery = createAgentNode("delivery", "Delivery");
      delivery.config = {
        ...delivery.config,
        approval: {
          enabled: true
        }
      };
      const blueprint = createBlueprint([delivery], []);
      const adapter = new ScriptedAdapter([
        createStartedAgentTask("task-agent-change-1"),
        createStartedAgentTask("task-agent-change-2")
      ], [
        createCompletedAgentTask("task-agent-change-1", "succeeded", "draft answer"),
        testCase.result
      ]);
      const worker = new BlueprintWorker(store, adapter);

      const run = await worker.startRun(blueprint, "test-user");
      const waitingView = await waitForRunStatus(store, run.id, "waiting_approval");
      const waitingNode = waitingView.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery");
      const approvalRequest = waitingView.approvalRequests?.find((request) => request.kind === "agent_proposal");
      if (!approvalRequest || !waitingNode) throw new Error("Expected agent approval request.");

      await expect(worker.applyApprovalRequest(blueprint, waitingView.run, approvalRequest.id, "request_changes", {
        comment: "Regenerate with sources."
      })).rejects.toThrow();

      const restoredView = await store.getRunView(run.id);
      const originalRequest = restoredView?.approvalRequests?.find((request) => request.id === approvalRequest.id);
      const revisedRequests = restoredView?.approvalRequests
        ?.filter((request) => request.kind === "agent_proposal" && request.replacesRequestId === approvalRequest.id) ?? [];
      const restoredNode = restoredView?.nodeRuns.find((nodeRun) => nodeRun.id === waitingNode.id);

      expect(restoredView?.run.status).toBe("waiting_approval");
      expect(originalRequest).toMatchObject({
        status: "pending",
        capabilities: expect.objectContaining({ approve: true, reply: true, requestChanges: true })
      });
      expect(revisedRequests).toHaveLength(0);
      expect(restoredNode).toMatchObject({
        status: "waiting_approval",
        output: expect.objectContaining({ reviewOutput: "draft answer" })
      });
      expect(restoredView?.approvalDecisions?.filter((decision) => decision.action === "request_changes")).toHaveLength(1);
    }
  });

  it("persists approval revision context across worker restart and creates revised Agent approval in the same thread after restored rerun", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-restored-revision-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const delivery = createAgentNode("delivery", "Delivery");
    delivery.config = {
      ...delivery.config,
      approval: {
        enabled: true
      }
    };
    const blueprint = createBlueprint([delivery], []);
    const firstWorker = new BlueprintWorker(
      store,
      new ScriptedAdapter([
        createStartedAgentTask("task-agent-change-1")
      ], [
        createCompletedAgentTask("task-agent-change-1", "succeeded", "draft answer")
      ]),
      { nodeRunLeaseMs: 10 }
    );

    const run = await firstWorker.startRun(blueprint, "test-user");
    const waitingView = await waitForRunStatus(store, run.id, "waiting_approval");
    const waitingNode = waitingView.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery");
    const approvalRequest = waitingView.approvalRequests?.find((request) => request.kind === "agent_proposal");
    if (!approvalRequest || !waitingNode || !isAgentApprovalWaitingOutputForTest(waitingNode.output)) {
      throw new Error("Expected agent approval request.");
    }

    await new ApprovalService(store).requestChanges(approvalRequest.id, "Regenerate with sources.");
    const revisionContext = {
      threadId: approvalRequest.threadId,
      replacesRequestId: approvalRequest.id,
      revision: approvalRequest.revision + 1,
      requestedChanges: "Regenerate with sources."
    };
    const now = new Date().toISOString();
    await store.upsertNodeRun({
      ...waitingNode,
      status: "running",
      input: {
        originalInput: waitingNode.input,
        approvalRevisionContext: revisionContext,
        approvalRevision: {
          previousOutput: waitingNode.output.reviewOutput,
          previousReplies: waitingNode.output.replies,
          requestedChanges: revisionContext.requestedChanges
        }
      },
      output: undefined,
      runtimeRef: {
        source: "openclaw",
        sourceId: "task-agent-change-2",
        sourceUpdatedAt: now,
        taskId: "task-agent-change-2",
        runId: "task-agent-change-2-run",
        sessionKey: "agent:main:main"
      },
      startedAt: now,
      endedAt: undefined,
      error: undefined
    });
    await store.updateBlueprintRun({ ...waitingView.run, status: "running" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const restoredWorker = new BlueprintWorker(
      store,
      new ScriptedAdapter([], [
        createCompletedAgentTask("task-agent-change-2", "succeeded", "revised answer")
      ])
    );
    await restoredWorker.resumeActiveRuns();

    const revisedView = await waitForRunStatus(store, run.id, "waiting_approval");
    const originalRequest = revisedView.approvalRequests?.find((request) => request.id === approvalRequest.id);
    const revisedRequest = revisedView.approvalRequests
      ?.filter((request) => request.kind === "agent_proposal" && request.replacesRequestId === approvalRequest.id)
      .at(-1);

    expect(originalRequest).toMatchObject({
      status: "superseded",
      supersededByRequestId: revisedRequest?.id
    });
    expect(revisedRequest).toMatchObject({
      status: "pending",
      threadId: approvalRequest.threadId,
      replacesRequestId: approvalRequest.id,
      revision: approvalRequest.revision + 1
    });
    expect(revisedView.nodeRuns.find((nodeRun) => nodeRun.id === waitingNode.id)).toMatchObject({
      status: "waiting_approval",
      output: expect.objectContaining({ reviewOutput: "revised answer" })
    });
  });

  it("keeps approvalRequestId Agent approval replies append-only until approval", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const delivery = createAgentNode("delivery", "Delivery");
    delivery.config = {
      ...delivery.config,
      approval: {
        enabled: true
      }
    };
    const blueprint = createBlueprint([delivery], []);
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-approval-request-1"),
      createStartedAgentTask("task-approval-request-2")
    ], [
      createCompletedAgentTask("task-approval-request-1", "succeeded", "draft answer"),
      createCompletedAgentTask("task-approval-request-2", "succeeded", "assistant revised answer")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const waitingView = await waitForRunStatus(store, run.id, "waiting_approval");
    const approvalRequest = waitingView.approvalRequests?.find((request) => request.kind === "agent_proposal");
    if (!approvalRequest) throw new Error("Expected agent approval request.");

    await worker.applyApprovalRequest(blueprint, waitingView.run, approvalRequest.id, "reply", {
      message: "Give me a shippable version."
    });

    const repliedView = await waitForRunStatus(store, run.id, "waiting_approval");
    const pendingAfterReply = (await store.listPendingApprovals()).find((approval) => approval.approvalRequestId === approvalRequest.id);

    expect(pendingAfterReply).toMatchObject({
      reviewOutput: "draft answer",
      status: "pending"
    });
    expect(pendingAfterReply?.replies?.map((reply) => [reply.role, reply.body])).toEqual([
      ["user", "Give me a shippable version."]
    ]);

    const repliedNode = repliedView.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery");
    if (!repliedNode) throw new Error("Expected replied node.");
    expect(adapter.calls).toHaveLength(1);

    const currentRun = await store.getBlueprintRun(run.id);
    if (!currentRun) throw new Error("Expected current run.");
    await worker.applyApprovalRequest(blueprint, currentRun, approvalRequest.id, "approve");

    const finalView = await waitForRunTerminal(store, run.id);
    const finalNode = finalView?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery");
    expect(finalView?.run.status).toBe("succeeded");
    expect(finalNode?.output).toMatchObject({
      approvedOutput: "draft answer",
      approval: {
        status: "approved"
      }
    });
    expect(finalView?.approvalRequests?.find((request) => request.id === approvalRequest.id)?.status).toBe("approved");
    expect(finalView?.approvalDecisions?.map((decision) => decision.action)).toEqual(["reply", "approve"]);
  });

  it("keeps Agent approval comments from changing the selected output", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const delivery = createAgentNode("delivery", "Delivery");
    delivery.config = {
      ...delivery.config,
      approval: {
        enabled: true
      }
    };
    const blueprint = createBlueprint([delivery], []);
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-1"),
      createStartedAgentTask("task-2"),
      createStartedAgentTask("task-3")
    ], [
      createCompletedAgentTask("task-1", "succeeded", "draft answer"),
      createCompletedAgentTask("task-2", "succeeded", "first usable plan"),
      createCompletedAgentTask("task-3", "succeeded", "second plan")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const waitingView = await waitForRunStatus(store, run.id, "waiting_approval");
    const waitingNode = waitingView.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery")!;

    await worker.replyToApproval(blueprint, waitingView.run, waitingNode.id, "Give me a concrete plan.");
    const firstReplyView = await waitForRunStatus(store, run.id, "waiting_approval");
    const firstReplyNode = firstReplyView.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery")!;
    const firstReplyOutput = firstReplyNode.output as {
      replies: Array<{ id: string; role: string; body: string; selected?: boolean }>;
    };
    expect(firstReplyOutput.replies.map((reply) => [reply.role, reply.body])).toEqual([
      ["user", "Give me a concrete plan."]
    ]);

    await worker.selectApprovalReply(blueprint, firstReplyView.run, firstReplyNode.id, "reviewOutput");
    const selectedView = await waitForRunStatus(store, run.id, "waiting_approval");
    const selectedNode = selectedView.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery")!;
    const selectedOutput = selectedNode.output as {
      selectedReplyId: string;
      replies: Array<{ id: string; selected?: boolean }>;
    };
    expect(selectedOutput.selectedReplyId).toBe("reviewOutput");

    await worker.replyToApproval(blueprint, selectedView.run, selectedNode.id, "Try one more variant.");
    const secondReplyView = await waitForRunStatus(store, run.id, "waiting_approval");
    const secondReplyNode = secondReplyView.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery")!;
    const secondReplyOutput = secondReplyNode.output as {
      reviewOutput: string;
      selectedReplyId: string;
      replies: Array<{ role: string; body: string }>;
    };

    expect(secondReplyOutput.reviewOutput).toBe("draft answer");
    expect(secondReplyOutput.selectedReplyId).toBe("reviewOutput");
    expect(secondReplyOutput.replies.map((reply) => [reply.role, reply.body])).toEqual([
      ["user", "Give me a concrete plan."],
      ["user", "Try one more variant."]
    ]);
    expect(adapter.calls).toHaveLength(1);

    await worker.approveRun(blueprint, secondReplyView.run, secondReplyNode.id);
    const finalView = await waitForRunTerminal(store, run.id);
    const finalNode = finalView?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery");

    expect(finalView?.run.status).toBe("succeeded");
    expect(finalNode?.output).toMatchObject({
      approvedOutput: "draft answer",
      approval: {
        status: "approved",
        selectedReplyId: "reviewOutput"
      }
    });
  });

  it("keeps the selected original approval message stable while later comments are appended", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const delivery = createAgentNode("delivery", "Delivery");
    delivery.config = {
      ...delivery.config,
      approval: {
        enabled: true
      }
    };
    const blueprint = createBlueprint([delivery], []);
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-1"),
      createStartedAgentTask("task-2")
    ], [
      createCompletedAgentTask("task-1", "succeeded", "original plan"),
      createCompletedAgentTask("task-2", "succeeded", "revised plan")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const waitingView = await waitForRunStatus(store, run.id, "waiting_approval");
    const waitingNode = waitingView.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery")!;

    await worker.selectApprovalReply(blueprint, waitingView.run, waitingNode.id, "reviewOutput");
    const selectedView = await waitForRunStatus(store, run.id, "waiting_approval");
    const selectedNode = selectedView.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery")!;

    await worker.replyToApproval(blueprint, selectedView.run, selectedNode.id, "Show another option.");
    const repliedView = await waitForRunStatus(store, run.id, "waiting_approval");
    const repliedNode = repliedView.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery")!;
    const repliedOutput = repliedNode.output as { reviewOutput: string; selectedReplyId: string; selectedOutput: string };

    expect(repliedOutput.reviewOutput).toBe("original plan");
    expect(repliedOutput.selectedReplyId).toBe("reviewOutput");
    expect(repliedOutput.selectedOutput).toBe("original plan");
    expect(adapter.calls).toHaveLength(1);

    await worker.approveRun(blueprint, repliedView.run, repliedNode.id);
    const finalView = await waitForRunTerminal(store, run.id);
    const finalNode = finalView?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery");

    expect(finalView?.run.status).toBe("succeeded");
    expect(finalNode?.output).toMatchObject({
      approvedOutput: "original plan",
      approval: {
        status: "approved",
        selectedReplyId: "reviewOutput"
      }
    });
  });

  it("does not rerun or fail the run when an Agent approval comment is added", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const delivery = createAgentNode("delivery", "Delivery");
    delivery.config = {
      ...delivery.config,
      approval: {
        enabled: true
      }
    };
    const blueprint = createBlueprint([delivery], []);
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-1"),
      createStartedAgentTask("task-2")
    ], [
      createCompletedAgentTask("task-1", "succeeded", "draft answer"),
      createCompletedAgentTask("task-2", "failed", undefined, "revision failed")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const waitingView = await waitForRunStatus(store, run.id, "waiting_approval");
    const waitingNode = waitingView.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery")!;

    await worker.replyToApproval(blueprint, waitingView.run, waitingNode.id, "Try again.");
    const replyView = await waitForRunStatus(store, run.id, "waiting_approval");
    const waitingAfterReply = replyView.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery");

    expect(replyView.run.status).toBe("waiting_approval");
    expect(waitingAfterReply?.status).toBe("waiting_approval");
    expect(waitingAfterReply?.error).toBeUndefined();
    expect(adapter.calls).toHaveLength(1);
  });

  it("runs downstream nodes connected to a manager slot forward output", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const slotAgent = createAgentNode("slot-agent", "Slot Agent", { x: 520, y: 180 });
    slotAgent.parentId = "slot-1";
    const followUp = createAgentNode("follow-up", "Follow Up", { x: 980, y: 180 });
    const blueprint = createBlueprint(
      [
        {
          id: "manager",
          type: "manager",
          position: { x: 80, y: 180 },
          config: {
            label: "Manager",
            portCount: 1,
            maxHandoffs: 1
          }
        },
        {
          id: "slot-1",
          type: "manager_slot",
          position: { x: 420, y: 120 },
          config: {
            label: "Slot 1",
            managerNodeId: "manager",
            slot: 1
          }
        },
        slotAgent,
        followUp
      ],
      [
        { id: "manager-slot", source: "manager", sourceHandle: "manager-out-1", target: "slot-1", targetHandle: "manager-slot-in" },
        { id: "slot-manager", source: "slot-1", sourceHandle: "manager-slot-out", target: "manager", targetHandle: "manager-in-1" },
        { id: "slot-agent", source: "slot-1", sourceHandle: "manager-slot-inner-out", target: "slot-agent" },
        { id: "agent-slot", source: "slot-agent", target: "slot-1", targetHandle: "manager-slot-inner-in" },
        { id: "slot-follow-up", source: "slot-1", sourceHandle: "manager-slot-forward-out", target: "follow-up" }
      ]
    );
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-slot-agent"),
      createStartedAgentTask("task-follow-up")
    ], [
      createCompletedAgentTask("task-slot-agent", "succeeded", "slot output"),
      createCompletedAgentTask("task-follow-up", "succeeded", "follow-up output")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);
    const slotRun = view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "slot-1");
    const followUpRun = view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "follow-up");

    expect(view?.run.status).toBe("succeeded");
    expect(slotRun).toMatchObject({
      status: "succeeded",
      output: "slot output"
    });
    expect(followUpRun).toMatchObject({
      status: "succeeded",
      output: "follow-up output",
      input: {
        upstream: [
          expect.objectContaining({
            nodeId: "slot-1",
            humanReportMd: "slot output"
          })
        ]
      }
    });
    expect((followUpRun?.input as { upstream?: Array<Record<string, unknown>> } | undefined)?.upstream?.[0]).not.toHaveProperty("output");
    expect(adapter.calls.map((call) => call.agentName)).toEqual(["slot-agent", "follow-up"]);
  });

  it("keeps platform-owned fields authoritative when agent output contains matching names", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const storePath = path.join(tempDir, "hiveward-store.json");
    const store = new FileHivewardStore(storePath);
    await store.init();

    const blueprint = createBlueprint([createAgentNode("brief", "Brief")], []);
    const agentOutput = JSON.stringify({
      status: "failed",
      nodeRunId: "agent-node-run",
      taskId: "agent-task",
      runId: "agent-run",
      sessionKey: "agent-session",
      inputTokens: 999,
      outputTokens: 999,
      error: "agent-claimed-error",
      source: "agent-source",
      nextNode: "agent-next",
      slotIndex: 42,
      resultRole: "ignore",
      artifactId: "agent-artifact",
      answer: "semantic content"
    });
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-1")
    ], [
      {
        ...createCompletedAgentTask("task-1", "succeeded", agentOutput),
        usage: createUsageFact(7, 11, 0.012345)
      }
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);
    const nodeRun = view?.nodeRuns.find((candidate) => candidate.nodeId === "brief");
    const index = JSON.parse(readFileSync(storePath, "utf8")) as {
      runIndex?: Array<{ id: string; totalInputTokens: number; totalOutputTokens: number; totalCostUsd: number }>;
    };

    expect(nodeRun).toMatchObject({
      status: "succeeded",
      output: agentOutput,
      usage: {
        inputTokens: 7,
        outputTokens: 11,
        costUsd: 0.012345
      },
      runtimeRef: {
        taskId: "task-1",
        runId: "task-1-run",
        sessionKey: "agent:main:main",
        source: "openclaw"
      }
    });
    expect(nodeRun?.error).toBeUndefined();
    expect(view?.run).toMatchObject({
      id: run.id,
      status: "succeeded",
      totalInputTokens: 7,
      totalOutputTokens: 11,
      totalCostUsd: 0.012345
    });
    expect(view?.finalResult?.candidates[0]).toMatchObject({
      nodeId: "brief",
      resultRole: "auto",
      output: agentOutput
    });
    expect(index.runIndex?.find((candidate) => candidate.id === run.id)).toMatchObject({
      totalInputTokens: 7,
      totalOutputTokens: 11,
      totalCostUsd: 0.012345
    });
  });

  it("skips the branch that does not match a condition result", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createBlueprint(
      [
        createAgentNode("brief", "Brief"),
        {
          id: "gate",
          type: "condition",
          position: { x: 360, y: 180 },
          config: {
            label: "Gate",
            expression: "true"
          }
        },
        createAgentNode("yes", "Yes branch"),
        createAgentNode("no", "No branch")
      ],
      [
        { id: "edge-1", source: "brief", target: "gate", condition: "success" },
        { id: "edge-2", source: "gate", target: "yes", condition: "true" },
        { id: "edge-3", source: "gate", target: "no", condition: "false" }
      ]
    );
    const worker = new BlueprintWorker(
      store,
      new ScriptedAdapter([
        createStartedAgentTask("task-1"),
        createStartedAgentTask("task-2")
      ], [
        createCompletedAgentTask("task-1", "succeeded", "brief ready"),
        createCompletedAgentTask("task-2", "succeeded", "yes path")
      ])
    );

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);

    expect(run.status).toBe("running");
    expect(view?.run.status).toBe("succeeded");
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "gate")?.input).toMatchObject({
      upstream: [expect.objectContaining({ nodeId: "brief", nodeLabel: "Brief", status: "succeeded", humanReportMd: "brief ready" })]
    });
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "gate")?.output).toEqual({ result: true });
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "yes")?.status).toBe("succeeded");
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "no")?.status).toBe("skipped");
  });

  it("runs sibling agent branches in parallel after a shared upstream node succeeds", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createBlueprint(
      [
        createAgentNode("brief", "Brief"),
        createAgentNode("alpha", "Alpha", { x: 460, y: 120 }),
        createAgentNode("beta", "Beta", { x: 460, y: 260 })
      ],
      [
        { id: "edge-1", source: "brief", target: "alpha", condition: "success" },
        { id: "edge-2", source: "brief", target: "beta", condition: "success" }
      ]
    );
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-1"),
      createStartedAgentTask("task-2"),
      createStartedAgentTask("task-3")
    ], [
      createCompletedAgentTask("task-1", "succeeded", "brief ready"),
      createCompletedAgentTask("task-2", "succeeded", "alpha ready"),
      createCompletedAgentTask("task-3", "succeeded", "beta ready")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);

    expect(run.status).toBe("running");
    expect(view?.run.status).toBe("succeeded");
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "alpha")?.status).toBe("succeeded");
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "beta")?.status).toBe("succeeded");
    expect(adapter.calls.slice(1).every((call) => Array.isArray((call.input as { upstream?: unknown[] }).upstream))).toBe(true);
    expect((adapter.calls[1]?.input as { upstream?: Array<{ humanReportMd?: string }> }).upstream?.[0]?.humanReportMd).toBe("brief ready");
    expect((adapter.calls[2]?.input as { upstream?: Array<{ humanReportMd?: string }> }).upstream?.[0]?.humanReportMd).toBe("brief ready");
  });

  it("approves the requested Agent approval when multiple approvals are waiting", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();
    const worker = new BlueprintWorker(
      store,
      new ScriptedAdapter([
        createStartedAgentTask("task-approval-a"),
        createStartedAgentTask("task-approval-b")
      ], [
        createCompletedAgentTask("task-approval-a", "succeeded", "A ready"),
        createCompletedAgentTask("task-approval-b", "succeeded", "B ready")
      ])
    );
    const approvalA = createAgentNode("approval-a", "Approval A");
    approvalA.config = {
      ...approvalA.config,
      approval: { enabled: true }
    };
    const approvalB = createAgentNode("approval-b", "Approval B", { x: 260, y: 0 });
    approvalB.config = {
      ...approvalB.config,
      approval: { enabled: true }
    };
    const blueprint = createBlueprint(
      [approvalA, approvalB],
      []
    );

    const run = await worker.startRun(blueprint, "test-user");
    const firstApproval = await waitForNodeRun(store, run.id, "approval-a", (nodeRun) => nodeRun.status === "waiting_approval");
    const secondApproval = await waitForNodeRun(store, run.id, "approval-b", (nodeRun) => nodeRun.status === "waiting_approval");
    const waitingRun = await waitForRunStatus(store, run.id, "waiting_approval");
    const secondApprovalExpectedOutput = secondApproval.runtimeRef?.sourceId === "task-approval-a" ? "A ready" : "B ready";

    await worker.approveRun(blueprint, waitingRun.run, secondApproval.id);
    await waitForNodeRun(store, run.id, "approval-b", (nodeRun) => nodeRun.status === "succeeded");
    const latestView = await waitForRunStatus(store, run.id, "waiting_approval");

    expect(latestView.nodeRuns.find((nodeRun) => nodeRun.id === firstApproval.id)?.status).toBe("waiting_approval");
    expect(latestView.nodeRuns.find((nodeRun) => nodeRun.id === secondApproval.id)?.status).toBe("succeeded");
    expect(["task-approval-a", "task-approval-b"]).toContain(secondApproval.runtimeRef?.sourceId);
    expect(latestView.nodeRuns.find((nodeRun) => nodeRun.id === secondApproval.id)?.output).toBe(secondApprovalExpectedOutput);
  });

  it("passes SDK node configuration to the adapter and persists provider refs", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createBlueprint(
      [
        {
          ...createAgentNode("sdk-node", "SDK Node"),
          runtimeId: "codex",
          config: {
            label: "SDK Node",
            agentName: "codex-runner",
            prompt: "Return JSON.",
            skillIds: ["hiveward-leader"],
            modelId: "gpt-5.4",
            permissionProfile: "read_only",
            workingDirectory: tempDir,
            timeoutMs: 120000,
            outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
            tools: []
          }
        }
      ],
      []
    );
    const adapter = new ScriptedAdapter([
      {
        ...createStartedAgentTask("codex-task-1"),
        source: "codex",
        sessionKey: "codex-session-start"
      }
    ], [
      {
        ...createCompletedAgentTask("codex-task-1", "succeeded", {
          humanReportMd: "## SDK node report\n\n## Delivery location\n\n- No new deliverable produced in this step.",
          result: { ok: true }
        }),
        source: "codex",
        sessionKey: "codex-session-final"
      }
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);

    expect(adapter.calls[0]).toMatchObject({
      source: "codex",
      agentName: "codex-runner",
      skillIds: ["hiveward-leader"],
      modelId: "gpt-5.4",
      permissionProfile: "read_only",
      workingDirectory: tempDir,
      timeoutMs: 120000,
      outputSchema: {
        type: "object",
        required: ["humanReportMd", "result"],
        properties: {
          humanReportMd: { type: "string" },
          handoffJson: { type: ["object", "null"] },
          result: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }
        }
      }
    });
    expect(adapter.waitCalls[0]).toMatchObject({
      source: "codex",
      sessionKey: "codex-session-start"
    });
    expect(view?.nodeRuns[0]?.runtimeRef).toMatchObject({
      source: "codex",
      sourceId: "codex-task-1",
      sessionKey: "codex-session-final"
    });
    expect(view?.run.runtimeRefs[0]?.source).toBe("codex");
  });

  it("lets a manager node route numbered slots and return to an earlier agent slot", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createBlueprint(
      [
        {
          id: "manager",
          type: "manager",
          runtimeId: "openclaw",
          position: { x: 80, y: 180 },
          config: {
            label: "Manager",
            dispatchMode: "self_dispatch",
            portCount: 3,
            maxHandoffs: 8,
            instructions: "Route product, developer, and test slots."
          }
        },
        createAgentNode("product", "Product", { x: 420, y: 80 }),
        createAgentNode("dev", "Dev", { x: 420, y: 220 }),
        createAgentNode("test", "Test", { x: 420, y: 360 })
      ],
      [
        { id: "m-product", source: "manager", sourceHandle: "manager-out-1", target: "product", condition: "success" },
        { id: "product-m", source: "product", target: "manager", targetHandle: "manager-in-1", condition: "success" },
        { id: "m-dev", source: "manager", sourceHandle: "manager-out-2", target: "dev", condition: "success" },
        { id: "dev-m", source: "dev", target: "manager", targetHandle: "manager-in-2", condition: "success" },
        { id: "m-test", source: "manager", sourceHandle: "manager-out-3", target: "test", condition: "success" },
        { id: "test-m", source: "test", target: "manager", targetHandle: "manager-in-3", condition: "success" }
      ]
    );
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-manager-1"),
      createStartedAgentTask("task-product"),
      createStartedAgentTask("task-manager-2"),
      createStartedAgentTask("task-dev-1"),
      createStartedAgentTask("task-manager-3"),
      createStartedAgentTask("task-test-1"),
      createStartedAgentTask("task-manager-4"),
      createStartedAgentTask("task-dev-2"),
      createStartedAgentTask("task-manager-5"),
      createStartedAgentTask("task-test-2"),
      createStartedAgentTask("task-manager-6")
    ], [
      createCompletedAgentTask("task-manager-1", "succeeded", JSON.stringify({ status: "continue", roundNumber: 1, nextSlot: 1, reason: "start with product requirements" })),
      createCompletedAgentTask("task-product", "succeeded", "prd ready"),
      createCompletedAgentTask("task-manager-2", "succeeded", JSON.stringify({ status: "continue", roundNumber: 1, nextSlot: 2, reason: "build the draft from the product receipt" })),
      createCompletedAgentTask("task-dev-1", "succeeded", "app draft"),
      createCompletedAgentTask("task-manager-3", "succeeded", JSON.stringify({ status: "continue", roundNumber: 1, nextSlot: 3, reason: "send the draft to QA" })),
      createCompletedAgentTask("task-test-1", "succeeded", JSON.stringify({ status: "fail", returnToSlot: 2, reason: "missing loading state" })),
      createCompletedAgentTask("task-manager-4", "succeeded", JSON.stringify({ status: "continue", roundNumber: 1, nextSlot: 2, reason: "QA receipt asks for a loading-state fix" })),
      createCompletedAgentTask("task-dev-2", "succeeded", "app fixed"),
      createCompletedAgentTask("task-manager-5", "succeeded", JSON.stringify({ status: "continue", roundNumber: 1, nextSlot: 3, reason: "retest the fixed build" })),
      createCompletedAgentTask("task-test-2", "succeeded", {
        humanReportMd: "## QA report\n\n## Delivery location\n\n- No new deliverable produced in this step.",
        result: { status: "pass" }
      }),
      createCompletedAgentTask("task-manager-6", "succeeded", JSON.stringify({ status: "complete", roundNumber: 1, reason: "QA passed after the fix" }))
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);

    expect(view?.run.status).toBe("succeeded");
    expect(view?.nodeRuns.filter((nodeRun) => nodeRun.nodeId === "dev" && nodeRun.status === "succeeded")).toHaveLength(2);
    expect(view?.nodeRuns.filter((nodeRun) => nodeRun.nodeId === "test" && nodeRun.status === "succeeded")).toHaveLength(2);
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "manager")?.status).toBe("succeeded");
    expect(adapter.calls.map((call) => call.agentName)).toEqual([
      "manager",
      "product",
      "manager",
      "dev",
      "manager",
      "test",
      "manager",
      "dev",
      "manager",
      "test",
      "manager"
    ]);
  });

  it("rejects manager decisions that jump beyond the current or next round", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createBlueprint(
      [
        {
          id: "manager",
          type: "manager",
          runtimeId: "openclaw",
          position: { x: 80, y: 180 },
          config: {
            label: "Manager",
            dispatchMode: "self_dispatch",
            portCount: 1,
            maxHandoffs: 3
          }
        },
        createAgentNode("worker", "Worker", { x: 420, y: 180 })
      ],
      [
        { id: "manager-worker", source: "manager", sourceHandle: "manager-out-1", target: "worker", condition: "success" },
        { id: "worker-manager", source: "worker", target: "manager", targetHandle: "manager-in-1", condition: "success" }
      ]
    );
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-manager"),
      createStartedAgentTask("task-worker"),
      createStartedAgentTask("task-manager-complete")
    ], [
      createCompletedAgentTask("task-manager", "succeeded", JSON.stringify({
        status: "continue",
        roundNumber: 5,
        nextSlot: 1,
        reason: "jump ahead"
      })),
      createCompletedAgentTask("task-worker", "succeeded", "worker output"),
      createCompletedAgentTask("task-manager-complete", "succeeded", JSON.stringify({
        status: "complete",
        roundNumber: 5,
        reason: "done"
      }))
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);
    const managerRun = view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "manager");

    expect(view?.run.status).toBe("failed");
    expect(managerRun?.status).toBe("failed");
    expect(managerRun?.error).toContain("roundNumber");
    expect(managerRun?.error).toContain("must equal current round 1");
    expect(view?.nodeRuns.some((nodeRun) => nodeRun.nodeId === "worker")).toBe(false);
  });

  it("lets a manager route work to a nested manager", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createBlueprint(
      [
        {
          id: "parent-manager",
          type: "manager",
          position: { x: 80, y: 180 },
          config: {
            label: "Parent Manager",
            portCount: 2,
            maxHandoffs: 3,
            instructions: "Delegate to the child manager, then run the parent slot."
          }
        },
        {
          id: "child-manager",
          type: "manager",
          position: { x: 420, y: 180 },
          config: {
            label: "Child Manager",
            portCount: 1,
            maxHandoffs: 3,
            instructions: "Run the implementation slot."
          }
        },
        createAgentNode("implementation", "Implementation", { x: 760, y: 180 }),
        {
          id: "parent-slot-2",
          type: "manager_slot",
          position: { x: 420, y: 420 },
          config: {
            label: "Slot 2",
            managerNodeId: "parent-manager",
            slot: 2
          }
        },
        {
          ...createAgentNode("parent-followup", "Parent Followup", { x: 120, y: 100 }),
          parentId: "parent-slot-2"
        }
      ],
      [
        { id: "parent-child", source: "parent-manager", sourceHandle: "manager-out-1", target: "child-manager", condition: "success" },
        { id: "child-parent", source: "child-manager", target: "parent-manager", targetHandle: "manager-in-1", condition: "success" },
        { id: "child-implementation", source: "child-manager", sourceHandle: "manager-out-1", target: "implementation", condition: "success" },
        { id: "implementation-child", source: "implementation", target: "child-manager", targetHandle: "manager-in-1", condition: "success" },
        { id: "parent-slot-2-out", source: "parent-manager", sourceHandle: "manager-out-2", target: "parent-slot-2", targetHandle: "manager-slot-in", condition: "success" },
        { id: "parent-slot-2-in", source: "parent-slot-2", sourceHandle: "manager-slot-out", target: "parent-manager", targetHandle: "manager-in-2", condition: "success" },
        { id: "parent-slot-2-start", source: "parent-slot-2", sourceHandle: "manager-slot-inner-out", target: "parent-followup", condition: "success" },
        { id: "parent-slot-2-finish", source: "parent-followup", target: "parent-slot-2", targetHandle: "manager-slot-inner-in", condition: "success" }
      ]
    );
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-1"),
      createStartedAgentTask("task-2")
    ], [
      createCompletedAgentTask("task-1", "succeeded", JSON.stringify({ status: "complete", result: "implemented" })),
      createCompletedAgentTask("task-2", "succeeded", JSON.stringify({ status: "complete", result: "parent followup complete" }))
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);

    expect(view?.run.status).toBe("succeeded");
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "parent-manager")?.status).toBe("succeeded");
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "child-manager")?.status).toBe("succeeded");
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "implementation")?.status).toBe("succeeded");
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "parent-slot-2")?.status).toBe("succeeded");
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "parent-followup")?.status).toBe("succeeded");
    expect(adapter.calls.map((call) => call.agentName)).toEqual(["implementation", "parent-followup"]);
    expect((adapter.calls[0]?.input as { upstream?: Array<{ nodeId: string }> }).upstream?.[0]?.nodeId).toBe("parent-manager");
    expect((adapter.calls[1]?.input as { upstream?: Array<{ nodeId: string }> }).upstream?.[0]?.nodeId).toBe("parent-slot-2");
  });

  it("executes a manager slot box as a nested blueprint and returns its output to the manager", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createBlueprint(
      [
        {
          id: "manager",
          type: "manager",
          position: { x: 80, y: 180 },
          config: {
            label: "Manager",
            portCount: 1,
            maxHandoffs: 3,
            instructions: "Run the slot blueprint."
          }
        },
        {
          id: "manager-slot-1",
          type: "manager_slot",
          position: { x: 420, y: 120 },
          config: {
            label: "Slot 1",
            managerNodeId: "manager",
            slot: 99
          }
        },
        {
          ...createAgentNode("slot-agent", "Slot Agent", { x: 120, y: 100 }),
          parentId: "manager-slot-1"
        }
      ],
      [
        { id: "manager-slot-out", source: "manager", sourceHandle: "manager-out-1", target: "manager-slot-1", targetHandle: "manager-slot-in", condition: "success" },
        { id: "slot-manager-in", source: "manager-slot-1", sourceHandle: "manager-slot-out", target: "manager", targetHandle: "manager-in-1", condition: "success" },
        { id: "slot-start", source: "manager-slot-1", sourceHandle: "manager-slot-inner-out", target: "slot-agent", condition: "success" },
        { id: "slot-finish", source: "slot-agent", target: "manager-slot-1", targetHandle: "manager-slot-inner-in", condition: "success" }
      ]
    );
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-1")
    ], [
      createCompletedAgentTask("task-1", "succeeded", JSON.stringify({ status: "complete", result: "slot done" }))
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);

    expect(view?.run.status).toBe("succeeded");
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "manager-slot-1")?.status).toBe("succeeded");
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "slot-agent")?.status).toBe("succeeded");
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "manager")?.output).toMatchObject({
      status: "completed"
    });
    expect(adapter.calls[0]?.agentName).toBe("slot-agent");
    expect((adapter.calls[0]?.input as { upstream?: Array<{ nodeId: string }> }).upstream?.[0]?.nodeId).toBe("manager-slot-1");
    expect(
      (
        (adapter.calls[0]?.input as { upstream?: Array<{ context?: { manager?: { slot?: number } } }> }).upstream?.[0]?.context
      )?.manager?.slot
    ).toBe(1);
  });

  it("fails a manager run without leaving manager slot children running", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createBlueprint(
      [
        {
          id: "manager",
          type: "manager",
          position: { x: 80, y: 180 },
          config: {
            label: "Manager",
            portCount: 1,
            maxHandoffs: 3,
            instructions: "Run the slot blueprint."
          }
        },
        {
          id: "manager-slot-1",
          type: "manager_slot",
          position: { x: 420, y: 120 },
          config: {
            label: "Slot 1",
            managerNodeId: "manager",
            slot: 1
          }
        },
        {
          ...createAgentNode("slot-agent", "Slot Agent", { x: 120, y: 100 }),
          parentId: "manager-slot-1"
        }
      ],
      [
        { id: "manager-slot-out", source: "manager", sourceHandle: "manager-out-1", target: "manager-slot-1", targetHandle: "manager-slot-in", condition: "success" },
        { id: "slot-manager-in", source: "manager-slot-1", sourceHandle: "manager-slot-out", target: "manager", targetHandle: "manager-in-1", condition: "success" },
        { id: "slot-start", source: "manager-slot-1", sourceHandle: "manager-slot-inner-out", target: "slot-agent", condition: "success" },
        { id: "slot-finish", source: "slot-agent", target: "manager-slot-1", targetHandle: "manager-slot-inner-in", condition: "success" }
      ]
    );
    const worker = new BlueprintWorker(
      store,
      new ScriptedAdapter([
        createStartedAgentTask("task-1")
      ], [
        new Error("protocol mismatch")
      ])
    );

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);

    expect(view?.run.status).toBe("failed");
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "manager")).toMatchObject({
      status: "failed",
      error: "protocol mismatch"
    });
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "manager-slot-1")?.status).toBe("cancelled");
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "slot-agent")?.status).toBe("cancelled");
    expect(view?.nodeRuns.some((nodeRun) => nodeRun.status === "running" || nodeRun.status === "queued")).toBe(false);
    expect(view?.finalResult?.failedNode?.nodeId).toBe("manager");
  });

  it("runs all child nodes in a parallel manager slot from one manager handoff", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createBlueprint(
      [
        {
          id: "manager",
          type: "manager",
          position: { x: 80, y: 180 },
          config: {
            label: "Manager",
            portCount: 1,
            maxHandoffs: 3,
            instructions: "Run the parallel slot."
          }
        },
        {
          id: "parallel-slot",
          type: "manager_slot",
          position: { x: 420, y: 120 },
          config: {
            label: "Parallel Slot",
            managerNodeId: "manager",
            slot: 1,
            executionMode: "parallel",
            parallelLaneCount: 2
          }
        },
        {
          ...createAgentNode("alpha", "Alpha", { x: 120, y: 100 }),
          parentId: "parallel-slot"
        },
        {
          ...createAgentNode("beta", "Beta", { x: 120, y: 240 }),
          parentId: "parallel-slot"
        }
      ],
      [
        { id: "manager-slot-out", source: "manager", sourceHandle: "manager-out-1", target: "parallel-slot", targetHandle: "manager-slot-in", condition: "success" },
        { id: "slot-manager-in", source: "parallel-slot", sourceHandle: "manager-slot-out", target: "manager", targetHandle: "manager-in-1", condition: "success" }
      ]
    );
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-1"),
      createStartedAgentTask("task-2")
    ], [
      createCompletedAgentTask("task-1", "succeeded", "done"),
      createCompletedAgentTask("task-2", "succeeded", "done")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);
    const slotOutput = view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "parallel-slot")?.output;

    expect(view?.run.status).toBe("succeeded");
    expect(adapter.calls.map((call) => call.agentName).sort()).toEqual(["alpha", "beta"]);
    expect(adapter.calls.every((call) => (call.input as { upstream?: Array<{ nodeId: string }> }).upstream?.[0]?.nodeId === "parallel-slot")).toBe(true);
    expect(typeof slotOutput).toBe("string");
    const parsedSlotOutput = JSON.parse(String(slotOutput)) as { outputs?: unknown[] };
    expect(parsedSlotOutput.outputs).toHaveLength(2);
    expect(parsedSlotOutput.outputs).toEqual(expect.arrayContaining([
      { nodeId: "alpha", nodeLabel: "Alpha", output: "done" },
      { nodeId: "beta", nodeLabel: "Beta", output: "done" }
    ]));
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "manager")?.output).toMatchObject({
      status: "completed"
    });
  });

  it("runs a one-lane manager slot as a single scoped chain", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createBlueprint(
      [
        {
          id: "manager",
          type: "manager",
          position: { x: 80, y: 180 },
          config: {
            label: "Manager",
            portCount: 1,
            maxHandoffs: 3,
            instructions: "Run the single slot."
          }
        },
        {
          id: "single-slot",
          type: "manager_slot",
          position: { x: 420, y: 120 },
          config: {
            label: "Single Slot",
            managerNodeId: "manager",
            slot: 1,
            executionMode: "parallel",
            parallelLaneCount: 1
          }
        },
        {
          ...createAgentNode("alpha", "Alpha", { x: 120, y: 100 }),
          parentId: "single-slot"
        },
        {
          ...createAgentNode("beta", "Beta", { x: 360, y: 100 }),
          parentId: "single-slot"
        }
      ],
      [
        { id: "manager-slot-out", source: "manager", sourceHandle: "manager-out-1", target: "single-slot", targetHandle: "manager-slot-in", condition: "success" },
        { id: "slot-manager-in", source: "single-slot", sourceHandle: "manager-slot-out", target: "manager", targetHandle: "manager-in-1", condition: "success" },
        { id: "slot-alpha", source: "single-slot", sourceHandle: "manager-slot-inner-out", target: "alpha", condition: "success" },
        { id: "alpha-beta", source: "alpha", target: "beta", condition: "success" },
        { id: "beta-slot", source: "beta", target: "single-slot", targetHandle: "manager-slot-inner-in", condition: "success" }
      ]
    );
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-alpha"),
      createStartedAgentTask("task-beta")
    ], [
      createCompletedAgentTask("task-alpha", "succeeded", "alpha done"),
      createCompletedAgentTask("task-beta", "succeeded", "beta done")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);
    const slotOutput = view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "single-slot")?.output;

    expect(view?.run.status).toBe("succeeded");
    expect(adapter.calls.map((call) => call.agentName)).toEqual(["alpha", "beta"]);
    expect((adapter.calls[0]?.input as { upstream?: Array<{ nodeId: string }> }).upstream?.[0]?.nodeId).toBe("single-slot");
    expect((adapter.calls[1]?.input as { upstream?: Array<{ nodeId: string; humanReportMd?: string }> }).upstream?.[0]).toMatchObject({
      nodeId: "alpha",
      humanReportMd: "alpha done"
    });
    expect(slotOutput).toBe("beta done");
  });

  it("runs an agent-driven manager with the default sequential prompt when instructions are empty", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createBlueprint(
      [
        {
          id: "manager",
          type: "manager",
          runtimeId: "openclaw",
          position: { x: 80, y: 180 },
          config: {
            label: "Manager",
            dispatchMode: "self_dispatch",
            portCount: 1,
            maxHandoffs: 3
          }
        },
        createAgentNode("implementer", "Implementer", { x: 420, y: 180 })
      ],
      [
        { id: "manager-implementer", source: "manager", sourceHandle: "manager-out-1", target: "implementer", condition: "success" },
        { id: "implementer-manager", source: "implementer", target: "manager", targetHandle: "manager-in-1", condition: "success" }
      ]
    );
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-manager"),
      createStartedAgentTask("task-implementer"),
      createStartedAgentTask("task-manager-complete")
    ], [
      createCompletedAgentTask("task-manager", "succeeded", JSON.stringify({ status: "continue", roundNumber: 1, nextSlot: 1, reason: "use the obvious first slot" })),
      createCompletedAgentTask("task-implementer", "succeeded", "implementation done"),
      createCompletedAgentTask("task-manager-complete", "succeeded", JSON.stringify({ status: "complete", roundNumber: 1, reason: "single slot done" }))
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);

    expect(view?.run.status).toBe("succeeded");
    expect(adapter.calls.map((call) => call.agentName)).toEqual(["manager", "implementer", "manager"]);
    expect(adapter.calls[0]?.prompt).toContain("You are a Hiveward manager agent.");
    expect((adapter.calls[0]?.input as { delegationRoster?: { slots?: unknown[] } }).delegationRoster?.slots).toHaveLength(1);
  });

  it("runs sequential manager slots in port order without treating slot output as a routing decision", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createBlueprint(
      [
        {
          id: "manager",
          type: "manager",
          runtimeId: "openclaw",
          position: { x: 80, y: 180 },
          config: {
            label: "Manager",
            dispatchMode: "sequential",
            portCount: 2,
            maxHandoffs: 4,
            instructions: "Run both connected slots in order."
          }
        },
        createAgentNode("first", "First", { x: 420, y: 120 }),
        createAgentNode("second", "Second", { x: 420, y: 280 })
      ],
      [
        { id: "manager-first", source: "manager", sourceHandle: "manager-out-1", target: "first", condition: "success" },
        { id: "first-manager", source: "first", target: "manager", targetHandle: "manager-in-1", condition: "success" },
        { id: "manager-second", source: "manager", sourceHandle: "manager-out-2", target: "second", condition: "success" },
        { id: "second-manager", source: "second", target: "manager", targetHandle: "manager-in-2", condition: "success" }
      ]
    );
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-first"),
      createStartedAgentTask("task-second")
    ], [
      createCompletedAgentTask("task-first", "succeeded", JSON.stringify({ status: "complete", reason: "first slot is done" })),
      createCompletedAgentTask("task-second", "succeeded", "second slot receipt")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);
    const managerOutput = view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "manager")?.output;

    expect(view?.run.status).toBe("succeeded");
    expect(adapter.calls.map((call) => call.agentName)).toEqual(["first", "second"]);
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "first")?.status).toBe("succeeded");
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "second")?.status).toBe("succeeded");
    expect(managerOutput).toMatchObject({
      status: "completed",
      reason: "manager_reached_final_connected_slot"
    });
  });

  it("passes structured slot receipts to an agent-driven manager before the next dispatch decision", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createBlueprint(
      [
        {
          id: "manager",
          type: "manager",
          runtimeId: "openclaw",
          position: { x: 80, y: 180 },
          config: {
            label: "Manager",
            dispatchMode: "self_dispatch",
            portCount: 1,
            maxHandoffs: 3,
            instructions: "Dispatch the worker, then complete after reading the receipt."
          }
        },
        createAgentNode("worker", "Worker", { x: 420, y: 180 })
      ],
      [
        { id: "manager-worker", source: "manager", sourceHandle: "manager-out-1", target: "worker", condition: "success" },
        { id: "worker-manager", source: "worker", target: "manager", targetHandle: "manager-in-1", condition: "success" }
      ]
    );
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-manager-1"),
      createStartedAgentTask("task-worker"),
      createStartedAgentTask("task-manager-2")
    ], [
      createCompletedAgentTask("task-manager-1", "succeeded", {
        humanReportMd: "## Dispatch\n\n## Delivery location\n\nNo new deliverable produced in this step.",
        result: { status: "continue", roundNumber: 1, nextSlot: 1, reason: "Need the worker receipt first." }
      }),
      createCompletedAgentTask("task-worker", "succeeded", {
        humanReportMd: "## Worker report\n\n## Delivery location\n\nNo new deliverable produced in this step.",
        handoffJson: { summary: "worker finished", next: "manager" },
        result: { status: "complete", summary: "worker output should not be the only receipt" }
      }),
      createCompletedAgentTask("task-manager-2", "succeeded", {
        humanReportMd: "## Complete\n\n## Delivery location\n\nNo new deliverable produced in this step.",
        result: { status: "complete", roundNumber: 1, reason: "Worker receipt is present." }
      })
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);
    const secondManagerInput = adapter.calls.find((call) => call.nodeRunId.includes("manager-decision-2"))?.input;
    const previousResults = isRecord(secondManagerInput) && Array.isArray(secondManagerInput.previousResults)
      ? secondManagerInput.previousResults
      : [];

    expect(view?.run.status).toBe("succeeded");
    expect(previousResults).toHaveLength(1);
    expect(previousResults[0]).not.toHaveProperty("output");
    expect(previousResults[0]).toMatchObject({
      nodeId: "worker",
      status: "succeeded",
      receipt: {
        valid: true,
        roleContexts: [expect.objectContaining({
          nodeId: "worker",
          nodeLabel: "Worker",
          type: "agent",
          systemPrompt: "Run worker"
        })],
        humanReportMd: expect.stringContaining("Worker report"),
        handoffJson: { summary: "worker finished", next: "manager" }
      }
    });
  });

  it("resumes an interrupted manager-slot run from the persisted OpenClaw task ref", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createBlueprint(
      [
        {
          id: "manager",
          type: "manager",
          position: { x: 120, y: 120 },
          config: {
            label: "Manager",
            portCount: 1,
            maxHandoffs: 3,
            instructions: "Run the slot."
          }
        },
        {
          id: "slot-1",
          type: "manager_slot",
          position: { x: 420, y: 120 },
          config: {
            label: "Slot 1",
            managerNodeId: "manager",
            slot: 1
          }
        },
        {
          ...createAgentNode("builder", "Builder", { x: 120, y: 100 }),
          parentId: "slot-1"
        }
      ],
      [
        { id: "manager-slot", source: "manager", sourceHandle: "manager-out-1", target: "slot-1", targetHandle: "manager-slot-in", condition: "success" },
        { id: "slot-manager", source: "slot-1", sourceHandle: "manager-slot-out", target: "manager", targetHandle: "manager-in-1", condition: "success" },
        { id: "slot-start", source: "slot-1", sourceHandle: "manager-slot-inner-out", target: "builder", condition: "success" },
        { id: "slot-finish", source: "builder", target: "slot-1", targetHandle: "manager-slot-inner-in", condition: "success" }
      ]
    );
    const blockedAdapter = new BlockingAdapter(createStartedAgentTask("task-1"));
    const firstWorker = new BlueprintWorker(store, blockedAdapter, { nodeRunLeaseMs: 100 });

    const run = await firstWorker.startRun(blueprint, "test-user");
    await waitForNodeRun(store, run.id, "builder", (nodeRun) =>
      nodeRun.status === "running" && nodeRun.runtimeRef?.taskId === "task-1"
    );
    await new Promise((resolve) => setTimeout(resolve, 150));

    const recoveryAdapter = new ScriptedAdapter([], [
      createCompletedAgentTask("task-1", "succeeded", "built html")
    ]);
    const recoveryWorker = new BlueprintWorker(store, recoveryAdapter);
    await recoveryWorker.resumeActiveRuns();

    const view = await waitForRunTerminal(store, run.id);
    expect(recoveryAdapter.waitCalls[0]).toMatchObject({ taskId: "task-1", runId: "task-1-run" });
    expect(view?.run.status).toBe("succeeded");
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "builder")?.status).toBe("succeeded");
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "slot-1")?.status).toBe("succeeded");
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "manager")?.status).toBe("succeeded");
  });

  it("does not treat unassigned manager slot boxes as global start nodes", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createBlueprint(
      [
        createAgentNode("brief", "Brief"),
        {
          id: "unassigned-slot",
          type: "manager_slot",
          position: { x: 420, y: 120 },
          config: {
            label: "Slot 1",
            managerNodeId: "",
            slot: 1
          }
        }
      ],
      []
    );
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-1")
    ], [
      createCompletedAgentTask("task-1", "succeeded", "brief ready")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);

    expect(view?.run.status).toBe("succeeded");
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "brief")?.status).toBe("succeeded");
    expect(view?.nodeRuns.some((nodeRun) => nodeRun.nodeId === "unassigned-slot")).toBe(false);
  });

  it("runs the manager-driven HTML delivery example through the news, execution-doc, and build agents", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createManagerDrivenHtmlBlueprint(new Date().toISOString(), "company-hiveward-studio");
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-manager-1"),
      createStartedAgentTask("task-1"),
      createStartedAgentTask("task-2"),
      createStartedAgentTask("task-manager-2"),
      createStartedAgentTask("task-3"),
      createStartedAgentTask("task-manager-3")
    ], [
      createCompletedAgentTask("task-manager-1", "succeeded", JSON.stringify({ status: "continue", roundNumber: 1, nextSlot: 1, reason: "start with research" })),
      createCompletedAgentTask(
        "task-1",
        "succeeded",
        [
          "# News brief",
          "",
          "Topic: AI agent productivity.",
          "",
          "- Agent teams move into production workflows: builders are using coordinated AI agents for research and delivery.",
          "",
          "Page thesis: Agentic workflows are becoming production infrastructure."
        ].join("\n")
      ),
      createCompletedAgentTask(
        "task-2",
        "succeeded",
        [
          "# HTML execution document",
          "",
          "Page title: Agentic Workflow Brief",
          "",
          "Hero headline: Agentic workflows are becoming production infrastructure.",
          "",
          "Acceptance criteria: standalone HTML, no placeholders."
        ].join("\n")
      ),
      createCompletedAgentTask("task-manager-2", "succeeded", JSON.stringify({ status: "continue", roundNumber: 1, nextSlot: 2, reason: "build the page" })),
      createCompletedAgentTask(
        "task-3",
        "succeeded",
        "<!doctype html><html><body><h1>Agentic Workflow Brief</h1></body></html>"
      ),
      createCompletedAgentTask("task-manager-3", "succeeded", JSON.stringify({ status: "complete", roundNumber: 1, reason: "HTML complete" }))
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);

    expect(view?.run.status).toBe("succeeded");
    expect(adapter.calls.map((call) => call.agentName)).toEqual([
      "html-delivery-manager",
      "news-researcher",
      "execution-doc-writer",
      "html-delivery-manager",
      "html-code-builder",
      "html-delivery-manager"
    ]);
    expect((adapter.calls[0]?.input as { delegationRoster?: { slots?: unknown[] } }).delegationRoster?.slots).toHaveLength(2);
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "html-manager-slot-1")?.status).toBe("succeeded");
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "html-manager-slot-2")?.status).toBe("succeeded");
    expect(view?.nodeRuns.some((nodeRun) => nodeRun.nodeId === "html-manager-slot-3")).toBe(false);
    const builderOutput = view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "html-manager-slot-2-agent-1")?.output;
    expect(builderOutput).toEqual(expect.stringContaining("<!doctype html>"));
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "html-manager")?.output).toMatchObject({
      status: "completed"
    });
  });

  it("lets the active manager chaos blueprint choose a scrambled news-to-html route", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createActiveManagerNewsHtmlChaosBlueprint(new Date().toISOString(), "company-hiveward-studio");
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-manager-1"),
      createStartedAgentTask("task-news"),
      createStartedAgentTask("task-manager-2"),
      createStartedAgentTask("task-doc"),
      createStartedAgentTask("task-manager-3"),
      createStartedAgentTask("task-html"),
      createStartedAgentTask("task-manager-4"),
      createStartedAgentTask("task-qa"),
      createStartedAgentTask("task-manager-5")
    ], [
      createCompletedAgentTask("task-manager-1", "succeeded", JSON.stringify({ status: "continue", roundNumber: 1, nextSlot: 3, reason: "先收集新闻" })),
      createCompletedAgentTask("task-news", "succeeded", "新闻简报：AI agent 正在进入企业运营。"),
      createCompletedAgentTask("task-manager-2", "succeeded", JSON.stringify({ status: "continue", roundNumber: 1, nextSlot: 4, reason: "再写制作说明" })),
      createCompletedAgentTask("task-doc", "succeeded", "制作说明：需要 hero、新闻要点、source-index 和 risk-notes。"),
      createCompletedAgentTask("task-manager-3", "succeeded", JSON.stringify({ status: "continue", roundNumber: 1, nextSlot: 1, reason: "现在构建 HTML" })),
      createCompletedAgentTask(
        "task-html",
        "succeeded",
        "<!doctype html><html><body><main><section id=\"source-index\"></section><section id=\"risk-notes\"></section></main></body></html>"
      ),
      createCompletedAgentTask("task-manager-4", "succeeded", JSON.stringify({ status: "continue", roundNumber: 1, nextSlot: 2, reason: "最后 QA" })),
      createCompletedAgentTask("task-qa", "succeeded", JSON.stringify({ status: "complete", deliveryReady: true })),
      createCompletedAgentTask("task-manager-5", "succeeded", JSON.stringify({ status: "complete", roundNumber: 1, reason: "QA 已通过" }))
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);

    expect(view?.run.status).toBe("succeeded");
    expect(adapter.calls.map((call) => call.agentName)).toEqual([
      "active-dispatch-manager",
      "news-researcher-cn",
      "active-dispatch-manager",
      "html-execution-doc-writer",
      "active-dispatch-manager",
      "html-builder",
      "active-dispatch-manager",
      "html-qa-reviewer",
      "active-dispatch-manager"
    ]);
    expect((adapter.calls[0]?.input as { delegationRoster?: { slots?: unknown[] } }).delegationRoster?.slots).toHaveLength(4);
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "chaos-manager")?.output).toMatchObject({
      status: "completed",
      reason: "QA 已通过"
    });
  });

  it("lets the active manager Remotion blueprint reroute to build after strict QA rejects HTML output", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createActiveManagerRemotionVideoChaosBlueprint(new Date().toISOString(), "company-hiveward-studio");
    const remotionBundle = [
      "src/Root.tsx",
      "import {Composition} from 'remotion';",
      "import {AgentOpsBrief} from './AgentOpsBrief';",
      "export const Root = () => <Composition id=\"AgentOpsBriefVideo\" component={AgentOpsBrief} width={1920} height={1080} fps={30} durationInFrames={450} />;",
      "src/AgentOpsBrief.tsx",
      "import {AbsoluteFill, Sequence, interpolate, useCurrentFrame, spring, useVideoConfig} from 'remotion';",
      "export const AgentOpsBrief = () => <AbsoluteFill><Sequence from={0} durationInFrames={120}>AI agent 进入企业运营</Sequence></AbsoluteFill>;",
      "Verification: npx remotion studio"
    ].join("\n");
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-manager-1"),
      createStartedAgentTask("task-research"),
      createStartedAgentTask("task-manager-2"),
      createStartedAgentTask("task-storyboard"),
      createStartedAgentTask("task-manager-3"),
      createStartedAgentTask("task-tech"),
      createStartedAgentTask("task-manager-4"),
      createStartedAgentTask("task-build-1"),
      createStartedAgentTask("task-manager-5"),
      createStartedAgentTask("task-qa-1"),
      createStartedAgentTask("task-manager-6"),
      createStartedAgentTask("task-build-2"),
      createStartedAgentTask("task-manager-7"),
      createStartedAgentTask("task-qa-2"),
      createStartedAgentTask("task-manager-8")
    ], [
      createCompletedAgentTask("task-manager-1", "succeeded", JSON.stringify({ status: "continue", roundNumber: 1, nextSlot: 3, reason: "先研究视频主题" })),
      createCompletedAgentTask("task-research", "succeeded", "研究：AI agent 与多 agent 工作流正在进入企业运营，需提示验证与治理风险。"),
      createCompletedAgentTask("task-manager-2", "succeeded", JSON.stringify({ status: "continue", roundNumber: 1, nextSlot: 4, reason: "再写脚本分镜" })),
      createCompletedAgentTask("task-storyboard", "succeeded", "分镜：0-90 标题，90-210 三个趋势点，210-330 风险，330-450 行动建议。"),
      createCompletedAgentTask("task-manager-3", "succeeded", JSON.stringify({ status: "continue", roundNumber: 1, nextSlot: 5, reason: "补技术规划" })),
      createCompletedAgentTask("task-tech", "succeeded", "技术规划：Root.tsx 注册 AgentOpsBriefVideo，1920x1080，30fps，450 frames，使用 Sequence、AbsoluteFill、interpolate。"),
      createCompletedAgentTask("task-manager-4", "succeeded", JSON.stringify({ status: "continue", roundNumber: 1, nextSlot: 1, reason: "开始构建 Remotion" })),
      createCompletedAgentTask("task-build-1", "succeeded", "<!doctype html><html><body>这是网页，不是 Remotion Composition。</body></html>"),
      createCompletedAgentTask("task-manager-5", "succeeded", JSON.stringify({ status: "continue", roundNumber: 1, nextSlot: 2, reason: "严格 QA" })),
      createCompletedAgentTask(
        "task-qa-1",
        "succeeded",
        JSON.stringify({ status: "fail", returnToSlot: 1, reason: "产物是 HTML，不是 Remotion Composition", fixes: ["删除 HTML 输出", "提供 Root.tsx 和 Composition"] })
      ),
      createCompletedAgentTask("task-manager-6", "succeeded", JSON.stringify({ status: "continue", roundNumber: 1, nextSlot: 1, reason: "QA 未通过，回退到构建槽修复" })),
      createCompletedAgentTask("task-build-2", "succeeded", remotionBundle),
      createCompletedAgentTask("task-manager-7", "succeeded", JSON.stringify({ status: "continue", roundNumber: 1, nextSlot: 2, reason: "复审修复后的 Remotion 产物" })),
      createCompletedAgentTask("task-qa-2", "succeeded", JSON.stringify({ status: "complete", deliveryReady: true, reason: "Remotion 产物已通过严格审查" })),
      createCompletedAgentTask("task-manager-8", "succeeded", JSON.stringify({ status: "complete", roundNumber: 1, reason: "Remotion QA 已通过" }))
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);

    expect(view?.run.status).toBe("succeeded");
    expect(adapter.calls.map((call) => call.agentName)).toEqual([
      "remotion-dispatch-manager",
      "remotion-video-researcher",
      "remotion-dispatch-manager",
      "remotion-storyboard-writer",
      "remotion-dispatch-manager",
      "remotion-tech-planner",
      "remotion-dispatch-manager",
      "remotion-code-builder",
      "remotion-dispatch-manager",
      "remotion-qa-reviewer",
      "remotion-dispatch-manager",
      "remotion-code-builder",
      "remotion-dispatch-manager",
      "remotion-qa-reviewer",
      "remotion-dispatch-manager"
    ]);
    expect((adapter.calls[0]?.input as { delegationRoster?: { slots?: unknown[] } }).delegationRoster?.slots).toHaveLength(5);
    expect(view?.nodeRuns.filter((nodeRun) => nodeRun.nodeId === "remotion-code-builder" && nodeRun.status === "succeeded")).toHaveLength(2);
    expect(view?.nodeRuns.filter((nodeRun) => nodeRun.nodeId === "remotion-qa-reviewer" && nodeRun.status === "succeeded")).toHaveLength(2);
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "remotion-manager")?.output).toMatchObject({
      status: "completed",
      reason: "Remotion QA 已通过"
    });
    expect(view?.finalResult?.candidates[0]?.output).toEqual(expect.stringContaining("AgentOpsBriefVideo"));
    expect(view?.finalResult?.candidates[0]?.output).not.toEqual(expect.stringContaining("<!doctype html>"));
  });

  it("runs manager self-iteration through three approved rounds and a final completion", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createSelfIterationBlueprint({ maxRounds: 3 });
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-round-1-research"),
      createStartedAgentTask("task-round-1-plan"),
      createStartedAgentTask("task-round-1"),
      createStartedAgentTask("task-round-1-report"),
      createStartedAgentTask("task-round-1-snapshot"),
      createStartedAgentTask("task-round-2-research"),
      createStartedAgentTask("task-round-2-plan"),
      createStartedAgentTask("task-round-2"),
      createStartedAgentTask("task-round-2-report"),
      createStartedAgentTask("task-round-2-snapshot"),
      createStartedAgentTask("task-round-3-research"),
      createStartedAgentTask("task-round-3-plan"),
      createStartedAgentTask("task-round-3"),
      createStartedAgentTask("task-round-3-report"),
      createStartedAgentTask("task-round-3-snapshot")
    ], [
      createCompletedAgentTask("task-round-1-research", "succeeded", "round 1 research summary"),
      createCompletedAgentTask("task-round-1-plan", "succeeded", "round 1 execution plan"),
      createCompletedAgentTask("task-round-1", "succeeded", htmlArtifactOutput("round 1")),
      createCompletedAgentTask("task-round-1-report", "succeeded", releaseReportOutput("round 1")),
      createCompletedAgentTask("task-round-1-snapshot", "succeeded", JSON.stringify({
        completedItems: ["Round 1 delivered an HTML artifact."],
        keyDecisions: ["Continue to round 2."],
        validatedFacts: ["round 1 artifact exists"],
        openQuestions: [],
        activeRisks: [],
        assumptions: [],
        recommendedNextStep: "plan",
        summary: "round 1 manager snapshot",
        freeform: "Round 1 freeform memory."
      })),
      createCompletedAgentTask("task-round-2-research", "succeeded", "round 2 research summary from manager"),
      createCompletedAgentTask("task-round-2-plan", "succeeded", "round 2 execution plan from manager"),
      createCompletedAgentTask("task-round-2", "succeeded", htmlArtifactOutput("round 2")),
      createCompletedAgentTask("task-round-2-report", "succeeded", releaseReportOutput("round 2")),
      createCompletedAgentTask("task-round-2-snapshot", "succeeded", JSON.stringify({
        completedItems: ["Round 2 delivered an HTML artifact."],
        keyDecisions: ["Continue to round 3."],
        validatedFacts: ["round 2 artifact exists"],
        openQuestions: [],
        activeRisks: [],
        assumptions: [],
        recommendedNextStep: "plan",
        summary: "round 2 manager snapshot",
        freeform: "Round 2 freeform memory."
      })),
      createCompletedAgentTask("task-round-3-research", "succeeded", "round 3 research summary from manager"),
      createCompletedAgentTask("task-round-3-plan", "succeeded", "round 3 execution plan from manager"),
      createCompletedAgentTask("task-round-3", "succeeded", htmlArtifactOutput("round 3")),
      createCompletedAgentTask("task-round-3-report", "succeeded", releaseReportOutput("round 3")),
      createCompletedAgentTask("task-round-3-snapshot", "succeeded", JSON.stringify({
        completedItems: ["Round 3 delivered final HTML."],
        keyDecisions: ["Complete the run."],
        validatedFacts: ["round 3 artifact exists"],
        openQuestions: [],
        activeRisks: [],
        assumptions: [],
        recommendedNextStep: "complete",
        summary: "round 3 manager snapshot",
        freeform: "Round 3 freeform memory."
      }))
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const started = await waitForRunStatus(store, run.id, "waiting_approval");
    const requirement1 = started?.approvalRequests?.find((request) => request.kind === "iteration_requirement_plan");

    expect(run.status).toBe("running");
    expect(started.run.status).toBe("waiting_approval");
    expect(adapter.calls.map((call) => call.agentName)).toEqual(["manager", "manager"]);
    expect(requirement1).toMatchObject({
      status: "pending",
      capabilities: expect.objectContaining({ approve: true, complete: false })
    });
    expect(requirement1?.body).toContain("Research source: manager_fallback");
    expect(requirement1?.body).toContain("Plan source: manager_fallback");
    expect(started?.managerMail).toHaveLength(1);
    expect(started?.nodeRuns.some((nodeRun) => nodeRun.id.startsWith("preflight-") && nodeRun.nodeId === "top-manager")).toBe(true);
    expect(started?.nodeRuns.some((nodeRun) => isRuntimeNodeRun(nodeRun) && nodeRun.nodeId === "top-manager")).toBe(false);

    const currentRun1 = await store.getBlueprintRun(run.id);
    if (!currentRun1 || !requirement1) throw new Error("Expected first requirement approval.");
    await worker.applyApprovalRequest(blueprint, currentRun1, requirement1.id, "approve");

    const report1View = await waitForRunView(store, run.id, (view) =>
      view.run.status === "waiting_approval" &&
      (view.approvalRequests ?? []).some((request) => request.kind === "manager_release_report" && request.status === "pending")
    );
    const report1 = report1View.approvalRequests?.find((request) =>
      request.kind === "manager_release_report" && request.status === "pending"
    );

    expect(report1).toMatchObject({
      capabilities: expect.objectContaining({ approve: true, complete: true })
    });
    expect(report1?.body).toContain("## Completed Work");
    expect(report1?.body).toContain("Builder");
    expect(report1?.body).not.toContain("Agent reports:");
    expect(report1?.body).not.toContain("### Builder");
    expect(report1View.agentHumanReports).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: "builder",
        source: "agent"
      })
    ]));
    expect(adapter.calls.filter((call) => call.agentName === "builder")).toHaveLength(1);
    expect(report1View.nodeRuns.filter((nodeRun) => isRuntimeNodeRun(nodeRun) && nodeRun.nodeId === "top-manager")).toHaveLength(2);
    expect(report1View.nodeRuns.filter((nodeRun) => isRuntimeNodeRun(nodeRun) && nodeRun.nodeId === "slot-1")).toHaveLength(1);
    expect(report1View.nodeRuns.filter((nodeRun) => isRuntimeNodeRun(nodeRun) && nodeRun.nodeId === "builder")).toHaveLength(1);
    expect(report1View.artifacts?.find((artifact) => artifact.kind === "html")).toMatchObject({
      kind: "html",
      trusted: false,
      previewPolicy: "sandboxed_iframe"
    });

    const currentRun2 = await store.getBlueprintRun(run.id);
    if (!currentRun2 || !report1) throw new Error("Expected first release report approval.");
    await worker.applyApprovalRequest(blueprint, currentRun2, report1.id, "approve", {
      comment: "Carry keyboard controls into the next round."
    });

    const requirement2View = await waitForRunView(store, run.id, (view) =>
      (view.iterationRounds ?? []).some((round) => round.roundNumber === 2 && round.status === "requirement_pending")
    );
    const round2 = requirement2View.iterationRounds?.find((round) => round.roundNumber === 2);
    const requirement2 = requirement2View.approvalRequests?.find((request) => request.id === round2?.requirementRequestId);
    const round2ResearchRun = requirement2View.nodeRuns.find((nodeRun) =>
      nodeRun.iterationRoundId === round2?.id &&
      nodeRun.nodeId === "top-manager" &&
      nodeRun.id.startsWith("preflight-research_resolution-")
    );
    const round2RequirementRun = requirement2View.nodeRuns.find((nodeRun) =>
      nodeRun.iterationRoundId === round2?.id &&
      nodeRun.nodeId === "top-manager" &&
      nodeRun.id.startsWith("preflight-requirement_resolution-")
    );
    const round2ResearchReport = requirement2View.agentHumanReports?.find((report) => report.nodeRunId === round2ResearchRun?.id);
    const round2ResearchStartIndex = requirement2View.runTimeline?.findIndex((item) => item.payloadRef === round2ResearchRun?.id && item.kind === "node_started") ?? -1;
    const round2RequirementStartIndex = requirement2View.runTimeline?.findIndex((item) => item.payloadRef === round2RequirementRun?.id && item.kind === "node_started") ?? -1;

    expect(requirement2).toMatchObject({
      status: "pending",
      capabilities: expect.objectContaining({ approve: true, complete: false })
    });
    expect(round2ResearchRun).toMatchObject({
      status: "succeeded",
      output: "round 2 research summary from manager"
    });
    expect(round2ResearchReport?.bodyMd).toContain("round 2 research summary from manager");
    expect(round2ResearchStartIndex).toBeGreaterThanOrEqual(0);
    expect(round2RequirementStartIndex).toBeGreaterThan(round2ResearchStartIndex);
    expect(requirement2?.body).toContain("Previous report:");
    expect(requirement2?.body).toContain("Carry keyboard controls into the next round.");
    expect(requirement2?.body).toContain("round 2 research summary from manager");
    expect(requirement2?.body).not.toContain("Use the previous round outcome to define the next execution round.");
    const round1SnapshotCall = adapter.calls.find((call) =>
      isRecord(call.input) &&
      call.input.roundNumber === 1 &&
      typeof call.input.humanFeedback === "string" &&
      call.input.humanFeedback.includes("Carry keyboard controls into the next round.") &&
      isRecord(call.input.runContext) &&
      call.input.runContext.mode === "context_snapshot"
    );
    expect(round1SnapshotCall?.input).toMatchObject({
      humanFeedback: expect.stringContaining("Carry keyboard controls into the next round."),
      runContext: expect.objectContaining({ mode: "context_snapshot" })
    });

    const currentRun3 = await store.getBlueprintRun(run.id);
    if (!currentRun3 || !requirement2) throw new Error("Expected second requirement approval.");
    await worker.applyApprovalRequest(blueprint, currentRun3, requirement2.id, "approve");

    const report2View = await waitForRunView(store, run.id, (view) =>
      view.run.status === "waiting_approval" &&
      (view.releaseReports ?? []).length === 2 &&
      (view.approvalRequests ?? []).some((request) => request.kind === "manager_release_report" && request.status === "pending")
    );
    const report2 = report2View.approvalRequests
      ?.filter((request) => request.kind === "manager_release_report" && request.status === "pending")
      .at(-1);

    expect(report2).toMatchObject({
      capabilities: expect.objectContaining({ approve: true, complete: true, terminate: false })
    });
    expect(adapter.calls.filter((call) => call.agentName === "builder")).toHaveLength(2);
    expect(report2View.nodeRuns.filter((nodeRun) => isRuntimeNodeRun(nodeRun) && nodeRun.nodeId === "top-manager")).toHaveLength(4);
    expect(report2View.nodeRuns.filter((nodeRun) => isRuntimeNodeRun(nodeRun) && nodeRun.nodeId === "slot-1")).toHaveLength(2);
    expect(report2View.nodeRuns.filter((nodeRun) => isRuntimeNodeRun(nodeRun) && nodeRun.nodeId === "builder")).toHaveLength(2);
    expect(new Set(report2View.nodeRuns.map((nodeRun) => nodeRun.iterationRoundId).filter(Boolean)).size).toBe(2);

    const currentRun4 = await store.getBlueprintRun(run.id);
    if (!currentRun4 || !report2) throw new Error("Expected second release report approval.");
    await worker.applyApprovalRequest(blueprint, currentRun4, report2.id, "approve");

    const requirement3View = await waitForRunView(store, run.id, (view) =>
      (view.iterationRounds ?? []).some((round) => round.roundNumber === 3 && round.status === "requirement_pending")
    );
    const round3 = requirement3View.iterationRounds?.find((round) => round.roundNumber === 3);
    const requirement3 = requirement3View.approvalRequests?.find((request) => request.id === round3?.requirementRequestId);

    expect(requirement3?.body).toContain("round 3 research summary from manager");
    expect(requirement3?.body).not.toContain("Use the previous round outcome to define the next execution round.");

    const currentRun5 = await store.getBlueprintRun(run.id);
    if (!currentRun5 || !requirement3) throw new Error("Expected third requirement approval.");
    await worker.applyApprovalRequest(blueprint, currentRun5, requirement3.id, "approve");

    const report3View = await waitForRunView(store, run.id, (view) =>
      view.run.status === "waiting_approval" &&
      (view.releaseReports ?? []).length === 3 &&
      (view.approvalRequests ?? []).some((request) => request.kind === "manager_release_report" && request.status === "pending")
    );
    const report3 = report3View.approvalRequests
      ?.filter((request) => request.kind === "manager_release_report" && request.status === "pending")
      .at(-1);

    expect(report3).toMatchObject({
      capabilities: expect.objectContaining({ approve: false, complete: true, terminate: false })
    });
    expect(adapter.calls.filter((call) => call.agentName === "builder")).toHaveLength(3);
    expect(report3View.nodeRuns.filter((nodeRun) => isRuntimeNodeRun(nodeRun) && nodeRun.nodeId === "top-manager")).toHaveLength(6);
    expect(report3View.nodeRuns.filter((nodeRun) => isRuntimeNodeRun(nodeRun) && nodeRun.nodeId === "slot-1")).toHaveLength(3);
    expect(report3View.nodeRuns.filter((nodeRun) => isRuntimeNodeRun(nodeRun) && nodeRun.nodeId === "builder")).toHaveLength(3);
    expect(new Set(report3View.nodeRuns.map((nodeRun) => nodeRun.iterationRoundId).filter(Boolean)).size).toBe(3);

    const currentRun6 = await store.getBlueprintRun(run.id);
    if (!currentRun6 || !report3) throw new Error("Expected final release report approval.");
    await worker.applyApprovalRequest(blueprint, currentRun6, report3.id, "complete");

    const completed = await waitForRunTerminal(store, run.id);
    expect(completed?.run.status).toBe("succeeded");
    expect(completed?.iterationSessions?.[0]).toMatchObject({ status: "completed" });
    expect(completed?.approvalRequests?.filter((request) => request.status === "pending")).toHaveLength(0);
    expect(completed?.approvalDecisions?.map((decision) => decision.action)).toEqual([
      "approve",
      "approve",
      "approve",
      "approve",
      "approve",
      "complete"
    ]);
    expect(completed?.runTimeline?.map((item) => item.sequence)).toEqual(
      completed?.runTimeline?.map((item) => item.sequence).slice().sort((left, right) => left - right)
    );
    expect(completed?.nodeRuns.filter((nodeRun) => isRuntimeNodeRun(nodeRun) && nodeRun.nodeId === "top-manager")).toHaveLength(6);
    expect(completed?.managerContextSnapshots).toHaveLength(3);
    expect(completed?.managerContextSnapshots?.[0]).toMatchObject({
      completedItems: ["Round 1 delivered an HTML artifact."],
      keyDecisions: ["Continue to round 2."],
      validatedFacts: ["round 1 artifact exists"],
      summary: "round 1 manager snapshot",
      freeform: "Round 1 freeform memory."
    });
  }, 30_000);

  it("starts self-iteration runs before preflight preparation completes", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createSelfIterationBlueprint({ maxRounds: 1, researchAgent: true });
    const adapter = new BlockingAdapter(createStartedAgentTask("task-preflight-research"));
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    await waitForCondition(() => adapter.calls.length === 1, "preflight research to start");
    const view = await store.getRunView(run.id);

    expect(run.status).toBe("running");
    expect(view?.run.status).toBe("running");
    expect(view?.approvalRequests).toEqual([]);
    expect(view?.runTimeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "round_started", title: "Round 1 started" }),
        expect.objectContaining({
          kind: "node_started",
          actorLabel: "Research",
          title: "Research: research started"
        })
      ])
    );
    expect(adapter.calls[0]).toMatchObject({
      agentName: "research",
      input: expect.objectContaining({ runId: run.id })
    });
  });

  it("uses configured research and round-plan agents before publishing the plan approval", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createSelfIterationBlueprint({ maxRounds: 1, researchAgent: true, requirementAgent: true });
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-research-agent"),
      createStartedAgentTask("task-requirement-agent")
    ], [
      createCompletedAgentTask("task-research-agent", "succeeded", markdownArtifactOutput("agent research summary", "Research summary")),
      createCompletedAgentTask("task-requirement-agent", "succeeded", "agent round execution plan")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunStatus(store, run.id, "waiting_approval");
    const round = view?.iterationRounds?.[0];
    const request = view?.approvalRequests?.find((approval) => approval.kind === "iteration_requirement_plan");

    expect(run.status).toBe("running");
    expect(view.run.status).toBe("waiting_approval");
    expect(adapter.calls.map((call) => call.agentName)).toEqual(["research", "requirements"]);
    expect(adapter.calls[0]?.input).toMatchObject({
      isFirstRound: true,
      researchInstruction: expect.stringContaining("Every self-iteration round must trigger this system research step"),
      runContext: expect.objectContaining({ mode: "research_resolution" })
    });
    expect(adapter.calls[1]?.input).toMatchObject({
      requirementInstruction: expect.stringContaining("Every self-iteration round must trigger this system requirement/planning step"),
      researchSummary: "agent research summary",
      runContext: expect.objectContaining({
        mode: "requirement_resolution",
        research: expect.objectContaining({ status: "agent_generated" })
      })
    });
    expect(round).toMatchObject({
      researchStatus: "agent_generated",
      planSource: "agent_generated",
      researchArtifactIds: expect.arrayContaining([expect.any(String)])
    });
    expect(view?.artifacts?.find((artifact) => artifact.kind === "markdown")).toMatchObject({
      downloadUrl: expect.stringContaining("/artifacts/"),
      relativePath: expect.stringContaining(".md")
    });
    expect(request?.body).toContain("Research source: agent_generated");
    expect(request?.body).toContain("Plan source: agent_generated");
    expect(request?.body).toContain("agent round execution plan");
  });

  it("uses connected system requirement interface but does not infer system research from ordinary slots", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createSelfIterationBlueprint({ maxRounds: 1, requirementAgent: true });
    const manager = blueprint.nodes.find((node) => node.id === "top-manager");
    const researchRequirementSlot = blueprint.nodes.find((node) => node.id === "requirement-slot");
    const researchRequirementAgent = blueprint.nodes.find((node) => node.id === "requirements");
    if (!manager || !researchRequirementSlot || !researchRequirementAgent || researchRequirementAgent.type !== "agent") {
      throw new Error("Expected manager, research requirement slot, and agent.");
    }
    manager.config = {
      ...manager.config,
      requirementAgentNodeId: undefined
    };
    const userResearchSlot = {
      id: "user-research-slot",
      type: "manager_slot" as const,
      position: { x: 300, y: -320 },
      config: {
        label: "\u7528\u6237\u666e\u901a\u8c03\u7814 Slot",
        managerNodeId: "top-manager",
        slot: 4,
        executionMode: "manual" as const
      }
    };
    const userResearchAgent = {
      ...createAgentNode("user-research", "\u7528\u6237\u666e\u901a\u8c03\u7814 Agent", { x: 80, y: 560 }),
      parentId: "user-research-slot"
    };
    blueprint.nodes.push(userResearchSlot, userResearchAgent);
    blueprint.edges.push(
      {
        id: "edge-top-manager-user-research-slot",
        source: "top-manager",
        sourceHandle: "manager-out-4",
        target: "user-research-slot",
        targetHandle: "manager-slot-in"
      },
      {
        id: "edge-user-research-slot-top-manager",
        source: "user-research-slot",
        sourceHandle: "manager-slot-out",
        target: "top-manager",
        targetHandle: "manager-in-4"
      },
      {
        id: "edge-user-research-slot-agent",
        source: "user-research-slot",
        sourceHandle: "manager-slot-inner-out",
        target: "user-research"
      },
      {
        id: "edge-user-research-agent-slot",
        source: "user-research",
        target: "user-research-slot",
        targetHandle: "manager-slot-inner-in"
      }
    );
    researchRequirementSlot.config = {
      ...researchRequirementSlot.config,
      label: "\u8c03\u7814\u4e0e\u63d0\u9700 Slot"
    };
    researchRequirementAgent.config = {
      ...researchRequirementAgent.config,
      label: "\u8c03\u7814\u4e0e\u63d0\u9700 Agent",
      agentName: "research-requirements",
      prompt: "Run first-round research and requirements."
    };
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-manager-research"),
      createStartedAgentTask("task-research-requirement-plan")
    ], [
      createCompletedAgentTask("task-manager-research", "succeeded", "manager first-round research baseline"),
      createCompletedAgentTask("task-research-requirement-plan", "succeeded", "first-round execution plan")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunStatus(store, run.id, "waiting_approval");

    expect(adapter.calls.map((call) => call.agentName)).toEqual(["manager", "research-requirements"]);
    expect(adapter.calls[0]?.input).toMatchObject({
      isFirstRound: true,
      researchInstruction: expect.stringContaining("Absence of lastRound"),
      runContext: expect.objectContaining({ mode: "research_resolution" })
    });
    expect(adapter.calls[1]?.input).toMatchObject({
      requirementInstruction: expect.stringContaining("Every self-iteration round must trigger this system requirement/planning step"),
      researchSummary: "manager first-round research baseline",
      runContext: expect.objectContaining({
        mode: "requirement_resolution",
        research: expect.objectContaining({ status: "manager_fallback" })
      })
    });
    expect(view?.iterationRounds?.[0]).toMatchObject({
      researchStatus: "manager_fallback",
      planSource: "agent_generated"
    });
    expect(view?.approvalRequests?.find((approval) => approval.kind === "iteration_requirement_plan")?.body)
      .toContain("first-round execution plan");
  });

  it("uses user-facing Chinese copy for Chinese round plan approvals", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createSelfIterationBlueprint({ maxRounds: 1 });
    blueprint.name = "自分发测试";
    const manager = blueprint.nodes.find((node) => node.id === "top-manager");
    if (!manager || manager.type !== "manager") throw new Error("Expected top manager.");
    manager.config = {
      ...manager.config,
      label: "自分发测试 Manager",
      instructions: "先完成前期准备，再把执行计划交给用户确认。"
    };
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-cn-research"),
      createStartedAgentTask("task-cn-plan")
    ], [
      createCompletedAgentTask("task-cn-research", "succeeded", "当前输入足够，不需要额外调研。"),
      createCompletedAgentTask("task-cn-plan", "succeeded", "制作一个单文件 HTML 测试页面，并在用户确认后交给页面制作 Agent。")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunStatus(store, run.id, "waiting_approval");
    const request = view.approvalRequests?.find((approval) => approval.kind === "iteration_requirement_plan");

    expect(request?.title).toBe("第 1 轮执行计划");
    expect(request?.body).toContain("前期准备工作已完成");
    expect(request?.body).toContain("请确认本轮执行计划");
    expect(request?.body).toContain("确认后会开始后续 Agent 工作");
    expect(request?.body).toContain("## 调研摘要");
    expect(request?.body).toContain("## 执行计划");
    expect(request?.body).not.toContain("Research source:");
    expect(request?.body).not.toContain("Plan source:");
  });

  it("blocks the round instead of falling back when a configured research agent fails", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createSelfIterationBlueprint({ maxRounds: 1, researchAgent: true, requirementAgent: true });
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-failed-research"),
      createStartedAgentTask("task-failed-research-reply")
    ], [
      createCompletedAgentTask("task-failed-research", "failed", undefined, "missing research credential"),
      createCompletedAgentTask("task-failed-research-reply", "failed", undefined, "missing research credential")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunStatus(store, run.id, "waiting_approval");
    const request = view?.approvalRequests?.find((approval) => approval.kind === "iteration_requirement_plan");

    expect(run.status).toBe("running");
    expect(view.run.status).toBe("waiting_approval");
    expect(adapter.calls.map((call) => call.agentName)).toEqual(["research"]);
    expect(view?.iterationRounds?.[0]).toMatchObject({
      researchStatus: "blocked",
      planSource: "manager_fallback"
    });
    expect(request).toMatchObject({
      status: "pending",
      capabilities: expect.objectContaining({ approve: false, reply: true, reject: true })
    });
    expect(request?.body).toContain("Issue Report");
    expect(request?.body).toContain("What you can do");
    expect(request?.body).toContain("missing research credential");

    const currentRun = await store.getBlueprintRun(run.id);
    if (!currentRun || !request) throw new Error("Expected blocked preflight approval.");
    await expect(worker.applyApprovalRequest(blueprint, currentRun, request.id, "approve"))
      .rejects.toThrow("Approval request does not allow approve.");
    await worker.applyApprovalRequest(blueprint, currentRun, request.id, "reply", {
      message: "The credential is still unavailable."
    });
    const replyView = await store.getRunView(run.id);
    const stillBlocked = replyView?.approvalRequests
      ?.find((approval) => approval.id === request.id);
    expect(adapter.calls.map((call) => call.agentName)).toEqual(["research"]);
    expect(stillBlocked).toMatchObject({
      status: "pending",
      revision: 1,
      capabilities: expect.objectContaining({ approve: false, reply: true })
    });
    expect(replyView?.approvalDecisions?.filter((decision) => decision.action === "reply")).toEqual([
      expect.objectContaining({ approvalRequestId: request.id, resultingStatus: "pending" })
    ]);
  });

  it("uses manager semantic judgment to request another research pass", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createSelfIterationBlueprint({ maxRounds: 1, maxPreparationAttempts: 2 });
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-research-1"),
      createStartedAgentTask("task-plan-1"),
      createStartedAgentTask("task-judge-1"),
      createStartedAgentTask("task-research-2"),
      createStartedAgentTask("task-plan-2")
    ], [
      createCompletedAgentTask("task-research-1", "succeeded", "initial research"),
      createCompletedAgentTask("task-plan-1", "succeeded", "draft plan before semantic judgment"),
      createCompletedAgentTask("task-judge-1", "succeeded", JSON.stringify({
        humanReportMd: "## Preflight judgment\n\n## Delivery location\n\n- No new deliverable produced in this step.",
        result: {
          needsMoreResearch: true,
          reason: "Need clearer market facts.",
          researchBrief: "Resolve market facts before execution."
        }
      })),
      createCompletedAgentTask("task-research-2", "succeeded", "updated research after semantic judgment"),
      createCompletedAgentTask("task-plan-2", "succeeded", "final plan after extra research")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunStatus(store, run.id, "waiting_approval");
    const request = view?.approvalRequests?.find((approval) => approval.kind === "iteration_requirement_plan");

    expect(run.status).toBe("running");
    expect(view.run.status).toBe("waiting_approval");
    expect(adapter.calls.map((call) => isRecord(call.input) ? call.input.runContext : undefined)).toEqual([
      expect.objectContaining({ mode: "research_resolution" }),
      expect.objectContaining({ mode: "requirement_resolution" }),
      expect.objectContaining({ mode: "preflight_judgment" }),
      expect.objectContaining({ mode: "research_resolution" }),
      expect.objectContaining({ mode: "requirement_resolution" })
    ]);
    expect(adapter.calls[3]?.input).toMatchObject({
      humanFeedback: expect.stringContaining("Need clearer market facts.")
    });
    expect(request?.body).toContain("updated research after semantic judgment");
    expect(request?.body).toContain("final plan after extra research");
    expect(request?.body).not.toContain("draft plan before semantic judgment");
  });

  it("falls back to the manager for missing research or round-plan agents", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const noResearchBlueprint = createSelfIterationBlueprint({ maxRounds: 1, requirementAgent: true });
    const noResearchAdapter = new ScriptedAdapter([
      createStartedAgentTask("task-no-research-manager"),
      createStartedAgentTask("task-no-research-requirements")
    ], [
      createCompletedAgentTask("task-no-research-manager", "succeeded", "manager research fallback"),
      createCompletedAgentTask("task-no-research-requirements", "succeeded", "requirement agent plan")
    ]);
    const noResearchWorker = new BlueprintWorker(store, noResearchAdapter);
    const noResearchRun = await noResearchWorker.startRun(noResearchBlueprint, "test-user");
    const noResearchView = await waitForRunStatus(store, noResearchRun.id, "waiting_approval");

    expect(noResearchAdapter.calls.map((call) => call.agentName)).toEqual(["manager", "requirements"]);
    expect(noResearchView?.iterationRounds?.[0]).toMatchObject({
      researchStatus: "manager_fallback",
      planSource: "agent_generated"
    });

    const secondStore = new FileHivewardStore(path.join(tempDir, "second", "hiveward-store.json"));
    await secondStore.init();
    const noRequirementBlueprint = createSelfIterationBlueprint({ maxRounds: 1, researchAgent: true });
    const noRequirementAdapter = new ScriptedAdapter([
      createStartedAgentTask("task-no-requirement-research"),
      createStartedAgentTask("task-no-requirement-manager")
    ], [
      createCompletedAgentTask("task-no-requirement-research", "succeeded", "research agent summary"),
      createCompletedAgentTask("task-no-requirement-manager", "succeeded", "manager plan fallback")
    ]);
    const noRequirementWorker = new BlueprintWorker(secondStore, noRequirementAdapter);
    const noRequirementRun = await noRequirementWorker.startRun(noRequirementBlueprint, "test-user");
    const noRequirementView = await waitForRunStatus(secondStore, noRequirementRun.id, "waiting_approval");

    expect(noRequirementAdapter.calls.map((call) => call.agentName)).toEqual(["research", "manager"]);
    expect(noRequirementView?.iterationRounds?.[0]).toMatchObject({
      researchStatus: "agent_generated",
      planSource: "manager_fallback"
    });
  });

  it("injects runContext into manager dispatch without platform-injecting it into worker input", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createSelfIterationBlueprint({ maxRounds: 1 });
    const manager = blueprint.nodes.find((node) => node.id === "top-manager");
    if (!manager) throw new Error("Expected top manager.");
    manager.config = {
      ...manager.config,
      dispatchMode: "self_dispatch"
    };
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-context-research"),
      createStartedAgentTask("task-context-plan"),
      createStartedAgentTask("task-context-dispatch-1"),
      createStartedAgentTask("task-context-builder"),
      createStartedAgentTask("task-context-dispatch-2"),
      createStartedAgentTask("task-context-report")
    ], [
      createCompletedAgentTask("task-context-research", "succeeded", "context research"),
      createCompletedAgentTask("task-context-plan", "succeeded", "context plan"),
      createCompletedAgentTask("task-context-dispatch-1", "succeeded", "{\"status\":\"continue\",\"roundNumber\":1,\"nextSlot\":3,\"reason\":\"dispatch\"}"),
      createCompletedAgentTask("task-context-builder", "succeeded", "worker output"),
      createCompletedAgentTask("task-context-dispatch-2", "succeeded", "{\"status\":\"complete\",\"roundNumber\":1,\"reason\":\"done\"}"),
      createCompletedAgentTask("task-context-report", "succeeded", releaseReportOutput("context"))
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const started = await waitForRunStatus(store, run.id, "waiting_approval");
    const requirement = started?.approvalRequests?.find((request) => request.kind === "iteration_requirement_plan");
    const currentRun = await store.getBlueprintRun(run.id);
    if (!currentRun || !requirement) throw new Error("Expected requirement approval.");
    await worker.applyApprovalRequest(blueprint, currentRun, requirement.id, "approve");

    const reportView = await waitForRunView(store, run.id, (view) =>
      (view.approvalRequests ?? []).some((request) => request.kind === "manager_release_report" && request.status === "pending")
    );
    const managerDecisionCalls = adapter.calls.filter((call) => call.nodeRunId.includes("manager-decision"));
    const builderRuns = reportView.nodeRuns.filter((nodeRun) => nodeRun.nodeId === "builder");
    const managerRunInput = reportView.nodeRuns.find((nodeRun) => isRuntimeNodeRun(nodeRun) && nodeRun.nodeId === "top-manager")?.input;
    const managerDecisionReports = reportView.agentHumanReports?.filter((report) => report.nodeRunId.includes("manager-decision")) ?? [];
    const managerDecisionTimeline = reportView.runTimeline?.filter((item) => item.payloadRef?.startsWith("agent-human-report-")) ?? [];

    expect(managerDecisionCalls).toHaveLength(2);
    expect(managerDecisionCalls[0]?.prompt).toContain("humanReportMd");
    expect(managerDecisionCalls[0]?.prompt).toContain("handoffJson");
    expect(managerDecisionCalls[0]?.prompt).toContain("Write humanReportMd in the user's working language");
    expect(managerDecisionCalls[0]?.prompt).toContain("All visible headings, labels, and prose inside humanReportMd");
    expect(managerDecisionCalls[0]?.prompt).toContain("## 摘要");
    expect(managerDecisionCalls[0]?.prompt).toContain("100-150");
    expect(managerDecisionCalls[0]?.prompt).toContain("real file path, browser URL, or exact artifacts[] reference");
    expect(managerDecisionCalls[0]?.prompt).toContain("Top-level artifacts[] is a publication hint and link/address index");
    expect(managerDecisionCalls[0]?.prompt).toContain("One step may declare many artifacts");
    expect(managerDecisionCalls[0]?.prompt).toContain("For generated deliverables, create or update files and return path");
    expect(managerDecisionCalls[0]?.prompt).toContain("Do not paste artifact source");
    expect(managerDecisionCalls[0]?.prompt).toContain("## \u4ea4\u4ed8\u4f4d\u7f6e");
    expect(managerDecisionCalls[0]?.prompt).toContain("Round lifecycle contract:");
    expect(managerDecisionCalls[0]?.prompt).toContain("input.manager.roundNumber is platform lifecycle state");
    expect(managerDecisionCalls[0]?.prompt).toContain("result.roundNumber must equal input.manager.roundNumber exactly");
    expect(managerDecisionCalls[0]?.prompt).toContain("result.status=\"complete\" means current-round delegation is finished");
    expect(managerDecisionCalls[0]?.prompt).not.toContain("Do not include markdown");
    expect(managerDecisionCalls[0]?.outputSchema).toMatchObject({
      required: ["humanReportMd", "result"],
      properties: {
        humanReportMd: { type: "string" },
        result: {
          type: "object",
          required: ["status", "reason", "roundNumber"],
          properties: expect.objectContaining({
            status: { type: "string" },
            roundNumber: { type: "integer" },
            nextSlot: { type: "integer" },
            reason: { type: "string" }
          })
        }
      }
    });
    expect(managerDecisionCalls[0]?.input).toMatchObject({
      manager: expect.objectContaining({
        roundNumber: 1
      }),
      decisionContract: expect.objectContaining({
        status: expect.stringContaining("not that the round is approved"),
        roundNumber: expect.stringContaining("copy input.manager.roundNumber exactly")
      }),
      runContext: expect.objectContaining({
        mode: "dispatch",
        research: expect.objectContaining({ status: "manager_fallback" }),
        currentPlan: expect.objectContaining({
          revision: 1,
          body: expect.stringContaining("context plan")
        })
      })
    });
    expect(builderRuns).not.toHaveLength(0);
    expect(managerRunInput).toMatchObject({
      manager: expect.objectContaining({
        roundNumber: 1
      })
    });
    expect(builderRuns.every((nodeRun) =>
      isRecord(nodeRun.input) &&
      isRecord(nodeRun.input.manager) &&
      nodeRun.input.manager.roundNumber === 1
    )).toBe(true);
    expect(builderRuns.every((nodeRun) => !isRecord(nodeRun.input) || !("runContext" in nodeRun.input))).toBe(true);
    expect(managerDecisionReports).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: "top-manager",
        nodeLabel: "Top Manager dispatch 1",
        managerRoundNumber: 1,
        bodyMd: "dispatch",
        source: "fallback"
      }),
      expect.objectContaining({
        nodeId: "top-manager",
        nodeLabel: "Top Manager dispatch 2",
        managerRoundNumber: 1,
        bodyMd: "done",
        source: "fallback"
      })
    ]));
    expect(managerDecisionTimeline.map((item) => item.title)).toEqual(expect.arrayContaining([
      "Top Manager dispatch 1",
      "Top Manager dispatch 2"
    ]));
  });

  it("uses the revised approved plan as the next manager dispatch contract", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createSelfIterationBlueprint({ maxRounds: 1, requirementAgent: true });
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-revised-research-1"),
      createStartedAgentTask("task-revised-plan-1"),
      createStartedAgentTask("task-revised-research-2"),
      createStartedAgentTask("task-revised-plan-2"),
      createStartedAgentTask("task-revised-dispatch"),
      createStartedAgentTask("task-revised-report"),
      createStartedAgentTask("task-revised-snapshot")
    ], [
      createCompletedAgentTask("task-revised-research-1", "succeeded", "initial revision research"),
      createCompletedAgentTask("task-revised-plan-1", "succeeded", "initial dispatch plan"),
      createCompletedAgentTask("task-revised-research-2", "succeeded", "updated revision research"),
      createCompletedAgentTask("task-revised-plan-2", "succeeded", "approved revised dispatch plan"),
      createCompletedAgentTask("task-revised-dispatch", "succeeded", "revised dispatch output"),
      createCompletedAgentTask("task-revised-report", "succeeded", releaseReportOutput("revised dispatch")),
      createCompletedAgentTask("task-revised-snapshot", "succeeded", JSON.stringify({
        completedItems: ["Revised plan executed."],
        keyDecisions: ["Use revised plan."],
        validatedFacts: ["revision 2 was approved"],
        openQuestions: [],
        activeRisks: [],
        assumptions: [],
        recommendedNextStep: "complete",
        summary: "revised dispatch snapshot"
      }))
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const started = await waitForRunStatus(store, run.id, "waiting_approval");
    const requirement1 = started?.approvalRequests?.find((request) => request.kind === "iteration_requirement_plan");
    if (!requirement1) throw new Error("Expected initial requirement approval.");

    await worker.applyApprovalRequest(blueprint, run, requirement1.id, "revise", {
      message: "Tighten the execution plan."
    });
    const replyView = await store.getRunView(run.id);
    const requirement2 = replyView?.approvalRequests
      ?.filter((request) => request.kind === "iteration_requirement_plan" && request.status === "pending")
      .at(-1);
    const currentRun = await store.getBlueprintRun(run.id);
    if (!currentRun || !requirement2) throw new Error("Expected pending requirement approval.");
    await worker.applyApprovalRequest(blueprint, currentRun, requirement2.id, "approve");

    const reportView = await waitForRunView(store, run.id, (view) =>
      (view.approvalRequests ?? []).some((request) => request.kind === "manager_release_report" && request.status === "pending")
    );
    const managerRunInput = reportView.nodeRuns.find((nodeRun) => isRuntimeNodeRun(nodeRun) && nodeRun.nodeId === "top-manager")?.input;
    const round = reportView.iterationRounds?.[0];

    expect(round).toMatchObject({
      approvedRequirementRequestId: requirement2.id,
      approvedRequirementRevision: 2
    });
    expect(managerRunInput).toMatchObject({
      runContext: expect.objectContaining({
        currentPlan: expect.objectContaining({
          requestId: requirement2.id,
          revision: 2,
          body: expect.stringContaining("approved revised dispatch plan")
        })
      })
    });
    const waitingRun = await store.getBlueprintRun(run.id);
    if (waitingRun) await worker.cancelRun(waitingRun);
  });

  it("keeps release report rejection as a denial without rerunning the round", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createSelfIterationBlueprint({ maxRounds: 1 });
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-reject-research"),
      createStartedAgentTask("task-reject-plan"),
      createStartedAgentTask("task-rejected-round"),
      createStartedAgentTask("task-rejected-report")
    ], [
      createCompletedAgentTask("task-reject-research", "succeeded", "reject test research"),
      createCompletedAgentTask("task-reject-plan", "succeeded", "reject test plan"),
      createCompletedAgentTask("task-rejected-round", "succeeded", htmlArtifactOutput("needs work")),
      createCompletedAgentTask("task-rejected-report", "succeeded", releaseReportOutput("needs work"))
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const started = await waitForRunStatus(store, run.id, "waiting_approval");
    const requirement = started?.approvalRequests?.find((request) => request.kind === "iteration_requirement_plan");
    const currentRun1 = await store.getBlueprintRun(run.id);
    if (!currentRun1 || !requirement) throw new Error("Expected requirement approval.");
    await worker.applyApprovalRequest(blueprint, currentRun1, requirement.id, "approve");

    const report1View = await waitForRunView(store, run.id, (view) =>
      view.run.status === "waiting_approval" &&
      (view.releaseReports ?? []).length === 1 &&
      (view.approvalRequests ?? []).some((request) => request.kind === "manager_release_report" && request.status === "pending")
    );
    const report1 = report1View.approvalRequests?.find((request) =>
      request.kind === "manager_release_report" && request.status === "pending"
    );
    const currentRun2 = await store.getBlueprintRun(run.id);
    if (!currentRun2 || !report1) throw new Error("Expected first release report.");
    await worker.applyApprovalRequest(blueprint, currentRun2, report1.id, "reject", { comment: "Fix the page." });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const rejectedView = await store.getRunView(run.id);
    const rejectedReport = rejectedView?.approvalRequests?.find((request) => request.id === report1.id);

    expect(rejectedView?.run.status).toBe("waiting_approval");
    expect(rejectedReport).toMatchObject({ status: "rejected" });
    expect(rejectedView?.approvalRequests?.filter((request) => request.kind === "manager_release_report" && request.status === "pending")).toHaveLength(0);
    expect(adapter.calls.filter((call) => call.agentName === "builder")).toHaveLength(1);
    expect(rejectedView?.nodeRuns.filter((nodeRun) => isRuntimeNodeRun(nodeRun) && nodeRun.nodeId === "top-manager")).toHaveLength(2);
    expect(rejectedView?.nodeRuns.filter((nodeRun) => isRuntimeNodeRun(nodeRun) && nodeRun.nodeId === "slot-1")).toHaveLength(1);
    expect(rejectedView?.nodeRuns.filter((nodeRun) => isRuntimeNodeRun(nodeRun) && nodeRun.nodeId === "builder")).toHaveLength(1);
    expect(rejectedView?.releaseReports?.map((report) => report.version)).toEqual([1]);
    expect(rejectedView?.artifacts?.some((artifact) => artifact.status === "rejected")).toBe(true);
    expect(rejectedView?.approvalDecisions?.map((decision) => decision.action)).toEqual([
      "approve",
      "reject"
    ]);
  }, 30_000);

  it("reruns the manager when revising a release report", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createSelfIterationBlueprint({ maxRounds: 1 });
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-report-revise-research"),
      createStartedAgentTask("task-report-revise-plan"),
      createStartedAgentTask("task-report-revise-build"),
      createStartedAgentTask("task-report-revise-release-1"),
      createStartedAgentTask("task-report-revise-release-2")
    ], [
      createCompletedAgentTask("task-report-revise-research", "succeeded", "revise report research"),
      createCompletedAgentTask("task-report-revise-plan", "succeeded", "revise report plan"),
      createCompletedAgentTask("task-report-revise-build", "succeeded", htmlArtifactOutput("revise report")),
      createCompletedAgentTask("task-report-revise-release-1", "succeeded", releaseReportOutput("initial revise report")),
      createCompletedAgentTask("task-report-revise-release-2", "succeeded", releaseReportOutput("manager revised report"))
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const started = await waitForRunStatus(store, run.id, "waiting_approval");
    const requirement = started.approvalRequests?.find((request) => request.kind === "iteration_requirement_plan");
    const currentRun1 = await store.getBlueprintRun(run.id);
    if (!currentRun1 || !requirement) throw new Error("Expected requirement approval.");
    await worker.applyApprovalRequest(blueprint, currentRun1, requirement.id, "approve");

    const report1View = await waitForRunView(store, run.id, (view) =>
      view.run.status === "waiting_approval" &&
      (view.approvalRequests ?? []).some((request) => request.kind === "manager_release_report" && request.status === "pending")
    );
    const report1 = report1View.approvalRequests?.find((request) =>
      request.kind === "manager_release_report" && request.status === "pending"
    );
    const currentRun2 = await store.getBlueprintRun(run.id);
    if (!currentRun2 || !report1) throw new Error("Expected first release report.");
    await worker.applyApprovalRequest(blueprint, currentRun2, report1.id, "revise", {
      message: "Rewrite with real source notes."
    });

    const revisedView = await store.getRunView(run.id);
    const oldReportApproval = revisedView?.approvalRequests?.find((request) => request.id === report1.id);
    const report2 = revisedView?.approvalRequests
      ?.filter((request) => request.kind === "manager_release_report" && request.status === "pending")
      .at(-1);
    const releaseReports = revisedView?.releaseReports ?? [];
    const revisionCall = adapter.calls.at(-1);

    expect(oldReportApproval).toMatchObject({
      status: "superseded",
      supersededByRequestId: report2?.id
    });
    expect(report2).toMatchObject({
      revision: 2,
      body: expect.stringContaining("manager revised report release report written by the manager")
    });
    expect(releaseReports.map((report) => report.version)).toEqual([1, 2]);
    expect(releaseReports.at(-1)).toMatchObject({
      approvalRequestId: report2?.id,
      summary: expect.stringContaining("manager revised report release report written by the manager"),
      supersedesReportId: releaseReports[0]?.id
    });
    expect(revisionCall?.agentName).toBe("manager");
    expect(revisionCall?.prompt).toContain("release report revision");
    expect(revisionCall?.input).toMatchObject({
      task: "self_iteration_release_report",
      revision: expect.objectContaining({
        feedback: "Rewrite with real source notes."
      })
    });
    expect(adapter.calls.map((call) => call.agentName)).toEqual(["manager", "manager", "builder", "manager", "manager"]);
  }, 30_000);

  it("freezes pending lifecycle approvals when a self-iteration run is cancelled", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createSelfIterationBlueprint({ maxRounds: 1 });
    const adapter = new ScriptedAdapter([], []);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const started = await waitForRunStatus(store, run.id, "waiting_approval");
    const requirement = started?.approvalRequests?.find((request) => request.kind === "iteration_requirement_plan");
    if (!requirement) throw new Error("Expected requirement approval.");

    const cancelled = await worker.cancelRun(run);
    expect(cancelled.status).toBe("cancelled");

    const cancelledView = await store.getRunView(run.id);
    const frozenRequirement = cancelledView?.approvalRequests?.find((request) => request.id === requirement.id);
    expect(frozenRequirement).toMatchObject({
      status: "superseded",
      capabilities: expect.objectContaining({ approve: false, reject: false, reply: false, complete: false })
    });
    await expect(worker.applyApprovalRequest(blueprint, cancelled, requirement.id, "approve"))
      .rejects.toThrow("Run is already finished.");
    expect((await store.getBlueprintRun(run.id))?.status).toBe("cancelled");
    expect(adapter.calls.map((call) => call.agentName)).toEqual(["manager"]);
  });

  it("keeps release report replies as pending comments without starting the next round", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createSelfIterationBlueprint({ maxRounds: 1 });
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-report-reply-research-1"),
      createStartedAgentTask("task-report-reply-plan-1"),
      createStartedAgentTask("task-report-reply-build-1"),
      createStartedAgentTask("task-report-reply-release-1"),
      createStartedAgentTask("task-report-reply-research-2"),
      createStartedAgentTask("task-report-reply-plan-2")
    ], [
      createCompletedAgentTask("task-report-reply-research-1", "succeeded", "round 1 research"),
      createCompletedAgentTask("task-report-reply-plan-1", "succeeded", "round 1 plan"),
      createCompletedAgentTask("task-report-reply-build-1", "succeeded", "<!doctype html><html><body>reply round</body></html>"),
      createCompletedAgentTask("task-report-reply-release-1", "succeeded", releaseReportOutput("report reply")),
      createCompletedAgentTask("task-report-reply-research-2", "succeeded", "round 2 research after report feedback"),
      createCompletedAgentTask("task-report-reply-plan-2", "succeeded", "round 2 plan with clearer artifact notes")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const started = await waitForRunStatus(store, run.id, "waiting_approval");
    const requirement = started?.approvalRequests?.find((request) => request.kind === "iteration_requirement_plan");
    const currentRun1 = await store.getBlueprintRun(run.id);
    if (!currentRun1 || !requirement) throw new Error("Expected requirement approval.");
    await worker.applyApprovalRequest(blueprint, currentRun1, requirement.id, "approve");

    const report1View = await waitForRunView(store, run.id, (view) =>
      view.run.status === "waiting_approval" &&
      (view.approvalRequests ?? []).some((request) => request.kind === "manager_release_report" && request.status === "pending")
    );
    const report1 = report1View.approvalRequests?.find((request) =>
      request.kind === "manager_release_report" && request.status === "pending"
    );
    const currentRun2 = await store.getBlueprintRun(run.id);
    if (!currentRun2 || !report1) throw new Error("Expected release report.");
    await worker.applyApprovalRequest(blueprint, currentRun2, report1.id, "reply", { message: "Add clearer artifact notes." });

    const replyView = await store.getRunView(run.id);
    const oldReportApproval = replyView?.approvalRequests?.find((request) => request.id === report1.id);
    const pendingReportApproval = replyView?.approvalRequests
      ?.filter((request) => request.kind === "manager_release_report" && request.status === "pending")
      .at(-1);
    const pendingRequirement = replyView?.approvalRequests
      ?.filter((request) => request.kind === "iteration_requirement_plan" && request.status === "pending")
      .at(-1);
    const releaseReports = replyView?.releaseReports ?? [];
    const sessions = await store.listIterationSessions(run.id);

    expect(oldReportApproval).toMatchObject({
      status: "pending",
      capabilities: expect.objectContaining({ approve: false, reply: true, complete: true })
    });
    expect(pendingReportApproval?.id).toBe(report1.id);
    expect(pendingRequirement).toBeUndefined();
    expect(releaseReports.map((report) => report.version)).toEqual([1]);
    expect(sessions[0]).toMatchObject({
      status: "running",
      maxRounds: 1
    });
    expect(adapter.calls.map((call) => call.agentName)).toEqual(["manager", "manager", "builder", "manager"]);
    expect(replyView?.run.status).toBe("waiting_approval");
    expect(replyView?.approvalDecisions?.map((decision) => decision.action)).toEqual(["approve", "reply"]);
  });

  it("carries release report approval replies into next round context when later approved", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createSelfIterationBlueprint({ maxRounds: 2 });
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-report-feedback-research-1"),
      createStartedAgentTask("task-report-feedback-plan-1"),
      createStartedAgentTask("task-report-feedback-build-1"),
      createStartedAgentTask("task-report-feedback-release-1"),
      createStartedAgentTask("task-report-feedback-snapshot-1"),
      createStartedAgentTask("task-report-feedback-research-2"),
      createStartedAgentTask("task-report-feedback-plan-2")
    ], [
      createCompletedAgentTask("task-report-feedback-research-1", "succeeded", "round 1 research"),
      createCompletedAgentTask("task-report-feedback-plan-1", "succeeded", "round 1 plan"),
      createCompletedAgentTask("task-report-feedback-build-1", "succeeded", htmlArtifactOutput("feedback round")),
      createCompletedAgentTask("task-report-feedback-release-1", "succeeded", releaseReportOutput("feedback round")),
      createCompletedAgentTask("task-report-feedback-snapshot-1", "succeeded", JSON.stringify({
        completedItems: ["Round 1 feedback artifact completed."],
        keyDecisions: ["Carry feedback into round 2."],
        validatedFacts: ["feedback artifact exists"],
        openQuestions: [],
        activeRisks: [],
        assumptions: [],
        recommendedNextStep: "plan",
        summary: "feedback snapshot"
      })),
      createCompletedAgentTask("task-report-feedback-research-2", "succeeded", "round 2 research with feedback"),
      createCompletedAgentTask("task-report-feedback-plan-2", "succeeded", "round 2 plan with feedback fixes")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const started = await waitForRunStatus(store, run.id, "waiting_approval");
    const requirement = started?.approvalRequests?.find((request) => request.kind === "iteration_requirement_plan");
    const currentRun1 = await store.getBlueprintRun(run.id);
    if (!currentRun1 || !requirement) throw new Error("Expected requirement approval.");
    await worker.applyApprovalRequest(blueprint, currentRun1, requirement.id, "approve");

    const reportView = await waitForRunView(store, run.id, (view) =>
      view.run.status === "waiting_approval" &&
      (view.approvalRequests ?? []).some((request) => request.kind === "manager_release_report" && request.status === "pending")
    );
    const report = reportView.approvalRequests?.find((request) =>
      request.kind === "manager_release_report" && request.status === "pending"
    );
    const currentRun2 = await store.getBlueprintRun(run.id);
    if (!currentRun2 || !report) throw new Error("Expected release report.");

    await worker.applyApprovalRequest(blueprint, currentRun2, report.id, "reply", {
      message: "Mouse clicks do not break blocks."
    });
    expect((await store.listApprovalReplies({ approvalRequestId: report.id })).map((reply) => reply.body)).toEqual([
      "Mouse clicks do not break blocks."
    ]);

    const currentRun3 = await store.getBlueprintRun(run.id);
    if (!currentRun3) throw new Error("Expected current run after reply.");
    await worker.applyApprovalRequest(blueprint, currentRun3, report.id, "approve", {
      comment: "Continue and fix character drift."
    });

    const nextRoundView = await waitForRunView(store, run.id, (view) =>
      (view.iterationRounds ?? []).some((round) => round.roundNumber === 2 && round.status === "requirement_pending")
    );
    const round2 = nextRoundView.iterationRounds?.find((round) => round.roundNumber === 2);
    const requirement2 = nextRoundView.approvalRequests?.find((request) => request.id === round2?.requirementRequestId);
    const round2ResearchCall = adapter.calls.find((call) =>
      isRecord(call.input) &&
      call.input.roundNumber === 2 &&
      typeof call.input.humanFeedback === "string" &&
      call.input.humanFeedback.includes("Mouse clicks do not break blocks.") &&
      call.input.humanFeedback.includes("Continue and fix character drift.")
    );

    expect(requirement2?.body).toContain("Mouse clicks do not break blocks.");
    expect(requirement2?.body).toContain("Continue and fix character drift.");
    expect(round2ResearchCall?.input).toMatchObject({
      humanFeedback: expect.stringContaining("Mouse clicks do not break blocks."),
      runContext: expect.objectContaining({
        mode: "research_resolution",
        lastRound: expect.objectContaining({
          humanFeedback: expect.stringContaining("Continue and fix character drift."),
          report: expect.objectContaining({
            approvalRequestId: report.id,
            artifactRefs: expect.arrayContaining([
              expect.objectContaining({ title: expect.stringContaining("feedback round") })
            ])
          })
        })
      })
    });
  }, 30_000);

  it("keeps requirement approval replies as comments without rerunning the requirement agent", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createSelfIterationBlueprint({ maxRounds: 1, requirementAgent: true });
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-requirements-research-1"),
      createStartedAgentTask("task-requirements-1"),
      createStartedAgentTask("task-requirements-research-2"),
      createStartedAgentTask("task-requirements-2")
    ], [
      createCompletedAgentTask("task-requirements-research-1", "succeeded", "initial research summary"),
      createCompletedAgentTask("task-requirements-1", "succeeded", "initial requirement plan"),
      createCompletedAgentTask("task-requirements-research-2", "succeeded", "revised research summary"),
      createCompletedAgentTask("task-requirements-2", "succeeded", "revised requirement plan from agent")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const started = await waitForRunStatus(store, run.id, "waiting_approval");
    const requirement1 = started?.approvalRequests?.find((request) => request.kind === "iteration_requirement_plan");
    if (!requirement1) throw new Error("Expected initial requirement approval.");

    await worker.applyApprovalRequest(blueprint, run, requirement1.id, "reply", {
      message: "Focus the plan on accessibility."
    });

    const replyView = await store.getRunView(run.id);
    const oldRequirement = replyView?.approvalRequests?.find((request) => request.id === requirement1.id);
    const pendingRequirement = replyView?.approvalRequests
      ?.filter((request) => request.kind === "iteration_requirement_plan" && request.status === "pending")
      .at(-1);

    expect(adapter.calls.map((call) => call.agentName)).toEqual(["manager", "requirements"]);
    expect(oldRequirement).toMatchObject({
      status: "pending"
    });
    expect(oldRequirement?.supersededByRequestId).toBeUndefined();
    expect(pendingRequirement).toMatchObject({
      id: requirement1.id,
      title: "Round 1 Execution Plan",
      body: expect.stringContaining("initial requirement plan"),
      revision: 1
    });
    expect(replyView?.approvalDecisions?.filter((decision) => decision.action === "reply")).toEqual([
      expect.objectContaining({ approvalRequestId: requirement1.id, resultingStatus: "pending" })
    ]);
  });

  it("keeps a requirement approval open after a reply so it can still be approved", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createSelfIterationBlueprint({ maxRounds: 1, requirementAgent: true });
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-close-research-1"),
      createStartedAgentTask("task-close-requirements-1")
    ], [
      createCompletedAgentTask("task-close-research-1", "succeeded", "initial research summary"),
      createCompletedAgentTask("task-close-requirements-1", "succeeded", "initial requirement plan")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const started = await waitForRunStatus(store, run.id, "waiting_approval");
    const requirement1 = started?.approvalRequests?.find((request) => request.kind === "iteration_requirement_plan");
    if (!requirement1) throw new Error("Expected initial requirement approval.");

    await worker.applyApprovalRequest(blueprint, run, requirement1.id, "reply", {
      message: "Add keyboard controls before execution."
    });

    const replyView = await store.getRunView(run.id);
    const requirementAfterReply = replyView?.approvalRequests?.find((request) => request.id === requirement1.id);
    expect(requirementAfterReply).toMatchObject({
      status: "pending",
      revision: 1,
      capabilities: expect.objectContaining({ approve: true, reply: true })
    });
    expect(replyView?.approvalDecisions?.find((decision) => decision.approvalRequestId === requirement1.id)).toMatchObject({
      action: "reply",
      comment: "Add keyboard controls before execution.",
      resultingStatus: "pending"
    });
    expect(adapter.calls.map((call) => call.agentName)).toEqual(["manager", "requirements"]);

    const currentRun = await store.getBlueprintRun(run.id);
    if (!currentRun) throw new Error("Expected current run.");
    await worker.applyApprovalRequest(blueprint, currentRun, requirement1.id, "approve");
    const approvedView = await store.getRunView(run.id);
    expect(approvedView?.approvalRequests?.find((request) => request.id === requirement1.id)).toMatchObject({
      status: "approved"
    });
  });

  it("auto-resolves self-iteration approvals while still recording requests and decisions", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createSelfIterationBlueprint({
      maxRounds: 1,
      autoApproveRequirements: true,
      autoApproveReleaseReports: true
    });
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-auto-research"),
      createStartedAgentTask("task-auto-plan"),
      createStartedAgentTask("task-auto-round"),
      createStartedAgentTask("task-auto-report"),
      createStartedAgentTask("task-auto-snapshot")
    ], [
      createCompletedAgentTask("task-auto-research", "succeeded", "auto research"),
      createCompletedAgentTask("task-auto-plan", "succeeded", "auto execution plan"),
      createCompletedAgentTask("task-auto-round", "succeeded", {
        humanReportMd: "## Auto builder report\n\nReadable auto result.",
        handoffJson: { conclusion: "auto handoff conclusion" },
        result: "SECRET_RAW_OUTPUT"
      }),
      createCompletedAgentTask("task-auto-report", "succeeded", {
        humanReportMd: "## Summary\n\nAuto builder report confirmed by manager.\n\n## Delivery location\n\nNone\n\n## Completed Work\n\nAuto builder report.\n\n## Handoff\n\nauto handoff conclusion",
        handoffJson: { conclusion: "auto handoff conclusion" },
        result: { status: "ready_for_confirmation" }
      }),
      createCompletedAgentTask("task-auto-snapshot", "succeeded", JSON.stringify({
        completedItems: ["Auto round output completed."],
        keyDecisions: ["Auto complete final round."],
        validatedFacts: ["auto output exists"],
        openQuestions: [],
        activeRisks: [],
        assumptions: [],
        recommendedNextStep: "complete",
        summary: "auto snapshot"
      }))
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const completed = await waitForRunTerminal(store, run.id);

    expect(completed?.run.status).toBe("succeeded");
    expect(adapter.calls.map((call) => call.agentName)).toEqual(["manager", "manager", "builder", "manager", "manager"]);
    expect(completed?.nodeRuns.some((nodeRun) => nodeRun.nodeId === "top-manager")).toBe(true);
    expect(completed?.nodeRuns.some((nodeRun) => nodeRun.nodeId === "slot-1")).toBe(true);
    expect(completed?.approvalRequests?.map((request) => request.kind)).toEqual([
      "iteration_requirement_plan",
      "manager_release_report"
    ]);
    expect(completed?.approvalRequests?.map((request) => request.status).sort()).toEqual(["approved", "completed"]);
    expect(completed?.approvalDecisions?.map((decision) => [decision.action, decision.actor])).toEqual([
      ["auto_approve", "system"],
      ["complete", "system"]
    ]);
    expect(completed?.releaseReports?.[0]?.summary).toContain("Auto builder report");
    expect(completed?.releaseReports?.[0]?.summary).toContain("auto handoff conclusion");
    expect(completed?.releaseReports?.[0]?.summary).not.toContain("Raw output summary");
    expect(completed?.releaseReports?.[0]?.summary).not.toContain("SECRET_RAW_OUTPUT");
    expect(completed?.managerMail?.map((mail) => mail.status).sort()).toEqual(["approved", "completed"]);
  });

  it("runs manager self-iteration end-to-end on SQLite without run JSON archives", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-sqlite-"));
    const store = new SqliteHivewardStore(path.join(tempDir, "hiveward.sqlite"));
    await store.init();

    try {
      const blueprint = createSelfIterationBlueprint({
        maxRounds: 1,
        autoApproveRequirements: true,
        autoApproveReleaseReports: true
      });
      const adapter = new ScriptedAdapter([
        createStartedAgentTask("task-sqlite-research"),
        createStartedAgentTask("task-sqlite-plan"),
        createStartedAgentTask("task-sqlite-round"),
        createStartedAgentTask("task-sqlite-report"),
        createStartedAgentTask("task-sqlite-snapshot")
      ], [
        createCompletedAgentTask("task-sqlite-research", "succeeded", "sqlite research"),
        createCompletedAgentTask("task-sqlite-plan", "succeeded", "sqlite execution plan"),
        createCompletedAgentTask("task-sqlite-round", "succeeded", htmlArtifactOutput("sqlite round")),
        createCompletedAgentTask("task-sqlite-report", "succeeded", releaseReportOutput("sqlite round")),
        createCompletedAgentTask("task-sqlite-snapshot", "succeeded", JSON.stringify({
          completedItems: ["SQLite round output completed."],
          keyDecisions: ["Complete the SQLite-backed run."],
          validatedFacts: ["sqlite artifact exists"],
          openQuestions: [],
          activeRisks: [],
          assumptions: [],
          recommendedNextStep: "complete",
          summary: "sqlite snapshot"
        }))
      ]);
      const worker = new BlueprintWorker(store, adapter);

      const run = await worker.startRun(blueprint, "test-user");
      const completed = await waitForRunTerminal(store, run.id);
      const runArchiveDir = path.join(tempDir, "runs");
      const htmlArtifacts = completed?.artifacts?.filter((artifact) => artifact.kind === "html") ?? [];
      const releaseReport = completed?.releaseReports?.[0];

      expect(completed?.run.status).toBe("succeeded");
      expect(htmlArtifacts).toHaveLength(1);
      expect(htmlArtifacts[0]).toMatchObject({
        downloadUrl: expect.stringContaining("/artifacts/"),
        status: "current"
      });
      expect(htmlArtifacts[0]?.relativePath).toMatch(/^objects\/sha256\//);
      expect(releaseReport?.artifactRefs).toEqual([expect.objectContaining({
        artifactId: htmlArtifacts[0]?.id,
        location: htmlArtifacts[0]?.downloadUrl
      })]);
      expect(completed?.approvalRequests?.map((request) => request.status).sort()).toEqual(["approved", "completed"]);
      expect(existsSync(runArchiveDir)).toBe(false);
    } finally {
      store.close();
    }
  }, 15_000);

  it("does not auto-approve a blocked self-iteration request", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createSelfIterationBlueprint({
      maxRounds: 1,
      autoApproveRequirements: true,
      autoApproveReleaseReports: true,
      researchAgent: true
    });
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-blocked-auto-research")
    ], [
      createCompletedAgentTask("task-blocked-auto-research", "succeeded", {
        hardBlocker: true,
        reason: "Missing credential.",
        humanReportMd: "## Missing credential\n\nAdd the API credential before this round can execute."
      })
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunStatus(store, run.id, "waiting_approval");
    const request = view?.approvalRequests?.find((approval) => approval.kind === "iteration_requirement_plan");

    expect(run.status).toBe("running");
    expect(view.run.status).toBe("waiting_approval");
    expect(request).toMatchObject({
      status: "pending",
      capabilities: expect.objectContaining({ approve: false, reply: true })
    });
    expect(request?.body).toContain("Missing credential");
    expect(request?.body).toContain("Add the API credential");
    expect(adapter.calls.map((call) => call.agentName)).toEqual(["research"]);
    expect(view?.nodeRuns.some((nodeRun) => nodeRun.nodeId === "builder")).toBe(false);
  });

  it("does not infer a hard blocker from plain text preflight output", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createSelfIterationBlueprint({ maxRounds: 1, researchAgent: true });
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-text-research"),
      createStartedAgentTask("task-text-plan")
    ], [
      createCompletedAgentTask("task-text-research", "succeeded", "Credential constraints are mentioned but not blocking."),
      createCompletedAgentTask("task-text-plan", "succeeded", "plain text execution plan")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunStatus(store, run.id, "waiting_approval");
    const request = view?.approvalRequests?.find((approval) => approval.kind === "iteration_requirement_plan");

    expect(run.status).toBe("running");
    expect(view.run.status).toBe("waiting_approval");
    expect(request).toMatchObject({
      status: "pending",
      capabilities: expect.objectContaining({ approve: true })
    });
    expect(request?.body).toContain("plain text execution plan");
  });

  it("stores agent reports and passes report handoff and artifact refs downstream without raw output", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const producer = createAgentNode("producer", "Producer", { x: 120, y: 180 });
    const consumer = createAgentNode("consumer", "Consumer", { x: 360, y: 180 });
    const blueprint = createBlueprint([
      producer,
      consumer
    ], [
      { id: "edge-producer-consumer", source: "producer", target: "consumer" }
    ]);
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-producer"),
      createStartedAgentTask("task-consumer")
    ], [
      createCompletedAgentTask("task-producer", "succeeded", {
        humanReportMd: "## Producer report\n\nThe producer made structured facts for the next agent.",
        handoffJson: { facts: ["handoff fact"], next: "consumer" },
        result: {
          ok: true,
          rawHtml: "<!doctype html><html><body>large deliverable should stay behind an artifact ref</body></html>"
        },
        artifacts: [{
          kind: "html",
          title: "Producer preview",
          content: "<!doctype html><html><body>preview</body></html>"
        }]
      }),
      createCompletedAgentTask("task-consumer", "succeeded", {
        summary: "Consumer used the handoff.",
        result: { done: true }
      })
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const completed = await waitForRunTerminal(store, run.id);
    const producerRun = completed?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "producer");
    const consumerRun = completed?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "consumer");
    const upstream = isRecord(consumerRun?.input) && Array.isArray(consumerRun.input.upstream)
      ? consumerRun.input.upstream
      : [];

    expect(adapter.calls[0]?.prompt).toContain("humanReportMd");
    expect(adapter.calls[0]?.prompt).toContain("handoffJson");
    expect(adapter.calls[0]?.prompt).toContain("downstream consumers");
    expect(adapter.calls[1]?.prompt).toContain("humanReportMd");
    expect(adapter.calls[1]?.prompt).toContain("handoffJson");
    expect(completed?.agentHumanReports).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: "producer",
        nodeRunId: producerRun?.id,
        source: "agent",
        bodyMd: expect.stringContaining("Producer report")
      }),
      expect.objectContaining({
        nodeId: "consumer",
        source: "fallback",
        bodyMd: expect.stringContaining("Consumer used the handoff")
      })
    ]));
    expect(completed?.agentHandoffs).toEqual([
      expect.objectContaining({
        nodeId: "producer",
        nodeRunId: producerRun?.id,
        payload: { facts: ["handoff fact"], next: "consumer" }
      })
    ]);
    expect(upstream[0]).toMatchObject({
      handoffJson: { facts: ["handoff fact"], next: "consumer" },
      humanReportMd: expect.stringContaining("Producer report"),
      artifacts: [
        expect.objectContaining({
          title: "Producer preview",
          kind: "html",
          downloadUrl: expect.stringContaining("/artifacts/")
        })
      ]
    });
    expect(upstream[0]).not.toHaveProperty("output");
    expect(producerRun?.output).toMatchObject({
      result: expect.objectContaining({ ok: true })
    });
  });

  it("reruns the loop output branch until the loop reaches max iterations", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const blueprint = createBlueprint(
      [
        createAgentNode("brief", "Brief"),
        {
          id: "loop",
          type: "loop",
          position: { x: 420, y: 180 },
          config: {
            label: "Loop",
            maxIterations: 2
          }
        }
      ],
      [
        { id: "brief-loop", source: "brief", target: "loop", condition: "success" },
        { id: "loop-brief", source: "loop", target: "brief", condition: "success" }
      ]
    );
    const worker = new BlueprintWorker(
      store,
      new ScriptedAdapter([
        createStartedAgentTask("task-1"),
        createStartedAgentTask("task-2")
      ], [
        createCompletedAgentTask("task-1", "succeeded", "brief ready"),
        createCompletedAgentTask("task-2", "succeeded", "brief ready again")
      ])
    );

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);

    expect(view?.run.status).toBe("succeeded");
    expect(view?.nodeRuns.filter((nodeRun) => nodeRun.nodeId === "brief" && nodeRun.status === "succeeded")).toHaveLength(2);
    expect(view?.nodeRuns.filter((nodeRun) => nodeRun.nodeId === "loop").map((nodeRun) => (nodeRun.output as { status?: string }).status)).toEqual([
      "rerun",
      "completed"
    ]);
    expect(view?.nodeRuns.filter((nodeRun) => nodeRun.nodeId === "loop").at(-1)?.output).toEqual({
      status: "completed",
      iteration: 2,
      maxIterations: 2,
      rerunTargets: [{ nodeId: "brief", nodeLabel: "Brief" }],
      upstream: [expect.objectContaining({ nodeId: "brief", nodeLabel: "Brief", status: "succeeded", humanReportMd: "brief ready again" })]
    });
  });
});

function createStartedAgentTask(taskId: string, source: StartedAgentTaskResult["source"] = "openclaw"): StartedAgentTaskResult {
  return {
    taskId,
    runId: `${taskId}-run`,
    sessionKey: "agent:main:main",
    source,
    status: "running",
    updatedAt: new Date().toISOString()
  };
}

function htmlArtifactOutput(label: string): Record<string, unknown> {
  return {
    contractVersion: 2,
    humanReportMd: `## Builder report\n\n${label}`,
    handoffJson: { delivered: label },
    result: { label },
    artifacts: [{
      slot: "html",
      title: `${label} HTML`,
      kind: "html",
      content: `<!doctype html><html><body>${label}</body></html>`
    }]
  };
}

function releaseReportOutput(label: string): Record<string, unknown> {
  return {
    contractVersion: 2,
    humanReportMd: [
      "## Summary",
      "",
      `${label} release report written by the manager.`,
      "",
      "## Delivery location",
      "",
      "None",
      "",
      "## Completed Work",
      "",
      `Builder delivered ${label}.`
    ].join("\n"),
    handoffJson: { releaseReport: label },
    result: { status: "ready_for_confirmation", summary: label }
  };
}

function markdownArtifactOutput(markdown: string, title: string): Record<string, unknown> {
  return {
    contractVersion: 2,
    humanReportMd: markdown,
    result: { summary: markdown },
    artifacts: [{
      slot: "research",
      title,
      kind: "markdown",
      content: markdown
    }]
  };
}

function createCompletedAgentTask(
  taskId: string,
  status: AgentTaskResult["status"],
  output?: unknown,
  error?: string,
  source: AgentTaskResult["source"] = "openclaw"
): AgentTaskResult {
  return {
    taskId,
    runId: `${taskId}-run`,
    sessionKey: "agent:main:main",
    source,
    status,
    output,
    error,
    updatedAt: new Date().toISOString()
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentApprovalWaitingOutputForTest(value: unknown): value is {
  approvalType: "agent";
  reviewOutput: unknown;
  replies: Array<{ id: string; body: string }>;
} {
  return isRecord(value) && value.approvalType === "agent" && Array.isArray(value.replies);
}

async function waitForCondition(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timed out waiting for ${label}.`);
}

async function waitForRunTerminal(store: HivewardStore, runId: string): Promise<Awaited<ReturnType<HivewardStore["getRunView"]>>> {
  const deadline = Date.now() + 10_000;
  let lastView: Awaited<ReturnType<HivewardStore["getRunView"]>> | undefined;

  while (Date.now() < deadline) {
    const view = await store.getRunView(runId);
    lastView = view;
    if (view && !["queued", "running", "waiting_approval"].includes(view.run.status)) {
      return view;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Blueprint run did not reach a terminal state in time: ${runId}; last status=${lastView?.run.status}; approvals=${lastView?.approvalRequests?.map((request) => `${request.kind}:${request.status}:${request.requestedBy.nodeId}:approve=${request.capabilities.approve}:complete=${request.capabilities.complete}:body=${request.body.slice(0, 240)}`).join(",")}; nodes=${lastView?.nodeRuns.map((nodeRun) => `${nodeRun.nodeId}:${nodeRun.status}`).join(",")}`);
}

async function waitForRunStatus(
  store: HivewardStore,
  runId: string,
  status: BlueprintRunStatus
): Promise<NonNullable<Awaited<ReturnType<HivewardStore["getRunView"]>>>> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const view = await store.getRunView(runId);
    if (view?.run.status === status) {
      return view;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Blueprint run did not reach ${status} in time: ${runId}`);
}

async function waitForRunView(
  store: HivewardStore,
  runId: string,
  predicate: (view: NonNullable<Awaited<ReturnType<HivewardStore["getRunView"]>>>) => boolean,
  timeoutMs = 10_000
): Promise<NonNullable<Awaited<ReturnType<HivewardStore["getRunView"]>>>> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const view = await store.getRunView(runId);
    if (view && predicate(view)) {
      return view;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Blueprint run view did not match the expected state in time: ${runId}`);
}

async function waitForNodeRun(
  store: FileHivewardStore,
  runId: string,
  nodeId: string,
  predicate: (nodeRun: NonNullable<Awaited<ReturnType<FileHivewardStore["getRunView"]>>>["nodeRuns"][number]) => boolean
): Promise<NonNullable<Awaited<ReturnType<FileHivewardStore["getRunView"]>>>["nodeRuns"][number]> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const view = await store.getRunView(runId);
    const nodeRun = view?.nodeRuns.find((candidate) => candidate.nodeId === nodeId);
    if (nodeRun && predicate(nodeRun)) {
      return nodeRun;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Node run did not match the expected state in time: ${runId}/${nodeId}`);
}

function createBlueprint(nodes: BlueprintNode[], edges: BlueprintEdge[]): BlueprintDefinition {
  const now = new Date().toISOString();
  return {
    id: "test-blueprint",
    companyId: "company-hiveward-studio",
    name: "Test blueprint",
    version: 1,
    nodes,
    edges,
    variables: {},
    display: {
      viewport: { x: 0, y: 0, zoom: 1 }
    },
    createdAt: now,
    updatedAt: now
  };
}

function createUsageFact(inputTokens: number, outputTokens: number, costUsd: number) {
  return {
    id: "usage-1",
    modelId: "test-model",
    inputTokens,
    outputTokens,
    costUsd,
    recordedAt: new Date().toISOString()
  };
}

function createAgentNode(id: string, label: string, position = { x: 120, y: 180 }): BlueprintNode {
  return {
    id,
    type: "agent",
    runtimeId: "openclaw",
    position,
    config: {
      label,
      openclawAgentId: "main",
      agentName: id,
      prompt: `Run ${id}`,
      tools: []
    }
  };
}

function createSelfIterationBlueprint(config: {
  maxRounds: number;
  maxPreparationAttempts?: number;
  autoApproveRequirements?: boolean;
  autoApproveReleaseReports?: boolean;
  researchAgent?: boolean;
  requirementAgent?: boolean;
}): BlueprintDefinition {
  const builder = {
    ...createAgentNode("builder", "Builder", { x: 520, y: 180 }),
    parentId: "slot-1"
  };
  const researchSlot = config.researchAgent
    ? {
        id: "research-slot",
        type: "manager_slot" as const,
        position: { x: 300, y: -180 },
        config: {
          label: "Research Slot",
          managerNodeId: "top-manager",
          slot: 1,
          executionMode: "manual" as const
        }
      }
    : undefined;
  const requirementSlot = config.requirementAgent
    ? {
        id: "requirement-slot",
        type: "manager_slot" as const,
        position: { x: 300, y: -20 },
        config: {
          label: "Requirement Slot",
          managerNodeId: "top-manager",
          slot: 2,
          executionMode: "manual" as const
        }
      }
    : undefined;
  const requirementAgent = config.requirementAgent
    ? {
        ...createAgentNode("requirements", "Requirements", { x: 80, y: 360 }),
        parentId: "requirement-slot"
      }
    : undefined;
  const researchAgent = config.researchAgent
    ? {
        ...createAgentNode("research", "Research", { x: 80, y: 460 }),
        parentId: "research-slot"
      }
    : undefined;
  return createBlueprint(
    [
      {
        id: "top-manager",
        type: "manager",
        runtimeId: "openclaw",
        position: { x: 80, y: 180 },
        config: {
          label: "Top Manager",
          lifecycleMode: "self_iteration",
          dispatchMode: "sequential",
          portCount: 3,
          maxHandoffs: 3,
          maxRounds: config.maxRounds,
          maxPreparationAttempts: config.maxPreparationAttempts ?? 1,
          autoApproveRequirements: config.autoApproveRequirements,
          autoApproveReleaseReports: config.autoApproveReleaseReports,
          researchAgentNodeId: config.researchAgent ? "research" : undefined,
          requirementAgentNodeId: config.requirementAgent ? "requirements" : undefined,
          instructions: "Coordinate self-iteration rounds."
        }
      },
      ...(researchSlot ? [researchSlot] : []),
      ...(researchAgent ? [researchAgent] : []),
      ...(requirementSlot ? [requirementSlot] : []),
      ...(requirementAgent ? [requirementAgent] : []),
      {
        id: "slot-1",
        type: "manager_slot",
        position: { x: 300, y: 180 },
        config: {
          label: "Build Slot",
          managerNodeId: "top-manager",
          slot: 3,
          executionMode: "manual"
        }
      },
      builder
    ],
    [
      ...(researchSlot && researchAgent
        ? [
            {
              id: "edge-top-manager-research-slot",
              source: "top-manager",
              sourceHandle: "manager-out-1",
              target: "research-slot",
              targetHandle: "manager-slot-in"
            },
            {
              id: "edge-research-slot-top-manager",
              source: "research-slot",
              sourceHandle: "manager-slot-out",
              target: "top-manager",
              targetHandle: "manager-in-1"
            },
            {
              id: "edge-research-slot-agent",
              source: "research-slot",
              sourceHandle: "manager-slot-inner-out",
              target: "research"
            },
            {
              id: "edge-research-agent-slot",
              source: "research",
              target: "research-slot",
              targetHandle: "manager-slot-inner-in"
            }
          ]
        : []),
      ...(requirementSlot && requirementAgent
        ? [
            {
              id: "edge-top-manager-requirement-slot",
              source: "top-manager",
              sourceHandle: "manager-out-2",
              target: "requirement-slot",
              targetHandle: "manager-slot-in"
            },
            {
              id: "edge-requirement-slot-top-manager",
              source: "requirement-slot",
              sourceHandle: "manager-slot-out",
              target: "top-manager",
              targetHandle: "manager-in-2"
            },
            {
              id: "edge-requirement-slot-agent",
              source: "requirement-slot",
              sourceHandle: "manager-slot-inner-out",
              target: "requirements"
            },
            {
              id: "edge-requirement-agent-slot",
              source: "requirements",
              target: "requirement-slot",
              targetHandle: "manager-slot-inner-in"
            }
          ]
        : []),
      {
        id: "edge-top-manager-slot-1",
        source: "top-manager",
        sourceHandle: "manager-out-3",
        target: "slot-1",
        targetHandle: "manager-slot-in"
      },
      {
        id: "edge-slot-1-top-manager",
        source: "slot-1",
        sourceHandle: "manager-slot-out",
        target: "top-manager",
        targetHandle: "manager-in-3"
      },
      {
        id: "edge-slot-1-builder",
        source: "slot-1",
        sourceHandle: "manager-slot-inner-out",
        target: "builder"
      },
      {
        id: "edge-builder-slot-1",
        source: "builder",
        target: "slot-1",
        targetHandle: "manager-slot-inner-in"
      }
    ]
  );
}

function isRuntimeNodeRun(nodeRun: BlueprintNodeRun): boolean {
  return !nodeRun.id.startsWith("preflight-");
}
