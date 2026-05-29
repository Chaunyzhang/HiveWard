export type AgentSdkProvider = "claude" | "codex" | "google" | "cursor" | "opencode" | "hermes";
export type AgentPermissionProfile = "read_only" | "workspace_write";
export type OpenClawObjectSource = "openclaw" | AgentSdkProvider;
export type RuntimeFilesystemPolicy = "read_only" | "workspace_write";
export type RuntimeNetworkPolicy = "disabled" | "enabled";
export type RuntimeWebSearchPolicy = "disabled" | "live";

export interface OpenClawObjectRef {
  source: OpenClawObjectSource;
  sourceId: string;
  sourceUpdatedAt: string;
  taskId?: string;
  runId?: string;
  sessionKey?: string;
  messageId?: string;
  usageRef?: string;
}

export type ChatThinkingEffort = "off" | "minimal" | "low" | "medium" | "high" | "adaptive" | "xhigh" | "max";

export interface OpenClawModel {
  id: string;
  label: string;
  provider: string;
  supportsTools: boolean;
  contextWindow?: number;
  thinkingLevels?: ChatThinkingEffort[];
}

export interface OpenClawTool {
  id: string;
  label: string;
  description: string;
  category: string;
}

export interface OpenClawChannel {
  id: string;
  label: string;
  status: "available" | "not_configured" | "disabled";
}

export interface OpenClawAgent {
  id: string;
  label: string;
  workspace?: string;
  runtimeId?: string;
  modelId?: string;
}

export interface OpenClawConfiguredModel {
  id: string;
  label: string;
  provider: string;
  alias?: string;
  thinkingLevels?: ChatThinkingEffort[];
}

export interface OpenClawConfiguredAgent {
  id: string;
  name?: string;
  workspace: string;
  agentDir: string;
  modelId?: string;
  isDefault: boolean;
}

export interface OpenClawConfiguredChannelAccount {
  id: string;
  name?: string;
  enabled: boolean;
  credentialKeys: string[];
  isDefault: boolean;
}

export interface OpenClawConfiguredChannel {
  id: string;
  label: string;
  enabled: boolean;
  accounts: OpenClawConfiguredChannelAccount[];
}

export interface OpenClawConfigState {
  configPath: string;
  defaultWorkspace: string;
  defaultModelId?: string;
  gateway?: OpenClawGatewaySettingsSummary;
  configuredModels: OpenClawConfiguredModel[];
  configuredAgents: OpenClawConfiguredAgent[];
  configuredChannels: OpenClawConfiguredChannel[];
}

export interface OpenClawGatewaySettingsSummary {
  url?: string;
  origin?: string;
  locale: string;
  requestTimeoutMs: number;
  agentStartTimeoutMs: number;
  tokenConfigured: boolean;
  passwordConfigured: boolean;
  source: "environment" | "config" | "none";
}

export interface OpenClawVersionInfo {
  version?: string;
  raw?: string;
  resolvedAt: string;
  error?: string;
}

export interface OpenClawSessionSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface OpenClawTaskSummary {
  id: string;
  title: string;
  status: OpenClawExecutionStatus;
  updatedAt: string;
}

export type OpenClawExecutionStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface OpenClawUsageFact {
  id: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  recordedAt: string;
}

export interface OpenClawModelUsageDay {
  date: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  calls: number;
}

export interface OpenClawModelUsageSummary {
  modelId: string;
  days: OpenClawModelUsageDay[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  calls: number;
}

export interface StartAgentTaskInput {
  blueprintRunId: string;
  nodeRunId: string;
  source: OpenClawObjectSource;
  agentId?: string;
  profileId?: string;
  agentName: string;
  prompt: string;
  modelId?: string;
  permissionProfile?: AgentPermissionProfile;
  workingDirectory?: string;
  timeoutMs?: number;
  outputSchema?: Record<string, unknown>;
  runtimeAccessPolicy?: {
    filesystem: RuntimeFilesystemPolicy;
    network: RuntimeNetworkPolicy;
    webSearch: RuntimeWebSearchPolicy;
  };
  input: unknown;
  skillIds?: string[];
  tools: string[];
}

export interface StartedAgentTaskResult {
  taskId: string;
  runId: string;
  sessionKey: string;
  source: OpenClawObjectSource;
  status: OpenClawExecutionStatus;
  error?: string;
  updatedAt: string;
}

export interface WaitForAgentTaskInput {
  nodeRunId: string;
  taskId: string;
  runId: string;
  sessionKey: string;
  source: OpenClawObjectSource;
  agentId?: string;
  modelId?: string;
}

export interface AgentTaskResult extends StartedAgentTaskResult {
  output?: unknown;
  usage?: OpenClawUsageFact;
}

export interface SendChannelInput {
  channelId: string;
  target: string;
  body: string;
  blueprintRunId: string;
  nodeRunId: string;
}

export interface SendChannelResult {
  deliveryId: string;
  status: "sent" | "failed";
  updatedAt: string;
}
