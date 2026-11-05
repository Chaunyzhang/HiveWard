/** C4 recovery uses bounded relaunch backoff, then census before publishing terminal verdicts. Recovery is never a user action, so it needs a confirmed-running distro and never boots one (E9). */
import type { HivewarddTerminalCensus } from '../../shared/hivewardd-terminal-census'
import { wslHostStatusDetailText } from '../../shared/wsl-host-failure-copy'
import type { WslRunningDistrosRead } from '../wsl-background-distro-gate'
import { wslDistroHolderKey } from './wsl-distro-holder-record'
import type { WslHivewarddConnection, WslHivewarddConnectOptions } from './wsl-hivewardd-connection'
import type { WslHivewarddConnectionStatus } from './wsl-hivewardd-connection-status'
import type { WslLivenessVerdict } from './wsl-hivewardd-liveness-verdict'
import type { WslHivewarddReconnectBackoff } from './wsl-hivewardd-reconnect-backoff'

export type WslHivewarddRecoveryReason = 'hivewardd-exited' | 'distro-restarted' | 'distro-stopped'

export type WslHivewarddRecoveryContext = {
  distro: string
  backoff: WslHivewarddReconnectBackoff
  now: () => number
  /** False once the distro stopped being supervised or a newer recovery took over. */
  current: () => boolean
  wait: (delayMs: number) => Promise<void>
  publish: (status: WslHivewarddConnectionStatus) => void
  ensure: (options: WslHivewarddConnectOptions) => Promise<WslHivewarddConnection>
  collectCensus: (connection: WslHivewarddConnection) => Promise<HivewarddTerminalCensus>
  /** Records the new hivewardd's identity and holds a fresh watch. */
  arm: (connection: WslHivewarddConnection) => Promise<void>
  readRunning: () => Promise<WslRunningDistrosRead>
}

/** Ends ready, failed, or with the verdict the background gate found instead (returned). */
export async function recoverWslHivewardd(
  context: WslHivewarddRecoveryContext,
  reason: WslHivewarddRecoveryReason
): Promise<WslLivenessVerdict | null> {
  const terminals = reason === 'hivewardd-exited' ? 'unverifiable' : 'exited'
  for (;;) {
    const decision = context.backoff.next(context.now())
    if (decision.kind === 'give-up') {
      const gaveUp = wslHostStatusDetailText('restartGaveUp', {
        distro: context.distro,
        count: decision.attempts
      })
      context.publish({
        state: 'failed',
        reason: gaveUp.text,
        reasonCode: gaveUp.code,
        reasonParams: gaveUp.params,
        terminals
      })
      return null
    }
    const reconnecting = {
      state: 'reconnecting',
      reason,
      attempt: decision.attempt,
      terminals
    } as const
    context.publish({ ...reconnecting, retryInMs: decision.delayMs })
    await context.wait(decision.delayMs)
    if (!context.current()) {
      return null
    }
    const gate = backgroundRecoveryGate(await context.readRunning(), context.distro)
    if (gate || !context.current()) {
      return gate
    }
    try {
      const connection = await context.ensure({
        status: {
          pending: { ...reconnecting, retryInMs: null },
          ready: { ...reconnecting, reason: 'census', retryInMs: null }
        }
      })
      if (!context.current()) {
        return null
      }
      // Recount before marking terminals; the daemon may have preserved all sessions across hivewardd loss.
      const census = await context.collectCensus(connection)
      await context.arm(connection)
      if (context.current()) {
        context.publish({ state: 'ready', census })
      }
      return null
    } catch (error) {
      console.warn(
        `[wsl] reconnect to ${context.distro} failed:`,
        error instanceof Error ? error.message : error
      )
      if (!context.current()) {
        return null
      }
    }
  }
}

/** null lets a background recovery go ahead: the distro is confirmed running. */
export function backgroundRecoveryGate(
  running: WslRunningDistrosRead,
  distro: string
): WslLivenessVerdict | null {
  if (running.status !== 'confirmed') {
    return { kind: 'unverifiable', reason: 'running-list-unavailable' }
  }
  const key = wslDistroHolderKey(distro)
  return running.distros.some((candidate) => wslDistroHolderKey(candidate) === key)
    ? null
    : { kind: 'distro-stopped', corroborated: false }
}
