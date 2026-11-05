// The host records quit/update/crash on the cut-turn row for Continue. Unknown wire causes retain the row's words without a named cause.

export const AGENT_SESSION_HIVEWARD_STOP_CAUSES = ['update', 'quit', 'crash'] as const
/** The row's presentation, so a client that re-words host rows it can't name passes it through. */
export const AGENT_SESSION_HIVEWARD_STOP_PRESENTATION = 'hiveward-stop'
export type AgentSessionHiveWardStopCause = (typeof AGENT_SESSION_HIVEWARD_STOP_CAUSES)[number]
export type AgentSessionHiveWardStop = { cause: AgentSessionHiveWardStopCause }

export function isAgentSessionHiveWardStopCause(value: unknown): value is AgentSessionHiveWardStopCause {
  return AGENT_SESSION_HIVEWARD_STOP_CAUSES.some((cause) => cause === value)
}

/** The stop a row states, when this build knows its cause. */
export function readAgentSessionHiveWardStop(value: unknown): AgentSessionHiveWardStop | undefined {
  const cause =
    typeof value === 'object' && value !== null && 'cause' in value ? value.cause : undefined
  return isAgentSessionHiveWardStopCause(cause) ? { cause } : undefined
}
