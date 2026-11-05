import { refuseHivewarddHostIdentity } from './hivewardd-host-version-admission'
/** Journal durably before mutation so interrupted deploys can finish or recover. Release the fence only once the host is provably settled on one slot. */
import { hivewarddRemoteBaseDir } from '../managed-server/install/hivewardd-remote-windows-node'
import { randomUUID } from 'node:crypto'
import type { HivewarddDeployOptions, HivewarddDeployResult } from './hivewardd-remote-deploy'
import { isUnconfirmedSshCommandTermination } from './remote-exec/remote-exec-command'
import {
  withActivatedVersion,
  type HivewarddActivationRecord,
  type HivewarddStateSnapshot
} from '../managed-server/activation/hivewardd-activation-record'
import {
  readHivewarddActivationRecord,
  writeHivewarddActivationRecord
} from '../managed-server/activation/hivewardd-activation-record-store'
import { launchAndJudgeHivewarddSlot } from './hivewardd-candidate-launch-verdict'
import { planHivewarddUpdate } from './hivewardd-update-plan'
import {
  type HivewarddTerminalCensus,
  UNVERIFIABLE_HIVEWARDD_TERMINAL_CENSUS
} from '../../shared/hivewardd-terminal-census'
import { runFencedStop } from './hivewardd-fenced-stop'
import {
  censusNeedsHostDaemonProtocols,
  CURRENT_HIVEWARDD_DAEMON_PROTOCOL
} from './hivewardd-daemon-protocol-crossing'
import { HIVEWARDD_LOG_FILENAME } from '../managed-server/install/hivewardd-remote-host-support'
import { hivewarddSnapshotFailureReason } from '../managed-server/host-state/hivewardd-state-snapshot-space'
import {
  HIVEWARDD_SNAPSHOT_SPACE_INSUFFICIENT_CODE,
  hivewarddSnapshotRoomRefusal,
  hivewarddSnapshotsRoot
} from './hivewardd-snapshot-room'
import {
  captureHivewarddStateSnapshotCommand,
  hivewarddSnapshotDirName,
  parseHivewarddSnapshotCapture
} from '../managed-server/host-state/hivewardd-state-snapshot'
import { joinRemotePath } from './ssh-remote-platform'
import { computeLocalHivewarddBuildHash } from './hivewardd-local-build-hash'
import { preflightHivewarddCandidate } from './hivewardd-candidate-preflight'
import type { HivewarddActivationLockControl } from '../managed-server/activation/hivewardd-activation-lock'
import type { HivewarddActivateTransaction } from '../managed-server/activation/hivewardd-activation-transaction'
import {
  createHivewarddActivationTransaction,
  withHivewarddActivationCandidateReady,
  withHivewarddActivationIncumbentStopped,
  withHivewarddActivationSnapshot
} from '../managed-server/activation/hivewardd-activation-transaction-transitions'
import { writeHivewarddActivationTransaction } from '../managed-server/activation/hivewardd-activation-transaction-store'
import {
  execHivewarddRemoteOr,
  withoutAbortSignal
} from '../managed-server/install/hivewardd-remote-runtime-control'
import { execHivewarddStateMutationOr } from '../managed-server/host-state/hivewardd-state-mutation-exec'
import {
  initialHivewarddActivationAdmissionCommand,
  parseInitialHivewarddActivationAdmission
} from './hivewardd-initial-activation-admission'
import {
  hivewarddSlotDir,
  resolveHivewarddSlotIdentity,
  type HivewarddSlotIdentity
} from './hivewardd-recovery-slot'
import { hivewarddSnapshotPath } from './hivewardd-incumbent-recovery'
import {
  restartAfterSnapshotFailure,
  restoreAfterRejectedCandidate,
  stopTransactionIncumbent
} from './hivewardd-transaction-incumbent'
import { withHivewarddLogTail } from '../managed-server/install/hivewardd-remote-log-tail'
import { hivewarddCandidateLaunchFailureCode } from '../hivewardd/hivewardd-host-unavailable'
import { errorMessage } from '../../shared/error-message'

type Outcome = Extract<HivewarddDeployResult, { outcome: 'installed-not-activated' }>

export const HIVEWARDD_ACTIVATION_POLICY_REFUSED_CODE = 'hivewardd_activation_policy_refused'

function countedLockedRecord(options: HivewarddDeployOptions, record: HivewarddActivationRecord): boolean {
  const counted = options.censusRecord
  return (
    !counted || (counted.active === record.active && counted.activatedAt === record.activatedAt)
  )
}

/** A census of another incumbent cannot authorize stopping this one. */
function censusForLockedRecord(
  options: HivewarddDeployOptions,
  record: HivewarddActivationRecord
): HivewarddTerminalCensus {
  return countedLockedRecord(options, record) ? options.census : UNVERIFIABLE_HIVEWARDD_TERMINAL_CENSUS
}

export async function activateInstalledHivewardd(
  options: HivewarddDeployOptions & { localHivewarddDir: string },
  fullVersion: string,
  remoteDir: string,
  lock: HivewarddActivationLockControl
): Promise<HivewarddDeployResult> {
  const now = options.now ?? ((): Date => new Date())
  const notActivated = (code: string, reason: string): Outcome => ({
    outcome: 'installed-not-activated',
    fullVersion,
    code,
    reason
  })
  const record = await readHivewarddActivationRecord(options)
  if (refuseHivewarddHostIdentity(record)) {
    return notActivated(
      HIVEWARDD_ACTIVATION_POLICY_REFUSED_CODE,
      '无法确认主机上的服务属于 HiveWard，已保留原安装。'
    )
  }
  const planFor = (
    census: HivewarddTerminalCensus,
    hostDaemonProtocols?: readonly number[]
  ): ReturnType<typeof planHivewarddUpdate> =>
    planHivewarddUpdate({
      record,
      candidateVersion: fullVersion,
      census,
      candidateDaemonProtocol: CURRENT_HIVEWARDD_DAEMON_PROTOCOL,
      ...(hostDaemonProtocols ? { hostDaemonProtocols } : {}),
      ...(options.force !== undefined ? { force: options.force } : {})
    })
  const census = censusForLockedRecord(options, record)
  let plan = planFor(census)
  if (plan.action === 'noop') {
    return { outcome: 'already-active', fullVersion }
  }
  const refusal = options.admitRecord?.(record, fullVersion)
  if (refusal) {
    return notActivated(HIVEWARDD_ACTIVATION_POLICY_REFUSED_CODE, refusal)
  }
  // Hosts predating the census protocol set cannot name mixed generations; the candidate can.
  const asksCandidate = censusNeedsHostDaemonProtocols(census)
  if (
    plan.action === 'defer' &&
    !(asksCandidate && plan.code === 'hivewardd_update_daemon_protocol_unverifiable')
  ) {
    return notActivated(plan.code, plan.reason)
  }
  const preflight = await preflightHivewarddCandidate(
    { ...options, remoteInstallDir: remoteDir, fullVersion },
    asksCandidate
  )
  if ('failure' in preflight) {
    return notActivated('hivewardd_candidate_preflight_failed', preflight.failure)
  }
  const { hostDaemonProtocols } = preflight
  plan = planFor(census, hostDaemonProtocols)
  if (plan.action === 'defer') {
    return notActivated(plan.code, plan.reason)
  }

  let incumbent: HivewarddSlotIdentity | null = null
  if (record.active) {
    try {
      incumbent = await resolveHivewarddSlotIdentity(options, record.active)
    } catch (error) {
      if (isUnconfirmedSshCommandTermination(error)) {
        throw error
      }
      return notActivated(
        'hivewardd_incumbent_identity_unverifiable',
        `The active hivewardd ${record.active} build identity could not be verified before ` +
          `stopping it: ${errorMessage(error)} Nothing was stopped.`
      )
    }
  } else {
    const admission = parseInitialHivewarddActivationAdmission(
      await execHivewarddRemoteOr(
        options,
        initialHivewarddActivationAdmissionCommand(
          options.host,
          options.userDataDir,
          remoteDir,
          options.nodePath
        )
      )
    )
    if (admission.decision === 'defer') {
      return notActivated(admission.code, admission.reason)
    }
  }

  // Scan snapshot room before recount so slow scans cannot outdate stop admission.
  const roomless = await hivewarddSnapshotRoomRefusal(options, record, fullVersion)
  if (roomless) {
    return notActivated(HIVEWARDD_SNAPSHOT_SPACE_INSUFFICIENT_CODE, roomless)
  }

  const startedAt = now()
  let transaction: HivewarddActivateTransaction = createHivewarddActivationTransaction({
    transactionId: randomUUID(),
    candidateVersion: fullVersion,
    appVersion: options.appVersion,
    recordBefore: record,
    snapshotDirName: hivewarddSnapshotDirName(fullVersion, startedAt.getTime()),
    now: startedAt
  })
  const beginMutating = (): void => {
    lock.retainOnError()
    // After mutation starts, cancellation would strand a stopped host; finish or roll back.
    options = withoutAbortSignal(options)
  }
  if (incumbent) {
    // Recount immediately before stop; the initial census may predate a long upload.
    const fenced = await runFencedStop({
      recountCensus: () =>
        countedLockedRecord(options, record)
          ? options.recountCensus()
          : Promise.reject(new Error('not the incumbent this update counted')),
      releaseIncumbentAdmission: options.releaseIncumbentAdmission,
      now: () => now().getTime(),
      refuse: (recounted) => {
        const plan = planFor(recounted, hostDaemonProtocols)
        return plan.action === 'defer' ? notActivated(plan.code, plan.reason) : null
      },
      prepare: () => writeHivewarddActivationTransaction(options, transaction),
      stale: () =>
        notActivated(
          'hivewardd_update_terminal_census_unavailable',
          'The terminal count went stale before the current server could be stopped, so nothing ' +
            'was stopped. HiveWard will try the update again.'
        ),
      stop: () => {
        beginMutating()
        return stopTransactionIncumbent(options, incumbent, lock)
      },
      stopMayHaveBeenSent: (unstopped) => unstopped === null || unstopped.stopMayBeUnderway
    })
    if ('refused' in fenced) {
      return fenced.refused
    }
    if (fenced.stopped) {
      return notActivated(
        'hivewardd_outgoing_stop_incomplete',
        `${fenced.stopped.reason} No snapshot was taken and the candidate was not started. HiveWard ` +
          'requires matching runtime readiness before signaling an incumbent and confirmed exit ' +
          'before snapshotting.'
      )
    }
  } else {
    await writeHivewarddActivationTransaction(options, transaction)
    beginMutating()
  }
  transaction = withHivewarddActivationIncumbentStopped(transaction, now())
  await writeHivewarddActivationTransaction(options, transaction)

  // Wait for confirmed exit before snapshotting; a live SQLite WAL is not a backup boundary.
  const snapshotDir = hivewarddSnapshotPath(options, transaction.snapshot.dirName)
  const captureOutput = await execHivewarddStateMutationOr(
    options,
    captureHivewarddStateSnapshotCommand(
      options.host,
      options.userDataDir,
      snapshotDir,
      hivewarddRemoteBaseDir(options.host, options.remoteHome),
      {
        snapshotsRoot: hivewarddSnapshotsRoot(options),
        keep: [transaction.snapshot.dirName, ...(record.snapshot ? [record.snapshot.dirName] : [])]
      }
    ),
    'FAILED'
  )
  const capture = parseHivewarddSnapshotCapture(captureOutput)
  if (capture === 'failed') {
    const reason = hivewarddSnapshotFailureReason(captureOutput)
    const restarted = incumbent
      ? ` The incumbent was stopped before snapshotting; ${await restartAfterSnapshotFailure(options, incumbent, lock)}`
      : ''
    throw new Error(
      `Could not snapshot ${options.userDataDir} before activating ${fullVersion}` +
        `${reason ? `: ${reason}` : ''}. HiveWard's persisted state carries no schema version, so ` +
        'without a snapshot a rollback has no way back. Refusing to activate. Fix what stops ' +
        `the copy (often a full disk or quota on ${hivewarddRemoteBaseDir(options.host, options.remoteHome)}), ` +
        `then reconnect.${restarted}`
    )
  }
  const snapshot: HivewarddStateSnapshot | null =
    capture === 'captured'
      ? {
          dirName: transaction.snapshot.dirName,
          takenBeforeVersion: fullVersion,
          readableByVersion: record.active,
          takenAt: startedAt.toISOString()
        }
      : null
  transaction = withHivewarddActivationSnapshot(transaction, capture, now())
  await writeHivewarddActivationTransaction(options, transaction)

  const { verdict, launchError } = await launchAndJudgeHivewarddSlot(options, {
    remoteInstallDir: remoteDir,
    fullVersion,
    buildHash: computeLocalHivewarddBuildHash(options.localHivewarddDir)
  })
  if (verdict.decision === 'reject') {
    const [code, reason] =
      launchError === undefined
        ? [verdict.code, verdict.reason]
        : [
            hivewarddCandidateLaunchFailureCode(launchError),
            `The candidate failed while starting: ${errorMessage(launchError)}`
          ]
    const restored = await restoreAfterRejectedCandidate(options, lock, {
      launchedDir: hivewarddSlotDir(options, transaction.candidateVersion),
      launchedVersion: transaction.candidateVersion,
      transactionStartedAt: transaction.startedAt,
      incumbent,
      restoreState: transaction.snapshot
    })
    const located =
      `${reason} Candidate stderr is at ` +
      `${joinRemotePath(options.host, remoteDir, HIVEWARDD_LOG_FILENAME)}. ${restored}`
    return notActivated(code, await withHivewarddLogTail(options, remoteDir, located))
  }

  const recordAfter = withActivatedVersion(record, fullVersion, snapshot, now(), options.appVersion)
  transaction = withHivewarddActivationCandidateReady(transaction, recordAfter, now())
  await writeHivewarddActivationTransaction(options, transaction)
  await writeHivewarddActivationRecord(options, recordAfter)
  return { outcome: 'installed-and-activated', fullVersion, verdict }
}
