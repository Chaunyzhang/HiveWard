import { hivewardExternalSessions } from '../../../../orchestration/hiveward-external-sessions'
/** Address any host-local chat by HiveWard session id, including /clear ancestors.
 * Unbound mail belongs to the root mailbox and points at the live session. Released leases may restart; closed/foreign/unknown chats refuse before storage. */

import {
  HIVEWARD_SESSION_ADDRESS_PREFIX,
  formatHiveWardSessionAddress,
  isHiveWardPrefixedSessionId,
  isHiveWardSessionId,
  parseHiveWardSessionAddress,
  type HiveWardSessionAddress,
  type HiveWardSessionId
} from '../../../../../../shared/hiveward-session-address'
// The caller codes, reused: each names the same fact about a session, whichever side of the mail it is on.
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../../../../../shared/orchestration-session-caller-codes'
import {
  lookupHiveWardAgentSession,
  structuredSessionMailReach
} from '../../../../orchestration/structured-session-mail-address'
import type { AgentSessionRecordReader } from '../../../../orchestration/structured-session-lineage'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { canonicalHiveWardSessionId } from '../../../../orchestration/canonical-hiveward-session-id'

/** `address` is the named session's own spelling; the mailbox mail lands in is its identity address. */
export type SessionRecipient = { sessionId: HiveWardSessionId; address: HiveWardSessionAddress }

export type SessionRecipientRefusal = {
  code: (typeof CODES)[keyof typeof CODES]
  message: string
}

/** Whether a recipient may name a session, so the caller can install the session host first. */
export function mayNameSession(recipient: string): boolean {
  return recipient.startsWith(HIVEWARD_SESSION_ADDRESS_PREFIX) || isHiveWardSessionId(recipient)
}

/** Recognize bare ids as sessions only when a local record exists; preserve terminal-handle interpretation otherwise. */
export function readSessionRecipient(
  recipient: string,
  store: AgentSessionRecordReader | null
): SessionRecipient | SessionRecipientRefusal | null {
  if (
    recipient.startsWith(HIVEWARD_SESSION_ADDRESS_PREFIX) ||
    recipient.startsWith(HIVEWARD_SESSION_ADDRESS_PREFIX)
  ) {
    const sessionId = parseHiveWardSessionAddress(recipient)
    return sessionId
      ? { sessionId, address: formatHiveWardSessionAddress(sessionId) }
      : {
          code: CODES.unknown,
          message: `${recipient} does not name an HiveWard session ID. No message was sent.`
        }
  }
  const sessionId = isHiveWardSessionId(recipient) ? recipient : null
  const found = sessionId && store ? lookupHiveWardAgentSession(store, sessionId) : null
  if (found?.kind === 'provider-id') {
    return providerIdRefusal(recipient, found.hivewardSessionId, store)
  }
  return sessionId && found?.kind === 'found'
    ? { sessionId, address: formatHiveWardSessionAddress(sessionId) }
    : null
}

/** Share mail/task reachability: null admits storage/delivery here, otherwise return the refusal. */
export function refuseUndeliverableSessionRecipient(
  recipient: SessionRecipient,
  store: AgentSessionRecordReader | null,
  db: OrchestrationDb,
  noEffect = 'No message was sent.'
): SessionRecipientRefusal | null {
  const { sessionId } = recipient
  if (isHiveWardPrefixedSessionId(sessionId)) {
    return hivewardExternalSessions(db).some((row) => row.sessionId === sessionId)
      ? null
      : { code: CODES.unknown, message: `HiveWard 外部会话 ${sessionId} 尚未登记。${noEffect}` }
  }
  if (!store) {
    return {
      code: CODES.unknown,
      message: `Agent session ${sessionId} cannot be verified: this HiveWard is not running its agent-session host. ${noEffect}`
    }
  }
  const found = lookupHiveWardAgentSession(store, sessionId)
  if (found.kind === 'provider-id') {
    return providerIdRefusal(sessionId, found.hivewardSessionId, store, noEffect)
  }
  if (found.kind === 'unknown') {
    return {
      code: CODES.unknown,
      message: `No HiveWard agent session ${sessionId} exists on this host. ${noEffect}`
    }
  }
  const reach = structuredSessionMailReach(store, found.record, db)
  if (reach.kind === 'other-host') {
    return {
      code: CODES.hostBoundary,
      message: `Agent session ${sessionId} runs on another host; mail reaches a session only on the host that runs it. Send from that host. ${noEffect}`
    }
  }
  if (reach.kind === 'unverifiable') {
    return {
      code: CODES.notLive,
      message: `The session continuing agent session ${sessionId} after a /clear cannot be verified: ${reach.reason} ${noEffect}`
    }
  }
  if (reach.kind === 'ended') {
    return {
      code: CODES.notLive,
      message:
        reach.reason === 'worker-identity-lost'
          ? `Agent session ${sessionId} is a structured worker whose worker identity this host no longer has, so it can never read that mail. ${noEffect}`
          : `Agent session ${sessionId} has ended: its chat was closed. ${noEffect}`
    }
  }
  return null
}

function providerIdRefusal(
  id: string,
  hivewardSessionId: string,
  store: AgentSessionRecordReader | null,
  noEffect = 'No message was sent.'
): SessionRecipientRefusal {
  // The conversation's HiveWard session ID, which a `/clear`ed session keeps; not the live session's.
  const root = isHiveWardSessionId(hivewardSessionId)
    ? canonicalHiveWardSessionId(hivewardSessionId, store)
    : hivewardSessionId
  const address = `${HIVEWARD_SESSION_ADDRESS_PREFIX}${root}`
  return {
    code: CODES.providerId,
    message: `${id} is the provider's own session id, which changes on /clear. This session's HiveWard session ID is ${address}; address it by that instead. ${noEffect}`
  }
}
