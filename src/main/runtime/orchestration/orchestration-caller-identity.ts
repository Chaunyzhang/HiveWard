import type { RunRow } from './types'
import { isEquivalentPaneKey } from './db/pane-key-match'
import { currentRunCoordinatorHiveWardSessionId } from './db/runs/run-coordinator-hiveward-session'
import { formatHiveWardSessionAddress, type HiveWardSessionId } from '../../../shared/hiveward-session-address'
import type { OrchestrationPartyIdentity } from '../../../shared/orchestration-party-identity'

/** Who an orchestration caller is; shared so a queued message can name its sender the same way. */
export type OrchestrationCallerIdentity = OrchestrationPartyIdentity

/** The part of a caller a Run binding stores and matches. */
export type OrchestrationCoordinatorKey = Pick<
  OrchestrationCallerIdentity,
  'terminalHandle' | 'paneKey' | 'hivewardSessionId'
>

/** A caller the dispatch entry resolved from the HiveWard session id in its injected environment. */
export type OrchestrationSessionCaller = OrchestrationCallerIdentity &
  Readonly<{
    hivewardSessionId: HiveWardSessionId
    /** The session record the request came from. */
    sessionId: HiveWardSessionId
    /** Where the session runs, from its record; `worker-start --worktree current` places here. */
    workspaceId: string
    hivewardExternal?: true
  }>

/** A caller with neither a pane nor an HiveWard session id can never be bound to a Run. */
export function hasRunBindingKey(caller: OrchestrationCoordinatorKey): boolean {
  return caller.paneKey !== null || caller.hivewardSessionId !== null
}

/** The one address a party reads mail at and is sent mail at; null for a key naming nobody. */
export function mailboxAddressOf(
  party: Pick<OrchestrationCoordinatorKey, 'terminalHandle' | 'hivewardSessionId'>
): string | null {
  // Workers read mail at their handles, so prefer that address when both identities exist.
  if (party.terminalHandle !== null) {
    return party.terminalHandle
  }
  return party.hivewardSessionId === null ? null : formatHiveWardSessionAddress(party.hivewardSessionId)
}

/** Who a Run's binding names now; an HiveWard session id an older binding left behind is not part of it. */
export function runCoordinatorKey(run: RunRow): OrchestrationCoordinatorKey {
  return {
    terminalHandle: run.coordinator_handle,
    paneKey: run.coordinator_pane_key,
    hivewardSessionId: currentRunCoordinatorHiveWardSessionId(run)
  }
}

export function runBoundToCoordinator(
  run: Pick<
    RunRow,
    | 'coordinator_pane_key'
    | 'coordinator_hiveward_session_id'
    | 'coordinator_hiveward_session_id_generation'
    | 'consumer_generation'
  >,
  caller: OrchestrationCoordinatorKey
): boolean {
  if (
    caller.paneKey !== null &&
    run.coordinator_pane_key !== null &&
    isEquivalentPaneKey(run.coordinator_pane_key, caller.paneKey)
  ) {
    return true
  }
  return (
    caller.hivewardSessionId !== null &&
    currentRunCoordinatorHiveWardSessionId(run) === caller.hivewardSessionId
  )
}
