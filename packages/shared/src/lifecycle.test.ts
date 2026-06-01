import { describe, expect, it } from "vitest";
import {
  approvalActionCanTriggerWorkflow,
  approvalActionIsMessageOnly,
  approvalThreadFromRequest,
  capabilitiesAllow,
  lifecycleKindForNodeType,
  normalizeApprovalRequestKind,
  resolveApprovalCapabilities,
  resolveApprovalThreadStatus,
  type ApprovalRequest
} from "./lifecycle";

describe("lifecycle contracts", () => {
  it("keeps reply as message-only while explicit decisions can trigger workflow", () => {
    expect(approvalActionIsMessageOnly("reply")).toBe(true);
    expect(approvalActionCanTriggerWorkflow("reply")).toBe(false);
    expect(approvalActionCanTriggerWorkflow("approve")).toBe(true);
    expect(approvalActionCanTriggerWorkflow("complete")).toBe(true);
    expect(approvalActionCanTriggerWorkflow("terminate")).toBe(true);
    expect(approvalActionCanTriggerWorkflow("request_changes")).toBe(true);
    expect(approvalActionCanTriggerWorkflow("revise")).toBe(true);
    expect(approvalActionCanTriggerWorkflow("reject")).toBe(false);
  });

  it("declares explicit request-change and revision capabilities by request kind", () => {
    const requirement = resolveApprovalCapabilities("iteration_requirement_plan", "pending");
    const release = resolveApprovalCapabilities("manager_release_report", "pending");
    const agent = resolveApprovalCapabilities("agent_proposal", "pending");
    const functionNode = resolveApprovalCapabilities("function_node", "pending");
    const delegation = resolveApprovalCapabilities("leader_delegation", "pending");

    expect(capabilitiesAllow(requirement, "reply")).toBe(true);
    expect(capabilitiesAllow(requirement, "request_changes")).toBe(false);
    expect(capabilitiesAllow(requirement, "revise")).toBe(true);
    expect(capabilitiesAllow(release, "complete")).toBe(true);
    expect(capabilitiesAllow(release, "request_changes")).toBe(false);
    expect(capabilitiesAllow(release, "revise")).toBe(true);
    expect(capabilitiesAllow(agent, "request_changes")).toBe(true);
    expect(capabilitiesAllow(agent, "revise")).toBe(false);
    expect(capabilitiesAllow(functionNode, "reply")).toBe(true);
    expect(capabilitiesAllow(functionNode, "terminate")).toBe(true);
    expect(capabilitiesAllow(functionNode, "request_changes")).toBe(false);
    expect(capabilitiesAllow(delegation, "request_changes")).toBe(false);
    expect(capabilitiesAllow(delegation, "revise")).toBe(false);
  });

  it("uses function_node as the canonical non-Agent approval kind", () => {
    expect(lifecycleKindForNodeType("agent")).toBe("agent_proposal");
    expect(lifecycleKindForNodeType("summary")).toBe("function_node");
    expect(normalizeApprovalRequestKind("generic_message")).toBe("function_node");
    expect(normalizeApprovalRequestKind("report")).toBeUndefined();
  });

  it("derives thread state from request lifecycle without splitting revisions into facts", () => {
    const request: ApprovalRequest = {
      id: "approval-1",
      runId: "run-1",
      roundId: "round-1",
      nodeRunId: "node-run-1",
      kind: "iteration_requirement_plan",
      status: "pending",
      title: "Round 1 Plan",
      body: "Plan body",
      threadId: "thread-1",
      revision: 2,
      capabilities: resolveApprovalCapabilities("iteration_requirement_plan", "pending"),
      requestedBy: { type: "node", label: "Top Manager", nodeId: "manager" },
      requestedAt: "2026-05-31T00:00:00.000Z",
      updatedAt: "2026-05-31T00:10:00.000Z"
    };

    expect(resolveApprovalThreadStatus("pending")).toBe("open");
    expect(resolveApprovalThreadStatus("approved")).toBe("closed");
    expect(approvalThreadFromRequest(request)).toEqual({
      id: "thread-1",
      kind: "iteration_requirement_plan",
      status: "open",
      title: "Round 1 Plan",
      runId: "run-1",
      roundId: "round-1",
      nodeRunId: "node-run-1",
      sourceRef: undefined,
      currentRequestId: "approval-1",
      currentRevision: 2,
      capabilities: request.capabilities,
      createdAt: "2026-05-31T00:00:00.000Z",
      updatedAt: "2026-05-31T00:10:00.000Z",
      closedAt: undefined
    });
  });
});
