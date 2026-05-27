import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeAdapter, RuntimeChatSessionResult, RuntimeChatSessionTitleResult } from "@hiveward/adapter";
import {
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
  type BlueprintRunStatus
} from "@hiveward/shared";
import { FileHivewardStore } from "../store/fileHivewardStore";
import { BlueprintWorker } from "./blueprintWorker";

class ScriptedAdapter implements RuntimeAdapter {
  readonly calls: StartAgentTaskInput[] = [];
  readonly waitCalls: WaitForAgentTaskInput[] = [];
  readonly sendCalls: SendChannelInput[] = [];

  constructor(
    private readonly startResults: StartedAgentTaskResult[],
    private readonly completionResults: Array<AgentTaskResult | Error>
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

  async createChatSession(): Promise<RuntimeChatSessionResult> {
    throw new Error("Chat session creation is not used by blueprint worker tests.");
  }

  async updateChatSessionTitle(): Promise<RuntimeChatSessionTitleResult> {
    throw new Error("Chat session title updates are not used by blueprint worker tests.");
  }

  async streamChatMessage(): Promise<void> {
    throw new Error("Chat stream is not used by blueprint worker tests.");
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
    const result = this.completionResults.shift();
    if (!result) {
      throw new Error("No scripted agent completion result available.");
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
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "brief")?.input).toEqual({ upstream: [] });
    const failedPlanRun = view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "plan");
    expect(failedPlanRun?.status).toBe("failed");
    expect(failedPlanRun?.input).toEqual({
      upstream: [expect.objectContaining({ nodeId: "brief", nodeLabel: "1. Brief", status: "succeeded", output: "brief ok" })]
    });
    expect((failedPlanRun?.input as { upstream?: Array<{ nodeRunId?: string; openclawRef?: { runId?: string } }> } | undefined)?.upstream?.[0])
      .toMatchObject({
        nodeRunId: expect.any(String),
        openclawRef: expect.objectContaining({ runId: "task-1-run" })
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
  });

  it("writes node input and OpenClaw ref to the run archive before the agent task finishes", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const storePath = path.join(tempDir, "hiveward-store.json");
    const store = new FileHivewardStore(storePath);
    await store.init();

    const blueprint = createBlueprint([createAgentNode("brief", "Brief")], []);
    const adapter = new BlockingAdapter(createStartedAgentTask("task-1"));
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const runningNode = await waitForNodeRun(store, run.id, "brief", (nodeRun) =>
      nodeRun.status === "running" && nodeRun.input !== undefined && nodeRun.openclawRef?.taskId === "task-1"
    );
    const archiveWhileRunning = JSON.parse(readFileSync(path.join(tempDir, "runs", `${run.id}.json`), "utf8")) as {
      nodeRuns: Array<{ nodeId: string; status: string; input?: unknown; openclawRef?: { taskId?: string; runId?: string } }>;
    };

    expect(runningNode.input).toEqual({ upstream: [] });
    expect(runningNode.openclawRef).toMatchObject({ taskId: "task-1", runId: "task-1-run" });
    expect(archiveWhileRunning.nodeRuns.find((nodeRun) => nodeRun.nodeId === "brief")).toMatchObject({
      status: "running",
      input: { upstream: [] },
      openclawRef: expect.objectContaining({ taskId: "task-1", runId: "task-1-run" })
    });

    adapter.complete(createCompletedAgentTask("task-1", "succeeded", "brief ok"));
    const view = await waitForRunTerminal(store, run.id);
    expect(view?.run.status).toBe("succeeded");
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
      openclawRef: {
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
    const firstWorker = new BlueprintWorker(store, missingTaskAdapter);
    await firstWorker.resumeActiveRuns();

    const stillRunningView = await waitForRunView(store, run.id, (view) =>
      view.events.some((event) => event.message.includes("is still running"))
    );
    expect(missingTaskAdapter.waitCalls).toHaveLength(1);
    expect(stillRunningView.run.status).toBe("running");
    expect(stillRunningView.nodeRuns.find((candidate) => candidate.id === nodeRun.id)?.status).toBe("running");
    expect(stillRunningView.events.some((event) => event.type === "blueprint.run.failed")).toBe(false);

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
    expect((adapter.calls[1]?.input as { upstream?: Array<{ output: unknown }> }).upstream?.[0]?.output).toBe("brief ready");
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
      prompt: "Return an executive summary."
    });
  });

  it("lets Agent approval replies revise output before approval sends the final answer", async () => {
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

    expect(repliedOutput.reviewOutput).toBe("final answer");
    expect(repliedOutput.replies.map((reply) => reply.role)).toEqual(["user", "assistant"]);
    expect(repliedOutput.replies.map((reply) => reply.body)).toEqual(["Use the final wording.", "final answer"]);
    expect(adapter.calls[1]?.input).toMatchObject({
      originalInput: {
        upstream: []
      },
      approvalReplies: [
        {
          role: "user",
          body: "Use the final wording."
        }
      ],
      approvalChat: {
        previousOutput: "draft answer",
        latestUserReply: "Use the final wording.",
        conversation: [
          {
            role: "user",
            body: "Use the final wording."
          }
        ]
      },
      humanApproval: {
        previousOutput: "draft answer",
        previousReplies: [],
        latestReply: "Use the final wording."
      }
    });
    expect(adapter.sendCalls).toHaveLength(0);

    await worker.approveRun(blueprint, repliedView.run, repliedNode.id, "Approved.");
    const finalView = await waitForRunTerminal(store, run.id);
    const finalNode = finalView?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery");

    expect(finalView?.run.status).toBe("succeeded");
    expect(finalNode).toMatchObject({
      status: "succeeded",
      output: {
        approvedOutput: "final answer",
        approval: {
          status: "approved",
          comment: "Approved.",
          replies: [
            {
              role: "user",
              body: "Use the final wording."
            },
            {
              role: "assistant",
              body: "final answer"
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
    expect(adapter.sendCalls[0]?.body).toContain("final answer");
  });

  it("approves the selected Agent approval reply instead of the latest review output", async () => {
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
    const firstAssistantReply = firstReplyOutput.replies.find((reply) => reply.role === "assistant")!;

    await worker.selectApprovalReply(blueprint, firstReplyView.run, firstReplyNode.id, firstAssistantReply.id);
    const selectedView = await waitForRunStatus(store, run.id, "waiting_approval");
    const selectedNode = selectedView.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery")!;
    const selectedOutput = selectedNode.output as {
      selectedReplyId: string;
      replies: Array<{ id: string; selected?: boolean }>;
    };
    expect(selectedOutput.selectedReplyId).toBe(firstAssistantReply.id);
    expect(selectedOutput.replies.find((reply) => reply.id === firstAssistantReply.id)?.selected).toBe(true);

    await worker.replyToApproval(blueprint, selectedView.run, selectedNode.id, "Try one more variant.");
    const secondReplyView = await waitForRunStatus(store, run.id, "waiting_approval");
    const secondReplyNode = secondReplyView.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery")!;
    const secondReplyOutput = secondReplyNode.output as {
      reviewOutput: string;
      selectedReplyId: string;
    };

    expect(secondReplyOutput.reviewOutput).toBe("second plan");
    expect(secondReplyOutput.selectedReplyId).toBe(firstAssistantReply.id);

    await worker.approveRun(blueprint, secondReplyView.run, secondReplyNode.id);
    const finalView = await waitForRunTerminal(store, run.id);
    const finalNode = finalView?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery");

    expect(finalView?.run.status).toBe("succeeded");
    expect(finalNode?.output).toMatchObject({
      approvedOutput: "first usable plan",
      approval: {
        status: "approved",
        selectedReplyId: firstAssistantReply.id
      }
    });
  });

  it("keeps the selected original approval message stable while later replies revise review output", async () => {
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

    expect(repliedOutput.reviewOutput).toBe("revised plan");
    expect(repliedOutput.selectedReplyId).toBe("reviewOutput");
    expect(repliedOutput.selectedOutput).toBe("original plan");

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

  it("fails the run instead of getting stuck when an Agent approval reply rerun fails", async () => {
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
    const finalView = await waitForRunTerminal(store, run.id);
    const failedNode = finalView?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "delivery");

    expect(finalView?.run.status).toBe("failed");
    expect(failedNode?.status).toBe("failed");
    expect(failedNode?.error).toBe("revision failed");
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
            output: "slot output"
          })
        ]
      }
    });
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
      openclawRef: {
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
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "gate")?.input).toEqual({
      upstream: [expect.objectContaining({ nodeId: "brief", nodeLabel: "Brief", status: "succeeded", output: "brief ready" })]
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
    expect((adapter.calls[1]?.input as { upstream?: Array<{ output: unknown }> }).upstream?.[0]?.output).toBe("brief ready");
    expect((adapter.calls[2]?.input as { upstream?: Array<{ output: unknown }> }).upstream?.[0]?.output).toBe("brief ready");
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

    await worker.approveRun(blueprint, waitingRun.run, secondApproval.id);
    await waitForNodeRun(store, run.id, "approval-b", (nodeRun) => nodeRun.status === "succeeded");
    const latestView = await waitForRunStatus(store, run.id, "waiting_approval");

    expect(latestView.nodeRuns.find((nodeRun) => nodeRun.id === firstApproval.id)?.status).toBe("waiting_approval");
    expect(latestView.nodeRuns.find((nodeRun) => nodeRun.id === secondApproval.id)?.status).toBe("succeeded");
    expect(latestView.nodeRuns.find((nodeRun) => nodeRun.id === secondApproval.id)?.output).toBe("B ready");
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
        ...createCompletedAgentTask("codex-task-1", "succeeded", "{\"ok\":true}"),
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
      timeoutMs: 120000
    });
    expect(adapter.waitCalls[0]).toMatchObject({
      source: "codex",
      sessionKey: "codex-session-start"
    });
    expect(view?.nodeRuns[0]?.openclawRef).toMatchObject({
      source: "codex",
      sourceId: "codex-task-1",
      sessionKey: "codex-session-final"
    });
    expect(view?.run.openclawRefs[0]?.source).toBe("codex");
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
          position: { x: 80, y: 180 },
          config: {
            label: "Manager",
            portCount: 3,
            maxHandoffs: 6,
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
      createStartedAgentTask("task-1"),
      createStartedAgentTask("task-2"),
      createStartedAgentTask("task-3"),
      createStartedAgentTask("task-4"),
      createStartedAgentTask("task-5")
    ], [
      createCompletedAgentTask("task-1", "succeeded", "prd ready"),
      createCompletedAgentTask("task-2", "succeeded", "app draft"),
      createCompletedAgentTask("task-3", "succeeded", JSON.stringify({ status: "fail", returnToSlot: 2, reason: "missing loading state" })),
      createCompletedAgentTask("task-4", "succeeded", "app fixed"),
      createCompletedAgentTask("task-5", "succeeded", JSON.stringify({ status: "pass" }))
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);

    expect(view?.run.status).toBe("succeeded");
    expect(view?.nodeRuns.filter((nodeRun) => nodeRun.nodeId === "dev" && nodeRun.status === "succeeded")).toHaveLength(2);
    expect(view?.nodeRuns.filter((nodeRun) => nodeRun.nodeId === "test" && nodeRun.status === "succeeded")).toHaveLength(2);
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "manager")?.status).toBe("succeeded");
    expect(adapter.calls.map((call) => call.agentName)).toEqual(["product", "dev", "test", "dev", "test"]);
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
        (adapter.calls[0]?.input as { upstream?: Array<{ output?: { manager?: { slot?: number } } }> }).upstream?.[0]?.output
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
      createStartedAgentTask("task-alpha"),
      createStartedAgentTask("task-beta")
    ], [
      createCompletedAgentTask("task-alpha", "succeeded", "alpha done"),
      createCompletedAgentTask("task-beta", "succeeded", "beta done")
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);
    const slotOutput = view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "parallel-slot")?.output;

    expect(view?.run.status).toBe("succeeded");
    expect(adapter.calls.map((call) => call.agentName)).toEqual(["alpha", "beta"]);
    expect(adapter.calls.every((call) => (call.input as { upstream?: Array<{ nodeId: string }> }).upstream?.[0]?.nodeId === "parallel-slot")).toBe(true);
    expect(slotOutput).toEqual(JSON.stringify({
      outputs: [
        { nodeId: "alpha", nodeLabel: "Alpha", output: "alpha done" },
        { nodeId: "beta", nodeLabel: "Beta", output: "beta done" }
      ]
    }));
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
    expect((adapter.calls[1]?.input as { upstream?: Array<{ nodeId: string; output?: unknown }> }).upstream?.[0]).toMatchObject({
      nodeId: "alpha",
      output: "alpha done"
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
      createCompletedAgentTask("task-manager", "succeeded", "use the obvious first slot"),
      createCompletedAgentTask("task-implementer", "succeeded", "implementation done"),
      createCompletedAgentTask("task-manager-complete", "succeeded", JSON.stringify({ status: "complete", reason: "single slot done" }))
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);

    expect(view?.run.status).toBe("succeeded");
    expect(adapter.calls.map((call) => call.agentName)).toEqual(["manager", "implementer", "manager"]);
    expect(adapter.calls[0]?.prompt).toContain("You are a Hiveward manager agent.");
    expect((adapter.calls[0]?.input as { delegationRoster?: { slots?: unknown[] } }).delegationRoster?.slots).toHaveLength(1);
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
    const firstWorker = new BlueprintWorker(store, blockedAdapter);

    const run = await firstWorker.startRun(blueprint, "test-user");
    await waitForNodeRun(store, run.id, "builder", (nodeRun) =>
      nodeRun.status === "running" && nodeRun.openclawRef?.taskId === "task-1"
    );

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
      createCompletedAgentTask("task-manager-1", "succeeded", JSON.stringify({ status: "continue", nextSlot: 1, reason: "start with research" })),
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
      createCompletedAgentTask("task-manager-2", "succeeded", JSON.stringify({ status: "continue", nextSlot: 2, reason: "build the page" })),
      createCompletedAgentTask(
        "task-3",
        "succeeded",
        "<!doctype html><html><body><h1>Agentic Workflow Brief</h1></body></html>"
      ),
      createCompletedAgentTask("task-manager-3", "succeeded", JSON.stringify({ status: "complete", reason: "HTML complete" }))
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

  it("fails an agent-driven manager when it completes after a failure-like slot output", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "hiveward-worker-"));
    const store = new FileHivewardStore(path.join(tempDir, "hiveward-store.json"));
    await store.init();

    const builder = {
      ...createAgentNode("builder", "Builder"),
      parentId: "builder-slot"
    };
    const blueprint = createBlueprint(
      [
        {
          id: "manager",
          type: "manager",
          runtimeId: "openclaw",
          position: { x: 80, y: 120 },
          config: {
            label: "Manager",
            openclawAgentId: "main",
            agentName: "manager",
            portCount: 1,
            maxHandoffs: 3,
            tools: []
          }
        },
        {
          id: "builder-slot",
          type: "manager_slot",
          position: { x: 420, y: 120 },
          config: {
            label: "Builder Slot",
            managerNodeId: "manager",
            slot: 1
          }
        },
        builder
      ],
      [
        { id: "manager-to-slot", source: "manager", target: "builder-slot", sourceHandle: "manager-out-1", targetHandle: "manager-slot-in", condition: "success" },
        { id: "slot-to-manager", source: "builder-slot", target: "manager", sourceHandle: "manager-slot-out", targetHandle: "manager-in-1", condition: "success" },
        { id: "slot-to-builder", source: "builder-slot", target: "builder", sourceHandle: "manager-slot-inner-out", condition: "success" },
        { id: "builder-to-slot", source: "builder", target: "builder-slot", targetHandle: "manager-slot-inner-in", condition: "success" }
      ]
    );
    const adapter = new ScriptedAdapter([
      createStartedAgentTask("task-manager-1"),
      createStartedAgentTask("task-builder"),
      createStartedAgentTask("task-manager-2")
    ], [
      createCompletedAgentTask("task-manager-1", "succeeded", JSON.stringify({ status: "continue", nextSlot: 1, reason: "build artifact" })),
      createCompletedAgentTask("task-builder", "succeeded", JSON.stringify({ status: "failed", generatedHtmlFilePath: null, reason: "read-only sandbox" })),
      createCompletedAgentTask("task-manager-2", "succeeded", JSON.stringify({ status: "complete", reason: "No artifact was generated." }))
    ]);
    const worker = new BlueprintWorker(store, adapter);

    const run = await worker.startRun(blueprint, "test-user");
    const view = await waitForRunTerminal(store, run.id);

    expect(view?.run.status).toBe("failed");
    const managerRun = view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "manager");
    expect(managerRun?.status).toBe("failed");
    expect(managerRun?.error).toBe("No artifact was generated.");
    expect(view?.nodeRuns.find((nodeRun) => nodeRun.nodeId === "builder-slot")?.output).toEqual(expect.stringContaining("\"status\":\"failed\""));
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
      createCompletedAgentTask("task-manager-1", "succeeded", JSON.stringify({ status: "continue", nextSlot: 3, reason: "先收集新闻" })),
      createCompletedAgentTask("task-news", "succeeded", "新闻简报：AI agent 正在进入企业运营。"),
      createCompletedAgentTask("task-manager-2", "succeeded", JSON.stringify({ status: "continue", nextSlot: 4, reason: "再写制作说明" })),
      createCompletedAgentTask("task-doc", "succeeded", "制作说明：需要 hero、新闻要点、source-index 和 risk-notes。"),
      createCompletedAgentTask("task-manager-3", "succeeded", JSON.stringify({ status: "continue", nextSlot: 1, reason: "现在构建 HTML" })),
      createCompletedAgentTask(
        "task-html",
        "succeeded",
        "<!doctype html><html><body><main><section id=\"source-index\"></section><section id=\"risk-notes\"></section></main></body></html>"
      ),
      createCompletedAgentTask("task-manager-4", "succeeded", JSON.stringify({ status: "continue", nextSlot: 2, reason: "最后 QA" })),
      createCompletedAgentTask("task-qa", "succeeded", JSON.stringify({ status: "complete", deliveryReady: true })),
      createCompletedAgentTask("task-manager-5", "succeeded", JSON.stringify({ status: "complete", reason: "QA 已通过" }))
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
      createCompletedAgentTask("task-manager-1", "succeeded", JSON.stringify({ status: "continue", nextSlot: 3, reason: "先研究视频主题" })),
      createCompletedAgentTask("task-research", "succeeded", "研究：AI agent 与多 agent 工作流正在进入企业运营，需提示验证与治理风险。"),
      createCompletedAgentTask("task-manager-2", "succeeded", JSON.stringify({ status: "continue", nextSlot: 4, reason: "再写脚本分镜" })),
      createCompletedAgentTask("task-storyboard", "succeeded", "分镜：0-90 标题，90-210 三个趋势点，210-330 风险，330-450 行动建议。"),
      createCompletedAgentTask("task-manager-3", "succeeded", JSON.stringify({ status: "continue", nextSlot: 5, reason: "补技术规划" })),
      createCompletedAgentTask("task-tech", "succeeded", "技术规划：Root.tsx 注册 AgentOpsBriefVideo，1920x1080，30fps，450 frames，使用 Sequence、AbsoluteFill、interpolate。"),
      createCompletedAgentTask("task-manager-4", "succeeded", JSON.stringify({ status: "continue", nextSlot: 1, reason: "开始构建 Remotion" })),
      createCompletedAgentTask("task-build-1", "succeeded", "<!doctype html><html><body>这是网页，不是 Remotion Composition。</body></html>"),
      createCompletedAgentTask("task-manager-5", "succeeded", JSON.stringify({ status: "continue", nextSlot: 2, reason: "严格 QA" })),
      createCompletedAgentTask(
        "task-qa-1",
        "succeeded",
        JSON.stringify({ status: "fail", returnToSlot: 1, reason: "产物是 HTML，不是 Remotion Composition", fixes: ["删除 HTML 输出", "提供 Root.tsx 和 Composition"] })
      ),
      createCompletedAgentTask("task-manager-6", "succeeded", JSON.stringify({ status: "continue", nextSlot: 1, reason: "QA 未通过，回退到构建槽修复" })),
      createCompletedAgentTask("task-build-2", "succeeded", remotionBundle),
      createCompletedAgentTask("task-manager-7", "succeeded", JSON.stringify({ status: "continue", nextSlot: 2, reason: "复审修复后的 Remotion 产物" })),
      createCompletedAgentTask("task-qa-2", "succeeded", JSON.stringify({ status: "complete", deliveryReady: true, reason: "Remotion 产物已通过严格审查" })),
      createCompletedAgentTask("task-manager-8", "succeeded", JSON.stringify({ status: "complete", reason: "Remotion QA 已通过" }))
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
      upstream: [expect.objectContaining({ nodeId: "brief", nodeLabel: "Brief", status: "succeeded", output: "brief ready again" })]
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

function createCompletedAgentTask(
  taskId: string,
  status: AgentTaskResult["status"],
  output?: string,
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

async function waitForRunTerminal(store: FileHivewardStore, runId: string): Promise<Awaited<ReturnType<FileHivewardStore["getRunView"]>>> {
  const deadline = Date.now() + 2_000;

  while (Date.now() < deadline) {
    const view = await store.getRunView(runId);
    if (view && !["queued", "running", "waiting_approval"].includes(view.run.status)) {
      return view;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Blueprint run did not reach a terminal state in time: ${runId}`);
}

async function waitForRunStatus(
  store: FileHivewardStore,
  runId: string,
  status: BlueprintRunStatus
): Promise<NonNullable<Awaited<ReturnType<FileHivewardStore["getRunView"]>>>> {
  const deadline = Date.now() + 2_000;

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
  store: FileHivewardStore,
  runId: string,
  predicate: (view: NonNullable<Awaited<ReturnType<FileHivewardStore["getRunView"]>>>) => boolean
): Promise<NonNullable<Awaited<ReturnType<FileHivewardStore["getRunView"]>>>> {
  const deadline = Date.now() + 2_000;

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
  const deadline = Date.now() + 2_000;

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
