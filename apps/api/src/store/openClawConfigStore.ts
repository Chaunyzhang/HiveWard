import { execFile } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  ConfigureOpenClawChannelRequest,
  ConfigureOpenClawModelAuthRequest,
  CreateOpenClawAgentRequest,
  CreateOpenClawChannelRequest,
  CreateOpenClawModelRequest,
  OpenClawConfigWizardMetadata,
  OpenClawConfigState,
  OpenClawConfiguredAgent,
  OpenClawConfiguredChannel,
  OpenClawConfiguredModel,
  OpenClawGatewaySettingsSummary,
  ChatThinkingEffort,
  OpenClawVersionInfo
} from "@hiveward/shared";
import {
  buildChannelRequest,
  buildModelAuthRequest,
  getOpenClawConfigWizardMetadata
} from "./openClawConfigWizard";

const execFileAsync = promisify(execFile);

type ConfigObject = Record<string, unknown>;
type OpenClawProviderConfig = ConfigObject & {
  models?: Array<ConfigObject & { id?: string; name?: string }>;
};

interface OpenClawConfigFile {
  agent?: {
    model?: string | { primary?: string };
  };
  agents?: {
    defaults?: {
      workspace?: string;
      models?: Record<string, { alias?: string }>;
      model?: string | { primary?: string };
    };
    list?: Array<{
      id?: string;
      default?: boolean;
      name?: string;
      workspace?: string;
      agentDir?: string;
      model?: string | { primary?: string };
    }>;
  };
  models?: {
    providers?: Record<string, OpenClawProviderConfig>;
  };
  gateway?: {
    port?: number;
    remote?: {
      url?: string;
      token?: string;
      password?: string;
    };
    auth?: {
      token?: string;
      password?: string;
    };
  };
  channels?: Record<string, unknown>;
  [key: string]: unknown;
}

export class OpenClawConfigStore {
  private readonly configPath: string;

  constructor(configPath = resolveOpenClawConfigPath()) {
    this.configPath = configPath;
  }

  async getState(): Promise<OpenClawConfigState> {
    const config = await this.readConfig();
    return this.toState(config);
  }

  async getVersion(): Promise<OpenClawVersionInfo> {
    const resolvedAt = new Date().toISOString();
    try {
      const raw = await runOpenClawCli(["--version"], { timeoutMs: 15_000 });
      return {
        version: parseOpenClawVersion(raw),
        raw: raw || undefined,
        resolvedAt
      };
    } catch (error) {
      return {
        resolvedAt,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  getWizardMetadata(): OpenClawConfigWizardMetadata {
    return getOpenClawConfigWizardMetadata();
  }

  async updateDefaultModel(modelId: string): Promise<OpenClawConfigState> {
    await writeDefaultModel(modelId);
    return this.getState();
  }

  async configureModelAuth(input: ConfigureOpenClawModelAuthRequest): Promise<OpenClawConfigState> {
    return this.addModel(buildModelAuthRequest(input));
  }

  async addModel(input: CreateOpenClawModelRequest): Promise<OpenClawConfigState> {
    const provider = normalizeProviderId(input.provider);
    const modelId = normalizeModelId(provider, input.modelId);
    if (!provider) {
      throw new Error("Model provider is required.");
    }
    if (!modelId) {
      throw new Error("Model id is required.");
    }

    const config = await this.readConfig();
    const existingProvider = getProviderConfig(config, provider);
    const existingModels = (existingProvider.models ?? []).filter(isConfigObject);
    const existingModel = existingModels.find((model) => readString(model.id) === modelId);
    const nextModel: ConfigObject = {
      ...(existingModel ?? {}),
      id: modelId
    };
    const label = readString(input.label);
    if (label) nextModel.name = label;
    else if (!readString(nextModel.name)) nextModel.name = modelId;
    if (isPositiveNumber(input.contextWindow)) nextModel.contextWindow = input.contextWindow;
    if (isPositiveNumber(input.maxTokens)) nextModel.maxTokens = input.maxTokens;

    const nextProvider: OpenClawProviderConfig = {
      ...existingProvider,
      models: [...existingModels.filter((model) => readString(model.id) !== modelId), nextModel]
    };
    const api = readString(input.api);
    if (api) nextProvider.api = api;
    const baseUrl = readString(input.baseUrl);
    if (baseUrl) nextProvider.baseUrl = baseUrl;
    const apiKeyEnv = readString(input.apiKeyEnv);
    const apiKey = readString(input.apiKey);
    if (apiKeyEnv) {
      nextProvider.apiKey = { source: "env", provider: "default", id: apiKeyEnv };
    } else if (apiKey) {
      nextProvider.apiKey = apiKey;
    }

    await runOpenClawCli(
      ["config", "set", `models.providers.${provider}`, JSON.stringify(nextProvider), "--strict-json"],
      { timeoutMs: 300_000 }
    );

    const fullModelId = `${provider}/${modelId}`;
    const alias = readString(input.alias);
    if (alias) {
      await runOpenClawCli(
        ["config", "set", `agents.defaults.models["${escapeConfigPathKey(fullModelId)}"].alias`, JSON.stringify(alias), "--strict-json"],
        { timeoutMs: 120_000 }
      );
    }
    if (input.setDefault) {
      await writeDefaultModel(fullModelId);
    }

    return this.getState();
  }

  async addAgent(input: CreateOpenClawAgentRequest): Promise<OpenClawConfigState> {
    if (!input.name.trim()) {
      throw new Error("Agent name is required.");
    }
    const config = await this.readConfig();
    const agentId = normalizeAgentId(input.name);
    const workspace = input.workspace?.trim() || resolveSuggestedWorkspace(config, agentId);
    const args = [
      "agents",
      "add",
      input.name.trim(),
      "--non-interactive",
      "--workspace",
      workspace,
      "--json"
    ];
    if (input.modelId?.trim()) {
      args.push("--model", input.modelId.trim());
    }

    await runOpenClawCli(args, { timeoutMs: 300_000 });
    return this.getState();
  }

  async addChannel(input: CreateOpenClawChannelRequest): Promise<OpenClawConfigState> {
    const channel = normalizeChannelId(input.channel);
    if (!channel) {
      throw new Error("Channel is required.");
    }

    const args = ["channels", "add", "--channel", channel];
    pushOptionalArg(args, "--account", input.account);
    pushOptionalArg(args, "--name", input.name);
    if (input.useEnv) args.push("--use-env");
    pushOptionalArg(args, "--token", input.token);
    pushOptionalArg(args, "--bot-token", input.botToken);
    pushOptionalArg(args, "--app-token", input.appToken);
    pushOptionalArg(args, "--password", input.password);
    pushOptionalArg(args, "--secret", input.secret);
    pushOptionalArg(args, "--url", input.url);
    pushOptionalArg(args, "--base-url", input.baseUrl);
    pushOptionalArg(args, "--db-path", input.dbPath);
    pushOptionalArg(args, "--http-host", input.httpHost);
    pushOptionalArg(args, "--http-port", input.httpPort);
    pushOptionalArg(args, "--http-url", input.httpUrl);
    pushOptionalArg(args, "--cli-path", input.cliPath);
    pushOptionalArg(args, "--auth-dir", input.authDir);
    pushOptionalArg(args, "--region", input.region);
    pushOptionalArg(args, "--service", input.service);
    pushOptionalArg(args, "--signal-number", input.signalNumber);
    pushOptionalArg(args, "--token-file", input.tokenFile);
    pushOptionalArg(args, "--secret-file", input.secretFile);

    await runOpenClawCli(args, { timeoutMs: 300_000 });
    return this.getState();
  }

  async configureChannel(input: ConfigureOpenClawChannelRequest): Promise<OpenClawConfigState> {
    return this.addChannel(buildChannelRequest(input));
  }

  private async readConfig(): Promise<OpenClawConfigFile> {
    try {
      const raw = await readFile(this.configPath, "utf8");
      return JSON.parse(raw) as OpenClawConfigFile;
    } catch {
      return {};
    }
  }

  private toState(config: OpenClawConfigFile): OpenClawConfigState {
    const defaultWorkspace = resolveDefaultWorkspace(config);
    const defaultModelId = resolveModelId(config.agents?.defaults?.model) ?? resolveModelId(config.agent?.model);

    return {
      configPath: this.configPath,
      defaultWorkspace,
      defaultModelId,
      gateway: summarizeGatewaySettings(config),
      configuredModels: collectConfiguredModels(config, defaultModelId),
      configuredAgents: buildConfiguredAgents(config, defaultWorkspace, defaultModelId),
      configuredChannels: collectConfiguredChannels(config)
    };
  }
}

function resolveOpenClawConfigPath(): string {
  const explicit = process.env.OPENCLAW_CONFIG_PATH?.trim() || process.env.OPENCLAW_CONFIG_FILE?.trim();
  if (explicit) return path.resolve(expandHome(explicit));
  return path.join(resolveStateDir(), "openclaw.json");
}

function resolveStateDir(): string {
  const explicit = process.env.OPENCLAW_STATE_DIR?.trim();
  if (explicit) return path.resolve(expandHome(explicit));
  return path.join(homedir(), ".openclaw");
}

function resolveDefaultWorkspace(config: OpenClawConfigFile): string {
  const configured = config.agents?.defaults?.workspace?.trim();
  if (configured) return path.resolve(expandHome(configured));

  const profile = process.env.OPENCLAW_PROFILE?.trim();
  if (profile && profile.toLowerCase() !== "default") {
    return path.join(homedir(), ".openclaw", `workspace-${profile}`);
  }
  return path.join(homedir(), ".openclaw", "workspace");
}

function resolveSuggestedWorkspace(config: OpenClawConfigFile, agentId: string): string {
  return path.join(resolveDefaultWorkspace(config), agentId);
}

function summarizeGatewaySettings(config: OpenClawConfigFile): OpenClawGatewaySettingsSummary {
  const envUrl = readString(process.env.OPENCLAW_GATEWAY_URL);
  const configuredUrl = readString(config.gateway?.remote?.url);
  const configuredPort = isPositiveNumber(config.gateway?.port) ? Math.floor(config.gateway.port) : undefined;
  const url = envUrl ?? configuredUrl ?? (configuredPort ? `ws://127.0.0.1:${configuredPort}` : undefined);
  const token =
    readString(process.env.OPENCLAW_GATEWAY_TOKEN) ??
    readString(config.gateway?.remote?.token) ??
    readString(config.gateway?.auth?.token);
  const password =
    readString(process.env.OPENCLAW_GATEWAY_PASSWORD) ??
    readString(config.gateway?.remote?.password) ??
    readString(config.gateway?.auth?.password);

  return {
    url,
    origin: readString(process.env.OPENCLAW_GATEWAY_ORIGIN) ?? (url ? websocketUrlToHttpOrigin(url) : undefined),
    locale: readString(process.env.OPENCLAW_GATEWAY_LOCALE) ?? "zh-CN",
    requestTimeoutMs: readPositiveIntegerEnv("OPENCLAW_GATEWAY_REQUEST_TIMEOUT_MS", 20_000),
    agentStartTimeoutMs: readPositiveIntegerEnv("OPENCLAW_AGENT_START_TIMEOUT_MS", 20_000),
    tokenConfigured: Boolean(token),
    passwordConfigured: Boolean(password),
    source: envUrl ? "environment" : configuredUrl || configuredPort ? "config" : "none"
  };
}

function buildConfiguredAgents(
  config: OpenClawConfigFile,
  defaultWorkspace: string,
  defaultModelId: string | undefined
): OpenClawConfiguredAgent[] {
  const entries = listAgentEntries(config);
  const defaultAgentId = entries.find((entry) => entry.default && entry.id)?.id?.trim() || entries[0]?.id?.trim() || "main";

  const normalized = entries.map((entry) => ({
    id: normalizeAgentId(entry.id),
    name: readString(entry.name),
    workspace: path.resolve(expandHome(readString(entry.workspace) || path.join(defaultWorkspace, normalizeAgentId(entry.id)))),
    agentDir: path.resolve(expandHome(readString(entry.agentDir) || path.join(resolveStateDir(), "agents", normalizeAgentId(entry.id), "agent"))),
    modelId: resolveModelId(entry.model) ?? defaultModelId,
    isDefault: normalizeAgentId(entry.id) === normalizeAgentId(defaultAgentId)
  }));

  if (normalized.length > 0) return normalized;

  return [
    {
      id: "main",
      name: "main",
      workspace: defaultWorkspace,
      agentDir: path.join(resolveStateDir(), "agents", "main", "agent"),
      modelId: defaultModelId,
      isDefault: true
    }
  ];
}

function collectConfiguredModels(config: OpenClawConfigFile, defaultModelId?: string): OpenClawConfiguredModel[] {
  const aliases = config.agents?.defaults?.models ?? {};
  const models: OpenClawConfiguredModel[] = [];

  for (const [provider, providerConfig] of Object.entries(config.models?.providers ?? {})) {
    for (const model of providerConfig.models ?? []) {
      const modelId = model.id?.trim();
      if (!modelId) continue;
      const fullId = `${provider}/${modelId}`;
      models.push({
        id: fullId,
        label: model.name?.trim() || aliases[fullId]?.alias || fullId,
        provider,
        alias: aliases[fullId]?.alias,
        thinkingLevels: readConfiguredThinkingLevels(model)
      });
    }
  }

  for (const [fullId, meta] of Object.entries(aliases)) {
    if (models.some((model) => model.id === fullId)) continue;
    const [provider = "unknown"] = fullId.split("/", 1);
    models.push({
      id: fullId,
      label: meta.alias?.trim() || fullId,
      provider,
      alias: meta.alias?.trim()
    });
  }

  if (defaultModelId && !models.some((model) => model.id === defaultModelId)) {
    const [provider = "unknown"] = defaultModelId.split("/", 1);
    models.push({
      id: defaultModelId,
      label: defaultModelId,
      provider
    });
  }

  return models.sort((left, right) => left.label.localeCompare(right.label));
}

const baseThinkingLevels: ChatThinkingEffort[] = ["off", "minimal", "low", "medium", "high"];
const thinkingLevelRank: Record<ChatThinkingEffort, number> = {
  off: 0,
  minimal: 10,
  low: 20,
  medium: 30,
  high: 40,
  adaptive: 50,
  xhigh: 60,
  max: 70
};

function readConfiguredThinkingLevels(model: ConfigObject): ChatThinkingEffort[] | undefined {
  const explicitLevels =
    readThinkingLevelList(model.thinkingLevels) ??
    readThinkingLevelList(model.thinkingOptions);
  if (explicitLevels?.length) return explicitLevels;

  const compat = isConfigObject(model.compat) ? model.compat : undefined;
  const supportedReasoningEfforts =
    readThinkingLevelList(compat?.supportedReasoningEfforts) ??
    readThinkingLevelList(model.supportedReasoningEfforts);
  if (supportedReasoningEfforts?.length) {
    return mergeThinkingLevels([...baseThinkingLevels, ...supportedReasoningEfforts]);
  }

  if (model.reasoning === false) return ["off"];
  if (model.reasoning === true || compat?.supportsReasoningEffort === true) return [...baseThinkingLevels];
  return undefined;
}

function readThinkingLevelList(value: unknown): ChatThinkingEffort[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const levels = value
    .map((entry) => {
      if (typeof entry === "string") return normalizeThinkingLevel(entry);
      if (!isConfigObject(entry)) return undefined;
      return normalizeThinkingLevel(
        readString(entry.id) ??
        readString(entry.value) ??
        readString(entry.reasoningEffort) ??
        readString(entry.label) ??
        readString(entry.name)
      );
    })
    .filter((level): level is ChatThinkingEffort => Boolean(level));
  return levels.length > 0 ? mergeThinkingLevels(levels) : undefined;
}

function mergeThinkingLevels(levels: ChatThinkingEffort[]): ChatThinkingEffort[] {
  return [...new Set(levels)].sort((left, right) => thinkingLevelRank[left] - thinkingLevelRank[right]);
}

function normalizeThinkingLevel(value: string | undefined): ChatThinkingEffort | undefined {
  const key = value?.trim().toLowerCase();
  if (!key) return undefined;
  const collapsed = key.replace(/[\s_-]+/g, "");
  if (collapsed === "off" || collapsed === "none" || collapsed === "disabled") return "off";
  if (collapsed === "min" || collapsed === "minimal") return "minimal";
  if (collapsed === "low" || collapsed === "on" || collapsed === "enabled") return "low";
  if (collapsed === "medium" || collapsed === "med" || collapsed === "mid") return "medium";
  if (collapsed === "high") return "high";
  if (collapsed === "adaptive" || collapsed === "auto") return "adaptive";
  if (collapsed === "xhigh" || collapsed === "extrahigh") return "xhigh";
  if (collapsed === "max") return "max";
  return undefined;
}

function collectConfiguredChannels(config: OpenClawConfigFile): OpenClawConfiguredChannel[] {
  const channels = isConfigObject(config.channels) ? config.channels : {};
  const configuredChannels: OpenClawConfiguredChannel[] = [];

  for (const [channelId, rawChannel] of Object.entries(channels)) {
    if (!isConfigObject(rawChannel)) continue;

    const enabled = readBoolean(rawChannel.enabled, true);
    const accounts: OpenClawConfiguredChannel["accounts"] = [];
    const accountsConfig = isConfigObject(rawChannel.accounts) ? rawChannel.accounts : {};
    const defaultCredentials = collectCredentialKeys(rawChannel);
    const hasDefaultAccount =
      defaultCredentials.length > 0 ||
      readString(rawChannel.name) !== undefined ||
      Object.keys(accountsConfig).length === 0 ||
      Object.prototype.hasOwnProperty.call(rawChannel, "enabled");

    if (hasDefaultAccount) {
      accounts.push({
        id: "default",
        name: readString(rawChannel.name),
        enabled,
        credentialKeys: defaultCredentials,
        isDefault: true
      });
    }

    for (const [accountId, rawAccount] of Object.entries(accountsConfig)) {
      if (!isConfigObject(rawAccount)) continue;
      accounts.push({
        id: accountId,
        name: readString(rawAccount.name),
        enabled: readBoolean(rawAccount.enabled, enabled),
        credentialKeys: collectCredentialKeys(rawAccount),
        isDefault: false
      });
    }

    configuredChannels.push({
      id: channelId,
      label: readString(rawChannel.label) ?? readString(rawChannel.name) ?? channelId,
      enabled,
      accounts: accounts.sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.id.localeCompare(right.id))
    });
  }

  return configuredChannels.sort((left, right) => left.label.localeCompare(right.label));
}

function listAgentEntries(config: OpenClawConfigFile): Array<NonNullable<NonNullable<OpenClawConfigFile["agents"]>["list"]>[number]> {
  return Array.isArray(config.agents?.list) ? config.agents!.list!.filter((entry) => Boolean(entry && typeof entry === "object")) : [];
}

function resolveModelId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && "primary" in value && typeof (value as { primary?: unknown }).primary === "string") {
    return (value as { primary: string }).primary.trim();
  }
  return undefined;
}

function normalizeAgentId(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "main";
  const normalized = trimmed.toLowerCase();
  return normalized.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/g, "").replace(/-+$/g, "").slice(0, 64) || "main";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isConfigObject(value: unknown): value is ConfigObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getProviderConfig(config: OpenClawConfigFile, provider: string): OpenClawProviderConfig {
  const rawProvider = config.models?.providers?.[provider];
  return isConfigObject(rawProvider) ? { ...rawProvider } : {};
}

function normalizeProviderId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(normalized)) return "";
  return normalized;
}

function normalizeModelId(provider: string, value: string): string {
  const trimmed = value.trim();
  const fullProviderPrefix = `${provider}/`;
  if (trimmed.toLowerCase().startsWith(fullProviderPrefix)) return trimmed.slice(fullProviderPrefix.length).trim();
  return trimmed;
}

function normalizeChannelId(value: string): string {
  return value.trim().toLowerCase();
}

function pushOptionalArg(args: string[], flag: string, value: unknown): void {
  const stringValue = readString(value);
  if (stringValue) args.push(flag, stringValue);
}

function collectCredentialKeys(config: ConfigObject): string[] {
  const credentialKeys = [
    "token",
    "botToken",
    "appToken",
    "password",
    "secret",
    "url",
    "baseUrl",
    "dbPath",
    "httpHost",
    "httpPort",
    "httpUrl",
    "cliPath",
    "authDir",
    "region",
    "service",
    "signalNumber",
    "tokenFile",
    "secretFile",
    "webhookSecret"
  ];
  return credentialKeys.filter((key) => Object.prototype.hasOwnProperty.call(config, key));
}

async function writeDefaultModel(modelId: string): Promise<void> {
  const normalized = modelId.trim();
  if (!normalized) {
    throw new Error("Model id is required.");
  }
  await runOpenClawCli(["config", "set", "agents.defaults.model", JSON.stringify({ primary: normalized }), "--strict-json"], {
    timeoutMs: 120_000
  });
}

function escapeConfigPathKey(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function expandHome(value: string): string {
  return value.startsWith("~") ? path.join(homedir(), value.slice(1)) : value;
}

function websocketUrlToHttpOrigin(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

async function runOpenClawCli(args: string[], options?: { timeoutMs?: number }): Promise<string> {
  const entryPath = await resolveOpenClawCliEntry();
  try {
    const { stdout } = await execFileAsync(process.execPath, [entryPath, ...args], {
      windowsHide: true,
      timeout: options?.timeoutMs ?? 120_000,
      maxBuffer: 1024 * 1024 * 8
    });
    return stdout.trim();
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message: string };
    const detail = failure.stderr?.trim() || failure.stdout?.trim() || failure.message;
    throw new Error(detail);
  }
}

function parseOpenClawVersion(output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  return trimmed.match(/\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1] ?? trimmed;
}

async function resolveOpenClawCliEntry(): Promise<string> {
  const explicit = process.env.OPENCLAW_CLI_ENTRY?.trim();
  if (explicit) return path.resolve(expandHome(explicit));

  const candidates = [
    process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "openclaw", "openclaw.mjs") : undefined,
    path.join(resolveStateDir(), "..", "AppData", "Roaming", "npm", "node_modules", "openclaw", "openclaw.mjs"),
    "/usr/local/lib/node_modules/openclaw/openclaw.mjs",
    "/opt/homebrew/lib/node_modules/openclaw/openclaw.mjs"
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  try {
    const stdout = await runNpmRootGlobal();
    const root = stdout.trim();
    const candidate = await resolveOpenClawCliEntryInNpmRoot(root);
    if (candidate) return candidate;
  } catch {
    throw new Error("OpenClaw CLI entry could not be resolved.");
  }
  throw new Error("OpenClaw CLI entry could not be resolved.");
}

async function runNpmRootGlobal(): Promise<string> {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync("cmd.exe", ["/d", "/v:off", "/c", "npm", "root", "-g"], {
      windowsHide: true,
      timeout: 15_000
    });
    return stdout;
  }
  const { stdout } = await execFileAsync("npm", ["root", "-g"], {
    windowsHide: true,
    timeout: 15_000
  });
  return stdout;
}

async function resolveOpenClawCliEntryInNpmRoot(root: string): Promise<string | undefined> {
  const standardCandidate = path.join(root, "openclaw", "openclaw.mjs");
  try {
    await access(standardCandidate);
    return standardCandidate;
  } catch {
    // Some OpenClaw update flows leave the runnable package in a staged
    // .openclaw-* directory while the visible openclaw folder lacks openclaw.mjs.
  }

  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries.filter((item) => item.isDirectory() && item.name.startsWith(".openclaw-")).sort((left, right) => left.name.localeCompare(right.name))) {
      const stagedCandidate = path.join(root, entry.name, "openclaw.mjs");
      try {
        await access(stagedCandidate);
        return stagedCandidate;
      } catch {
        continue;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}
