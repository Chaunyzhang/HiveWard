import { isAgentSessionId } from './agent-session/lifecycle/agent-session-record'
import { STRUCTURED_WORKER_HANDLE_PREFIX } from './structured-worker-handle'

export const HIVEWARD_SESSION_ID_PREFIX = 'hiveward_'
export const HIVEWARD_SESSION_ADDRESS_PREFIX = 'hiveward_session_id:'
export const HIVEWARD_ORCHESTRATION_SESSION_ENV = 'HIVEWARD_ORCHESTRATION_SESSION_ID'

export function isHiveWardPrefixedSessionId(id: string): boolean {
  return /^hiveward_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
}

/** HiveWard-minted structured session identity (record id/HIVEWARD_AGENT_SESSION_ID), never provider identity. Orchestration stores bare lineage-root ids after /clear,
 * not live replacement ids; derive mail spelling hiveward_session_id:<id> alongside run:/dispatch: addresses.
 * Resolve execution location from records. PTYs have no id today; never use pane keys because later agents inherit panes. */
declare const hivewardSessionIdBrand: unique symbol
declare const hivewardSessionAddressBrand: unique symbol

/** A bare HiveWard session id; only `isHiveWardSessionId` and `parseHiveWardSessionAddress` produce one. */
export type HiveWardSessionId = string & { readonly [hivewardSessionIdBrand]: true }
/** An `hiveward_session_id:<id>` mail address; only `formatHiveWardSessionAddress` produces one. */
export type HiveWardSessionAddress = string & { readonly [hivewardSessionAddressBrand]: true }

// Terminal handles (term_/structworker_) share the charset but are never durable session ids.
const TERMINAL_HANDLE_PREFIXES = ['term_', STRUCTURED_WORKER_HANDLE_PREFIX] as const

export function isHiveWardSessionId(id: string): id is HiveWardSessionId {
  return isAgentSessionId(id) && !TERMINAL_HANDLE_PREFIXES.some((prefix) => id.startsWith(prefix))
}

export function formatHiveWardSessionAddress(
  hivewardSessionId: HiveWardSessionId
): HiveWardSessionAddress {
  const address = `${HIVEWARD_SESSION_ADDRESS_PREFIX}${hivewardSessionId}`
  // Always true for a checked id; the check brands the address without a type assertion.
  if (!isHiveWardSessionAddress(address)) {
    throw new Error(`Not a HiveWard session id: ${hivewardSessionId}`)
  }
  return address
}

/** The bare HiveWard session id of an `hiveward_session_id:<id>` address; anything else reads as null. */
export function parseHiveWardSessionAddress(
  address: string | null | undefined
): HiveWardSessionId | null {
  if (!address?.startsWith(HIVEWARD_SESSION_ADDRESS_PREFIX)) {
    return null
  }
  const id = address.slice(HIVEWARD_SESSION_ADDRESS_PREFIX.length)
  return isHiveWardSessionId(id) ? id : null
}

function isHiveWardSessionAddress(address: string): address is HiveWardSessionAddress {
  return parseHiveWardSessionAddress(address) !== null
}
