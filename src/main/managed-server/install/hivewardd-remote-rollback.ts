// Rollback restores a pre-activation snapshot: older builds may not understand newer state.
// Stop, rescue, restore, then launch; the rescue and fenced journal allow recovery of interrupted steps.
import { logHivewarddActivationOutcome } from '../activation/hivewardd-activation-outcome-log'
import type { HivewarddHostTransport } from '../../ssh/hivewardd-host-transport'
import type { HivewarddActivationRecord } from '../activation/hivewardd-activation-record'
import type { HivewarddTerminalCensus } from '../../../shared/hivewardd-terminal-census'
import type { HivewarddActivationVerdict } from '../activation/hivewardd-activation-gate'
import type { HivewarddDaemonProtocolFacts } from '../../ssh/hivewardd-daemon-protocol-crossing'
import { readHivewarddActivationRecord } from '../activation/hivewardd-activation-record-store'
import { sameHivewarddActivationRecord } from '../activation/hivewardd-activation-transaction'
import type { RemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import {
  resolveHivewarddActivationReadinessTimeout,
  withHivewarddActivationLock
} from '../activation/hivewardd-activation-lock'
import { hivewarddActivationFenceRefusal } from '../activation/hivewardd-activation-fence-hold'
import { HIVEWARDD_STARTUP_READINESS_TIMEOUT_MS } from '../../../shared/hivewardd-profile-preflight'
import { rollbackHivewarddLocked } from '../lifecycle/hivewardd-rollback-transition'

export type HivewarddRollbackOptions = {
  conn: HivewarddHostTransport
  host: RemoteHostPlatform
  remoteHome: string
  record: HivewarddActivationRecord
  nodePath: string
  userDataDir: string
  bindHost: string
  port: number
  census: HivewarddTerminalCensus
  /** Close terminal admission, then recount under the host lock; any failure is unverifiable. */
  recountCensus: () => Promise<HivewarddTerminalCensus>
  /** Reopen admission if rollback leaves the incumbent serving. */
  releaseIncumbentAdmission: () => Promise<void>
  /** Expected hash from the client's copy of the rollback target. */
  targetBuildHash: string
  /** Protocol facts from the same target bytes. */
  targetDaemonProtocol: HivewarddDaemonProtocolFacts
  readinessTimeoutMs?: number
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
}

export type HivewarddRollbackResult =
  | { outcome: 'rolled-back'; target: string; discarded: string[]; verdict: HivewarddActivationVerdict }
  | { outcome: 'refused'; code: string; reason: string }
  | { outcome: 'failed'; code: string; reason: string }

export async function rollbackHivewardd(input: HivewarddRollbackOptions): Promise<HivewarddRollbackResult> {
  const options = {
    ...input,
    readinessTimeoutMs: resolveHivewarddActivationReadinessTimeout(
      input.readinessTimeoutMs,
      HIVEWARDD_STARTUP_READINESS_TIMEOUT_MS
    )
  }
  return logHivewarddActivationOutcome(
    `rollback to ${options.record.previous ?? 'none'}`,
    () =>
      withHivewarddActivationLock(
        options,
        async (lock) => {
          if (
            !sameHivewarddActivationRecord(await readHivewarddActivationRecord(options), options.record)
          ) {
            return {
              outcome: 'refused',
              code: 'hivewardd_rollback_record_changed',
              reason:
                'The host activation record changed while this rollback was waiting. Refresh the ' +
                'host state and review the new rollback target before trying again.'
            }
          }
          return rollbackHivewarddLocked(options, lock)
        },
        async () => {
          const { code, reason } = await hivewarddActivationFenceRefusal(options, 'rollback')
          return { outcome: 'refused', code, reason }
        }
      ),
    ['rolled-back']
  )
}
