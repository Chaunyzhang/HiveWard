/** Only positive host evidence proves slot exit. Unanswered probes stay unverifiable and never authorize starting a second slot. */
import type { ServeReadiness } from '../server/serve-readiness'
import type { HivewarddActivationExpectation } from '../managed-server/activation/hivewardd-activation-gate'
import { HIVEWARDD_INSTALL_MODEL } from '../managed-server/install/remote-install-model'
import { computeRemoteInstallDir } from '../managed-server/install/remote-versioned-install'
import { readRemoteHivewarddBuildHash } from '../managed-server/install/hivewardd-remote-build-hash'
import {
  launchHivewarddSlotAndAwaitReadiness,
  HivewarddActiveReadinessError,
  probeActiveHivewarddReadiness
} from './hivewardd-active-readiness'
import {
  hivewarddLivenessProbeCommand,
  hivewarddLivenessProvenExited,
  parseHivewarddLiveness,
  type HivewarddLiveness
} from '../managed-server/install/hivewardd-remote-launch'
import {
  parseHivewarddStopOutcome,
  stopHivewarddCommand,
  type HivewarddStopOutcome
} from '../managed-server/install/hivewardd-remote-process-control'
import {
  execHivewarddRemote,
  type HivewarddRemoteExecTarget
} from '../managed-server/install/hivewardd-remote-runtime-control'
import { hivewarddActivationTransactionRoot } from '../managed-server/activation/hivewardd-activation-transaction'
import {
  initialHivewarddActivationAdmissionCommand,
  parseInitialHivewarddActivationAdmission
} from './hivewardd-initial-activation-admission'

export const HIVEWARDD_SLOT_STOP_WAIT_SECONDS = 20

export type HivewarddSlotOptions = HivewarddRemoteExecTarget & {
  remoteHome: string
  /** Host Node for legacy slots only; a slot's own runtime marker wins. */
  nodePath: string
  userDataDir: string
  bindHost: string
  port: number
  readinessTimeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

export type HivewarddSlotIdentity = { version: string; remoteDir: string; buildHash: string }

function expectation(identity: HivewarddSlotIdentity): HivewarddActivationExpectation {
  return { buildHash: identity.buildHash, fullVersion: identity.version }
}

export function hivewarddSlotDir(options: HivewarddSlotOptions, version: string): string {
  return computeRemoteInstallDir(HIVEWARDD_INSTALL_MODEL, options.remoteHome, version)
}

/** Hash installed bytes so readiness must prove the same build. */
export async function resolveHivewarddSlotIdentity(
  options: HivewarddSlotOptions,
  version: string
): Promise<HivewarddSlotIdentity> {
  const remoteDir = hivewarddSlotDir(options, version)
  return { version, remoteDir, buildHash: await readRemoteHivewarddBuildHash(options, remoteDir) }
}

export function launchHivewarddSlot(
  options: HivewarddSlotOptions,
  identity: HivewarddSlotIdentity
): Promise<ServeReadiness> {
  return launchHivewarddSlotAndAwaitReadiness(
    options,
    {
      remoteInstallDir: identity.remoteDir,
      nodePath: options.nodePath,
      fullVersion: identity.version,
      userDataDir: options.userDataDir,
      bindHost: options.bindHost,
      port: options.port,
      // Every SSH launch is client-managed, so every one may idle out and be woken on connect.
      activationRoot: hivewarddActivationTransactionRoot(options.host, options.remoteHome)
    },
    expectation(identity)
  )
}

/** Proves the slot serves, starting it only on proven exit. */
export async function ensureHivewarddSlotServing(
  options: HivewarddSlotOptions,
  identity: HivewarddSlotIdentity
): Promise<ServeReadiness> {
  const liveness = parseHivewarddLiveness(
    await execHivewarddRemote(options, hivewarddLivenessProbeCommand(options.host, identity.remoteDir))
  )
  if (liveness === 'LIVE') {
    return probeActiveHivewarddReadiness(
      { ...options, remoteInstallDir: identity.remoteDir },
      expectation(identity)
    )
  }
  if (!hivewarddLivenessProvenExited(liveness)) {
    throw new HivewarddActiveReadinessError(
      'unverifiable',
      `hivewardd ${identity.version} process state is unverifiable.`
    )
  }
  return launchHivewarddSlot(options, identity)
}

/** `justLaunched` only for a slot this run started; otherwise the readiness PID must agree. */
export async function stopHivewarddSlot(
  options: HivewarddSlotOptions,
  remoteDir: string,
  justLaunched: boolean
): Promise<HivewarddStopOutcome> {
  return parseHivewarddStopOutcome(
    await execHivewarddRemote(
      options,
      stopHivewarddCommand(
        options.host,
        remoteDir,
        justLaunched
          ? { waitSeconds: HIVEWARDD_SLOT_STOP_WAIT_SECONDS, justLaunched: true }
          : { waitSeconds: HIVEWARDD_SLOT_STOP_WAIT_SECONDS, nodePath: options.nodePath }
      )
    )
  )
}

type HivewarddSlotQuiescence = 'exited' | 'other-slot-serving'

/** Prove candidate exit before replacing state and rule out another running slot, unless it already serves. Missing PID files prove nothing: SSH may drop after nohup but before $! is recorded, so inspect data-root ownership. */
export async function quiesceInterruptedHivewarddSlot(
  options: HivewarddSlotOptions,
  /** `null` when nothing was launched, so only `otherSlot` needs ruling out. */
  version: string | null,
  otherSlot: HivewarddSlotIdentity | null
): Promise<HivewarddSlotQuiescence> {
  const remoteDir = version === null ? null : hivewarddSlotDir(options, version)
  const stopped =
    remoteDir === null ? 'already-exited' : await stopHivewarddSlot(options, remoteDir, false)
  let exited = stopped === 'stopped' || stopped === 'already-exited'
  if ((stopped === 'unknown' || stopped === 'unconfirmed') && remoteDir !== null) {
    // No verified answer, e.g. the slot died before readiness; liveness decides.
    exited = hivewarddLivenessProvenExited(await slotLiveness(options, remoteDir))
  }
  if (otherSlot) {
    const other = await slotLiveness(options, otherSlot.remoteDir)
    if (other === 'LIVE' && (exited || stopped === 'no-pid')) {
      // The serving slot holds the instance lock, so a PID-less launch cannot own the state.
      await probeActiveHivewarddReadiness(
        { ...options, remoteInstallDir: otherSlot.remoteDir },
        expectation(otherSlot)
      )
      return 'other-slot-serving'
    }
    if (!hivewarddLivenessProvenExited(other)) {
      throw new HivewarddActiveReadinessError(
        'unverifiable',
        `hivewardd ${version ?? 'candidate'} (${stopped}) and ${otherSlot.version} (${other}) cannot both be ` +
          'ruled out as owners of the shared state; it was not replaced.'
      )
    }
  }
  if (!exited && stopped === 'no-pid' && remoteDir !== null) {
    const admission = parseInitialHivewarddActivationAdmission(
      await execHivewarddRemote(
        options,
        initialHivewarddActivationAdmissionCommand(
          options.host,
          options.userDataDir,
          remoteDir,
          options.nodePath
        )
      )
    )
    exited = admission.decision === 'proceed'
  }
  if (!exited) {
    throw new HivewarddActiveReadinessError(
      'unverifiable',
      `hivewardd ${version ?? 'candidate'} could not be confirmed stopped (${stopped}); replacing its state would be unsafe.`
    )
  }
  return 'exited'
}

export async function slotLiveness(
  options: HivewarddSlotOptions,
  remoteDir: string
): Promise<HivewarddLiveness> {
  return parseHivewarddLiveness(
    await execHivewarddRemote(options, hivewarddLivenessProbeCommand(options.host, remoteDir))
  )
}
