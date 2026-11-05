import { randomUUID } from 'node:crypto'
import type { HivewarddManagedRestartResult } from '../../../shared/hivewardd-managed-runtime'
import {
  withHivewarddActivationLock,
  type HivewarddActivationLockControl
} from '../activation/hivewardd-activation-lock'
import { readHivewarddActivationRecord } from '../activation/hivewardd-activation-record-store'
import {
  hivewarddLaunchSshSessionProbeCommand,
  parseHivewarddLaunchSshSession,
  recordsHivewarddLaunchSshSession,
  type HivewarddLaunchSshSession
} from '../../ssh/hivewardd-launch-ssh-session'
import { withManagedHivewarddLifecycle } from '../../ssh/hivewardd-runtime-maintenance'
import {
  managedHivewarddInstallDir,
  managedHivewarddSlot,
  requireManagedHivewarddEnvironment,
  requireManagedHivewarddInfrastructure,
  resolveLinkedHivewarddContext
} from './hivewardd-managed-runtime-context'
import { resolveHivewarddRemoteContext } from '../install/hivewardd-remote-context'
import { sshHivewarddHostTransport } from '../../ssh/hivewardd-ssh-host-transport'
import { rebuildHivewarddManagedTunnel } from './hivewardd-managed-tunnel'
import { wakeStoppedManagedHivewardd } from './hivewardd-managed-wake'
import { readRemoteHivewarddManagedStopTarget } from './hivewardd-managed-remote-stop'
import { hivewarddSlotDir, type HivewarddSlotOptions } from '../../ssh/hivewardd-recovery-slot'
import { stopIncumbentBehindTerminalBarrier } from './hivewardd-rollback-terminal-barrier'
import { execHivewarddRemote } from '../install/hivewardd-remote-runtime-control'
import { collectManagedTerminalCensus } from '../../ssh/hivewardd-terminal-census-client'
import { runFencedStop, updateTerminalCounts } from '../../ssh/hivewardd-fenced-stop'

export async function readManagedHivewarddLaunchSshSession(
  userDataPath: string,
  environmentId: string
): Promise<HivewarddLaunchSshSession> {
  const { deployment } = requireManagedHivewarddEnvironment(userDataPath, environmentId)
  const { connectionManager, targetStore } = requireManagedHivewarddInfrastructure()
  const target = targetStore.getTarget(deployment.sshTargetId)
  // Background checks must not reconnect hosts the user left.
  const connection =
    target && connectionManager.getState(target.id)?.status === 'connected'
      ? (connectionManager.getConnection(target.id) ?? null)
      : null
  if (!target || !connection) {
    return 'unverifiable'
  }
  const context = await resolveHivewarddRemoteContext(target, sshHivewarddHostTransport(connection))
  if (!recordsHivewarddLaunchSshSession(context.host)) {
    return 'not-applicable'
  }
  const active = context.activationRecord.active
  if (!active) {
    return 'not-recorded'
  }
  return parseHivewarddLaunchSshSession(
    await execHivewarddRemote(
      { conn: context.connection, host: context.host },
      hivewarddLaunchSshSessionProbeCommand(
        context.host,
        managedHivewarddInstallDir(context, active),
        context.userDataDir
      )
    )
  )
}

/** Restart only without terminals: surviving daemons retain the old SSH-session attribution. */
export function restartManagedHivewarddEnvironment(
  userDataPath: string,
  selector: string
): Promise<HivewarddManagedRestartResult> {
  return withManagedHivewarddLifecycle(userDataPath, selector, async ({ environment, deployment }) => {
    const context = await resolveLinkedHivewarddContext(environment, deployment)
    if (!context.activationRecord.active) {
      return { outcome: 'not-restarted', reason: 'This host has no activated HiveWard server.' }
    }
    const counts = updateTerminalCounts((options) =>
      collectManagedTerminalCensus(
        userDataPath,
        environment,
        context.activationRecord,
        undefined,
        options
      )
    )
    // Reject live terminals before waiting for the host lock.
    const census = await counts.countFirst()
    if (census.liveSessions !== 0) {
      return { outcome: 'terminals-running', liveSessions: census.liveSessions }
    }
    const slot = managedHivewarddSlot(context, deployment.remotePort)
    const stopped = await withHivewarddActivationLock(
      slot,
      (lock) => recountThenStop(slot, lock, counts),
      (): StopOutcome => ({
        state: 'kept',
        reason: 'An update, rollback or recovery holds this host; try again when it finishes.'
      })
    )
    if (stopped.state === 'terminals-running') {
      return { outcome: 'terminals-running', liveSessions: stopped.liveSessions }
    }
    if (stopped.state === 'kept') {
      return { outcome: 'not-restarted', reason: stopped.reason }
    }
    // Wake even when daemon retirement failed: the stopped server cannot serve clients.
    const wake = await wakeStoppedManagedHivewardd(slot)
    if (wake.outcome !== 'started' && wake.outcome !== 'serving') {
      return {
        outcome: 'not-restarted',
        reason:
          wake.outcome === 'recovery-refused'
            ? wake.reason
            : `This host’s HiveWard server stopped but did not start again (${wake.outcome}); reconnect to start it.`
      }
    }
    // Restart may bind a different port than the existing forward.
    await rebuildHivewarddManagedTunnel(userDataPath, environment.id)
    const dir = hivewarddSlotDir(slot, stopped.version)
    if (stopped.state === 'daemon-kept') {
      // A retained daemon keeps old attribution, so preserve the warning.
      return { outcome: 'not-restarted', reason: stopped.reason }
    }
    const session = parseHivewarddLaunchSshSession(
      await execHivewarddRemote(
        slot,
        hivewarddLaunchSshSessionProbeCommand(slot.host, dir, slot.userDataDir)
      )
    )
    if (session === 'exited') {
      return {
        outcome: 'not-restarted',
        reason:
          'This host’s HiveWard server restarted, but its terminals still belong to an SSH session ' +
          'that has ended: its terminal daemon was still running, or this connection opens a ' +
          'new SSH session for each command. Turn on SSH connection reuse for this host if ' +
          'it is off, then restart again.'
      }
    }
    return { outcome: 'restarted', environmentId: environment.id }
  })
}

type StopOutcome =
  | { state: 'retired'; version: string }
  /** The surviving daemon still spawns terminals with old attribution. */
  | { state: 'daemon-kept'; version: string; reason: string }
  /** Serving or possibly stopping; do not start another instance. */
  | { state: 'kept'; reason: string; mayBeStopping?: true }
  | { state: 'terminals-running'; liveSessions: number | null }

/** Only the host lock holder may close/reopen admission, preserving other runs' fences. */
async function recountThenStop(
  slot: HivewarddSlotOptions,
  lock: HivewarddActivationLockControl,
  counts: ReturnType<typeof updateTerminalCounts>
): Promise<StopOutcome> {
  const fenced = await runFencedStop({
    ...counts,
    now: Date.now,
    refuse: (census): StopOutcome | null =>
      census.liveSessions === 0
        ? null
        : { state: 'terminals-running', liveSessions: census.liveSessions },
    stale: (): StopOutcome => STALE_COUNT,
    stop: (stillFenced) => stopRetiringIdleDaemon(slot, lock, stillFenced),
    // Woken servers start with admission open; only unsent stops need reopening.
    stopMayHaveBeenSent: (outcome) =>
      outcome.state === 'retired' ||
      outcome.state === 'daemon-kept' ||
      (outcome.state === 'kept' && outcome.mayBeStopping === true)
  })
  return 'refused' in fenced ? fenced.refused : fenced.stopped
}

const STALE_COUNT: StopOutcome = {
  state: 'kept',
  reason: 'The terminal count went stale before the stop. Restart again.'
}

async function stopRetiringIdleDaemon(
  slot: HivewarddSlotOptions,
  lock: HivewarddActivationLockControl,
  stillFenced: () => boolean
): Promise<StopOutcome> {
  // Other clients may change the active slot; reread under the fence.
  const active = (await readHivewarddActivationRecord(slot)).active
  if (!active) {
    return { state: 'kept', reason: 'This host has no activated HiveWard server.' }
  }
  const target = await readRemoteHivewarddManagedStopTarget(slot, active)
  if (target.state === 'refused') {
    return { state: 'kept', reason: target.reason }
  }
  // Expired census fences may have admitted terminals; do not stop after expiry.
  if (!stillFenced()) {
    return STALE_COUNT
  }
  const barrier = await stopIncumbentBehindTerminalBarrier(slot, randomUUID(), target.context)
  switch (barrier.state) {
    case 'retired':
      return { state: 'retired', version: active }
    case 'unproven':
      return {
        state: 'daemon-kept',
        version: active,
        reason:
          'This host’s HiveWard server restarted, but its terminal daemon kept running because a terminal ' +
          'was open at the stop, so terminals may still lack local network access.'
      }
    case 'unsettled':
      // Recovery must retain the fence while hivewardd may still be stopping.
      lock.retain()
      return { state: 'kept', reason: barrier.reason, mayBeStopping: true }
    case 'withdrawn':
      return { state: 'kept', reason: barrier.reason }
  }
}
