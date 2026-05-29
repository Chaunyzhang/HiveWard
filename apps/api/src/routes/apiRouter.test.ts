import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it } from "vitest";
import {
  MockRuntimeAdapter,
  type RuntimeChatSessionInput,
  type RuntimeChatSessionTitleInput,
  type RuntimeChatStreamInput
} from "@hiveward/adapter";
import type {
  AgentNodeConfig,
  BlueprintDefinition,
  BlueprintNodeRun,
  BlueprintRun,
  ChatHistoryMessage,
  ChatStreamEvent,
  HivewardChatMessage,
  HivewardChatSession,
  OpenClawConfigState,
  OpenClawVersionInfo,
  RuntimeOverview,
  StartAgentTaskInput,
  WorkspaceDashboard,
  ApprovalRequest
} from "@hiveward/shared";
import { hivewardInboxSubmissionSchema, resolveApprovalCapabilities } from "@hiveward/shared";
import { createApiRouter } from "./apiRouter";
import { ArtifactService } from "../services/artifactService";
import { FileHivewardStore } from "../store/fileHivewardStore";
import type { OpenClawConfigStore } from "../store/openClawConfigStore";
import type { BlueprintWorker } from "../worker/blueprintWorker";

class TrackingAdapter extends MockRuntimeAdapter {
  runtimeOverviewCalls = 0;
  lastStartInput: StartAgentTaskInput | undefined;
  lastChatSessionInput: RuntimeChatSessionInput | undefined;
  lastChatSessionTitleInput: RuntimeChatSessionTitleInput | undefined;
  lastChatStreamInput: RuntimeChatStreamInput | undefined;

  override async startAgentTask(input: StartAgentTaskInput) {
    this.lastStartInput = input;
    return super.startAgentTask(input);
  }

  override async streamChatMessage(input: RuntimeChatStreamInput, onEvent: (event: ChatStreamEvent) => void) {
    this.lastChatStreamInput = input;
    return super.streamChatMessage(input, onEvent);
  }

  override async createChatSession(input: RuntimeChatSessionInput) {
    this.lastChatSessionInput = input;
    return super.createChatSession(input);
  }

  override async updateChatSessionTitle(input: RuntimeChatSessionTitleInput) {
    this.lastChatSessionTitleInput = input;
    return super.updateChatSessionTitle(input);
  }

  override async getRuntimeOverview(): Promise<RuntimeOverview> {
    this.runtimeOverviewCalls += 1;
    throw new Error("runtime overview is not on the run read path");
  }
}

class ChatOutputAdapter extends TrackingAdapter {
  constructor(private readonly output: string) {
    super();
  }

  override async streamChatMessage(input: RuntimeChatStreamInput, onEvent: (event: ChatStreamEvent) => void) {
    this.lastChatStreamInput = input;
    const now = new Date().toISOString();
    const runId = input.idempotencyKey;
    onEvent({
      type: "started",
      taskId: runId,
      runId,
      sessionKey: input.sessionKey,
      source: "openclaw",
      status: "running",
      updatedAt: now
    });
    onEvent({
      type: "delta",
      text: this.output
    });
    onEvent({
      type: "done",
      taskId: runId,
      runId,
      sessionKey: input.sessionKey,
      source: "openclaw",
      status: "succeeded",
      output: this.output,
      updatedAt: now
    });
  }
}

class ChatHistoryAdapter extends TrackingAdapter {
  constructor(private readonly messages: ChatHistoryMessage[]) {
    super();
  }

  override async getSessionMessages(): Promise<ChatHistoryMessage[]> {
    return this.messages;
  }
}

class NativeSessionTrackingAdapter extends TrackingAdapter {
  readonly chatInputs: RuntimeChatStreamInput[] = [];

  constructor(
    private readonly nativeSessionId: string,
    private readonly output = "native session response"
  ) {
    super();
  }

  override async streamChatMessage(input: RuntimeChatStreamInput, onEvent: (event: ChatStreamEvent) => void) {
    this.chatInputs.push(input);
    this.lastChatStreamInput = input;
    const now = new Date().toISOString();
    const sessionKey = input.sessionKey || this.nativeSessionId;
    onEvent({
      type: "started",
      taskId: input.idempotencyKey,
      runId: input.idempotencyKey,
      sessionKey,
      source: input.source ?? "codex",
      status: "running",
      updatedAt: now
    });
    onEvent({ type: "delta", text: this.output });
    onEvent({
      type: "done",
      taskId: input.idempotencyKey,
      runId: input.idempotencyKey,
      sessionKey,
      source: input.source ?? "codex",
      status: "succeeded",
      output: this.output,
      updatedAt: now
    });
  }
}

class NativeMissingAdapter extends TrackingAdapter {
  readonly chatInputs: RuntimeChatStreamInput[] = [];

  override async streamChatMessage(input: RuntimeChatStreamInput, onEvent: (event: ChatStreamEvent) => void) {
    this.chatInputs.push(input);
    this.lastChatStreamInput = input;
    const now = new Date().toISOString();
    if (input.sessionKey === "missing-native-session") {
      onEvent({
        type: "done",
        taskId: input.idempotencyKey,
        runId: input.idempotencyKey,
        sessionKey: input.sessionKey,
        source: input.source ?? "codex",
        status: "failed",
        error: "Cannot resume thread: session not found",
        updatedAt: now
      });
      return;
    }
    const sessionKey = input.sessionKey || "rebuilt-native-session";
    onEvent({ type: "delta", text: "rebuilt response" });
    onEvent({
      type: "done",
      taskId: input.idempotencyKey,
      runId: input.idempotencyKey,
      sessionKey,
      source: input.source ?? "codex",
      status: "succeeded",
      output: "rebuilt response",
      updatedAt: now
    });
  }
}

describe("apiRouter", () => {
  it("creates and selects a new company", async () => {
    const fixture = await createStoreFixture();
    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/companies`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Field Ops",
            businessGoal: "Coordinate field operations.",
            logoLabel: "FO"
          })
        });
        const body = await readOkJson<{
          companies: Array<{ id: string; name: string; businessGoal: string; logoLabel?: string }>;
          selectedCompanyId?: string;
        }>(response);
        const company = body.companies.find((item) => item.name === "Field Ops");

        expect(company).toMatchObject({
          businessGoal: "Coordinate field operations.",
          logoLabel: "FO"
        });
        expect(body.selectedCompanyId).toBe(company?.id);
      });
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("directly creates, renames, and persists an isolated company workspace", async () => {
    const fixture = await createStoreFixture();
    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const initialResponse = await fetch(`${baseUrl}/api/companies`);
        const initialBody = await readOkJson<{ selectedCompanyId: string }>(initialResponse);
        const defaultCompanyId = initialBody.selectedCompanyId;

        const createResponse = await fetch(`${baseUrl}/api/companies`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({})
        });
        const createdBody = await readOkJson<{
          companies: Array<{ id: string; name: string; logoLabel?: string }>;
          selectedCompanyId: string;
        }>(createResponse);
        const companyId = createdBody.selectedCompanyId;
        const createdCompany = createdBody.companies.find((company) => company.id === companyId);

        expect(createdCompany).toMatchObject({
          name: "New Company",
          logoLabel: "NC"
        });

        const emptyWorkspaceResponse = await fetch(`${baseUrl}/api/dashboard-state`);
        const emptyWorkspaceBody = await readOkJson<{ dashboard: WorkspaceDashboard }>(emptyWorkspaceResponse);
        expect(emptyWorkspaceBody.dashboard.notes).toEqual([]);

        const now = new Date().toISOString();
        const companyDashboard: WorkspaceDashboard = {
          dashboardWidgets: [],
          savedViews: [],
          tags: [],
          notes: [
            {
              id: "note-company-only",
              title: "Company scoped note",
              body: "Stored only in the new company's workspace.",
              tagIds: [],
              createdAt: now,
              updatedAt: now
            }
          ],
          updatedAt: now
        };
        const saveWorkspaceResponse = await fetch(`${baseUrl}/api/dashboard-state`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ dashboard: companyDashboard })
        });
        const savedWorkspaceBody = await readOkJson<{ dashboard: WorkspaceDashboard }>(saveWorkspaceResponse);
        expect(savedWorkspaceBody.dashboard.notes).toHaveLength(1);

        const renameResponse = await fetch(`${baseUrl}/api/companies/${companyId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Renamed Ops" })
        });
        const renamedBody = await readOkJson<{ companies: Array<{ id: string; name: string; logoLabel?: string }> }>(renameResponse);
        expect(renamedBody.companies.find((company) => company.id === companyId)).toMatchObject({
          name: "Renamed Ops",
          logoLabel: "RO"
        });

        const selectDefaultResponse = await fetch(`${baseUrl}/api/companies/selected`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ companyId: defaultCompanyId })
        });
        await readOkJson(selectDefaultResponse);
        const defaultWorkspaceResponse = await fetch(`${baseUrl}/api/dashboard-state`);
        const defaultWorkspaceBody = await readOkJson<{ dashboard: WorkspaceDashboard }>(defaultWorkspaceResponse);
        expect(defaultWorkspaceBody.dashboard.notes.some((note) => note.id === "note-company-only")).toBe(false);

        const selectNewResponse = await fetch(`${baseUrl}/api/companies/selected`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ companyId })
        });
        await readOkJson(selectNewResponse);
        const restoredWorkspaceResponse = await fetch(`${baseUrl}/api/dashboard-state`);
        const restoredWorkspaceBody = await readOkJson<{ dashboard: WorkspaceDashboard }>(restoredWorkspaceResponse);
        expect(restoredWorkspaceBody.dashboard.notes).toMatchObject([{ id: "note-company-only" }]);
      });
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("keeps company CEOs, leaders, blueprints, and role scopes isolated", async () => {
    const fixture = await createStoreFixture();
    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const initialCompanies = await readOkJson<{
          selectedCompanyId: string;
        }>(await fetch(`${baseUrl}/api/companies`));
        const defaultCompanyId = initialCompanies.selectedCompanyId;
        const defaultBlueprints = await readOkJson<{ blueprints: Array<{ id: string; companyId: string; name: string }> }>(
          await fetch(`${baseUrl}/api/blueprints`)
        );
        const defaultBlueprintId = defaultBlueprints.blueprints[0]!.id;
        const defaultRoles = await readOkJson<{
          roles: {
            companyId: string;
            ceo: { companyId: string; id: string };
            leaders: Array<{ companyId: string; id: string; blueprintId?: string }>;
          };
          architecture: { companyId: string; nodes: Array<{ kind: string; blueprintId?: string }> };
        }>(await fetch(`${baseUrl}/api/roles`));

        expect(defaultRoles.roles.companyId).toBe(defaultCompanyId);
        expect(defaultRoles.roles.ceo).toMatchObject({ id: "ceo", companyId: defaultCompanyId });
        expect(defaultRoles.roles.leaders.every((leader) => leader.companyId === defaultCompanyId)).toBe(true);
        expect(defaultRoles.roles.leaders.map((leader) => leader.blueprintId).sort()).toEqual(
          defaultBlueprints.blueprints.map((blueprint) => blueprint.id).sort()
        );
        expect(defaultRoles.architecture.companyId).toBe(defaultCompanyId);

        const createCompany = await readOkJson<{ selectedCompanyId: string }>(
          await fetch(`${baseUrl}/api/companies`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "Isolated Company" })
          })
        );
        const isolatedCompanyId = createCompany.selectedCompanyId;

        const emptyBlueprints = await readOkJson<{ blueprints: Array<{ id: string }> }>(await fetch(`${baseUrl}/api/blueprints`));
        expect(emptyBlueprints.blueprints).toEqual([]);
        const emptyRoles = await readOkJson<{
          roles: { companyId: string; ceo: { companyId: string; id: string }; leaders: unknown[] };
          architecture: { companyId: string; nodes: Array<{ kind: string }> };
        }>(await fetch(`${baseUrl}/api/roles`));
        expect(emptyRoles.roles).toMatchObject({
          companyId: isolatedCompanyId,
          ceo: { id: "ceo", companyId: isolatedCompanyId },
          leaders: []
        });
        expect(emptyRoles.architecture).toMatchObject({
          companyId: isolatedCompanyId,
          nodes: [{ kind: "ceo" }]
        });

        const createBlueprint = await readOkJson<{ blueprint: { id: string; companyId: string; name: string } }>(
          await fetch(`${baseUrl}/api/blueprints`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "Isolated Blueprint" })
          })
        );
        const isolatedBlueprintId = createBlueprint.blueprint.id;
        expect(createBlueprint.blueprint).toMatchObject({
          companyId: isolatedCompanyId,
          name: "Isolated Blueprint"
        });

        const isolatedRoles = await readOkJson<{
          roles: {
            companyId: string;
            ceo: { companyId: string; id: string };
            leaders: Array<{ companyId: string; id: string; blueprintId?: string }>;
          };
          architecture: { companyId: string; nodes: Array<{ kind: string; blueprintId?: string }> };
        }>(await fetch(`${baseUrl}/api/roles`));
        expect(isolatedRoles.roles.companyId).toBe(isolatedCompanyId);
        expect(isolatedRoles.roles.ceo.companyId).toBe(isolatedCompanyId);
        expect(isolatedRoles.roles.leaders).toMatchObject([
          {
            companyId: isolatedCompanyId,
            blueprintId: isolatedBlueprintId
          }
        ]);
        expect(isolatedRoles.architecture.nodes.some((node) => node.kind === "leader" && node.blueprintId === isolatedBlueprintId)).toBe(true);

        const selectDefault = await fetch(`${baseUrl}/api/companies/selected`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ companyId: defaultCompanyId })
        });
        await readOkJson(selectDefault);
        const defaultBlueprintsAgain = await readOkJson<{ blueprints: Array<{ id: string; companyId: string }> }>(
          await fetch(`${baseUrl}/api/blueprints`)
        );
        expect(defaultBlueprintsAgain.blueprints.some((blueprint) => blueprint.id === isolatedBlueprintId)).toBe(false);
        expect(defaultBlueprintsAgain.blueprints.every((blueprint) => blueprint.companyId === defaultCompanyId)).toBe(true);
        expect((await fetch(`${baseUrl}/api/blueprints/${isolatedBlueprintId}`)).status).toBe(404);

        const defaultRolesAgain = await readOkJson<{
          roles: { companyId: string; ceo: { companyId: string }; leaders: Array<{ companyId: string; blueprintId?: string }> };
          architecture: { companyId: string; nodes: Array<{ blueprintId?: string }> };
        }>(await fetch(`${baseUrl}/api/roles`));
        expect(defaultRolesAgain.roles.companyId).toBe(defaultCompanyId);
        expect(defaultRolesAgain.roles.ceo.companyId).toBe(defaultCompanyId);
        expect(defaultRolesAgain.roles.leaders.some((leader) => leader.blueprintId === isolatedBlueprintId)).toBe(false);
        expect(defaultRolesAgain.architecture.nodes.some((node) => node.blueprintId === isolatedBlueprintId)).toBe(false);

        const ceoSessionResponse = await fetch(`${baseUrl}/api/chat/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            harnessId: "openclaw",
            roleScope: { role: "ceo", companyId: isolatedCompanyId, blueprintId: isolatedBlueprintId }
          })
        });
        const ceoSessionBody = await readOkJson<{ session: { companyId: string; roleScope?: { companyId?: string; blueprintId?: string } } }>(
          ceoSessionResponse
        );
        expect(ceoSessionBody.session.companyId).toBe(defaultCompanyId);
        expect(ceoSessionBody.session.roleScope).toMatchObject({ companyId: defaultCompanyId });
        expect(ceoSessionBody.session.roleScope?.blueprintId).toBeUndefined();

        const leaderSessionResponse = await fetch(`${baseUrl}/api/chat/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            harnessId: "openclaw",
            roleScope: {
              role: "leader",
              companyId: isolatedCompanyId,
              leaderId: isolatedRoles.roles.leaders[0]!.id,
              blueprintId: isolatedBlueprintId
            }
          })
        });
        const leaderSessionBody = await readOkJson<{ session: { roleScope?: unknown } }>(leaderSessionResponse);
        expect(leaderSessionBody.session.roleScope).toBeUndefined();

        const selectIsolated = await fetch(`${baseUrl}/api/companies/selected`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ companyId: isolatedCompanyId })
        });
        await readOkJson(selectIsolated);
        expect((await fetch(`${baseUrl}/api/blueprints/${defaultBlueprintId}`)).status).toBe(404);
      });
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("deletes a selected company and its scoped blueprints", async () => {
    const fixture = await createStoreFixture();
    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const createCompanyResponse = await fetch(`${baseUrl}/api/companies`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Archive Lab",
            businessGoal: "Temporary company for deletion coverage."
          })
        });
        const createdCompanyBody = await readOkJson<{ selectedCompanyId: string }>(createCompanyResponse);
        const companyId = createdCompanyBody.selectedCompanyId;

        const createBlueprintResponse = await fetch(`${baseUrl}/api/blueprints`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Temporary deletion blueprint" })
        });
        const createdBlueprintBody = await readOkJson<{ blueprint: { id: string } }>(createBlueprintResponse);
        const blueprintPath = join(fixture.dir, "blueprints", `${createdBlueprintBody.blueprint.id}.json`);
        expect(existsSync(blueprintPath)).toBe(true);

        const deleteResponse = await fetch(`${baseUrl}/api/companies/${companyId}`, {
          method: "DELETE"
        });
        const deleteBody = await readOkJson<{
          companies: Array<{ id: string; name: string }>;
          selectedCompanyId?: string;
          deleted: boolean;
        }>(deleteResponse);

        expect(deleteBody.deleted).toBe(true);
        expect(deleteBody.companies.some((company) => company.id === companyId)).toBe(false);
        expect(deleteBody.selectedCompanyId).not.toBe(companyId);
        expect(existsSync(blueprintPath)).toBe(false);
      });
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("lists run summaries from runIndex without reading archive files", async () => {
    const fixture = await createStoreFixture();
    try {
      const blueprint = (await fixture.store.listBlueprints())[0]!;
      const run = await fixture.store.createBlueprintRun(blueprint, "tester");
      rmSync(join(fixture.dir, "runs", `${run.id}.json`), { force: true });

      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/blueprint-runs`);
        const body = await readOkJson<{ runs: Array<Record<string, unknown>> }>(response);

        expect(body.runs[0]).toMatchObject({
          id: run.id,
          blueprintId: blueprint.id,
          blueprintName: blueprint.name
        });
        expect(body.runs[0]).not.toHaveProperty("nodeRuns");
        expect(body.runs[0]).not.toHaveProperty("events");
      });
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("serves a single run archive without touching runtime overview", async () => {
    const fixture = await createStoreFixture();
    const adapter = new TrackingAdapter();
    try {
      const blueprint = (await fixture.store.listBlueprints())[0]!;
      const run = await fixture.store.createBlueprintRun(blueprint, "tester");

      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/blueprint-runs/${run.id}`);
        const body = await readOkJson<{ run: { run: { id: string }; nodeRuns: unknown[]; events: unknown[] } }>(response);

        expect(body.run.run.id).toBe(run.id);
        expect(body.run.nodeRuns).toEqual([]);
        expect(body.run.events).toEqual([]);
        expect(adapter.runtimeOverviewCalls).toBe(0);
      }, adapter);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("routes legacy blueprint approval actions through pending approval requests", async () => {
    const fixture = await createStoreFixture();
    const calls: Array<{ action: string; approvalRequestId?: string; comment?: string; message?: string; selectedReplyId?: string }> = [];
    const worker = {
      async applyApprovalRequest(
        _blueprint: BlueprintDefinition,
        run: BlueprintRun,
        approvalRequestId: string,
        action: "approve" | "reject" | "reply",
        input?: { comment?: string; message?: string; selectedReplyId?: string }
      ) {
        calls.push({ action, approvalRequestId, comment: input?.comment, message: input?.message, selectedReplyId: input?.selectedReplyId });
        return { ...run, status: "waiting_approval" as const };
      },
      async selectApprovalReply(_blueprint: BlueprintDefinition, run: BlueprintRun, nodeRunId: string, selectedReplyId: string) {
        calls.push({ action: "select", approvalRequestId: nodeRunId, selectedReplyId });
        return { ...run, status: "waiting_approval" as const };
      }
    } as unknown as BlueprintWorker;

    try {
      const blueprint = (await fixture.store.listBlueprints())[0]!;
      const run = await fixture.store.createBlueprintRun(blueprint, "tester");
      const approval1 = await seedRunApprovalRequest(fixture.store, run.id, "node-run-1");
      const approval2 = await seedRunApprovalRequest(fixture.store, run.id, "node-run-2");
      const approval3 = await seedRunApprovalRequest(fixture.store, run.id, "node-run-3");

      await withApiServer(fixture.store, async (baseUrl) => {
        await readOkJson(await fetch(`${baseUrl}/api/blueprint-runs/${run.id}/approve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ nodeRunId: "node-run-1", comment: "Looks good.", selectedReplyId: "reply-1" })
        }));
        await readOkJson(await fetch(`${baseUrl}/api/blueprint-runs/${run.id}/reject`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ nodeRunId: "node-run-2", comment: "Needs work." })
        }));
        await readOkJson(await fetch(`${baseUrl}/api/blueprint-runs/${run.id}/reply`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ nodeRunId: "node-run-3", message: "Please revise this answer." })
        }));
        await readOkJson(await fetch(`${baseUrl}/api/blueprint-runs/${run.id}/select-approval-reply`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ nodeRunId: "node-run-4", selectedReplyId: "reply-4" })
        }));
      }, new TrackingAdapter(), createConfigStoreFixture(), worker);

      expect(calls).toEqual([
        { action: "approve", approvalRequestId: approval1.id, comment: "Looks good.", selectedReplyId: "reply-1" },
        { action: "reject", approvalRequestId: approval2.id, comment: "Needs work.", selectedReplyId: undefined },
        { action: "reply", approvalRequestId: approval3.id, message: "Please revise this answer.", comment: undefined, selectedReplyId: undefined },
        { action: "select", approvalRequestId: "node-run-4", selectedReplyId: "reply-4" }
      ]);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("returns 409 for repeated approval and inbox decisions", async () => {
    const fixture = await createStoreFixture();
    try {
      const approval = await seedStandaloneApprovalRequest(fixture.store, "external-approval");
      const roles = await fixture.store.getRoleDirectory();
      const item = await fixture.store.createLeaderDelegationRequest({
        leaderId: roles.roles.leaders[0]!.id,
        title: "Delegate to leader"
      });
      await seedInboxApprovalRequest(fixture.store, item.id);

      await withApiServer(fixture.store, async (baseUrl) => {
        await readOkJson(await fetch(`${baseUrl}/api/approval-requests/${approval.id}/approve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ comment: "Approved once." })
        }));
        const secondApproval = await fetch(`${baseUrl}/api/approval-requests/${approval.id}/approve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ comment: "Duplicate click." })
        });
        const secondApprovalBody = await secondApproval.json() as { error?: { code?: string } };
        expect(secondApproval.status, JSON.stringify(secondApprovalBody)).toBe(409);
        expect(secondApprovalBody.error?.code).toBe("approval_conflict");
        expect(await fixture.store.listApprovalDecisions(approval.id)).toHaveLength(1);

        await readOkJson(await fetch(`${baseUrl}/api/inbox/${item.id}/approve`, { method: "POST" }));
        const secondInbox = await fetch(`${baseUrl}/api/inbox/${item.id}/approve`, { method: "POST" });
        const secondInboxBody = await secondInbox.json() as { error?: { code?: string } };
        expect(secondInbox.status).toBe(409);
        expect(secondInboxBody.error?.code).toBe("inbox_decision_conflict");
        const inboxRequest = (await fixture.store.listApprovalRequests({ runId: item.id }))[0]!;
        expect(await fixture.store.listApprovalDecisions(inboxRequest.id)).toHaveLength(1);
      });
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("serves published HTML artifact download URLs from the configured store data directory", async () => {
    const fixture = await createStoreFixture();
    try {
      const now = new Date().toISOString();
      const service = new ArtifactService(fixture.store);
      const [artifact] = await service.publishFromNodeRun({
        runId: "run-artifact-route",
        roundId: "round-artifact-route",
        nodeRun: {
          id: "node-run-artifact-route",
          blueprintRunId: "run-artifact-route",
          blueprintId: "blueprint-artifact-route",
          nodeId: "html-builder",
          nodeLabel: "HTML Builder",
          nodeType: "agent",
          status: "succeeded",
          queuedAt: now,
          startedAt: now,
          endedAt: now,
          output: {
            humanReportMd: "## Delivery location\n\n- HTML preview declared in artifacts[].",
            artifacts: [{
              title: "HTML Builder",
              kind: "html",
              content: "<!doctype html><html><body>artifact route ok</body></html>"
            }]
          }
        } satisfies BlueprintNodeRun
      });
      if (!artifact?.downloadUrl) throw new Error("Expected published HTML artifact with a downloadUrl.");

      expect(artifact).toMatchObject({
        kind: "html",
        trusted: false,
        previewPolicy: "sandboxed_iframe"
      });
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await fetch(`${baseUrl}${artifact.downloadUrl}`);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("artifact route ok");
      });
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("serves published markdown and JSON artifact download URLs", async () => {
    const fixture = await createStoreFixture();
    try {
      const now = new Date().toISOString();
      const service = new ArtifactService(fixture.store);
      const markdownArtifacts = await service.publishFromNodeRun({
        runId: "run-artifact-route-md",
        roundId: "round-artifact-route-md",
        nodeRun: {
          id: "node-run-artifact-route-md",
          blueprintRunId: "run-artifact-route-md",
          blueprintId: "blueprint-artifact-route",
          nodeId: "markdown-builder",
          nodeLabel: "Markdown Builder",
          nodeType: "agent",
          status: "succeeded",
          queuedAt: now,
          startedAt: now,
          endedAt: now,
          output: {
            humanReportMd: "## Delivery location\n\n- Markdown declared in artifacts[].",
            artifacts: [{
              title: "Markdown Builder",
              kind: "markdown",
              content: "# Artifact route markdown"
            }]
          }
        } satisfies BlueprintNodeRun
      });
      const jsonArtifacts = await service.publishFromNodeRun({
        runId: "run-artifact-route-json",
        roundId: "round-artifact-route-json",
        nodeRun: {
          id: "node-run-artifact-route-json",
          blueprintRunId: "run-artifact-route-json",
          blueprintId: "blueprint-artifact-route",
          nodeId: "json-builder",
          nodeLabel: "JSON Builder",
          nodeType: "agent",
          status: "succeeded",
          queuedAt: now,
          startedAt: now,
          endedAt: now,
          output: {
            humanReportMd: "## Delivery location\n\n- JSON declared in artifacts[].",
            artifacts: [{
              title: "JSON Builder",
              kind: "json",
              content: { ok: true, message: "artifact route json" }
            }]
          }
        } satisfies BlueprintNodeRun
      });
      const markdown = markdownArtifacts[0];
      const json = jsonArtifacts[0];
      if (!markdown?.downloadUrl || !json?.downloadUrl) throw new Error("Expected markdown and JSON artifacts with download URLs.");

      expect(markdown).toMatchObject({
        kind: "markdown",
        previewPolicy: "source",
        relativePath: expect.stringContaining(".md")
      });
      expect(json).toMatchObject({
        kind: "json",
        previewPolicy: "source",
        relativePath: expect.stringContaining(".json")
      });

      await withApiServer(fixture.store, async (baseUrl) => {
        const markdownResponse = await fetch(`${baseUrl}${markdown.downloadUrl}`);
        expect(markdownResponse.status).toBe(200);
        expect(await markdownResponse.text()).toContain("Artifact route markdown");

        const jsonResponse = await fetch(`${baseUrl}${json.downloadUrl}`);
        expect(jsonResponse.status).toBe(200);
        expect(await jsonResponse.json()).toMatchObject({ ok: true, message: "artifact route json" });
      });
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("deletes a blueprint from the selected company", async () => {
    const fixture = await createStoreFixture();
    try {
      const blueprint = (await fixture.store.listBlueprints())[0]!;

      await withApiServer(fixture.store, async (baseUrl) => {
        const deleteResponse = await fetch(`${baseUrl}/api/blueprints/${blueprint.id}`, {
          method: "DELETE"
        });
        const deleteBody = await readOkJson<{ blueprintId: string }>(deleteResponse);
        expect(deleteBody.blueprintId).toBe(blueprint.id);

        const listResponse = await fetch(`${baseUrl}/api/blueprints`);
        const listBody = await readOkJson<{ blueprints: Array<{ id: string }> }>(listResponse);
        expect(listBody.blueprints.some((item) => item.id === blueprint.id)).toBe(false);

        const getResponse = await fetch(`${baseUrl}/api/blueprints/${blueprint.id}`);
        expect(getResponse.status).toBe(404);
      });
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("persists architecture blueprint node positions across role rebuilds", async () => {
    const fixture = await createStoreFixture();
    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const initial = await readOkJson<{
          architecture: { nodes: Array<{ id: string; kind: string; position: { x: number; y: number } }> };
        }>(await fetch(`${baseUrl}/api/roles`));
        const ceo = initial.architecture.nodes.find((node) => node.kind === "ceo")!;
        const leader = initial.architecture.nodes.find((node) => node.kind === "leader")!;

        const saveLayoutResponse = await fetch(`${baseUrl}/api/roles/architecture-layout`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            positions: {
              [ceo.id]: { x: -40, y: 16 },
              [leader.id]: { x: 320, y: 480 }
            }
          })
        });
        const saved = await readOkJson<{
          architecture: { nodes: Array<{ id: string; position: { x: number; y: number } }> };
        }>(saveLayoutResponse);
        expect(saved.architecture.nodes.find((node) => node.id === ceo.id)?.position).toEqual({ x: -40, y: 16 });
        expect(saved.architecture.nodes.find((node) => node.id === leader.id)?.position).toEqual({ x: 320, y: 480 });

        await readOkJson(await fetch(`${baseUrl}/api/blueprints`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Layout rebuild coverage" })
        }));

        const afterRebuild = await readOkJson<{
          architecture: { nodes: Array<{ id: string; position: { x: number; y: number } }> };
        }>(await fetch(`${baseUrl}/api/roles`));
        expect(afterRebuild.architecture.nodes.find((node) => node.id === ceo.id)?.position).toEqual({ x: -40, y: 16 });
        expect(afterRebuild.architecture.nodes.find((node) => node.id === leader.id)?.position).toEqual({ x: 320, y: 480 });
      });
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("injects runtime default models before starting a blueprint run", async () => {
    const fixture = await createStoreFixture();
    const previousCodexDefault = process.env.HIVEWARD_CODEX_DEFAULT_MODEL;
    const previousClaudeDefault = process.env.HIVEWARD_CLAUDE_CODE_DEFAULT_MODEL;
    process.env.HIVEWARD_CODEX_DEFAULT_MODEL = "codex/test-default";
    process.env.HIVEWARD_CLAUDE_CODE_DEFAULT_MODEL = "claude/test-default";

    const startedBlueprints: BlueprintDefinition[] = [];
    const worker = {
      async startRun(blueprint: BlueprintDefinition, startedBy: string) {
        startedBlueprints.push(blueprint);
        return fixture.store.createBlueprintRun(blueprint, startedBy);
      }
    } as unknown as BlueprintWorker;

    try {
      await withApiServer(
        fixture.store,
        async (baseUrl) => {
          const response = await fetch(`${baseUrl}/api/blueprints/multi-agent-compatibility-blueprint/runs`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ startedBy: "tester" })
          });
          await readOkJson(response);

          const started = startedBlueprints[0]!;
          expect(readAgentConfig(started, "compat-openclaw-brief").modelId).toBe("openclaw/default");
          expect(readAgentConfig(started, "compat-codex-check").modelId).toBe("codex/test-default");
          expect(readAgentConfig(started, "compat-claude-check").modelId).toBe("claude/test-default");
        },
        new TrackingAdapter(),
        createConfigStoreFixture(),
        worker
      );
    } finally {
      restoreEnv("HIVEWARD_CODEX_DEFAULT_MODEL", previousCodexDefault);
      restoreEnv("HIVEWARD_CLAUDE_CODE_DEFAULT_MODEL", previousClaudeDefault);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("reports Codex models from the local Codex config and model cache", async () => {
    const fixture = await createStoreFixture();
    const codexHome = join(fixture.dir, "codex-home");
    const previousCodexHome = process.env.CODEX_HOME;
    const previousHivewardCodexDefault = process.env.HIVEWARD_CODEX_DEFAULT_MODEL;
    const previousCodexDefault = process.env.CODEX_DEFAULT_MODEL;
    process.env.CODEX_HOME = codexHome;
    delete process.env.HIVEWARD_CODEX_DEFAULT_MODEL;
    delete process.env.CODEX_DEFAULT_MODEL;

    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n[profiles.fast]\nmodel = "gpt-5.3-codex-spark"\n');
    writeFileSync(join(codexHome, "auth.json"), "{}");
    writeFileSync(join(codexHome, "models_cache.json"), JSON.stringify({
      models: [
        {
          slug: "gpt-5.4",
          display_name: "GPT-5.4",
          visibility: "list",
          supported_in_api: true,
          priority: 4,
          supported_reasoning_levels: [{ effort: "low" }, { effort: "minimal" }, { effort: "high" }]
        },
        {
          slug: "gpt-5.5",
          display_name: "GPT-5.5",
          visibility: "list",
          supported_in_api: true,
          priority: 9,
          supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "xhigh" }]
        },
        {
          slug: "internal-hidden-model",
          display_name: "Hidden",
          visibility: "hidden",
          supported_in_api: true,
          priority: 99
        }
      ]
    }));

    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/harness-status`);
        const body = await readOkJson<{
          statuses: Array<{ id: string; defaultModelId?: string; models?: Array<{ id: string; label: string; isDefault?: boolean; thinkingLevels?: string[] }> }>;
        }>(response);
        const codexStatus = body.statuses.find((status) => status.id === "codex");
        const codexModelIds = codexStatus?.models?.map((model) => model.id) ?? [];

        expect(codexStatus?.defaultModelId).toBe("gpt-5.5");
        expect(codexStatus?.models?.[0]).toMatchObject({
          id: "gpt-5.5",
          label: "GPT-5.5",
          isDefault: true
        });
        expect(codexModelIds).toEqual(expect.arrayContaining(["gpt-5.5", "gpt-5.4"]));
        expect(codexModelIds).not.toContain("internal-hidden-model");
        expect(codexStatus?.models?.find((model) => model.id === "gpt-5.4")?.thinkingLevels).toEqual(["low", "high"]);
      });
    } finally {
      restoreEnv("CODEX_HOME", previousCodexHome);
      restoreEnv("HIVEWARD_CODEX_DEFAULT_MODEL", previousHivewardCodexDefault);
      restoreEnv("CODEX_DEFAULT_MODEL", previousCodexDefault);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("reports Claude Code model options from local Claude settings", async () => {
    const fixture = await createStoreFixture();
    const claudeHome = join(fixture.dir, "claude-home");
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const previousHivewardClaudeDefault = process.env.HIVEWARD_CLAUDE_CODE_DEFAULT_MODEL;
    const previousClaudeDefault = process.env.CLAUDE_CODE_DEFAULT_MODEL;
    const previousHivewardClaudeModels = process.env.HIVEWARD_CLAUDE_CODE_MODELS;
    const previousClaudeModels = process.env.CLAUDE_CODE_MODELS;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    delete process.env.HIVEWARD_CLAUDE_CODE_DEFAULT_MODEL;
    delete process.env.CLAUDE_CODE_DEFAULT_MODEL;
    delete process.env.HIVEWARD_CLAUDE_CODE_MODELS;
    delete process.env.CLAUDE_CODE_MODELS;

    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({
      env: {
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-local",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-local",
        UNRELATED_TOKEN: "not-a-model"
      }
    }));
    writeFileSync(join(claudeHome, ".credentials.json"), "{}");

    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/harness-status`);
        const body = await readOkJson<{
          statuses: Array<{ id: string; defaultModelId?: string; models?: Array<{ id: string; isDefault?: boolean }> }>;
        }>(response);
        const claudeStatus = body.statuses.find((status) => status.id === "claudeCode");
        const claudeModelIds = claudeStatus?.models?.map((model) => model.id) ?? [];

        expect(claudeStatus?.defaultModelId).toBe("inherit");
        expect(claudeStatus?.models?.[0]).toMatchObject({ id: "inherit", isDefault: true });
        expect(claudeModelIds).toEqual(expect.arrayContaining(["inherit", "claude-haiku-local", "claude-sonnet-local"]));
        expect(claudeModelIds).not.toContain("not-a-model");
      });
    } finally {
      restoreEnv("CLAUDE_CONFIG_DIR", previousClaudeConfigDir);
      restoreEnv("HIVEWARD_CLAUDE_CODE_DEFAULT_MODEL", previousHivewardClaudeDefault);
      restoreEnv("CLAUDE_CODE_DEFAULT_MODEL", previousClaudeDefault);
      restoreEnv("HIVEWARD_CLAUDE_CODE_MODELS", previousHivewardClaudeModels);
      restoreEnv("CLAUDE_CODE_MODELS", previousClaudeModels);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("reports Google, Cursor, OpenCode, and Hermes CLI harness status and model defaults", async () => {
    const fixture = await createStoreFixture();
    const binDir = join(fixture.dir, "bin");
    const hermesHome = join(fixture.dir, "hermes-home");
    const previousPath = process.env.PATH;
    const previousGoogleDefault = process.env.HIVEWARD_GOOGLE_CLI_DEFAULT_MODEL;
    const previousGoogleModels = process.env.HIVEWARD_GOOGLE_CLI_MODELS;
    const previousCursorDefault = process.env.HIVEWARD_CURSOR_DEFAULT_MODEL;
    const previousCursorModels = process.env.HIVEWARD_CURSOR_MODELS;
    const previousOpenCodeDefault = process.env.HIVEWARD_OPENCODE_DEFAULT_MODEL;
    const previousOpenCodeModels = process.env.HIVEWARD_OPENCODE_MODELS;
    const previousHermesDefault = process.env.HIVEWARD_HERMES_DEFAULT_MODEL;
    const previousHermesModels = process.env.HIVEWARD_HERMES_MODELS;
    const previousHermesHome = process.env.HERMES_HOME;
    mkdirSync(binDir, { recursive: true });
    mkdirSync(hermesHome, { recursive: true });
    writeFakeExecutable(join(binDir, "gemini"), "gemini 0.38.1");
    writeFakeExecutable(join(binDir, "cursor-agent"), "cursor-agent 2026.1.0");
    writeFakeExecutable(join(binDir, "opencode"), "opencode 1.2.3");
    writeFakeExecutable(join(binDir, "hermes-architect"), "hermes profile architect wrapper");
    writeFakeHermesExecutable(join(binDir, "hermes"));
    process.env.PATH = `${binDir}${delimiter}${previousPath ?? ""}`;
    process.env.HIVEWARD_GOOGLE_CLI_DEFAULT_MODEL = "gemini-2.5-pro";
    process.env.HIVEWARD_GOOGLE_CLI_MODELS = "gemini-2.5-pro,gemini-2.5-flash";
    process.env.HIVEWARD_CURSOR_DEFAULT_MODEL = "gpt-5";
    process.env.HIVEWARD_CURSOR_MODELS = "gpt-5,claude-4-sonnet";
    process.env.HIVEWARD_OPENCODE_DEFAULT_MODEL = "anthropic/claude-sonnet-4";
    process.env.HIVEWARD_OPENCODE_MODELS = "anthropic/claude-sonnet-4,openai/gpt-5.4";
    process.env.HIVEWARD_HERMES_DEFAULT_MODEL = "hermes-env-default";
    process.env.HIVEWARD_HERMES_MODELS = "hermes-env-default,hermes-env-fallback";
    process.env.HERMES_HOME = hermesHome;

    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/harness-status`);
        const body = await readOkJson<{
          statuses: Array<{
            id: string;
            label?: string;
            summary?: string;
            installed?: boolean;
            connectionState?: string;
            defaultModelId?: string;
            models?: Array<{ id: string; isDefault?: boolean }>;
            profiles?: Array<{ id: string; label: string; alias?: string; isDefault?: boolean }>;
            checks?: Array<{ label: string }>;
          }>;
        }>(response);
        const googleStatus = body.statuses.find((status) => status.id === "google");
        const cursorStatus = body.statuses.find((status) => status.id === "cursor");
        const opencodeStatus = body.statuses.find((status) => status.id === "opencode");
        const hermesStatus = body.statuses.find((status) => status.id === "hermes");

        expect(googleStatus).toMatchObject({
          label: "Google CLI Beta",
          installed: true,
          connectionState: "available",
          defaultModelId: "gemini-2.5-pro"
        });
        expect(googleStatus?.summary).not.toContain("CLI CLI");
        expect(googleStatus?.checks?.[0]?.label).toBe("Gemini CLI");
        expect(googleStatus?.models?.map((model) => model.id)).toEqual([
          "gemini-2.5-pro",
          "gemini-2.5-flash"
        ]);
        expect(cursorStatus).toMatchObject({
          label: "Cursor CLI Beta",
          installed: true,
          connectionState: "available",
          defaultModelId: "gpt-5"
        });
        expect(cursorStatus?.summary).not.toContain("CLI CLI");
        expect(cursorStatus?.checks?.[0]?.label).toBe("Cursor CLI");
        expect(cursorStatus?.models?.map((model) => model.id)).toEqual([
          "gpt-5",
          "claude-4-sonnet"
        ]);
        expect(opencodeStatus).toMatchObject({
          label: "OpenCode Beta",
          installed: true,
          connectionState: "available",
          defaultModelId: "anthropic/claude-sonnet-4"
        });
        expect(opencodeStatus?.checks?.[0]?.label).toBe("OpenCode CLI");
        expect(opencodeStatus?.models?.map((model) => model.id)).toEqual([
          "anthropic/claude-sonnet-4",
          "openai/gpt-5.4"
        ]);
        expect(opencodeStatus?.models?.[0]?.isDefault).toBe(true);
        expect(hermesStatus).toMatchObject({
          label: "Hermes Beta",
          installed: true,
          connectionState: "available",
          defaultModelId: "hermes-env-default"
        });
        expect(hermesStatus?.checks?.[0]?.label).toBe("Hermes CLI");
        expect(hermesStatus?.models?.map((model) => model.id)).toEqual([
          "hermes-env-default",
          "hermes-env-fallback"
        ]);
        expect(hermesStatus?.profiles).toEqual([
          { id: "ceo", label: "ceo", alias: "hw-ceo", modelId: "hermes-primary-test", isDefault: true },
          { id: "architect", label: "architect", modelId: "hermes-profile-model-test" },
          { id: "researcher", label: "researcher", modelId: "hermes-research-model-test" }
        ]);
      });
    } finally {
      restoreEnv("PATH", previousPath);
      restoreEnv("HIVEWARD_GOOGLE_CLI_DEFAULT_MODEL", previousGoogleDefault);
      restoreEnv("HIVEWARD_GOOGLE_CLI_MODELS", previousGoogleModels);
      restoreEnv("HIVEWARD_CURSOR_DEFAULT_MODEL", previousCursorDefault);
      restoreEnv("HIVEWARD_CURSOR_MODELS", previousCursorModels);
      restoreEnv("HIVEWARD_OPENCODE_DEFAULT_MODEL", previousOpenCodeDefault);
      restoreEnv("HIVEWARD_OPENCODE_MODELS", previousOpenCodeModels);
      restoreEnv("HIVEWARD_HERMES_DEFAULT_MODEL", previousHermesDefault);
      restoreEnv("HIVEWARD_HERMES_MODELS", previousHermesModels);
      restoreEnv("HERMES_HOME", previousHermesHome);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("reads Hermes agents and channels, then creates local entries", async () => {
    const fixture = await createStoreFixture();
    const binDir = join(fixture.dir, "bin");
    const hermesHome = join(fixture.dir, "hermes-home");
    const previousPath = process.env.PATH;
    const previousHermesHome = process.env.HERMES_HOME;
    mkdirSync(binDir, { recursive: true });
    mkdirSync(hermesHome, { recursive: true });
    mkdirSync(join(hermesHome, "skills", "hiveward-leader"), { recursive: true });
    mkdirSync(join(hermesHome, "profiles", "ceo", "skills", "hiveward-ceo"), { recursive: true });
    mkdirSync(join(hermesHome, "profiles", "ceo"), { recursive: true });
    writeFileSync(join(hermesHome, "config.yaml"), [
      "model:",
      "  default: hermes-primary-test",
      "  provider: custom:test-primary",
      "fallback_providers:",
      "  - provider: custom:test-fallback",
      "    model: hermes-fallback-test",
      "terminal:",
      "  cwd: ."
    ].join("\n"));
    writeFileSync(join(hermesHome, "profiles", "ceo", "config.yaml"), [
      "model:",
      "  default: claude-sonnet-4",
      "  provider: anthropic",
      "terminal:",
      `  cwd: ${join(fixture.dir, "ceo-workspace")}`
    ].join("\n"));
    writeFileSync(join(hermesHome, "skills", "hiveward-leader", "SKILL.md"), "# Leader\n");
    writeFileSync(join(hermesHome, "profiles", "ceo", "skills", "hiveward-ceo", "SKILL.md"), "# CEO\n");
    writeFileSync(join(hermesHome, "channel_directory.json"), JSON.stringify({
      updated_at: "2026-05-01T00:00:00.000Z",
      platforms: {
        feishu: [
          { id: "channel_demo", name: "Demo Group", type: "group", thread_id: null }
        ]
      }
    }));
    writeFileSync(join(hermesHome, "profiles", "ceo", "channel_directory.json"), JSON.stringify({
      updated_at: "2026-05-01T00:00:00.000Z",
      platforms: {
        feishu: [
          { id: "profile_room", name: "CEO Room", type: "group", thread_id: "thread-1" }
        ]
      }
    }));
    writeFakeHermesExecutable(join(binDir, "hermes"), {
      allowProfileWrites: true,
      profileRows: [
        " Profile          Model                        Gateway      Alias        Distribution",
        "\u25c6ceo             hermes-primary-test            stopped      hermes-ceo   \u2014"
      ]
    });
    process.env.PATH = `${binDir}${delimiter}${previousPath ?? ""}`;
    process.env.HERMES_HOME = hermesHome;

    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const initialResponse = await fetch(`${baseUrl}/api/hermes-config`);
        const initial = await readOkJson<{
          profiles: Array<{ id: string; alias?: string; provider?: string; path?: string; workspace?: string; modelId?: string }>;
          channels: Array<{ profileId?: string; platform: string; id: string; name: string; type?: string }>;
          skills: Array<{ id: string; profileId?: string; path: string }>;
          channelDirectoryPath: string;
        }>(initialResponse);

        expect(initial.profiles).toEqual([
          expect.objectContaining({
            id: "ceo",
            alias: "hermes-ceo",
            modelId: "hermes-primary-test",
            provider: "anthropic",
            path: join(hermesHome, "profiles", "ceo"),
            workspace: join(fixture.dir, "ceo-workspace")
          })
        ]);
        expect(initial.channels).toEqual(expect.arrayContaining([
          expect.objectContaining({ profileId: "default", platform: "feishu", id: "channel_demo", name: "Demo Group", type: "group" }),
          expect.objectContaining({ profileId: "ceo", platform: "feishu", id: "profile_room", name: "CEO Room", type: "group" })
        ]));
        expect(initial.skills).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: "hiveward-leader", path: join(hermesHome, "skills", "hiveward-leader", "SKILL.md") }),
          expect.objectContaining({ id: "hiveward-ceo", profileId: "ceo", path: join(hermesHome, "profiles", "ceo", "skills", "hiveward-ceo", "SKILL.md") })
        ]));
        expect(initial.channelDirectoryPath).toBe(join(hermesHome, "channel_directory.json"));

        const profileResponse = await fetch(`${baseUrl}/api/hermes-config/profiles`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "researcher", description: "Research tasks", cloneFrom: "ceo" })
        });
        expect(profileResponse.status).toBe(201);

        const channelResponse = await fetch(`${baseUrl}/api/hermes-config/channels`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ platform: "slack", id: "C123", name: "ops", type: "group" })
        });
        const channelBody = await readOkJson<{ channels: Array<{ platform: string; id: string; name: string }> }>(channelResponse);
        expect(channelResponse.status).toBe(201);
        expect(channelBody.channels).toEqual(expect.arrayContaining([expect.objectContaining({ platform: "slack", id: "C123", name: "ops" })]));
      });
    } finally {
      restoreEnv("PATH", previousPath);
      restoreEnv("HERMES_HOME", previousHermesHome);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("reads Hermes configured models from local config files", async () => {
    const fixture = await createStoreFixture();
    const hermesHome = join(fixture.dir, "hermes-home");
    const previousHermesHome = process.env.HERMES_HOME;
    const previousHermesDefault = process.env.HIVEWARD_HERMES_DEFAULT_MODEL;
    const previousHermesModels = process.env.HIVEWARD_HERMES_MODELS;
    mkdirSync(join(hermesHome, "profiles", "writer"), { recursive: true });
    writeFileSync(join(hermesHome, "config.yaml"), [
      "model:",
      "  default: hermes-primary-test",
      "  provider: custom:test-primary",
      "fallback_providers:",
      "  - provider: custom:test-fallback",
      "    model: hermes-fallback-test"
    ].join("\n"));
    writeFileSync(join(hermesHome, "profiles", "writer", "config.yaml"), [
      "model:",
      "  default: hermes-profile-test",
      "  provider: custom:test-profile"
    ].join("\n"));
    process.env.HERMES_HOME = hermesHome;
    delete process.env.HIVEWARD_HERMES_DEFAULT_MODEL;
    delete process.env.HIVEWARD_HERMES_MODELS;

    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/harness-status`);
        const body = await readOkJson<{
          statuses: Array<{ id: string; defaultModelId?: string; models?: Array<{ id: string; provider?: string; isDefault?: boolean }> }>;
        }>(response);
        const hermesStatus = body.statuses.find((status) => status.id === "hermes");

        expect(hermesStatus?.defaultModelId).toBe("hermes-primary-test");
        expect(hermesStatus?.models).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: "hermes-primary-test", provider: "custom:test-primary", isDefault: true }),
          expect.objectContaining({ id: "hermes-fallback-test", provider: "custom:test-fallback" }),
          expect.objectContaining({ id: "hermes-profile-test", provider: "custom:test-profile" })
        ]));
      });
    } finally {
      restoreEnv("HERMES_HOME", previousHermesHome);
      restoreEnv("HIVEWARD_HERMES_DEFAULT_MODEL", previousHermesDefault);
      restoreEnv("HIVEWARD_HERMES_MODELS", previousHermesModels);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("accepts Claude Code auth from local settings env when reporting harness status", async () => {
    const fixture = await createStoreFixture();
    const claudeHome = join(fixture.dir, "claude-home");
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const previousHivewardClaudeDefault = process.env.HIVEWARD_CLAUDE_CODE_DEFAULT_MODEL;
    const previousClaudeDefault = process.env.CLAUDE_CODE_DEFAULT_MODEL;
    const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    const previousAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    const previousClaudeOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    delete process.env.HIVEWARD_CLAUDE_CODE_DEFAULT_MODEL;
    delete process.env.CLAUDE_CODE_DEFAULT_MODEL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: "sk-minimax",
        ANTHROPIC_MODEL: "MiniMax-M2.7"
      }
    }));

    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/harness-status`);
        const body = await readOkJson<{
          statuses: Array<{
            id: string;
            environmentOk?: boolean;
            connectionState?: string;
            models?: Array<{ id: string }>;
            checks?: Array<{ id: string; status: string; detail: string }>;
          }>;
        }>(response);
        const claudeStatus = body.statuses.find((status) => status.id === "claudeCode");
        const authCheck = claudeStatus?.checks?.find((check) => check.id === "claude-auth");

        expect(claudeStatus?.environmentOk).toBe(true);
        expect(claudeStatus?.connectionState).toBe("available");
        expect(claudeStatus?.models?.map((model) => model.id)).toContain("MiniMax-M2.7");
        expect(authCheck).toMatchObject({ status: "pass" });
        expect(authCheck?.detail).toContain("settings.json");
        expect(authCheck?.detail).toContain("ANTHROPIC_AUTH_TOKEN");
      });
    } finally {
      restoreEnv("CLAUDE_CONFIG_DIR", previousClaudeConfigDir);
      restoreEnv("HIVEWARD_CLAUDE_CODE_DEFAULT_MODEL", previousHivewardClaudeDefault);
      restoreEnv("CLAUDE_CODE_DEFAULT_MODEL", previousClaudeDefault);
      restoreEnv("ANTHROPIC_API_KEY", previousAnthropicApiKey);
      restoreEnv("ANTHROPIC_AUTH_TOKEN", previousAnthropicAuthToken);
      restoreEnv("CLAUDE_CODE_OAUTH_TOKEN", previousClaudeOauthToken);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("does not treat a Claude Code model preset as configured auth", async () => {
    const fixture = await createStoreFixture();
    const claudeHome = join(fixture.dir, "claude-home");
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const previousHivewardClaudeDefault = process.env.HIVEWARD_CLAUDE_CODE_DEFAULT_MODEL;
    const previousClaudeDefault = process.env.CLAUDE_CODE_DEFAULT_MODEL;
    const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    const previousAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    const previousClaudeOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    delete process.env.HIVEWARD_CLAUDE_CODE_DEFAULT_MODEL;
    delete process.env.CLAUDE_CODE_DEFAULT_MODEL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
        ANTHROPIC_MODEL: "deepseek-v4-pro",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro"
      }
    }));

    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/harness-status`);
        const body = await readOkJson<{
          statuses: Array<{
            id: string;
            environmentOk?: boolean;
            connectionState?: string;
            checks?: Array<{ id: string; status: string; detail: string }>;
          }>;
        }>(response);
        const claudeStatus = body.statuses.find((status) => status.id === "claudeCode");
        const authCheck = claudeStatus?.checks?.find((check) => check.id === "claude-auth");

        expect(claudeStatus?.environmentOk).toBe(false);
        expect(claudeStatus?.connectionState).toBe("needs_config");
        expect(authCheck).toMatchObject({ status: "fail" });
        expect(authCheck?.detail).not.toContain("settings.json");
        expect(authCheck?.detail).not.toContain("Detected:");
      });
    } finally {
      restoreEnv("CLAUDE_CONFIG_DIR", previousClaudeConfigDir);
      restoreEnv("HIVEWARD_CLAUDE_CODE_DEFAULT_MODEL", previousHivewardClaudeDefault);
      restoreEnv("CLAUDE_CODE_DEFAULT_MODEL", previousClaudeDefault);
      restoreEnv("ANTHROPIC_API_KEY", previousAnthropicApiKey);
      restoreEnv("ANTHROPIC_AUTH_TOKEN", previousAnthropicAuthToken);
      restoreEnv("CLAUDE_CODE_OAUTH_TOKEN", previousClaudeOauthToken);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("reads Claude Code model config from local settings", async () => {
    const fixture = await createStoreFixture();
    const claudeHome = join(fixture.dir, "claude-home");
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;

    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({
      env: {
        ANTHROPIC_MODEL: "fallback-model",
        ANTHROPIC_SMALL_FAST_MODEL: "legacy-small",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet-model",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "opus-model",
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "Opus Model"
      },
      permissions: { allow: ["Bash(ls)"] }
    }));

    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/claude-code-config/models`);
        const body = await readOkJson<{
          config: {
            configPath: string;
            fallbackModelId?: string;
            haikuModelId?: string;
            sonnetModelId?: string;
            opusModelId?: string;
            opusModelName?: string;
          };
        }>(response);

        expect(body.config.configPath).toBe(join(claudeHome, "settings.json"));
        expect(body.config.fallbackModelId).toBe("fallback-model");
        expect(body.config.haikuModelId).toBe("legacy-small");
        expect(body.config.sonnetModelId).toBe("sonnet-model");
        expect(body.config.opusModelId).toBe("opus-model");
        expect(body.config.opusModelName).toBe("Opus Model");
      });
    } finally {
      restoreEnv("CLAUDE_CONFIG_DIR", previousClaudeConfigDir);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("reports Claude Code model presets from the CCSwitch-style catalog", async () => {
    const fixture = await createStoreFixture();
    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/claude-code-config/models`);
        const body = await readOkJson<{
          presets?: Array<{
            id: string;
            name: string;
            category: string;
            baseUrl?: string;
            sonnetModelId?: string;
          }>;
        }>(response);

        expect(body.presets?.length).toBeGreaterThanOrEqual(12);
        expect(body.presets).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "deepseek",
              name: "DeepSeek",
              category: "cn_official",
              baseUrl: "https://api.deepseek.com/anthropic",
              sonnetModelId: "deepseek-v4-pro"
            }),
            expect.objectContaining({
              id: "kimi",
              name: "Kimi",
              category: "cn_official",
              baseUrl: "https://api.moonshot.cn/anthropic",
              sonnetModelId: "kimi-k2.6"
            }),
            expect.objectContaining({
              id: "minimax-cn",
              name: "MiniMax",
              category: "cn_official",
              baseUrl: "https://api.minimaxi.com/anthropic",
              sonnetModelId: "MiniMax-M2.7"
            })
          ])
        );
      });
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("writes Claude Code model config while preserving unrelated settings", async () => {
    const fixture = await createStoreFixture();
    const claudeHome = join(fixture.dir, "claude-home");
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;

    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({
      env: {
        ANTHROPIC_MODEL: "old-fallback",
        ANTHROPIC_SMALL_FAST_MODEL: "old-small",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "old-sonnet",
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "Old Sonnet",
        ANTHROPIC_API_KEY: "sk-preserved"
      },
      permissions: { allow: ["Bash(ls)"] }
    }));

    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/claude-code-config/models`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            fallbackModelId: "next-fallback",
            haikuModelId: "next-haiku",
            sonnetModelId: "next-sonnet",
            sonnetModelName: "Next Sonnet",
            opusModelId: "next-opus"
          })
        });
        const body = await readOkJson<{
          config: {
            fallbackModelId?: string;
            haikuModelId?: string;
            sonnetModelId?: string;
            sonnetModelName?: string;
            opusModelId?: string;
          };
        }>(response);

        expect(body.config).toMatchObject({
          fallbackModelId: "next-fallback",
          haikuModelId: "next-haiku",
          sonnetModelId: "next-sonnet",
          sonnetModelName: "Next Sonnet",
          opusModelId: "next-opus"
        });

        const settings = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
        expect(settings.env).toMatchObject({
          ANTHROPIC_MODEL: "next-fallback",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "next-haiku",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "next-sonnet",
          ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "Next Sonnet",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "next-opus",
          ANTHROPIC_API_KEY: "sk-preserved"
        });
        expect(settings.env).not.toHaveProperty("ANTHROPIC_SMALL_FAST_MODEL");
        expect(settings.permissions).toEqual({ allow: ["Bash(ls)"] });
      });
    } finally {
      restoreEnv("CLAUDE_CONFIG_DIR", previousClaudeConfigDir);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("applies a Claude Code model preset without creating a token", async () => {
    const fixture = await createStoreFixture();
    const claudeHome = join(fixture.dir, "claude-home");
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;

    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: "sk-preserved",
        ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
        ANTHROPIC_MODEL: "deepseek-v4-pro",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro"
      },
      permissions: { allow: ["Bash(ls)"] }
    }));

    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/claude-code-config/models`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ presetId: "deepseek" })
        });
        const body = await readOkJson<{
          config: {
            providerPresetId?: string;
            baseUrl?: string;
            fallbackModelId?: string;
            haikuModelId?: string;
            sonnetModelId?: string;
            opusModelId?: string;
          };
        }>(response);

        expect(body.config).toMatchObject({
          providerPresetId: "deepseek",
          baseUrl: "https://api.deepseek.com/anthropic",
          fallbackModelId: "deepseek-v4-pro",
          haikuModelId: "deepseek-v4-flash",
          sonnetModelId: "deepseek-v4-pro",
          opusModelId: "deepseek-v4-pro"
        });

        const settings = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
        expect(settings.env).toMatchObject({
          ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
          ANTHROPIC_AUTH_TOKEN: "sk-preserved",
          ANTHROPIC_MODEL: "deepseek-v4-pro",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro"
        });
        expect(settings.env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(settings.permissions).toEqual({ allow: ["Bash(ls)"] });
      });
    } finally {
      restoreEnv("CLAUDE_CONFIG_DIR", previousClaudeConfigDir);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("rejects switching Claude Code presets without the new provider token", async () => {
    const fixture = await createStoreFixture();
    const claudeHome = join(fixture.dir, "claude-home");
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;

    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: "sk-kimi",
        ANTHROPIC_BASE_URL: "https://api.moonshot.cn/anthropic",
        ANTHROPIC_MODEL: "kimi-k2.6",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "kimi-k2.6",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-k2.6",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "kimi-k2.6"
      },
      permissions: { allow: ["Bash(ls)"] }
    }));

    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/claude-code-config/models`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ presetId: "minimax-global" })
        });
        const body = await response.json() as { error?: { code?: string; message?: string } };

        expect(response.status).toBe(400);
        expect(body.error).toMatchObject({
          code: "claude_code_auth_required"
        });

        const settings = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
        expect(settings.env).toMatchObject({
          ANTHROPIC_AUTH_TOKEN: "sk-kimi",
          ANTHROPIC_BASE_URL: "https://api.moonshot.cn/anthropic",
          ANTHROPIC_MODEL: "kimi-k2.6"
        });
      });
    } finally {
      restoreEnv("CLAUDE_CONFIG_DIR", previousClaudeConfigDir);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("rejects applying a Claude Code model preset without an auth token", async () => {
    const fixture = await createStoreFixture();
    const claudeHome = join(fixture.dir, "claude-home");
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;

    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({
      env: {},
      permissions: { allow: ["Bash(ls)"] }
    }));

    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/claude-code-config/models`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ presetId: "deepseek" })
        });
        const body = await response.json() as { error?: { code?: string; message?: string } };

        expect(response.status).toBe(400);
        expect(body.error).toMatchObject({
          code: "claude_code_auth_required"
        });
        expect(body.error?.message).toContain("API key");

        const settings = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
        expect(settings.env).toEqual({});
        expect(settings.permissions).toEqual({ allow: ["Bash(ls)"] });
      });
    } finally {
      restoreEnv("CLAUDE_CONFIG_DIR", previousClaudeConfigDir);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("applies a Claude Code model preset with a provided auth token", async () => {
    const fixture = await createStoreFixture();
    const claudeHome = join(fixture.dir, "claude-home");
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;

    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({
      env: {},
      permissions: { allow: ["Bash(ls)"] }
    }));

    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/claude-code-config/models`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            presetId: "deepseek",
            authEnvKey: "ANTHROPIC_AUTH_TOKEN",
            authValue: "sk-deepseek"
          })
        });
        const body = await readOkJson<{
          config: {
            authConfigured?: boolean;
            authEnvKey?: string;
            providerPresetId?: string;
          };
        }>(response);

        expect(body.config).toMatchObject({
          authConfigured: true,
          authEnvKey: "ANTHROPIC_AUTH_TOKEN",
          providerPresetId: "deepseek"
        });

        const settings = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
        expect(settings.env).toMatchObject({
          ANTHROPIC_AUTH_TOKEN: "sk-deepseek",
          ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
          ANTHROPIC_MODEL: "deepseek-v4-pro"
        });
      });
    } finally {
      restoreEnv("CLAUDE_CONFIG_DIR", previousClaudeConfigDir);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("uses CC Switch preset auth fields and plan metadata when writing Claude Code settings", async () => {
    const fixture = await createStoreFixture();
    const claudeHome = join(fixture.dir, "claude-home");
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;

    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: "stale-bearer-token",
        ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic"
      }
    }));

    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const listResponse = await fetch(`${baseUrl}/api/claude-code-config/models`);
        const listBody = await readOkJson<{
          presets: Array<{
            id: string;
            authEnvKey?: string;
            baseUrl?: string;
            planType?: string;
            planProvider?: string;
          }>;
        }>(listResponse);

        expect(listBody.presets.find((preset) => preset.id === "pateway-ai")).toMatchObject({
          authEnvKey: "ANTHROPIC_API_KEY",
          baseUrl: "https://api.pateway.ai"
        });
        expect(listBody.presets.find((preset) => preset.id === "aihubmix")).toMatchObject({
          authEnvKey: "ANTHROPIC_API_KEY",
          baseUrl: "https://aihubmix.com"
        });
        expect(listBody.presets.find((preset) => preset.id === "minimax-cn")).toMatchObject({
          planType: "coding_plan",
          planProvider: "minimax"
        });
        expect(listBody.presets.find((preset) => preset.id === "xiaomi-mimo-token-plan-cn")).toMatchObject({
          planType: "token_plan",
          planProvider: "xiaomi_mimo"
        });

        const response = await fetch(`${baseUrl}/api/claude-code-config/models`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            presetId: "pateway-ai",
            authEnvKey: "ANTHROPIC_AUTH_TOKEN",
            authValue: "sk-pateway"
          })
        });
        const body = await readOkJson<{
          config: {
            authConfigured?: boolean;
            authEnvKey?: string;
            providerPresetId?: string;
          };
        }>(response);

        expect(body.config).toMatchObject({
          authConfigured: true,
          authEnvKey: "ANTHROPIC_API_KEY",
          providerPresetId: "pateway-ai"
        });

        const settings = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
        expect(settings.env).toMatchObject({
          ANTHROPIC_API_KEY: "sk-pateway",
          ANTHROPIC_BASE_URL: "https://api.pateway.ai"
        });
        expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      });
    } finally {
      restoreEnv("CLAUDE_CONFIG_DIR", previousClaudeConfigDir);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("applies Claude Code preset defaults while allowing selected model overrides", async () => {
    const fixture = await createStoreFixture();
    const claudeHome = join(fixture.dir, "claude-home");
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;

    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({
      env: {},
      permissions: { allow: ["Bash(ls)"] }
    }));

    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/claude-code-config/models`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            presetId: "minimax-global",
            authEnvKey: "ANTHROPIC_AUTH_TOKEN",
            authValue: "sk-minimax",
            fallbackModelId: "MiniMax-M2.7",
            haikuModelId: "",
            sonnetModelId: "",
            opusModelId: ""
          })
        });
        const body = await readOkJson<{
          config: {
            providerPresetId?: string;
            baseUrl?: string;
            fallbackModelId?: string;
            haikuModelId?: string;
            sonnetModelId?: string;
            opusModelId?: string;
          };
        }>(response);

        expect(body.config).toMatchObject({
          providerPresetId: "minimax-global",
          baseUrl: "https://api.minimax.io/anthropic",
          fallbackModelId: "MiniMax-M2.7",
          haikuModelId: "MiniMax-M2.7",
          sonnetModelId: "MiniMax-M2.7",
          opusModelId: "MiniMax-M2.7"
        });

        const settings = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
        expect(settings.env).toMatchObject({
          ANTHROPIC_AUTH_TOKEN: "sk-minimax",
          ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic",
          ANTHROPIC_MODEL: "MiniMax-M2.7",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "MiniMax-M2.7",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "MiniMax-M2.7",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "MiniMax-M2.7"
        });
      });
    } finally {
      restoreEnv("CLAUDE_CONFIG_DIR", previousClaudeConfigDir);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("forces preset auth env and clears stale alternate Claude Code auth when switching providers", async () => {
    const fixture = await createStoreFixture();
    const claudeHome = join(fixture.dir, "claude-home");
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;

    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: "sk-minimax-old",
        ANTHROPIC_API_KEY: "sk-api-old",
        ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic",
        ANTHROPIC_MODEL: "MiniMax-M2.7"
      },
      permissions: { allow: ["Bash(ls)"] }
    }));

    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/claude-code-config/models`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            presetId: "deepseek",
            authEnvKey: "ANTHROPIC_API_KEY",
            authValue: "sk-deepseek"
          })
        });
        const body = await readOkJson<{
          config: {
            authConfigured?: boolean;
            authEnvKey?: string;
            providerPresetId?: string;
          };
        }>(response);

        expect(body.config).toMatchObject({
          authConfigured: true,
          authEnvKey: "ANTHROPIC_AUTH_TOKEN",
          providerPresetId: "deepseek"
        });

        const settings = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
        expect(settings.env).toMatchObject({
          ANTHROPIC_AUTH_TOKEN: "sk-deepseek",
          ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
          ANTHROPIC_MODEL: "deepseek-v4-pro",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro"
        });
        expect(settings.env.ANTHROPIC_API_KEY).toBeUndefined();
      });
    } finally {
      restoreEnv("CLAUDE_CONFIG_DIR", previousClaudeConfigDir);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("does not treat conflicting Claude Code auth envs as reusable preset auth", async () => {
    const fixture = await createStoreFixture();
    const claudeHome = join(fixture.dir, "claude-home");
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;

    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: "sk-minimax-old",
        ANTHROPIC_API_KEY: "sk-deepseek-new",
        ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
        ANTHROPIC_MODEL: "deepseek-v4-pro",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro"
      }
    }));

    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const readResponse = await fetch(`${baseUrl}/api/claude-code-config/models`);
        const readBody = await readOkJson<{
          config: {
            authConfigured?: boolean;
            authEnvKey?: string;
            providerPresetId?: string;
          };
        }>(readResponse);

        expect(readBody.config).toMatchObject({
          authConfigured: false,
          authEnvKey: "ANTHROPIC_AUTH_TOKEN",
          providerPresetId: "deepseek"
        });

        const updateResponse = await fetch(`${baseUrl}/api/claude-code-config/models`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ presetId: "deepseek" })
        });
        const updateBody = await updateResponse.json() as { error?: { code?: string } };

        expect(updateResponse.status).toBe(400);
        expect(updateBody.error?.code).toBe("claude_code_auth_required");
      });
    } finally {
      restoreEnv("CLAUDE_CONFIG_DIR", previousClaudeConfigDir);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("keeps preset model defaults when the Claude Code form submits empty model overrides", async () => {
    const fixture = await createStoreFixture();
    const claudeHome = join(fixture.dir, "claude-home");
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;

    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({
      env: {},
      permissions: { allow: ["Bash(ls)"] }
    }));

    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/claude-code-config/models`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            presetId: "deepseek",
            authEnvKey: "ANTHROPIC_AUTH_TOKEN",
            authValue: "sk-deepseek",
            fallbackModelId: "",
            haikuModelId: "",
            sonnetModelId: "",
            opusModelId: ""
          })
        });
        const body = await readOkJson<{
          config: {
            fallbackModelId?: string;
            haikuModelId?: string;
            sonnetModelId?: string;
            opusModelId?: string;
          };
        }>(response);

        expect(body.config).toMatchObject({
          fallbackModelId: "deepseek-v4-pro",
          haikuModelId: "deepseek-v4-flash",
          sonnetModelId: "deepseek-v4-pro",
          opusModelId: "deepseek-v4-pro"
        });

        const settings = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
        expect(settings.env).toMatchObject({
          ANTHROPIC_MODEL: "deepseek-v4-pro",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro"
        });
      });
    } finally {
      restoreEnv("CLAUDE_CONFIG_DIR", previousClaudeConfigDir);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("saves the current Claude Code model profile without exposing the API key", async () => {
    const fixture = await createStoreFixture();
    const claudeHome = join(fixture.dir, "claude-home");
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;

    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: "sk-deepseek",
        ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
        ANTHROPIC_MODEL: "deepseek-v4-pro",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro"
      }
    }));

    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/claude-code-config/model-profiles`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "DeepSeek saved" })
        });
        const body = await readOkJson<{
          savedProfiles: Array<{
            id: string;
            name: string;
            authConfigured?: boolean;
            providerPresetId?: string;
            authValue?: string;
          }>;
        }>(response);

        expect(body.savedProfiles).toHaveLength(1);
        expect(body.savedProfiles[0]).toMatchObject({
          name: "DeepSeek saved",
          authConfigured: true,
          providerPresetId: "deepseek"
        });
        expect(body.savedProfiles[0]).not.toHaveProperty("authValue");

        const profileStore = JSON.parse(readFileSync(join(claudeHome, "hiveward-model-profiles.json"), "utf8")) as {
          profiles: Array<{ authValue?: string }>;
        };
        expect(profileStore.profiles[0]?.authValue).toBe("sk-deepseek");
      });
    } finally {
      restoreEnv("CLAUDE_CONFIG_DIR", previousClaudeConfigDir);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("applies a saved Claude Code model profile for quick switching", async () => {
    const fixture = await createStoreFixture();
    const claudeHome = join(fixture.dir, "claude-home");
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;

    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: "sk-deepseek",
        ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
        ANTHROPIC_MODEL: "deepseek-v4-pro",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro"
      }
    }));

    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const saveResponse = await fetch(`${baseUrl}/api/claude-code-config/model-profiles`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "DeepSeek saved" })
        });
        const saved = await readOkJson<{ savedProfiles: Array<{ id: string; providerPresetId?: string }> }>(saveResponse);
        const deepseekProfileId = saved.savedProfiles.find((profile) => profile.providerPresetId === "deepseek")?.id;
        expect(deepseekProfileId).toBeTruthy();

        await readOkJson(await fetch(`${baseUrl}/api/claude-code-config/models`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            presetId: "minimax-global",
            authEnvKey: "ANTHROPIC_AUTH_TOKEN",
            authValue: "sk-minimax"
          })
        }));

        const applyResponse = await fetch(`${baseUrl}/api/claude-code-config/model-profiles/${deepseekProfileId}/apply`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({})
        });
        const applied = await readOkJson<{
          config: { providerPresetId?: string; authConfigured?: boolean; fallbackModelId?: string };
          savedProfiles: Array<{ providerPresetId?: string }>;
        }>(applyResponse);

        expect(applied.config).toMatchObject({
          providerPresetId: "deepseek",
          authConfigured: true,
          fallbackModelId: "deepseek-v4-pro"
        });
        expect(applied.savedProfiles).toEqual(expect.arrayContaining([
          expect.objectContaining({ providerPresetId: "minimax-global" })
        ]));

        const settings = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
        expect(settings.env).toMatchObject({
          ANTHROPIC_AUTH_TOKEN: "sk-deepseek",
          ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
          ANTHROPIC_MODEL: "deepseek-v4-pro"
        });
        expect(settings.env.ANTHROPIC_API_KEY).toBeUndefined();
      });
    } finally {
      restoreEnv("CLAUDE_CONFIG_DIR", previousClaudeConfigDir);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("reports and installs HiveWard skills into the OpenClaw home skill root", async () => {
    const fixture = await createStoreFixture();
    const openClawWorkspace = join(fixture.dir, "openclaw-workspace");
    const openClawHome = join(fixture.dir, "openclaw-home");
    const openClawConfigStore = createConfigStoreFixture(openClawWorkspace);
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    const previousOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_HOME = openClawHome;
    delete process.env.OPENCLAW_STATE_DIR;
    try {
      await withApiServer(
        fixture.store,
        async (baseUrl) => {
          const initialResponse = await fetch(`${baseUrl}/api/harness-skills/openclaw`);
          const initialBody = await readOkJson<{
            supported: boolean;
            installRoot?: string;
            installCandidates?: Array<{ root: string; source: string; selected: boolean; hasHiveWardSkills: boolean }>;
            skills: Array<{ id: string; status: string; installed: boolean; targetPath?: string }>;
          }>(initialResponse);

          expect(initialBody.supported).toBe(true);
          expect(initialBody.installRoot).toBe(join(openClawHome, "skills"));
          expect(initialBody.installCandidates?.find((candidate) => candidate.selected)).toMatchObject({
            root: join(openClawHome, "skills"),
            source: "environment",
            hasHiveWardSkills: false
          });
          expect(initialBody.skills.map((skill) => skill.status)).toEqual(["missing", "missing", "missing"]);

          const installResponse = await fetch(`${baseUrl}/api/harness-skills/openclaw/install`, {
            method: "POST"
          });
          const installBody = await readOkJson<{
            installedCount: number;
            installCandidates?: Array<{ root: string; source: string; selected: boolean; hasHiveWardSkills: boolean }>;
            skills: Array<{ id: string; status: string; installed: boolean }>;
          }>(installResponse);

          expect(installBody.installedCount).toBe(3);
          expect(installBody.skills.map((skill) => [skill.id, skill.status, skill.installed])).toEqual([
            ["hiveward-ceo", "installed", true],
            ["hiveward-leader", "installed", true],
            ["hiveward-skill-decomposer", "installed", true]
          ]);
          expect(installBody.installCandidates?.find((candidate) => candidate.selected)).toMatchObject({
            root: join(openClawHome, "skills"),
            source: "environment",
            hasHiveWardSkills: true
          });
          expect(existsSync(join(openClawHome, "skills", "hiveward-ceo", "SKILL.md"))).toBe(true);
          expect(existsSync(join(openClawHome, "skills", "hiveward-leader", "SKILL.md"))).toBe(true);
          expect(existsSync(join(openClawHome, "skills", "hiveward-skill-decomposer", "SKILL.md"))).toBe(true);
        },
        new TrackingAdapter(),
        openClawConfigStore
      );
    } finally {
      restoreEnv("OPENCLAW_HOME", previousOpenClawHome);
      restoreEnv("OPENCLAW_STATE_DIR", previousOpenClawStateDir);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("reports and installs HiveWard skills into Codex and Claude Code skill roots", async () => {
    const fixture = await createStoreFixture();
    const codexHome = join(fixture.dir, "codex-home");
    const claudeHome = join(fixture.dir, "claude-home");
    const previousCodexHome = process.env.CODEX_HOME;
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CODEX_HOME = codexHome;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        for (const [harnessId, root] of [
          ["codex", codexHome],
          ["claudeCode", claudeHome]
        ] as const) {
          const initialResponse = await fetch(`${baseUrl}/api/harness-skills/${harnessId}`);
          const initialBody = await readOkJson<{
            supported: boolean;
            installRoot?: string;
            installCandidates?: Array<{ root: string; source: string; selected: boolean; hasHiveWardSkills: boolean }>;
            skills: Array<{ status: string; installed: boolean }>;
          }>(initialResponse);

          expect(initialBody.supported).toBe(true);
          expect(initialBody.installRoot).toBe(join(root, "skills"));
          expect(initialBody.installCandidates?.find((candidate) => candidate.selected)).toMatchObject({
            root: join(root, "skills"),
            source: "environment",
            hasHiveWardSkills: false
          });
          expect(initialBody.installCandidates?.some((candidate) => candidate.source === "project")).toBe(true);
          expect(initialBody.skills.map((skill) => [skill.status, skill.installed])).toEqual([
            ["missing", false],
            ["missing", false],
            ["missing", false]
          ]);

          const installResponse = await fetch(`${baseUrl}/api/harness-skills/${harnessId}/install`, {
            method: "POST"
          });
          const installBody = await readOkJson<{
            installedCount: number;
            installCandidates?: Array<{ root: string; source: string; selected: boolean; hasHiveWardSkills: boolean }>;
            skills: Array<{ id: string; status: string; installed: boolean }>;
          }>(installResponse);

          expect(installBody.installedCount).toBe(3);
          expect(installBody.skills.map((skill) => [skill.id, skill.status, skill.installed])).toEqual([
            ["hiveward-ceo", "installed", true],
            ["hiveward-leader", "installed", true],
            ["hiveward-skill-decomposer", "installed", true]
          ]);
          expect(installBody.installCandidates?.find((candidate) => candidate.selected)).toMatchObject({
            root: join(root, "skills"),
            source: "environment",
            hasHiveWardSkills: true
          });
          expect(existsSync(join(root, "skills", "hiveward-ceo", "SKILL.md"))).toBe(true);
          expect(existsSync(join(root, "skills", "hiveward-leader", "SKILL.md"))).toBe(true);
          expect(existsSync(join(root, "skills", "hiveward-skill-decomposer", "SKILL.md"))).toBe(true);
        }
      });
    } finally {
      restoreEnv("CODEX_HOME", previousCodexHome);
      restoreEnv("CLAUDE_CONFIG_DIR", previousClaudeConfigDir);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("streams native chat responses through the runtime adapter", async () => {
    const fixture = await createStoreFixture();
    const adapter = new TrackingAdapter();
    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await streamSessionChat(baseUrl, {
          harnessId: "openclaw",
          nativeSessionId: "main",
          message: "Say hello from chat.",
          attachments: [],
          modelId: "openclaw/default",
          agentId: "main",
          thinkingEffort: "medium",
          includePlatformContext: true,
          roleScope: {
            role: "ceo"
          }
        });
        const text = await response.text();

        expect(response.status, text).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        expect(text).toContain("event: started");
        expect(text).toContain("event: delta");
        expect(text).toContain("event: done");
        expect(text).toContain("main completed through runtime adapter");
        expect(adapter.lastStartInput).toBeUndefined();
        expect(adapter.lastChatStreamInput?.sessionKey).toBe("main");
        expect(adapter.lastChatStreamInput?.message).toContain("System context:");
        expect(adapter.lastChatStreamInput?.message).toContain("HiveWard is a local company operations console");
        expect(adapter.lastChatStreamInput?.message).toContain("selected harness owns runtime execution");
        expect(adapter.lastChatStreamInput?.message).not.toContain("OpenClaw owns runtime execution");
        expect(adapter.lastChatStreamInput?.message).not.toContain("OpenClaw-native tools");
        expect(adapter.lastChatStreamInput?.message).toContain("HiveWard appointment:");
        expect(adapter.lastChatStreamInput?.message).toContain("Installed external skill:");
        expect(adapter.lastChatStreamInput?.message).toContain("hiveward-ceo");
        expect(adapter.lastChatStreamInput?.message).not.toContain("SKILL.md");
        expect(adapter.lastChatStreamInput?.message).toContain("answer directly without reading files");
        expect(adapter.lastChatStreamInput?.message).toContain("User message:\nSay hello from chat.");
        expect(adapter.lastChatStreamInput?.message).not.toContain("Project context: HiveWard");
        expect(adapter.lastChatStreamInput?.message).not.toContain("Hiveward blueprint run");
        expect(adapter.lastChatStreamInput?.modelId).toBe("openclaw/default");
        expect(adapter.lastChatStreamInput?.thinking).toBe("medium");
      }, adapter);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("does not pass native chat skills to a harness when those skills are not installed", async () => {
    const fixture = await createStoreFixture();
    const adapter = new TrackingAdapter();
    const codexHome = join(fixture.dir, "codex-home");
    const previousCodexHome = process.env.CODEX_HOME;
    mkdirSync(join(codexHome, "skills"), { recursive: true });
    process.env.CODEX_HOME = codexHome;
    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await streamSessionChat(baseUrl, {
          harnessId: "codex",
          message: "Say hello from Codex chat.",
          attachments: [],
          modelId: "gpt-5.5",
          thinkingEffort: "medium",
          includePlatformContext: true,
          roleScope: {
            role: "ceo"
          }
        });
        const text = await response.text();

        expect(response.status, text).toBe(200);
        expect(adapter.lastChatStreamInput?.source).toBe("codex");
        expect(adapter.lastChatStreamInput?.skillIds).toBeUndefined();
        expect(adapter.lastChatStreamInput?.message).toContain("hiveward-ceo");
      }, adapter);
    } finally {
      restoreEnv("CODEX_HOME", previousCodexHome);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("does not expose the old generic chat stream route", async () => {
    const fixture = await createStoreFixture();
    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/chat/stream`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({})
        });

        expect(response.status).toBe(404);
      });
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("streams Codex and Claude Code chat responses through the selected harness source", async () => {
    const fixture = await createStoreFixture();
    const adapter = new TrackingAdapter();
    const codexHome = join(fixture.dir, "codex-home");
    const claudeHome = join(fixture.dir, "claude-home");
    const previousCodexDefault = process.env.HIVEWARD_CODEX_DEFAULT_MODEL;
    const previousClaudeDefault = process.env.HIVEWARD_CLAUDE_CODE_DEFAULT_MODEL;
    const previousCodexHome = process.env.CODEX_HOME;
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    mkdirSync(join(codexHome, "skills", "hiveward-ceo"), { recursive: true });
    mkdirSync(join(claudeHome, "skills", "hiveward-leader"), { recursive: true });
    writeFileSync(join(codexHome, "skills", "hiveward-ceo", "SKILL.md"), "# CEO\n");
    writeFileSync(join(claudeHome, "skills", "hiveward-leader", "SKILL.md"), "# Leader\n");
    process.env.HIVEWARD_CODEX_DEFAULT_MODEL = "codex/chat-default";
    process.env.HIVEWARD_CLAUDE_CODE_DEFAULT_MODEL = "inherit";
    process.env.CODEX_HOME = codexHome;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const codexResponse = await streamSessionChat(baseUrl, {
          harnessId: "codex",
          message: "Say hello from Codex.",
          attachments: [],
          thinkingEffort: "high",
          includePlatformContext: false,
          roleScope: {
            role: "ceo"
          }
        });
        const codexText = await codexResponse.text();

        expect(codexResponse.status, codexText).toBe(200);
        expect(codexText).toContain("main completed through Codex adapter");
        expect(adapter.lastChatStreamInput?.source).toBe("codex");
        expect(adapter.lastChatStreamInput?.sessionKey).toBe("");
        expect(adapter.lastChatStreamInput?.modelId).toBe("codex/chat-default");
        expect(adapter.lastChatStreamInput?.permissionMode).toBe("safe");
        expect(adapter.lastChatStreamInput?.skillIds).toEqual(["hiveward-ceo"]);
        expect(adapter.lastChatStreamInput?.message).toContain("HiveWard appointment:");
        expect(adapter.lastChatStreamInput?.message).toContain("hiveward-ceo");

        const { roles } = await fixture.store.getRoleDirectory();
        const leader = roles.leaders[0]!;
        expect(leader).toBeDefined();
        const claudeResponse = await streamSessionChat(baseUrl, {
          harnessId: "claudeCode",
          message: "Say hello from Claude Code.",
          attachments: [],
          modelId: "inherit",
          thinkingEffort: "medium",
          permissionMode: "full_access",
          roleScope: {
            role: "leader",
            leaderId: leader.id,
            blueprintId: leader.blueprintId
          }
        });
        const claudeText = await claudeResponse.text();

        expect(claudeResponse.status, claudeText).toBe(200);
        expect(claudeText).toContain("main completed through Claude Code adapter");
        expect(adapter.lastChatStreamInput?.source).toBe("claude");
        expect(adapter.lastChatStreamInput?.sessionKey).toBe("");
        expect(adapter.lastChatStreamInput?.modelId).toBeUndefined();
        expect(adapter.lastChatStreamInput?.permissionMode).toBe("full_access");
        expect(adapter.lastChatStreamInput?.skillIds).toEqual(["hiveward-leader"]);
        expect(adapter.lastChatStreamInput?.message).toContain("hiveward-leader");
      }, adapter);
    } finally {
      restoreEnv("HIVEWARD_CODEX_DEFAULT_MODEL", previousCodexDefault);
      restoreEnv("HIVEWARD_CLAUDE_CODE_DEFAULT_MODEL", previousClaudeDefault);
      restoreEnv("CODEX_HOME", previousCodexHome);
      restoreEnv("CLAUDE_CONFIG_DIR", previousClaudeConfigDir);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("injects CEO skill decomposition guidance in skill split mode", async () => {
    const fixture = await createStoreFixture();
    const adapter = new TrackingAdapter();
    const codexHome = join(fixture.dir, "codex-home");
    const previousCodexHome = process.env.CODEX_HOME;
    mkdirSync(join(codexHome, "skills", "hiveward-ceo"), { recursive: true });
    mkdirSync(join(codexHome, "skills", "hiveward-skill-decomposer"), { recursive: true });
    writeFileSync(join(codexHome, "skills", "hiveward-ceo", "SKILL.md"), "# CEO\n");
    writeFileSync(join(codexHome, "skills", "hiveward-skill-decomposer", "SKILL.md"), "# Decomposer\n");
    process.env.CODEX_HOME = codexHome;
    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await streamSessionChat(baseUrl, {
          harnessId: "codex",
          message: "帮我拆分一个 skill",
          attachments: [],
          modelId: "codex/test-default",
          thinkingEffort: "medium",
          mode: "skill_split",
          roleScope: {
            role: "ceo"
          }
        });
        const text = await response.text();

        expect(response.status, text).toBe(200);
        expect(adapter.lastChatStreamInput?.message).toContain("Skill split mode:");
        expect(adapter.lastChatStreamInput?.message).toContain("hiveward-skill-decomposer");
        expect(adapter.lastChatStreamInput?.message).toContain("Ask the user for skill material");
        expect(adapter.lastChatStreamInput?.message).toContain("source completeness");
        expect(adapter.lastChatStreamInput?.message).toContain("Skill IR summary");
        expect(adapter.lastChatStreamInput?.message).toContain("blueprint exposure metadata");
        expect(adapter.lastChatStreamInput?.message).toContain("states where required scripts live");
        expect(adapter.lastChatStreamInput?.message).toContain("Do not place the CEO role inside the generated runtime blueprint");
        expect(adapter.lastChatStreamInput?.message).toContain("do not claim current blueprint runtime enforces per-node thinking effort");
        expect(adapter.lastChatStreamInput?.message).not.toContain("Current selected blueprint JSON:");
        expect(adapter.lastChatStreamInput?.skillIds).toEqual(["hiveward-ceo", "hiveward-skill-decomposer"]);
      }, adapter);
    } finally {
      restoreEnv("CODEX_HOME", previousCodexHome);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("includes the inbox submission contract for skill split approval requests", async () => {
    const fixture = await createStoreFixture();
    const adapter = new TrackingAdapter();
    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await streamSessionChat(baseUrl, {
          harnessId: "codex",
          message: "已经拿到 skill 内容了，请提交拆分后的蓝图提案到审批",
          attachments: [],
          modelId: "codex/test-default",
          thinkingEffort: "medium",
          mode: "skill_split",
          roleScope: {
            role: "ceo"
          }
        });
        const text = await response.text();

        expect(response.status, text).toBe(200);
        expect(adapter.lastChatStreamInput?.message).toContain("Skill split mode:");
        expect(adapter.lastChatStreamInput?.message).toContain("HIVEWARD_INBOX_SUBMISSION_CONTRACT v1");
        expect(adapter.lastChatStreamInput?.message).toContain(hivewardInboxSubmissionSchema);
      }, adapter);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("includes the inbox submission contract for Chinese blueprint approval requests", async () => {
    const fixture = await createStoreFixture();
    const adapter = new TrackingAdapter();
    const blueprint = (await fixture.store.listBlueprints())[0]!;
    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await streamSessionChat(baseUrl, {
          harnessId: "codex",
          message: "\u8bf7\u628a\u8fd9\u4e2a\u84dd\u56fe\u63d0\u6848\u63d0\u4ea4\u5230\u5ba1\u6279",
          attachments: [],
          modelId: "codex/test-default",
          thinkingEffort: "medium",
          mode: "blueprint",
          roleScope: {
            role: "leader",
            leaderId: "leader-test",
            blueprintId: blueprint.id
          }
        });
        const text = await response.text();

        expect(response.status, text).toBe(200);
        expect(adapter.lastChatStreamInput?.source).toBe("codex");
        expect(adapter.lastChatStreamInput?.message).toContain("HIVEWARD_INBOX_SUBMISSION_CONTRACT v1");
        expect(adapter.lastChatStreamInput?.message).toContain(hivewardInboxSubmissionSchema);
      }, adapter);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("turns formal chat inbox submission blocks into pending inbox items", async () => {
    const fixture = await createStoreFixture();
    const blueprint = (await fixture.store.listBlueprints())[0]!;
    const output = [
      "I prepared the concrete package and submitted it for inbox approval.",
      "```hiveward-inbox",
      JSON.stringify({
        schema: hivewardInboxSubmissionSchema,
        type: "blueprint_proposal",
        blueprintId: blueprint.id,
        title: "Review generated blueprint package",
        summary: "Approve the generated package before Hiveward imports it.",
        diffSummary: "Creates a pending package review from chat.",
        blueprintPackage: {
          schema: "hiveward.blueprint-package/v1",
          exportedAt: "2026-05-23T00:00:00.000Z",
          blueprints: [
            {
              id: "review-generated-blueprint-package",
              name: "Review generated blueprint package",
              description: "A test blueprint package submitted from chat.",
              version: 1,
              nodes: [
                {
                  id: "brief",
                  type: "agent",
                  runtimeId: "openclaw",
                  position: { x: 0, y: 0 },
                  config: {
                    label: "Brief",
                    agentName: "brief-agent",
                    prompt: "Write a brief.",
                    tools: []
                  }
                }
              ],
              edges: [],
              variables: {},
              display: { viewport: { x: 0, y: 0, zoom: 1 } }
            }
          ]
        }
      }),
      "```"
    ].join("\n");
    const adapter = new ChatOutputAdapter(output);
    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await streamSessionChat(baseUrl, {
          harnessId: "openclaw",
          nativeSessionId: "main",
          message: "Submit this blueprint package for approval.",
          attachments: [],
          modelId: "openclaw/default",
          agentId: "main",
          thinkingEffort: "medium",
          mode: "blueprint",
          roleScope: {
            role: "leader",
            leaderId: "leader-test",
            blueprintId: blueprint.id
          }
        });
        const text = await response.text();

        expect(response.status, text).toBe(200);
        expect(text).toContain("event: inbox_item_created");
        expect(text).toContain("\"replace\":true");
        expect(text).toContain("Review generated blueprint package");
        expect(text).toContain("已提交到收件箱，请前往收件箱审批。");
        expect(adapter.lastChatStreamInput?.message).toContain("HiveWard appointment:");
        expect(adapter.lastChatStreamInput?.message).toContain("Installed external skill:");
        expect(adapter.lastChatStreamInput?.message).toContain("hiveward-leader");
        expect(adapter.lastChatStreamInput?.message).not.toContain("SKILL.md");
        expect(adapter.lastChatStreamInput?.message).toContain("Leader owns exactly one bound business blueprint");
        expect(adapter.lastChatStreamInput?.message).not.toContain("The Leader is the permanent role seat bound to exactly one business blueprint.");
        expect(adapter.lastChatStreamInput?.message).not.toContain("Hiveward role scope:");
        expect(adapter.lastChatStreamInput?.message).toContain("HIVEWARD_INBOX_SUBMISSION_CONTRACT v1");
        expect(adapter.lastChatStreamInput?.message).toContain(hivewardInboxSubmissionSchema);

        const inboxResponse = await fetch(`${baseUrl}/api/inbox`);
        const inboxBody = await readOkJson<{ items: Array<{ id: string; title: string; status: string; type: string; blueprintId?: string }> }>(inboxResponse);
        expect(inboxBody.items[0]).toMatchObject({
          title: "Review generated blueprint package",
          status: "pending",
          type: "blueprint_proposal",
          blueprintId: blueprint.id
        });

        const replyResponse = await fetch(`${baseUrl}/api/inbox/${inboxBody.items[0]!.id}/reply`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "Please tighten the generated package before I approve it." })
        });
        const replyBody = await readOkJson<{ item: { replies?: Array<{ role: string; body: string }> } }>(replyResponse);
        expect(replyBody.item.replies).toMatchObject([
          {
            role: "user",
            body: "Please tighten the generated package before I approve it."
          }
        ]);

        const approveResponse = await fetch(`${baseUrl}/api/inbox/${inboxBody.items[0]!.id}/approve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({})
        });
        const approveBody = await readOkJson<{ importedBlueprints?: Array<{ name: string }> }>(approveResponse);
        expect(approveBody.importedBlueprints?.[0]).toMatchObject({
          name: "Review generated blueprint package"
        });

        const blueprintsResponse = await fetch(`${baseUrl}/api/blueprints`);
        const blueprintsBody = await readOkJson<{ blueprints: Array<{ name: string }> }>(blueprintsResponse);
        expect(blueprintsBody.blueprints.some((item) => item.name === "Review generated blueprint package")).toBe(true);
      }, adapter);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("reports invalid chat inbox submission blocks without creating inbox items", async () => {
    const fixture = await createStoreFixture();
    const blueprint = (await fixture.store.listBlueprints())[0]!;
    const output = [
      "Okay, submitting this package for approval.",
      "HIVEWARD-INBOX",
      "```json",
      JSON.stringify({
        schema: hivewardInboxSubmissionSchema,
        type: "blueprint_proposal",
        blueprintId: blueprint.id,
        title: "Incomplete package",
        summary: "This should not become an inbox item."
      }),
      "```"
    ].join("\n");
    const adapter = new ChatOutputAdapter(output);
    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await streamSessionChat(baseUrl, {
          harnessId: "openclaw",
          nativeSessionId: "main",
          message: "Submit this incomplete package for approval.",
          attachments: [],
          modelId: "openclaw/default",
          agentId: "main",
          thinkingEffort: "medium",
          mode: "blueprint",
          roleScope: {
            role: "leader",
            leaderId: "leader-test",
            blueprintId: blueprint.id
          }
        });
        const text = await response.text();

        expect(response.status, text).toBe(200);
        expect(text).toContain("\"replace\":true");
        expect(text).toContain("\"status\":\"failed\"");
        expect(text).toContain("Blueprint proposal request requires blueprintPackage.");
        expect(text).not.toContain("event: inbox_item_created");

        const inboxResponse = await fetch(`${baseUrl}/api/inbox`);
        const inboxBody = await readOkJson<{ items: Array<{ id: string }> }>(inboxResponse);
        expect(inboxBody.items).toEqual([]);
      }, adapter);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("uses the selected chat harness as the default runtime when approving generated blueprint proposals", async () => {
    const fixture = await createStoreFixture();
    const blueprint = (await fixture.store.listBlueprints())[0]!;
    const previousCodexDefault = process.env.HIVEWARD_CODEX_DEFAULT_MODEL;
    process.env.HIVEWARD_CODEX_DEFAULT_MODEL = "codex/proposal-default";
    const output = [
      "I prepared a Codex-backed blueprint package for approval.",
      "```hiveward-inbox",
      JSON.stringify({
        schema: hivewardInboxSubmissionSchema,
        type: "blueprint_proposal",
        blueprintId: blueprint.id,
        title: "Codex runtime proposal",
        summary: "Approve a generated package from a Codex chat session.",
        diffSummary: "Creates a single agent blueprint.",
        preview: {},
        blueprintPackage: {
          schema: "hiveward.blueprint-package/v1",
          exportedAt: "2026-05-24T00:00:00.000Z",
          blueprints: [
            {
              id: "codex-runtime-proposal",
              name: "Codex runtime proposal",
              version: 1,
              nodes: [
                {
                  id: "brief",
                  type: "agent",
                  position: { x: 0, y: 0 },
                  config: {
                    label: "Brief",
                    agentName: "brief-agent",
                    prompt: "Write a brief.",
                    tools: []
                  }
                }
              ],
              edges: [],
              variables: {},
              display: { viewport: { x: 0, y: 0, zoom: 1 } }
            }
          ]
        }
      }),
      "```"
    ].join("\n");
    const adapter = new ChatOutputAdapter(output);
    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await streamSessionChat(baseUrl, {
          harnessId: "codex",
          nativeSessionId: "codex-session",
          message: "Submit this blueprint package for approval.",
          attachments: [],
          modelId: "codex/proposal-default",
          thinkingEffort: "medium",
          mode: "blueprint",
          roleScope: {
            role: "leader",
            leaderId: "leader-test",
            blueprintId: blueprint.id
          }
        });
        const text = await response.text();
        expect(response.status, text).toBe(200);
        expect(text).toContain("event: inbox_item_created");

        const inbox = await readOkJson<{ items: Array<{ id: string; payload?: Record<string, unknown> }> }>(
          await fetch(`${baseUrl}/api/inbox`)
        );
        expect(inbox.items[0]?.payload?.runtimeId).toBe("codex");

        const approved = await readOkJson<{ importedBlueprints?: BlueprintDefinition[] }>(
          await fetch(`${baseUrl}/api/inbox/${inbox.items[0]!.id}/approve`, { method: "POST" })
        );
        const importedNode = approved.importedBlueprints?.[0]?.nodes.find((node) => node.id === "brief");
        const importedConfig = importedNode?.config as AgentNodeConfig | undefined;
        expect(importedNode?.runtimeId).toBe("codex");
        expect(importedConfig?.modelId).toBe("codex/proposal-default");
        expect(importedConfig?.openclawAgentId).toBeUndefined();
      }, adapter);
    } finally {
      restoreEnv("HIVEWARD_CODEX_DEFAULT_MODEL", previousCodexDefault);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported Hiveward inbox submission schema versions", async () => {
    const fixture = await createStoreFixture();
    const blueprint = (await fixture.store.listBlueprints())[0]!;
    const output = [
      "Okay, submitting this package for approval.",
      "```hiveward-inbox",
      JSON.stringify({
        schema: "hiveward.inbox-submission/v0",
        type: "blueprint_proposal",
        blueprintId: blueprint.id,
        title: "Old schema package",
        summary: "This should not become an inbox item.",
        blueprintPackage: {
          schema: "hiveward.blueprint-package/v1",
          exportedAt: "2026-05-23T00:00:00.000Z",
          blueprints: [
            {
              id: "old-schema-blueprint",
              name: "Old schema package",
              version: 1,
              nodes: [],
              edges: [],
              variables: {},
              display: { viewport: { x: 0, y: 0, zoom: 1 } }
            }
          ]
        }
      }),
      "```"
    ].join("\n");
    const adapter = new ChatOutputAdapter(output);
    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await streamSessionChat(baseUrl, {
          harnessId: "openclaw",
          nativeSessionId: "main",
          message: "Submit this old schema package for approval.",
          attachments: [],
          modelId: "openclaw/default",
          agentId: "main",
          thinkingEffort: "medium",
          mode: "blueprint",
          roleScope: {
            role: "leader",
            leaderId: "leader-test",
            blueprintId: blueprint.id
          }
        });
        const text = await response.text();

        expect(response.status, text).toBe(200);
        expect(text).toContain("\"status\":\"failed\"");
        expect(text).toContain(`Expected ${hivewardInboxSubmissionSchema}.`);
        expect(text).not.toContain("event: inbox_item_created");
      }, adapter);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("rejects chat blueprint proposals that use unsupported Hiveward node types", async () => {
    const fixture = await createStoreFixture();
    const blueprint = (await fixture.store.listBlueprints())[0]!;
    const output = [
      "Okay, submitting this package for approval.",
      "```hiveward-inbox",
      JSON.stringify({
        schema: hivewardInboxSubmissionSchema,
        type: "blueprint_proposal",
        blueprintId: blueprint.id,
        title: "Unsupported node proposal",
        summary: "This should fail before it becomes an inbox item.",
        blueprintPackage: {
          schema: "hiveward.blueprint-package/v1",
          exportedAt: "2026-05-23T00:00:00.000Z",
          blueprints: [
            {
              id: "unsupported-node-blueprint",
              name: "Unsupported node proposal",
              version: 1,
              nodes: [
                {
                  id: "fetch",
                  type: "http.get",
                  position: { x: 0, y: 0 },
                  config: { label: "Fetch" }
                }
              ],
              edges: [],
              variables: {},
              display: { viewport: { x: 0, y: 0, zoom: 1 } }
            }
          ]
        }
      }),
      "```"
    ].join("\n");
    const adapter = new ChatOutputAdapter(output);
    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await streamSessionChat(baseUrl, {
          harnessId: "openclaw",
          nativeSessionId: "main",
          message: "Submit this unsupported package for approval.",
          attachments: [],
          modelId: "openclaw/default",
          agentId: "main",
          thinkingEffort: "medium",
          mode: "blueprint",
          roleScope: {
            role: "leader",
            leaderId: "leader-test",
            blueprintId: blueprint.id
          }
        });
        const text = await response.text();

        expect(response.status, text).toBe(200);
        expect(text).toContain("\"status\":\"failed\"");
        expect(text).toContain("Unsupported blueprint node type: http.get.");
        expect(text).not.toContain("event: inbox_item_created");

        const inboxResponse = await fetch(`${baseUrl}/api/inbox`);
        const inboxBody = await readOkJson<{ items: Array<{ id: string }> }>(inboxResponse);
        expect(inboxBody.items).toEqual([]);
      }, adapter);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("repairs common model JSON and edge-shape mistakes in chat blueprint proposals", async () => {
    const fixture = await createStoreFixture();
    const blueprint = (await fixture.store.listBlueprints())[0]!;
    const validSubmission = {
      schema: hivewardInboxSubmissionSchema,
      type: "blueprint_proposal",
      blueprintId: blueprint.id,
      title: "Repaired X blueprint proposal",
      summary: "This proposal has a common extra closing brace and from/to edges.",
      blueprintPackage: {
        schema: "hiveward.blueprint-package/v1",
        exportedAt: "2026-05-23T00:00:00.000Z",
        blueprints: [
          {
            id: "repaired-x-blueprint",
            name: "Repaired X blueprint proposal",
            version: 1,
            nodes: [
              {
                id: "fetch",
                type: "agent",
                runtimeId: "openclaw",
                position: { x: 0, y: 0 },
                config: {
                  label: "Fetch",
                  agentName: "fetch-agent",
                  prompt: "Fetch X trending data.",
                  tools: []
                }
              },
              {
                id: "render",
                type: "agent",
                runtimeId: "openclaw",
                position: { x: 320, y: 0 },
                config: {
                  label: "Render",
                  agentName: "render-agent",
                  prompt: "Render an HTML report from upstream data.",
                  tools: []
                }
              }
            ],
            edges: [{ from: "fetch", to: "render" }],
            variables: {},
            display: { viewport: { x: 0, y: 0, zoom: 1 } }
          }
        ]
      }
    };
    const malformedSubmission = JSON.stringify(validSubmission).replace(/}]}}$/, "}}]}}");
    const adapter = new ChatOutputAdapter([
      "Okay, submitting this package for approval.",
      "```hiveward-inbox",
      malformedSubmission,
      "```"
    ].join("\n"));

    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await streamSessionChat(baseUrl, {
          harnessId: "openclaw",
          nativeSessionId: "main",
          message: "Submit this package for approval.",
          attachments: [],
          modelId: "openclaw/default",
          agentId: "main",
          thinkingEffort: "medium",
          mode: "blueprint",
          roleScope: {
            role: "leader",
            leaderId: "leader-test",
            blueprintId: blueprint.id
          }
        });
        const text = await response.text();

        expect(response.status, text).toBe(200);
        expect(text).toContain("event: inbox_item_created");
        expect(text).not.toContain("Inbox submission failed");

        const inboxResponse = await fetch(`${baseUrl}/api/inbox`);
        const inboxBody = await readOkJson<{ items: Array<{ id: string; title: string }> }>(inboxResponse);
        expect(inboxBody.items[0]).toMatchObject({ title: "Repaired X blueprint proposal" });

        const approveResponse = await fetch(`${baseUrl}/api/inbox/${inboxBody.items[0]!.id}/approve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({})
        });
        const approveBody = await readOkJson<{ importedBlueprints?: Array<{ edges: Array<{ source: string; target: string }> }> }>(approveResponse);
        expect(approveBody.importedBlueprints?.[0]?.edges[0]).toMatchObject({
          source: "fetch",
          target: "render"
        });
      }, adapter);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("proxies native chat history by session key", async () => {
    const fixture = await createStoreFixture();
    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/chat/history?sessionKey=${encodeURIComponent("session-demo-1")}`);
        const body = await readOkJson<{ messages: Array<{ role: string; content: string }> }>(response);

        expect(body.messages.length).toBeGreaterThan(0);
        expect(body.messages[0]).toMatchObject({
          role: "user",
          content: "Mock runtime session history."
        });
      });
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("syncs Hiveward inbox submissions from native chat history without duplicates", async () => {
    const fixture = await createStoreFixture();
    const blueprint = (await fixture.store.listBlueprints())[0]!;
    const now = new Date().toISOString();
    const output = [
      "I prepared the package for approval.",
      "```hiveward-inbox",
      JSON.stringify({
        schema: hivewardInboxSubmissionSchema,
        type: "blueprint_proposal",
        blueprintId: blueprint.id,
        title: "History synced blueprint package",
        summary: "Created from a native runtime history response.",
        diffSummary: "Adds a history-synced blueprint package.",
        blueprintPackage: {
          schema: "hiveward.blueprint-package/v1",
          exportedAt: "2026-05-23T00:00:00.000Z",
          blueprints: [
            {
              id: "history-synced-blueprint",
              name: "History synced blueprint package",
              description: "Valid proposal recovered from native history.",
              version: 1,
              nodes: [
                {
                  id: "brief",
                  type: "agent",
                  runtimeId: "openclaw",
                  position: { x: 0, y: 0 },
                  config: {
                    label: "Brief",
                    agentName: "brief-agent",
                    prompt: "Write a brief.",
                    tools: []
                  }
                }
              ],
              edges: [],
              variables: {},
              display: { viewport: { x: 0, y: 0, zoom: 1 } }
            }
          ]
        }
      }),
      "```"
    ].join("\n");
    const adapter = new ChatHistoryAdapter([
      {
        id: "history-sync-user",
        role: "user",
        content: "Submit this package for approval.",
        createdAt: now
      },
      {
        id: "history-sync-assistant",
        role: "assistant",
        content: output,
        createdAt: now
      }
    ]);

    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const firstResponse = await fetch(`${baseUrl}/api/chat/history?sessionKey=${encodeURIComponent("agent:main:dashboard:history-sync")}`);
        const firstBody = await readOkJson<{
          messages: Array<{ role: string; content: string }>;
          inboxItems?: Array<{ id: string; title: string; status: string; type: string }>;
        }>(firstResponse);

        expect(firstBody.messages[1]?.content).toContain("I prepared the package for approval.");
        expect(firstBody.messages[1]?.content).toContain("已提交到收件箱，请前往收件箱审批。");
        expect(firstBody.messages[1]?.content).not.toContain("hiveward-inbox");
        expect(firstBody.inboxItems?.[0]).toMatchObject({
          title: "History synced blueprint package",
          status: "pending",
          type: "blueprint_proposal"
        });

        const secondResponse = await fetch(`${baseUrl}/api/chat/history?sessionKey=${encodeURIComponent("agent:main:dashboard:history-sync")}`);
        const secondBody = await readOkJson<{ inboxItems?: Array<{ id: string }> }>(secondResponse);
        expect(secondBody.inboxItems?.[0]?.id).toBe(firstBody.inboxItems?.[0]?.id);

        const inboxResponse = await fetch(`${baseUrl}/api/inbox`);
        const inboxBody = await readOkJson<{ items: Array<{ title: string }> }>(inboxResponse);
        expect(inboxBody.items.filter((item) => item.title === "History synced blueprint package")).toHaveLength(1);
      }, adapter);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("creates native chat sessions through the runtime adapter", async () => {
    const fixture = await createStoreFixture();
    const adapter = new TrackingAdapter();
    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/chat/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agentId: "main",
            parentSessionKey: "main"
          })
        });
        const body = await readOkJson<{ sessionKey: string }>(response);

        expect(response.status).toBe(201);
        expect(body.sessionKey).toMatch(/^agent:main:chat-/);
        expect(adapter.lastChatSessionInput).toEqual({
          agentId: "main",
          parentSessionKey: "main"
        });
      }, adapter);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("updates native chat session titles through the runtime adapter", async () => {
    const fixture = await createStoreFixture();
    const adapter = new TrackingAdapter();
    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/chat/session`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionKey: "agent:main:main",
            title: "Renamed chat"
          })
        });
        const body = await readOkJson<{ sessionKey: string; title: string }>(response);

        expect(body).toEqual({
          sessionKey: "agent:main:main",
          title: "Renamed chat"
        });
        expect(adapter.lastChatSessionTitleInput).toEqual({
          sessionKey: "agent:main:main",
          title: "Renamed chat"
        });
      }, adapter);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("persists skill split chat mode on HiveWard chat sessions", async () => {
    const fixture = await createStoreFixture();
    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const createResponse = await fetch(`${baseUrl}/api/chat/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            harnessId: "codex",
            title: "Skill split",
            mode: "skill_split"
          })
        });
        const created = await readOkJson<{ session: HivewardChatSession }>(createResponse);

        expect(created.session.mode).toBe("skill_split");

        const readResponse = await fetch(`${baseUrl}/api/chat/sessions/${created.session.id}`);
        const readBack = await readOkJson<{ session: HivewardChatSession }>(readResponse);

        expect(readBack.session.mode).toBe("skill_split");
      });
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("persists Codex chat sessions and resumes the native session id on the next turn", async () => {
    const fixture = await createStoreFixture();
    const adapter = new NativeSessionTrackingAdapter("codex-native-session-1", "codex persisted response");
    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const createResponse = await fetch(`${baseUrl}/api/chat/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            harnessId: "codex",
            title: "Codex persistence",
            modelId: "codex/test-default",
            thinkingEffort: "high"
          })
        });
        const created = await readOkJson<{ session: HivewardChatSession }>(createResponse);

        const firstResponse = await fetch(`${baseUrl}/api/chat/sessions/${created.session.id}/messages/stream`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "First Codex turn." })
        });
        expect(firstResponse.status).toBe(200);
        await firstResponse.text();

        const afterFirst = await readOkJson<{ session: HivewardChatSession }>(
          await fetch(`${baseUrl}/api/chat/sessions/${created.session.id}`)
        );
        expect(afterFirst.session.nativeSessionId).toBe("codex-native-session-1");
        expect(afterFirst.session.nativeSessionState).toBe("resumable");

        const secondResponse = await fetch(`${baseUrl}/api/chat/sessions/${created.session.id}/messages/stream`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "Second Codex turn." })
        });
        expect(secondResponse.status).toBe(200);
        await secondResponse.text();

        expect(adapter.chatInputs).toHaveLength(2);
        expect(adapter.chatInputs[0]?.sessionKey).toBe("");
        expect(adapter.chatInputs[1]?.sessionKey).toBe("codex-native-session-1");

        const messages = await readOkJson<{ messages: HivewardChatMessage[] }>(
          await fetch(`${baseUrl}/api/chat/sessions/${created.session.id}/messages`)
        );
        expect(messages.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
        expect(messages.messages[1]).toMatchObject({
          harnessId: "codex",
          content: "codex persisted response",
          status: "sent"
        });
      }, adapter);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("marks missing native sessions and requires explicit HiveWard history rebuild", async () => {
    const fixture = await createStoreFixture();
    const adapter = new NativeMissingAdapter();
    try {
      await withApiServer(fixture.store, async (baseUrl) => {
        const createResponse = await fetch(`${baseUrl}/api/chat/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            harnessId: "codex",
            title: "Missing native",
            nativeSessionId: "missing-native-session",
            modelId: "codex/test-default"
          })
        });
        const created = await readOkJson<{ session: HivewardChatSession }>(createResponse);

        const failedResponse = await fetch(`${baseUrl}/api/chat/sessions/${created.session.id}/messages/stream`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "Try to resume." })
        });
        expect(failedResponse.status).toBe(200);
        await failedResponse.text();

        const afterFailure = await readOkJson<{ session: HivewardChatSession }>(
          await fetch(`${baseUrl}/api/chat/sessions/${created.session.id}`)
        );
        expect(afterFailure.session.status).toBe("native_missing");
        expect(afterFailure.session.nativeSessionState).toBe("missing");

        const blockedResponse = await fetch(`${baseUrl}/api/chat/sessions/${created.session.id}/messages/stream`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "Continue without permission." })
        });
        expect(blockedResponse.status).toBe(409);

        const rebuiltResponse = await fetch(`${baseUrl}/api/chat/sessions/${created.session.id}/messages/stream`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: "Continue with history.",
            rebuildFromHivewardHistory: true
          })
        });
        expect(rebuiltResponse.status).toBe(200);
        await rebuiltResponse.text();

        expect(adapter.chatInputs.at(-1)?.sessionKey).toBe("");
        expect(adapter.chatInputs.at(-1)?.message).toContain("HiveWard visible conversation history:");

        const afterRebuild = await readOkJson<{ session: HivewardChatSession }>(
          await fetch(`${baseUrl}/api/chat/sessions/${created.session.id}`)
        );
        expect(afterRebuild.session.status).toBe("active");
        expect(afterRebuild.session.nativeSessionId).toBe("rebuilt-native-session");
      }, adapter);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

async function createStoreFixture(): Promise<{ dir: string; store: FileHivewardStore }> {
  const dir = mkdtempSync(join(tmpdir(), "hiveward-api-"));
  const store = new FileHivewardStore(join(dir, "hiveward-store.json"));
  await store.init();
  return { dir, store };
}

async function seedRunApprovalRequest(store: FileHivewardStore, runId: string, nodeRunId: string): Promise<ApprovalRequest> {
  const now = new Date().toISOString();
  const request: ApprovalRequest = {
    id: `approval-${nodeRunId}`,
    runId,
    nodeRunId,
    kind: "agent_proposal",
    status: "pending",
    title: `${nodeRunId} approval`,
    body: "Review output",
    sourceRef: { type: "node_run", id: nodeRunId },
    threadId: `thread-${nodeRunId}`,
    revision: 1,
    capabilities: resolveApprovalCapabilities("agent_proposal", "pending"),
    requestedBy: {
      type: "node",
      label: nodeRunId,
      nodeId: nodeRunId
    },
    requestedAt: now,
    updatedAt: now
  };
  return store.upsertApprovalRequest(request);
}

async function seedStandaloneApprovalRequest(store: FileHivewardStore, id: string): Promise<ApprovalRequest> {
  const now = new Date().toISOString();
  const request: ApprovalRequest = {
    id,
    runId: id,
    kind: "leader_delegation",
    status: "pending",
    title: "Standalone approval",
    body: "Approve the standalone request.",
    sourceRef: { type: "inbox_item", id },
    threadId: `thread-${id}`,
    revision: 1,
    capabilities: resolveApprovalCapabilities("leader_delegation", "pending"),
    requestedBy: {
      type: "role",
      label: "ceo",
      roleId: "ceo"
    },
    requestedAt: now,
    updatedAt: now
  };
  return store.upsertApprovalRequest(request);
}

async function seedInboxApprovalRequest(store: FileHivewardStore, itemId: string): Promise<ApprovalRequest> {
  const now = new Date().toISOString();
  const request: ApprovalRequest = {
    id: `approval-${itemId}`,
    runId: itemId,
    kind: "leader_delegation",
    status: "pending",
    title: "Inbox approval",
    body: "Approve the inbox item.",
    payloadRef: itemId,
    sourceRef: { type: "inbox_item", id: itemId },
    threadId: `thread-${itemId}`,
    revision: 1,
    capabilities: resolveApprovalCapabilities("leader_delegation", "pending"),
    requestedBy: {
      type: "role",
      label: "ceo",
      roleId: "ceo"
    },
    requestedAt: now,
    updatedAt: now
  };
  return store.upsertApprovalRequest(request);
}

async function withApiServer(
  store: FileHivewardStore,
  work: (baseUrl: string) => Promise<void>,
  adapter = new TrackingAdapter(),
  openClawConfigStore = createConfigStoreFixture(),
  worker = {} as BlueprintWorker
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(createApiRouter({
    store,
    openClawConfigStore,
    adapter,
    worker
  }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error &&
      typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : 500;
    const code = typeof error === "object" && error !== null && "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "internal_error";
    const message = error instanceof Error ? error.message : "Unexpected API failure.";
    res.status(statusCode).json({ error: { code, message } });
  });

  const server = app.listen(0);
  try {
    const address = server.address() as AddressInfo;
    await work(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

async function readOkJson<T = unknown>(response: Response): Promise<T> {
  const text = await response.text();
  expect([200, 201], text).toContain(response.status);
  return JSON.parse(text) as T;
}

type StreamSessionChatTestInput = {
  harnessId: HivewardChatSession["harnessId"];
  title?: string;
  nativeSessionId?: string;
  message: string;
  attachments?: unknown[];
  modelId?: string;
  agentId?: string;
  thinkingEffort?: HivewardChatSession["thinkingEffort"];
  permissionMode?: HivewardChatSession["permissionMode"];
  includePlatformContext?: boolean;
  mode?: HivewardChatSession["mode"];
  roleScope?: HivewardChatSession["roleScope"];
  rebuildFromHivewardHistory?: boolean;
};

async function streamSessionChat(baseUrl: string, input: StreamSessionChatTestInput): Promise<Response> {
  const createResponse = await fetch(`${baseUrl}/api/chat/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      harnessId: input.harnessId,
      title: input.title ?? input.message,
      nativeSessionId: input.nativeSessionId,
      modelId: input.modelId,
      agentId: input.agentId,
      thinkingEffort: input.thinkingEffort,
      permissionMode: input.permissionMode,
      mode: input.mode,
      roleScope: input.roleScope
    })
  });
  const created = await readOkJson<{ session: HivewardChatSession }>(createResponse);

  return fetch(`${baseUrl}/api/chat/sessions/${created.session.id}/messages/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: input.message,
      attachments: input.attachments ?? [],
      modelId: input.modelId,
      agentId: input.agentId,
      thinkingEffort: input.thinkingEffort,
      permissionMode: input.permissionMode,
      includePlatformContext: input.includePlatformContext,
      mode: input.mode,
      roleScope: input.roleScope,
      rebuildFromHivewardHistory: input.rebuildFromHivewardHistory
    })
  });
}

function createConfigStoreFixture(defaultWorkspace = "D:\\hiveward-test"): OpenClawConfigStore {
  const state: OpenClawConfigState = {
    configPath: "test-openclaw.json",
    defaultWorkspace,
    defaultModelId: "openclaw/default",
    configuredModels: [{ id: "openclaw/default", label: "OpenClaw Default", provider: "openclaw" }],
    configuredAgents: [
      {
        id: "main",
        name: "main",
        workspace: defaultWorkspace,
        agentDir: join(defaultWorkspace, ".openclaw", "agents", "main"),
        modelId: "openclaw/default",
        isDefault: true
      }
    ],
    configuredChannels: []
  };
  const version: OpenClawVersionInfo = {
    version: "0.0.0-test",
    resolvedAt: "2026-05-21T00:00:00.000Z"
  };
  return {
    async getState() {
      return state;
    },
    async getVersion() {
      return version;
    }
  } as OpenClawConfigStore;
}

function readAgentConfig(blueprint: BlueprintDefinition, nodeId: string): AgentNodeConfig {
  return blueprint.nodes.find((node) => node.id === nodeId)!.config as AgentNodeConfig;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function writeFakeExecutable(path: string, output: string): void {
  if (process.platform === "win32") {
    writeFileSync(`${path}.cmd`, `@echo off\r\necho ${output}\r\n`, "utf8");
    return;
  }
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, "utf8");
  chmodSync(path, 0o755);
}

function writeFakeHermesExecutable(
  path: string,
  options: { allowProfileWrites?: boolean; profileRows?: string[] } = {}
): void {
  const profileRows = options.profileRows ?? [
    " Profile          Model                        Gateway      Alias        Distribution",
    "\u25c6ceo             hermes-primary-test            stopped      hw-ceo       \u2014",
    " architect       hermes-profile-model-test                      stopped      \u2014            \u2014",
    " researcher      hermes-research-model-test      stopped      -            \u2014"
  ];
  const scriptPath = `${path}.js`;
  const script = [
    "const args = process.argv.slice(2);",
    "if (args[0] === \"--version\") { console.log(\"hermes 0.9.0\"); process.exit(0); }",
    "if (args[0] === \"profile\" && args[1] === \"list\") {",
    ...profileRows.map((row) => `  console.log(${JSON.stringify(row)});`),
    "  process.exit(0);",
    "}",
    options.allowProfileWrites
      ? "if (args[0] === \"profile\" && (args[1] === \"create\" || args[1] === \"alias\")) process.exit(0);"
      : "",
    "process.exit(1);"
  ].filter(Boolean).join("\n");
  writeFileSync(scriptPath, script, "utf8");
  if (process.platform === "win32") {
    writeFileSync(`${path}.cmd`, `@echo off\r\nnode "${scriptPath}" %*\r\n`, "utf8");
    return;
  }
  writeFileSync(path, `#!/bin/sh\nnode '${scriptPath.replace(/'/g, "'\\''")}' "$@"\n`, "utf8");
  chmodSync(path, 0o755);
}
