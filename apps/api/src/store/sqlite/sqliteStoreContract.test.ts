import { existsSync, mkdtempSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HivewardStore } from "../hivewardStore";
import { FileHivewardStore } from "../fileHivewardStore";
import {
  contractNow,
  createContractApproval,
  createContractArtifact,
  createContractBlueprint,
  createContractDecision,
  createContractEvent,
  createContractHandoff,
  createContractHumanReport,
  createContractIteration,
  createContractManagerContext,
  createContractNodeRun,
  createContractPortablePackage,
  createContractReleaseReport,
  createContractTimelineItem
} from "../storeContractFixtures";
import { SqliteHivewardStore } from "./sqliteHivewardStore";

type Harness = {
  store: HivewardStore;
  dataDir: string;
  close?: () => void;
};

const storeCases: Array<[string, () => Promise<Harness>]> = [
  ["FileHivewardStore", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hiveward-file-store-contract-"));
    const store = new FileHivewardStore(join(dataDir, "hiveward-store.json"));
    await store.init();
    return { store, dataDir };
  }],
  ["SqliteHivewardStore", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hiveward-sqlite-store-contract-"));
    const store = new SqliteHivewardStore(join(dataDir, "hiveward.sqlite"));
    await store.init();
    return { store, dataDir, close: () => store.close() };
  }]
];

describe("SqliteHivewardStore inbox item type filtering", () => {
  it("hides legacy report rows and unknown inbox item types", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hiveward-sqlite-inbox-type-filter-"));
    const store = new SqliteHivewardStore(join(dataDir, "hiveward.sqlite"));
    await store.init();
    const companyState = await store.createCompany({ name: "Inbox Type Filter Company" });
    const companyId = companyState.selectedCompanyId;
    if (!companyId) throw new Error("Expected selected company.");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = (store as unknown as {
      driver: {
        db: {
          prepare: (sql: string) => { run: (...values: unknown[]) => unknown };
        };
      };
    }).driver.db;
    const insert = db.prepare(
      `INSERT INTO inbox_items (
        id, company_id, type, status, title, summary, created_by_role_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const now = "2026-05-31T00:00:00.000Z";
    insert.run("inbox-report", companyId, "report", "pending", "Legacy report", "Should not appear.", "ceo", now, now);
    insert.run("inbox-unknown", companyId, "unknown", "pending", "Unknown", "Should not be coerced.", "ceo", now, now);
    insert.run("inbox-config", companyId, "company_config", "pending", "Config", "Valid item.", "ceo", now, now);

    try {
      await expect(store.listInboxItems()).resolves.toEqual([
        expect.objectContaining({ id: "inbox-config", type: "company_config" })
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("unsupported inbox item type"));
    } finally {
      warn.mockRestore();
      store.close();
    }
  });
});

describe.each(storeCases)("%s store contract", (_label, createHarness) => {
  it("persists runtime state and rebuilds the existing run view shape", async () => {
    const { store, close } = await createHarness();
    try {
      const companyState = await store.createCompany({ name: "Contract Company" });
      const companyId = companyState.selectedCompanyId;
      if (!companyId) throw new Error("Expected selected company.");

      const blueprint = await store.saveBlueprint(createContractBlueprint(companyId));
      await expect(store.getBlueprint(blueprint.id)).resolves.toMatchObject({ id: blueprint.id, name: "Contract Blueprint" });
      await expect(store.listBlueprints()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: blueprint.id })]));

      const run = await store.createBlueprintRun(blueprint, "contract-user");
      await store.saveBlueprint({ ...blueprint, name: "Current Blueprint After Run" });
      await expect(store.getBlueprint(blueprint.id)).resolves.toMatchObject({ name: "Current Blueprint After Run" });
      await expect(store.getRunArchive(run.id)).resolves.toMatchObject({
        blueprintSnapshot: { id: blueprint.id, name: "Contract Blueprint" }
      });
      const output = {
        contractVersion: 2,
        humanReportMd: "## Contract Report\n\nDone.",
        handoffJson: { next: "manager" },
        result: { ok: true },
        artifacts: [{
          id: "artifact-contract",
          slot: "deliverable",
          title: "Contract Markdown",
          kind: "markdown" as const,
          content: "# Done"
        }]
      };
      const nodeRun = createContractNodeRun(run, output);
      await store.upsertNodeRun(nodeRun);
      await store.appendEvent(createContractEvent(run.id, nodeRun.id, 1));
      await store.appendEvent(createContractEvent(run.id, nodeRun.id, 2));

      const { session, round } = createContractIteration(run.id);
      await store.upsertIterationSession(session);
      await store.upsertIterationRound(round);

      const approval = await store.upsertApprovalRequest(createContractApproval(run.id, nodeRun.id));
      await store.appendApprovalDecision(createContractDecision(approval.id));
      await store.upsertApprovalRequest({
        ...approval,
        status: "replied",
        capabilities: resolveClosedCapabilities(),
        updatedAt: contractNow
      });

      const artifact = await store.upsertArtifact(createContractArtifact(run.id, nodeRun.id, round.id));
      await store.upsertReleaseReport(createContractReleaseReport(run.id, round.id, approval.id));
      await store.upsertAgentHumanReport(createContractHumanReport(run.id, nodeRun.id, round.id));
      await store.upsertAgentHandoff(createContractHandoff(run.id, nodeRun.id, round.id));
      await store.upsertManagerContextSnapshot(createContractManagerContext(run.id, session.id, round.id));
      await store.appendRunTimelineItem(createContractTimelineItem(run.id));

      const view = await store.getRunView(run.id);
      expect(view).toMatchObject({
        run: { id: run.id, blueprintName: "Contract Blueprint" },
        nodeRuns: [expect.objectContaining({ id: nodeRun.id, status: "succeeded", output })],
        approvalRequests: [expect.objectContaining({ id: approval.id, status: "replied" })],
        approvalThreads: [expect.objectContaining({ id: approval.id, status: "closed", currentRevision: 1 })],
        approvalReplies: [expect.objectContaining({
          id: "reply-approval-decision-contract",
          threadId: approval.id,
          approvalRequestId: approval.id,
          body: "Please tighten the report."
        })],
        artifacts: [expect.objectContaining({ id: artifact.id, slot: "deliverable" })],
        agentHumanReports: [expect.objectContaining({ nodeRunId: nodeRun.id, bodyMd: expect.stringContaining("Contract Report") })],
        agentHandoffs: [expect.objectContaining({ nodeRunId: nodeRun.id, payload: { next: "manager", facts: ["contract complete"] } })],
        managerContextSnapshots: [expect.objectContaining({ id: "manager-context-contract" })],
        runTimeline: [expect.objectContaining({ id: "timeline-contract", sequence: 1 })]
      });
      expect(view?.events.map((event) => event.id)).toEqual(["event-contract-1", "event-contract-2"]);

      await expect(store.listRunSummaries()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: run.id })]));
      await expect(store.listPendingApprovals()).resolves.toEqual([]);
      await expect(store.listApprovalDecisions(approval.id)).resolves.toEqual([expect.objectContaining({ id: "approval-decision-contract" })]);
      await expect(store.listApprovalThreads({ runId: run.id })).resolves.toEqual([
        expect.objectContaining({ id: approval.id, status: "closed" })
      ]);
      await expect(store.listApprovalReplies({ approvalRequestId: approval.id })).resolves.toEqual([
        expect.objectContaining({
          id: "reply-approval-decision-contract",
          threadId: approval.id,
          metadata: expect.objectContaining({
            source: "approval_decision",
            requestKind: approval.kind,
            resultingStatus: "replied"
          })
        })
      ]);

      const inbox = await store.createBlueprintProposal({
        title: "Import proposal",
        summary: "Import a portable blueprint.",
        blueprintPackage: createContractPortablePackage()
      });
      const replied = await store.replyToInboxItem(inbox.id, "Please narrow scope.");
      expect(replied.replies?.[0]?.body).toBe("Please narrow scope.");
      const approved = await store.approveInboxItem(inbox.id, undefined, "Approved.");
      expect(approved.item.status).toBe("approved");
      expect(approved.importedBlueprints?.[0]?.name).toBe("Portable Contract Blueprint");

      const rejectedProposal = await store.createBlueprintProposal({
        title: "Reject proposal",
        summary: "Reject a portable blueprint.",
        blueprintPackage: createContractPortablePackage()
      });
      await expect(store.rejectInboxItem(rejectedProposal.id, "No capacity.")).resolves.toMatchObject({ status: "rejected" });

      const sessionRecord = await store.createChatSession({ harnessId: "codex", title: "Contract chat" });
      await store.appendChatMessage({
        sessionId: sessionRecord.id,
        role: "user",
        content: "Hello",
        harnessId: "codex",
        status: "sent"
      });
      await expect(store.listChatMessages(sessionRecord.id)).resolves.toEqual([expect.objectContaining({ content: "Hello" })]);
    } finally {
      close?.();
    }
  }, 20_000);

  it("projects the pending approval harness from the paused node runtime", async () => {
    const { store, close } = await createHarness();
    try {
      const companyState = await store.createCompany({ name: "Runtime Approval Company" });
      const companyId = companyState.selectedCompanyId;
      if (!companyId) throw new Error("Expected selected company.");
      const blueprint = await store.saveBlueprint(createContractBlueprint(companyId));
      const run = await store.createBlueprintRun(blueprint, "contract-user");
      const nodeRun = {
        ...createContractNodeRun(run, undefined, "waiting_approval"),
        output: {
          approvalType: "agent",
          reviewOutput: "Draft answer",
          replies: []
        },
        runtimeRef: {
          source: "claude",
          sourceId: "claude-task-contract",
          sourceUpdatedAt: contractNow,
          taskId: "claude-task-contract",
          runId: "claude-run-contract",
          sessionKey: "claude-session-contract"
        }
      } as const;
      await store.upsertNodeRun(nodeRun);
      await store.upsertApprovalRequest(createContractApproval(run.id, nodeRun.id));

      await expect(store.listPendingApprovals()).resolves.toEqual([
        expect.objectContaining({
          approvalRequestId: "approval-contract",
          harnessId: "claude"
        })
      ]);
    } finally {
      close?.();
    }
  });

  it("exposes request-level selected candidate state in pending approval views", async () => {
    const { store, close } = await createHarness();
    try {
      const companyState = await store.createCompany({ name: "Selected Candidate Company" });
      const companyId = companyState.selectedCompanyId;
      if (!companyId) throw new Error("Expected selected company.");
      const blueprint = await store.saveBlueprint(createContractBlueprint(companyId));
      const run = await store.createBlueprintRun(blueprint, "contract-user");
      const request = await store.upsertApprovalRequest({
        id: "approval-selected-candidate",
        runId: run.id,
        kind: "iteration_requirement_plan",
        status: "pending",
        title: "Round plan",
        body: "Original plan",
        threadId: "thread-selected-candidate",
        revision: 1,
        selectedReplyId: "reply-selected-candidate",
        capabilities: {
          approve: true,
          reject: true,
          reply: true,
          complete: false,
          terminate: false
        },
        requestedBy: { type: "node", label: "Manager", nodeId: "contract-manager" },
        requestedAt: contractNow,
        updatedAt: contractNow
      });
      await store.appendApprovalReply({
        id: "reply-selected-candidate",
        threadId: request.threadId ?? request.id,
        approvalRequestId: request.id,
        actor: "manager",
        body: "Candidate plan",
        createdAt: contractNow,
        metadata: { inboxDiscussionMode: "candidate", candidate: true }
      });

      await expect(store.listPendingApprovals()).resolves.toEqual([
        expect.objectContaining({
          approvalRequestId: request.id,
          selectedReplyId: "reply-selected-candidate",
          replies: [
            expect.objectContaining({
              id: "reply-selected-candidate",
              selected: true,
              canUseAsSolution: true
            })
          ]
        })
      ]);
    } finally {
      close?.();
    }
  });

  it("applies approval and inbox decisions once with conflict on repeats", async () => {
    const { store, close } = await createHarness();
    try {
      const blueprint = await store.saveBlueprint(createContractBlueprint());
      const run = await store.createBlueprintRun(blueprint, "contract-user");
      const approval = await store.upsertApprovalRequest(createContractApproval(run.id, "node-run-contract-agent"));
      const approvedRequest = {
        ...approval,
        status: "approved" as const,
        capabilities: resolveClosedCapabilities(),
        updatedAt: contractNow
      };
      const decision = createDecision("decision-approval-once", approval.id, "approve", "approved");
      await expect(store.applyApprovalDecision({
        approvalRequestId: approval.id,
        expectedStatus: "pending",
        nextRequest: approvedRequest,
        decision,
        timelineItem: createDecisionTimeline("timeline-approval-once", run.id, decision)
      })).resolves.toMatchObject({ status: "applied" });
      await expect(store.applyApprovalDecision({
        approvalRequestId: approval.id,
        expectedStatus: "pending",
        nextRequest: approvedRequest,
        decision: createDecision("decision-approval-duplicate", approval.id, "approve", "approved")
      })).resolves.toMatchObject({ status: "conflict" });
      await expect(store.listApprovalDecisions(approval.id)).resolves.toHaveLength(1);

      const inbox = await store.createBlueprintProposal({
        title: "Atomic inbox proposal",
        summary: "Import a portable blueprint.",
        blueprintPackage: createContractPortablePackage()
      });
      const inboxApproval = await store.upsertApprovalRequest({
        ...createContractApproval(inbox.id, "inbox-node"),
        id: `approval-${inbox.id}`,
        runId: inbox.id,
        kind: "blueprint_proposal",
        sourceRef: { type: "inbox_item", id: inbox.id },
        payloadRef: inbox.id
      });
      const inboxReplyDecision = createDecision("decision-inbox-reply", inboxApproval.id, "reply", "pending", "Need details.");
      await expect(store.applyInboxDecision({
        inboxItemId: inbox.id,
        approvalRequestId: inboxApproval.id,
        action: "reply",
        comment: "Need details.",
        approvalDecision: inboxReplyDecision
      })).resolves.toMatchObject({ status: "applied", item: expect.objectContaining({ status: "pending" }) });
      await expect(store.listApprovalReplies({ approvalRequestId: inboxApproval.id })).resolves.toEqual([
        expect.objectContaining({ id: "reply-decision-inbox-reply", body: "Need details.", threadId: inboxApproval.id })
      ]);
      await expect(store.listApprovalThreads({ runId: inbox.id, status: "open" })).resolves.toEqual([
        expect.objectContaining({ id: inboxApproval.id, currentRequestId: inboxApproval.id })
      ]);
      const inboxDecision = createDecision("decision-inbox-once", inboxApproval.id, "approve", "approved");
      await expect(store.applyInboxDecision({
        inboxItemId: inbox.id,
        approvalRequestId: inboxApproval.id,
        action: "approve",
        defaults: {},
        approvalDecision: inboxDecision
      })).resolves.toMatchObject({ status: "applied", item: expect.objectContaining({ status: "approved" }) });
      await expect(store.applyInboxDecision({
        inboxItemId: inbox.id,
        approvalRequestId: inboxApproval.id,
        action: "approve",
        approvalDecision: createDecision("decision-inbox-duplicate", inboxApproval.id, "approve", "approved")
      })).resolves.toMatchObject({ status: "conflict" });
      await expect(store.listApprovalDecisions(inboxApproval.id)).resolves.toEqual([
        expect.objectContaining({ id: "decision-inbox-reply" }),
        expect.objectContaining({ id: "decision-inbox-once" })
      ]);
      await expect(store.listApprovalThreads({ runId: inbox.id, status: "closed" })).resolves.toEqual([
        expect.objectContaining({ id: inboxApproval.id, currentRequestId: undefined })
      ]);
    } finally {
      close?.();
    }
  });
});

describe("SqliteHivewardStore runtime storage", () => {
  it("creates new runs without writing data/runs JSON archives", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hiveward-sqlite-no-run-json-"));
    const store = new SqliteHivewardStore(join(dataDir, "hiveward.sqlite"));
    await store.init();
    try {
      const blueprint = await store.saveBlueprint(createContractBlueprint());
      const run = await store.createBlueprintRun(blueprint, "contract-user");
      await store.upsertNodeRun(createContractNodeRun(run, { result: { ok: true } }));

      const runsDir = join(dataDir, "runs");
      const runFiles = existsSync(runsDir) ? await readdir(runsDir) : [];
      expect(runFiles.filter((file) => file.endsWith(".json") || file.endsWith(".tmp"))).toEqual([]);
      await expect(store.getRunView(run.id)).resolves.toMatchObject({
        nodeRuns: [expect.objectContaining({ id: "node-run-contract-agent" })]
      });
    } finally {
      store.close();
    }
  });

  it("atomically claims and completes node runs across SQLite connections", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hiveward-sqlite-claim-"));
    const sqlitePath = join(dataDir, "hiveward.sqlite");
    const first = new SqliteHivewardStore(sqlitePath);
    const second = new SqliteHivewardStore(sqlitePath);
    await first.init();
    await second.init();
    try {
      const blueprint = await first.saveBlueprint(createContractBlueprint());
      const run = await first.createBlueprintRun(blueprint, "contract-user");
      const queued = createContractNodeRun(run, undefined, "queued");
      await first.upsertNodeRun(queued);

      const claims = await Promise.all([
        first.claimNodeRun({ nodeRunId: queued.id, owner: "worker-a", leaseMs: 30_000 }),
        second.claimNodeRun({ nodeRunId: queued.id, owner: "worker-b", leaseMs: 30_000 })
      ]);
      expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
      const winner = claims[0]?.claimed ? "worker-a" : "worker-b";
      const winnerClaim = claims[0]?.claimed ? claims[0] : claims[1]!;
      const winnerStore = winner === "worker-a" ? first : second;
      const loserStore = winner === "worker-a" ? second : first;

      const completed = {
        ...queued,
        status: "succeeded" as const,
        startedAt: contractNow,
        endedAt: contractNow,
        output: { result: { winner } }
      };
      await expect(winnerStore.completeNodeRun({
        nodeRunId: queued.id,
        owner: winner,
        workerEpoch: winnerClaim.workerEpoch ?? 0,
        nodeRun: completed
      })).resolves.toBe(true);
      await expect(loserStore.completeNodeRun({
        nodeRunId: queued.id,
        owner: winner === "worker-a" ? "worker-b" : "worker-a",
        workerEpoch: winnerClaim.workerEpoch ?? 0,
        nodeRun: { ...completed, output: { result: { winner: "loser" } } }
      })).resolves.toBe(false);

      const view = await first.getRunView(run.id);
      expect(view?.nodeRuns[0]).toMatchObject({ status: "succeeded", output: { result: { winner } } });
    } finally {
      first.close();
      second.close();
    }
  });

  it("rejects late terminal transitions and allows reclaim only after lease expiry", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hiveward-sqlite-lease-"));
    const sqlitePath = join(dataDir, "hiveward.sqlite");
    const first = new SqliteHivewardStore(sqlitePath);
    const second = new SqliteHivewardStore(sqlitePath);
    await first.init();
    await second.init();
    try {
      const blueprint = await first.saveBlueprint(createContractBlueprint());
      const run = await first.createBlueprintRun(blueprint, "contract-user");
      const queued = createContractNodeRun(run, undefined, "queued");
      await first.createQueuedNodeRun(queued);

      const firstClaim = await first.claimNodeRun({ nodeRunId: queued.id, owner: "worker-a", leaseMs: 10 });
      expect(firstClaim.claimed).toBe(true);
      await expect(second.claimNodeRun({ nodeRunId: queued.id, owner: "worker-b", leaseMs: 10 })).resolves.toMatchObject({ claimed: false });
      await new Promise((resolve) => setTimeout(resolve, 25));
      const secondClaim = await second.claimNodeRun({ nodeRunId: queued.id, owner: "worker-b", leaseMs: 30_000 });
      expect(secondClaim.claimed).toBe(true);

      const completed = {
        ...queued,
        status: "succeeded" as const,
        startedAt: contractNow,
        endedAt: contractNow,
        output: { result: { owner: "worker-b" } }
      };
      await expect(first.completeNodeRun({
        nodeRunId: queued.id,
        owner: "worker-a",
        workerEpoch: firstClaim.workerEpoch ?? 0,
        nodeRun: { ...completed, output: { result: { owner: "stale" } } }
      })).resolves.toBe(false);
      await expect(second.completeNodeRun({
        nodeRunId: queued.id,
        owner: "worker-b",
        workerEpoch: secondClaim.workerEpoch ?? 0,
        nodeRun: completed
      })).resolves.toBe(true);
      await expect(first.failNodeRun({
        nodeRunId: queued.id,
        owner: "worker-a",
        workerEpoch: firstClaim.workerEpoch ?? 0,
        error: "late failure"
      })).resolves.toBe(false);
      await expect(second.cancelNodeRun({
        nodeRunId: queued.id,
        owner: "worker-b",
        workerEpoch: secondClaim.workerEpoch ?? 0,
        reason: "late cancel"
      })).resolves.toBe(false);

      const view = await first.getRunView(run.id);
      expect(view?.nodeRuns[0]).toMatchObject({ status: "succeeded", output: { result: { owner: "worker-b" } } });
    } finally {
      first.close();
      second.close();
    }
  });

  it("rolls back publishAgentOutput when a transactional side write fails", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hiveward-sqlite-publish-rollback-"));
    const store = new SqliteHivewardStore(join(dataDir, "hiveward.sqlite"));
    await store.init();
    try {
      const blueprint = await store.saveBlueprint(createContractBlueprint());
      const run = await store.createBlueprintRun(blueprint, "contract-user");
      const queued = createContractNodeRun(run, undefined, "queued");
      await store.createQueuedNodeRun(queued);
      const claim = await store.claimNodeRun({ nodeRunId: queued.id, owner: "worker-a", leaseMs: 30_000 });
      if (!claim.claimed || claim.workerEpoch === undefined) throw new Error("Expected node claim.");
      const completed = {
        ...queued,
        status: "succeeded" as const,
        startedAt: contractNow,
        endedAt: contractNow,
        output: { result: { ok: true } }
      };

      await expect(store.publishAgentOutput({
        runId: run.id,
        nodeRunId: queued.id,
        owner: "worker-a",
        workerEpoch: claim.workerEpoch,
        nodeRun: completed,
        output: completed.output,
        rawResult: completed.output,
        artifacts: [],
        humanReport: {
          ...createContractHumanReport("missing-run", queued.id),
          id: "agent-human-report-invalid-run"
        },
        event: createContractEvent(run.id, queued.id, 99)
      })).rejects.toThrow();

      const view = await store.getRunView(run.id);
      expect(view?.nodeRuns[0]?.status).toBe("running");
      expect(view?.events.some((event) => event.id === "event-contract-99")).toBe(false);
      await expect(store.listAgentHumanReports(run.id)).resolves.toEqual([]);
    } finally {
      store.close();
    }
  });

  it("reopens a WAL-mode SQLite store on Windows paths without losing state", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hiveward-sqlite-wal-reopen-"));
    const sqlitePath = join(dataDir, "hiveward.sqlite");
    const first = new SqliteHivewardStore(sqlitePath);
    await first.init();
    const blueprint = await first.saveBlueprint(createContractBlueprint());
    const run = await first.createBlueprintRun(blueprint, "contract-user");
    first.close();

    const second = new SqliteHivewardStore(sqlitePath);
    await second.init();
    try {
      await expect(second.getBlueprint(blueprint.id)).resolves.toMatchObject({ id: blueprint.id });
      await expect(second.getBlueprintRun(run.id)).resolves.toMatchObject({ id: run.id });
    } finally {
      second.close();
    }
  });

  it("keeps event sequences unique when multiple node completions append events", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hiveward-sqlite-events-"));
    const sqlitePath = join(dataDir, "hiveward.sqlite");
    const first = new SqliteHivewardStore(sqlitePath);
    const second = new SqliteHivewardStore(sqlitePath);
    await first.init();
    await second.init();
    try {
      const blueprint = await first.saveBlueprint(createContractBlueprint());
      const run = await first.createBlueprintRun(blueprint, "contract-user");
      await Promise.all(Array.from({ length: 8 }, (_, index) => {
        const store = index % 2 === 0 ? first : second;
        return store.appendEvent({
          id: `event-concurrent-${index}`,
          blueprintRunId: run.id,
          type: "node.run.completed",
          message: `Node ${index} completed.`,
          createdAt: new Date(Date.parse(contractNow) + index).toISOString()
        });
      }));

      const view = await first.getRunView(run.id);
      expect(view?.events).toHaveLength(8);
      const ids = new Set(view?.events.map((event) => event.id));
      expect(ids.size).toBe(8);
      expect(view?.events.map((event) => event.id)).toEqual(Array.from({ length: 8 }, (_, index) => `event-concurrent-${index}`));
    } finally {
      first.close();
      second.close();
    }
  });

  it("publishes multiple claimed agent outputs across SQLite connections without duplicate terminal writes or sequences", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "hiveward-sqlite-publish-concurrent-"));
    const sqlitePath = join(dataDir, "hiveward.sqlite");
    const first = new SqliteHivewardStore(sqlitePath);
    const second = new SqliteHivewardStore(sqlitePath);
    await first.init();
    await second.init();
    try {
      const blueprint = await first.saveBlueprint(createContractBlueprint());
      const run = await first.createBlueprintRun(blueprint, "contract-user");
      const queuedRuns = await Promise.all(Array.from({ length: 6 }, async (_item, index) => {
        const nodeRun = {
          ...createContractNodeRun(run, undefined, "queued"),
          id: `node-run-concurrent-${index}`,
          nodeId: "contract-agent",
          nodeLabel: `Concurrent ${index}`
        };
        await first.createQueuedNodeRun(nodeRun);
        return nodeRun;
      }));
      const claims = await Promise.all(queuedRuns.map((nodeRun, index) =>
        (index % 2 === 0 ? first : second).claimNodeRun({
          nodeRunId: nodeRun.id,
          owner: `worker-${index}`,
          leaseMs: 30_000
        })
      ));
      expect(claims.every((claim) => claim.claimed && claim.workerEpoch !== undefined)).toBe(true);

      await Promise.all(queuedRuns.map((nodeRun, index) => {
        const store = index % 2 === 0 ? first : second;
        const claim = claims[index]!;
        const completed = {
          ...nodeRun,
          status: "succeeded" as const,
          startedAt: contractNow,
          endedAt: contractNow,
          output: {
            contractVersion: 2,
            humanReportMd: `## Report ${index}`,
            handoffJson: { index },
            result: { index }
          }
        };
        return store.publishAgentOutput({
          runId: run.id,
          nodeRunId: nodeRun.id,
          owner: `worker-${index}`,
          workerEpoch: claim.workerEpoch ?? 0,
          nodeRun: completed,
          output: completed.output,
          rawResult: completed.output,
          artifacts: [{
            id: `artifact-concurrent-${index}`,
            runId: run.id,
            nodeRunId: nodeRun.id,
            slot: "link",
            title: `Concurrent link ${index}`,
            kind: "link",
            downloadUrl: `https://example.invalid/${index}`,
            previewPolicy: "none",
            trusted: false,
            status: "current",
            createdAt: contractNow
          }],
          humanReport: {
            ...createContractHumanReport(run.id, nodeRun.id),
            id: `agent-human-report-concurrent-${index}`,
            nodeId: nodeRun.nodeId,
            nodeLabel: nodeRun.nodeLabel,
            title: `${nodeRun.nodeLabel} report`,
            bodyMd: `## Report ${index}`
          },
          handoff: {
            ...createContractHandoff(run.id, nodeRun.id),
            id: `agent-handoff-concurrent-${index}`,
            nodeId: nodeRun.nodeId,
            payload: { index }
          },
          event: {
            ...createContractEvent(run.id, nodeRun.id, index + 1),
            id: `event-publish-concurrent-${index}`,
            type: "node.run.completed"
          },
          timelineItems: [{
            id: `timeline-publish-concurrent-${index}`,
            runId: run.id,
            createdAt: contractNow,
            actorNodeId: nodeRun.nodeId,
            actorLabel: nodeRun.nodeLabel,
            kind: "node_output",
            title: `${nodeRun.nodeLabel} completed`
          }]
        });
      }));

      const view = await first.getRunView(run.id);
      expect(view?.nodeRuns.filter((nodeRun) => nodeRun.status === "succeeded")).toHaveLength(6);
      expect(view?.artifacts).toHaveLength(6);
      expect(view?.agentHumanReports).toHaveLength(6);
      expect(view?.agentHandoffs).toHaveLength(6);
      expect(view?.events.map((event) => event.id)).toEqual(Array.from({ length: 6 }, (_item, index) => `event-publish-concurrent-${index}`));
      expect(new Set(view?.runTimeline?.map((item) => item.sequence)).size).toBe(6);
    } finally {
      first.close();
      second.close();
    }
  });
});

function resolveClosedCapabilities() {
  return { approve: false, reject: false, reply: false, complete: false, terminate: false };
}

function createDecision(
  id: string,
  approvalRequestId: string,
  action: "approve" | "reject" | "reply",
  resultingStatus: "approved" | "rejected" | "pending",
  comment = "Decision comment."
) {
  return {
    id,
    approvalRequestId,
    action,
    actor: "user" as const,
    comment,
    resultingStatus,
    createdAt: contractNow
  };
}

function createDecisionTimeline(id: string, runId: string, decision: ReturnType<typeof createDecision>) {
  return {
    id,
    runId,
    createdAt: decision.createdAt,
    actorLabel: "user",
    kind: "decision_created" as const,
    title: `Decision ${decision.action}`,
    body: decision.comment,
    payloadRef: decision.approvalRequestId
  };
}
