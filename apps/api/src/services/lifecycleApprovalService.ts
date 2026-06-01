import { nanoid } from "nanoid";
import type {
  ApprovalCapabilities,
  ApprovalDecision,
  ApprovalDecisionAction,
  ApprovalReply,
  ApprovalRequest,
  ApprovalRequestKind,
  ApprovalRequestStatus,
  ReleaseReport,
  RunTimelineItem
} from "@hiveward/shared";
import {
  approvalThreadIdForRequest,
  capabilitiesAllow,
  emptyApprovalCapabilities,
  resolveApprovalCapabilities
} from "@hiveward/shared";
import type { HivewardStore } from "../store/hivewardStore";
export interface ApprovalActionResult {
  approvalRequest: ApprovalRequest;
  decision: ApprovalDecision;
  nextApprovalRequest?: ApprovalRequest;
}

export interface ApprovalRevisionDraft {
  title?: string;
  body?: string;
  payloadRef?: string;
  releaseReport?: ReleaseReport;
  capabilities?: ApprovalCapabilities;
}

export interface LifecycleApprovalOutcome {
  resumeExecution: boolean;
  completeRun: boolean;
  prepareNextRound?: {
    sessionId: string;
    roundId: string;
    previousReportRequestId: string;
    humanFeedback?: string;
  };
}

export class ApprovalConflictError extends Error {
  readonly statusCode = 409;
  readonly code = "approval_conflict";

  constructor(message = "Approval request is no longer pending.") {
    super(message);
    this.name = "ApprovalConflictError";
  }
}

export class ApprovalService {
  constructor(private readonly store: HivewardStore) {}

  async buildApprovalHumanFeedback(
    request: ApprovalRequest,
    decision?: ApprovalDecision
  ): Promise<string | undefined> {
    const threadId = request.threadId ?? request.id;
    const replies = await this.store.listApprovalReplies({ threadId });
    const entries: ApprovalFeedbackEntry[] = [];

    for (const reply of replies) {
      if (!isCurrentRequestUserReply(reply, request)) continue;
      const body = reply.body.trim();
      if (!body) continue;
      entries.push({
        source: "reply",
        body,
        createdAt: reply.createdAt
      });
    }

    const actionComment = decision?.comment?.trim();
    if (decision?.actor === "user" && decision.action !== "reply" && actionComment) {
      entries.push({
        source: "decision",
        body: actionComment,
        createdAt: decision.createdAt
      });
    }

    const uniqueEntries = dedupeApprovalFeedback(entries)
      .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
    const zh = usesChineseText(request.title) ||
      usesChineseText(request.body) ||
      uniqueEntries.some((entry) => usesChineseText(entry.body));
    return formatApprovalHumanFeedback(uniqueEntries, zh);
  }

  async createRequest(input: {
    runId?: string;
    roundId?: string;
    nodeRunId?: string;
    kind: ApprovalRequestKind;
    title: string;
    body: string;
    payloadRef?: string;
    sourceRef?: ApprovalRequest["sourceRef"];
    threadId?: string;
    requestedBy: ApprovalRequest["requestedBy"];
    revision?: number;
    replacesRequestId?: string;
    closeReplacedRequest?: boolean;
    finalRound?: boolean;
    requestedAt?: string;
    capabilities?: ApprovalCapabilities;
  }): Promise<ApprovalRequest> {
    const now = input.requestedAt ?? new Date().toISOString();
    const request: ApprovalRequest = {
      id: `approval-${nanoid(10)}`,
      runId: input.runId,
      roundId: input.roundId,
      nodeRunId: input.nodeRunId,
      kind: input.kind,
      status: "pending",
      title: input.title,
      body: input.body,
      payloadRef: input.payloadRef,
      sourceRef: input.sourceRef,
      threadId: input.threadId ?? input.replacesRequestId ?? `thread-${nanoid(10)}`,
      revision: input.revision ?? 1,
      replacesRequestId: input.replacesRequestId,
      capabilities: input.capabilities ?? resolveApprovalCapabilities(input.kind, "pending", { finalRound: input.finalRound }),
      requestedBy: input.requestedBy,
      requestedAt: now,
      updatedAt: now
    };

    if (input.replacesRequestId && input.closeReplacedRequest !== false) {
      const previous = await this.store.getApprovalRequest(input.replacesRequestId);
      if (previous && previous.status === "pending") {
        await this.closeRequest(previous, "superseded", "supersede", "system", request.id);
      }
    }

    await this.store.upsertApprovalRequest(request);
    if (input.runId && await this.store.getBlueprintRun(input.runId)) {
      await this.store.appendRunTimelineItem({
        id: `timeline-${nanoid(10)}`,
        runId: input.runId,
        createdAt: now,
        actorNodeId: input.requestedBy.nodeId,
        actorLabel: input.requestedBy.label,
        kind: "approval_created",
        title: input.title,
        body: input.body,
        payloadRef: input.payloadRef
      });
    }
    return request;
  }

  approve(id: string, comment?: string, selectedReplyId?: string): Promise<ApprovalActionResult> {
    return this.decide(id, "approve", "approved", { comment, selectedReplyId });
  }

  async selectReply(id: string, selectedReplyId: string): Promise<ApprovalRequest> {
    const current = await this.requireRequest(id);
    if (current.status !== "pending") {
      throw new ApprovalConflictError("Approval request is already closed.");
    }
    const selectedReply = await this.requireSelectableReply(current, selectedReplyId);
    return this.store.upsertApprovalRequest({
      ...current,
      selectedReplyId: selectedReply.id,
      updatedAt: new Date().toISOString()
    });
  }

  reject(id: string, comment?: string): Promise<ApprovalActionResult> {
    return this.decide(id, "reject", "rejected", { comment });
  }

  complete(id: string, comment?: string): Promise<ApprovalActionResult> {
    return this.decide(id, "complete", "completed", { comment });
  }

  terminate(id: string, comment?: string): Promise<ApprovalActionResult> {
    return this.decide(id, "terminate", "terminated", { comment });
  }

  async requestChanges(id: string, comment: string): Promise<ApprovalActionResult> {
    const trimmed = comment.trim();
    if (!trimmed) throw new Error("Approval request_changes comment is required.");
    const current = await this.requirePendingRequest(id, "request_changes");
    const now = new Date().toISOString();
    const updated: ApprovalRequest = { ...current, updatedAt: now };
    const decision = this.buildDecision(current.id, "request_changes", "pending", "user", trimmed, now);
    return this.applyDecisionOrThrow({ approvalRequest: updated, decision });
  }

  async markSupersededByRevision(id: string, supersededByRequestId: string): Promise<ApprovalRequest> {
    const current = await this.requireRequest(id);
    if (current.status !== "pending") {
      throw new ApprovalConflictError("Approval request is already closed.");
    }
    const superseded: ApprovalRequest = {
      ...current,
      status: "superseded",
      supersededByRequestId,
      capabilities: { ...emptyApprovalCapabilities },
      updatedAt: new Date().toISOString()
    };
    return this.store.upsertApprovalRequest(superseded);
  }

  async revise(id: string, message: string, revisionOverride: ApprovalRevisionDraft = {}): Promise<ApprovalActionResult> {
    const feedback = message.trim();
    if (!feedback) throw new Error("Approval revision message is required.");

    const current = await this.requirePendingRequest(id, "revise");
    const revision = current.revision + 1;
    const draft = await this.buildDecisionRevision(current, feedback, revision, revisionOverride);
    const now = new Date().toISOString();
    const nextApprovalRequestId = `approval-${nanoid(10)}`;
    const nextApprovalRequest: ApprovalRequest = {
      ...current,
      id: nextApprovalRequestId,
      status: "pending",
      title: draft.title,
      body: draft.body,
      payloadRef: draft.payloadRef,
      revision,
      replacesRequestId: current.id,
      supersededByRequestId: undefined,
      capabilities: draft.capabilities,
      requestedAt: now,
      updatedAt: now
    };
    const releaseReport = draft.releaseReport
      ? {
          ...draft.releaseReport,
          approvalRequestId: nextApprovalRequestId,
          createdAt: draft.releaseReport.createdAt || now
        }
      : undefined;
    const decision = this.buildDecision(current.id, "revise", "superseded", "user", feedback, now);
    const superseded: ApprovalRequest = {
      ...current,
      status: "superseded",
      supersededByRequestId: nextApprovalRequestId,
      capabilities: { ...emptyApprovalCapabilities },
      updatedAt: now
    };
    return this.applyDecisionOrThrow({
      approvalRequest: superseded,
      decision,
      nextApprovalRequest,
      releaseReport
    });
  }

  async reply(
    id: string,
    message: string,
    revisionOverride: ApprovalRevisionDraft = {}
  ): Promise<ApprovalActionResult> {
    void revisionOverride;
    return this.recordPendingReply(id, message);
  }

  async recordPendingReply(id: string, message: string): Promise<ApprovalActionResult> {
    const trimmed = message.trim();
    if (!trimmed) throw new Error("Approval reply message is required.");

    const current = await this.requirePendingRequest(id, "reply");
    const now = new Date().toISOString();
    const updated: ApprovalRequest = { ...current, updatedAt: now };
    const decision = this.buildDecision(current.id, "reply", "pending", "user", trimmed, now);
    return this.applyDecisionOrThrow({ approvalRequest: updated, decision });
  }

  async closeWithReply(id: string, message: string): Promise<ApprovalActionResult> {
    return this.recordPendingReply(id, message);
  }

  async autoApprove(input: Parameters<ApprovalService["createRequest"]>[0], comment?: string): Promise<ApprovalActionResult> {
    const request = await this.createRequest(input);
    return this.autoResolve(request.id, comment);
  }

  async autoResolve(id: string, comment?: string): Promise<ApprovalActionResult> {
    const request = await this.requireRequest(id);
    if (request.status !== "pending") {
      throw new ApprovalConflictError("Approval request is already closed.");
    }
    if (request.capabilities.approve) {
      return this.decide(request.id, "auto_approve", "approved", { actor: "system", comment });
    }
    if (request.capabilities.complete) {
      return this.decide(request.id, "complete", "completed", { actor: "system", comment });
    }
    throw new Error("Approval request cannot be auto-resolved.");
  }

  async supersede(id: string, supersededByRequestId?: string): Promise<ApprovalActionResult> {
    const current = await this.requireRequest(id);
    const closed = await this.closeRequest(current, "superseded", "supersede", "system", supersededByRequestId);
    const decision = (await this.store.listApprovalDecisions(current.id)).at(-1);
    if (!decision) throw new Error("Supersede decision was not recorded.");
    return { approvalRequest: closed, decision };
  }

  async closePendingForRun(runId: string, comment: string): Promise<ApprovalRequest[]> {
    const pending = await this.store.listApprovalRequests({ runId, status: "pending" });
    const closed: ApprovalRequest[] = [];
    for (const request of pending) {
      closed.push(await this.closeRequest(request, "superseded", "supersede", "system", undefined, comment));
    }
    return closed;
  }

  private async decide(
    id: string,
    action: ApprovalDecisionAction,
    resultingStatus: ApprovalRequestStatus,
    options: { actor?: ApprovalDecision["actor"]; comment?: string; selectedReplyId?: string } = {}
  ): Promise<ApprovalActionResult> {
    const current = await this.requirePendingRequest(id, action);
    if (action === "complete" && current.kind !== "manager_release_report") {
      throw new Error("Only manager release reports can be completed.");
    }
    if (action === "terminate" && current.kind === "manager_release_report") {
      throw new Error("Manager release reports cannot be terminated.");
    }
    const actionConsumesSelection = action === "approve" || action === "complete" || action === "auto_approve";
    const selectedReplyId = actionConsumesSelection ? options.selectedReplyId ?? current.selectedReplyId : current.selectedReplyId;
    const selectedReply = actionConsumesSelection && selectedReplyId && current.kind !== "agent_proposal"
      ? await this.requireSelectableReply(current, selectedReplyId)
      : undefined;
    const selectedBody = selectedReply && approvalKindConsumesSelectedReplyBody(current.kind)
      ? selectedReply.body
      : undefined;
    const releaseReport = selectedBody !== undefined && current.kind === "manager_release_report"
      ? await this.buildSelectedReleaseReport(current, selectedBody)
      : undefined;
    const now = new Date().toISOString();
    const decision = this.buildDecision(
      current.id,
      action,
      resultingStatus,
      options.actor ?? "user",
      options.comment,
      now,
      actionConsumesSelection ? selectedReplyId : options.selectedReplyId
    );
    const next: ApprovalRequest = {
      ...current,
      ...(selectedBody !== undefined ? { body: selectedBody } : {}),
      status: resultingStatus,
      ...(selectedReplyId ? { selectedReplyId } : {}),
      capabilities: { ...emptyApprovalCapabilities },
      updatedAt: now
    };
    return this.applyDecisionOrThrow({ approvalRequest: next, decision, releaseReport });
  }

  private async closeRequest(
    request: ApprovalRequest,
    status: ApprovalRequestStatus,
    action: ApprovalDecisionAction,
    actor: ApprovalDecision["actor"],
    supersededByRequestId?: string,
    comment?: string
  ): Promise<ApprovalRequest> {
    const now = new Date().toISOString();
    const decision = this.buildDecision(request.id, action, status, actor, comment, now);
    const next: ApprovalRequest = {
      ...request,
      status,
      supersededByRequestId,
      capabilities: { ...emptyApprovalCapabilities },
      updatedAt: now
    };
    await this.applyDecisionOrThrow({ approvalRequest: next, decision });
    return next;
  }

  private async requirePendingRequest(id: string, action: ApprovalDecisionAction): Promise<ApprovalRequest> {
    const request = await this.requireRequest(id);
    if (request.status !== "pending") {
      throw new ApprovalConflictError("Approval request is already closed.");
    }
    if (!capabilitiesAllow(request.capabilities, action)) {
      throw new Error(`Approval request does not allow ${action}.`);
    }
    return request;
  }

  private async requireRequest(id: string): Promise<ApprovalRequest> {
    const request = await this.store.getApprovalRequest(id);
    if (!request) throw new Error(`Approval request not found: ${id}`);
    return request;
  }

  private async requireSelectableReply(request: ApprovalRequest, selectedReplyId: string): Promise<ApprovalReply> {
    const normalizedSelectedReplyId = selectedReplyId.trim();
    if (!normalizedSelectedReplyId) {
      throw new Error("Approval selectedReplyId is required.");
    }
    const threadId = approvalThreadIdForRequest(request);
    const reply = (await this.store.listApprovalReplies({ threadId }))
      .find((candidate) => candidate.id === normalizedSelectedReplyId);
    if (!reply || (reply.approvalRequestId && reply.approvalRequestId !== request.id)) {
      throw new Error("Selected approval reply does not belong to this approval request.");
    }
    if (!isSelectableApprovalReply(reply, request.selectedReplyId)) {
      throw new Error("Only assistant, agent, or manager approval replies can be selected as candidates.");
    }
    return reply;
  }

  private async buildSelectedReleaseReport(
    request: ApprovalRequest,
    selectedBody: string
  ): Promise<ReleaseReport | undefined> {
    if (!request.runId) return undefined;
    const reports = await this.store.listReleaseReports(request.runId);
    const report = request.payloadRef
      ? reports.find((candidate) => candidate.id === request.payloadRef)
      : undefined;
    const selectedReport = report ??
      reports.find((candidate) => candidate.approvalRequestId === request.id) ??
      (request.roundId ? reports.filter((candidate) => candidate.roundId === request.roundId).at(-1) : undefined);
    return selectedReport ? { ...selectedReport, summary: selectedBody } : undefined;
  }

  private buildDecision(
    approvalRequestId: string,
    action: ApprovalDecisionAction,
    resultingStatus: ApprovalRequestStatus,
    actor: ApprovalDecision["actor"],
    comment: string | undefined,
    createdAt: string,
    selectedReplyId?: string
  ): ApprovalDecision {
    return {
      id: `decision-${nanoid(10)}`,
      approvalRequestId,
      action,
      actor,
      comment: comment?.trim() || undefined,
      selectedReplyId,
      resultingStatus,
      createdAt
    };
  }

  private async applyDecisionOrThrow(input: {
    approvalRequest: ApprovalRequest;
    decision: ApprovalDecision;
    nextApprovalRequest?: ApprovalRequest;
    releaseReport?: ReleaseReport;
  }): Promise<ApprovalActionResult> {
    const result = await this.store.applyApprovalDecision({
      approvalRequestId: input.approvalRequest.id,
      expectedStatus: "pending",
      nextRequest: input.approvalRequest,
      decision: input.decision,
      nextApprovalRequest: input.nextApprovalRequest,
      releaseReport: input.releaseReport,
      timelineItem: input.approvalRequest.runId && await this.store.getBlueprintRun(input.approvalRequest.runId)
        ? this.buildDecisionTimelineItem(input.approvalRequest, input.decision)
        : undefined
    });
    if (result.status === "conflict") {
      throw new ApprovalConflictError();
    }
    return result;
  }

  private appendDecisionTimeline(request: ApprovalRequest, decision: ApprovalDecision): Promise<unknown> {
    if (!request.runId) return Promise.resolve();
    return this.store.appendRunTimelineItem(this.buildDecisionTimelineItem(request, decision));
  }

  private buildDecisionTimelineItem(
    request: ApprovalRequest,
    decision: ApprovalDecision
  ): Omit<RunTimelineItem, "sequence"> & { sequence?: number } {
    if (!request.runId) throw new Error("Approval decision timeline requires a blueprint run id.");
    return {
      id: `timeline-${nanoid(10)}`,
      runId: request.runId,
      createdAt: decision.createdAt,
      actorNodeId: request.requestedBy.nodeId,
      actorLabel: decision.actor,
      kind: "decision_created",
      title: `${request.title}: ${decision.action}`,
      body: decision.comment,
      payloadRef: request.payloadRef
    };
  }

  private async buildDecisionRevision(
    current: ApprovalRequest,
    message: string,
    revision: number,
    override: ApprovalRevisionDraft
  ): Promise<{
    title: string;
    body: string;
    payloadRef?: string;
    releaseReport?: ReleaseReport;
    capabilities: ApprovalCapabilities;
  }> {
    if (override.title || override.body || override.payloadRef || override.releaseReport || override.capabilities) {
      return {
        title: override.title ?? appendRevisionSuffix(current.title, revision),
        body: override.body ?? current.body,
        payloadRef: override.payloadRef ?? current.payloadRef,
        releaseReport: override.releaseReport,
        capabilities: override.capabilities ?? current.capabilities
      };
    }

    if (current.kind === "manager_release_report") {
      throw new Error("Manager release report revisions require a worker-generated Manager draft.");
    }

    const title = appendRevisionSuffix(current.title, revision);
    return {
      title,
      body: [
        `Revision ${revision} for ${current.kind}.`,
        "Previous request:",
        current.body,
        "Revision feedback:",
        message,
        "Revised request:",
        `${current.body}\n\nRequested adjustment: ${message}`
      ].join("\n\n"),
      payloadRef: current.payloadRef,
      capabilities: current.capabilities
    };
  }
}

function appendRevisionSuffix(title: string, revision: number): string {
  return `${title.replace(/\s+v\d+$/i, "")} v${revision}`;
}

function approvalKindConsumesSelectedReplyBody(kind: ApprovalRequestKind): boolean {
  return kind === "iteration_requirement_plan" || kind === "manager_release_report";
}

function isSelectableApprovalReply(reply: ApprovalReply, selectedReplyId?: string): boolean {
  if (reply.id === selectedReplyId) return true;
  return isSelectableApprovalReplyActor(reply.actor);
}

function isSelectableApprovalReplyActor(actor: ApprovalReply["actor"]): boolean {
  return actor === "assistant" || actor === "agent" || actor === "manager";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ApprovalFeedbackEntry = {
  source: "reply" | "decision";
  body: string;
  createdAt: string;
};

function isCurrentRequestUserReply(reply: ApprovalReply, request: ApprovalRequest): boolean {
  if (reply.actor !== "user") return false;
  if (reply.approvalRequestId) return reply.approvalRequestId === request.id;
  return reply.threadId === (request.threadId ?? request.id);
}

function dedupeApprovalFeedback(entries: ApprovalFeedbackEntry[]): ApprovalFeedbackEntry[] {
  const seen = new Set<string>();
  const unique: ApprovalFeedbackEntry[] = [];
  for (const entry of entries) {
    const key = entry.body.replace(/\s+/g, " ").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique;
}

function formatApprovalHumanFeedback(entries: ApprovalFeedbackEntry[], zh: boolean): string | undefined {
  if (entries.length === 0) return undefined;
  return [
    zh ? "Human feedback / 用户验收反馈:" : "Human feedback / user acceptance feedback:",
    ...entries.map((entry, index) => `${index + 1}. ${approvalFeedbackSourceLabel(entry.source, zh)}: ${entry.body}`)
  ].join("\n");
}

function approvalFeedbackSourceLabel(source: ApprovalFeedbackEntry["source"], zh: boolean): string {
  if (zh) return source === "reply" ? "审批留言" : "审批动作备注";
  return source === "reply" ? "Approval message" : "Approval action note";
}

function usesChineseText(value: string | undefined): boolean {
  return /[\u3400-\u9fff]/.test(value ?? "");
}
