import type {
  AgentTaskResult,
  ChatStreamEvent,
  StartAgentTaskInput,
  StartedAgentTaskResult,
  WaitForAgentTaskInput
} from "@hiveward/shared";
import { ClaudeAgentSdkRuntime } from "./claude-runtime";
import { CliAgentSdkRuntime } from "./cli-runtime";
import { CodexAgentSdkRuntime } from "./codex-runtime";
import { AgentSdkTaskRegistry } from "./task-registry";
import type { AgentSdkChatStreamInput, AgentSdkRuntime, AgentSdkRuntimeOptions } from "./types";
import { isAgentSdkProvider } from "./types";

export class AgentSdkRuntimeRouter implements AgentSdkRuntime {
  constructor(private readonly runtimes: Record<"claude" | "codex" | "google" | "cursor" | "opencode" | "hermes", AgentSdkRuntime>) {}

  streamChatMessage(input: AgentSdkChatStreamInput, onEvent: (event: ChatStreamEvent) => void): Promise<void> {
    return this.runtimes[input.source].streamChatMessage(input, onEvent);
  }

  streamTask(input: StartAgentTaskInput, onEvent: (event: ChatStreamEvent) => void): Promise<AgentTaskResult> {
    if (!isAgentSdkProvider(input.source)) {
      throw new Error("SDK runtime requires claude or codex source.");
    }
    return this.runtimes[input.source].streamTask(input, onEvent);
  }

  startTask(input: StartAgentTaskInput): Promise<StartedAgentTaskResult> {
    if (!isAgentSdkProvider(input.source)) {
      throw new Error("SDK runtime requires claude or codex source.");
    }
    return this.runtimes[input.source].startTask(input);
  }

  waitForTask(input: WaitForAgentTaskInput): Promise<AgentTaskResult> {
    if (isAgentSdkProvider(input.source)) {
      return this.runtimes[input.source].waitForTask(input);
    }
    throw new Error(`Unknown SDK task source: ${input.source}`);
  }

  cancelTask(input: WaitForAgentTaskInput): Promise<AgentTaskResult> {
    if (isAgentSdkProvider(input.source)) {
      return this.runtimes[input.source].cancelTask(input);
    }
    throw new Error(`Unknown SDK task source: ${input.source}`);
  }
}

export function createAgentSdkRuntime(
  options: AgentSdkRuntimeOptions,
  env: NodeJS.ProcessEnv = process.env
): AgentSdkRuntime {
  const registry = new AgentSdkTaskRegistry(options.maxConcurrency);
  return new AgentSdkRuntimeRouter({
    claude: new ClaudeAgentSdkRuntime(registry, options),
    codex: new CodexAgentSdkRuntime(registry, options, undefined, env),
    google: new CliAgentSdkRuntime(registry, options, "google", undefined, env),
    cursor: new CliAgentSdkRuntime(registry, options, "cursor", undefined, env),
    opencode: new CliAgentSdkRuntime(registry, options, "opencode", undefined, env),
    hermes: new CliAgentSdkRuntime(registry, options, "hermes", undefined, env)
  });
}
