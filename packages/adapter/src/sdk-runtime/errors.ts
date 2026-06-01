export type AgentSdkErrorCode =
  | "model_not_configured"
  | "provider_not_configured"
  | "workspace_not_allowed"
  | "permission_denied"
  | "timeout"
  | "cancelled"
  | "provider_error";

export class AgentSdkError extends Error {
  constructor(
    readonly code: AgentSdkErrorCode,
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = "AgentSdkError";
  }
}

export function formatAgentSdkError(code: AgentSdkErrorCode, detail: string): string {
  return `${code}: ${detail}`;
}

export function formatAgentSdkProviderError(providerLabel: string, error: unknown): string {
  const detail = getErrorMessage(error);
  return formatAgentSdkError(detectProviderConfigurationError(detail) ? "provider_not_configured" : "provider_error", `${providerLabel}: ${detail}`);
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: unknown; code?: unknown; message?: unknown };
  return record.name === "AbortError" || record.code === "ABORT_ERR" || String(record.message ?? "").toLowerCase().includes("abort");
}

function detectProviderConfigurationError(message: string): boolean {
  const normalized = message.toLowerCase();
  return [
    "api key",
    "apikey",
    "auth",
    "login",
    "log in",
    "not logged",
    "unauthorized",
    "forbidden",
    "401",
    "403",
    "enoent",
    "not found"
  ].some((term) => normalized.includes(term));
}
