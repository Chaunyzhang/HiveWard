import {
  evaluateHivewarddActivation,
  type HivewarddActivationVerdict
} from '../managed-server/activation/hivewardd-activation-gate'
import { hivewarddActivationTransactionRoot } from '../managed-server/activation/hivewardd-activation-transaction'
import type { HivewarddReadinessParse } from '../managed-server/install/hivewardd-remote-launch'
import {
  launchHivewarddAndAwaitReadiness,
  type HivewarddRemoteExecTarget
} from '../managed-server/install/hivewardd-remote-runtime-control'
import { isUnconfirmedSshCommandTermination } from './remote-exec/remote-exec-command'

type CandidateLaunchTarget = Parameters<typeof launchHivewarddAndAwaitReadiness>[0] &
  HivewarddRemoteExecTarget & {
    remoteHome: string
    nodePath: string
    userDataDir: string
    bindHost: string
    port: number
  }

/** Rethrow unconfirmed SSH cleanup: it provides no candidate evidence and must never mean rejection. */
export async function launchAndJudgeHivewarddSlot(
  options: CandidateLaunchTarget,
  slot: { remoteInstallDir: string; fullVersion: string; buildHash: string }
): Promise<{ verdict: HivewarddActivationVerdict; launchError: unknown }> {
  let parsed: HivewarddReadinessParse | null = null
  let launchError: unknown
  try {
    parsed = await launchHivewarddAndAwaitReadiness(options, {
      remoteInstallDir: slot.remoteInstallDir,
      nodePath: options.nodePath,
      fullVersion: slot.fullVersion,
      userDataDir: options.userDataDir,
      bindHost: options.bindHost,
      port: options.port,
      activationRoot: hivewarddActivationTransactionRoot(options.host, options.remoteHome)
    })
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    launchError = error
  }
  const verdict = evaluateHivewarddActivation(parsed?.state === 'ready' ? parsed.readiness : null, {
    buildHash: slot.buildHash,
    fullVersion: slot.fullVersion
  })
  return { verdict, launchError }
}
