import type { RuntimeAccessPolicy } from "./lifecycle";

export type AgentSdkProvider = "claude" | "codex" | "google" | "cursor" | "opencode" | "hermes";
export type AgentPermissionProfile = "read_only" | "workspace_write";
export type RuntimeObjectSource = "openclaw" | AgentSdkProvider;

export interface RuntimeObjectRef {
  source: RuntimeObjectSource;
  sourceId: string;
  sourceUpdatedAt: string;
  taskId?: string;
  runId?: string;
  sessionKey?: string;
  messageId?: string;
  usageRef?: string;
}

export type ChatThinkingEffort = "off" | "minimal" | "low" | "medium" | "high" | "adaptive" | "xhigh" | "max";

export interface RuntimeModel {
  id: string;
  label: string;
  provider: string;
  supportsTools: boolean;
  contextWindow?: number;
  thinkingLevels?: ChatThinkingEffort[];
}

export interface RuntimeTool {
  id: string;
  label: string;
  description: string;
  category: string;
}

export interface RuntimeChannel {
  id: string;
  label: string;
  status: "available" | "not_configured" | "disabled";
}

export interface RuntimeAgent {
  id: string;
  label: string;
  workspace?: string;
  runtimeId?: string;
  modelId?: string;
}

export interface RuntimeSessionSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface RuntimeTaskSummary {
  id: string;
  title: string;
  status: RuntimeExecutionStatus;
  updatedAt: string;
}

export type RuntimeExecutionStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RuntimeUsageFact {
  id: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  recordedAt: string;
}

export interface StartAgentTaskInput {
  blueprintRunId: string;
  nodeRunId: string;
  source: RuntimeObjectSource;
  agentId?: string;
  profileId?: string;
  agentName: string;
  prompt: string;
  modelId?: string;
  permissionProfile?: AgentPermissionProfile;
  workingDirectory?: string;
  timeoutMs?: number;
  outputSchema?: Record<string, unknown>;
  runtimeAccessPolicy?: RuntimeAccessPolicy;
  input: unknown;
  skillIds?: string[];
  tools: string[];
}

export interface StartedAgentTaskResult {
  taskId: string;
  runId: string;
  sessionKey: string;
  source: RuntimeObjectSource;
  status: RuntimeExecutionStatus;
  error?: string;
  updatedAt: string;
}

export interface WaitForAgentTaskInput {
  nodeRunId: string;
  taskId: string;
  runId: string;
  sessionKey: string;
  source: RuntimeObjectSource;
  agentId?: string;
  modelId?: string;
}

export interface AgentTaskResult extends StartedAgentTaskResult {
  output?: unknown;
  usage?: RuntimeUsageFact;
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
