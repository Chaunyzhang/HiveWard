import { describe, expect, it } from "vitest";
import type { BlueprintRunStatus, BlueprintRunSummary, BlueprintRunView, PendingApprovalItem } from "@hiveward/shared";
import {
  acknowledgedTerminalRunIdsStorageKey,
  readAcknowledgedTerminalRunIds,
  resolveBlueprintActivityState,
  resolveRunViewDisplayStatus,
  resolveRunViewStatus,
  selectRunPollingTarget,
  shouldShowBlueprintWorkspaceRunState,
  syncApprovalsForRun,
  writeAcknowledgedTerminalRunIds
} from "./run-state";

describe("run state sync", () => {
  it("derives pending inbox items from a waiting Agent approval in run detail", () => {
    const runView = createRunView("waiting_approval");

    const approvals = syncApprovalsForRun([], runView);

    expect(approvals).toEqual([
      {
        blueprintId: "blueprint-1",
        blueprintName: "Blueprint 1",
        blueprintRunId: "run-1",
        nodeRunId: "node-run-agent",
        nodeId: "agent",
        nodeLabel: "Agent",
        startedBy: "tester",
        startedAt: "2026-05-21T01:00:00.000Z",
        requestedAt: "2026-05-21T01:02:00.000Z",
        status: "pending",
        reviewOutput: "draft answer",
        canApprove: true,
        canReply: true,
        canReject: true
      }
    ]);
  });

  it("derives Agent approval reply state from a waiting agent node", () => {
    const runView = createRunView("waiting_approval");
    runView.nodeRuns[0] = {
      ...runView.nodeRuns[0]!,
      nodeId: "delivery",
      nodeLabel: "Delivery",
      nodeType: "agent",
      output: {
        approvalType: "agent",
        reviewOutput: "draft answer",
        replies: [
          {
            id: "reply-1",
            role: "user",
            body: "Tighten the wording.",
            createdAt: "2026-05-21T01:03:00.000Z"
          },
          {
            id: "reply-2",
            role: "assistant",
            body: "final answer",
            createdAt: "2026-05-21T01:04:00.000Z"
          }
        ]
      }
    };

    const approvals = syncApprovalsForRun([], runView);

    expect(approvals[0]).toMatchObject({
      nodeId: "delivery",
      nodeLabel: "Delivery",
      reviewOutput: "draft answer",
      status: "pending",
      canApprove: true,
      canReply: true,
      canReject: true,
      replies: [
        {
          id: "reply-1",
          role: "user",
          body: "Tighten the wording.",
          createdAt: "2026-05-21T01:03:00.000Z"
        },
        {
          id: "reply-2",
          role: "assistant",
          body: "final answer",
          createdAt: "2026-05-21T01:04:00.000Z"
        }
      ]
    });
  });

  it("carries previous node output into pending inbox items", () => {
    const previousOutput = {
      title: "Launch decision",
      body: "Ship the approved HTML page to the team channel."
    };
    const runView = createRunView("waiting_approval", { upstreamOutput: previousOutput });

    const approvals = syncApprovalsForRun([], runView);

    expect(approvals[0]?.upstream).toEqual([
      {
        nodeId: "summary",
        nodeLabel: "Summary",
        nodeRunId: "node-run-summary",
        output: previousOutput
      }
    ]);
  });

  it("keeps an approval visible while a reply rerun is in progress", () => {
    const runView = createRunView("running");
    runView.nodeRuns[0] = {
      ...runView.nodeRuns[0]!,
      output: {
        approvalType: "agent",
        reviewOutput: "draft answer",
        replies: [
          {
            id: "reply-1",
            role: "user",
            body: "Tighten the wording.",
            createdAt: "2026-05-21T01:03:00.000Z"
          }
        ]
      }
    };

    const approvals = syncApprovalsForRun([], runView);

    expect(approvals[0]).toMatchObject({
      nodeRunId: "node-run-agent",
      status: "replying",
      reviewOutput: "draft answer",
      canApprove: false,
      canReply: false,
      canReject: false,
      replies: [
        {
          id: "reply-1",
          role: "user",
          body: "Tighten the wording.",
          createdAt: "2026-05-21T01:03:00.000Z"
        }
      ]
    });
  });

  it("keeps an approved approval visible but non-actionable after completion", () => {
    const existing: PendingApprovalItem[] = [
      {
        blueprintId: "blueprint-1",
        blueprintName: "Blueprint 1",
        blueprintRunId: "run-1",
        nodeRunId: "node-run-agent",
        nodeId: "agent",
        nodeLabel: "Agent",
        startedBy: "tester",
        startedAt: "2026-05-21T01:00:00.000Z",
        requestedAt: "2026-05-21T01:02:00.000Z",
        reviewOutput: "draft answer",
        canApprove: true,
        canReply: true,
        canReject: true
      }
    ];

    const runView = createRunView("succeeded");
    runView.nodeRuns[0] = {
      ...runView.nodeRuns[0]!,
      endedAt: "2026-05-21T01:05:00.000Z"
    };

    expect(syncApprovalsForRun(existing, runView)[0]).toMatchObject({
      nodeRunId: "node-run-agent",
      status: "approved",
      decidedAt: "2026-05-21T01:05:00.000Z",
      canApprove: false,
      canReply: false,
      canReject: false
    });
  });

  it("removes stale inbox items when the same run no longer has a waiting approval node", () => {
    const existing: PendingApprovalItem[] = [
      {
        blueprintId: "blueprint-1",
        blueprintName: "Blueprint 1",
        blueprintRunId: "run-1",
        nodeRunId: "node-run-agent",
        nodeId: "agent",
        nodeLabel: "Agent",
        startedBy: "tester",
        startedAt: "2026-05-21T01:00:00.000Z",
        requestedAt: "2026-05-21T01:02:00.000Z",
        reviewOutput: "draft answer",
        canReply: true,
        canReject: true
      }
    ];

    expect(syncApprovalsForRun(existing, createRunView("running"))).toEqual([]);
  });

  it("polls the selected running run on the runs page", () => {
    const running = createRunView("running", { runId: "run-running" });
    const queued = createRunView("queued", { runId: "run-queued" });

    expect(
      selectRunPollingTarget({
        runs: [queued, running],
        selectedBlueprintId: "blueprint-1",
        selectedRunId: "run-running",
        view: "runs"
      })
    ).toBe("run-running");
  });

  it("moves from a stale selected run to the current blueprint active run", () => {
    const stale = createRunView("failed", { runId: "run-stale" });
    const running = createRunView("running", { runId: "run-running" });

    expect(
      selectRunPollingTarget({
        runs: [running, stale],
        selectedBlueprintId: "blueprint-1",
        selectedRunId: "run-stale",
        view: "runs"
      })
    ).toBe("run-running");
  });

  it("keeps polling waiting approval runs so external approvals update the workspace", () => {
    expect(
      selectRunPollingTarget({
        runs: [createRunView("waiting_approval")],
        selectedBlueprintId: "blueprint-1",
        selectedRunId: "run-1",
        view: "runs"
      })
    ).toBe("run-1");
  });

  it("keeps polling a stale terminal run summary while any node is still active", () => {
    const staleTerminalRun = createRunView("running", { runId: "run-stale-terminal", runStatus: "failed" });

    expect(resolveRunViewStatus(staleTerminalRun)).toBe("running");
    expect(resolveRunViewDisplayStatus(staleTerminalRun)).toBe("running");
    expect(
      selectRunPollingTarget({
        runs: [staleTerminalRun],
        selectedBlueprintId: "blueprint-1",
        selectedRunId: "run-stale-terminal",
        view: "runs"
      })
    ).toBe("run-stale-terminal");
  });

  it("shows failed node results before the run summary reaches a terminal status", () => {
    const failedNodeInOpenRun = createRunView("failed", { runId: "run-failed-node", runStatus: "running" });

    expect(resolveRunViewStatus(failedNodeInOpenRun)).toBe("running");
    expect(resolveRunViewDisplayStatus(failedNodeInOpenRun)).toBe("failed");
  });

  it("does not let cleanup cancellations make a succeeded run display as failed", () => {
    const succeededRun = createRunView("succeeded", { runStatus: "succeeded" });
    succeededRun.nodeRuns.push({
      ...succeededRun.nodeRuns[0]!,
      id: "node-run-stale",
      nodeId: "stale",
      nodeLabel: "Stale child",
      status: "cancelled",
      error: "Run already reached a terminal state; closing stale work."
    });

    expect(resolveRunViewStatus(succeededRun)).toBe("succeeded");
    expect(resolveRunViewDisplayStatus(succeededRun)).toBe("succeeded");
  });

  it("does not poll runs from another blueprint", () => {
    expect(
      selectRunPollingTarget({
        runs: [createRunView("running", { blueprintId: "blueprint-2" })],
        selectedBlueprintId: "blueprint-1",
        view: "blueprint"
      })
    ).toBeUndefined();
  });

  it("shows blueprint activity for open runs or unseen terminal results", () => {
    expect(resolveBlueprintActivityState("running")).toBe("running");
    expect(resolveBlueprintActivityState("queued")).toBe("running");
    expect(resolveBlueprintActivityState("waiting_approval")).toBe("running");
    expect(resolveBlueprintActivityState("succeeded")).toBe("succeeded");
    expect(resolveBlueprintActivityState("failed")).toBe("failed");
    expect(resolveBlueprintActivityState("cancelled")).toBe("failed");
    expect(resolveBlueprintActivityState("succeeded", true)).toBe("idle");
    expect(resolveBlueprintActivityState("failed", true)).toBe("idle");
  });

  it("clears terminal run details from the blueprint workspace after the run was seen", () => {
    expect(shouldShowBlueprintWorkspaceRunState("running")).toBe(true);
    expect(shouldShowBlueprintWorkspaceRunState("waiting_approval")).toBe(true);
    expect(shouldShowBlueprintWorkspaceRunState("queued")).toBe(true);
    expect(shouldShowBlueprintWorkspaceRunState("succeeded")).toBe(true);
    expect(shouldShowBlueprintWorkspaceRunState("failed")).toBe(true);
    expect(shouldShowBlueprintWorkspaceRunState("cancelled")).toBe(true);
    expect(shouldShowBlueprintWorkspaceRunState("succeeded", true)).toBe(false);
    expect(shouldShowBlueprintWorkspaceRunState("failed", true)).toBe(false);
    expect(shouldShowBlueprintWorkspaceRunState("cancelled", true)).toBe(false);
  });

  it("persists acknowledged terminal run ids for reload-safe blueprint markers", () => {
    const storage = createMemoryStorage();

    writeAcknowledgedTerminalRunIds(storage, ["run-2", "run-1"]);

    expect(JSON.parse(storage.getItem(acknowledgedTerminalRunIdsStorageKey) ?? "[]")).toEqual(["run-1", "run-2"]);
    expect([...readAcknowledgedTerminalRunIds(storage)]).toEqual(["run-1", "run-2"]);
  });

  it("ignores invalid acknowledged run id storage", () => {
    const storage = createMemoryStorage();
    storage.setItem(acknowledgedTerminalRunIdsStorageKey, "{\"bad\":true}");

    expect([...readAcknowledgedTerminalRunIds(storage)]).toEqual([]);
  });
});

function createRunView(
  nodeStatus: "waiting_approval" | "succeeded" | "running" | "queued" | "failed",
  options: {
    blueprintId?: string;
    runId?: string;
    runStatus?: BlueprintRunStatus;
    upstreamOutput?: unknown;
  } = {}
): BlueprintRunView {
  const run: BlueprintRunSummary = {
    id: options.runId ?? "run-1",
    companyId: "company-1",
    blueprintId: options.blueprintId ?? "blueprint-1",
    blueprintName: "Blueprint 1",
    blueprintVersion: 1,
    status: options.runStatus ?? toRunStatus(nodeStatus),
    startedBy: "tester",
    startedAt: "2026-05-21T01:00:00.000Z",
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    runtimeRefs: []
  };

  return {
    run,
    nodeRuns: [
      {
        id: "node-run-agent",
        blueprintRunId: run.id,
        blueprintId: run.blueprintId,
        nodeId: "agent",
        nodeLabel: "Agent",
        nodeType: "agent",
        status: nodeStatus,
        queuedAt: "2026-05-21T01:01:00.000Z",
        startedAt: "2026-05-21T01:02:00.000Z",
        ...(options.upstreamOutput === undefined
          ? {}
          : {
              input: {
                upstream: [
                  {
                    nodeId: "summary",
                    nodeLabel: "Summary",
                    nodeRunId: "node-run-summary",
                    status: "succeeded",
                    output: options.upstreamOutput
                  }
                ]
              }
            }),
        output: nodeStatus === "waiting_approval"
          ? {
              approvalType: "agent",
              reviewOutput: "draft answer",
              replies: []
            }
          : { approved: true }
      }
    ],
    events: [],
    finalResult: null
  };
}

function toRunStatus(nodeStatus: "waiting_approval" | "succeeded" | "running" | "queued" | "failed"): BlueprintRunStatus {
  if (nodeStatus === "waiting_approval") return "waiting_approval";
  if (nodeStatus === "failed") return "failed";
  if (nodeStatus === "succeeded") return "succeeded";
  return nodeStatus;
}

function createMemoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    }
  };
}
