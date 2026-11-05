import {
  isHiveWardSessionId,
  type HiveWardSessionId
} from '../../../shared/hiveward-session-address'
import {
  clearedInto,
  readAgentSessionRecordStore,
  type AgentSessionRecordReader
} from './structured-session-lineage'

/** Address by the /clear root to preserve Runs and mail; without records, retain the supplied id. */
export function canonicalHiveWardSessionId(
  hivewardSessionId: HiveWardSessionId,
  store: Pick<
    AgentSessionRecordReader,
    'listRecords' | 'lineageRevision'
  > | null = readAgentSessionRecordStore()
): HiveWardSessionId {
  return createCanonicalHiveWardSessionResolver(store)(hivewardSessionId)
}

/** Clear edges per lineage revision: mail checks ask per message, and must not rescan every record each time. */
const clearEdgesByRevision = new WeakMap<object, ReadonlyMap<string, string>>()

export function createCanonicalHiveWardSessionResolver(
  store: Pick<AgentSessionRecordReader, 'listRecords' | 'lineageRevision'> | null
): (id: HiveWardSessionId) => HiveWardSessionId {
  if (!store) {
    return (id) => id
  }
  const revision = store.lineageRevision?.()
  let clearedFrom = revision ? clearEdgesByRevision.get(revision) : undefined
  if (!clearedFrom) {
    const edges = new Map<string, string>()
    for (const record of store.listRecords()) {
      const next = clearedInto(record)
      if (next) {
        edges.set(next, record.sessionId)
      }
    }
    clearedFrom = edges
    if (revision) {
      clearEdgesByRevision.set(revision, edges)
    }
  }
  const edges = clearedFrom
  return (id) => canonicalHiveWardSessionFromEdges(id, edges)
}

export function canonicalHiveWardSessionFromEdges(
  hivewardSessionId: HiveWardSessionId,
  clearedFrom: ReadonlyMap<string, string>
): HiveWardSessionId {
  // The visited set bounds corrupt chains; valid clear lineage is acyclic.
  let root: string = hivewardSessionId
  const earlier = new Set([root])
  let prior = clearedFrom.get(root)
  while (prior && !earlier.has(prior)) {
    earlier.add(prior)
    root = prior
    prior = clearedFrom.get(root)
  }
  // Record ids are minted as HiveWard session ids; one that is not cannot name the conversation.
  return isHiveWardSessionId(root) ? root : hivewardSessionId
}
