import { describe, expect, it } from "vitest";
import type { ApprovalRequest, BlueprintRunStatus, BlueprintRunSummary, BlueprintRunView, PendingApprovalItem, RuntimeObjectSource } from "@hiveward/shared";
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

  it("uses the paused node runtime source as the approval harness label source", () => {
    const runView = createRunView("waiting_approval", { runtimeSource: "claude" });

    const approvals = syncApprovalsForRun([], runView);

    expect(approvals[0]).toMatchObject({ harnessId: "claude" });
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

  it("keeps a legacy harness approval visible while the node is running", () => {
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

  it("keeps replied lifecycle approvals distinct from rejected approvals", () => {
    const runView = createRunView("succeeded");
    runView.approvalRequests = [
      createApprovalRequest({
        id: "approval-report-1",
        kind: "manager_release_report",
        status: "replied",
        title: "Round 1 Release Report v1",
        body: "Report feedback was recorded."
      })
    ];

    const approvals = syncApprovalsForRun([], runView);

    expect(approvals[0]).toMatchObject({
      approvalRequestId: "approval-report-1",
      kind: "manager_release_report",
      status: "replied",
      canApprove: false,
      canReply: false,
      canReject: false,
      canComplete: false,
      reviewOutput: "Report feedback was recorded."
    });
  });

  it("restores lifecycle approval replies from persisted decisions", () => {
    const runView = createRunView("succeeded");
    runView.approvalRequests = [
      createApprovalRequest({
        id: "approval-plan-1",
        kind: "iteration_requirement_plan",
        status: "replied",
        title: "Round 2 Execution Plan v1",
        body: "Previous plan"
      })
    ];
    runView.approvalDecisions = [
      {
        id: "decision-reply-1",
        approvalRequestId: "approval-plan-1",
        action: "reply",
        actor: "user",
        comment: "Please include my inbox feedback.",
        resultingStatus: "replied",
        createdAt: "2026-05-21T01:05:00.000Z"
      }
    ];

    const approvals = syncApprovalsForRun([], runView);

    expect(approvals[0]).toMatchObject({
      approvalRequestId: "approval-plan-1",
      status: "replied",
      replies: [
        {
          id: "decision-reply-1",
          role: "user",
          body: "Please include my inbox feedback.",
          createdAt: "2026-05-21T01:05:00.000Z"
        }
      ]
    });
  });

  it("maps explicit request-change and revision capabilities into pending approval items", () => {
    const runView = createRunView("waiting_approval");
    runView.approvalRequests = [
      createApprovalRequest({
        id: "approval-agent-change",
        kind: "agent_proposal",
        status: "pending",
        capabilities: {
          approve: true,
          reject: true,
          reply: true,
          complete: false,
          terminate: false,
          requestChanges: true,
          revise: false
        }
      }),
      createApprovalRequest({
        id: "approval-plan-revise",
        kind: "iteration_requirement_plan",
        status: "pending",
        capabilities: {
          approve: true,
          reject: true,
          reply: true,
          complete: false,
          terminate: false,
          requestChanges: false,
          revise: true
        }
      })
    ];

    const approvals = syncApprovalsForRun([], runView);

    expect(approvals.find((approval) => approval.approvalRequestId === "approval-agent-change")).toMatchObject({
      canRequestChanges: true,
      canRevise: false
    });
    expect(approvals.find((approval) => approval.approvalRequestId === "approval-plan-revise")).toMatchObject({
      canRequestChanges: false,
      canRevise: true
    });
  });

  it("restores lifecycle approval replies from thread facts", () => {
    const runView = createRunView("succeeded");
    runView.approvalRequests = [
      createApprovalRequest({
        id: "approval-plan-2",
        threadId: "approval-thread-2",
        kind: "iteration_requirement_plan",
        status: "replied",
        title: "Round 2 Execution Plan v2",
        body: "Updated plan"
      })
    ];
    runView.approvalReplies = [
      {
        id: "reply-fact-1",
        threadId: "approval-thread-2",
        approvalRequestId: "approval-plan-2",
        actor: "user",
        body: "Keep this as a comment only.",
        createdAt: "2026-05-21T01:06:00.000Z"
      }
    ];

    const approvals = syncApprovalsForRun([], runView);

    expect(approvals[0]).toMatchObject({
      approvalRequestId: "approval-plan-2",
      approvalThreadId: "approval-thread-2",
      replies: [
        {
          id: "reply-fact-1",
          role: "user",
          body: "Keep this as a comment only.",
          createdAt: "2026-05-21T01:06:00.000Z"
        }
      ]
    });
  });

  it("restores request-level selected candidate state from run views", () => {
    const runView = createRunView("waiting_approval");
    runView.approvalRequests = [
      createApprovalRequest({
        id: "approval-plan-selected",
        threadId: "approval-thread-selected",
        kind: "iteration_requirement_plan",
        status: "pending",
        title: "Round 1 Execution Plan",
        body: "Original plan",
        selectedReplyId: "reply-selected"
      })
    ];
    runView.approvalReplies = [
      {
        id: "reply-selected",
        threadId: "approval-thread-selected",
        approvalRequestId: "approval-plan-selected",
        actor: "agent",
        body: "Selected candidate plan",
        createdAt: "2026-05-21T01:06:00.000Z",
        metadata: { inboxDiscussionMode: "candidate", candidate: true }
      }
    ];

    const approvals = syncApprovalsForRun([], runView);

    expect(approvals[0]).toMatchObject({
      approvalRequestId: "approval-plan-selected",
      selectedReplyId: "reply-selected",
      replies: [
        {
          id: "reply-selected",
          role: "assistant",
          body: "Selected candidate plan",
          selected: true,
          canUseAsSolution: true
        }
      ]
    });
  });

  it("offers request-level ordinary assistant discussion replies for explicit solution selection", () => {
    const runView = createRunView("waiting_approval");
    runView.approvalRequests = [
      createApprovalRequest({
        id: "approval-plan-chat",
        threadId: "approval-thread-chat",
        kind: "iteration_requirement_plan",
        status: "pending",
        title: "Round 1 Execution Plan",
        body: "Original plan"
      })
    ];
    runView.approvalReplies = [
      {
        id: "reply-chat",
        threadId: "approval-thread-chat",
        approvalRequestId: "approval-plan-chat",
        actor: "agent",
        body: "This is a discussion answer, not a candidate.",
        createdAt: "2026-05-21T01:06:00.000Z",
        metadata: { inboxDiscussionMode: "reply", candidate: false }
      }
    ];

    const approvals = syncApprovalsForRun([], runView);

    expect(approvals[0]?.replies?.[0]).toMatchObject({
      id: "reply-chat",
      role: "assistant",
      body: "This is a discussion answer, not a candidate.",
      canUseAsSolution: true
    });
  });

  it("prefers thread facts over duplicate node output replies", () => {
    const runView = createRunView("waiting_approval");
    runView.approvalRequests = [
      createApprovalRequest({
        id: "approval-agent-1",
        threadId: "approval-thread-agent-1",
        kind: "agent_proposal",
        nodeRunId: "node-run-agent",
        body: "draft answer"
      })
    ];
    runView.approvalReplies = [
      {
        id: "reply-fact-1",
        threadId: "approval-thread-agent-1",
        approvalRequestId: "approval-agent-1",
        actor: "user",
        body: "Give me a shippable version.",
        createdAt: "2026-05-21T01:06:00.000Z"
      }
    ];
    runView.nodeRuns[0] = {
      ...runView.nodeRuns[0]!,
      output: {
        approvalType: "agent",
        reviewOutput: "draft answer",
        replies: [
          {
            id: "approval-reply-node-1",
            role: "user",
            body: "Give me a shippable version.",
            createdAt: "2026-05-21T01:06:01.000Z"
          }
        ]
      }
    };

    const approvals = syncApprovalsForRun([], runView);

    expect(approvals[0]?.replies).toEqual([
      {
        id: "reply-fact-1",
        role: "user",
        body: "Give me a shippable version.",
        createdAt: "2026-05-21T01:06:00.000Z"
      }
    ]);
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
    runtimeSource?: RuntimeObjectSource;
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
        ...(options.runtimeSource
          ? {
              runtimeRef: {
                source: options.runtimeSource,
                sourceId: `${options.runtimeSource}-task-1`,
                sourceUpdatedAt: "2026-05-21T01:02:30.000Z",
                taskId: `${options.runtimeSource}-task-1`,
                runId: `${options.runtimeSource}-run-1`,
                sessionKey: `${options.runtimeSource}-session-1`
              }
            }
          : {}),
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

function createApprovalRequest(overrides: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    id: "approval-1",
    runId: "run-1",
    kind: "function_node",
    status: "pending",
    title: "Approval",
    body: "Approval body",
    revision: 1,
    capabilities: {
      approve: false,
      reject: false,
      reply: false,
      complete: false,
      terminate: false
    },
    requestedBy: {
      type: "node",
      label: "Manager",
      nodeId: "manager"
    },
    requestedAt: "2026-05-21T01:03:00.000Z",
    updatedAt: "2026-05-21T01:04:00.000Z",
    ...overrides
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
