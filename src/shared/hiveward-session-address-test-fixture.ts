import { isHiveWardSessionId, type HiveWardSessionId } from './hiveward-session-address'

/** A literal HiveWard session id for a test, checked by the same predicate production uses. */
export function testHiveWardSessionId(id: string): HiveWardSessionId {
  if (!isHiveWardSessionId(id)) {
    throw new Error(`Not an HiveWard session id: ${id}`)
  }
  return id
}
