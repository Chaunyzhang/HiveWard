import type { PtyRegistrationClaim } from '../../runtime/runtime-terminal-state-records'
import type { PtySpawnResult } from '../../providers/pty-provider-contract'
import type { HiveWardRuntimeService } from '../../runtime/hiveward-runtime'
import { normalizeNodePtySpawnError } from './provider/liveness'
import { restoreProvisionalPtySize, type PtySpawnSizeSeed } from './spawn-options-assembly'
import { clearProviderPtyState } from './provider/state-cleanup'

type PtySpawnExecuteState = {
  deps: { runtime?: HiveWardRuntimeService }
  isClaudeLaunch: boolean
  effectiveSessionAppId: string | undefined
  provisionalPtySize: PtySpawnSizeSeed | undefined
  preparedProvisionalExecutionContext: boolean
  pendingRegistrationPtyId: string | null
  pendingRegistrationClaim?: PtyRegistrationClaim
  rejectedRegistrationCandidate: PtySpawnResult | null
}

export function failPtySpawnExecute(
  ctx: PtySpawnExecuteState,
  err: unknown,
  lane: {
    sessionId: string | undefined
    /** This start owns the new incarnation, including a fresh process using a supplied id. */
    ownsNewSession: boolean
    telemetry: { agent_kind?: unknown } | undefined
    /** This request awaited another request's claimed start, whose own catch records its failure. */
    joinedAnotherStart?: boolean
  }
): Error {
  const runtime = ctx.deps.runtime
  if (
    (lane.ownsNewSession || ctx.preparedProvisionalExecutionContext) &&
    ctx.effectiveSessionAppId
  ) {
    runtime?.preparePtyExecutionContext?.(ctx.effectiveSessionAppId, null, {
      resetIncarnation: true
    })
  }
  if (ctx.pendingRegistrationPtyId) {
    runtime?.cancelPendingPtyRegistration?.(
      ctx.pendingRegistrationPtyId,
      ctx.rejectedRegistrationCandidate?.incarnationId,
      ctx.pendingRegistrationClaim
    )
    ctx.pendingRegistrationPtyId = null
  }
  const spawnError = normalizeNodePtySpawnError(err)
  const exitedBeforeSpawnReply = ctx.rejectedRegistrationCandidate?.exitedBeforeSpawnReply === true
  // Preparation for an unaccepted new incarnation must not leak into a later start.
  if (lane.ownsNewSession && lane.sessionId !== undefined) {
    clearProviderPtyState(lane.sessionId)
  }
  // Restore the pre-start grid after teardown, which also clears its provisional cache entry.
  restoreProvisionalPtySize(ctx, { exitedBeforeSpawnReply })
  return spawnError
}
