import type { CatalogSnapshot } from "./catalog";
import type { CompanyOverview } from "./company";
import type {
  OpenClawExecutionStatus,
  OpenClawConfigState,
  OpenClawModelUsageSummary,
  OpenClawObjectSource,
  OpenClawSessionSummary,
  ChatThinkingEffort,
  OpenClawTaskSummary,
  OpenClawUsageFact,
  OpenClawVersionInfo
} from "./openclaw";
import type { AgentRuntimeId, PortableBlueprintPackage, BlueprintDefinition, BlueprintRunSummary, BlueprintRunView } from "./blueprint";
import type { PendingApprovalItem, InboxItem, WorkspaceDashboard } from "./workspace";
import type { ApprovalDecision, ApprovalRequest, ManagerMail } from "./lifecycle";
import type { ArchitectureBlueprintView, ChatRoleScope, CompanyRoleDirectory } from "./roles";

export interface ListBlueprintsResponse {
  blueprints: BlueprintDefinition[];
}

export interface CreateBlueprintRequest {
  name?: string;
  description?: string;
}

export interface BlueprintResponse {
  blueprint: BlueprintDefinition;
}

export interface DeleteBlueprintResponse {
  blueprintId: string;
}

export interface SaveBlueprintRequest {
  blueprint: BlueprintDefinition;
}

export interface ExportBlueprintResponse {
  blueprintPackage: PortableBlueprintPackage;
}

export interface ImportBlueprintPackageRequest {
  blueprintPackage: PortableBlueprintPackage;
}

export interface ImportBlueprintPackageResponse {
  blueprints: BlueprintDefinition[];
}

export interface StartBlueprintRunRequest {
  startedBy?: string;
}

export interface StartBlueprintRunResponse {
  run: BlueprintRunView;
}

export interface LatestBlueprintRunResponse {
  run: BlueprintRunView | null;
}

export interface BlueprintRunResponse {
  run: BlueprintRunView;
}

export interface ListBlueprintRunSummariesResponse {
  runs: BlueprintRunSummary[];
}

export interface ListPendingApprovalsResponse {
  approvals: PendingApprovalItem[];
}

export interface ListApprovalRequestsResponse {
  approvalRequests: ApprovalRequest[];
}

export interface ApprovalRequestResponse {
  approvalRequest: ApprovalRequest;
  decision?: ApprovalDecision;
  nextApprovalRequest?: ApprovalRequest;
  run?: BlueprintRunView;
}

export interface ReplyApprovalRequestRequest {
  message: string;
}

export interface CompleteApprovalRequestRequest {
  comment?: string;
}

export interface TerminateApprovalRequestRequest {
  comment?: string;
}

export interface ListApprovalMessagesResponse {
  messages: ManagerMail[];
}

export interface RoleDirectoryResponse {
  roles: CompanyRoleDirectory;
  architecture: ArchitectureBlueprintView;
}

export interface SaveArchitectureBlueprintLayoutRequest {
  positions: Record<string, ArchitectureBlueprintView["nodes"][number]["position"]>;
}

export interface ListInboxItemsResponse {
  items: InboxItem[];
}

export interface CreateLeaderDelegationRequest {
  leaderId: string;
  blueprintId?: string;
  title?: string;
  summary?: string;
  createdByRoleId?: string;
}

export interface CreateBlueprintProposalRequest {
  title: string;
  summary: string;
  blueprintId?: string;
  blueprintPackage: PortableBlueprintPackage;
  preview?: Record<string, unknown>;
  diffSummary?: string;
  createdByRoleId?: string;
  targetRoleId?: string;
  runtimeId?: AgentRuntimeId;
}

export interface InboxItemResponse {
  item: InboxItem;
}

export interface ApproveInboxItemRequest {
  comment?: string;
}

export interface RejectInboxItemRequest {
  comment?: string;
}

export interface ReplyInboxItemRequest {
  message: string;
}

export interface ApproveInboxItemResponse {
  item: InboxItem;
  importedBlueprints?: BlueprintDefinition[];
}

export interface ApproveBlueprintRunRequest {
  nodeRunId?: string;
  comment?: string;
  selectedReplyId?: string;
}

export interface SelectBlueprintRunApprovalRequest {
  nodeRunId: string;
  selectedReplyId: string;
}

export interface RejectBlueprintRunRequest {
  nodeRunId?: string;
  comment?: string;
}

export interface ReplyBlueprintRunApprovalRequest {
  nodeRunId: string;
  message: string;
}

export interface DashboardStateResponse {
  dashboard: WorkspaceDashboard;
}

export interface SaveDashboardStateRequest {
  dashboard: WorkspaceDashboard;
}

export interface CompanyDirectoryResponse {
  companies: CompanyOverview[];
  selectedCompanyId?: string;
}

export interface CreateCompanyRequest {
  name?: string;
  businessGoal?: string;
  logoLabel?: string;
  logoUrl?: string;
}

export interface UpdateCompanyRequest {
  name?: string;
  businessGoal?: string;
  logoLabel?: string;
  logoUrl?: string;
}

export interface SelectCompanyRequest {
  companyId?: string;
}

export interface DeleteCompanyResponse extends CompanyDirectoryResponse {
  deleted: boolean;
}

export type HarnessId = "openclaw" | "claudeCode" | "codex" | "google" | "cursor" | "opencode" | "hermes";

export type HarnessConnectionState = "connected" | "available" | "needs_config" | "unavailable";

export interface HarnessStatusCheck {
  id: string;
  label: string;
  status: "pass" | "warning" | "fail";
  detail: string;
}

export interface HarnessModelOption {
  id: string;
  label: string;
  provider?: string;
  description?: string;
  thinkingLevels?: ChatThinkingEffort[];
  isDefault?: boolean;
}

export interface HarnessProfileOption {
  id: string;
  label: string;
  alias?: string;
  modelId?: string;
  provider?: string;
  path?: string;
  workspace?: string;
  isDefault?: boolean;
}

export interface HarnessStatus {
  id: HarnessId;
  label: string;
  defaultModelId?: string;
  models?: HarnessModelOption[];
  profiles?: HarnessProfileOption[];
  installed: boolean;
  environmentOk: boolean;
  connectionState: HarnessConnectionState;
  summary: string;
  checkedAt: string;
  checks: HarnessStatusCheck[];
}

export interface HarnessStatusResponse {
  statuses: HarnessStatus[];
}

export interface HermesChannelOption {
  profileId?: string;
  platform: string;
  id: string;
  name: string;
  type?: string;
  threadId?: string;
}

export interface HermesSkillOption {
  id: string;
  label: string;
  path: string;
  profileId?: string;
}

export interface HermesConfigResponse {
  homePath: string;
  configPath: string;
  channelDirectoryPath: string;
  profiles: HarnessProfileOption[];
  channels: HermesChannelOption[];
  skills: HermesSkillOption[];
}

export interface CreateHermesProfileRequest {
  name: string;
  description?: string;
  cloneFrom?: string;
  createAlias?: boolean;
}

export interface CreateHermesChannelRequest {
  platform: string;
  id: string;
  name?: string;
  type?: string;
  threadId?: string;
}

export type ClaudeCodeModelPresetCategory =
  | "official"
  | "cn_official"
  | "aggregator"
  | "third_party"
  | "cloud_provider";

export type ClaudeCodeAuthEnvKey = "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY";

export type ClaudeCodePresetExtraEnvValue = string | number | boolean;

export type ClaudeCodeModelPresetPlanType = "coding_plan" | "token_plan";

export interface ClaudeCodeModelPreset {
  id: string;
  name: string;
  category: ClaudeCodeModelPresetCategory;
  websiteUrl?: string;
  apiKeyUrl?: string;
  baseUrl?: string;
  authEnvKey?: ClaudeCodeAuthEnvKey;
  planType?: ClaudeCodeModelPresetPlanType;
  planProvider?: string;
  fallbackModelId?: string;
  haikuModelId?: string;
  sonnetModelId?: string;
  opusModelId?: string;
  extraEnv?: Record<string, ClaudeCodePresetExtraEnvValue>;
}

export interface ClaudeCodeModelConfig {
  configPath: string;
  providerPresetId?: string;
  providerPresetName?: string;
  baseUrl?: string;
  authEnvKey?: ClaudeCodeAuthEnvKey;
  authConfigured?: boolean;
  extraEnv?: Record<string, ClaudeCodePresetExtraEnvValue>;
  fallbackModelId?: string;
  haikuModelId?: string;
  haikuModelName?: string;
  sonnetModelId?: string;
  sonnetModelName?: string;
  opusModelId?: string;
  opusModelName?: string;
}

export interface ClaudeCodeSavedModelProfile {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  providerPresetId?: string;
  providerPresetName?: string;
  baseUrl?: string;
  authEnvKey?: ClaudeCodeAuthEnvKey;
  authConfigured?: boolean;
  extraEnv?: Record<string, ClaudeCodePresetExtraEnvValue>;
  fallbackModelId?: string;
  haikuModelId?: string;
  haikuModelName?: string;
  sonnetModelId?: string;
  sonnetModelName?: string;
  opusModelId?: string;
  opusModelName?: string;
}

export interface UpdateClaudeCodeModelConfigRequest {
  presetId?: string;
  baseUrl?: string;
  authEnvKey?: ClaudeCodeAuthEnvKey;
  authValue?: string;
  extraEnv?: Record<string, ClaudeCodePresetExtraEnvValue | undefined>;
  fallbackModelId?: string;
  haikuModelId?: string;
  haikuModelName?: string;
  sonnetModelId?: string;
  sonnetModelName?: string;
  opusModelId?: string;
  opusModelName?: string;
}

export interface SaveClaudeCodeModelProfileRequest {
  name?: string;
}

export interface ClaudeCodeModelConfigResponse {
  config: ClaudeCodeModelConfig;
  presets: ClaudeCodeModelPreset[];
  savedProfiles: ClaudeCodeSavedModelProfile[];
}

export type HarnessSkillId = "hiveward-ceo" | "hiveward-leader" | "hiveward-skill-decomposer";

export type HarnessSkillInstallStatus = "installed" | "missing" | "stale" | "unsupported" | "error";

export type HarnessSkillInstallCandidateSource =
  | "environment"
  | "existing_install"
  | "existing_root"
  | "project"
  | "default";

export interface HarnessSkillInstallCandidate {
  root: string;
  source: HarnessSkillInstallCandidateSource;
  label: string;
  exists: boolean;
  hasHiveWardSkills: boolean;
  selected: boolean;
}

export interface HarnessSkillStatusItem {
  id: HarnessSkillId;
  label: string;
  sourcePath: string;
  targetPath?: string;
  installed: boolean;
  status: HarnessSkillInstallStatus;
  sourceHash?: string;
  installedHash?: string;
  error?: string;
}

export interface HarnessSkillStatusResponse {
  harnessId: HarnessId;
  supported: boolean;
  checkedAt: string;
  installRoot?: string;
  installCandidates?: HarnessSkillInstallCandidate[];
  skills: HarnessSkillStatusItem[];
}

export interface InstallHarnessSkillsResponse extends HarnessSkillStatusResponse {
  installedCount: number;
}

export interface ChatAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  text?: string;
  truncated?: boolean;
}

export interface ChatHistoryMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  attachments?: ChatAttachment[];
}

export type ChatSessionStatus = "active" | "ended" | "native_missing" | "failed";

export type ChatNativeSessionState = "unknown" | "resumable" | "missing";

export type ChatMessageStatus = "sent" | "streaming" | "failed";

export type ChatMode = "chat" | "blueprint" | "skill_split";
export type ChatPermissionMode = "safe" | "full_access";

export interface ChatRuntimeRef {
  taskId: string;
  runId: string;
  sessionKey: string;
  source: OpenClawObjectSource;
  status: string;
  updatedAt: string;
  error?: string;
  usage?: OpenClawUsageFact;
  timings?: ChatStreamTimings;
}

export interface HivewardChatSession {
  id: string;
  companyId?: string;
  harnessId: HarnessId;
  roleScope?: ChatRoleScope;
  title: string;
  nativeSessionId?: string;
  nativeSessionState?: ChatNativeSessionState;
  modelId?: string;
  agentId?: string;
  thinkingEffort?: ChatThinkingEffort;
  permissionMode: ChatPermissionMode;
  mode: ChatMode;
  status: ChatSessionStatus;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

export interface HivewardChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  attachments?: ChatAttachment[];
  harnessId: HarnessId;
  modelId?: string;
  nativeMessageId?: string;
  status: ChatMessageStatus;
  runtimeRef?: ChatRuntimeRef;
  createdAt: string;
  updatedAt?: string;
}

export interface SendChatSessionMessageRequest {
  message: string;
  attachments?: ChatAttachment[];
  modelId?: string;
  agentId?: string;
  thinkingEffort?: ChatThinkingEffort;
  permissionMode?: ChatPermissionMode;
  includePlatformContext?: boolean;
  mode?: ChatMode;
  roleScope?: ChatRoleScope;
  rebuildFromHivewardHistory?: boolean;
}

export interface CreateChatSessionRequest {
  agentId?: string;
  parentSessionKey?: string;
  roleScope?: ChatRoleScope;
}

export interface CreateChatSessionResponse {
  sessionKey: string;
  sessionId?: string;
  title?: string;
}

export interface UpdateChatSessionTitleRequest {
  sessionKey: string;
  title: string;
}

export interface UpdateChatSessionTitleResponse {
  sessionKey: string;
  title: string;
}

export interface CreateHivewardChatSessionRequest {
  harnessId: HarnessId;
  title?: string;
  nativeSessionId?: string;
  modelId?: string;
  agentId?: string;
  thinkingEffort?: ChatThinkingEffort;
  permissionMode?: ChatPermissionMode;
  mode?: ChatMode;
  roleScope?: ChatRoleScope;
}

export interface UpdateHivewardChatSessionRequest {
  title?: string;
  nativeSessionId?: string;
  nativeSessionState?: ChatNativeSessionState;
  modelId?: string;
  agentId?: string;
  thinkingEffort?: ChatThinkingEffort;
  permissionMode?: ChatPermissionMode;
  mode?: ChatMode;
  roleScope?: ChatRoleScope;
  status?: ChatSessionStatus;
}

export interface ListChatSessionsResponse {
  sessions: HivewardChatSession[];
}

export interface HivewardChatSessionResponse {
  session: HivewardChatSession;
}

export interface ChatSessionMessagesResponse {
  messages: HivewardChatMessage[];
}

export interface ChatStreamTimings {
  totalMs: number;
  hivewardPreprocessMs: number;
  openclawMs: number;
  hivewardPostprocessMs: number;
  inboxSubmissionMs?: number;
  openclawAcceptedMs?: number;
  openclawFirstDeltaMs?: number;
}

export type ChatStreamEvent =
  | {
      type: "started";
      taskId: string;
      runId: string;
      sessionKey: string;
      source: OpenClawObjectSource;
      status: OpenClawExecutionStatus;
      updatedAt: string;
    }
  | {
      type: "delta";
      text: string;
      replace?: boolean;
    }
  | {
      type: "runtime_state";
      source: OpenClawObjectSource;
      phase: "thinking" | "tool" | "command";
      label: string;
    }
  | {
      type: "done";
      taskId: string;
      runId: string;
      sessionKey: string;
      source: OpenClawObjectSource;
      status: OpenClawExecutionStatus;
      output?: string;
      error?: string;
      usage?: OpenClawUsageFact;
      timings?: ChatStreamTimings;
      updatedAt: string;
    }
  | {
      type: "inbox_item_created";
      item: InboxItem;
      message: string;
    }
  | {
      type: "error";
      message: string;
    };

export interface ChatSessionHistoryResponse {
  messages: ChatHistoryMessage[];
  inboxItems?: InboxItem[];
}

export interface OpenClawConfigResponse {
  config: OpenClawConfigState;
}

export type OpenClawWizardValue = string | number | boolean | undefined;

export interface OpenClawWizardFieldOption {
  value: string;
  label: string;
  hint?: string;
}

export interface OpenClawWizardFieldVisibility {
  fieldId: string;
  equals: OpenClawWizardValue;
}

export interface OpenClawWizardField {
  id: string;
  label: string;
  type: "text" | "password" | "number" | "select" | "checkbox";
  required?: boolean;
  placeholder?: string;
  hint?: string;
  defaultValue?: OpenClawWizardValue;
  options?: OpenClawWizardFieldOption[];
  visibleWhen?: OpenClawWizardFieldVisibility;
}

export interface OpenClawModelAuthMethodOption {
  id: string;
  label: string;
  hint?: string;
  kind: "api_key" | "oauth" | "device_code" | "token" | "local" | "custom";
  choiceId?: string;
  fields: OpenClawWizardField[];
  submitLabel?: string;
}

export interface OpenClawModelAuthProviderOption {
  id: string;
  label: string;
  hint?: string;
  methods: OpenClawModelAuthMethodOption[];
}

export interface OpenClawChannelSetupOption {
  id: string;
  label: string;
  hint?: string;
  fields: OpenClawWizardField[];
}

export interface OpenClawConfigWizardMetadata {
  modelProviders: OpenClawModelAuthProviderOption[];
  channels: OpenClawChannelSetupOption[];
}

export interface OpenClawConfigWizardResponse {
  wizard: OpenClawConfigWizardMetadata;
}

export interface OpenClawVersionResponse {
  version: OpenClawVersionInfo;
}

export type HivewardUpdateSource = "git" | "npm";

export interface HivewardUpdateStatus {
  source: HivewardUpdateSource;
  currentVersion: string;
  latestVersion?: string;
  currentCommit?: string;
  latestCommit?: string;
  currentBranch?: string;
  remoteBranch?: string;
  remoteUrl?: string;
  repositoryUrl: string;
  registryUrl?: string;
  distTag?: string;
  checkedAt: string;
  updateAvailable: boolean;
  canApply: boolean;
  applyCommand: string;
  restartRequired: boolean;
  error?: string;
}

export interface HivewardUpdateResponse {
  update: HivewardUpdateStatus;
}

export interface ApplyHivewardUpdateResponse {
  update: HivewardUpdateStatus;
  applied: boolean;
  output: string;
}

export interface ConfigureOpenClawModelAuthRequest {
  providerId: string;
  methodId: string;
  values: Record<string, OpenClawWizardValue>;
}

export interface ConfigureOpenClawChannelRequest {
  channelId: string;
  values: Record<string, OpenClawWizardValue>;
}

export interface UpdateOpenClawDefaultModelRequest {
  modelId: string;
}

export interface CreateOpenClawModelRequest {
  provider: string;
  modelId: string;
  label?: string;
  alias?: string;
  api?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  contextWindow?: number;
  maxTokens?: number;
  setDefault?: boolean;
}

export interface CreateOpenClawAgentRequest {
  name: string;
  workspace?: string;
  modelId?: string;
}

export interface CreateOpenClawChannelRequest {
  channel: string;
  account?: string;
  name?: string;
  useEnv?: boolean;
  token?: string;
  botToken?: string;
  appToken?: string;
  password?: string;
  secret?: string;
  url?: string;
  baseUrl?: string;
  dbPath?: string;
  httpHost?: string;
  httpPort?: string;
  httpUrl?: string;
  cliPath?: string;
  authDir?: string;
  region?: string;
  service?: string;
  signalNumber?: string;
  tokenFile?: string;
  secretFile?: string;
}

export interface RuntimeOverview {
  sessions: OpenClawSessionSummary[];
  tasks: OpenClawTaskSummary[];
}

export interface RuntimeOverviewResponse {
  runtime: RuntimeOverview;
}

export interface OpenClawModelUsageResponse {
  usage: OpenClawModelUsageSummary[];
}

export interface CatalogSnapshotResponse {
  snapshot: CatalogSnapshot;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}
