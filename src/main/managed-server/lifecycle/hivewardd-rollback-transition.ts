import { hivewarddRemoteBaseDir } from '../install/hivewardd-remote-windows-node'
import { randomUUID } from 'node:crypto'
import type { HivewarddRollbackOptions, HivewarddRollbackResult } from '../install/hivewardd-remote-rollback'
import { isUnconfirmedSshCommandTermination } from '../../ssh/remote-exec/remote-exec-command'
import { withRolledBackVersion } from '../activation/hivewardd-activation-record'
import { writeHivewarddActivationRecord } from '../activation/hivewardd-activation-record-store'
import { launchAndJudgeHivewarddSlot } from '../../ssh/hivewardd-candidate-launch-verdict'
import { assessHivewarddRollback } from '../../ssh/hivewardd-update-plan'
import { HIVEWARDD_LOG_FILENAME } from '../install/hivewardd-remote-host-support'
import {
  captureHivewarddStateSnapshotCommand,
  hivewarddRollbackRescueDirName,
  parseHivewarddSnapshotCapture,
  parseHivewarddSnapshotPresence,
  parseHivewarddSnapshotRestore,
  probeHivewarddStateSnapshotCommand,
  restoreHivewarddStateSnapshotCommand
} from '../host-state/hivewardd-state-snapshot'
import {
  newestStateMtimeCommand,
  parseNewestStateMtimeSeconds
} from '../host-state/hivewardd-state-newest-mtime'
import { joinRemotePath } from '../../ssh/ssh-remote-platform'
import type { HivewarddActivationLockControl } from '../activation/hivewardd-activation-lock'
import {
  rollbackStartingState,
  type HivewarddRollbackTransaction
} from '../activation/hivewardd-activation-transaction'
import {
  createHivewarddRollbackTransaction,
  withHivewarddRollbackPhase,
  withHivewarddRollbackRescue
} from '../activation/hivewardd-activation-transaction-transitions'
import { writeHivewarddActivationTransaction } from '../activation/hivewardd-activation-transaction-store'
import { ROLLBACK_STALE_COUNT, rollbackRecountRefusal } from './hivewardd-rollback-admission'
import { runFencedStop } from '../../ssh/hivewardd-fenced-stop'
import { execHivewarddRemoteOr, withoutAbortSignal } from '../install/hivewardd-remote-runtime-control'
import { execHivewarddStateMutationOr } from '../host-state/hivewardd-state-mutation-exec'
import {
  hivewarddSlotDir,
  resolveHivewarddSlotIdentity,
  type HivewarddSlotIdentity
} from '../../ssh/hivewardd-recovery-slot'
import { hivewarddSnapshotPath } from '../../ssh/hivewardd-incumbent-recovery'
import {
  putTransactionIncumbentBack,
  restoreAfterRejectedCandidate
} from '../../ssh/hivewardd-transaction-incumbent'
import {
  readHivewarddRollbackBarrierTarget,
  rollbackBarrierRefusal,
  stopIncumbentBehindTerminalBarrier
} from './hivewardd-rollback-terminal-barrier'
import { withHivewarddLogTail } from '../install/hivewardd-remote-log-tail'
import { errorMessage } from '../../../shared/error-message'

async function stateWritesSinceActivation(options: HivewarddRollbackOptions): Promise<boolean | null> {
  const activatedAtSeconds = Math.floor(Date.parse(options.record.activatedAt ?? '') / 1000)
  if (!Number.isFinite(activatedAtSeconds)) {
    return null
  }
  const newest = parseNewestStateMtimeSeconds(
    await execHivewarddRemoteOr(
      options,
      newestStateMtimeCommand(
        options.host,
        options.userDataDir,
        hivewarddRemoteBaseDir(options.host, options.remoteHome)
      )
    )
  )
  return newest === null ? null : newest >= activatedAtSeconds
}

export async function rollbackHivewarddLocked(
  options: HivewarddRollbackOptions,
  lock: HivewarddActivationLockControl
): Promise<HivewarddRollbackResult> {
  const now = options.now ?? ((): Date => new Date())
  const snapshot = options.record.snapshot
  const presence = snapshot
    ? parseHivewarddSnapshotPresence(
        await execHivewarddRemoteOr(
          options,
          probeHivewarddStateSnapshotCommand(
            options.host,
            hivewarddSnapshotPath(options, snapshot.dirName),
            hivewarddRemoteBaseDir(options.host, options.remoteHome)
          )
        )
      )
    : 'absent'
  const safety = assessHivewarddRollback({
    record: options.record,
    snapshotPresent: presence === 'unverifiable' ? null : presence === 'present',
    census: options.census,
    targetDaemonProtocol: options.targetDaemonProtocol,
    stateWritesSinceActivation: await stateWritesSinceActivation(options)
  })
  if (safety.safety === 'unsafe') {
    return { outcome: 'refused', code: safety.code, reason: safety.reason }
  }
  if (!snapshot || !options.record.active) {
    return {
      outcome: 'refused',
      code: 'hivewardd_rollback_no_active',
      reason: 'No hivewardd version is active on this host, so there is nothing to roll back from.'
    }
  }
  let incumbent: HivewarddSlotIdentity
  try {
    incumbent = await resolveHivewarddSlotIdentity(options, options.record.active)
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    return {
      outcome: 'refused',
      code: 'hivewardd_rollback_active_identity_unverifiable',
      reason: `The active hivewardd identity could not be verified: ${errorMessage(error)} Nothing was changed.`
    }
  }

  const barrierTarget = await readHivewarddRollbackBarrierTarget(options, incumbent.version)
  if (barrierTarget.state === 'refused') {
    return { outcome: 'refused', code: barrierTarget.code, reason: barrierTarget.reason }
  }
  const startedAt = now()
  let transaction: HivewarddRollbackTransaction = createHivewarddRollbackTransaction({
    transactionId: randomUUID(),
    incumbentVersion: incumbent.version,
    targetVersion: safety.target,
    recordBefore: options.record,
    recordAfter: withRolledBackVersion(options.record, startedAt),
    rescueDirName: hivewarddRollbackRescueDirName(incumbent.version, startedAt.getTime()),
    now: startedAt
  })
  const fenced = await runFencedStop({
    recountCensus: options.recountCensus,
    releaseIncumbentAdmission: options.releaseIncumbentAdmission,
    now: () => now().getTime(),
    refuse: rollbackRecountRefusal,
    prepare: () => writeHivewarddActivationTransaction(options, transaction),
    stale: () => ROLLBACK_STALE_COUNT,
    stop: async () => {
      lock.retainOnError()
      // Cancellation after mutation could strand a stopped host; finish or recover instead.
      options = withoutAbortSignal(options)
      // Pre-lock census can go stale; the fenced stop supplies the terminal-safety proof.
      return stopIncumbentBehindTerminalBarrier(
        options,
        transaction.transactionId,
        barrierTarget.context
      )
    },
    // Withdrawn stops leave the incumbent serving and needing admission reopened.
    stopMayHaveBeenSent: (barrier) => barrier.state !== 'withdrawn'
  })
  if ('refused' in fenced) {
    return fenced.refused
  }
  const blocked = rollbackBarrierRefusal(fenced.stopped)
  if (blocked) {
    if (blocked.retainFence) {
      lock.retain()
    }
    const recovered = blocked.restartIncumbent
      ? ` ${await putIncumbentBack(options, lock, transaction, incumbent)}`
      : ''
    return { outcome: blocked.outcome, code: blocked.code, reason: blocked.reason + recovered }
  }
  transaction = withHivewarddRollbackPhase(transaction, 'incumbent-stopped', now())
  await writeHivewarddActivationTransaction(options, transaction)

  const rescue = parseHivewarddSnapshotCapture(
    await execHivewarddStateMutationOr(
      options,
      captureHivewarddStateSnapshotCommand(
        options.host,
        options.userDataDir,
        hivewarddSnapshotPath(options, transaction.rescue.dirName),
        hivewarddRemoteBaseDir(options.host, options.remoteHome)
      )
    )
  )
  if (rescue === 'failed') {
    const recovered = await putIncumbentBack(options, lock, transaction, incumbent)
    return {
      outcome: 'failed',
      code: 'hivewardd_rollback_rescue_snapshot_failed',
      reason:
        'The current state could not be preserved in a rescue snapshot, so the data root was ' +
        `not replaced. ${recovered}`
    }
  }
  transaction = withHivewarddRollbackRescue(transaction, rescue, now())
  await writeHivewarddActivationTransaction(options, transaction)

  // Restore before launching: older builds must never load newer state.
  const restored = parseHivewarddSnapshotRestore(
    await execHivewarddStateMutationOr(
      options,
      restoreHivewarddStateSnapshotCommand(
        options.host,
        options.userDataDir,
        hivewarddSnapshotPath(options, snapshot.dirName),
        hivewarddRemoteBaseDir(options.host, options.remoteHome)
      )
    )
  )
  if (restored !== 'restored') {
    const recovered = await putIncumbentBack(options, lock, transaction, incumbent)
    return {
      outcome: 'failed',
      code: 'hivewardd_rollback_restore_failed',
      reason: `The pre-activation snapshot could not be restored (${restored}). ${recovered}`
    }
  }
  transaction = withHivewarddRollbackPhase(transaction, 'rollback-state-restored', now())
  await writeHivewarddActivationTransaction(options, transaction)

  const targetDir = hivewarddSlotDir(options, safety.target)
  const { verdict, launchError } = await launchAndJudgeHivewarddSlot(options, {
    remoteInstallDir: targetDir,
    fullVersion: safety.target,
    buildHash: options.targetBuildHash
  })
  if (verdict.decision === 'reject') {
    const reason =
      launchError === undefined
        ? verdict.reason
        : `It failed while starting: ${errorMessage(launchError)}`
    const recovered = await restoreAfterRejectedCandidate(options, lock, {
      launchedDir: targetDir,
      launchedVersion: safety.target,
      transactionStartedAt: transaction.startedAt,
      incumbent,
      restoreState: rescueVerdict(transaction),
      launchedFromState: rollbackStartingState(transaction)
    })
    return {
      outcome: 'failed',
      code: launchError === undefined ? verdict.code : 'hivewardd_rollback_target_launch_failed',
      reason: await withHivewarddLogTail(
        options,
        targetDir,
        `The rollback target ${safety.target} did not come up healthy: ${reason} ${recovered} ` +
          `Its stderr is at ${joinRemotePath(options.host, targetDir, HIVEWARDD_LOG_FILENAME)}.`
      )
    }
  }

  // Until target readiness is proven, active must still identify the recoverable incumbent.
  transaction = withHivewarddRollbackPhase(transaction, 'target-ready', now())
  await writeHivewarddActivationTransaction(options, transaction)
  await writeHivewarddActivationRecord(options, transaction.recordAfter)
  return {
    outcome: 'rolled-back',
    target: safety.target,
    discarded: safety.safety === 'lossy' ? safety.discards : [],
    verdict
  }
}

type RestoreState = Parameters<typeof putTransactionIncumbentBack>[2]['restoreState']

function rescueVerdict(transaction: HivewarddRollbackTransaction): RestoreState {
  return transaction.rescue.state === 'pending' ? null : transaction.rescue
}

async function putIncumbentBack(
  options: HivewarddRollbackOptions,
  lock: HivewarddActivationLockControl,
  transaction: HivewarddRollbackTransaction,
  incumbent: HivewarddSlotIdentity
): Promise<string> {
  const failure = await putTransactionIncumbentBack(options, lock, {
    transactionStartedAt: transaction.startedAt,
    launchedVersion: null,
    incumbent,
    restoreState: rescueVerdict(transaction)
  })
  return failure ?? `hivewardd ${incumbent.version} was restored and is serving again.`
}
