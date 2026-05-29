import { spawn } from "node:child_process";
import { nanoid } from "nanoid";
import type {
  AgentSdkProvider,
  AgentTaskResult,
  ChatPermissionMode,
  ChatStreamEvent,
  StartAgentTaskInput,
  StartedAgentTaskResult,
  WaitForAgentTaskInput
} from "@hiveward/shared";
import { buildSdkChatPrompt } from "./chat-envelope";
import { formatAgentSdkError, formatAgentSdkProviderError, getErrorMessage, isAbortLikeError } from "./errors";
import { normalizePermissionProfile } from "./permissions";
import { buildPromptEnvelope, validateOutputSchema } from "./prompt-envelope";
import { createTerminalTaskResult, AgentSdkTaskRegistry } from "./task-registry";
import type { AgentSdkChatStreamInput, AgentSdkRuntime } from "./types";
import { resolveSdkWorkingDirectory } from "./workspace";

export type CliHarnessId = Extract<AgentSdkProvider, "google" | "cursor" | "opencode" | "hermes">;

export interface CliCommandInput {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface CliCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: NodeJS.Signals | null;
}

export type RunCliCommand = (input: CliCommandInput) => Promise<CliCommandResult>;

type CliStreamParser = {
  push(chunk: string): string[];
  finish(stdout: string): { output: string; sessionKey?: string };
};

export class CliAgentSdkRuntime implements AgentSdkRuntime {
  private readonly config: CliHarnessConfig;

  constructor(
    private readonly registry: AgentSdkTaskRegistry,
    private readonly options: { defaultTimeoutMs: number; workspaceRoot: string },
    private readonly harnessId: CliHarnessId,
    private readonly runCliCommand: RunCliCommand = runCliCommandWithSpawn,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {
    this.config = cliHarnessConfigs[harnessId];
  }

  async streamChatMessage(input: AgentSdkChatStreamInput, onEvent: (event: ChatStreamEvent) => void): Promise<void> {
    const now = new Date().toISOString();
    const taskId = `${this.harnessId}-chat-${nanoid(10)}`;
    const runId = `${this.harnessId}-chat-run-${nanoid(10)}`;
    let sessionKey = input.sessionKey || "";
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort("timeout"), normalizeTimeout(input.timeoutMs, this.options.defaultTimeoutMs));
    let streamedOutput = "";

    onEvent({
      type: "started",
      taskId,
      runId,
      sessionKey,
      source: this.harnessId,
      status: "running",
      updatedAt: now
    });

    try {
      const prompt = buildSdkChatPrompt(input.message, input.attachments);
      const streamParser = createCliStreamParser(this.harnessId);
      const command = await this.resolveCommand({
        profileId: input.profileId,
        cwd: this.options.workspaceRoot,
        signal: abortController.signal
      });
      const result = await this.runCliCommand({
        command,
        args: buildCliChatArgs(this.harnessId, {
          prompt,
          workingDirectory: this.options.workspaceRoot,
          modelId: input.modelId,
          sessionKey: input.sessionKey,
          permissionMode: input.permissionMode,
          skillIds: input.skillIds
        }),
        cwd: this.options.workspaceRoot,
        env: this.env,
        signal: abortController.signal,
        onStdout: (chunk) => {
          for (const delta of streamParser.push(chunk)) {
            streamedOutput = `${streamedOutput}${delta}`;
            onEvent({ type: "delta", text: delta });
          }
        }
      });
      if (result.exitCode !== 0) {
        throw new Error(formatCliFailure(result));
      }

      const parsed = streamParser.finish(result.stdout);
      const output = parsed.output;
      sessionKey = parsed.sessionKey ?? extractCliSessionKey(result.stdout, sessionKey);
      if (output && output !== streamedOutput) {
        if (!streamedOutput || output.startsWith(streamedOutput)) {
          const delta = output.slice(streamedOutput.length);
          if (delta) onEvent({ type: "delta", text: delta });
        }
      }
      onEvent({
        type: "done",
        taskId,
        runId,
        sessionKey,
        source: this.harnessId,
        status: "succeeded",
        output,
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      const cancelled = isAbortLikeError(error) || abortController.signal.aborted;
      onEvent({
        type: "done",
        taskId,
        runId,
        sessionKey,
        source: this.harnessId,
        status: cancelled ? "cancelled" : "failed",
        error: cancelled
          ? formatAgentSdkError("cancelled", "Run was cancelled.")
          : formatAgentSdkProviderError(formatCliHarnessLabel(this.harnessId), error),
        updatedAt: new Date().toISOString()
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async startTask(input: StartAgentTaskInput): Promise<StartedAgentTaskResult> {
    const now = new Date().toISOString();
    const taskId = `${this.harnessId}-task-${nanoid(10)}`;
    const runId = `${this.harnessId}-run-${nanoid(10)}`;
    const sessionKey = `${this.harnessId}-session-${input.nodeRunId}`;

    let workingDirectory: string;
    try {
      workingDirectory = resolveSdkWorkingDirectory(input.workingDirectory, this.options.workspaceRoot);
    } catch (error) {
      return this.failedStart(taskId, runId, sessionKey, getErrorMessage(error), now);
    }

    const timeoutMs = normalizeTimeout(input.timeoutMs, this.options.defaultTimeoutMs);
    const abortController = new AbortController();
    let timedOut = false;
    const final = this.registry.runWithConcurrency(() =>
      this.runCliTask({
        input,
        taskId,
        runId,
        sessionKey,
        workingDirectory,
        abortController,
        isTimedOut: () => timedOut
      })
    );
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort("timeout");
    }, timeoutMs);

    this.registry.register({
      taskId,
      runId,
      provider: this.harnessId,
      nodeRunId: input.nodeRunId,
      blueprintRunId: input.blueprintRunId,
      sessionKey,
      startedAt: now,
      abortController,
      timeout,
      final
    });

    return {
      taskId,
      runId,
      sessionKey,
      source: this.harnessId,
      status: "running",
      updatedAt: now
    };
  }

  waitForTask(input: WaitForAgentTaskInput): Promise<AgentTaskResult> {
    return this.registry.waitForTask(input);
  }

  cancelTask(input: WaitForAgentTaskInput): Promise<AgentTaskResult> {
    return this.registry.cancelTask(input);
  }

  private async runCliTask({
    input,
    taskId,
    runId,
    sessionKey,
    workingDirectory,
    abortController,
    isTimedOut
  }: {
    input: StartAgentTaskInput;
    taskId: string;
    runId: string;
    sessionKey: string;
    workingDirectory: string;
    abortController: AbortController;
    isTimedOut: () => boolean;
  }): Promise<AgentTaskResult> {
    try {
      if (abortController.signal.aborted) {
        return this.cancelledResult(taskId, runId, sessionKey, isTimedOut());
      }

      const permissionProfile = normalizePermissionProfile(input.permissionProfile);
      const prompt = buildPromptEnvelope(input);
      const command = await this.resolveCommand({
        profileId: input.profileId,
        cwd: workingDirectory,
        signal: abortController.signal
      });
      const result = await this.runCliCommand({
        command,
        args: buildCliTaskArgs(this.harnessId, {
          prompt,
          workingDirectory,
          modelId: input.modelId,
          agentId: input.agentId,
          agentName: input.agentName,
          workspaceWrite: permissionProfile === "workspace_write",
          skillIds: input.skillIds
        }),
        cwd: workingDirectory,
        env: this.env,
        signal: abortController.signal
      });
      if (result.exitCode !== 0) {
        return createTerminalTaskResult({
          taskId,
          runId,
          sessionKey,
          source: this.harnessId,
          status: "failed",
          error: formatAgentSdkProviderError(formatCliHarnessLabel(this.harnessId), formatCliFailure(result))
        });
      }

      const parsed = parseCliCommandOutput(this.harnessId, result.stdout);
      const output = parsed.output;
      const finalSessionKey = parsed.sessionKey ?? extractCliSessionKey(result.stdout, sessionKey);
      if (!validateOutputSchema(output, input.outputSchema)) {
        return createTerminalTaskResult({
          taskId,
          runId,
          sessionKey: finalSessionKey,
          source: this.harnessId,
          status: "failed",
          error: formatAgentSdkError("invalid_output", "CLI output does not match outputSchema.")
        });
      }

      return {
        taskId,
        runId,
        sessionKey: finalSessionKey,
        source: this.harnessId,
        status: "succeeded",
        output,
        updatedAt: new Date().toISOString()
      };
    } catch (error) {
      if (isAbortLikeError(error) || abortController.signal.aborted) {
        return this.cancelledResult(taskId, runId, sessionKey, isTimedOut());
      }
      return createTerminalTaskResult({
        taskId,
        runId,
        sessionKey,
        source: this.harnessId,
        status: "failed",
        error: formatAgentSdkProviderError(formatCliHarnessLabel(this.harnessId), error)
      });
    }
  }

  private failedStart(taskId: string, runId: string, sessionKey: string, error: string, updatedAt: string): StartedAgentTaskResult {
    return {
      taskId,
      runId,
      sessionKey,
      source: this.harnessId,
      status: "failed",
      error,
      updatedAt
    };
  }

  private cancelledResult(taskId: string, runId: string, sessionKey: string, timedOut: boolean): AgentTaskResult {
    return createTerminalTaskResult({
      taskId,
      runId,
      sessionKey,
      source: this.harnessId,
      status: "cancelled",
      error: timedOut ? formatAgentSdkError("timeout", "Run exceeded timeoutMs.") : formatAgentSdkError("cancelled", "Run was cancelled.")
    });
  }

  private async resolveCommand(input: { profileId?: string; cwd: string; signal: AbortSignal }): Promise<string> {
    if (this.harnessId !== "hermes") return this.config.command;
    const profileId = normalizeHermesProfileId(input.profileId);
    if (!profileId) return this.config.command;
    return resolveHermesProfileCommand({
      profileId,
      defaultCommand: this.config.command,
      runCliCommand: this.runCliCommand,
      cwd: input.cwd,
      env: this.env,
      signal: input.signal
    });
  }
}

interface CliHarnessConfig {
  id: CliHarnessId;
  label: string;
  command: string;
}

const cliHarnessConfigs: Record<CliHarnessId, CliHarnessConfig> = {
  google: {
    id: "google",
    label: "Google CLI Beta",
    command: "gemini"
  },
  cursor: {
    id: "cursor",
    label: "Cursor CLI Beta",
    command: "cursor-agent"
  },
  opencode: {
    id: "opencode",
    label: "OpenCode Beta",
    command: "opencode"
  },
  hermes: {
    id: "hermes",
    label: "Hermes Beta",
    command: "hermes"
  }
};

function buildCliChatArgs(
  harnessId: CliHarnessId,
  input: {
    prompt: string;
    workingDirectory: string;
    modelId?: string;
    sessionKey?: string;
    permissionMode?: ChatPermissionMode;
    skillIds?: string[];
  }
): string[] {
  if (harnessId === "google") {
    return [
      ...(input.sessionKey ? ["--resume", input.sessionKey] : []),
      ...modelArgs("--model", input.modelId),
      ...googleApprovalArgs(input.permissionMode === "full_access" ? "full_access" : "read_only"),
      "--prompt",
      input.prompt
    ];
  }

  if (harnessId === "cursor") {
    return [
      "--print",
      "--output-format",
      "stream-json",
      ...modelArgs("--model", input.modelId),
      ...(input.sessionKey ? ["--resume", input.sessionKey] : []),
      ...(input.permissionMode === "full_access" ? ["--force"] : []),
      input.prompt
    ];
  }

  if (harnessId === "opencode") {
    return [
      "run",
      "--dir",
      input.workingDirectory,
      ...modelArgs("--model", input.modelId),
      ...(input.sessionKey ? ["--session", input.sessionKey] : ["--title", "HiveWard chat"]),
      ...(input.permissionMode === "full_access" ? ["--dangerously-skip-permissions"] : []),
      input.prompt
    ];
  }

  return [
    ...(input.sessionKey ? ["--resume", input.sessionKey] : []),
    "chat",
    ...modelArgs("--model", input.modelId),
    ...(input.permissionMode === "full_access" ? ["--yolo"] : []),
    ...skillArgs(input.skillIds),
    "-q",
    input.prompt
  ];
}

function buildCliTaskArgs(
  harnessId: CliHarnessId,
  input: {
    prompt: string;
    workingDirectory: string;
    modelId?: string;
    agentId?: string;
    agentName: string;
    workspaceWrite: boolean;
    skillIds?: string[];
  }
): string[] {
  if (harnessId === "google") {
    return [
      ...modelArgs("--model", input.modelId),
      ...googleApprovalArgs(input.workspaceWrite ? "workspace_write" : "read_only"),
      "--prompt",
      input.prompt
    ];
  }

  if (harnessId === "cursor") {
    return [
      "--print",
      "--output-format",
      "stream-json",
      ...modelArgs("--model", input.modelId),
      ...(input.workspaceWrite ? ["--force"] : []),
      input.prompt
    ];
  }

  if (harnessId === "opencode") {
    return [
      "run",
      "--dir",
      input.workingDirectory,
      ...modelArgs("--model", input.modelId),
      ...(input.agentId ? ["--agent", input.agentId] : []),
      "--title",
      input.agentName,
      ...(input.workspaceWrite ? ["--dangerously-skip-permissions"] : []),
      input.prompt
    ];
  }

  return [
    "chat",
    ...modelArgs("--model", input.modelId),
    ...(input.workspaceWrite ? ["--yolo"] : []),
    ...skillArgs(input.skillIds),
    "-q",
    input.prompt
  ];
}

function googleApprovalArgs(permission: "read_only" | "workspace_write" | "full_access"): string[] {
  if (permission === "full_access") return ["--approval-mode", "yolo"];
  if (permission === "workspace_write") return ["--approval-mode", "auto_edit"];
  return [];
}

function modelArgs(flag: string, modelId: string | undefined): string[] {
  const trimmed = modelId?.trim();
  return trimmed && trimmed !== "inherit" ? [flag, trimmed] : [];
}

function skillArgs(skillIds: string[] | undefined): string[] {
  return (skillIds ?? []).flatMap((skillId) => ["-s", skillId]);
}

function normalizeHermesProfileId(profileId: string | undefined): string | undefined {
  const trimmed = profileId?.trim();
  if (!trimmed || trimmed === "default") return undefined;
  return /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : undefined;
}

type HermesProfileCommandOption = {
  id: string;
  alias?: string;
};

async function resolveHermesProfileCommand(input: {
  profileId: string;
  defaultCommand: string;
  runCliCommand: RunCliCommand;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}): Promise<string> {
  const result = await input.runCliCommand({
    command: input.defaultCommand,
    args: ["profile", "list"],
    cwd: input.cwd,
    env: input.env,
    signal: input.signal
  });
  if (result.exitCode !== 0) {
    throw new Error(`Hermes profile list failed: ${formatCliFailure(result)}`);
  }

  const profiles = parseHermesProfileCommandOptions(result.stdout || result.stderr || "");
  const profile = profiles.find((item) => item.id === input.profileId);
  if (profile?.alias) return profile.alias;

  throw new Error(
    profile
      ? `Hermes profile "${input.profileId}" does not have an executable alias. Create one before using it in HiveWard.`
      : `Hermes profile "${input.profileId}" was not found.`
  );
}

function parseHermesProfileCommandOptions(output: string): HermesProfileCommandOption[] {
  const profiles: HermesProfileCommandOption[] = [];
  const seen = new Set<string>();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("Profile") || line.startsWith("─")) continue;
    const normalized = line.replace(/^◆\s*/, "").trim();
    const [id, _modelId, _gateway, alias] = normalized.split(/\s+/);
    if (!id || id === "Profile" || seen.has(id)) continue;
    seen.add(id);
    profiles.push({
      id,
      alias: alias && !isMissingHermesProfileCell(alias) ? alias : undefined
    });
  }
  return profiles;
}

function isMissingHermesProfileCell(value: string): boolean {
  return value === "-" || value === "—";
}

function runCliCommandWithSpawn(input: CliCommandInput): Promise<CliCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      signal: input.signal,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`;
      input.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`;
      input.onStderr?.(chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      resolve({ stdout, stderr, exitCode: exitCode ?? (signal ? 1 : 0), signal });
    });
  });
}

function normalizeCliOutput(output: string): string {
  return output.replace(/\s+$/g, "");
}

function createCliStreamParser(harnessId: CliHarnessId): CliStreamParser {
  if (harnessId === "cursor") return new CursorStreamParser();
  return new PlainTextStreamParser();
}

function parseCliCommandOutput(harnessId: CliHarnessId, stdout: string): { output: string; sessionKey?: string } {
  const parser = createCliStreamParser(harnessId);
  parser.push(stdout);
  return parser.finish(stdout);
}

class PlainTextStreamParser implements CliStreamParser {
  private output = "";

  push(chunk: string): string[] {
    this.output = `${this.output}${chunk}`;
    return chunk ? [chunk] : [];
  }

  finish(stdout: string): { output: string; sessionKey?: string } {
    return {
      output: normalizeCliOutput(this.output || stdout),
      sessionKey: extractCliSessionKey(stdout, "") || undefined
    };
  }
}

class CursorStreamParser implements CliStreamParser {
  private buffer = "";
  private output = "";
  private resultOutput = "";
  private sessionKey: string | undefined;

  push(chunk: string): string[] {
    this.buffer = `${this.buffer}${chunk}`;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    return lines.flatMap((line) => this.parseLine(line));
  }

  finish(stdout: string): { output: string; sessionKey?: string } {
    const deltas = this.buffer ? this.parseLine(this.buffer) : [];
    this.buffer = "";
    if (!this.resultOutput && !this.output && deltas.length > 0) {
      this.output = `${this.output}${deltas.join("")}`;
    }
    return {
      output: normalizeCliOutput(this.resultOutput || this.output || stdout),
      sessionKey: (this.sessionKey ?? extractCliSessionKey(stdout, "")) || undefined
    };
  }

  private parseLine(line: string): string[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    const event = parseJsonObject(trimmed);
    if (!event) return [line];

    const sessionKey = readString(event.session_id) ?? readString(event.sessionId);
    if (sessionKey) this.sessionKey = sessionKey;

    if (event.type === "result") {
      const result = readString(event.result);
      if (result) this.resultOutput = result;
      return [];
    }

    if (event.type !== "assistant") return [];
    const text = readCursorMessageText(event.message);
    if (!text) return [];
    this.output = `${this.output}${text}`;
    return [text];
  }
}

function readCursorMessageText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const content = value.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((item) => {
      if (typeof item === "string") return item;
      if (!isRecord(item)) return "";
      return readString(item.text) ?? "";
    })
    .join("");
  return text || undefined;
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractCliSessionKey(output: string, fallback: string): string {
  const resumeMatch = /(?:--resume|--session)\s+([A-Za-z0-9_.:-]+)/.exec(output);
  const sessionMatch = /Session:\s*([A-Za-z0-9_.:-]+)/.exec(output);
  const jsonSessionMatch =
    /"session_id"\s*:\s*"([^"]+)"/.exec(output) ??
    /"sessionId"\s*:\s*"([^"]+)"/.exec(output) ??
    /"session"\s*:\s*"([^"]+)"/.exec(output);
  return resumeMatch?.[1] ?? sessionMatch?.[1] ?? jsonSessionMatch?.[1] ?? fallback;
}

function formatCliFailure(result: CliCommandResult): string {
  const detail = normalizeCliOutput([result.stderr, result.stdout].filter(Boolean).join("\n"));
  return detail || `CLI exited with code ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}.`;
}

function formatCliHarnessLabel(harnessId: CliHarnessId): string {
  return cliHarnessConfigs[harnessId].label;
}

function normalizeTimeout(value: number | undefined, defaultValue: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : defaultValue;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
