import {
  formatHiveWardSessionAddress,
  isHiveWardSessionId,
  parseHiveWardSessionAddress,
  type HiveWardSessionId
} from '../../../shared/hiveward-session-address'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../../shared/orchestration-session-caller-codes'
import {
  isRecordedStructuredWorkerSession,
  resolveStructuredWorkerIdentity,
  resolveStructuredWorkerIdentityForRoot
} from '../structured-worker-authority'
import type { StructuredWorkerIdentity } from '../structured-worker-identity'
import { canonicalHiveWardSessionId } from './canonical-hiveward-session-id'
import type { AgentSessionRecordReader } from './structured-session-lineage'
import type { OrchestrationDb } from './db'
import { mailboxAddressOf, type OrchestrationCallerIdentity } from './orchestration-caller-identity'
import { OrchestrationError } from './orchestration-error'

/** A party as Run binding and mail routing match it; `address` is its one mailbox address. */
export type OrchestrationParty = OrchestrationCallerIdentity

/** A party named by an HiveWard session id: a structured worker, or a chat. */
export type OrchestrationSessionParty = OrchestrationParty &
  Readonly<{ hivewardSessionId: HiveWardSessionId }>

const NO_EFFECTS = { effectsApplied: false } as const

/** Every param naming a party other than the caller; a new one is added here with its own test. */
export const ORCHESTRATION_TARGET_PARAM: Readonly<
  Record<string, 'to' | 'terminal' | 'sessionId' | 'address'>
> = {
  'orchestration.send': 'to',
  'orchestration.ask': 'to',
  'orchestration.dispatch': 'to',
  'orchestration.inbox': 'terminal',
  'orchestration.sessionAddress': 'sessionId',
  'orchestration.partyLocation': 'address',
  'orchestration.partyOpen': 'address',
  'orchestration.workerStart': 'terminal'
}

/** The party an HiveWard session id names. Throws when it is a worker this host lost the identity of. */
export function resolveHiveWardSessionParty(
  hivewardSessionId: HiveWardSessionId,
  db: OrchestrationDb | null | undefined,
  store?: Pick<AgentSessionRecordReader, 'listRecords'> | null
): OrchestrationSessionParty {
  const id = canonicalHiveWardSessionId(hivewardSessionId, store)
  const worker = resolveStructuredWorkerIdentityForRoot(id, db)
  const party = sessionPartyFromWorkerIdentity(
    id,
    worker,
    !worker && Boolean(db && isRecordedStructuredWorkerSession(id, db))
  )
  if (!party) {
    // Without its handle, one worker would split into two parties and bind as a chat.
    throw new OrchestrationError(
      CODES.notLive,
      `Agent session ${id} is a structured worker whose worker identity this host no longer has, so orchestration cannot address it. No effects were applied.`,
      NO_EFFECTS
    )
  }
  return party
}

export function sessionPartyFromWorkerIdentity(
  id: HiveWardSessionId,
  worker: Pick<StructuredWorkerIdentity, 'handle' | 'paneKey'> | null,
  recordedWorker: boolean
): OrchestrationSessionParty | undefined {
  if (!worker && recordedWorker) {
    return undefined
  }
  const key = { terminalHandle: worker?.handle ?? null, hivewardSessionId: id }
  return {
    ...key,
    address: mailboxAddressOf(key) ?? formatHiveWardSessionAddress(id),
    paneKey: worker?.paneKey ?? null
  }
}

/** The party an address names; a PTY handle is itself and costs no lookup. */
export function resolveOrchestrationParty(
  address: string,
  db: OrchestrationDb | null | undefined
): OrchestrationParty {
  const hivewardSessionId = parseHiveWardSessionAddress(address)
  if (hivewardSessionId) {
    return resolveHiveWardSessionParty(hivewardSessionId, db)
  }
  const worker = resolveStructuredWorkerIdentity(address, db)
  return {
    address,
    terminalHandle: address,
    paneKey: worker?.paneKey ?? null,
    hivewardSessionId:
      worker && isHiveWardSessionId(worker.sessionId)
        ? canonicalHiveWardSessionId(worker.sessionId)
        : null
  }
}

/** How a preamble names a party: a session by its HiveWard session ID (its `/clear` root), else its handle. */
export function hivewardSessionIdOrHandle(
  address: string,
  db: OrchestrationDb | null | undefined
): string {
  const { hivewardSessionId } = resolveOrchestrationParty(address, db)
  return hivewardSessionId === null ? address : formatHiveWardSessionAddress(hivewardSessionId)
}

/** A caller named by a param: naming a chat's address proves nothing, unlike its own session id. */
export function resolveDeclaredCallerParty(
  address: string,
  db: OrchestrationDb | null | undefined
): OrchestrationParty {
  const party = resolveOrchestrationParty(address, db)
  if (party.terminalHandle === null) {
    throw new OrchestrationError(
      CODES.chatNotDeclarable,
      `Agent session ${party.hivewardSessionId} is a chat, and a chat is identified only by the HiveWard session ID its own environment sends, never by naming it. No effects were applied.`,
      NO_EFFECTS
    )
  }
  return party
}

/** Resolve terminals, workers and chats; chat assignments use the /clear root address for later reports. */
export function resolveDispatchAssigneeParty(
  address: string,
  db: OrchestrationDb | null | undefined
): OrchestrationParty {
  return resolveOrchestrationParty(address, db)
}
