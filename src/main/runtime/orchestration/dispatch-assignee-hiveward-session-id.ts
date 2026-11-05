import { parseHiveWardSessionAddress, type HiveWardSessionId } from '../../../shared/hiveward-session-address'
import { structuredWorkerHiveWardSessionIdForIncarnation } from '../structured-worker-identity'
import { canonicalHiveWardSessionId } from './canonical-hiveward-session-id'

/** Resolve structured incarnations or chat addresses to bare session ids; PTYs have none. */
export function dispatchAssigneeHiveWardSessionId(assignee: {
  handle: string
  processIncarnation: string | null | undefined
}): HiveWardSessionId | null {
  const hivewardSessionId =
    structuredWorkerHiveWardSessionIdForIncarnation(assignee.processIncarnation) ??
    parseHiveWardSessionAddress(assignee.handle)
  return hivewardSessionId === null ? null : canonicalHiveWardSessionId(hivewardSessionId)
}
