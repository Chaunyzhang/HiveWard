/** Host-resolved HiveWard session identity comes from the injected environment, never flags. Terminal agents lack it;
 * hiveward status --json publishes it as caller. */
export type OrchestrationCallerSession = {
  hivewardSessionId: string
  live: boolean
}

/** The host refused the session this process names, so it cannot act as it right now. */
export type OrchestrationCallerRefusal = {
  live: false
  refusal: { code: string; message: string }
}

/** Absent for non-session callers, unreachable runtimes or hosts predating orchestration.callerShow. */
export type CliStatusCaller = OrchestrationCallerSession | OrchestrationCallerRefusal

/** `null`: the caller is not an HiveWard session. */
export type OrchestrationCallerShowResult = { caller: OrchestrationCallerSession | null }

/** `orchestration.sessionAddress`: a session's HiveWard session ID, its `/clear` root's. */
export type OrchestrationSessionAddressResult = { hivewardSessionId: string }

/** Where a party is now: a chat at its `/clear` lineage's live session, or a terminal. */
export type OrchestrationPartyLocation =
  | { kind: 'chat'; sessionId: string; worktreeId: string }
  | { kind: 'terminal'; handle: string }

/** `orchestration.partyLocation`: a null location is a party this host does not find. `lost` says
 *  it proved that party gone, and what it was; absent, the host cannot tell (one it does not run). */
export type OrchestrationPartyLocationResult = {
  location: OrchestrationPartyLocation | null
  lost?: 'chat' | 'terminal'
}
