import type {
  AgentHandoff,
  AgentHumanReport,
  AgentRuntimeId,
  ArchitectureBlueprintView,
  ApprovalDecision,
  ApprovalRequest,
  Artifact,
  BlueprintDefinition,
  BlueprintImportDefaults,
  BlueprintNodeEvent,
  BlueprintNodeRun,
  BlueprintRun,
  BlueprintRunArchive,
  BlueprintRunSummary,
  BlueprintRunView,
  CatalogSnapshot,
  ChatRoleScope,
  CompanyOverview,
  CompanyRoleDirectory,
  CreateHivewardChatSessionRequest,
  HarnessId,
  HivewardChatMessage,
  HivewardChatSession,
  InboxItem,
  IterationRound,
  IterationSession,
  ManagerContextSnapshot,
  ManagerMail,
  PortableBlueprintPackage,
  ReleaseReport,
  RoleDriverBinding,
  RunTimelineItem,
  UpdateHivewardChatSessionRequest,
  WorkspaceDashboard
} from "@hiveward/shared";

export type BlueprintSkillSourceSnapshot = {
  skillSourceId: string;
  blueprintId: string;
  workingDirectory: string;
  sourceCompleteness: "full_package" | "markdown_only" | "partial_package" | "unknown";
  capturedFiles: string[];
  fileHashes: Record<string, string>;
  scriptInventory: Array<{
    path: string;
    runtime: "node" | "python" | "bash" | "unknown";
    sizeBytes: number;
    sha256: string;
    shouldExecuteByDefault: false;
  }>;
};

export type ClaimNodeRunResult = {
  claimed: boolean;
  nodeRun?: BlueprintNodeRun;
  workerEpoch?: number;
  leaseExpiresAt?: string;
};

export type NodeRunTransitionInput = {
  nodeRunId: string;
  owner: string;
  workerEpoch: number;
};

export type CompleteNodeRunInput = NodeRunTransitionInput & {
  nodeRun: BlueprintNodeRun;
};

export type FailNodeRunInput = NodeRunTransitionInput & {
  endedAt?: string;
  error: string;
};

export type CancelNodeRunInput = NodeRunTransitionInput & {
  endedAt?: string;
  reason: string;
  runtimeRef?: BlueprintNodeRun["runtimeRef"];
};

export type PublishAgentOutputInput = NodeRunTransitionInput & {
  runId: string;
  roundId?: string;
  nodeRun: BlueprintNodeRun;
  output: unknown;
  rawResult?: unknown;
  usage?: unknown;
  artifacts: Artifact[];
  humanReport?: AgentHumanReport;
  handoff?: AgentHandoff;
  event: BlueprintNodeEvent;
  timelineItems?: Array<Omit<RunTimelineItem, "sequence"> & { sequence?: number }>;
};

export type PublishAgentOutputResult = {
  published: boolean;
};

export type ApplyApprovalDecisionInput = {
  approvalRequestId: string;
  expectedStatus: "pending";
  nextRequest: ApprovalRequest;
  decision: ApprovalDecision;
  nextApprovalRequest?: ApprovalRequest;
  releaseReport?: ReleaseReport;
  timelineItem?: Omit<RunTimelineItem, "sequence"> & { sequence?: number };
};

export type ApplyApprovalDecisionResult =
  | { status: "applied"; approvalRequest: ApprovalRequest; decision: ApprovalDecision; nextApprovalRequest?: ApprovalRequest }
  | { status: "conflict"; approvalRequest?: ApprovalRequest };

export type ApplyInboxDecisionInput = {
  inboxItemId: string;
  approvalRequestId?: string;
  action: "approve" | "reject" | "reply";
  comment?: string;
  defaults?: BlueprintImportDefaults;
  approvalDecision?: ApprovalDecision;
  approvalTimelineItem?: Omit<RunTimelineItem, "sequence"> & { sequence?: number };
};

export type ApplyInboxDecisionResult =
  | { status: "applied"; item: InboxItem; importedBlueprints?: BlueprintDefinition[] }
  | { status: "conflict"; item?: InboxItem };

export interface HivewardStore {
  getDataDir(): string;
  init(): Promise<void>;

  listCompanies(): Promise<{ companies: CompanyOverview[]; selectedCompanyId?: string }>;
  createCompany(input: { name?: string; businessGoal?: string; logoLabel?: string; logoUrl?: string }): Promise<{
    companies: CompanyOverview[];
    selectedCompanyId?: string;
  }>;
  updateCompany(
    companyId: string,
    input: { name?: string; businessGoal?: string; logoLabel?: string; logoUrl?: string }
  ): Promise<{ companies: CompanyOverview[]; selectedCompanyId?: string }>;
  selectCompany(companyId?: string): Promise<{ companies: CompanyOverview[]; selectedCompanyId?: string }>;
  deleteCompany(companyId: string): Promise<{ companies: CompanyOverview[]; selectedCompanyId?: string; deleted: boolean }>;

  listBlueprints(): Promise<BlueprintDefinition[]>;
  getBlueprint(id: string): Promise<BlueprintDefinition | undefined>;
  getBlueprintWorkspacePath(id: string): string;
  saveBlueprint(blueprint: BlueprintDefinition): Promise<BlueprintDefinition>;
  createBlueprint(input?: { name?: string; description?: string }): Promise<BlueprintDefinition>;
  deleteBlueprint(id: string): Promise<boolean>;
  importBlueprintPackage(
    blueprintPackage: PortableBlueprintPackage,
    defaults?: BlueprintImportDefaults
  ): Promise<BlueprintDefinition[]>;
  storeBlueprintSkillSource(input: {
    blueprintId: string;
    sourcePath: string;
    sourceLabel?: string;
    skillSourceId?: string;
    skillIr?: unknown;
  }): Promise<BlueprintSkillSourceSnapshot>;

  getRoleDirectory(): Promise<{ roles: CompanyRoleDirectory; architecture: ArchitectureBlueprintView }>;
  saveArchitectureLayout(
    positions: Record<string, ArchitectureBlueprintView["nodes"][number]["position"]>
  ): Promise<{ roles: CompanyRoleDirectory; architecture: ArchitectureBlueprintView }>;

  listInboxItems(): Promise<InboxItem[]>;
  createLeaderDelegationRequest(input: {
    leaderId: string;
    blueprintId?: string;
    title?: string;
    summary?: string;
    createdByRoleId?: string;
  }): Promise<InboxItem>;
  createBlueprintProposal(input: {
    title: string;
    summary: string;
    blueprintId?: string;
    blueprintPackage?: PortableBlueprintPackage;
    preview?: Record<string, unknown>;
    diffSummary?: string;
    createdByRoleId?: string;
    targetRoleId?: string;
    runtimeId?: AgentRuntimeId;
  }): Promise<InboxItem>;
  approveInboxItem(
    itemId: string,
    defaults?: BlueprintImportDefaults,
    comment?: string
  ): Promise<{ item: InboxItem; importedBlueprints?: BlueprintDefinition[] }>;
  rejectInboxItem(itemId: string, comment?: string): Promise<InboxItem>;
  replyToInboxItem(itemId: string, message: string): Promise<InboxItem>;
  applyInboxDecision(input: ApplyInboxDecisionInput): Promise<ApplyInboxDecisionResult>;

  createBlueprintRun(blueprint: BlueprintDefinition, startedBy: string): Promise<BlueprintRun>;
  updateBlueprintRun(run: BlueprintRun): Promise<void>;
  getBlueprintRun(id: string): Promise<BlueprintRun | undefined>;
  createQueuedNodeRun(nodeRun: BlueprintNodeRun): Promise<BlueprintNodeRun>;
  claimNodeRun(input: { nodeRunId: string; owner: string; leaseMs: number }): Promise<ClaimNodeRunResult>;
  renewNodeRunLease(input: { nodeRunId: string; owner: string; workerEpoch: number; leaseMs: number }): Promise<boolean>;
  startNodeRun(input: NodeRunTransitionInput & { startedAt?: string; input?: unknown; runtimeRef?: BlueprintNodeRun["runtimeRef"] }): Promise<boolean>;
  completeNodeRun(input: CompleteNodeRunInput): Promise<boolean>;
  failNodeRun(input: FailNodeRunInput): Promise<boolean>;
  cancelNodeRun(input: CancelNodeRunInput): Promise<boolean>;
  publishAgentOutput(input: PublishAgentOutputInput): Promise<PublishAgentOutputResult>;
  upsertNodeRun(nodeRun: BlueprintNodeRun): Promise<void>;
  listNodeRuns(blueprintRunId: string): Promise<BlueprintNodeRun[]>;
  appendEvent(event: BlueprintNodeEvent): Promise<void>;
  getRunView(blueprintRunId: string): Promise<BlueprintRunView | undefined>;
  getLatestRunViewForBlueprint(blueprintId: string): Promise<BlueprintRunView | undefined>;
  listRunSummaries(): Promise<BlueprintRunSummary[]>;
  listRunViews(): Promise<BlueprintRunView[]>;
  listRunArchives(): Promise<BlueprintRunArchive[]>;

  listPendingApprovals(): Promise<import("@hiveward/shared").PendingApprovalItem[]>;
  listApprovalRequests(filter?: { runId?: string; status?: ApprovalRequest["status"] }): Promise<ApprovalRequest[]>;
  getApprovalRequest(id: string): Promise<ApprovalRequest | undefined>;
  upsertApprovalRequest(request: ApprovalRequest): Promise<ApprovalRequest>;
  appendApprovalDecision(decision: ApprovalDecision): Promise<ApprovalDecision>;
  applyApprovalDecision(input: ApplyApprovalDecisionInput): Promise<ApplyApprovalDecisionResult>;
  listApprovalDecisions(approvalRequestId?: string): Promise<ApprovalDecision[]>;

  listIterationSessions(runId?: string): Promise<IterationSession[]>;
  upsertIterationSession(session: IterationSession): Promise<IterationSession>;
  listIterationRounds(filter?: { runId?: string; sessionId?: string; status?: IterationRound["status"] }): Promise<IterationRound[]>;
  upsertIterationRound(round: IterationRound): Promise<IterationRound>;

  listArtifacts(runId?: string): Promise<Artifact[]>;
  upsertArtifact(artifact: Artifact): Promise<Artifact>;
  listReleaseReports(runId?: string): Promise<ReleaseReport[]>;
  upsertReleaseReport(report: ReleaseReport): Promise<ReleaseReport>;
  listAgentHumanReports(runId?: string): Promise<AgentHumanReport[]>;
  upsertAgentHumanReport(report: AgentHumanReport): Promise<AgentHumanReport>;
  listAgentHandoffs(runId?: string): Promise<AgentHandoff[]>;
  upsertAgentHandoff(handoff: AgentHandoff): Promise<AgentHandoff>;
  listManagerContextSnapshots(runId?: string): Promise<ManagerContextSnapshot[]>;
  upsertManagerContextSnapshot(snapshot: ManagerContextSnapshot): Promise<ManagerContextSnapshot>;
  appendRunTimelineItem(item: Omit<RunTimelineItem, "sequence"> & { sequence?: number }): Promise<RunTimelineItem>;
  listRunTimeline(runId: string): Promise<RunTimelineItem[]>;
  listManagerMail(runId?: string): Promise<ManagerMail[]>;
  replaceManagerMail(mail: ManagerMail[], scope?: { runId?: string }): Promise<ManagerMail[]>;

  getDashboardState(): Promise<WorkspaceDashboard>;
  saveDashboardState(dashboard: WorkspaceDashboard): Promise<WorkspaceDashboard>;
  saveCatalogSnapshot(snapshot: CatalogSnapshot): Promise<CatalogSnapshot>;
  getCatalogSnapshot(): Promise<CatalogSnapshot | undefined>;

  listChatSessions(): Promise<HivewardChatSession[]>;
  getChatSession(id: string): Promise<HivewardChatSession | undefined>;
  findChatSessionByNative(input: { harnessId: HarnessId; nativeSessionId: string }): Promise<HivewardChatSession | undefined>;
  createChatSession(input: CreateHivewardChatSessionRequest): Promise<HivewardChatSession>;
  updateChatSession(id: string, patch: UpdateHivewardChatSessionRequest): Promise<HivewardChatSession | undefined>;
  endChatSession(id: string): Promise<HivewardChatSession | undefined>;
  listChatMessages(sessionId: string): Promise<HivewardChatMessage[]>;
  appendChatMessage(
    input: Omit<HivewardChatMessage, "id" | "createdAt" | "updatedAt"> & {
      id?: string;
      createdAt?: string;
      updatedAt?: string;
    }
  ): Promise<HivewardChatMessage>;
  updateChatMessage(
    sessionId: string,
    messageId: string,
    patch: Partial<Pick<HivewardChatMessage, "content" | "status" | "runtimeRef" | "nativeMessageId" | "modelId">>
  ): Promise<HivewardChatMessage | undefined>;
}
