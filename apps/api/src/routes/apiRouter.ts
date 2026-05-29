import { Router, type Response } from "express";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import type {
  AgentNodeConfig,
  AgentRuntimeId,
  ApproveInboxItemRequest,
  BlueprintImportDefaults,
  CatalogSnapshot,
  ChatRoleScope,
  CreateCompanyRequest,
  ConfigureOpenClawChannelRequest,
  ConfigureOpenClawModelAuthRequest,
  CreateOpenClawChannelRequest,
  CreateBlueprintRequest,
  CreateBlueprintProposalRequest,
  CreateOpenClawAgentRequest,
  CreateOpenClawModelRequest,
  CreateLeaderDelegationRequest,
  HarnessId,
  HarnessModelOption,
  HarnessProfileOption,
  HermesChannelOption,
  HermesConfigResponse,
  HermesSkillOption,
  CreateHermesProfileRequest,
  CreateHermesChannelRequest,
  HarnessSkillInstallCandidate,
  HarnessSkillInstallCandidateSource,
  HarnessSkillId,
  HarnessSkillStatusItem,
  HarnessSkillStatusResponse,
  HarnessStatus,
  ImportBlueprintPackageRequest,
  InstallHarnessSkillsResponse,
  RuntimeOverview,
  OpenClawConfiguredAgent,
  OpenClawConfiguredChannel,
  OpenClawConfigState,
  RuntimeObjectSource,
  OpenClawVersionInfo,
  ManagerNodeConfig,
  SummaryNodeConfig,
  UpdateCompanyRequest,
  UpdateOpenClawDefaultModelRequest,
  SelectCompanyRequest,
  SaveDashboardStateRequest,
  SaveArchitectureBlueprintLayoutRequest,
  SaveBlueprintRequest,
  ChatAttachment,
  ChatHistoryMessage,
  ChatMode,
  ChatPermissionMode,
  ChatRuntimeRef,
  ChatSessionStatus,
  ChatThinkingEffort,
  ApproveBlueprintRunRequest,
  CreateChatSessionRequest,
  CreateHivewardChatSessionRequest,
  InboxItem,
  RejectBlueprintRunRequest,
  RejectInboxItemRequest,
  ReplyBlueprintRunApprovalRequest,
  ReplyInboxItemRequest,
  SendChatSessionMessageRequest,
  UpdateChatSessionTitleRequest,
  UpdateHivewardChatSessionRequest,
  SelectBlueprintRunApprovalRequest,
  ChatStreamEvent,
  ApprovalDecision,
  ApprovalRequest,
  BlueprintDefinition,
  BlueprintRun,
  HivewardChatMessage,
  HivewardChatSession,
  StartBlueprintRunRequest,
  ApplyHivewardUpdateResponse,
  ClaudeCodeModelConfig,
  ClaudeCodeModelPreset,
  ClaudeCodeModelConfigResponse,
  ClaudeCodeSavedModelProfile,
  SaveClaudeCodeModelProfileRequest,
  UpdateClaudeCodeModelConfigRequest,
  ApprovalRequestResponse
} from "@hiveward/shared";
import { claudeCodeModelPresets, createPortableBlueprintPackage, isAgentBlueprintNode, readPortableBlueprintPackage } from "@hiveward/shared";
import { buildHivewardRoleSkillPrompt, hivewardInboxSubmissionContract, hivewardInboxSubmissionSchema } from "@hiveward/shared";
import { ApprovalService } from "../services/lifecycleApprovalService";
import { isPathInside } from "../services/artifactService";
import { ManagerMailProjector } from "../services/managerMailProjector";
import type { RuntimeAdapter } from "@hiveward/adapter";
import type { HivewardStore } from "../store/hivewardStore";
import type { OpenClawConfigStore } from "../store/openClawConfigStore";
import { listOpenClawModelUsage } from "../store/openClawUsageStore";
import type { BlueprintWorker } from "../worker/blueprintWorker";
import { applyHivewardUpdate, getHivewardUpdateStatus } from "../update";

interface ApiRouterDeps {
  store: HivewardStore;
  openClawConfigStore: OpenClawConfigStore;
  adapter: RuntimeAdapter;
  worker: BlueprintWorker;
  artifactRoot?: string;
}

interface RunModelDefaults {
  openclaw?: string;
  codex?: string;
  claude?: string;
  google?: string;
  cursor?: string;
  opencode?: string;
  hermes?: string;
}

interface HarnessModelDefaults extends Pick<RunModelDefaults, "codex" | "claude" | "google" | "cursor" | "opencode" | "hermes"> {
  codexModels: HarnessModelOption[];
  claudeModels: HarnessModelOption[];
  googleModels: HarnessModelOption[];
  cursorModels: HarnessModelOption[];
  opencodeModels: HarnessModelOption[];
  hermesModels: HarnessModelOption[];
}

type ChatDoneEvent = Extract<ChatStreamEvent, { type: "done" }>;

type ChatInboxSubmissionResult = {
  item: InboxItem;
  output: string;
};

type ChatInboxSubmissionBlock = {
  fullMatch: string;
  json: string;
};

type StreamHivewardChatSessionInput = {
  sessionId: string;
  body: SendChatSessionMessageRequest;
  requestStartedAtMs: number;
  store: HivewardStore;
  openClawConfigStore: OpenClawConfigStore;
  adapter: RuntimeAdapter;
  res: Response;
};

type ResolvedChatSessionMessage = {
  harnessId: HarnessId;
  message: string;
  attachments?: ChatAttachment[];
  modelId?: string;
  agentId?: string;
  nativeSessionKey?: string;
  thinkingEffort?: ChatThinkingEffort;
  permissionMode?: ChatPermissionMode;
  includePlatformContext?: boolean;
  mode?: ChatMode;
  roleScope?: ChatRoleScope;
};

type HarnessSkillInstallCandidateInput = {
  root: string;
  source: HarnessSkillInstallCandidateSource;
  label: string;
};

type HarnessSkillInstallTarget = {
  root: string;
  candidates: HarnessSkillInstallCandidate[];
};

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const fallbackCodexDefaultModel = "gpt-5.4";
const fallbackClaudeCodeDefaultModel = "inherit";
const fallbackCliDefaultModel = "inherit";
const codexDefaultThinkingLevels: ChatThinkingEffort[] = ["low", "medium", "high", "xhigh"];
const claudeCodeDefaultThinkingLevels: ChatThinkingEffort[] = ["off", "low", "medium", "high", "xhigh", "max", "adaptive"];
const cliHarnessDefaultThinkingLevels: ChatThinkingEffort[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const hivewardHarnessSkills: Array<{
  id: HarnessSkillId;
  label: string;
  sourceDir: string;
}> = [
  {
    id: "hiveward-ceo",
    label: "HiveWard CEO",
    sourceDir: join(repositoryRoot, "docs", "skills", "hiveward-ceo")
  },
  {
    id: "hiveward-leader",
    label: "HiveWard Leader",
    sourceDir: join(repositoryRoot, "docs", "skills", "hiveward-leader")
  },
  {
    id: "hiveward-skill-decomposer",
    label: "HiveWard Skill Decomposer",
    sourceDir: join(repositoryRoot, "apps", "api", "harness-skills", "hiveward-skill-decomposer")
  }
];

export function createApiRouter({ store, openClawConfigStore, adapter, worker, artifactRoot: configuredArtifactRoot }: ApiRouterDeps): Router {
  const router = Router();
  const approvalService = new ApprovalService(store);
  const managerMailProjector = new ManagerMailProjector(store);
  const artifactRoot = resolve(configuredArtifactRoot ?? join(store.getDataDir(), "artifacts"));

  router.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  router.get("/readyz", (_req, res) => {
    res.json({ ok: true, runtimeDiscovery: "not_on_readiness_path" });
  });

  router.get(/^\/artifacts\/(.+)$/, (req, res, next) => {
    const relativePath = (req.params as Record<string, string>)[0] ?? "";
    const resolved = resolve(artifactRoot, relativePath);
    if (!isPathInside(resolved, artifactRoot)) {
      res.status(400).json({ error: { code: "artifact_path_invalid", message: "Artifact path escaped artifact root." } });
      return;
    }
    if (!existsSync(resolved)) {
      res.status(404).json({ error: { code: "artifact_not_found", message: "Artifact not found." } });
      return;
    }
    res.sendFile(resolved, (error) => {
      if (error) next(error);
    });
  });

  router.get("/api/companies", async (_req, res, next) => {
    try {
      res.json(await store.listCompanies());
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/companies", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as CreateCompanyRequest;
      res.status(201).json(await store.createCompany(body));
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/companies/selected", async (req, res, next) => {
    try {
      const body = req.body as SelectCompanyRequest;
      res.json(await store.selectCompany(body.companyId));
    } catch (error) {
      next(error);
    }
  });

  router.patch("/api/companies/:companyId", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as UpdateCompanyRequest;
      res.json(await store.updateCompany(req.params.companyId, body));
    } catch (error) {
      next(error);
    }
  });

  router.delete("/api/companies/:companyId", async (req, res, next) => {
    try {
      res.json(await store.deleteCompany(req.params.companyId));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/openclaw-config", async (_req, res, next) => {
    try {
      res.json({ config: await openClawConfigStore.getState() });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/openclaw-version", async (_req, res, next) => {
    try {
      res.json({ version: await openClawConfigStore.getVersion() });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/hiveward-update", async (_req, res, next) => {
    try {
      res.json({ update: await getHivewardUpdateStatus() });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/hiveward-update/apply", async (_req, res, next) => {
    try {
      const result: ApplyHivewardUpdateResponse = await applyHivewardUpdate();
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/harness-status", async (_req, res, next) => {
    try {
      const [version, config] = await Promise.all([openClawConfigStore.getVersion(), openClawConfigStore.getState()]);
      res.json({ statuses: buildHarnessStatuses(version, config, resolveHarnessModelDefaults()) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/hermes-config", (_req, res, next) => {
    try {
      res.json(readHermesConfigResponse());
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/hermes-config/profiles", (req, res, next) => {
    try {
      createHermesProfile(req.body as CreateHermesProfileRequest);
      res.status(201).json(readHermesConfigResponse());
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/hermes-config/channels", async (req, res, next) => {
    try {
      await createHermesChannel(req.body as CreateHermesChannelRequest);
      res.status(201).json(readHermesConfigResponse());
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/claude-code-config/models", (_req, res, next) => {
    try {
      res.json(readClaudeCodeModelConfigResponse());
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/claude-code-config/models", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as UpdateClaudeCodeModelConfigRequest;
      await updateClaudeCodeModelConfig(body);
      res.json(readClaudeCodeModelConfigResponse());
    } catch (error) {
      if (error instanceof ClaudeCodeModelConfigInputError) {
        res.status(400).json({
          error: {
            code: error.code,
            message: error.message
          }
        });
        return;
      }
      next(error);
    }
  });

  router.post("/api/claude-code-config/model-profiles", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as SaveClaudeCodeModelProfileRequest;
      await saveCurrentClaudeCodeModelProfile(body);
      res.status(201).json(readClaudeCodeModelConfigResponse());
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/claude-code-config/model-profiles/:profileId/apply", async (req, res, next) => {
    try {
      await applyClaudeCodeSavedModelProfile(req.params.profileId);
      res.json(readClaudeCodeModelConfigResponse());
    } catch (error) {
      if (error instanceof ClaudeCodeModelConfigInputError) {
        res.status(400).json({
          error: {
            code: error.code,
            message: error.message
          }
        });
        return;
      }
      next(error);
    }
  });

  router.delete("/api/claude-code-config/model-profiles/:profileId", async (req, res, next) => {
    try {
      await deleteClaudeCodeSavedModelProfile(req.params.profileId);
      res.json(readClaudeCodeModelConfigResponse());
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/harness-skills/:harnessId", async (req, res, next) => {
    try {
      const harnessId = readHarnessId(req.params.harnessId);
      res.json(await buildHarnessSkillStatusResponse(harnessId, openClawConfigStore));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/harness-skills/:harnessId/install", async (req, res, next) => {
    try {
      const harnessId = readHarnessId(req.params.harnessId);
      res.status(201).json(await installHarnessSkills(harnessId, openClawConfigStore));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/openclaw-usage/models", async (_req, res, next) => {
    try {
      res.json({ usage: await listOpenClawModelUsage() });
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/openclaw-config/default-model", async (req, res, next) => {
    try {
      const body = req.body as UpdateOpenClawDefaultModelRequest;
      res.json({ config: await openClawConfigStore.updateDefaultModel(body.modelId) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/openclaw-config/wizard", (_req, res, next) => {
    try {
      res.json({ wizard: openClawConfigStore.getWizardMetadata() });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/openclaw-config/models", async (req, res, next) => {
    try {
      const body = req.body as CreateOpenClawModelRequest;
      res.status(201).json({ config: await openClawConfigStore.addModel(body) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/openclaw-config/model-auth", async (req, res, next) => {
    try {
      const body = req.body as ConfigureOpenClawModelAuthRequest;
      res.status(201).json({ config: await openClawConfigStore.configureModelAuth(body) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/openclaw-config/agents", async (req, res, next) => {
    try {
      const body = req.body as CreateOpenClawAgentRequest;
      res.status(201).json({ config: await openClawConfigStore.addAgent(body) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/openclaw-config/channels", async (req, res, next) => {
    try {
      const body = req.body as CreateOpenClawChannelRequest;
      res.status(201).json({ config: await openClawConfigStore.addChannel(body) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/openclaw-config/channel-setup", async (req, res, next) => {
    try {
      const body = req.body as ConfigureOpenClawChannelRequest;
      res.status(201).json({ config: await openClawConfigStore.configureChannel(body) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/blueprints", async (_req, res, next) => {
    try {
      res.json({ blueprints: await store.listBlueprints() });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/blueprints", async (req, res, next) => {
    try {
      const body = req.body as CreateBlueprintRequest;
      const blueprint = await store.createBlueprint({
        name: body.name,
        description: body.description
      });
      res.status(201).json({ blueprint });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/blueprints/import", async (req, res, next) => {
    try {
      const body = req.body as ImportBlueprintPackageRequest;
      const blueprintPackage = readPortableBlueprintPackage(body.blueprintPackage);
      const config = await openClawConfigStore.getState();
      const blueprints = await store.importBlueprintPackage(blueprintPackage, buildBlueprintImportDefaults(config));
      res.status(201).json({ blueprints });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/blueprints/:blueprintId", async (req, res, next) => {
    try {
      const blueprintId = readRouteParam(req.params.blueprintId, "blueprintId");
      const blueprint = await store.getBlueprint(blueprintId);
      if (!blueprint) {
        res.status(404).json({ error: { code: "blueprint_not_found", message: "Blueprint not found." } });
        return;
      }
      res.json({ blueprint });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/blueprints/:blueprintId/export", async (req, res, next) => {
    try {
      const blueprintId = readRouteParam(req.params.blueprintId, "blueprintId");
      const blueprint = await store.getBlueprint(blueprintId);
      if (!blueprint) {
        res.status(404).json({ error: { code: "blueprint_not_found", message: "Blueprint not found." } });
        return;
      }
      res.json({ blueprintPackage: createPortableBlueprintPackage([blueprint], new Date().toISOString()) });
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/blueprints/:blueprintId", async (req, res, next) => {
    try {
      const body = req.body as SaveBlueprintRequest;
      const saved = await store.saveBlueprint({
        ...body.blueprint,
        id: readRouteParam(req.params.blueprintId, "blueprintId")
      });
      res.json({ blueprint: saved });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/api/blueprints/:blueprintId", async (req, res, next) => {
    try {
      const blueprintId = readRouteParam(req.params.blueprintId, "blueprintId");
      const deleted = await store.deleteBlueprint(blueprintId);
      if (!deleted) {
        res.status(404).json({ error: { code: "blueprint_not_found", message: "Blueprint not found." } });
        return;
      }
      res.json({ blueprintId });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/blueprints/:blueprintId/runs", async (req, res, next) => {
    try {
      const blueprintId = readRouteParam(req.params.blueprintId, "blueprintId");
      const blueprint = await store.getBlueprint(blueprintId);
      if (!blueprint) {
        res.status(404).json({ error: { code: "blueprint_not_found", message: "Blueprint not found." } });
        return;
      }
      const config = await openClawConfigStore.getState();
      const invalidAgentIds = collectInvalidAgentIds(blueprint, new Set(config.configuredAgents.map((agent) => agent.id)));
      if (invalidAgentIds.length > 0) {
        res.status(400).json({
          error: {
            code: "blueprint_agent_invalid",
            message: `Blueprint references agent ids that are not present in OpenClaw config: ${invalidAgentIds.join(", ")}`
          }
        });
        return;
      }
      const body = req.body as StartBlueprintRunRequest;
      const harnessDefaults = resolveHarnessModelDefaults();
      const run = await worker.startRun(
        withRunDefaults(blueprint, {
          openclaw: config.defaultModelId,
          codex: harnessDefaults.codex,
          claude: harnessDefaults.claude,
          google: harnessDefaults.google,
          cursor: harnessDefaults.cursor,
          opencode: harnessDefaults.opencode,
          hermes: harnessDefaults.hermes
        }),
        body.startedBy ?? "local-user"
      );
      const view = await store.getRunView(run.id);
      res.status(201).json({ run: view });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/blueprints/:blueprintId/runs/latest", async (req, res, next) => {
    try {
      const blueprintId = readRouteParam(req.params.blueprintId, "blueprintId");
      const blueprint = await store.getBlueprint(blueprintId);
      if (!blueprint) {
        res.status(404).json({ error: { code: "blueprint_not_found", message: "Blueprint not found." } });
        return;
      }
      res.json({ run: (await store.getLatestRunViewForBlueprint(blueprintId)) ?? null });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/blueprint-runs/:runId", async (req, res, next) => {
    try {
      const view = await store.getRunView(readRouteParam(req.params.runId, "runId"));
      if (!view) {
        res.status(404).json({ error: { code: "run_not_found", message: "Blueprint run not found." } });
        return;
      }
      res.json({ run: view });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/blueprint-runs", async (_req, res, next) => {
    try {
      res.json({ runs: await store.listRunSummaries() });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/blueprint-runs/:runId/cancel", async (req, res, next) => {
    try {
      const run = await store.getBlueprintRun(readRouteParam(req.params.runId, "runId"));
      if (!run) {
        res.status(404).json({ error: { code: "run_not_found", message: "Blueprint run not found." } });
        return;
      }
      const updated = await worker.cancelRun(run);
      const view = await store.getRunView(updated.id);
      if (!view) {
        res.status(404).json({ error: { code: "run_not_found", message: "Blueprint run not found." } });
        return;
      }
      res.json({ run: view });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/approvals/pending", async (_req, res, next) => {
    try {
      res.json({ approvals: await store.listPendingApprovals() });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/approval-requests", async (_req, res, next) => {
    try {
      res.json({ approvalRequests: await store.listApprovalRequests() });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/approval-requests/:approvalRequestId", async (req, res, next) => {
    try {
      const approvalRequest = await store.getApprovalRequest(readRouteParam(req.params.approvalRequestId, "approvalRequestId"));
      if (!approvalRequest) {
        res.status(404).json({ error: { code: "approval_request_not_found", message: "Approval request not found." } });
        return;
      }
      res.json({ approvalRequest });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/approval-requests/:approvalRequestId/approve", async (req, res, next) => {
    try {
      res.json(await applyApprovalRequestRouteAction("approve", readRouteParam(req.params.approvalRequestId, "approvalRequestId"), req.body));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/approval-requests/:approvalRequestId/reject", async (req, res, next) => {
    try {
      res.json(await applyApprovalRequestRouteAction("reject", readRouteParam(req.params.approvalRequestId, "approvalRequestId"), req.body));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/approval-requests/:approvalRequestId/reply", async (req, res, next) => {
    try {
      res.json(await applyApprovalRequestRouteAction("reply", readRouteParam(req.params.approvalRequestId, "approvalRequestId"), req.body));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/approval-requests/:approvalRequestId/complete", async (req, res, next) => {
    try {
      res.json(await applyApprovalRequestRouteAction("complete", readRouteParam(req.params.approvalRequestId, "approvalRequestId"), req.body));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/approval-requests/:approvalRequestId/terminate", async (req, res, next) => {
    try {
      res.json(await applyApprovalRequestRouteAction("terminate", readRouteParam(req.params.approvalRequestId, "approvalRequestId"), req.body));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/approval-messages", async (_req, res, next) => {
    try {
      res.json({ messages: await managerMailProjector.refresh() });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/roles", async (_req, res, next) => {
    try {
      res.json(await store.getRoleDirectory());
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/roles/architecture-layout", async (req, res, next) => {
    try {
      const body = normalizeSaveArchitectureBlueprintLayoutRequest(req.body);
      res.json(await store.saveArchitectureLayout(body.positions));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/inbox", async (_req, res, next) => {
    try {
      res.json({ items: await store.listInboxItems() });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/inbox/delegations", async (req, res, next) => {
    try {
      const body = normalizeCreateLeaderDelegationRequest(req.body);
      const item = await store.createLeaderDelegationRequest(body);
      await createInboxApprovalRequest(item, "leader_delegation");
      res.status(201).json({ item });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/inbox/blueprint-proposals", async (req, res, next) => {
    try {
      const body = normalizeCreateBlueprintProposalRequest(req.body);
      const item = await store.createBlueprintProposal(body);
      await createInboxApprovalRequest(item, "blueprint_proposal");
      res.status(201).json({ item });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/inbox/:itemId/approve", async (req, res, next) => {
    try {
      const body = normalizeApproveInboxItemRequest(req.body);
      const config = await openClawConfigStore.getState();
      const itemId = readRouteParam(req.params.itemId, "itemId");
      const request = await findPendingInboxApprovalRequest(itemId);
      const decision = request ? buildApprovalDecision(request, "approve", "approved", body.comment) : undefined;
      const result = await store.applyInboxDecision({
        inboxItemId: itemId,
        approvalRequestId: request?.id,
        action: "approve",
        comment: body.comment,
        defaults: buildBlueprintImportDefaults(config),
        approvalDecision: decision
      });
      if (result.status === "conflict") {
        sendConflict(res, "inbox_decision_conflict", "Inbox item is no longer pending.");
        return;
      }
      await managerMailProjector.refresh();
      res.json({ item: result.item, importedBlueprints: result.importedBlueprints });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/inbox/:itemId/reject", async (req, res, next) => {
    try {
      const body = normalizeRejectInboxItemRequest(req.body);
      const itemId = readRouteParam(req.params.itemId, "itemId");
      const request = await findPendingInboxApprovalRequest(itemId);
      const decision = request ? buildApprovalDecision(request, "reject", "rejected", body.comment) : undefined;
      const result = await store.applyInboxDecision({
        inboxItemId: itemId,
        approvalRequestId: request?.id,
        action: "reject",
        comment: body.comment,
        approvalDecision: decision
      });
      if (result.status === "conflict") {
        sendConflict(res, "inbox_decision_conflict", "Inbox item is no longer pending.");
        return;
      }
      await managerMailProjector.refresh();
      res.json({ item: result.item });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/inbox/:itemId/reply", async (req, res, next) => {
    try {
      const body = normalizeReplyInboxItemRequest(req.body);
      const itemId = readRouteParam(req.params.itemId, "itemId");
      const request = await findPendingInboxApprovalRequest(itemId);
      const decision = request ? buildApprovalDecision(request, "reply", "pending", body.message) : undefined;
      const result = await store.applyInboxDecision({
        inboxItemId: itemId,
        approvalRequestId: request?.id,
        action: "reply",
        comment: body.message,
        approvalDecision: decision
      });
      if (result.status === "conflict") {
        sendConflict(res, "inbox_decision_conflict", "Inbox item is no longer pending.");
        return;
      }
      await managerMailProjector.refresh();
      res.json({ item: result.item });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/dashboard-state", async (_req, res, next) => {
    try {
      res.json({ dashboard: await store.getDashboardState() });
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/dashboard-state", async (req, res, next) => {
    try {
      const body = req.body as SaveDashboardStateRequest;
      res.json({ dashboard: await store.saveDashboardState(body.dashboard) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/runtime-overview", async (_req, res) => {
    try {
      res.json({ runtime: await adapter.getRuntimeOverview() });
    } catch (error) {
      res.json({ runtime: emptyRuntimeOverview() });
    }
  });

  router.get("/api/chat/sessions", async (_req, res, next) => {
    try {
      res.json({ sessions: await store.listChatSessions() });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/chat/sessions", async (req, res) => {
    let body: CreateHivewardChatSessionRequest;
    try {
      body = normalizeCreateHivewardChatSessionRequest(req.body);
    } catch (error) {
      res.status(400).json({
        error: {
          code: "hiveward_chat_session_request_invalid",
          message: error instanceof Error ? error.message : "Invalid HiveWard chat session request."
        }
      });
      return;
    }

    try {
      res.status(201).json({ session: await store.createChatSession(body) });
    } catch (error) {
      res.status(500).json({
        error: {
          code: "hiveward_chat_session_create_failed",
          message: error instanceof Error ? error.message : "HiveWard chat session creation failed."
        }
      });
    }
  });

  router.get("/api/chat/sessions/:sessionId", async (req, res, next) => {
    try {
      const session = await store.getChatSession(readRouteParam(req.params.sessionId, "sessionId"));
      if (!session) {
        res.status(404).json({ error: { code: "chat_session_not_found", message: "Chat session not found." } });
        return;
      }
      res.json({ session });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/api/chat/sessions/:sessionId", async (req, res) => {
    let body: UpdateHivewardChatSessionRequest;
    try {
      body = normalizeUpdateHivewardChatSessionRequest(req.body);
    } catch (error) {
      res.status(400).json({
        error: {
          code: "hiveward_chat_session_update_invalid",
          message: error instanceof Error ? error.message : "Invalid HiveWard chat session update."
        }
      });
      return;
    }

    try {
      const session = await store.updateChatSession(readRouteParam(req.params.sessionId, "sessionId"), body);
      if (!session) {
        res.status(404).json({ error: { code: "chat_session_not_found", message: "Chat session not found." } });
        return;
      }
      if (session.harnessId === "openclaw" && session.nativeSessionId && body.title) {
        await adapter.updateChatSessionTitle({ sessionKey: session.nativeSessionId, title: body.title }).catch(() => undefined);
      }
      res.json({ session });
    } catch (error) {
      res.status(500).json({
        error: {
          code: "hiveward_chat_session_update_failed",
          message: error instanceof Error ? error.message : "HiveWard chat session update failed."
        }
      });
    }
  });

  router.get("/api/chat/sessions/:sessionId/messages", async (req, res, next) => {
    try {
      const sessionId = readRouteParam(req.params.sessionId, "sessionId");
      const session = await store.getChatSession(sessionId);
      if (!session) {
        res.status(404).json({ error: { code: "chat_session_not_found", message: "Chat session not found." } });
        return;
      }
      res.json({ messages: await store.listChatMessages(sessionId) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/chat/sessions/:sessionId/end", async (req, res, next) => {
    try {
      const session = await store.endChatSession(readRouteParam(req.params.sessionId, "sessionId"));
      if (!session) {
        res.status(404).json({ error: { code: "chat_session_not_found", message: "Chat session not found." } });
        return;
      }
      res.json({ session });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/chat/sessions/:sessionId/messages/stream", async (req, res) => {
    const requestStartedAtMs = Date.now();
    let body: SendChatSessionMessageRequest;
    try {
      body = normalizeSessionChatRequest(req.body);
    } catch (error) {
      res.status(400).json({
        error: {
          code: "chat_request_invalid",
          message: error instanceof Error ? error.message : "Invalid chat request."
        }
      });
      return;
    }

    await streamHivewardChatSession({
      sessionId: readRouteParam(req.params.sessionId, "sessionId"),
      body,
      requestStartedAtMs,
      store,
      openClawConfigStore,
      adapter,
      res
    });
  });

  router.post("/api/chat/session", async (req, res) => {
    let body: CreateChatSessionRequest;
    try {
      body = normalizeCreateChatSessionRequest(req.body);
    } catch (error) {
      res.status(400).json({
        error: {
          code: "chat_session_request_invalid",
          message: error instanceof Error ? error.message : "Invalid chat session request."
        }
      });
      return;
    }

    try {
      const config = await openClawConfigStore.getState();
      const session = await adapter.createChatSession({
        agentId: body.agentId || selectDefaultAgentId(config.configuredAgents),
        parentSessionKey: body.parentSessionKey
      });
      res.status(201).json(session);
    } catch (error) {
      res.status(502).json({
        error: {
          code: "chat_session_unavailable",
          message: error instanceof Error ? error.message : "Native chat session creation is unavailable."
        }
      });
    }
  });

  router.patch("/api/chat/session", async (req, res) => {
    let body: UpdateChatSessionTitleRequest;
    try {
      body = normalizeUpdateChatSessionTitleRequest(req.body);
    } catch (error) {
      res.status(400).json({
        error: {
          code: "chat_session_title_request_invalid",
          message: error instanceof Error ? error.message : "Invalid chat session title request."
        }
      });
      return;
    }

    try {
      res.json(await adapter.updateChatSessionTitle(body));
    } catch (error) {
      res.status(502).json({
        error: {
          code: "chat_session_title_unavailable",
          message: error instanceof Error ? error.message : "Native chat session title update is unavailable."
        }
      });
    }
  });

  router.get("/api/chat/history", async (req, res) => {
    const sessionKey = readOptionalString(req.query.sessionKey);
    if (!sessionKey) {
      res.status(400).json({
        error: {
          code: "chat_history_session_required",
          message: "Chat history requires a native sessionKey."
        }
      });
      return;
    }

    try {
      const messages = await adapter.getSessionMessages(sessionKey);
      res.json(await syncChatHistoryInboxSubmissions(store, messages));
    } catch (error) {
      res.status(502).json({
        error: {
          code: "chat_history_unavailable",
          message: error instanceof Error ? error.message : "Native chat history is unavailable."
        }
      });
    }
  });

  router.post("/api/blueprint-runs/:runId/approve", async (req, res, next) => {
    try {
      const run = await store.getBlueprintRun(readRouteParam(req.params.runId, "runId"));
      if (!run) {
        res.status(404).json({ error: { code: "run_not_found", message: "Blueprint run not found." } });
        return;
      }
      const blueprint = await store.getBlueprint(run.blueprintId);
      if (!blueprint) {
        res.status(404).json({ error: { code: "blueprint_not_found", message: "Blueprint not found." } });
        return;
      }
      const body = normalizeApproveBlueprintRunRequest(req.body);
      if (isTerminalRunStatus(run.status)) {
        res.status(409).json({ error: { code: "run_already_finished", message: "Run is already finished." } });
        return;
      }
      const approvalRequest = await findPendingRunApprovalRequest(run.id, body.nodeRunId);
      if (!approvalRequest) {
        res.status(409).json({ error: { code: "approval_request_not_pending", message: "No pending approval request matches this run action." } });
        return;
      }
      const updated = await worker.applyApprovalRequest(blueprint, run, approvalRequest.id, "approve", {
        comment: body.comment,
        selectedReplyId: body.selectedReplyId
      });
      res.json(await buildApprovalRequestResponse(approvalRequest.id, updated.id));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/blueprint-runs/:runId/reject", async (req, res, next) => {
    try {
      const run = await store.getBlueprintRun(readRouteParam(req.params.runId, "runId"));
      if (!run) {
        res.status(404).json({ error: { code: "run_not_found", message: "Blueprint run not found." } });
        return;
      }
      const blueprint = await store.getBlueprint(run.blueprintId);
      if (!blueprint) {
        res.status(404).json({ error: { code: "blueprint_not_found", message: "Blueprint not found." } });
        return;
      }
      const body = normalizeRejectBlueprintRunRequest(req.body);
      if (isTerminalRunStatus(run.status)) {
        res.status(409).json({ error: { code: "run_already_finished", message: "Run is already finished." } });
        return;
      }
      const approvalRequest = await findPendingRunApprovalRequest(run.id, body.nodeRunId);
      if (!approvalRequest) {
        res.status(409).json({ error: { code: "approval_request_not_pending", message: "No pending approval request matches this run action." } });
        return;
      }
      const updated = await worker.applyApprovalRequest(blueprint, run, approvalRequest.id, "reject", { comment: body.comment });
      res.json(await buildApprovalRequestResponse(approvalRequest.id, updated.id));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/blueprint-runs/:runId/reply", async (req, res, next) => {
    try {
      const run = await store.getBlueprintRun(readRouteParam(req.params.runId, "runId"));
      if (!run) {
        res.status(404).json({ error: { code: "run_not_found", message: "Blueprint run not found." } });
        return;
      }
      const blueprint = await store.getBlueprint(run.blueprintId);
      if (!blueprint) {
        res.status(404).json({ error: { code: "blueprint_not_found", message: "Blueprint not found." } });
        return;
      }
      const body = normalizeReplyBlueprintRunApprovalRequest(req.body);
      if (isTerminalRunStatus(run.status)) {
        res.status(409).json({ error: { code: "run_already_finished", message: "Run is already finished." } });
        return;
      }
      const approvalRequest = await findPendingRunApprovalRequest(run.id, body.nodeRunId);
      if (!approvalRequest) {
        res.status(409).json({ error: { code: "approval_request_not_pending", message: "No pending approval request matches this run action." } });
        return;
      }
      const updated = await worker.applyApprovalRequest(blueprint, run, approvalRequest.id, "reply", { message: body.message });
      res.json(await buildApprovalRequestResponse(approvalRequest.id, updated.id));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/blueprint-runs/:runId/select-approval-reply", async (req, res, next) => {
    try {
      const run = await store.getBlueprintRun(readRouteParam(req.params.runId, "runId"));
      if (!run) {
        res.status(404).json({ error: { code: "run_not_found", message: "Blueprint run not found." } });
        return;
      }
      const blueprint = await store.getBlueprint(run.blueprintId);
      if (!blueprint) {
        res.status(404).json({ error: { code: "blueprint_not_found", message: "Blueprint not found." } });
        return;
      }
      const body = normalizeSelectBlueprintRunApprovalRequest(req.body);
      if (isTerminalRunStatus(run.status)) {
        res.status(409).json({ error: { code: "run_already_finished", message: "Run is already finished." } });
        return;
      }
      const updated = await worker.selectApprovalReply(blueprint, run, body.nodeRunId, body.selectedReplyId);
      const view = await store.getRunView(updated.id);
      res.json({ run: view });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/catalog/snapshot", async (_req, res, next) => {
    try {
      res.json({ snapshot: (await store.getCatalogSnapshot()) ?? emptyCatalogSnapshot() });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/catalog/refresh", async (_req, res, next) => {
    try {
      res.json({ snapshot: await refreshCatalog(adapter, store) });
    } catch (error) {
      next(error);
    }
  });

  async function applyApprovalRequestRouteAction(
    action: "approve" | "reject" | "reply" | "complete" | "terminate",
    approvalRequestId: string,
    rawBody: unknown
  ): Promise<ApprovalRequestResponse> {
    const approvalRequest = await store.getApprovalRequest(approvalRequestId);
    if (!approvalRequest) {
      throw new Error(`Approval request not found: ${approvalRequestId}`);
    }
    const body = isPlainRecord(rawBody) ? rawBody : {};
    const run = await store.getBlueprintRun(approvalRequest.runId);
    if (run) {
      if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") {
        throw new Error("Run is already finished.");
      }
      const blueprint = await store.getBlueprint(run.blueprintId);
      if (!blueprint) throw new Error(`Blueprint not found: ${run.blueprintId}`);
      const updated = await worker.applyApprovalRequest(blueprint, run, approvalRequestId, action, {
        comment: readOptionalString(body.comment),
        message: readOptionalString(body.message),
        selectedReplyId: readOptionalString(body.selectedReplyId)
      });
      return buildApprovalRequestResponse(approvalRequestId, updated.id);
    }

    const result = action === "approve"
      ? await approvalService.approve(approvalRequestId, readOptionalString(body.comment), readOptionalString(body.selectedReplyId))
      : action === "reject"
        ? await approvalService.reject(approvalRequestId, readOptionalString(body.comment))
        : action === "reply"
          ? await approvalService.reply(approvalRequestId, readOptionalString(body.message) ?? "")
          : action === "complete"
            ? await approvalService.complete(approvalRequestId, readOptionalString(body.comment))
            : await approvalService.terminate(approvalRequestId, readOptionalString(body.comment));
    await managerMailProjector.refresh();
    return result;
  }

  async function buildApprovalRequestResponse(approvalRequestId: string, runId?: string): Promise<ApprovalRequestResponse> {
    const approvalRequest = await store.getApprovalRequest(approvalRequestId);
    if (!approvalRequest) {
      throw new Error(`Approval request not found: ${approvalRequestId}`);
    }
    const decisions = await store.listApprovalDecisions(approvalRequestId);
    const nextApprovalRequest = (await store.listApprovalRequests({ runId: approvalRequest.runId }))
      .find((request) => request.replacesRequestId === approvalRequestId);
    return {
      approvalRequest,
      decision: decisions.at(-1),
      nextApprovalRequest,
      run: runId ? await store.getRunView(runId) : undefined
    };
  }

  async function findPendingRunApprovalRequest(runId: string, nodeRunId?: string): Promise<{ id: string } | undefined> {
    const requests = await store.listApprovalRequests({ runId, status: "pending" });
    return requests.find((request) => !nodeRunId || request.nodeRunId === nodeRunId || request.id === nodeRunId);
  }

  function isTerminalRunStatus(status: BlueprintRun["status"]): boolean {
    return status === "succeeded" || status === "failed" || status === "cancelled";
  }

  async function createInboxApprovalRequest(item: InboxItem, kind: "leader_delegation" | "blueprint_proposal"): Promise<void> {
    const existing = await findPendingInboxApprovalRequest(item.id);
    if (existing) return;
    await approvalService.createRequest({
      runId: item.id,
      kind,
      title: item.title,
      body: item.summary,
      payloadRef: item.id,
      sourceRef: { type: "inbox_item", id: item.id },
      requestedBy: {
        type: "role",
        label: item.createdByRoleId,
        roleId: item.createdByRoleId
      }
    });
    await managerMailProjector.refresh();
  }

  async function findPendingInboxApprovalRequest(itemId: string): Promise<ApprovalRequest | undefined> {
    const requests = await store.listApprovalRequests({ status: "pending" });
    return requests.find((request) => request.sourceRef?.type === "inbox_item" && request.sourceRef.id === itemId);
  }

  function buildApprovalDecision(
    request: ApprovalRequest,
    action: ApprovalDecision["action"],
    resultingStatus: ApprovalDecision["resultingStatus"],
    comment?: string,
    selectedReplyId?: string
  ): ApprovalDecision {
    return {
      id: `decision-${nanoid(10)}`,
      approvalRequestId: request.id,
      action,
      actor: "user",
      comment: comment?.trim() || undefined,
      selectedReplyId,
      resultingStatus,
      createdAt: new Date().toISOString()
    };
  }

  function sendConflict(res: Response, code: string, message: string): void {
    res.status(409).json({ error: { code, message } });
  }

  return router;
}

function normalizeApproveBlueprintRunRequest(value: unknown): ApproveBlueprintRunRequest {
  if (value === undefined || value === null) return {};
  if (!isPlainRecord(value)) {
    throw new Error("Approve request must be a JSON object.");
  }
  return {
    nodeRunId: readOptionalString(value.nodeRunId),
    comment: readOptionalString(value.comment),
    selectedReplyId: readOptionalString(value.selectedReplyId)
  };
}

function normalizeRejectBlueprintRunRequest(value: unknown): RejectBlueprintRunRequest {
  if (value === undefined || value === null) return {};
  if (!isPlainRecord(value)) {
    throw new Error("Reject request must be a JSON object.");
  }
  return {
    nodeRunId: readOptionalString(value.nodeRunId),
    comment: readOptionalString(value.comment)
  };
}

function normalizeReplyBlueprintRunApprovalRequest(value: unknown): ReplyBlueprintRunApprovalRequest {
  if (!isPlainRecord(value)) {
    throw new Error("Approval reply request must be a JSON object.");
  }
  const nodeRunId = readOptionalString(value.nodeRunId);
  const message = readOptionalString(value.message);
  if (!nodeRunId) {
    throw new Error("Approval reply nodeRunId is required.");
  }
  if (!message) {
    throw new Error("Approval reply message is required.");
  }
  return { nodeRunId, message };
}

function normalizeSelectBlueprintRunApprovalRequest(value: unknown): SelectBlueprintRunApprovalRequest {
  if (!isPlainRecord(value)) {
    throw new Error("Approval selection request must be a JSON object.");
  }
  const nodeRunId = readOptionalString(value.nodeRunId);
  const selectedReplyId = readOptionalString(value.selectedReplyId);
  if (!nodeRunId) {
    throw new Error("Approval selection nodeRunId is required.");
  }
  if (!selectedReplyId) {
    throw new Error("Approval selection selectedReplyId is required.");
  }
  return { nodeRunId, selectedReplyId };
}

function normalizeSaveArchitectureBlueprintLayoutRequest(value: unknown): SaveArchitectureBlueprintLayoutRequest {
  if (!isPlainRecord(value) || !isPlainRecord(value.positions)) {
    throw new Error("Architecture layout request must include positions.");
  }

  const positions: SaveArchitectureBlueprintLayoutRequest["positions"] = {};
  for (const [nodeId, position] of Object.entries(value.positions)) {
    if (!isPlainRecord(position)) continue;
    const x = position.x;
    const y = position.y;
    if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) continue;
    positions[nodeId] = { x, y };
  }
  return { positions };
}

function normalizeCreateChatSessionRequest(value: unknown): CreateChatSessionRequest {
  if (!isPlainRecord(value)) {
    throw new Error("Chat session request must be a JSON object.");
  }

  return {
    agentId: readOptionalString(value.agentId),
    parentSessionKey: readOptionalString(value.parentSessionKey)
  };
}

function normalizeCreateHivewardChatSessionRequest(value: unknown): CreateHivewardChatSessionRequest {
  if (!isPlainRecord(value)) {
    throw new Error("HiveWard chat session request must be a JSON object.");
  }
  const harnessId = readHarnessId(readOptionalString(value.harnessId));
  const rawThinkingEffort = readOptionalString(value.thinkingEffort);
  const thinkingEffort = rawThinkingEffort ? normalizeChatThinkingEffort(rawThinkingEffort) : undefined;
  if (rawThinkingEffort && !thinkingEffort) {
    throw new Error("Chat thinkingEffort must be off, minimal, low, medium, high, adaptive, xhigh, or max.");
  }
  const permissionMode = normalizeChatPermissionModeForRequest(value.permissionMode, "Chat permissionMode");
  return {
    harnessId,
    title: readOptionalString(value.title)?.slice(0, 120),
    nativeSessionId: readOptionalString(value.nativeSessionId),
    modelId: readOptionalString(value.modelId),
    agentId: readOptionalString(value.agentId),
    thinkingEffort,
    permissionMode,
    mode: normalizeChatMode(value.mode),
    roleScope: normalizeChatRoleScope(value.roleScope)
  };
}

function normalizeUpdateHivewardChatSessionRequest(value: unknown): UpdateHivewardChatSessionRequest {
  if (!isPlainRecord(value)) {
    throw new Error("HiveWard chat session update must be a JSON object.");
  }
  const rawThinkingEffort = readOptionalString(value.thinkingEffort);
  const thinkingEffort = rawThinkingEffort ? normalizeChatThinkingEffort(rawThinkingEffort) : undefined;
  if (rawThinkingEffort && !thinkingEffort) {
    throw new Error("Chat thinkingEffort must be off, minimal, low, medium, high, adaptive, xhigh, or max.");
  }
  const status = normalizeChatSessionStatus(value.status);
  if (value.status !== undefined && !status) {
    throw new Error("Chat session status must be active, ended, native_missing, or failed.");
  }
  const nativeSessionState = normalizeNativeSessionState(value.nativeSessionState);
  if (value.nativeSessionState !== undefined && !nativeSessionState) {
    throw new Error("Native session state must be unknown, resumable, or missing.");
  }
  const permissionMode = normalizeChatPermissionModeForRequest(value.permissionMode, "Chat session permissionMode");
  return {
    title: readOptionalString(value.title)?.slice(0, 120),
    nativeSessionId: readOptionalString(value.nativeSessionId),
    nativeSessionState,
    modelId: readOptionalString(value.modelId),
    agentId: readOptionalString(value.agentId),
    thinkingEffort,
    permissionMode,
    mode: value.mode === undefined ? undefined : normalizeChatMode(value.mode),
    roleScope: normalizeChatRoleScope(value.roleScope),
    status
  };
}

function normalizeUpdateChatSessionTitleRequest(value: unknown): UpdateChatSessionTitleRequest {
  if (!isPlainRecord(value)) {
    throw new Error("Chat session title request must be a JSON object.");
  }
  const sessionKey = readOptionalString(value.sessionKey);
  const title = readOptionalString(value.title);
  if (!sessionKey) throw new Error("Chat session title request requires sessionKey.");
  if (!title) throw new Error("Chat session title request requires title.");
  return {
    sessionKey,
    title: title.slice(0, 120)
  };
}

function normalizeCreateLeaderDelegationRequest(value: unknown): CreateLeaderDelegationRequest {
  if (!isPlainRecord(value)) {
    throw new Error("Leader delegation request must be a JSON object.");
  }
  const leaderId = readOptionalString(value.leaderId);
  if (!leaderId) throw new Error("Leader delegation request requires leaderId.");
  return {
    leaderId,
    blueprintId: readOptionalString(value.blueprintId),
    title: readOptionalString(value.title),
    summary: readOptionalString(value.summary),
    createdByRoleId: readOptionalString(value.createdByRoleId)
  };
}

function normalizeCreateBlueprintProposalRequest(value: unknown): CreateBlueprintProposalRequest {
  if (!isPlainRecord(value)) {
    throw new Error("Blueprint proposal request must be a JSON object.");
  }
  const title = readOptionalString(value.title);
  const summary = readOptionalString(value.summary);
  if (!title) throw new Error("Blueprint proposal request requires title.");
  if (!summary) throw new Error("Blueprint proposal request requires summary.");
  if (!value.blueprintPackage) {
    throw new Error("Blueprint proposal request requires blueprintPackage.");
  }
  const blueprintPackage = readPortableBlueprintPackage(value.blueprintPackage);
  return {
    title,
    summary,
    blueprintId: readOptionalString(value.blueprintId),
    blueprintPackage,
    preview: isPlainRecord(value.preview) ? value.preview : undefined,
    diffSummary: readOptionalString(value.diffSummary),
    createdByRoleId: readOptionalString(value.createdByRoleId),
    targetRoleId: readOptionalString(value.targetRoleId),
    runtimeId: readOptionalAgentRuntimeId(value.runtimeId)
  };
}

function normalizeApproveInboxItemRequest(value: unknown): ApproveInboxItemRequest {
  if (value === undefined || value === null) return {};
  if (!isPlainRecord(value)) {
    throw new Error("Inbox approval request must be a JSON object.");
  }
  return {
    comment: readOptionalString(value.comment)
  };
}

function normalizeRejectInboxItemRequest(value: unknown): RejectInboxItemRequest {
  if (value === undefined || value === null) return {};
  if (!isPlainRecord(value)) {
    throw new Error("Inbox rejection request must be a JSON object.");
  }
  return {
    comment: readOptionalString(value.comment)
  };
}

function normalizeReplyInboxItemRequest(value: unknown): ReplyInboxItemRequest {
  if (!isPlainRecord(value)) {
    throw new Error("Inbox reply request must be a JSON object.");
  }
  const message = readOptionalString(value.message);
  if (!message) {
    throw new Error("Inbox reply message is required.");
  }
  return { message };
}

function normalizeSessionChatRequest(value: unknown): SendChatSessionMessageRequest {
  if (!isPlainRecord(value)) {
    throw new Error("Chat request must be a JSON object.");
  }

  const rawThinkingEffort = readOptionalString(value.thinkingEffort);
  const thinkingEffort = rawThinkingEffort ? normalizeChatThinkingEffort(rawThinkingEffort) : undefined;
  if (rawThinkingEffort && !thinkingEffort) {
    throw new Error("Chat thinkingEffort must be off, minimal, low, medium, high, adaptive, xhigh, or max.");
  }

  const message = readOptionalString(value.message) ?? "";
  const attachments = normalizeChatAttachments(value.attachments);
  if (!message.trim() && attachments.length === 0) {
    throw new Error("Chat message or attachment is required.");
  }

  return {
    message: message.slice(0, maxChatMessageChars),
    attachments,
    modelId: readOptionalString(value.modelId),
    agentId: readOptionalString(value.agentId),
    thinkingEffort,
    permissionMode: normalizeChatPermissionModeForRequest(value.permissionMode, "Chat permissionMode"),
    includePlatformContext: typeof value.includePlatformContext === "boolean" ? value.includePlatformContext : undefined,
    mode: value.mode === undefined ? undefined : normalizeChatMode(value.mode),
    roleScope: normalizeChatRoleScope(value.roleScope),
    rebuildFromHivewardHistory: value.rebuildFromHivewardHistory === true
  };
}

function normalizeChatMode(value: unknown): ChatMode {
  return value === "blueprint" || value === "skill_split" ? value : "chat";
}

function normalizeChatPermissionModeForRequest(value: unknown, fieldName: string): ChatPermissionMode | undefined {
  if (value === undefined) return undefined;
  if (value === "safe" || value === "full_access") return value;
  throw new Error(`${fieldName} must be safe or full_access.`);
}

function normalizeChatRoleScope(value: unknown): ChatRoleScope | undefined {
  if (!isPlainRecord(value)) return undefined;
  const role = readOptionalString(value.role);
  if (role !== "ceo" && role !== "leader") return undefined;
  return {
    role,
    companyId: readOptionalString(value.companyId),
    leaderId: readOptionalString(value.leaderId),
    blueprintId: readOptionalString(value.blueprintId)
  };
}

function normalizeChatThinkingEffort(value: string | undefined): ChatThinkingEffort | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "off" ||
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "adaptive" ||
    normalized === "xhigh" ||
    normalized === "max"
  ) {
    return normalized;
  }
  return undefined;
}

function normalizeChatSessionStatus(value: unknown): ChatSessionStatus | undefined {
  return value === "active" || value === "ended" || value === "native_missing" || value === "failed" ? value : undefined;
}

function normalizeNativeSessionState(value: unknown): HivewardChatSession["nativeSessionState"] | undefined {
  return value === "unknown" || value === "resumable" || value === "missing" ? value : undefined;
}

function normalizeChatAttachments(value: unknown): ChatAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxChatAttachments).flatMap((item) => {
    if (!isPlainRecord(item)) return [];
    const name = readOptionalString(item.name);
    if (!name) return [];
    const size = typeof item.size === "number" && Number.isFinite(item.size) ? Math.max(0, item.size) : 0;
    const text = readOptionalString(item.text);
    return [{
      id: readOptionalString(item.id) ?? `attachment-${nanoid(8)}`,
      name: name.slice(0, 180),
      mediaType: readOptionalString(item.mediaType) ?? "application/octet-stream",
      size,
      text: text?.slice(0, maxChatAttachmentTextChars),
      truncated: item.truncated === true || Boolean(text && text.length > maxChatAttachmentTextChars)
    }];
  });
}

async function buildChatRoleSkillPrompt(store: HivewardStore, scope: ChatRoleScope | undefined): Promise<string | undefined> {
  if (!scope) return undefined;
  try {
    const { roles } = await store.getRoleDirectory();
    const role = scope.role === "leader"
      ? roles.leaders.find((leader) => leader.id === scope.leaderId || leader.blueprintId === scope.blueprintId)
      : roles.ceo;
    return buildHivewardRoleSkillPrompt({
      role: scope.role,
      roleId: role?.id ?? scope.leaderId ?? scope.role,
      roleLabel: role?.label,
      companyId: scope.companyId ?? roles.companyId,
      blueprintId: role?.kind === "leader" ? role.blueprintId : scope.blueprintId,
      skillFilePath: buildRoleSkillFilePath(scope.role)
    });
  } catch {
    return buildHivewardRoleSkillPrompt({
      role: scope.role,
      roleId: scope.leaderId ?? scope.role,
      companyId: scope.companyId,
      blueprintId: scope.blueprintId,
      skillFilePath: buildRoleSkillFilePath(scope.role)
    });
  }
}

function buildRoleSkillFilePath(role: ChatRoleScope["role"]): string {
  const skillDirectory = role === "leader" ? "hiveward-leader" : "hiveward-ceo";
  return join(repositoryRoot, "docs", "skills", skillDirectory, "SKILL.md");
}

async function streamHivewardChatSession({
  sessionId,
  body,
  requestStartedAtMs,
  store,
  openClawConfigStore,
  adapter,
  res
}: StreamHivewardChatSessionInput): Promise<void> {
  let session = await store.getChatSession(sessionId);
  if (!session) {
    res.status(404).json({ error: { code: "chat_session_not_found", message: "Chat session not found." } });
    return;
  }
  if (session.status === "ended") {
    res.status(409).json({ error: { code: "chat_session_ended", message: "This chat session has ended. Create a new session to continue." } });
    return;
  }
  if (session.status === "native_missing" && !("rebuildFromHivewardHistory" in body && body.rebuildFromHivewardHistory)) {
    res.status(409).json({
      error: {
        code: "chat_session_native_missing",
        message: "The native session is not recoverable. Create a new session or explicitly rebuild from HiveWard history."
      }
    });
    return;
  }

  const config = await openClawConfigStore.getState();
  const harnessDefaults = resolveHarnessModelDefaults();
  const defaults = {
    openclaw: config.defaultModelId,
    codex: harnessDefaults.codex,
    claude: harnessDefaults.claude,
    google: harnessDefaults.google,
    cursor: harnessDefaults.cursor,
    opencode: harnessDefaults.opencode,
    hermes: harnessDefaults.hermes
  };
  const messagesBefore = await store.listChatMessages(session.id);
  const shouldRebuildFromHivewardHistory = "rebuildFromHivewardHistory" in body && body.rebuildFromHivewardHistory === true;
  const rebuildContext = shouldRebuildFromHivewardHistory ? buildHivewardHistoryContext(messagesBefore) : undefined;
  if (shouldRebuildFromHivewardHistory) {
    session = await store.updateChatSession(session.id, {
      nativeSessionId: undefined,
      nativeSessionState: "unknown",
      status: "active"
    }) ?? session;
  }

  const requestBody: ResolvedChatSessionMessage = {
    harnessId: session.harnessId,
    message: body.message,
    attachments: body.attachments ?? [],
    modelId: body.modelId ?? session.modelId,
    agentId: body.agentId ?? session.agentId,
    nativeSessionKey: shouldRebuildFromHivewardHistory ? undefined : session.nativeSessionId,
    thinkingEffort: body.thinkingEffort ?? session.thinkingEffort ?? "medium",
    permissionMode: body.permissionMode ?? session.permissionMode ?? "safe",
    includePlatformContext: body.includePlatformContext ?? messagesBefore.length === 0,
    mode: body.mode ?? session.mode,
    roleScope: body.roleScope ?? session.roleScope
  };
  const source = sourceForChatHarness(requestBody.harnessId);
  const agentId = requestBody.agentId || selectDefaultAgentId(config.configuredAgents);
  const modelId = resolveChatModelId(requestBody, config, defaults);
  const userMessage = await store.appendChatMessage({
    sessionId: session.id,
    role: "user",
    content: requestBody.message || "Uploaded files",
    attachments: requestBody.attachments,
    harnessId: requestBody.harnessId,
    modelId: requestBody.modelId,
    status: "sent"
  });
  const assistantMessage = await store.appendChatMessage({
    sessionId: session.id,
    role: "assistant",
    content: "",
    harnessId: requestBody.harnessId,
    modelId: requestBody.modelId,
    status: "streaming"
  });
  session = await store.updateChatSession(session.id, {
    modelId: requestBody.modelId,
    agentId,
    thinkingEffort: requestBody.thinkingEffort,
    permissionMode: requestBody.permissionMode,
    mode: requestBody.mode,
    roleScope: requestBody.roleScope,
    status: "active"
  }) ?? session;
  const resolvedRoleScope = session.roleScope;
  const resolvedRequestBody: ResolvedChatSessionMessage = {
    ...requestBody,
    roleScope: resolvedRoleScope
  };

  res.status(200);
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders?.();

  const isClosed = () => res.writableEnded || res.destroyed;
  let doneEvent: ChatDoneEvent | undefined;
  let streamedOutput = "";
  let runtimeAcceptedAtMs: number | undefined;
  let runtimeFirstDeltaAtMs: number | undefined;
  let nativeSessionKey = requestBody.nativeSessionKey ?? "";
  const attemptedNativeResume = Boolean(nativeSessionKey) && !shouldRebuildFromHivewardHistory;
  const runtimeStartedAtMs = Date.now();

  try {
    if (requestBody.harnessId === "openclaw" && !nativeSessionKey) {
      const nativeSession = await adapter.createChatSession({ agentId });
      nativeSessionKey = nativeSession.sessionKey;
      requestBody.nativeSessionKey = nativeSessionKey;
      session = await store.updateChatSession(session.id, {
        nativeSessionId: nativeSessionKey,
        nativeSessionState: "resumable"
      }) ?? session;
    }

    const roleSkillPrompt = await buildChatRoleSkillPrompt(store, resolvedRoleScope);
    const selectedBlueprintContext =
      requestBody.mode === "blueprint"
        ? await buildSelectedBlueprintDraftingContext(store, resolvedRoleScope)
        : undefined;
    const prompt = buildChatPrompt(resolvedRequestBody, roleSkillPrompt, rebuildContext, selectedBlueprintContext);
    const skillIds = await chatSkillIdsForRequest(requestBody.harnessId, resolvedRoleScope, requestBody.mode, openClawConfigStore);
    await adapter.streamChatMessage(
      {
        sessionKey: nativeSessionKey,
        source,
        message: prompt,
        attachments: requestBody.attachments ?? [],
        modelId,
        thinking: requestBody.thinkingEffort,
        permissionMode: requestBody.permissionMode,
        idempotencyKey: userMessage.id,
        timeoutMs: 3_600_000,
        skillIds
      },
      (event) => {
        if (event.type === "started") {
          runtimeAcceptedAtMs ??= Date.now();
        }
        if (event.type === "done") {
          doneEvent = event;
          return;
        }
        if (event.type === "delta") {
          runtimeFirstDeltaAtMs ??= Date.now();
          streamedOutput = event.replace ? event.text : `${streamedOutput}${event.text}`;
        }
        writeChatStreamEvent(res, event, isClosed);
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Chat request failed.";
    await store.updateChatMessage(session.id, assistantMessage.id, {
      content: message,
      status: "failed"
    });
    await store.updateChatSession(session.id, {
      status: attemptedNativeResume && isNativeResumeFailure(message) ? "native_missing" : "failed",
      nativeSessionState: attemptedNativeResume && isNativeResumeFailure(message) ? "missing" : session.nativeSessionState
    });
    writeChatStreamEvent(res, { type: "error", message }, isClosed);
    res.end();
    return;
  }

  const runtimeFinishedAtMs = Date.now();
  const postprocessStartedAtMs = Date.now();
  if (!doneEvent) {
    const message = "Chat request completed without a final runtime event.";
    await store.updateChatMessage(session.id, assistantMessage.id, {
      content: streamedOutput || message,
      status: streamedOutput ? "sent" : "failed"
    });
    writeChatStreamEvent(res, { type: "error", message }, isClosed);
    res.end();
    return;
  }

  const finalOutput = doneEvent.output ?? streamedOutput;
  const submissionBlock = extractChatInboxSubmissionBlock(finalOutput);
  let submission: ChatInboxSubmissionResult | undefined;
  let inboxSubmissionMs: number | undefined;
  let finalDoneEvent: ChatDoneEvent = doneEvent;
  let assistantOutput = finalOutput || doneEvent.error || "";

  if (doneEvent.status === "succeeded" && submissionBlock) {
    try {
      const submissionStartedAtMs = Date.now();
      submission = await materializeChatInboxSubmission(store, resolvedRequestBody, finalOutput, submissionBlock);
      inboxSubmissionMs = Date.now() - submissionStartedAtMs;
    } catch (submissionError) {
      const message = submissionError instanceof Error ? submissionError.message : "Invalid Hiveward inbox submission.";
      const failedOutput = buildChatInboxSubmissionFailureOutput(finalOutput, submissionBlock.fullMatch, message);
      writeChatStreamEvent(res, { type: "delta", text: failedOutput, replace: true }, isClosed);
      finalDoneEvent = {
        ...doneEvent,
        status: "failed",
        output: failedOutput,
        error: message
      };
      assistantOutput = failedOutput;
    }
  }

  if (submission) {
    assistantOutput = submission.output;
    writeChatStreamEvent(res, { type: "delta", text: submission.output, replace: true }, isClosed);
    writeChatStreamEvent(res, {
      type: "inbox_item_created",
      item: submission.item,
      message: `Created Hiveward inbox item ${submission.item.id}.`
    }, isClosed);
    finalDoneEvent = { ...doneEvent, output: submission.output };
  }

  const finalEventWithTimings = withChatStreamTimings(
    finalDoneEvent,
    requestStartedAtMs,
    runtimeStartedAtMs,
    runtimeFinishedAtMs,
    postprocessStartedAtMs,
    inboxSubmissionMs,
    runtimeAcceptedAtMs,
    runtimeFirstDeltaAtMs
  );
  const runtimeRef = toChatRuntimeRef(finalEventWithTimings);
  const nativeMissing = attemptedNativeResume && finalEventWithTimings.status === "failed" && isNativeResumeFailure(finalEventWithTimings.error);
  await store.updateChatMessage(session.id, assistantMessage.id, {
    content: assistantOutput,
    status: finalEventWithTimings.status === "failed" || finalEventWithTimings.status === "cancelled" ? "failed" : "sent",
    runtimeRef,
    modelId: requestBody.modelId
  });
  const sessionPatch: UpdateHivewardChatSessionRequest = {
    status: nativeMissing ? "native_missing" : "active",
    nativeSessionState: nativeMissing ? "missing" : finalEventWithTimings.sessionKey ? "resumable" : session.nativeSessionState
  };
  if (finalEventWithTimings.sessionKey) {
    sessionPatch.nativeSessionId = finalEventWithTimings.sessionKey;
  }
  await store.updateChatSession(session.id, sessionPatch);
  writeChatStreamEvent(res, finalEventWithTimings, isClosed);
  res.end();
}

function buildChatPrompt(
  input: ResolvedChatSessionMessage,
  roleSkillPrompt?: string,
  rebuildContext?: string,
  selectedBlueprintContext?: string
): string {
  const contextBlocks = [
    input.includePlatformContext ? hivewardPlatformContext : undefined,
    roleSkillPrompt,
    rebuildContext,
    selectedBlueprintContext,
    input.mode === "blueprint"
      ? buildBlueprintDraftingContext(input.message)
      : input.mode === "skill_split"
        ? buildSkillSplitContext(input.message)
        : undefined
  ].filter((block): block is string => Boolean(block));
  if (!contextBlocks.length) return input.message.trim();
  return [...contextBlocks, "", "User message:", input.message.trim()].join("\n");
}

async function buildSelectedBlueprintDraftingContext(
  store: HivewardStore,
  roleScope: ChatRoleScope | undefined
): Promise<string | undefined> {
  if (!roleScope?.blueprintId) return undefined;
  const blueprint = await store.getBlueprint(roleScope.blueprintId);
  if (!blueprint) {
    return [
      "Selected blueprint target:",
      `- blueprintId: ${roleScope.blueprintId}`,
      "- The user selected this blueprint, but HiveWard could not load it. Ask the user to choose another blueprint before submitting a proposal."
    ].join("\n");
  }
  const portableBlueprint = {
    id: blueprint.id,
    name: blueprint.name,
    description: blueprint.description,
    version: blueprint.version,
    nodes: blueprint.nodes,
    edges: blueprint.edges,
    variables: blueprint.variables,
    display: blueprint.display
  };
  return [
    "Selected blueprint target:",
    `- blueprintId: ${blueprint.id}`,
    `- name: ${blueprint.name}`,
    "- Modify this selected blueprint instead of creating an unrelated new blueprint.",
    "- When submitting a hiveward-inbox blueprint_proposal, set blueprintId to this blueprint id.",
    "- The blueprintPackage should contain one complete replacement definition for the selected blueprint, including nodes, edges, variables, and display.",
    "Current selected blueprint JSON:",
    "```json",
    JSON.stringify(portableBlueprint, null, 2),
    "```"
  ].join("\n");
}

async function syncChatHistoryInboxSubmissions(
  store: HivewardStore,
  messages: ChatHistoryMessage[]
): Promise<{ messages: ChatHistoryMessage[]; inboxItems: InboxItem[] }> {
  let knownInboxItems: InboxItem[] | undefined;
  const syncedItems = new Map<string, InboxItem>();
  const syncedMessages: ChatHistoryMessage[] = [];

  for (const message of messages) {
    if (message.role !== "assistant") {
      syncedMessages.push(message);
      continue;
    }

    const block = extractChatInboxSubmissionBlock(message.content);
    if (!block) {
      syncedMessages.push(message);
      continue;
    }

    try {
      const parsed = parseChatInboxSubmissionBlock(block);
      knownInboxItems ??= await store.listInboxItems();
      const existing = findExistingChatInboxSubmission(knownInboxItems, parsed);
      if (existing) {
        syncedItems.set(existing.id, existing);
        const output = buildChatInboxSubmissionSuccessOutput(stripChatInboxSubmissionBlock(message.content, block.fullMatch), existing);
        syncedMessages.push({ ...message, content: output });
        continue;
      }

      const submission = await materializeChatInboxSubmission(
        store,
        buildHistoryInboxChatRequest(parsed),
        message.content,
        block
      );
      if (submission) {
        knownInboxItems = [submission.item, ...knownInboxItems];
        syncedItems.set(submission.item.id, submission.item);
        syncedMessages.push({ ...message, content: submission.output });
        continue;
      }

      syncedMessages.push(message);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Invalid Hiveward inbox submission.";
      syncedMessages.push({
        ...message,
        content: buildChatInboxSubmissionFailureOutput(message.content, block.fullMatch, errorMessage)
      });
    }
  }

  return {
    messages: syncedMessages,
    inboxItems: [...syncedItems.values()]
  };
}

function buildHistoryInboxChatRequest(parsed: Record<string, unknown>): ResolvedChatSessionMessage {
  const type = readOptionalString(parsed.type);
  const leaderId = readOptionalString(parsed.leaderId) ?? readOptionalString(parsed.targetRoleId);
  const blueprintId = readOptionalString(parsed.blueprintId);
  return {
    harnessId: "openclaw",
    message: "",
    attachments: [],
    includePlatformContext: false,
    mode: "blueprint",
    roleScope: {
      role: type === "leader_delegation" ? "ceo" : "leader",
      leaderId,
      blueprintId
    }
  };
}

function findExistingChatInboxSubmission(items: InboxItem[], parsed: Record<string, unknown>): InboxItem | undefined {
  const type = readOptionalString(parsed.type);
  if (type !== "leader_delegation" && type !== "blueprint_proposal") return undefined;

  const title = readOptionalString(parsed.title);
  const blueprintId = readOptionalString(parsed.blueprintId);
  const leaderId = readOptionalString(parsed.leaderId);
  const firstBlueprintId = readBlueprintPackageFirstBlueprintId(parsed.blueprintPackage);
  const diffSummary = readOptionalString(parsed.diffSummary);

  return items.find((item) => {
    if (item.type !== type) return false;
    if (title && item.title !== title) return false;
    if (blueprintId && item.blueprintId && item.blueprintId !== blueprintId) return false;

    if (type === "leader_delegation") {
      return !leaderId || readPayloadString(item.payload, "leaderId") === leaderId;
    }

    const itemFirstBlueprintId = readBlueprintPackageFirstBlueprintId(item.payload?.blueprintPackage);
    if (firstBlueprintId) return itemFirstBlueprintId === firstBlueprintId;
    if (diffSummary) return readPayloadString(item.payload, "diffSummary") === diffSummary;
    return Boolean(title || blueprintId);
  });
}

function readPayloadString(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  return isPlainRecord(payload) ? readOptionalString(payload[key]) : undefined;
}

function readBlueprintPackageFirstBlueprintId(value: unknown): string | undefined {
  if (!isPlainRecord(value) || !Array.isArray(value.blueprints)) return undefined;
  const firstBlueprint = value.blueprints[0];
  return isPlainRecord(firstBlueprint) ? readOptionalString(firstBlueprint.id) : undefined;
}

async function materializeChatInboxSubmission(
  store: HivewardStore,
  chatRequest: ResolvedChatSessionMessage,
  output: string,
  block = extractChatInboxSubmissionBlock(output)
): Promise<ChatInboxSubmissionResult | undefined> {
  if (!block) return undefined;
  const parsed = parseChatInboxSubmissionBlock(block);

  const type = readOptionalString(parsed.type);
  const createdByRoleId =
    readOptionalString(parsed.createdByRoleId) ??
    chatRequest.roleScope?.leaderId ??
    (chatRequest.roleScope?.role === "ceo" ? "ceo" : undefined);
  const blueprintId = readOptionalString(parsed.blueprintId) ?? chatRequest.roleScope?.blueprintId;
  const outputWithoutBlock = stripChatInboxSubmissionBlock(output, block.fullMatch);

  if (type === "leader_delegation") {
    const item = await store.createLeaderDelegationRequest(normalizeCreateLeaderDelegationRequest({
      ...parsed,
      blueprintId,
      createdByRoleId
    }));
    return { item, output: buildChatInboxSubmissionSuccessOutput(outputWithoutBlock, item) };
  }

  if (type === "blueprint_proposal") {
    const item = await store.createBlueprintProposal(normalizeCreateBlueprintProposalRequest({
      ...parsed,
      blueprintId,
      createdByRoleId,
      targetRoleId: readOptionalString(parsed.targetRoleId) ?? chatRequest.roleScope?.leaderId,
      runtimeId: readOptionalAgentRuntimeId(parsed.runtimeId) ?? runtimeIdForChatHarness(chatRequest.harnessId)
    }));
    return { item, output: buildChatInboxSubmissionSuccessOutput(outputWithoutBlock, item) };
  }

  throw new Error("Hiveward inbox submission type must be leader_delegation or blueprint_proposal.");
}

function buildChatInboxSubmissionSuccessOutput(outputWithoutBlock: string, item: InboxItem): string {
  const visibleOutput = outputWithoutBlock.trim() || `已提交「${item.title}」到收件箱。`;
  const approvalHint = "已提交到收件箱，请前往收件箱审批。";
  if (visibleOutput.includes(approvalHint)) return visibleOutput;
  return [visibleOutput, "", approvalHint].join("\n").trim();
}

function parseChatInboxSubmissionBlock(block: ChatInboxSubmissionBlock): Record<string, unknown> {
  const parsed = parseChatInboxSubmissionJson(block.json);
  if (!isPlainRecord(parsed)) {
    throw new Error("Hiveward inbox submission block must contain a JSON object.");
  }
  validateChatInboxSubmissionSchema(parsed);
  return parsed;
}

function validateChatInboxSubmissionSchema(parsed: Record<string, unknown>): void {
  const schema = readOptionalString(parsed.schema);
  if (schema && schema !== hivewardInboxSubmissionSchema) {
    throw new Error(`Unsupported Hiveward inbox submission schema: ${schema}. Expected ${hivewardInboxSubmissionSchema}.`);
  }
}

function parseChatInboxSubmissionJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    const repaired = repairExtraJsonObjectClosers(value);
    if (repaired !== value) {
      try {
        return JSON.parse(repaired) as unknown;
      } catch {
        // Keep the original parser error because its location matches the model output.
      }
    }
    throw error;
  }
}

function repairExtraJsonObjectClosers(value: string): string {
  const stack: string[] = [];
  let repaired = "";
  let inString = false;
  let escaped = false;

  for (const char of value) {
    repaired += char;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      stack.push("{");
      continue;
    }
    if (char === "[") {
      stack.push("[");
      continue;
    }
    if (char === "}") {
      if (stack.at(-1) === "{") {
        stack.pop();
        continue;
      }
      repaired = repaired.slice(0, -1);
      continue;
    }
    if (char === "]") {
      if (stack.at(-1) === "[") stack.pop();
    }
  }

  return repaired;
}

function extractChatInboxSubmissionBlock(output: string): ChatInboxSubmissionBlock | undefined {
  const matches = [
    /```hiveward-inbox\s*([\s\S]*?)```/i.exec(output),
    /(?:^|\n)\s*(?:#{1,6}\s*)?hiveward-inbox\s*\n```(?:json)?\s*([\s\S]*?)```/i.exec(output),
    /(?:^|\n)\s*(?:#{1,6}\s*)?hiveward-inbox\s*\n(\{[\s\S]*\})\s*$/i.exec(output)
  ];
  const match = matches.find(Boolean);
  if (!match) return undefined;
  return {
    fullMatch: match[0],
    json: normalizeChatInboxSubmissionJson(match[1] ?? "")
  };
}

function normalizeChatInboxSubmissionJson(value: string): string {
  return value
    .trim()
    .replace(/^json\s*\n/i, "")
    .trim();
}

function stripChatInboxSubmissionBlock(output: string, block: string): string {
  return output
    .replace(block, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildChatInboxSubmissionFailureOutput(output: string, block: string, errorMessage: string): string {
  const visibleOutput = stripChatInboxSubmissionBlock(output, block);
  return [
    visibleOutput || "Hiveward inbox submission failed.",
    "",
    `Inbox submission failed: ${errorMessage}`
  ].join("\n").trim();
}

const hivewardPlatformContext = [
  "System context:",
  "HiveWard is a local company operations console for building business workflows, company structure, blueprints, task cards, notes, runtime status views, and local UI metadata.",
  "In Chat, HiveWard is only the user interface and dispatch channel. The selected harness owns runtime execution, agents, tools, skills, sessions, transcripts, reasoning, and usage facts.",
  "Use harness-native tools and skills when they are available. If the user asks to create or change HiveWard blueprints, workflows, company structure, or visual assets, help turn the request into concrete platform actions and use real runtime tools/APIs when required.",
  "Do not claim stored HiveWard data, blueprints, files, or external deliveries changed unless an actual tool or API performed that change."
].join("\n");

const hivewardBlueprintDraftingGuidance = [
  "Blueprint drafting mode:",
  "When the user asks for a blueprint change, first align on direction in chat. For final approval, produce a concrete importable content package with proposal text, JSON or patch details, preview, and diff summary.",
  "Do not describe a natural-language idea as approved or imported until the Hiveward inbox item has been approved and the backend import completed."
].join("\n");

const hivewardBlueprintSubmissionContext = [
  hivewardBlueprintDraftingGuidance,
  "If the user explicitly asks to submit the proposal for approval, end the response with one hiveward-inbox fenced block so Hiveward can create the real inbox item.",
  "",
  hivewardInboxSubmissionContract
].join("\n");

const hivewardSkillSplitGuidance = [
  "Skill split mode:",
  "You are the HiveWard CEO chat role helping the user turn one skill material into a new multi-agent HiveWard business blueprint proposal.",
  "The skill material is conversation input only. Do not save it as a HiveWard skill, do not create a skill library entry, and do not claim it was imported.",
  "Ask the user for skill material when it is missing. Accept pasted SKILL.md text, uploaded files, local file paths, downloadable URLs, GitHub file URLs, or GitHub repository URLs.",
  "Do not claim you have read a path, URL, or repository unless the selected harness actually loaded it through available tools or the user pasted or uploaded the content.",
  "If the material cannot be accessed, ask the user to paste or upload the skill content.",
  "Use the installed hiveward-skill-decomposer skill when available. If it is not loadable, follow the compact fallback invariants in this prompt.",
  "The decomposer invariant is: skill package structure is evidence, Skill IR is the contract, and blueprint proposal is the governed output.",
  "Treat a skill as a package, not only SKILL.md. Accept Markdown-only skills as complete only when the user identifies the Markdown as the whole skill.",
  "Build Skill IR before mapping to blueprint nodes. The IR must capture source completeness, package inventory, classification, phases, scripts, assets, risks, validation, unresolved items, difficulty, model profile, and parallelism hints.",
  "Inspect scripts statically as controlled assets. Do not execute scripts by default, and do not claim scripts are embedded in JSON-only blueprint packages.",
  "Use node economy: split only on real work boundaries such as independent I/O contracts, different tools or permissions, validation checkpoints, safe parallelism, retry/failure branches, script side effects, or decision points.",
  "Record desired per-phase thinking effort in Skill IR and proposal notes, but do not claim current blueprint runtime enforces per-node thinking effort.",
  "Default to creating a new business blueprint. Modify an existing blueprint only when the user explicitly asks for that target and provides enough context.",
  "Do not place the CEO role inside the generated runtime blueprint. CEO is the chat designer, not a workflow node.",
  "Use only existing HiveWard blueprint node types: manager, manager_slot, agent, summary, condition, note, and group.",
  "Use manager and manager_slot for runtime coordination, agent nodes for concrete worker responsibilities, summary nodes for aggregation, and condition nodes for explicit branching.",
  "Do not use removed or invented node types such as approval, send, parallel_agents, fetch, parse, http.get, file.write, or save.",
  "Parallel work must use manager_slot.config.parallelLaneCount. Human approval and sending must remain agent config options.",
  "A usable decomposition response must identify source completeness, list inspected package parts, include a Skill IR summary, explain classification confidence, list unresolved assumptions, and include blueprint exposure metadata for future CEO catalog matching.",
  "For script-backed skills, the proposal states where required scripts live, whether those paths will exist after import, required permissions, side effects, validation commands, and any approval requirement.",
  "Before formal submission, explain the skill purpose, inferred inputs and outputs, proposed agents, manager-slot structure, validation checkpoints, and unresolved questions.",
  "If the user asks to submit for approval before enough skill material exists, ask for the missing material instead of fabricating a blueprint package."
].join("\n");

const hivewardSkillSplitSubmissionContext = [
  hivewardSkillSplitGuidance,
  "If the user explicitly asks to submit the generated blueprint for approval, end the response with one hiveward-inbox fenced block so Hiveward can create the real inbox item.",
  "",
  hivewardInboxSubmissionContract
].join("\n");

function buildBlueprintDraftingContext(message: string): string {
  return shouldIncludeBlueprintSubmissionContract(message)
    ? hivewardBlueprintSubmissionContext
    : hivewardBlueprintDraftingGuidance;
}

function buildSkillSplitContext(message: string): string {
  return shouldIncludeBlueprintSubmissionContract(message)
    ? hivewardSkillSplitSubmissionContext
    : hivewardSkillSplitGuidance;
}

function shouldIncludeBlueprintSubmissionContract(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("submit") ||
    normalized.includes("approval") ||
    normalized.includes("approve") ||
    normalized.includes("inbox") ||
    normalized.includes("proposal") ||
    normalized.includes("import") ||
    message.includes("提交") ||
    message.includes("审批") ||
    message.includes("批准") ||
    message.includes("收件箱") ||
    message.includes("提案") ||
    message.includes("导入")
  );
}

function writeChatStreamEvent(
  res: Response,
  event: ChatStreamEvent,
  isClosed: () => boolean
): boolean {
  if (isClosed()) return false;
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
  return !isClosed();
}

function withChatStreamTimings<T extends ChatDoneEvent>(
  event: T,
  requestStartedAtMs: number,
  runtimeStartedAtMs: number,
  runtimeFinishedAtMs: number,
  postprocessStartedAtMs: number,
  inboxSubmissionMs: number | undefined,
  runtimeAcceptedAtMs: number | undefined,
  runtimeFirstDeltaAtMs: number | undefined
): T {
  const completedAtMs = Date.now();
  return {
    ...event,
    timings: {
      totalMs: Math.max(0, completedAtMs - requestStartedAtMs),
      hivewardPreprocessMs: Math.max(0, runtimeStartedAtMs - requestStartedAtMs),
      runtimeMs: Math.max(0, runtimeFinishedAtMs - runtimeStartedAtMs),
      hivewardPostprocessMs: Math.max(0, completedAtMs - postprocessStartedAtMs),
      inboxSubmissionMs,
      runtimeAcceptedMs: runtimeAcceptedAtMs === undefined ? undefined : Math.max(0, runtimeAcceptedAtMs - runtimeStartedAtMs),
      runtimeFirstDeltaMs: runtimeFirstDeltaAtMs === undefined ? undefined : Math.max(0, runtimeFirstDeltaAtMs - runtimeStartedAtMs)
    }
  };
}

function toChatRuntimeRef(event: ChatDoneEvent): ChatRuntimeRef {
  return {
    taskId: event.taskId,
    runId: event.runId,
    sessionKey: event.sessionKey,
    source: event.source,
    status: event.status,
    updatedAt: event.updatedAt,
    error: event.error,
    usage: event.usage,
    timings: event.timings
  };
}

function buildHivewardHistoryContext(messages: HivewardChatMessage[]): string {
  const maxMessages = 40;
  const maxChars = 24_000;
  const visibleMessages = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-maxMessages)
    .map((message) => `${message.role}: ${message.content.trim() || "[empty message]"}`);
  let history = visibleMessages.join("\n\n");
  if (history.length > maxChars) {
    history = history.slice(history.length - maxChars);
  }
  return [
    "HiveWard visible conversation history:",
    history || "[no prior visible messages]",
    "",
    "The native provider session was not recoverable. Use this explicit HiveWard transcript only as user-visible context; do not describe this as native recovery."
  ].join("\n");
}

function isNativeResumeFailure(message: string | undefined): boolean {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return (
    /(resume|resum|session|thread).*(missing|not found|invalid|expired|deleted|unavailable|cannot|could not|failed)/.test(normalized) ||
    /(missing|not found|invalid|expired|deleted).*(session|thread)/.test(normalized) ||
    normalized.includes("no conversation found")
  );
}

function sourceForChatHarness(harnessId: HarnessId): RuntimeObjectSource {
  if (harnessId === "claudeCode") return "claude";
  return harnessId;
}

function runtimeIdForChatHarness(harnessId: HarnessId): AgentRuntimeId {
  if (harnessId === "claudeCode") return "claude";
  return harnessId;
}

function roleSkillIdForRole(role: ChatRoleScope["role"]): HarnessSkillId {
  return role === "leader" ? "hiveward-leader" : "hiveward-ceo";
}

async function chatSkillIdsForRequest(
  harnessId: HarnessId,
  roleScope: ChatRoleScope | undefined,
  mode: ChatMode | undefined,
  openClawConfigStore: OpenClawConfigStore
): Promise<HarnessSkillId[] | undefined> {
  const skillIds: HarnessSkillId[] = [];
  if (roleScope) {
    skillIds.push(roleSkillIdForRole(roleScope.role));
  }
  if (mode === "skill_split") {
    skillIds.push("hiveward-skill-decomposer");
  }
  if (!skillIds.length) return undefined;

  const config = await openClawConfigStore.getState();
  const installRoot = resolveHarnessSkillInstallTarget(harnessId, config).root;
  const installedSkillIds = skillIds.filter((skillId) => fileExists(join(installRoot, skillId, "SKILL.md")));
  return installedSkillIds.length ? installedSkillIds : undefined;
}

function resolveChatModelId(
  body: ResolvedChatSessionMessage,
  config: OpenClawConfigState,
  defaults: RunModelDefaults
): string | undefined {
  if (body.harnessId === "openclaw") {
    return body.modelId;
  }

  const requestedModel = body.modelId === config.defaultModelId ? undefined : body.modelId;
  const modelId = requestedModel ?? defaultModelForChatHarness(body.harnessId, defaults);
  if (modelId === "inherit") {
    return undefined;
  }
  return modelId;
}

function defaultModelForChatHarness(harnessId: HarnessId, defaults: RunModelDefaults): string | undefined {
  if (harnessId === "codex") return defaults.codex;
  if (harnessId === "claudeCode") return defaults.claude;
  if (harnessId === "google") return defaults.google;
  if (harnessId === "cursor") return defaults.cursor;
  if (harnessId === "opencode") return defaults.opencode;
  if (harnessId === "hermes") return defaults.hermes;
  return defaults.openclaw;
}

function readHarnessId(value: string | undefined): HarnessId {
  if (value === "openclaw" || value === "claudeCode" || value === "codex" || value === "google" || value === "cursor" || value === "opencode" || value === "hermes") return value;
  throw new Error(`Unsupported harness id: ${value ?? ""}`);
}

function readOptionalAgentRuntimeId(value: unknown): AgentRuntimeId | undefined {
  return value === "openclaw" || value === "codex" || value === "claude" || value === "google" || value === "cursor" || value === "opencode" || value === "hermes"
    ? value
    : undefined;
}

async function buildHarnessSkillStatusResponse(
  harnessId: HarnessId,
  openClawConfigStore: OpenClawConfigStore
): Promise<HarnessSkillStatusResponse> {
  const checkedAt = new Date().toISOString();
  const config = await openClawConfigStore.getState();
  const installTarget = resolveHarnessSkillInstallTarget(harnessId, config);
  const installRoot = installTarget.root;
  const skills = await Promise.all(hivewardHarnessSkills.map((skill) => buildHarnessSkillStatusItem(skill, installRoot)));
  return {
    harnessId,
    supported: true,
    checkedAt,
    installRoot,
    installCandidates: installTarget.candidates,
    skills
  };
}

async function installHarnessSkills(
  harnessId: HarnessId,
  openClawConfigStore: OpenClawConfigStore
): Promise<InstallHarnessSkillsResponse> {
  const config = await openClawConfigStore.getState();
  const installRoot = resolveHarnessSkillInstallTarget(harnessId, config).root;
  await mkdir(installRoot, { recursive: true });

  let installedCount = 0;
  for (const skill of hivewardHarnessSkills) {
    const targetDir = join(installRoot, skill.id);
    await rm(targetDir, { recursive: true, force: true });
    await cp(skill.sourceDir, targetDir, { recursive: true });
    installedCount += 1;
  }

  return {
    ...(await buildHarnessSkillStatusResponse(harnessId, openClawConfigStore)),
    installedCount
  };
}

function resolveHarnessSkillInstallTarget(harnessId: HarnessId, config: OpenClawConfigState): HarnessSkillInstallTarget {
  const candidates = buildHarnessSkillInstallCandidates(harnessId, config);
  const selected = selectHarnessSkillInstallCandidate(candidates);
  const selectedRootKey = normalizePathKey(selected.root);
  return {
    root: selected.root,
    candidates: candidates.map((candidate) => ({
      ...candidate,
      selected: normalizePathKey(candidate.root) === selectedRootKey
    }))
  };
}

function buildHarnessSkillInstallCandidates(
  harnessId: HarnessId,
  config: OpenClawConfigState
): HarnessSkillInstallCandidate[] {
  const candidates: HarnessSkillInstallCandidate[] = [];
  const home = homedir();

  if (harnessId === "codex") {
    addEnvHomeSkillCandidate(candidates, "CODEX_HOME", "Codex CODEX_HOME skills");
    addPersonalSkillCandidate(candidates, join(home, ".codex", "skills"), "Codex personal skills");
    addProjectSkillCandidate(candidates, join(repositoryRoot, ".codex", "skills"), "Codex project skills");
    return candidates;
  }

  if (harnessId === "claudeCode") {
    addEnvHomeSkillCandidate(candidates, "CLAUDE_CONFIG_DIR", "Claude Code CLAUDE_CONFIG_DIR skills");
    addPersonalSkillCandidate(candidates, join(home, ".claude", "skills"), "Claude Code personal skills");
    addProjectSkillCandidate(candidates, join(repositoryRoot, ".claude", "skills"), "Claude Code project skills");
    return candidates;
  }

  if (harnessId === "google") {
    addEnvHomeSkillCandidate(candidates, "GEMINI_HOME", "Google CLI GEMINI_HOME skills");
    addPersonalSkillCandidate(candidates, join(home, ".gemini", "skills"), "Google CLI personal skills");
    addProjectSkillCandidate(candidates, join(repositoryRoot, ".gemini", "skills"), "Google CLI project skills");
    return candidates;
  }

  if (harnessId === "cursor") {
    addEnvHomeSkillCandidate(candidates, "CURSOR_HOME", "Cursor CURSOR_HOME skills");
    addPersonalSkillCandidate(candidates, join(home, ".cursor", "skills"), "Cursor personal skills");
    addProjectSkillCandidate(candidates, join(repositoryRoot, ".cursor", "skills"), "Cursor project skills");
    return candidates;
  }

  if (harnessId === "opencode") {
    addEnvHomeSkillCandidate(candidates, "OPENCODE_HOME", "OpenCode OPENCODE_HOME skills");
    addPersonalSkillCandidate(candidates, join(home, ".opencode", "skills"), "OpenCode personal skills");
    addPersonalSkillCandidate(candidates, join(home, ".config", "opencode", "skills"), "OpenCode config skills");
    addProjectSkillCandidate(candidates, join(repositoryRoot, ".opencode", "skills"), "OpenCode project skills");
    return candidates;
  }

  if (harnessId === "hermes") {
    addEnvHomeSkillCandidate(candidates, "HERMES_HOME", "Hermes HERMES_HOME skills");
    addEnvHomeSkillCandidate(candidates, "HERMES_CONFIG_DIR", "Hermes HERMES_CONFIG_DIR skills");
    addPersonalSkillCandidate(candidates, join(home, ".hermes", "skills"), "Hermes personal skills");
    addProjectSkillCandidate(candidates, join(repositoryRoot, ".hermes", "skills"), "Hermes project skills");
    return candidates;
  }

  addEnvHomeSkillCandidate(candidates, "OPENCLAW_STATE_DIR", "OpenClaw OPENCLAW_STATE_DIR skills");
  addEnvHomeSkillCandidate(candidates, "OPENCLAW_HOME", "OpenClaw OPENCLAW_HOME skills");
  addConfigSiblingSkillCandidate(candidates, config.configPath, "OpenClaw config-adjacent skills");
  addPersonalSkillCandidate(candidates, join(home, ".openclaw", "skills"), "OpenClaw personal skills");
  addProjectSkillCandidate(candidates, join(repositoryRoot, ".openclaw", "skills"), "OpenClaw project skills");
  return candidates;
}

function addEnvHomeSkillCandidate(
  candidates: HarnessSkillInstallCandidate[],
  envName: string,
  label: string
): void {
  const envHome = readEnvString(process.env, envName);
  if (!envHome) return;
  addHarnessSkillInstallCandidate(candidates, {
    root: join(expandHomePath(envHome), "skills"),
    source: "environment",
    label
  });
}

function addPersonalSkillCandidate(
  candidates: HarnessSkillInstallCandidate[],
  root: string,
  label: string
): void {
  const normalizedRoot = resolve(root);
  const hasHiveWardSkills = hasHiveWardSkillInstall(normalizedRoot);
  addHarnessSkillInstallCandidate(candidates, {
    root: normalizedRoot,
    source: hasHiveWardSkills ? "existing_install" : fileExists(normalizedRoot) ? "existing_root" : "default",
    label
  });
}

function addProjectSkillCandidate(
  candidates: HarnessSkillInstallCandidate[],
  root: string,
  label: string
): void {
  addHarnessSkillInstallCandidate(candidates, {
    root,
    source: "project",
    label
  });
}

function addConfigSiblingSkillCandidate(
  candidates: HarnessSkillInstallCandidate[],
  configPath: string | undefined,
  label: string
): void {
  if (!configPath) return;
  const resolvedConfigPath = resolve(expandHomePath(configPath));
  if (!fileExists(resolvedConfigPath) && !fileExists(dirname(resolvedConfigPath))) return;
  addHarnessSkillInstallCandidate(candidates, {
    root: join(dirname(resolvedConfigPath), "skills"),
    source: "existing_root",
    label
  });
}

function addHarnessSkillInstallCandidate(
  candidates: HarnessSkillInstallCandidate[],
  input: HarnessSkillInstallCandidateInput
): void {
  const root = resolve(input.root);
  const rootKey = normalizePathKey(root);
  if (candidates.some((candidate) => normalizePathKey(candidate.root) === rootKey)) return;
  candidates.push({
    root,
    source: input.source,
    label: input.label,
    exists: fileExists(root),
    hasHiveWardSkills: hasHiveWardSkillInstall(root),
    selected: false
  });
}

function selectHarnessSkillInstallCandidate(
  candidates: HarnessSkillInstallCandidate[]
): HarnessSkillInstallCandidate {
  return (
    candidates.find((candidate) => candidate.source === "environment") ??
    candidates.find((candidate) => candidate.source !== "project" && candidate.hasHiveWardSkills) ??
    candidates.find((candidate) => candidate.source !== "project" && candidate.exists) ??
    candidates.find((candidate) => candidate.source === "default") ??
    candidates[0] ??
    {
      root: join(homedir(), ".openclaw", "skills"),
      source: "default",
      label: "Default personal skills",
      exists: false,
      hasHiveWardSkills: false,
      selected: false
    }
  );
}

function hasHiveWardSkillInstall(root: string): boolean {
  return hivewardHarnessSkills.some((skill) => fileExists(join(root, skill.id, "SKILL.md")));
}

function expandHomePath(value: string): string {
  if (value === "~") return homedir();
  return value.startsWith("~/") || value.startsWith("~\\") ? join(homedir(), value.slice(2)) : value;
}

function normalizePathKey(path: string): string {
  return process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
}

async function buildHarnessSkillStatusItem(
  skill: (typeof hivewardHarnessSkills)[number],
  installRoot: string
): Promise<HarnessSkillStatusItem> {
  const sourcePath = join(skill.sourceDir, "SKILL.md");
  const targetDir = join(installRoot, skill.id);
  const targetPath = join(targetDir, "SKILL.md");

  let sourceHash: string;
  try {
    sourceHash = await hashDirectory(skill.sourceDir);
  } catch (error) {
    return {
      id: skill.id,
      label: skill.label,
      sourcePath,
      targetPath,
      installed: false,
      status: "error",
      error: error instanceof Error ? error.message : String(error)
    };
  }

  try {
    const installedHash = await hashDirectory(targetDir);
    const installed = installedHash === sourceHash;
    return {
      id: skill.id,
      label: skill.label,
      sourcePath,
      targetPath,
      installed,
      status: installed ? "installed" : "stale",
      sourceHash,
      installedHash
    };
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return {
        id: skill.id,
        label: skill.label,
        sourcePath,
        targetPath,
        installed: false,
        status: "missing",
        sourceHash
      };
    }
    return {
      id: skill.id,
      label: skill.label,
      sourcePath,
      targetPath,
      installed: false,
      status: "error",
      sourceHash,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function hashDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  await appendDirectoryHash(hash, root, "");
  return hash.digest("hex");
}

async function appendDirectoryHash(hash: ReturnType<typeof createHash>, root: string, relativePath: string): Promise<void> {
  const directory = relativePath ? join(root, relativePath) : root;
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    const childPath = join(root, childRelativePath);
    if (entry.isDirectory()) {
      hash.update(`dir:${childRelativePath}\0`);
      await appendDirectoryHash(hash, root, childRelativePath);
      continue;
    }
    if (entry.isFile()) {
      hash.update(`file:${childRelativePath}\0`);
      hash.update(await readFile(childPath));
      hash.update("\0");
    }
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

const claudeCodeModelFields: Array<[keyof UpdateClaudeCodeModelConfigRequest, string]> = [
  ["fallbackModelId", "ANTHROPIC_MODEL"],
  ["haikuModelId", "ANTHROPIC_DEFAULT_HAIKU_MODEL"],
  ["haikuModelName", "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME"],
  ["sonnetModelId", "ANTHROPIC_DEFAULT_SONNET_MODEL"],
  ["sonnetModelName", "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME"],
  ["opusModelId", "ANTHROPIC_DEFAULT_OPUS_MODEL"],
  ["opusModelName", "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME"]
];

const claudeCodePresetExtraEnvKeys = [
  "API_TIMEOUT_MS",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
  "CLAUDE_CODE_USE_BEDROCK"
] as const;

const claudeCodeAuthEnvKeys = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

class ClaudeCodeModelConfigInputError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ClaudeCodeModelConfigInputError";
  }
}

type StoredClaudeCodeModelProfile = ClaudeCodeSavedModelProfile & {
  authValue?: string;
};

type ClaudeCodeModelProfileStore = {
  profiles: StoredClaudeCodeModelProfile[];
};

function readClaudeCodeModelConfigResponse(env: NodeJS.ProcessEnv = process.env): ClaudeCodeModelConfigResponse {
  return {
    config: readClaudeCodeModelConfig(env),
    presets: claudeCodeModelPresets,
    savedProfiles: listClaudeCodeSavedModelProfiles(env)
  };
}

function readClaudeCodeModelConfig(env: NodeJS.ProcessEnv = process.env): ClaudeCodeModelConfig {
  const configPath = resolveClaudeCodeSettingsPath(env);
  const settings = readJsonObjectFile(configPath);
  const modelEnv = isPlainRecord(settings.env) ? settings.env : {};
  const baseUrl = readOptionalString(modelEnv.ANTHROPIC_BASE_URL);
  const fallbackModelId = readOptionalString(modelEnv.ANTHROPIC_MODEL);
  const legacySmallModel = readOptionalString(modelEnv.ANTHROPIC_SMALL_FAST_MODEL);
  const resolvedConfig = {
    baseUrl,
    fallbackModelId,
    haikuModelId: readOptionalString(modelEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL) ?? legacySmallModel,
    haikuModelName: readOptionalString(modelEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME),
    sonnetModelId: readOptionalString(modelEnv.ANTHROPIC_DEFAULT_SONNET_MODEL),
    sonnetModelName: readOptionalString(modelEnv.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME),
    opusModelId: readOptionalString(modelEnv.ANTHROPIC_DEFAULT_OPUS_MODEL),
    opusModelName: readOptionalString(modelEnv.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME)
  };
  const matchedPreset = findMatchingClaudeCodePreset(resolvedConfig);
  const extraEnv = readClaudeCodePresetExtraEnv(modelEnv);
  const hasAuthConflict = hasConflictingClaudeCodeAuth(modelEnv, matchedPreset);

  return {
    configPath,
    providerPresetId: matchedPreset?.id,
    providerPresetName: matchedPreset?.name,
    authEnvKey: inferClaudeCodeAuthEnvKey(modelEnv, matchedPreset),
    authConfigured: hasClaudeCodeAuth(modelEnv, matchedPreset) && !hasAuthConflict,
    extraEnv: Object.keys(extraEnv).length ? extraEnv : undefined,
    ...resolvedConfig
  };
}

async function updateClaudeCodeModelConfig(
  input: UpdateClaudeCodeModelConfigRequest,
  env: NodeJS.ProcessEnv = process.env
): Promise<ClaudeCodeModelConfig> {
  const previousConfig = readClaudeCodeModelConfig(env);
  const previousAuthValue = readClaudeCodeModelAuthValue(previousConfig, env);
  const configPath = resolveClaudeCodeSettingsPath(env);
  const settings = readJsonObjectFile(configPath);
  const modelEnv = isPlainRecord(settings.env) ? { ...settings.env } : {};
  const currentPresetId = findMatchingClaudeCodePreset({
    baseUrl: readOptionalString(modelEnv.ANTHROPIC_BASE_URL),
    fallbackModelId: readOptionalString(modelEnv.ANTHROPIC_MODEL),
    haikuModelId: readOptionalString(modelEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL) ?? readOptionalString(modelEnv.ANTHROPIC_SMALL_FAST_MODEL),
    sonnetModelId: readOptionalString(modelEnv.ANTHROPIC_DEFAULT_SONNET_MODEL) ?? readOptionalString(modelEnv.ANTHROPIC_MODEL),
    opusModelId: readOptionalString(modelEnv.ANTHROPIC_DEFAULT_OPUS_MODEL) ?? readOptionalString(modelEnv.ANTHROPIC_MODEL)
  })?.id;
  const preset = input.presetId ? findClaudeCodeModelPreset(input.presetId) : undefined;
  if (input.presetId && !preset) {
    throw new ClaudeCodeModelConfigInputError("claude_code_unknown_preset", `Unknown Claude Code model preset: ${input.presetId}`);
  }

  if (preset) {
    writeOptionalEnvValue(modelEnv, "ANTHROPIC_BASE_URL", preset.baseUrl);
    writeOptionalEnvValue(modelEnv, "ANTHROPIC_MODEL", preset.fallbackModelId);
    writeOptionalEnvValue(modelEnv, "ANTHROPIC_DEFAULT_HAIKU_MODEL", preset.haikuModelId);
    writeOptionalEnvValue(modelEnv, "ANTHROPIC_DEFAULT_SONNET_MODEL", preset.sonnetModelId);
    writeOptionalEnvValue(modelEnv, "ANTHROPIC_DEFAULT_OPUS_MODEL", preset.opusModelId);
    for (const key of claudeCodePresetExtraEnvKeys) delete modelEnv[key];
    for (const [key, value] of Object.entries(preset.extraEnv ?? {})) writeOptionalEnvValue(modelEnv, key, value);
  }

  const requestedAuthEnvKey = preset?.authEnvKey ?? input.authEnvKey;
  const requestedAuthValue = readOptionalString(input.authValue);
  if (requestedAuthValue) {
    if (!requestedAuthEnvKey) {
      throw new ClaudeCodeModelConfigInputError("claude_code_auth_env_required", "Claude Code API key field is required.");
    }
    writeOptionalEnvValue(modelEnv, requestedAuthEnvKey, requestedAuthValue);
    clearOtherClaudeCodeAuthEnvKeys(modelEnv, requestedAuthEnvKey);
  }

  const hasAuthConflict = hasConflictingClaudeCodeAuth(modelEnv, preset);
  if (preset && !requestedAuthValue && (!hasClaudeCodeAuth(modelEnv, preset) || currentPresetId !== preset.id || hasAuthConflict)) {
    throw new ClaudeCodeModelConfigInputError(
      "claude_code_auth_required",
      `API key is required before applying the ${preset.name} Claude Code preset.`
    );
  }
  if (preset?.authEnvKey && readOptionalString(modelEnv[preset.authEnvKey])) {
    clearOtherClaudeCodeAuthEnvKeys(modelEnv, preset.authEnvKey);
  }

  if (Object.prototype.hasOwnProperty.call(input, "baseUrl")) {
    writeOptionalEnvValue(modelEnv, "ANTHROPIC_BASE_URL", input.baseUrl);
  }

  if (input.extraEnv) {
    for (const key of claudeCodePresetExtraEnvKeys) {
      if (!Object.prototype.hasOwnProperty.call(input.extraEnv, key)) continue;
      writeOptionalEnvValue(modelEnv, key, input.extraEnv[key]);
    }
  }

  for (const [field, envKey] of claudeCodeModelFields) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
    const value = input[field];
    if (preset && typeof value === "string" && !value.trim()) continue;
    writeOptionalEnvValue(modelEnv, envKey, value);
  }

  delete modelEnv.ANTHROPIC_SMALL_FAST_MODEL;
  settings.env = modelEnv;
  await writeJsonObjectFileAtomic(configPath, settings);
  await saveClaudeCodeModelProfileSnapshot(previousConfig, undefined, env, previousAuthValue);
  return readClaudeCodeModelConfig(env);
}

function listClaudeCodeSavedModelProfiles(env: NodeJS.ProcessEnv = process.env): ClaudeCodeSavedModelProfile[] {
  return readClaudeCodeModelProfileStore(env).profiles
    .map(({ authValue: _authValue, ...profile }) => ({
      ...profile,
      authConfigured: Boolean(profile.authConfigured || _authValue)
    }))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function saveCurrentClaudeCodeModelProfile(
  input: SaveClaudeCodeModelProfileRequest = {},
  env: NodeJS.ProcessEnv = process.env
): Promise<ClaudeCodeSavedModelProfile | undefined> {
  return saveClaudeCodeModelProfileSnapshot(readClaudeCodeModelConfig(env), input.name, env);
}

async function saveClaudeCodeModelProfileSnapshot(
  config: ClaudeCodeModelConfig,
  name: string | undefined,
  env: NodeJS.ProcessEnv,
  authValue = readClaudeCodeModelAuthValue(config, env)
): Promise<ClaudeCodeSavedModelProfile | undefined> {
  if (!hasMeaningfulClaudeCodeModelConfig(config)) return undefined;
  const store = readClaudeCodeModelProfileStore(env);
  const now = new Date().toISOString();
  const fingerprint = fingerprintClaudeCodeModelConfig(config);
  const existing = store.profiles.find((profile) => profile.id === fingerprint);
  const storedProfile: StoredClaudeCodeModelProfile = {
    id: fingerprint,
    name: readOptionalString(name) ?? existing?.name ?? defaultClaudeCodeModelProfileName(config),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    providerPresetId: config.providerPresetId,
    providerPresetName: config.providerPresetName,
    baseUrl: config.baseUrl,
    authEnvKey: config.authEnvKey,
    authConfigured: config.authConfigured,
    authValue: authValue ?? existing?.authValue,
    extraEnv: config.extraEnv,
    fallbackModelId: config.fallbackModelId,
    haikuModelId: config.haikuModelId,
    haikuModelName: config.haikuModelName,
    sonnetModelId: config.sonnetModelId,
    sonnetModelName: config.sonnetModelName,
    opusModelId: config.opusModelId,
    opusModelName: config.opusModelName
  };
  const nextProfiles = [storedProfile, ...store.profiles.filter((profile) => profile.id !== fingerprint)];
  await writeClaudeCodeModelProfileStore({ profiles: nextProfiles }, env);
  const { authValue: _authValue, ...publicProfile } = storedProfile;
  return { ...publicProfile, authConfigured: Boolean(publicProfile.authConfigured || _authValue) };
}

async function applyClaudeCodeSavedModelProfile(profileId: string, env: NodeJS.ProcessEnv = process.env): Promise<ClaudeCodeModelConfig> {
  const profile = readClaudeCodeModelProfileStore(env).profiles.find((item) => item.id === profileId);
  if (!profile) {
    throw new ClaudeCodeModelConfigInputError("claude_code_saved_profile_not_found", `Unknown Claude Code saved model profile: ${profileId}`);
  }
  return updateClaudeCodeModelConfig({
    presetId: profile.providerPresetId,
    baseUrl: profile.baseUrl,
    authEnvKey: profile.authEnvKey,
    authValue: profile.authValue,
    extraEnv: profile.extraEnv,
    fallbackModelId: profile.fallbackModelId,
    haikuModelId: profile.haikuModelId,
    haikuModelName: profile.haikuModelName,
    sonnetModelId: profile.sonnetModelId,
    sonnetModelName: profile.sonnetModelName,
    opusModelId: profile.opusModelId,
    opusModelName: profile.opusModelName
  }, env);
}

async function deleteClaudeCodeSavedModelProfile(profileId: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const store = readClaudeCodeModelProfileStore(env);
  const nextProfiles = store.profiles.filter((profile) => profile.id !== profileId);
  if (nextProfiles.length === store.profiles.length) return;
  await writeClaudeCodeModelProfileStore({ profiles: nextProfiles }, env);
}

function hasMeaningfulClaudeCodeModelConfig(config: ClaudeCodeModelConfig): boolean {
  return Boolean(config.providerPresetId || config.baseUrl || config.fallbackModelId || config.haikuModelId || config.sonnetModelId || config.opusModelId);
}

function fingerprintClaudeCodeModelConfig(config: ClaudeCodeModelConfig): string {
  const fingerprintInput = {
    providerPresetId: config.providerPresetId,
    baseUrl: config.baseUrl,
    fallbackModelId: config.fallbackModelId,
    haikuModelId: config.haikuModelId,
    sonnetModelId: config.sonnetModelId,
    opusModelId: config.opusModelId
  };
  return `ccm_${createHash("sha256").update(JSON.stringify(fingerprintInput)).digest("hex").slice(0, 16)}`;
}

function defaultClaudeCodeModelProfileName(config: ClaudeCodeModelConfig): string {
  return [config.providerPresetName, config.fallbackModelId].filter(Boolean).join(" / ") || config.baseUrl || config.fallbackModelId || "Claude Code";
}

function readClaudeCodeModelAuthValue(config: ClaudeCodeModelConfig, env: NodeJS.ProcessEnv): string | undefined {
  if (!config.authEnvKey || !config.authConfigured) return undefined;
  const settings = readJsonObjectFile(resolveClaudeCodeSettingsPath(env));
  const modelEnv = isPlainRecord(settings.env) ? settings.env : {};
  return readOptionalString(modelEnv[config.authEnvKey]);
}

function readClaudeCodeModelProfileStore(env: NodeJS.ProcessEnv): ClaudeCodeModelProfileStore {
  const storePath = resolveClaudeCodeModelProfileStorePath(env);
  if (!fileExists(storePath)) return { profiles: [] };
  const value = readJsonFile(storePath);
  if (!isPlainRecord(value) || !Array.isArray(value.profiles)) return { profiles: [] };
  return {
    profiles: value.profiles
      .filter(isStoredClaudeCodeModelProfile)
      .map((profile) => ({ ...profile }))
  };
}

async function writeClaudeCodeModelProfileStore(store: ClaudeCodeModelProfileStore, env: NodeJS.ProcessEnv): Promise<void> {
  await writeJsonObjectFileAtomic(resolveClaudeCodeModelProfileStorePath(env), store);
}

function resolveClaudeCodeModelProfileStorePath(env: NodeJS.ProcessEnv): string {
  return join(dirname(resolveClaudeCodeSettingsPath(env)), "hiveward-model-profiles.json");
}

function isStoredClaudeCodeModelProfile(value: unknown): value is StoredClaudeCodeModelProfile {
  if (!isPlainRecord(value)) return false;
  return Boolean(readOptionalString(value.id) && readOptionalString(value.name) && readOptionalString(value.createdAt) && readOptionalString(value.updatedAt));
}

function findClaudeCodeModelPreset(id: string): ClaudeCodeModelPreset | undefined {
  return claudeCodeModelPresets.find((preset) => preset.id === id);
}

function findMatchingClaudeCodePreset(config: Pick<ClaudeCodeModelConfig, "baseUrl" | "fallbackModelId" | "haikuModelId" | "sonnetModelId" | "opusModelId">): ClaudeCodeModelPreset | undefined {
  const exactMatch = claudeCodeModelPresets.find((preset) => {
    if (preset.baseUrl && preset.baseUrl !== config.baseUrl) return false;
    if (preset.fallbackModelId && preset.fallbackModelId !== config.fallbackModelId) return false;
    if (preset.haikuModelId && preset.haikuModelId !== config.haikuModelId) return false;
    if (preset.sonnetModelId && preset.sonnetModelId !== config.sonnetModelId) return false;
    if (preset.opusModelId && preset.opusModelId !== config.opusModelId) return false;
    return Boolean(preset.baseUrl || preset.fallbackModelId || preset.sonnetModelId);
  });
  if (exactMatch) return exactMatch;

  if (!config.baseUrl) return undefined;
  const baseUrlMatches = claudeCodeModelPresets.filter((preset) => preset.baseUrl === config.baseUrl);
  return baseUrlMatches.length === 1 ? baseUrlMatches[0] : undefined;
}

function inferClaudeCodeAuthEnvKey(modelEnv: Record<string, unknown>, preset?: ClaudeCodeModelPreset): ClaudeCodeModelConfig["authEnvKey"] {
  if (preset?.authEnvKey && readOptionalString(modelEnv[preset.authEnvKey])) return preset.authEnvKey;
  if (readOptionalString(modelEnv.ANTHROPIC_API_KEY)) return "ANTHROPIC_API_KEY";
  if (readOptionalString(modelEnv.ANTHROPIC_AUTH_TOKEN)) return "ANTHROPIC_AUTH_TOKEN";
  return preset?.authEnvKey;
}

function hasClaudeCodeAuth(modelEnv: Record<string, unknown>, preset?: ClaudeCodeModelPreset): boolean {
  if (preset?.authEnvKey) return Boolean(readOptionalString(modelEnv[preset.authEnvKey]));
  return Boolean(readOptionalString(modelEnv.ANTHROPIC_API_KEY) || readOptionalString(modelEnv.ANTHROPIC_AUTH_TOKEN));
}

function hasConflictingClaudeCodeAuth(modelEnv: Record<string, unknown>, preset?: ClaudeCodeModelPreset): boolean {
  if (!preset?.authEnvKey) return false;
  const preferred = readOptionalString(modelEnv[preset.authEnvKey]);
  if (!preferred) return false;
  return claudeCodeAuthEnvKeys.some((key) => key !== preset.authEnvKey && Boolean(readOptionalString(modelEnv[key])));
}

function clearOtherClaudeCodeAuthEnvKeys(modelEnv: Record<string, unknown>, activeKey: (typeof claudeCodeAuthEnvKeys)[number]): void {
  for (const key of claudeCodeAuthEnvKeys) {
    if (key !== activeKey) delete modelEnv[key];
  }
}

function readClaudeCodeSettingsAuthSource(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const configPath = resolveClaudeCodeSettingsPath(env);
    const settings = readJsonObjectFile(configPath);
    const modelEnv = isPlainRecord(settings.env) ? settings.env : {};
    const preset = findMatchingClaudeCodePreset({
      baseUrl: readOptionalString(modelEnv.ANTHROPIC_BASE_URL),
      fallbackModelId: readOptionalString(modelEnv.ANTHROPIC_MODEL),
      haikuModelId: readOptionalString(modelEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL) ?? readOptionalString(modelEnv.ANTHROPIC_SMALL_FAST_MODEL),
      sonnetModelId: readOptionalString(modelEnv.ANTHROPIC_DEFAULT_SONNET_MODEL),
      opusModelId: readOptionalString(modelEnv.ANTHROPIC_DEFAULT_OPUS_MODEL)
    });
    const authEnvKey = inferClaudeCodeAuthEnvKey(modelEnv, preset);
    return authEnvKey && readOptionalString(modelEnv[authEnvKey]) ? `${basename(configPath)} env.${authEnvKey}` : undefined;
  } catch {
    return undefined;
  }
}

function readClaudeCodePresetExtraEnv(modelEnv: Record<string, unknown>): Record<string, string | number | boolean> {
  const extraEnv: Record<string, string | number | boolean> = {};
  for (const key of claudeCodePresetExtraEnvKeys) {
    const value = modelEnv[key];
    if (typeof value === "string" && value.trim()) extraEnv[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") extraEnv[key] = value;
  }
  return extraEnv;
}

function writeOptionalEnvValue(modelEnv: Record<string, unknown>, envKey: string, value: unknown): void {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) modelEnv[envKey] = trimmed;
    else delete modelEnv[envKey];
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    modelEnv[envKey] = value;
    return;
  }
  delete modelEnv[envKey];
}

function resolveClaudeCodeSettingsPath(env: NodeJS.ProcessEnv): string {
  const root = readEnvString(env, "CLAUDE_CONFIG_DIR") ?? join(homedir(), ".claude");
  const settingsPath = join(root, "settings.json");
  if (fileExists(settingsPath)) return settingsPath;

  const legacyPath = join(root, "claude.json");
  if (fileExists(legacyPath)) return legacyPath;
  return settingsPath;
}

function readJsonObjectFile(path: string): Record<string, unknown> {
  if (!fileExists(path)) return {};

  const value = readJsonFile(path);
  if (!isPlainRecord(value)) {
    throw new Error(`Claude Code settings must be a JSON object: ${path}`);
  }
  return { ...value };
}

async function writeJsonObjectFileAtomic(path: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const fileName = basename(path);
  const tempPath = join(dirname(path), `.${fileName}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function buildHarnessStatuses(
  version: OpenClawVersionInfo,
  config: OpenClawConfigState,
  defaults: HarnessModelDefaults
): HarnessStatus[] {
  const checkedAt = new Date().toISOString();
  return [
    buildOpenClawHarnessStatus(version, config, checkedAt),
    buildClaudeCodeHarnessStatus(checkedAt, defaults.claude, defaults.claudeModels),
    buildCodexHarnessStatus(checkedAt, defaults.codex, defaults.codexModels),
    buildCliHarnessStatus({
      id: "google",
      label: "Google CLI Beta",
      cliLabel: "Gemini CLI",
      command: "gemini",
      checkedAt,
      defaultModelId: defaults.google,
      models: defaults.googleModels
    }),
    buildCliHarnessStatus({
      id: "cursor",
      label: "Cursor CLI Beta",
      cliLabel: "Cursor CLI",
      command: "cursor-agent",
      checkedAt,
      defaultModelId: defaults.cursor,
      models: defaults.cursorModels
    }),
    buildCliHarnessStatus({
      id: "opencode",
      label: "OpenCode Beta",
      cliLabel: "OpenCode CLI",
      command: "opencode",
      checkedAt,
      defaultModelId: defaults.opencode,
      models: defaults.opencodeModels
    }),
    buildCliHarnessStatus({
      id: "hermes",
      label: "Hermes Beta",
      cliLabel: "Hermes CLI",
      command: "hermes",
      checkedAt,
      defaultModelId: defaults.hermes,
      models: defaults.hermesModels,
      profiles: readHermesProfiles()
    })
  ];
}

function buildOpenClawHarnessStatus(
  version: OpenClawVersionInfo,
  config: OpenClawConfigState,
  checkedAt: string
): HarnessStatus {
  const installed = Boolean(version.version && !version.error);
  const gatewayConfigured = Boolean(config.gateway?.url);
  const environmentOk = installed && Boolean(config.configPath);
  const connectionState = installed ? (gatewayConfigured ? "connected" : "available") : "unavailable";
  return {
    id: "openclaw",
    label: "OpenClaw",
    defaultModelId: config.defaultModelId,
    installed,
    environmentOk,
    connectionState,
    summary: installed
      ? gatewayConfigured
        ? `OpenClaw ${version.version} detected with Gateway configured.`
        : `OpenClaw ${version.version} detected. Gateway is not configured.`
      : `OpenClaw is not available${version.error ? `: ${version.error}` : "."}`,
    checkedAt,
    checks: [
      {
        id: "openclaw-version",
        label: "OpenClaw CLI",
        status: installed ? "pass" : "fail",
        detail: installed ? `Version ${version.version}` : version.error ?? "No version was resolved."
      },
      {
        id: "openclaw-config",
        label: "Config file",
        status: config.configPath ? "pass" : "warning",
        detail: config.configPath || "No OpenClaw config path was resolved."
      },
      {
        id: "openclaw-gateway",
        label: "Gateway",
        status: gatewayConfigured ? "pass" : "warning",
        detail: config.gateway?.url ?? "Gateway URL is not configured."
      }
    ]
  };
}

function buildClaudeCodeHarnessStatus(
  checkedAt: string,
  defaultModelId: string | undefined,
  models: HarnessModelOption[]
): HarnessStatus {
  const installed = canResolvePackage("@anthropic-ai/claude-agent-sdk");
  const apiKeyConfigured = hasEnvValue("ANTHROPIC_API_KEY");
  const authTokenConfigured = hasEnvValue("ANTHROPIC_AUTH_TOKEN");
  const oauthConfigured = hasEnvValue("CLAUDE_CODE_OAUTH_TOKEN");
  const settingsAuthSource = readClaudeCodeSettingsAuthSource();
  const credentialsFile = resolveConfigFile({
    envDirName: "CLAUDE_CONFIG_DIR",
    fallbackDir: join(homedir(), ".claude"),
    fallbackLabel: "~/.claude",
    fileName: ".credentials.json"
  });
  const credentialsConfigured = fileExists(credentialsFile.path);
  const configured = apiKeyConfigured || authTokenConfigured || oauthConfigured || Boolean(settingsAuthSource) || credentialsConfigured;
  return {
    id: "claudeCode",
    label: "Claude code",
    defaultModelId,
    models,
    installed,
    environmentOk: installed && configured && Boolean(defaultModelId),
    connectionState: !installed ? "unavailable" : configured ? "available" : "needs_config",
    summary: !installed
      ? "Claude Code SDK is not installed in this workspace."
      : configured
        ? "Claude Code SDK is installed and a local credential source was detected."
        : "Claude Code SDK is installed, but no API key, auth token, OAuth token, settings credential, or credentials file was detected.",
    checkedAt,
    checks: [
      {
        id: "claude-sdk",
        label: "Claude Code SDK",
        status: installed ? "pass" : "fail",
        detail: installed ? "@anthropic-ai/claude-agent-sdk resolved from node_modules." : "Package resolution failed."
      },
      {
        id: "claude-auth",
        label: "Claude credentials",
        status: configured ? "pass" : "fail",
        detail: configured
          ? credentialSourceLabel([
              apiKeyConfigured ? "ANTHROPIC_API_KEY" : undefined,
              authTokenConfigured ? "ANTHROPIC_AUTH_TOKEN" : undefined,
              oauthConfigured ? "CLAUDE_CODE_OAUTH_TOKEN" : undefined,
              settingsAuthSource,
              credentialsConfigured ? credentialsFile.label : undefined
            ])
          : "No ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, Claude settings credential, or Claude credentials file was detected."
      },
      {
        id: "claude-entitlement",
        label: "Claude entitlement",
        status: configured ? "warning" : "fail",
        detail: configured
          ? "Subscription or API entitlement is not verified by this local check."
          : "A Claude API key, auth token, OAuth token, or paid Claude Code entitlement is required before runtime use."
      },
      {
        id: "claude-default-model",
        label: "Default model",
        status: defaultModelId ? "pass" : "fail",
        detail: defaultModelId ? `${defaultModelId} (${models.length} model option${models.length === 1 ? "" : "s"} resolved).` : "No default Claude Code model was resolved."
      }
    ]
  };
}

function buildCodexHarnessStatus(
  checkedAt: string,
  defaultModelId: string | undefined,
  models: HarnessModelOption[]
): HarnessStatus {
  const installed = canResolvePackage("@openai/codex-sdk");
  const apiKeyConfigured = Boolean(process.env.CODEX_API_KEY?.trim());
  const authFile = resolveConfigFile({
    envDirName: "CODEX_HOME",
    fallbackDir: join(homedir(), ".codex"),
    fallbackLabel: "~/.codex",
    fileName: "auth.json"
  });
  const loginConfigured = fileExists(authFile.path);
  const configured = apiKeyConfigured || loginConfigured;
  return {
    id: "codex",
    label: "Codex",
    defaultModelId,
    models,
    installed,
    environmentOk: installed && configured && Boolean(defaultModelId),
    connectionState: !installed ? "unavailable" : configured ? "available" : "needs_config",
    summary: !installed
      ? "Codex SDK is not installed in this workspace."
      : configured
        ? "Codex SDK is installed and a Codex credential source was detected."
        : "Codex SDK is installed, but no CODEX_API_KEY or Codex login file was detected.",
    checkedAt,
    checks: [
      {
        id: "codex-sdk",
        label: "Codex SDK",
        status: installed ? "pass" : "fail",
        detail: installed ? "@openai/codex-sdk resolved from node_modules." : "Package resolution failed."
      },
      {
        id: "codex-auth",
        label: "Codex credentials",
        status: configured ? "pass" : "fail",
        detail: configured
          ? credentialSourceLabel([apiKeyConfigured ? "CODEX_API_KEY" : undefined, loginConfigured ? authFile.label : undefined])
          : `No CODEX_API_KEY or ${authFile.label} was detected.`
      },
      {
        id: "codex-default-model",
        label: "Default model",
        status: defaultModelId ? "pass" : "fail",
        detail: defaultModelId ? `${defaultModelId} (${models.length} model option${models.length === 1 ? "" : "s"} scanned).` : "No default Codex model was resolved."
      }
    ]
  };
}

function buildCliHarnessStatus({
  id,
  label,
  cliLabel,
  command,
  checkedAt,
  defaultModelId,
  models,
  profiles
}: {
  id: Extract<HarnessId, "google" | "cursor" | "opencode" | "hermes">;
  label: string;
  cliLabel: string;
  command: string;
  checkedAt: string;
  defaultModelId: string | undefined;
  models: HarnessModelOption[];
  profiles?: HarnessProfileOption[];
}): HarnessStatus {
  const version = detectCliVersion(command);
  const installed = version.installed;
  return {
    id,
    label,
    defaultModelId,
    models,
    profiles,
    installed,
    environmentOk: installed && Boolean(defaultModelId),
    connectionState: installed ? "available" : "unavailable",
    summary: installed
      ? `${label} is available. HiveWard will execute ${cliLabel} through its non-interactive command interface.`
      : `${cliLabel} was not found on PATH.`,
    checkedAt,
    checks: [
      {
        id: `${id}-cli`,
        label: cliLabel,
        status: installed ? "pass" : "fail",
        detail: installed ? version.version ?? `${command} resolved on PATH.` : version.error ?? `${command} was not found on PATH.`
      },
      {
        id: `${id}-auth`,
        label: `${cliLabel} credentials`,
        status: installed ? "warning" : "fail",
        detail: installed
          ? "HiveWard does not inspect native CLI credentials; the CLI will use its own configured auth at runtime."
          : "Install and configure the native CLI before runtime use."
      },
      {
        id: `${id}-default-model`,
        label: "Default model",
        status: defaultModelId ? "pass" : "warning",
        detail: defaultModelId
          ? `${defaultModelId} (${models.length} model option${models.length === 1 ? "" : "s"} resolved).`
          : "No default model was resolved; HiveWard will let the CLI use its native default."
      },
      ...(profiles
        ? [{
            id: `${id}-profiles`,
            label: "Profiles",
            status: profiles.length > 0 ? "pass" as const : "warning" as const,
            detail: profiles.length > 0
              ? `${profiles.length} Hermes profile${profiles.length === 1 ? "" : "s"} detected. Create aliases with hermes profile alias <name> before using non-default profiles.`
              : "No Hermes profiles were detected from hermes profile list."
          }]
        : [])
    ]
  };
}

function readHermesProfiles(): HarnessProfileOption[] {
  try {
    const result = runHermesCli(["profile", "list"], 2_000);
    if (result.error || result.status !== 0) return [];
    const homePath = resolveHermesHome();
    const rootConfig = readHermesProfileConfig(homePath);
    return parseHermesProfileList(result.stdout || result.stderr || "").map((profile) => {
      const profilePath = resolveHermesProfilePath(homePath, profile.id);
      const localConfig = {
        ...rootConfig,
        ...(profilePath ? readHermesProfileConfig(profilePath) : {})
      };
      return {
        ...profile,
        modelId: profile.modelId ?? localConfig.modelId,
        provider: localConfig.provider,
        path: profilePath,
        workspace: localConfig.workspace
      };
    });
  } catch {
    return [];
  }
}

function resolveHermesProfilePath(homePath: string, profileId: string): string | undefined {
  const path = profileId === "default" ? join(homePath, "profiles", "default") : join(homePath, "profiles", profileId);
  return fileExists(path) ? path : profileId === "default" ? homePath : undefined;
}

function readHermesProfileConfig(profilePath: string): { modelId?: string; provider?: string; workspace?: string } {
  const configPath = join(profilePath, "config.yaml");
  let content = "";
  try {
    content = readFileSync(configPath, "utf8");
  } catch {
    return {};
  }
  return {
    modelId: readYamlSectionString(content, "model", "default"),
    provider: readYamlSectionString(content, "model", "provider"),
    workspace: readYamlSectionString(content, "terminal", "cwd")
  };
}

function readHermesConfigResponse(): HermesConfigResponse {
  const homePath = resolveHermesHome();
  const channelDirectoryPath = join(homePath, "channel_directory.json");
  return {
    homePath,
    configPath: join(homePath, "config.yaml"),
    channelDirectoryPath,
    profiles: readHermesProfiles(),
    channels: readAllHermesChannels(homePath, channelDirectoryPath),
    skills: readHermesSkills(homePath)
  };
}

function createHermesProfile(input: CreateHermesProfileRequest): void {
  const name = normalizeHermesProfileName(input?.name);
  if (!name) {
    throw new Error("Hermes profile name is required and must use lowercase letters, numbers, dashes, or underscores.");
  }
  const args = ["profile", "create", name];
  const cloneFrom = normalizeHermesProfileName(input.cloneFrom);
  if (cloneFrom) args.push("--clone-from", cloneFrom);
  const description = readOptionalString(input.description);
  if (description) args.push("--description", description);
  const result = runHermesCli(args, 30_000);
  if (result.error || result.status !== 0) {
    throw new Error((result.stderr || result.stdout || result.error?.message || "Hermes profile creation failed.").trim());
  }
  if (input.createAlias !== false) {
    const aliasResult = runHermesCli(["profile", "alias", name, "--name", `hermes-${name}`], 10_000);
    if (aliasResult.error || aliasResult.status !== 0) {
      throw new Error((aliasResult.stderr || aliasResult.stdout || aliasResult.error?.message || "Hermes alias creation failed.").trim());
    }
  }
}

function runHermesCli(args: string[], timeout: number) {
  if (process.platform === "win32") {
    return spawnSync("cmd.exe", ["/d", "/v:off", "/c", "hermes", ...args], {
      encoding: "utf8",
      timeout,
      windowsHide: true
    });
  }
  return spawnSync("hermes", args, {
    encoding: "utf8",
    timeout
  });
}

async function createHermesChannel(input: CreateHermesChannelRequest): Promise<void> {
  const platform = normalizeHermesChannelKey(input?.platform);
  const id = readOptionalString(input?.id);
  if (!platform || !id) {
    throw new Error("Hermes channel platform and id are required.");
  }
  const homePath = resolveHermesHome();
  const channelDirectoryPath = join(homePath, "channel_directory.json");
  const directory = readHermesChannelDirectory(channelDirectoryPath);
  const platforms = isPlainRecord(directory.platforms) ? { ...directory.platforms } : {};
  const entries = Array.isArray(platforms[platform]) ? [...platforms[platform] as unknown[]] : [];
  const channel = {
    id,
    name: readOptionalString(input.name) ?? id,
    type: readOptionalString(input.type) ?? "manual",
    thread_id: readOptionalString(input.threadId) ?? null
  };
  const existingIndex = entries.findIndex((entry) => isPlainRecord(entry) && readOptionalString(entry.id) === id);
  if (existingIndex >= 0) entries[existingIndex] = channel;
  else entries.push(channel);
  platforms[platform] = entries;
  await mkdir(homePath, { recursive: true });
  await writeJsonObjectFileAtomic(channelDirectoryPath, {
    ...directory,
    updated_at: new Date().toISOString(),
    platforms
  });
}

function readHermesChannels(path: string): HermesChannelOption[] {
  const directory = readHermesChannelDirectory(path);
  const platforms = isPlainRecord(directory.platforms) ? directory.platforms : {};
  const channels: HermesChannelOption[] = [];
  for (const [platform, entries] of Object.entries(platforms)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isPlainRecord(entry)) continue;
      const id = readOptionalString(entry.id);
      if (!id) continue;
      channels.push({
        profileId: undefined,
        platform,
        id,
        name: readOptionalString(entry.name) ?? id,
        type: readOptionalString(entry.type),
        threadId: readOptionalString(entry.thread_id)
      });
    }
  }
  return channels.sort((left, right) => `${left.platform}:${left.name}`.localeCompare(`${right.platform}:${right.name}`));
}

function readAllHermesChannels(homePath: string, rootChannelDirectoryPath: string): HermesChannelOption[] {
  const channels = readHermesChannels(rootChannelDirectoryPath).map((channel) => ({ ...channel, profileId: "default" }));
  const profilesRoot = join(homePath, "profiles");
  try {
    for (const profileId of readdirSyncSafe(profilesRoot)) {
      const directoryPath = join(profilesRoot, profileId, "channel_directory.json");
      if (!fileExists(directoryPath)) continue;
      channels.push(...readHermesChannels(directoryPath).map((channel) => ({ ...channel, profileId })));
    }
  } catch {
    return channels;
  }
  const seen = new Set<string>();
  return channels.filter((channel) => {
    const key = `${channel.profileId ?? ""}:${channel.platform}:${channel.id}:${channel.threadId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readHermesSkills(homePath: string): HermesSkillOption[] {
  const skills: HermesSkillOption[] = [
    ...readHermesSkillsFromDirectory(join(homePath, "skills")),
  ];
  const profilesRoot = join(homePath, "profiles");
  for (const profileId of readdirSyncSafe(profilesRoot)) {
    skills.push(...readHermesSkillsFromDirectory(join(profilesRoot, profileId, "skills"), profileId));
  }
  const seen = new Set<string>();
  return skills.filter((skill) => {
    const key = `${skill.profileId ?? "default"}:${skill.id}:${skill.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => `${left.profileId ?? "default"}:${left.label}`.localeCompare(`${right.profileId ?? "default"}:${right.label}`));
}

function readHermesSkillsFromDirectory(skillsPath: string, profileId?: string): HermesSkillOption[] {
  return readdirSyncSafe(skillsPath).flatMap((id) => {
    const skillPath = join(skillsPath, id, "SKILL.md");
    if (!fileExists(skillPath)) return [];
    return [{
      id,
      label: id,
      path: skillPath,
      profileId
    }];
  });
}

function readHermesChannelDirectory(path: string): Record<string, unknown> {
  const value = readJsonFile(path);
  return isPlainRecord(value) ? { ...value } : { platforms: {} };
}

function resolveHermesHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(readEnvString(env, "HERMES_HOME") ?? join(homedir(), ".hermes"));
}

function normalizeHermesProfileName(value: unknown): string | undefined {
  const name = readOptionalString(value)?.toLowerCase();
  return name && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) ? name : undefined;
}

function normalizeHermesChannelKey(value: unknown): string | undefined {
  const key = readOptionalString(value)?.toLowerCase();
  return key && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(key) ? key : undefined;
}

function parseHermesProfileList(output: string): HarnessProfileOption[] {
  const profiles: HarnessProfileOption[] = [];
  const seen = new Set<string>();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("Profile") || line.startsWith("─")) continue;
    const isDefault = line.startsWith("◆");
    const normalized = line.replace(/^◆\s*/, "").trim();
    const [id, modelId, _gateway, alias] = normalized.split(/\s+/);
    if (!id || id === "Profile" || seen.has(id)) continue;
    seen.add(id);
    profiles.push({
      id,
      label: id,
      modelId: modelId && !isMissingHermesProfileCell(modelId) ? modelId : undefined,
      alias: alias && !isMissingHermesProfileCell(alias) ? alias : undefined,
      isDefault: isDefault || undefined
    });
  }
  return profiles;
}

function isMissingHermesProfileCell(value: string): boolean {
  return value === "-" || value === "—";
}

function detectCliVersion(command: string): { installed: boolean; version?: string; error?: string } {
  try {
    const result = process.platform === "win32"
      ? spawnSync(`${command} --version`, {
          encoding: "utf8",
          shell: true,
          timeout: 2_000,
          windowsHide: true
        })
      : spawnSync(command, ["--version"], {
          encoding: "utf8",
          timeout: 2_000
        });
    if (result.error) {
      return { installed: false, error: result.error.message };
    }
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || "").trim();
      return { installed: false, error: detail || `${command} --version exited with ${result.status}.` };
    }
    const version = (result.stdout || result.stderr || "").trim().split(/\r?\n/)[0];
    return { installed: true, version };
  } catch (error) {
    return { installed: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function readdirSyncSafe(path: string): string[] {
  try {
    return readdirSync(path).filter((entry) => !entry.startsWith("."));
  } catch {
    return [];
  }
}

function readYamlSectionString(content: string, sectionName: string, key: string): string | undefined {
  let inSection = false;
  const keyPattern = new RegExp(`^\\s{2}${escapeRegExp(key)}\\s*:\\s*(.+?)\\s*$`);
  for (const rawLine of content.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
    if (/^\S[^:]*:\s*$/.test(rawLine)) {
      inSection = rawLine.trim() === `${sectionName}:`;
      continue;
    }
    if (!inSection) continue;
    const match = keyPattern.exec(rawLine);
    if (!match?.[1]) continue;
    return unquoteYamlScalar(match[1]);
  }
  return undefined;
}

function readHermesConfiguredModelsFromFiles(env: NodeJS.ProcessEnv = process.env): HarnessModelOption[] {
  const homePath = resolveHermesHome(env);
  const options: HarnessModelOption[] = [];
  for (const configPath of [
    join(homePath, "config.yaml"),
    ...readdirSyncSafe(join(homePath, "profiles")).map((profileId) => join(homePath, "profiles", profileId, "config.yaml"))
  ]) {
    try {
      const content = readFileSync(configPath, "utf8");
      const provider = readYamlSectionString(content, "model", "provider") ?? "hermes";
      const defaultModel = readYamlSectionString(content, "model", "default");
      if (defaultModel) options.push({ id: defaultModel, label: defaultModel, provider, thinkingLevels: cliHarnessDefaultThinkingLevels });
      for (const fallback of readHermesFallbackModels(content)) {
        options.push({ id: fallback.modelId, label: fallback.modelId, provider: fallback.provider ?? provider, thinkingLevels: cliHarnessDefaultThinkingLevels });
      }
    } catch {
      continue;
    }
  }
  return mergeHarnessModelOptions(options);
}

function readHermesFallbackModels(content: string): Array<{ modelId: string; provider?: string }> {
  const models: Array<{ modelId: string; provider?: string }> = [];
  let inFallbacks = false;
  let currentProvider: string | undefined;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^\S[^:]*:\s*$/.test(rawLine)) {
      inFallbacks = line === "fallback_providers:";
      currentProvider = undefined;
      continue;
    }
    if (!inFallbacks) continue;
    const providerMatch = /^-\s*provider:\s*(.+)$/.exec(line);
    if (providerMatch?.[1]) {
      currentProvider = unquoteYamlScalar(providerMatch[1]);
      continue;
    }
    const modelMatch = /^model:\s*(.+)$/.exec(line);
    if (modelMatch?.[1]) {
      models.push({ modelId: unquoteYamlScalar(modelMatch[1]), provider: currentProvider });
    }
  }
  return models;
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function resolveConfigFile({
  envDirName,
  fallbackDir,
  fallbackLabel,
  fileName
}: {
  envDirName: string;
  fallbackDir: string;
  fallbackLabel: string;
  fileName: string;
}): { path: string; label: string } {
  const envDir = process.env[envDirName]?.trim();
  return envDir
    ? { path: join(envDir, fileName), label: `${envDirName}/${fileName}` }
    : { path: join(fallbackDir, fileName), label: `${fallbackLabel}/${fileName}` };
}

function hasEnvValue(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function fileExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function credentialSourceLabel(sources: Array<string | undefined>): string {
  return `Detected: ${sources.filter(Boolean).join(", ")}.`;
}

function canResolvePackage(packageName: string): boolean {
  try {
    import.meta.resolve(packageName);
    return true;
  } catch {
    return false;
  }
}

function collectInvalidAgentIds(blueprint: BlueprintDefinition, configuredAgentIds: Set<string>): string[] {
  const invalid = new Set<string>();

  for (const node of blueprint.nodes) {
    if (isAgentBlueprintNode(node) && node.runtimeId === "openclaw") {
      const agentId = node.config.openclawAgentId ?? "main";
      if (!configuredAgentIds.has(agentId)) invalid.add(agentId);
      continue;
    }
    if (node.type === "manager" && (node.runtimeId ?? "openclaw") === "openclaw") {
      const agentId = (node.config as ManagerNodeConfig).openclawAgentId ?? "main";
      if (!configuredAgentIds.has(agentId)) invalid.add(agentId);
      continue;
    }
  }

  return [...invalid];
}

function readRouteParam(value: string | string[] | undefined, name: string): string {
  if (Array.isArray(value)) {
    const [first] = value;
    if (first) return first;
  }
  if (typeof value === "string" && value) return value;
  throw new Error(`Missing route parameter: ${name}`);
}

function withRunDefaults(blueprint: BlueprintDefinition, defaults: RunModelDefaults): BlueprintDefinition {
  if (!defaults.openclaw && !defaults.codex && !defaults.claude && !defaults.google && !defaults.cursor && !defaults.opencode && !defaults.hermes) return blueprint;

  return {
    ...blueprint,
    nodes: blueprint.nodes.map((node) => {
      if (isAgentBlueprintNode(node)) {
        const config = node.config as AgentNodeConfig;
        const runtimeId = node.runtimeId ?? "openclaw";
        const defaultModelId = defaultModelForAgentRuntime(runtimeId, defaults);
        return config.modelId || !defaultModelId
          ? { ...node, runtimeId }
          : { ...node, runtimeId, config: { ...config, modelId: defaultModelId } };
      }
      if (node.type === "manager") {
        const config = node.config as ManagerNodeConfig;
        const defaultModelId = defaultModelForAgentRuntime(node.runtimeId ?? "openclaw", defaults);
        return {
          ...node,
          runtimeId: node.runtimeId ?? "openclaw",
          config: config.modelId || !defaultModelId ? config : { ...config, modelId: defaultModelId }
        };
      }
      if (node.type === "summary") {
        const config = node.config as SummaryNodeConfig;
        const mode = config.mode as string;
        if (mode !== "harness_summary" && mode !== "openclaw_summary_agent") return node;
        const runtimeId = config.runtimeId ?? "openclaw";
        const defaultModelId = defaultModelForAgentRuntime(runtimeId, defaults);
        return {
          ...node,
          config: {
            ...config,
            mode: "harness_summary",
            runtimeId,
            modelId: config.modelId || defaultModelId
          } satisfies SummaryNodeConfig
        };
      }
      return node;
    })
  };
}

function defaultModelForAgentRuntime(runtimeId: AgentRuntimeId | undefined, defaults: RunModelDefaults): string | undefined {
  if (runtimeId === "codex") return defaults.codex;
  if (runtimeId === "claude") return defaults.claude;
  if (runtimeId === "google") return defaults.google;
  if (runtimeId === "cursor") return defaults.cursor;
  if (runtimeId === "opencode") return defaults.opencode;
  if (runtimeId === "hermes") return defaults.hermes;
  return defaults.openclaw;
}

function buildBlueprintImportDefaults(
  config: OpenClawConfigState,
  runtimeId?: AgentRuntimeId,
  harnessDefaults = resolveHarnessModelDefaults()
): BlueprintImportDefaults {
  return {
    runtimeId,
    openclawAgentId: selectDefaultAgentId(config.configuredAgents),
    modelId: config.defaultModelId,
    modelIds: {
      openclaw: config.defaultModelId,
      codex: harnessDefaults.codex,
      claude: harnessDefaults.claude,
      google: harnessDefaults.google,
      cursor: harnessDefaults.cursor,
      opencode: harnessDefaults.opencode,
      hermes: harnessDefaults.hermes
    },
    channelId: selectDefaultChannelId(config.configuredChannels)
  };
}

function resolveHarnessModelDefaults(env: NodeJS.ProcessEnv = process.env): HarnessModelDefaults {
  const codexModels = readCodexModelCache(env);
  const codexConfiguredModel = readCodexConfiguredModel(env);
  const codexDefaultModelId =
    readEnvString(env, "HIVEWARD_CODEX_DEFAULT_MODEL") ??
    readEnvString(env, "CODEX_DEFAULT_MODEL") ??
    codexConfiguredModel ??
    codexModels[0]?.id ??
    fallbackCodexDefaultModel;

  const claudeDefaultModelId =
    readEnvString(env, "HIVEWARD_CLAUDE_CODE_DEFAULT_MODEL") ??
    readEnvString(env, "CLAUDE_CODE_DEFAULT_MODEL") ??
    fallbackClaudeCodeDefaultModel;
  const googleConfiguredModel = readGoogleCliConfiguredModel(env);
  const googleDefaultModelId =
    readEnvString(env, "HIVEWARD_GOOGLE_CLI_DEFAULT_MODEL") ??
    readEnvString(env, "GOOGLE_CLI_DEFAULT_MODEL") ??
    readEnvString(env, "GEMINI_DEFAULT_MODEL") ??
    googleConfiguredModel ??
    fallbackCliDefaultModel;
  const cursorDefaultModelId =
    readEnvString(env, "HIVEWARD_CURSOR_DEFAULT_MODEL") ??
    readEnvString(env, "CURSOR_DEFAULT_MODEL") ??
    fallbackCliDefaultModel;
  const opencodeDefaultModelId =
    readEnvString(env, "HIVEWARD_OPENCODE_DEFAULT_MODEL") ??
    readEnvString(env, "OPENCODE_DEFAULT_MODEL") ??
    fallbackCliDefaultModel;
  const hermesConfiguredModels = readHermesConfiguredModelsFromFiles(env);
  const hermesDefaultModelId =
    readEnvString(env, "HIVEWARD_HERMES_DEFAULT_MODEL") ??
    readEnvString(env, "HERMES_DEFAULT_MODEL") ??
    hermesConfiguredModels[0]?.id ??
    fallbackCliDefaultModel;

  return {
    codex: codexDefaultModelId,
    claude: claudeDefaultModelId,
    google: googleDefaultModelId,
    cursor: cursorDefaultModelId,
    opencode: opencodeDefaultModelId,
    hermes: hermesDefaultModelId,
    codexModels: prepareHarnessModelOptions(codexModels, codexDefaultModelId, "codex", codexDefaultThinkingLevels),
    claudeModels: prepareHarnessModelOptions(
      readClaudeCodeModelOptions(env),
      claudeDefaultModelId,
      "claude",
      claudeCodeDefaultThinkingLevels
    ),
    googleModels: prepareHarnessModelOptions(
      readGoogleCliModelOptions(env),
      googleDefaultModelId,
      "google",
      cliHarnessDefaultThinkingLevels
    ),
    cursorModels: prepareHarnessModelOptions(
      readEnvModelOptions(env, ["HIVEWARD_CURSOR_MODELS", "CURSOR_MODELS"], "cursor", cliHarnessDefaultThinkingLevels),
      cursorDefaultModelId,
      "cursor",
      cliHarnessDefaultThinkingLevels
    ),
    opencodeModels: prepareHarnessModelOptions(
      readEnvModelOptions(env, ["HIVEWARD_OPENCODE_MODELS", "OPENCODE_MODELS"], "opencode", cliHarnessDefaultThinkingLevels),
      opencodeDefaultModelId,
      "opencode",
      cliHarnessDefaultThinkingLevels
    ),
    hermesModels: prepareHarnessModelOptions(
      [
        ...hermesConfiguredModels,
        ...readEnvModelOptions(env, ["HIVEWARD_HERMES_MODELS", "HERMES_MODELS"], "hermes", cliHarnessDefaultThinkingLevels)
      ],
      hermesDefaultModelId,
      "hermes",
      cliHarnessDefaultThinkingLevels
    )
  };
}

function readCodexConfiguredModel(env: NodeJS.ProcessEnv): string | undefined {
  for (const root of resolveCodexConfigRoots(env)) {
    const configPath = join(root, "config.toml");
    if (!fileExists(configPath)) continue;
    const model = readTopLevelTomlString(configPath, "model");
    if (model) return model;
  }
  return undefined;
}

function readCodexModelCache(env: NodeJS.ProcessEnv): HarnessModelOption[] {
  const entries: Array<HarnessModelOption & { priority: number }> = [];
  for (const root of resolveCodexConfigRoots(env)) {
    const cachePath = join(root, "models_cache.json");
    const cache = readJsonFile(cachePath);
    const models = isPlainRecord(cache) && Array.isArray(cache.models) ? cache.models : [];
    for (const model of models) {
      const option = readCodexCachedModel(model);
      if (option) entries.push(option);
    }
  }

  entries.sort((left, right) => right.priority - left.priority || left.label.localeCompare(right.label));
  return mergeHarnessModelOptions(entries.map(({ priority: _priority, ...option }) => option));
}

function readCodexCachedModel(value: unknown): (HarnessModelOption & { priority: number }) | undefined {
  if (!isPlainRecord(value)) return undefined;
  const id = readOptionalString(value.slug);
  if (!id) return undefined;

  const visibility = readOptionalString(value.visibility);
  if (visibility && visibility !== "list") return undefined;
  if (value.supported_in_api === false) return undefined;

  return {
    id,
    label: readOptionalString(value.display_name) ?? id,
    provider: "codex",
    description: readOptionalString(value.description),
    thinkingLevels: readCodexThinkingLevels(value.supported_reasoning_levels),
    priority: typeof value.priority === "number" ? value.priority : 0
  };
}

function readCodexThinkingLevels(value: unknown): ChatThinkingEffort[] {
  if (!Array.isArray(value)) return codexDefaultThinkingLevels;
  const levels = value
    .map((item) => (isPlainRecord(item) ? readOptionalString(item.effort) : undefined))
    .filter((effort): effort is ChatThinkingEffort => isChatThinkingEffort(effort) && effort !== "minimal" && effort !== "off");
  return levels.length ? [...new Set(levels)] : codexDefaultThinkingLevels;
}

function readEnvModelOptions(
  env: NodeJS.ProcessEnv,
  names: string[],
  provider: string,
  thinkingLevels: ChatThinkingEffort[]
): HarnessModelOption[] {
  for (const name of names) {
    const value = readEnvString(env, name);
    if (!value) continue;
    return value
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((id) => ({
        id,
        label: id,
        provider,
        thinkingLevels
      }));
  }
  return [];
}

function readClaudeCodeModelOptions(env: NodeJS.ProcessEnv): HarnessModelOption[] {
  return mergeHarnessModelOptions([
    ...readEnvModelOptions(env, ["HIVEWARD_CLAUDE_CODE_MODELS", "CLAUDE_CODE_MODELS"], "claude", claudeCodeDefaultThinkingLevels),
    ...readClaudeCodeSettingsModelOptions(env)
  ]);
}

function readGoogleCliConfiguredModel(env: NodeJS.ProcessEnv): string | undefined {
  for (const root of resolveGoogleCliConfigRoots(env)) {
    const settings = readJsonFile(join(root, "settings.json"));
    if (!isPlainRecord(settings)) continue;
    const model = readOptionalString(settings.model);
    if (model) return model;
  }
  return undefined;
}

function readGoogleCliModelOptions(env: NodeJS.ProcessEnv): HarnessModelOption[] {
  return mergeHarnessModelOptions([
    ...readEnvModelOptions(env, ["HIVEWARD_GOOGLE_CLI_MODELS", "GOOGLE_CLI_MODELS", "GEMINI_MODELS"], "google", cliHarnessDefaultThinkingLevels),
    ...readGoogleCliSettingsModelOptions(env)
  ]);
}

function readGoogleCliSettingsModelOptions(env: NodeJS.ProcessEnv): HarnessModelOption[] {
  const modelIds = new Set<string>();
  for (const root of resolveGoogleCliConfigRoots(env)) {
    const settings = readJsonFile(join(root, "settings.json"));
    if (!isPlainRecord(settings)) continue;
    const model = readOptionalString(settings.model);
    if (model) modelIds.add(model);
  }
  return [...modelIds].map((id) => ({
    id,
    label: id,
    provider: "google",
    thinkingLevels: cliHarnessDefaultThinkingLevels
  }));
}

function readClaudeCodeSettingsModelOptions(env: NodeJS.ProcessEnv): HarnessModelOption[] {
  const modelIds = new Set<string>();
  for (const root of resolveClaudeCodeConfigRoots(env)) {
    for (const fileName of ["settings.json", "settings.local.json"]) {
      const settings = readJsonFile(join(root, fileName));
      if (!isPlainRecord(settings)) continue;
      const topLevelModel = readOptionalString(settings.model);
      if (topLevelModel) modelIds.add(topLevelModel);
      const settingsEnv = isPlainRecord(settings.env) ? settings.env : {};
      for (const [key, value] of Object.entries(settingsEnv)) {
        if (key === "ANTHROPIC_MODEL" || key === "CLAUDE_CODE_DEFAULT_MODEL" || /^ANTHROPIC_DEFAULT_.*_MODEL$/.test(key)) {
          const modelId = readOptionalString(value);
          if (modelId) modelIds.add(modelId);
        }
      }
    }
  }

  return [...modelIds].map((id) => ({
    id,
    label: id,
    provider: "claude",
    thinkingLevels: claudeCodeDefaultThinkingLevels
  }));
}

function prepareHarnessModelOptions(
  scannedModels: HarnessModelOption[],
  defaultModelId: string | undefined,
  provider: string,
  thinkingLevels: ChatThinkingEffort[]
): HarnessModelOption[] {
  const defaultOption = defaultModelId
    ? [{
        id: defaultModelId,
        label: defaultModelId,
        provider,
        thinkingLevels
      }]
    : [];
  const merged = mergeHarnessModelOptions([...defaultOption, ...scannedModels]);
  return merged
    .map((model) => ({
      ...model,
      isDefault: defaultModelId ? model.id === defaultModelId : undefined
    }))
    .sort((left, right) => Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault)));
}

function mergeHarnessModelOptions(options: HarnessModelOption[]): HarnessModelOption[] {
  const merged: HarnessModelOption[] = [];
  const indexesById = new Map<string, number>();
  for (const option of options) {
    if (!option.id) continue;
    const existingIndex = indexesById.get(option.id);
    if (existingIndex === undefined) {
      indexesById.set(option.id, merged.length);
      merged.push(option);
      continue;
    }
    const existing = merged[existingIndex]!;
    merged[existingIndex] = {
      ...existing,
      ...option,
      thinkingLevels: option.thinkingLevels?.length ? option.thinkingLevels : existing.thinkingLevels
    };
  }
  return merged;
}

function resolveCodexConfigRoots(env: NodeJS.ProcessEnv): string[] {
  const roots = [readEnvString(env, "CODEX_HOME"), join(homedir(), ".codex")].filter((root): root is string => Boolean(root));
  return [...new Set(roots.map((root) => resolve(root)))];
}

function resolveClaudeCodeConfigRoots(env: NodeJS.ProcessEnv): string[] {
  const roots = [readEnvString(env, "CLAUDE_CONFIG_DIR"), join(homedir(), ".claude")].filter((root): root is string => Boolean(root));
  return [...new Set(roots.map((root) => resolve(root)))];
}

function resolveGoogleCliConfigRoots(env: NodeJS.ProcessEnv): string[] {
  const roots = [readEnvString(env, "GEMINI_HOME"), readEnvString(env, "GOOGLE_CLI_HOME"), join(homedir(), ".gemini")]
    .filter((root): root is string => Boolean(root));
  return [...new Set(roots.map((root) => resolve(root)))];
}

function readTopLevelTomlString(path: string, key: string): string | undefined {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const pattern = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^\\s#]+))`);
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) return undefined;
    const match = pattern.exec(line);
    const value = match?.[1] ?? match?.[2] ?? match?.[3];
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

function readJsonFile(path: string): unknown {
  if (!fileExists(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function isChatThinkingEffort(value: string | undefined): value is ChatThinkingEffort {
  return value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "adaptive" ||
    value === "xhigh" ||
    value === "max";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readEnvString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const maxChatMessageChars = 40_000;
const maxChatAttachments = 6;
const maxChatAttachmentTextChars = 24_000;

async function refreshCatalog(adapter: RuntimeAdapter, store: HivewardStore): Promise<CatalogSnapshot> {
  const now = new Date();
  const snapshot: CatalogSnapshot = {
    id: `catalog-${nanoid(8)}`,
    source: "openclaw",
    sourceUpdatedAt: now.toISOString(),
    refreshedAt: now.toISOString(),
    staleAfter: new Date(now.getTime() + 1000 * 60 * 15).toISOString(),
    models: await adapter.listModels(),
    agents: await adapter.listAgents(),
    tools: await adapter.listTools(),
    channels: await adapter.listChannels()
  };
  return store.saveCatalogSnapshot(snapshot);
}

function emptyCatalogSnapshot(): CatalogSnapshot {
  const now = new Date();
  return {
    id: "catalog-unscanned",
    source: "openclaw",
    sourceUpdatedAt: now.toISOString(),
    refreshedAt: now.toISOString(),
    staleAfter: now.toISOString(),
    models: [],
    agents: [],
    tools: [],
    channels: []
  };
}

function selectDefaultAgentId(agents: OpenClawConfiguredAgent[]): string {
  return agents.find((agent) => agent.isDefault)?.id ?? agents[0]?.id ?? "main";
}

function selectDefaultChannelId(channels: OpenClawConfiguredChannel[]): string | undefined {
  return channels.find((channel) => channel.enabled)?.id ?? channels[0]?.id;
}

function emptyRuntimeOverview(): RuntimeOverview {
  return {
    sessions: [],
    tasks: []
  };
}
