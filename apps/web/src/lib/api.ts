import type {
  CatalogSnapshot,
  CatalogSnapshotResponse,
  ClaudeCodeModelConfig,
  ClaudeCodeModelConfigResponse,
  CompanyDirectoryResponse,
  ConfigureOpenClawChannelRequest,
  ConfigureOpenClawModelAuthRequest,
  CreateCompanyRequest,
  CreateHermesChannelRequest,
  CreateHermesProfileRequest,
  CreateOpenClawAgentRequest,
  CreateBlueprintRequest,
  CreateBlueprintProposalRequest,
  CreateLeaderDelegationRequest,
  DashboardStateResponse,
  DeleteBlueprintResponse,
  DeleteCompanyResponse,
  ExportBlueprintResponse,
  HarnessId,
  HarnessSkillStatusResponse,
  HarnessStatus,
  HarnessStatusResponse,
  HermesConfigResponse,
  ApplyHivewardUpdateResponse,
  ApprovalRequest,
  ApprovalRequestResponse,
  HivewardUpdateResponse,
  ImportBlueprintPackageRequest,
  ImportBlueprintPackageResponse,
  InstallHarnessSkillsResponse,
  LatestBlueprintRunResponse,
  ListPendingApprovalsResponse,
  ListApprovalMessagesResponse,
  ListApprovalRequestsResponse,
  ListBlueprintRunSummariesResponse,
  ListBlueprintsResponse,
  OpenClawConfigResponse,
  OpenClawConfigWizardMetadata,
  OpenClawConfigWizardResponse,
  OpenClawModelUsageResponse,
  OpenClawModelUsageSummary,
  OpenClawVersionInfo,
  OpenClawVersionResponse,
  RuntimeOverview,
  RuntimeOverviewResponse,
  SaveArchitectureBlueprintLayoutRequest,
  SaveBlueprintRequest,
  SelectCompanyRequest,
  UpdateCompanyRequest,
  ApproveBlueprintRunRequest,
  RejectBlueprintRunRequest,
  ReplyBlueprintRunApprovalRequest,
  SelectBlueprintRunApprovalRequest,
  ReplyInboxItemRequest,
  ChatSessionHistoryResponse,
  ChatSessionMessagesResponse,
  CreateChatSessionRequest,
  CreateChatSessionResponse,
  CreateHivewardChatSessionRequest,
  UpdateChatSessionTitleRequest,
  UpdateChatSessionTitleResponse,
  UpdateHivewardChatSessionRequest,
  SaveClaudeCodeModelProfileRequest,
  UpdateClaudeCodeModelConfigRequest,
  SendChatSessionMessageRequest,
  ChatStreamEvent,
  HivewardChatSession,
  HivewardChatSessionResponse,
  InboxItem,
  InboxItemResponse,
  ApproveInboxItemResponse,
  ListChatSessionsResponse,
  StartBlueprintRunResponse,
  UpdateOpenClawDefaultModelRequest,
  PendingApprovalItem,
  RoleDirectoryResponse,
  OpenClawConfigState,
  PortableBlueprintPackage,
  WorkspaceDashboard,
  BlueprintDefinition,
  BlueprintResponse,
  BlueprintRunResponse
} from "@hiveward/shared";

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "").trim().replace(/\/+$/, "");

export interface ChatStreamHandlers {
  onEvent: (event: ChatStreamEvent) => void;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetchApi(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers
    }
  });

  if (!response.ok) {
    const body = await response.json().catch(() => undefined);
    const message = body?.error?.message ?? `Request failed: ${response.status}`;
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

async function fetchApi(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(buildApiUrl(path), init);
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (apiBaseUrl) {
      try {
        return await fetch(path, init);
      } catch (fallbackError) {
        if (isAbortError(fallbackError)) throw fallbackError;
      }
    }
    throw new Error("Cannot reach Hiveward API. Make sure the local Hiveward server is running.");
  }
}

function buildApiUrl(path: string, baseUrl = apiBaseUrl): string {
  if (isAbsoluteResourceUrl(path)) return path;
  return baseUrl ? `${baseUrl}${path.startsWith("/") ? path : `/${path}`}` : path;
}

export function resolveApiResourceUrl(path: string, baseUrl = apiBaseUrl): string {
  const trimmed = path.trim();
  if (!trimmed) return trimmed;
  return buildApiUrl(trimmed, baseUrl);
}

function isAbsoluteResourceUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//");
}

function isAbortError(error: unknown): boolean {
  return typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError";
}

async function consumeChatStreamResponse(response: Response, handlers: ChatStreamHandlers): Promise<void> {
  if (!response.body) {
    throw new Error("Chat stream response did not include a body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = consumeChatStreamBuffer(buffer, handlers);
  }

  buffer += decoder.decode();
  consumeChatStreamBuffer(`${buffer}\n\n`, handlers);
}

export const api = {
  async listChatSessions(): Promise<HivewardChatSession[]> {
    const response = await request<ListChatSessionsResponse>("/api/chat/sessions");
    return response.sessions;
  },

  async createHivewardChatSession(input: CreateHivewardChatSessionRequest): Promise<HivewardChatSession> {
    const response = await request<HivewardChatSessionResponse>("/api/chat/sessions", {
      method: "POST",
      body: JSON.stringify(input satisfies CreateHivewardChatSessionRequest)
    });
    return response.session;
  },

  async updateHivewardChatSession(sessionId: string, input: UpdateHivewardChatSessionRequest): Promise<HivewardChatSession> {
    const response = await request<HivewardChatSessionResponse>(`/api/chat/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      body: JSON.stringify(input satisfies UpdateHivewardChatSessionRequest)
    });
    return response.session;
  },

  async endHivewardChatSession(sessionId: string): Promise<HivewardChatSession> {
    const response = await request<HivewardChatSessionResponse>(`/api/chat/sessions/${encodeURIComponent(sessionId)}/end`, {
      method: "POST"
    });
    return response.session;
  },

  async getHivewardChatMessages(sessionId: string): Promise<ChatSessionMessagesResponse["messages"]> {
    const response = await request<ChatSessionMessagesResponse>(`/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`);
    return response.messages;
  },

  async streamSessionChat(
    sessionId: string,
    input: SendChatSessionMessageRequest,
    handlers: ChatStreamHandlers,
    signal?: AbortSignal
  ): Promise<void> {
    const response = await fetchApi(`/api/chat/sessions/${encodeURIComponent(sessionId)}/messages/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      signal,
      body: JSON.stringify(input)
    });

    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      const message = body?.error?.message ?? `Request failed: ${response.status}`;
      throw new Error(message);
    }

    if (!response.body) {
      throw new Error("Chat stream response did not include a body.");
    }

    await consumeChatStreamResponse(response, handlers);
  },

  async createChatSession(input: CreateChatSessionRequest): Promise<CreateChatSessionResponse> {
    return request<CreateChatSessionResponse>("/api/chat/session", {
      method: "POST",
      body: JSON.stringify(input satisfies CreateChatSessionRequest)
    });
  },

  async updateChatSessionTitle(input: UpdateChatSessionTitleRequest): Promise<UpdateChatSessionTitleResponse> {
    return request<UpdateChatSessionTitleResponse>("/api/chat/session", {
      method: "PATCH",
      body: JSON.stringify(input satisfies UpdateChatSessionTitleRequest)
    });
  },

  async getChatSessionHistory(sessionKey: string): Promise<ChatSessionHistoryResponse> {
    return request<ChatSessionHistoryResponse>(`/api/chat/history?sessionKey=${encodeURIComponent(sessionKey)}`);
  },

  async getOpenClawConfig(): Promise<OpenClawConfigState> {
    const response = await request<OpenClawConfigResponse>("/api/openclaw-config");
    return response.config;
  },

  async getOpenClawConfigWizard(): Promise<OpenClawConfigWizardMetadata> {
    const response = await request<OpenClawConfigWizardResponse>("/api/openclaw-config/wizard");
    return response.wizard;
  },

  async getOpenClawVersion(): Promise<OpenClawVersionInfo> {
    const response = await request<OpenClawVersionResponse>("/api/openclaw-version");
    return response.version;
  },

  async getHivewardUpdate(): Promise<HivewardUpdateResponse["update"]> {
    const response = await request<HivewardUpdateResponse>("/api/hiveward-update");
    return response.update;
  },

  async applyHivewardUpdate(): Promise<ApplyHivewardUpdateResponse> {
    return request<ApplyHivewardUpdateResponse>("/api/hiveward-update/apply", {
      method: "POST"
    });
  },

  async getHarnessStatus(): Promise<HarnessStatus[]> {
    const response = await request<HarnessStatusResponse>("/api/harness-status");
    return response.statuses;
  },

  async getHermesConfig(): Promise<HermesConfigResponse> {
    return request<HermesConfigResponse>("/api/hermes-config");
  },

  async addHermesProfile(input: CreateHermesProfileRequest): Promise<HermesConfigResponse> {
    return request<HermesConfigResponse>("/api/hermes-config/profiles", {
      method: "POST",
      body: JSON.stringify(input satisfies CreateHermesProfileRequest)
    });
  },

  async addHermesChannel(input: CreateHermesChannelRequest): Promise<HermesConfigResponse> {
    return request<HermesConfigResponse>("/api/hermes-config/channels", {
      method: "POST",
      body: JSON.stringify(input satisfies CreateHermesChannelRequest)
    });
  },

  async getClaudeCodeModelConfig(): Promise<ClaudeCodeModelConfigResponse> {
    return request<ClaudeCodeModelConfigResponse>("/api/claude-code-config/models");
  },

  async updateClaudeCodeModelConfig(input: UpdateClaudeCodeModelConfigRequest): Promise<ClaudeCodeModelConfigResponse> {
    return request<ClaudeCodeModelConfigResponse>("/api/claude-code-config/models", {
      method: "PUT",
      body: JSON.stringify(input satisfies UpdateClaudeCodeModelConfigRequest)
    });
  },

  async saveClaudeCodeModelProfile(input: SaveClaudeCodeModelProfileRequest = {}): Promise<ClaudeCodeModelConfigResponse> {
    return request<ClaudeCodeModelConfigResponse>("/api/claude-code-config/model-profiles", {
      method: "POST",
      body: JSON.stringify(input satisfies SaveClaudeCodeModelProfileRequest)
    });
  },

  async applyClaudeCodeModelProfile(profileId: string): Promise<ClaudeCodeModelConfigResponse> {
    return request<ClaudeCodeModelConfigResponse>(`/api/claude-code-config/model-profiles/${encodeURIComponent(profileId)}/apply`, {
      method: "POST",
      body: JSON.stringify({})
    });
  },

  async deleteClaudeCodeModelProfile(profileId: string): Promise<ClaudeCodeModelConfigResponse> {
    return request<ClaudeCodeModelConfigResponse>(`/api/claude-code-config/model-profiles/${encodeURIComponent(profileId)}`, {
      method: "DELETE"
    });
  },

  async getHarnessSkillStatus(harnessId: HarnessId): Promise<HarnessSkillStatusResponse> {
    return request<HarnessSkillStatusResponse>(`/api/harness-skills/${encodeURIComponent(harnessId)}`);
  },

  async installHarnessSkills(harnessId: HarnessId): Promise<InstallHarnessSkillsResponse> {
    return request<InstallHarnessSkillsResponse>(`/api/harness-skills/${encodeURIComponent(harnessId)}/install`, {
      method: "POST"
    });
  },

  async getOpenClawModelUsage(): Promise<OpenClawModelUsageSummary[]> {
    const response = await request<OpenClawModelUsageResponse>("/api/openclaw-usage/models");
    return response.usage;
  },

  async updateOpenClawDefaultModel(modelId: string): Promise<OpenClawConfigState> {
    const response = await request<OpenClawConfigResponse>("/api/openclaw-config/default-model", {
      method: "PUT",
      body: JSON.stringify({ modelId } satisfies UpdateOpenClawDefaultModelRequest)
    });
    return response.config;
  },

  async configureOpenClawModelAuth(input: ConfigureOpenClawModelAuthRequest): Promise<OpenClawConfigState> {
    const response = await request<OpenClawConfigResponse>("/api/openclaw-config/model-auth", {
      method: "POST",
      body: JSON.stringify(input satisfies ConfigureOpenClawModelAuthRequest)
    });
    return response.config;
  },

  async addOpenClawAgent(input: CreateOpenClawAgentRequest): Promise<OpenClawConfigState> {
    const response = await request<OpenClawConfigResponse>("/api/openclaw-config/agents", {
      method: "POST",
      body: JSON.stringify(input satisfies CreateOpenClawAgentRequest)
    });
    return response.config;
  },

  async configureOpenClawChannel(input: ConfigureOpenClawChannelRequest): Promise<OpenClawConfigState> {
    const response = await request<OpenClawConfigResponse>("/api/openclaw-config/channel-setup", {
      method: "POST",
      body: JSON.stringify(input satisfies ConfigureOpenClawChannelRequest)
    });
    return response.config;
  },

  async listCompanies(): Promise<CompanyDirectoryResponse> {
    return request<CompanyDirectoryResponse>("/api/companies");
  },

  async createCompany(input: CreateCompanyRequest): Promise<CompanyDirectoryResponse> {
    return request<CompanyDirectoryResponse>("/api/companies", {
      method: "POST",
      body: JSON.stringify(input satisfies CreateCompanyRequest)
    });
  },

  async updateCompany(companyId: string, input: UpdateCompanyRequest): Promise<CompanyDirectoryResponse> {
    return request<CompanyDirectoryResponse>(`/api/companies/${encodeURIComponent(companyId)}`, {
      method: "PATCH",
      body: JSON.stringify(input satisfies UpdateCompanyRequest)
    });
  },

  async selectCompany(companyId?: string): Promise<CompanyDirectoryResponse> {
    return request<CompanyDirectoryResponse>("/api/companies/selected", {
      method: "PUT",
      body: JSON.stringify({ companyId } satisfies SelectCompanyRequest)
    });
  },

  async deleteCompany(companyId: string): Promise<DeleteCompanyResponse> {
    return request<DeleteCompanyResponse>(`/api/companies/${encodeURIComponent(companyId)}`, {
      method: "DELETE"
    });
  },

  async listBlueprints(): Promise<BlueprintDefinition[]> {
    const response = await request<ListBlueprintsResponse>("/api/blueprints");
    return response.blueprints;
  },

  async createBlueprint(input: CreateBlueprintRequest): Promise<BlueprintDefinition> {
    const response = await request<BlueprintResponse>("/api/blueprints", {
      method: "POST",
      body: JSON.stringify(input satisfies CreateBlueprintRequest)
    });
    return response.blueprint;
  },

  async getBlueprint(id: string): Promise<BlueprintDefinition> {
    const response = await request<BlueprintResponse>(`/api/blueprints/${id}`);
    return response.blueprint;
  },

  async listBlueprintRuns(): Promise<ListBlueprintRunSummariesResponse["runs"]> {
    const response = await request<ListBlueprintRunSummariesResponse>("/api/blueprint-runs");
    return response.runs;
  },

  async getBlueprintRun(runId: string): Promise<BlueprintRunResponse["run"]> {
    const response = await request<BlueprintRunResponse>(`/api/blueprint-runs/${runId}`);
    return response.run;
  },

  async listPendingApprovals(): Promise<PendingApprovalItem[]> {
    const response = await request<ListPendingApprovalsResponse>("/api/approvals/pending");
    return response.approvals;
  },

  async listApprovalRequests(): Promise<ApprovalRequest[]> {
    const response = await request<ListApprovalRequestsResponse>("/api/approval-requests");
    return response.approvalRequests;
  },

  async listApprovalMessages(): Promise<ListApprovalMessagesResponse["messages"]> {
    const response = await request<ListApprovalMessagesResponse>("/api/approval-messages");
    return response.messages;
  },

  async approveApprovalRequest(approvalRequestId: string, comment?: string, selectedReplyId?: string): Promise<ApprovalRequestResponse> {
    return request<ApprovalRequestResponse>(`/api/approval-requests/${encodeURIComponent(approvalRequestId)}/approve`, {
      method: "POST",
      body: JSON.stringify({ comment, selectedReplyId })
    });
  },

  async rejectApprovalRequest(approvalRequestId: string, comment?: string): Promise<ApprovalRequestResponse> {
    return request<ApprovalRequestResponse>(`/api/approval-requests/${encodeURIComponent(approvalRequestId)}/reject`, {
      method: "POST",
      body: JSON.stringify({ comment })
    });
  },

  async replyToApprovalRequest(approvalRequestId: string, message: string): Promise<ApprovalRequestResponse> {
    return request<ApprovalRequestResponse>(`/api/approval-requests/${encodeURIComponent(approvalRequestId)}/reply`, {
      method: "POST",
      body: JSON.stringify({ message })
    });
  },

  async completeApprovalRequest(approvalRequestId: string, comment?: string): Promise<ApprovalRequestResponse> {
    return request<ApprovalRequestResponse>(`/api/approval-requests/${encodeURIComponent(approvalRequestId)}/complete`, {
      method: "POST",
      body: JSON.stringify({ comment })
    });
  },

  async terminateApprovalRequest(approvalRequestId: string, comment?: string): Promise<ApprovalRequestResponse> {
    return request<ApprovalRequestResponse>(`/api/approval-requests/${encodeURIComponent(approvalRequestId)}/terminate`, {
      method: "POST",
      body: JSON.stringify({ comment })
    });
  },

  async getRoleDirectory(): Promise<RoleDirectoryResponse> {
    return request<RoleDirectoryResponse>("/api/roles");
  },

  async saveArchitectureLayout(
    positions: SaveArchitectureBlueprintLayoutRequest["positions"]
  ): Promise<RoleDirectoryResponse> {
    return request<RoleDirectoryResponse>("/api/roles/architecture-layout", {
      method: "PUT",
      body: JSON.stringify({ positions } satisfies SaveArchitectureBlueprintLayoutRequest)
    });
  },

  async listInboxItems(): Promise<InboxItem[]> {
    const response = await request<{ items: InboxItem[] }>("/api/inbox");
    return response.items;
  },

  async createLeaderDelegation(input: CreateLeaderDelegationRequest): Promise<InboxItem> {
    const response = await request<InboxItemResponse>("/api/inbox/delegations", {
      method: "POST",
      body: JSON.stringify(input satisfies CreateLeaderDelegationRequest)
    });
    return response.item;
  },

  async createBlueprintProposal(input: CreateBlueprintProposalRequest): Promise<InboxItem> {
    const response = await request<InboxItemResponse>("/api/inbox/blueprint-proposals", {
      method: "POST",
      body: JSON.stringify(input satisfies CreateBlueprintProposalRequest)
    });
    return response.item;
  },

  async approveInboxItem(itemId: string, comment?: string): Promise<ApproveInboxItemResponse> {
    return request<ApproveInboxItemResponse>(`/api/inbox/${encodeURIComponent(itemId)}/approve`, {
      method: "POST",
      body: JSON.stringify({ comment })
    });
  },

  async rejectInboxItem(itemId: string, comment?: string): Promise<InboxItem> {
    const response = await request<InboxItemResponse>(`/api/inbox/${encodeURIComponent(itemId)}/reject`, {
      method: "POST",
      body: JSON.stringify({ comment })
    });
    return response.item;
  },

  async replyToInboxItem(itemId: string, message: string): Promise<InboxItem> {
    const response = await request<InboxItemResponse>(`/api/inbox/${encodeURIComponent(itemId)}/reply`, {
      method: "POST",
      body: JSON.stringify({ message } satisfies ReplyInboxItemRequest)
    });
    return response.item;
  },

  async saveBlueprint(blueprint: BlueprintDefinition): Promise<BlueprintDefinition> {
    const response = await request<BlueprintResponse>(`/api/blueprints/${blueprint.id}`, {
      method: "PUT",
      body: JSON.stringify({ blueprint } satisfies SaveBlueprintRequest)
    });
    return response.blueprint;
  },

  async deleteBlueprint(blueprintId: string): Promise<string> {
    const response = await request<DeleteBlueprintResponse>(`/api/blueprints/${blueprintId}`, {
      method: "DELETE"
    });
    return response.blueprintId;
  },

  async exportBlueprint(blueprintId: string): Promise<PortableBlueprintPackage> {
    const response = await request<ExportBlueprintResponse>(`/api/blueprints/${blueprintId}/export`);
    return response.blueprintPackage;
  },

  async importBlueprintPackage(blueprintPackage: PortableBlueprintPackage): Promise<BlueprintDefinition[]> {
    const response = await request<ImportBlueprintPackageResponse>("/api/blueprints/import", {
      method: "POST",
      body: JSON.stringify({ blueprintPackage } satisfies ImportBlueprintPackageRequest)
    });
    return response.blueprints;
  },

  async startBlueprintRun(blueprintId: string): Promise<StartBlueprintRunResponse["run"]> {
    const response = await request<StartBlueprintRunResponse>(`/api/blueprints/${blueprintId}/runs`, {
      method: "POST",
      body: JSON.stringify({ startedBy: "local-user" })
    });
    return response.run;
  },

  async getLatestBlueprintRun(blueprintId: string): Promise<StartBlueprintRunResponse["run"] | undefined> {
    const response = await request<LatestBlueprintRunResponse>(`/api/blueprints/${blueprintId}/runs/latest`);
    return response.run ?? undefined;
  },

  async approveBlueprintRun(
    runId: string,
    nodeRunId?: string,
    comment?: string,
    selectedReplyId?: string
  ): Promise<BlueprintRunResponse["run"]> {
    const response = await request<BlueprintRunResponse>(`/api/blueprint-runs/${runId}/approve`, {
      method: "POST",
      body: JSON.stringify({ nodeRunId, comment, selectedReplyId } satisfies ApproveBlueprintRunRequest)
    });
    return response.run;
  },

  async rejectBlueprintRun(runId: string, nodeRunId?: string, comment?: string): Promise<BlueprintRunResponse["run"]> {
    const response = await request<BlueprintRunResponse>(`/api/blueprint-runs/${runId}/reject`, {
      method: "POST",
      body: JSON.stringify({ nodeRunId, comment } satisfies RejectBlueprintRunRequest)
    });
    return response.run;
  },

  async replyToBlueprintRunApproval(runId: string, nodeRunId: string, message: string): Promise<BlueprintRunResponse["run"]> {
    const response = await request<BlueprintRunResponse>(`/api/blueprint-runs/${runId}/reply`, {
      method: "POST",
      body: JSON.stringify({ nodeRunId, message } satisfies ReplyBlueprintRunApprovalRequest)
    });
    return response.run;
  },

  async selectBlueprintRunApprovalReply(
    runId: string,
    nodeRunId: string,
    selectedReplyId: string
  ): Promise<BlueprintRunResponse["run"]> {
    const response = await request<BlueprintRunResponse>(`/api/blueprint-runs/${runId}/select-approval-reply`, {
      method: "POST",
      body: JSON.stringify({ nodeRunId, selectedReplyId } satisfies SelectBlueprintRunApprovalRequest)
    });
    return response.run;
  },

  async cancelBlueprintRun(runId: string): Promise<BlueprintRunResponse["run"]> {
    const response = await request<BlueprintRunResponse>(`/api/blueprint-runs/${runId}/cancel`, {
      method: "POST",
      body: JSON.stringify({})
    });
    return response.run;
  },

  async getCatalogSnapshot(): Promise<CatalogSnapshot> {
    const response = await request<CatalogSnapshotResponse>("/api/catalog/snapshot");
    return response.snapshot;
  },

  async refreshCatalog(): Promise<CatalogSnapshot> {
    const response = await request<CatalogSnapshotResponse>("/api/catalog/refresh", {
      method: "POST",
      body: JSON.stringify({})
    });
    return response.snapshot;
  },

  async getDashboardState(): Promise<WorkspaceDashboard> {
    const response = await request<DashboardStateResponse>("/api/dashboard-state");
    return response.dashboard;
  },

  async getRuntimeOverview(): Promise<RuntimeOverview> {
    const response = await request<RuntimeOverviewResponse>("/api/runtime-overview");
    return response.runtime;
  }
};

function consumeChatStreamBuffer(buffer: string, handlers: ChatStreamHandlers): string {
  const frames = buffer.split(/\n\n/);
  const remainder = frames.pop() ?? "";
  for (const frame of frames) {
    const event = readChatStreamFrame(frame);
    if (event) handlers.onEvent(event);
  }
  return remainder;
}

function readChatStreamFrame(frame: string): ChatStreamEvent | undefined {
  const data = frame
    .split(/\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return undefined;
  return JSON.parse(data) as ChatStreamEvent;
}
