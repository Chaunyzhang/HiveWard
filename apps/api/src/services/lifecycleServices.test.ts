import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FileHivewardStore } from "../store/fileHivewardStore";
import { SqliteHivewardStore } from "../store/sqlite/sqliteHivewardStore";
import {
  createContractBlueprint,
  createContractIteration,
  createContractReleaseReport
} from "../store/storeContractFixtures";
import {
  ApprovalService as CompatApprovalService,
  ArtifactService as CompatArtifactService,
  IterationService as CompatIterationService,
  ManagerMailProjector as CompatManagerMailProjector,
  MigrationService as CompatMigrationService,
  RuntimeAccessPolicyService as CompatRuntimeAccessPolicyService
} from "./lifecycleServices";
import { ApprovalService } from "./lifecycleApprovalService";
import { ArtifactService } from "./artifactService";
import { IterationService } from "./iterationLifecycleService";
import { ManagerMailProjector } from "./managerMailProjector";
import { MigrationService, RuntimeAccessPolicyService } from "./runtimeAccessPolicyService";

describe("ApprovalService", () => {
  it("keeps lifecycleServices as a compatibility barrel over split service implementations", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "lifecycleServices.ts"), "utf8");

    expect(CompatApprovalService).toBe(ApprovalService);
    expect(CompatIterationService).toBe(IterationService);
    expect(CompatArtifactService).toBe(ArtifactService);
    expect(CompatManagerMailProjector).toBe(ManagerMailProjector);
    expect(CompatRuntimeAccessPolicyService).toBe(RuntimeAccessPolicyService);
    expect(CompatMigrationService).toBe(MigrationService);
    expect(source).not.toContain("class ApprovalService");
    expect(source).not.toContain("class IterationService");
    expect(source).not.toContain("class ArtifactService");
    expect(source.split(/\r?\n/).length).toBeLessThan(40);
  });

  it("records replies without changing request lifecycle or creating revisions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hiveward-lifecycle-"));
    const store = new FileHivewardStore(join(dir, "hiveward-store.json"));
    await store.init();
    const service = new ApprovalService(store);

    const request = await service.createRequest({
      runId: "run-1",
      kind: "iteration_requirement_plan",
      title: "Round 1 requirement",
      body: "Initial plan",
      requestedBy: {
        type: "node",
        label: "Top Manager",
        nodeId: "manager"
      }
    });

    const result = await service.reply(request.id, "Clarify the acceptance criteria.");
    const original = await store.getApprovalRequest(request.id);
    const decisions = await store.listApprovalDecisions(request.id);
    const replies = await store.listApprovalReplies({ approvalRequestId: request.id });
    const threads = await store.listApprovalThreads({ runId: "run-1" });

    expect(original).toMatchObject({
      status: "pending",
      updatedAt: expect.any(String)
    });
    expect(decisions.map((decision) => decision.action)).toEqual(["reply"]);
    expect(decisions[0]).toMatchObject({
      resultingStatus: "pending",
      comment: "Clarify the acceptance criteria."
    });
    expect(replies).toEqual([
      expect.objectContaining({
        threadId: request.threadId ?? request.id,
        approvalRequestId: request.id,
        body: "Clarify the acceptance criteria."
      })
    ]);
    expect(threads).toEqual([
      expect.objectContaining({
        id: request.threadId ?? request.id,
        status: "open",
        currentRequestId: request.id
      })
    ]);
    expect(result.approvalRequest).toMatchObject({
      id: request.id,
      status: "pending",
      revision: 1,
      threadId: request.threadId
    });
    expect(result.nextApprovalRequest).toBeUndefined();
    expect((await store.listApprovalRequests({ runId: "run-1" }))).toHaveLength(1);
  });

  it("creates a superseding revision only for an explicit revise decision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hiveward-lifecycle-revise-"));
    const store = new FileHivewardStore(join(dir, "hiveward-store.json"));
    await store.init();
    const service = new ApprovalService(store);

    const request = await service.createRequest({
      runId: "run-revise",
      kind: "iteration_requirement_plan",
      title: "Round 1 requirement",
      body: "Initial plan",
      requestedBy: {
        type: "node",
        label: "Top Manager",
        nodeId: "manager"
      }
    });

    const result = await service.revise(request.id, "Tighten scope.");
    const original = await store.getApprovalRequest(request.id);
    const requests = await store.listApprovalRequests({ runId: "run-revise" });
    const decisions = await store.listApprovalDecisions(request.id);
    const replies = await store.listApprovalReplies({ threadId: request.threadId });

    expect(original).toMatchObject({
      status: "superseded",
      capabilities: expect.objectContaining({ approve: false, reply: false, revise: false })
    });
    expect(result.nextApprovalRequest).toMatchObject({
      status: "pending",
      threadId: request.threadId,
      replacesRequestId: request.id,
      revision: 2,
      body: expect.stringContaining("Tighten scope.")
    });
    expect(original?.supersededByRequestId).toBe(result.nextApprovalRequest?.id);
    expect(requests).toHaveLength(2);
    expect(decisions).toEqual([
      expect.objectContaining({
        action: "revise",
        resultingStatus: "superseded",
        comment: "Tighten scope."
      })
    ]);
    expect(replies).toEqual([]);
  });

  it("selects request-level assistant candidates without creating lifecycle decisions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hiveward-lifecycle-select-"));
    const store = new FileHivewardStore(join(dir, "hiveward-store.json"));
    await store.init();
    const service = new ApprovalService(store);

    const request = await service.createRequest({
      runId: "run-select",
      kind: "iteration_requirement_plan",
      title: "Round 1 requirement",
      body: "Original plan",
      requestedBy: {
        type: "node",
        label: "Top Manager",
        nodeId: "manager"
      }
    });
    await store.appendApprovalReply({
      id: "reply-candidate",
      threadId: request.threadId ?? request.id,
      approvalRequestId: request.id,
      actor: "agent",
      body: "Candidate plan",
      createdAt: new Date().toISOString(),
      metadata: { inboxDiscussionMode: "candidate", candidate: true }
    });

    const selected = await service.selectReply(request.id, "reply-candidate");

    expect(selected).toMatchObject({
      id: request.id,
      status: "pending",
      selectedReplyId: "reply-candidate",
      body: "Original plan"
    });
    expect(await store.listApprovalDecisions(request.id)).toEqual([]);
  });

  it("rejects invalid request-level selections and lets ordinary assistant replies become candidates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hiveward-lifecycle-select-invalid-"));
    const store = new FileHivewardStore(join(dir, "hiveward-store.json"));
    await store.init();
    const service = new ApprovalService(store);

    const first = await service.createRequest({
      runId: "run-select-invalid",
      kind: "iteration_requirement_plan",
      title: "First",
      body: "First body",
      requestedBy: { type: "node", label: "Manager", nodeId: "manager" }
    });
    const second = await service.createRequest({
      runId: "run-select-invalid",
      kind: "manager_release_report",
      title: "Second",
      body: "Second body",
      requestedBy: { type: "node", label: "Manager", nodeId: "manager" }
    });
    await store.appendApprovalReply({
      id: "reply-user",
      threadId: first.threadId ?? first.id,
      approvalRequestId: first.id,
      actor: "user",
      body: "Human note",
      createdAt: new Date().toISOString()
    });
    await store.appendApprovalReply({
      id: "reply-system",
      threadId: first.threadId ?? first.id,
      approvalRequestId: first.id,
      actor: "system",
      body: "System note",
      createdAt: new Date().toISOString()
    });
    await store.appendApprovalReply({
      id: "reply-other",
      threadId: second.threadId ?? second.id,
      approvalRequestId: second.id,
      actor: "manager",
      body: "Other request candidate",
      createdAt: new Date().toISOString(),
      metadata: { inboxDiscussionMode: "candidate", candidate: true }
    });
    await store.appendApprovalReply({
      id: "reply-not-candidate",
      threadId: first.threadId ?? first.id,
      approvalRequestId: first.id,
      actor: "agent",
      body: "Ordinary discussion reply",
      createdAt: new Date().toISOString(),
      metadata: { inboxDiscussionMode: "reply", candidate: false }
    });

    await expect(service.selectReply(first.id, "reply-user")).rejects.toThrow("Only assistant, agent, or manager approval replies");
    await expect(service.selectReply(first.id, "reply-system")).rejects.toThrow("Only assistant, agent, or manager approval replies");
    await expect(service.selectReply(first.id, "reply-not-candidate")).resolves.toMatchObject({
      selectedReplyId: "reply-not-candidate"
    });
    await expect(service.selectReply(first.id, "reply-other")).rejects.toThrow("does not belong");

    await service.reject(first.id);
    await expect(service.selectReply(first.id, "reply-user")).rejects.toThrow("already closed");
  });

  it("uses the selected request-level candidate body when approving a requirement plan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hiveward-lifecycle-selected-plan-"));
    const store = new FileHivewardStore(join(dir, "hiveward-store.json"));
    await store.init();
    const service = new ApprovalService(store);

    const request = await service.createRequest({
      runId: "run-selected-plan",
      kind: "iteration_requirement_plan",
      title: "Round 1 requirement",
      body: "Original plan",
      requestedBy: { type: "node", label: "Top Manager", nodeId: "manager" }
    });
    await store.appendApprovalReply({
      id: "reply-selected-plan",
      threadId: request.threadId ?? request.id,
      approvalRequestId: request.id,
      actor: "agent",
      body: "Selected candidate plan",
      createdAt: new Date().toISOString(),
      metadata: { inboxDiscussionMode: "candidate", candidate: true }
    });
    await service.selectReply(request.id, "reply-selected-plan");

    const result = await service.approve(request.id);

    expect(result.decision).toMatchObject({
      action: "approve",
      selectedReplyId: "reply-selected-plan"
    });
    expect(result.approvalRequest).toMatchObject({
      status: "approved",
      selectedReplyId: "reply-selected-plan",
      body: "Selected candidate plan"
    });
    expect(await store.getApprovalRequest(request.id)).toMatchObject({
      status: "approved",
      body: "Selected candidate plan"
    });
  });

  it("records request_changes as a lifecycle decision without appending a reply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hiveward-lifecycle-request-changes-"));
    const store = new FileHivewardStore(join(dir, "hiveward-store.json"));
    await store.init();
    const service = new ApprovalService(store);

    const request = await service.createRequest({
      runId: "run-request-changes",
      kind: "agent_proposal",
      title: "Agent output",
      body: "Draft output",
      requestedBy: {
        type: "node",
        label: "Agent",
        nodeId: "agent"
      }
    });

    const result = await service.requestChanges(request.id, "Regenerate with sources.");
    const decisions = await store.listApprovalDecisions(request.id);
    const replies = await store.listApprovalReplies({ threadId: request.threadId });

    expect(result.approvalRequest).toMatchObject({
      status: "pending",
      capabilities: expect.objectContaining({ approve: true, reply: true, requestChanges: true })
    });
    expect(decisions).toEqual([
      expect.objectContaining({
        action: "request_changes",
        resultingStatus: "pending",
        comment: "Regenerate with sources."
      })
    ]);
    expect(replies).toEqual([]);
  });

  it("reply then approve release report carries reply into next round humanFeedback", async () => {
    const { store, approvalService, iterationService, request, run } = await createReleaseReportApprovalFixture();

    await approvalService.reply(request.id, "I tried it and the character keeps walking left.");
    const result = await approvalService.approve(request.id);
    const outcome = await iterationService.handleApprovalResult(result);

    expect(await store.listApprovalReplies({ approvalRequestId: request.id })).toEqual([
      expect.objectContaining({ body: "I tried it and the character keeps walking left." })
    ]);
    expect((await store.getApprovalRequest(request.id))?.status).toBe("approved");
    expect(outcome.prepareNextRound).toMatchObject({
      previousReportRequestId: request.id,
      humanFeedback: expect.stringContaining("I tried it and the character keeps walking left.")
    });
    expect(outcome.prepareNextRound?.humanFeedback).toContain("Human feedback / user acceptance feedback");
    expect((await store.listIterationRounds({ runId: run.id })).filter((round) => round.roundNumber === 2)).toHaveLength(1);
  });

  it("approve comment still carries into next round humanFeedback", async () => {
    const { approvalService, iterationService, request } = await createReleaseReportApprovalFixture();

    const result = await approvalService.approve(request.id, "Approve, but keep keyboard controls in the next round.");
    const outcome = await iterationService.handleApprovalResult(result);

    expect(outcome.prepareNextRound?.humanFeedback).toContain("Approve, but keep keyboard controls in the next round.");
    expect(outcome.prepareNextRound?.humanFeedback).toContain("Approval action note");
  });

  it("uses the selected manager release candidate when completing a release report", async () => {
    const { store, approvalService, request, run } = await createReleaseReportApprovalFixture();
    await store.appendApprovalReply({
      id: "reply-selected-report",
      threadId: request.threadId ?? request.id,
      approvalRequestId: request.id,
      actor: "manager",
      body: "Selected release report summary",
      createdAt: new Date().toISOString(),
      metadata: { inboxDiscussionMode: "candidate", candidate: true }
    });
    await approvalService.selectReply(request.id, "reply-selected-report");

    const result = await approvalService.complete(request.id);

    expect(result.approvalRequest).toMatchObject({
      status: "completed",
      selectedReplyId: "reply-selected-report",
      body: "Selected release report summary"
    });
    expect((await store.listReleaseReports(run.id))[0]).toMatchObject({
      approvalRequestId: request.id,
      summary: "Selected release report summary"
    });
  });

  it("reply plus approve comment are both carried and ordered", async () => {
    const { approvalService, iterationService, request } = await createReleaseReportApprovalFixture();

    await approvalService.reply(request.id, "A: the mouse click does not break blocks.");
    const result = await approvalService.approve(request.id, "B: approve the next round to fix this.");
    const outcome = await iterationService.handleApprovalResult(result);
    const feedback = outcome.prepareNextRound?.humanFeedback ?? "";

    expect(feedback).toContain("A: the mouse click does not break blocks.");
    expect(feedback).toContain("B: approve the next round to fix this.");
    expect(feedback.indexOf("A: the mouse click does not break blocks.")).toBeLessThan(
      feedback.indexOf("B: approve the next round to fix this.")
    );
  });

  it("duplicate approve on closed approval does not create another round", async () => {
    const { store, approvalService, iterationService, request, run } = await createReleaseReportApprovalFixture();

    const result = await approvalService.approve(request.id, "Continue once.");
    await iterationService.handleApprovalResult(result);
    await expect(approvalService.approve(request.id, "Continue twice.")).rejects.toThrow("Approval request is already closed.");

    const rounds = await store.listIterationRounds({ runId: run.id });
    const decisions = await store.listApprovalDecisions(request.id);
    expect(rounds.filter((round) => round.roundNumber === 2)).toHaveLength(1);
    expect(decisions.filter((decision) => decision.action === "approve")).toHaveLength(1);
  });

  it("freezes all pending approvals for a terminal run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hiveward-lifecycle-"));
    const store = new FileHivewardStore(join(dir, "hiveward-store.json"));
    await store.init();
    const service = new ApprovalService(store);

    const first = await service.createRequest({
      runId: "run-terminal",
      kind: "iteration_requirement_plan",
      title: "Requirement",
      body: "Plan",
      requestedBy: { type: "node", label: "Top Manager", nodeId: "manager" }
    });
    const second = await service.createRequest({
      runId: "run-terminal",
      kind: "manager_release_report",
      title: "Round 1 Release Report v1",
      body: "Report",
      requestedBy: { type: "node", label: "Top Manager", nodeId: "manager" }
    });

    await service.closePendingForRun("run-terminal", "Run cancelled.");

    expect(await store.getApprovalRequest(first.id)).toMatchObject({ status: "superseded" });
    expect(await store.getApprovalRequest(second.id)).toMatchObject({ status: "superseded" });
    expect((await store.listApprovalDecisions()).map((decision) => decision.comment)).toEqual([
      "Run cancelled.",
      "Run cancelled."
    ]);
  });

  it("treats manager mail as a rebuildable approval projection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hiveward-manager-mail-projection-"));
    const store = new SqliteHivewardStore(join(dir, "hiveward.sqlite"));
    await store.init();
    try {
      const approvalService = new ApprovalService(store);
      const projector = new ManagerMailProjector(store);
      const blueprint = await store.saveBlueprint(createContractBlueprint());
      const run = await store.createBlueprintRun(blueprint, "projection-user");
      const request = await approvalService.createRequest({
        runId: run.id,
        roundId: "round-projection",
        kind: "iteration_requirement_plan",
        title: "Round plan",
        body: "Approve the round plan.",
        requestedBy: { type: "node", label: "Top Manager", nodeId: "manager" }
      });

      await projector.rebuild(run.id);
      expect(await projector.verify(run.id)).toMatchObject({ ok: true, expected: 1, actual: 1 });

      await store.replaceManagerMail([], { runId: run.id });
      expect(await store.listManagerMail(run.id)).toEqual([]);
      await projector.rebuild(run.id);
      expect(await store.listManagerMail(run.id)).toEqual([
        expect.objectContaining({ sourceId: request.id, status: "pending" })
      ]);

      await store.upsertApprovalRequest({
        ...request,
        status: "approved",
        capabilities: { approve: false, reject: false, reply: false, complete: false, terminate: false },
        updatedAt: "2026-05-29T00:00:00.000Z"
      });
      expect(await projector.verify(run.id)).toMatchObject({ ok: false, mismatches: [`drift:mail-${request.id}`] });
      await projector.refresh(run.id);
      expect(await store.listManagerMail(run.id)).toEqual([
        expect.objectContaining({ sourceId: request.id, status: "approved" })
      ]);

      await store.replaceManagerMail([
        {
          id: `mail-${request.id}`,
          sourceType: "approval_request",
          sourceId: request.id,
          kind: request.kind,
          status: "pending",
          title: request.title,
          body: request.body,
          capabilities: request.capabilities,
          relatedRunId: request.runId,
          relatedRoundId: request.roundId,
          createdAt: request.requestedAt,
          updatedAt: request.requestedAt
        }
      ], { runId: run.id });
      expect(await projector.verify(run.id)).toMatchObject({ ok: false, mismatches: [`drift:mail-${request.id}`] });
    } finally {
      store.close();
    }
  });
});

async function createReleaseReportApprovalFixture() {
  const dir = mkdtempSync(join(tmpdir(), "hiveward-release-feedback-"));
  const store = new FileHivewardStore(join(dir, "hiveward-store.json"));
  await store.init();
  const approvalService = new ApprovalService(store);
  const iterationService = new IterationService(store, approvalService);
  const blueprint = await store.saveBlueprint(createContractBlueprint());
  const run = await store.createBlueprintRun(blueprint, "feedback-user");
  const { session, round: fixtureRound } = createContractIteration(run.id);
  const round = {
    ...fixtureRound,
    status: "report_pending" as const
  };

  await store.upsertIterationSession(session);
  await store.upsertIterationRound(round);
  const request = await approvalService.createRequest({
    runId: run.id,
    roundId: round.id,
    kind: "manager_release_report",
    title: "Round 1 Release Report v1",
    body: "Round 1 delivered the playable artifact.",
    payloadRef: "release-report-contract",
    sourceRef: { type: "blueprint_run", id: run.id },
    requestedBy: { type: "node", label: "Top Manager", nodeId: "contract-manager" }
  });
  await store.upsertIterationRound({
    ...round,
    releaseReportRequestId: request.id
  });
  await store.upsertReleaseReport(createContractReleaseReport(run.id, round.id, request.id));

  return {
    store,
    approvalService,
    iterationService,
    request,
    run
  };
}
