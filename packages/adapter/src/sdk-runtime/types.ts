import type {
  AgentSdkProvider,
  AgentTaskResult,
  ChatAttachment,
  ChatPermissionMode,
  ChatStreamEvent,
  ChatThinkingEffort,
  HarnessSkillId,
  StartAgentTaskInput,
  StartedAgentTaskResult,
  WaitForAgentTaskInput
} from "@hiveward/shared";
import { resolve } from "node:path";

export interface AgentSdkRuntime {
  streamChatMessage(input: AgentSdkChatStreamInput, onEvent: (event: ChatStreamEvent) => void): Promise<void>;
  startTask(input: StartAgentTaskInput): Promise<StartedAgentTaskResult>;
  waitForTask(input: WaitForAgentTaskInput): Promise<AgentTaskResult>;
  cancelTask(input: WaitForAgentTaskInput): Promise<AgentTaskResult>;
}

export interface AgentSdkChatStreamInput {
  source: AgentSdkProvider;
  sessionKey: string;
  message: string;
  attachments: ChatAttachment[];
  modelId?: string;
  thinking?: ChatThinkingEffort;
  permissionMode?: ChatPermissionMode;
  idempotencyKey: string;
  timeoutMs?: number;
  skillIds?: HarnessSkillId[];
  profileId?: string;
}

export interface AgentSdkTaskRecord {
  taskId: string;
  runId: string;
  provider: AgentSdkProvider;
  nodeRunId: string;
  blueprintRunId: string;
  sessionKey: string;
  startedAt: string;
  abortController: AbortController;
  timeout?: ReturnType<typeof setTimeout>;
  final: Promise<AgentTaskResult>;
}

export interface AgentSdkRuntimeOptions {
  defaultTimeoutMs: number;
  maxConcurrency: number;
  workspaceRoot: string;
}

export function isAgentSdkProvider(value: unknown): value is AgentSdkProvider {
  return value === "claude" || value === "codex" || value === "google" || value === "cursor" || value === "opencode" || value === "hermes";
}

export function readAgentSdkRuntimeOptions(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): AgentSdkRuntimeOptions {
  return {
    defaultTimeoutMs: readPositiveInteger(env.HIVEWARD_AGENT_SDK_TASK_TIMEOUT_MS, 3_600_000),
    maxConcurrency: readPositiveInteger(env.HIVEWARD_AGENT_SDK_MAX_CONCURRENCY, 2),
    workspaceRoot: resolve(workspaceRoot)
  };
}

function readPositiveInteger(value: string | undefined, defaultValue: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}
