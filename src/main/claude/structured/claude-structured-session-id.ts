import { createHash } from 'node:crypto'

/** A stable UUID (v4 layout) for the Claude conversation behind an HiveWard chat. */
export function claudeSessionIdForHiveWardSession(
  sessionId: string,
  clearOperationId?: string
): string {
  return stableUuid(
    clearOperationId
      ? `hiveward-claude:${sessionId}:context-clear:${clearOperationId}`
      : `hiveward-claude:${sessionId}`
  )
}

/** Stable across retries so a rewind always names the same conversation. */
export function claudeSessionIdForRewind(sessionId: string, rewindOperationId: string): string {
  return stableUuid(`hiveward-claude:${sessionId}:rewind:${rewindOperationId}`)
}

/** Fresh submissions have fresh keys; only provably unwritten input may reuse one. */
export function claudePromptUuidForSubmission(
  sessionId: string,
  submissionItemKey: string
): string {
  return stableUuid(JSON.stringify(['hiveward-claude:prompt', sessionId, submissionItemKey]))
}

function stableUuid(identity: string): string {
  const bytes = createHash('sha256').update(identity).digest().subarray(0, 16)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
