/** Restore changed state only after proven slot exit and operator consent: a launched RPC server may have created terminals the stopped host cannot census, making the snapshot stale. Use the same rule for failure and crash recovery. */
import { execHivewarddStateMutation } from '../managed-server/host-state/hivewardd-state-mutation-exec'
import { hivewarddRemoteBaseDir } from '../managed-server/install/hivewardd-remote-windows-node'
import type { ServeReadiness } from '../server/serve-readiness'
import { RELAY_REMOTE_DIR } from './remote-exec/remote-frame-protocol'
import { HIVEWARDD_STATE_SNAPSHOT_DIR } from '../managed-server/activation/hivewardd-activation-record'
import type { HivewarddSnapshotVerdict } from '../managed-server/activation/hivewardd-activation-transaction'
import {
  clearHivewarddStateSnapshotMembersCommand,
  compareHivewarddStateSnapshotCommand,
  hivewarddSnapshotIsUnchanged,
  parseHivewarddSnapshotRestore,
  restoreHivewarddStateSnapshotCommand
} from '../managed-server/host-state/hivewardd-state-snapshot'
import { execHivewarddRemote } from '../managed-server/install/hivewardd-remote-runtime-control'
import {
  ensureHivewarddSlotServing,
  launchHivewarddSlot,
  quiesceInterruptedHivewarddSlot,
  type HivewarddSlotIdentity,
  type HivewarddSlotOptions
} from './hivewardd-recovery-slot'
import { joinRemotePath } from './ssh-remote-platform'
import { HIVEWARDD_RECOVERY_CHANGED_STATE_CODE } from '../../shared/hivewardd-managed-runtime'

export type HivewarddIncumbentRecoveryOptions = HivewarddSlotOptions & {
  /** The operator accepted restoring the snapshot over state a launched build changed. */
  acceptChangedState?: boolean
}

type HivewarddIncumbentRecovery =
  | { outcome: 'restored'; readiness: ServeReadiness | null }
  | { outcome: 'refused'; verdict: 'live' | 'unverifiable'; code: string; reason: string }

export function hivewarddSnapshotPath(options: HivewarddSlotOptions, dirName: string): string {
  return joinRemotePath(
    options.host,
    options.remoteHome,
    RELAY_REMOTE_DIR,
    HIVEWARDD_STATE_SNAPSHOT_DIR,
    dirName
  )
}

/** Unverifiable steps throw so the caller retains the fence. */
export async function recoverHivewarddIncumbent(
  options: HivewarddIncumbentRecoveryOptions,
  input: {
    transactionStartedAt: string
    launchedVersion: string | null
    incumbent: HivewarddSlotIdentity | null
    restoreState: HivewarddSnapshotVerdict | null
    /** Rollback may restore a different snapshot from the launched slot's starting state. */
    launchedFromState?: HivewarddSnapshotVerdict | null
    /** This run itself proved both slots exited, so no fresh liveness probe is needed. */
    slotsProvenExited?: boolean
  }
): Promise<HivewarddIncumbentRecovery> {
  const quiescence =
    input.slotsProvenExited || !input.restoreState
      ? 'exited'
      : await quiesceInterruptedHivewarddSlot(options, input.launchedVersion, input.incumbent)
  // With no incumbent there is no older reader to protect; the record names nothing to serve.
  if (quiescence === 'exited' && input.restoreState && input.incumbent) {
    const decision = input.launchedVersion
      ? await decideChangedStateRestore(options, input.launchedFromState ?? input.restoreState)
      : 'restore'
    if (decision !== 'restore' && decision !== 'unchanged') {
      return decision
    }
    // A launched slot that left its starting state untouched still sits on a root to replace.
    if (decision === 'restore' || input.launchedFromState) {
      await restoreState(options, input.restoreState)
    }
  }
  if (!input.incumbent) {
    return { outcome: 'restored', readiness: null }
  }
  return {
    outcome: 'restored',
    readiness: input.slotsProvenExited
      ? await launchHivewarddSlot(options, input.incumbent)
      : await ensureHivewarddSlotServing(options, input.incumbent)
  }
}

async function decideChangedStateRestore(
  options: HivewarddIncumbentRecoveryOptions,
  state: HivewarddSnapshotVerdict
): Promise<'unchanged' | 'restore' | Extract<HivewarddIncumbentRecovery, { outcome: 'refused' }>> {
  if (state.state === 'captured') {
    const snapshotDir = hivewarddSnapshotPath(options, state.dirName)
    // A lost read-only comparison can conservatively mean changed.
    const comparison = await execHivewarddRemote(
      options,
      compareHivewarddStateSnapshotCommand(
        options.host,
        options.userDataDir,
        snapshotDir,
        hivewarddRemoteBaseDir(options.host, options.remoteHome)
      )
    ).catch(() => '')
    if (hivewarddSnapshotIsUnchanged(comparison)) {
      return 'unchanged'
    }
  }
  if (options.acceptChangedState) {
    return 'restore'
  }
  const retained =
    state.state === 'captured' ? ` at ${hivewarddSnapshotPath(options, state.dirName)}` : ''
  return {
    outcome: 'refused',
    verdict: 'unverifiable',
    code: HIVEWARDD_RECOVERY_CHANGED_STATE_CODE,
    reason:
      'The launched build is stopped, but it changed profile state (or the change could not be ' +
      'checked), so the previous build was not restarted against it and this host serves ' +
      'nothing. Recover to restore the prelaunch snapshot' +
      `${retained} and restart the previous build; terminals the launched build started keep ` +
      'running but drop out of the restored state.'
  }
}

async function restoreState(options: HivewarddSlotOptions, state: HivewarddSnapshotVerdict): Promise<void> {
  if (state.state === 'pending') {
    throw new Error('The interrupted transaction has no durable snapshot verdict.')
  }
  const command =
    state.state === 'captured'
      ? restoreHivewarddStateSnapshotCommand(
          options.host,
          options.userDataDir,
          hivewarddSnapshotPath(options, state.dirName),
          hivewarddRemoteBaseDir(options.host, options.remoteHome)
        )
      : clearHivewarddStateSnapshotMembersCommand(
          options.host,
          options.userDataDir,
          hivewarddRemoteBaseDir(options.host, options.remoteHome)
        )
  const restored = parseHivewarddSnapshotRestore(await execHivewarddStateMutation(options, command))
  if (restored !== 'restored') {
    throw new Error(`The prelaunch state could not be restored (${restored}).`)
  }
}
