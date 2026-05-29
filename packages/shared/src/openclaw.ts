import type {
  ChatThinkingEffort,
  RuntimeAgent,
  RuntimeChannel,
  RuntimeExecutionStatus,
  RuntimeModel,
  RuntimeObjectRef,
  RuntimeObjectSource,
  RuntimeSessionSummary,
  RuntimeTaskSummary,
  RuntimeTool,
  RuntimeUsageFact
} from "./runtime";

export type OpenClawObjectSource = RuntimeObjectSource;
export type OpenClawObjectRef = RuntimeObjectRef;
export type OpenClawModel = RuntimeModel;
export type OpenClawTool = RuntimeTool;
export type OpenClawChannel = RuntimeChannel;
export type OpenClawAgent = RuntimeAgent;
export type OpenClawSessionSummary = RuntimeSessionSummary;
export type OpenClawTaskSummary = RuntimeTaskSummary;
export type OpenClawExecutionStatus = RuntimeExecutionStatus;
export type OpenClawUsageFact = RuntimeUsageFact;

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
