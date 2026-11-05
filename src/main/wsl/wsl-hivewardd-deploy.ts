/** D1/D2b/D8 reuse SSH installation, activation journals/fences and admission over wsl.exe. C5 pairs through the reported loopback port. */
import { getAppEnvironment } from '../../shared/app-environment'
import type { PairingOffer } from '../../shared/pairing'
import { HIVEWARDD_MANAGED_REMOTE_PORT } from '../../shared/hivewardd-managed-runtime'
import type { ServeReadiness } from '../server/serve-readiness'
import type { WslHostDeferredUpdate } from '../../shared/wsl-host-types'
import { recoverInterruptedHivewarddActivation } from '../managed-server/activation/hivewardd-activation-recovery'
import { readHivewarddActivationRecord } from '../managed-server/activation/hivewardd-activation-record-store'
import { materializeHivewarddArtifact } from '../hivewardd/hivewardd-artifact-materializer'
import type { HivewarddHostTransport } from '../ssh/hivewardd-host-transport'
import { HIVEWARDD_ACTIVATION_POLICY_REFUSED_CODE } from '../ssh/hivewardd-installed-activation'
import { hivewarddBoundPort } from '../managed-server/lifecycle/hivewardd-managed-bound-port'
import {
  isForceableHivewarddDeferral,
  managedHivewarddDeployPolicy,
  managedHivewarddSlot
} from '../managed-server/lifecycle/hivewardd-managed-runtime-context'
import { isWaitingHivewarddUpdateDeferral } from '../managed-server/lifecycle/hivewardd-managed-auto-update'
import { clearHivewarddUpdateFailedThisLaunch } from '../managed-server/lifecycle/hivewardd-managed-update-failure-memory'
import type { HivewarddUpdateIntent } from '../managed-server/lifecycle/hivewardd-managed-update-decision'
import type { HivewarddActivationRecord } from '../managed-server/activation/hivewardd-activation-record'
import { errorMessage } from '../../shared/error-message'
import { pruneWslHivewarddVersionsUntilClean } from './wsl-hivewardd-version-gc-memo'
import { pruneSupersededHivewarddCandidates } from '../managed-server/lifecycle/hivewardd-managed-version-gc'
import { wakeAlreadyActiveHivewardd } from '../ssh/hivewardd-already-active-wake'
import { HivewarddActiveReadinessError } from '../ssh/hivewardd-active-readiness'
import { WslDistroNotRunningError } from './wsl-hivewardd-connection-errors'
import { deployHivewardd, type HivewarddDeployOptions } from '../ssh/hivewardd-remote-deploy'
import { isWslMoveUnderwayOnHost } from '../persistence/moving-wsl-projects/wsl-move-running-moves'
import { readLocalFullVersion } from '../managed-server/install/remote-versioned-install'
import { createWslDistroHolder, type WslDistroHolder } from './wsl-distro-holder'
import { wslDistroHolderKey } from './wsl-distro-holder-record'
import { readWslDistroRegistryIdShared } from './wsl-distro-registry-id'
import type { WslHivewarddHostTarget } from './wsl-hivewardd-host-target'
import { createWslHivewarddHostTransport, type WslHivewarddHostTransport } from './wsl-hivewardd-host-transport'
import { holdWslDistroWithContext } from './wsl-hivewardd-held-context'
import { deployWslHivewarddWithOneFence } from './wsl-hivewardd-one-fence-deploy'
import { probeWslActiveHivewardd, readWslHivewarddPid } from './wsl-hivewardd-active-probe'
import { wslHivewarddConnectStateHints } from './wsl-hivewardd-connect-state-snapshot'
import { readWslHivewarddIncumbent, type WslHivewarddIncumbent } from './wsl-hivewardd-incumbent'
import { adoptUnrecordedWslHivewardd } from './wsl-hivewardd-instance-adoption'
import {
  admitWslHivewarddLaunch,
  readRestoredWslHivewarddRecord,
  recordWslHivewarddUpdateFailure,
  wslHivewarddDeferralCode,
  wslHivewarddDeferralFailure
} from './wsl-hivewardd-update-admission'
import { withOwnBuildLaunchEnv } from './wsl-hivewardd-own-build-launch-env'
import { WSL_NODE_RUNTIME_DOWNLOAD_BUDGET } from './wsl-node-runtime-download-budget'

/** An update this app carries that the host may not take yet; the incumbent keeps serving. */
export type WslHivewarddDeferredUpdate = WslHostDeferredUpdate

export type WslHivewarddLaunch =
  | {
      outcome: 'ready'
      distro: string
      /** The Lxss registration GUID for the deployment record's `distroId`; null if unreadable. */
      distroId: string | null
      /** The loopback port hivewardd bound inside the distro (another one when the preferred was taken). */
      port: number
      fullVersion: string
      pid: number | null
      readiness: ServeReadiness
      holder: 'adopted' | 'spawned' | 'unverifiable'
      /** An hivewardd the record did not name (e.g. left by a failed Remove), now recorded. */
      adoptedInstance?: { version: string; pid: number }
      /** Set when `fullVersion` is the incumbent because the update must wait. */
      deferredUpdate?: WslHivewarddDeferredUpdate
    }
  | ({ outcome: 'deferred'; distro: string } & WslHivewarddDeferredUpdate)

export type WslHivewarddDeployOptions = {
  /** The WSL environment's id; keys host-scoped state (wake dedupe). Defaults per distro. */
  environmentId?: string
  label?: string
  /** Defaults to a connect. */
  intent?: HivewarddUpdateIntent
  signal?: AbortSignal
  /** Defaults to one created over `userData`; the app should pass its shared instance. */
  holder?: WslDistroHolder
  createTransport?: (target: WslHivewarddHostTarget) => HivewarddHostTransport & { dispose?(): void }
  readRegistryId?: (distro: string) => Promise<string | null>
  readIncumbent?: typeof readWslHivewarddIncumbent
  /** This desktop's enrolled pairing, which the incumbent's terminal count authenticates with. */
  pairedOffer?: PairingOffer | null
  /** The hivewardd template to deploy from; defaults to the packaged one (the C10 lane swaps it). */
  templateDir?: string
  /** A no-boot connect's running check (E9), re-read before any further wake. */
  requireRunning?: () => Promise<boolean>
}

/** Until the persisted deployment record (C7) assigns one, the environment is keyed per distro. */
export function defaultWslHivewarddEnvironmentId(distro: string): string {
  return `wsl:${wslDistroHolderKey(distro)}`
}

export async function deployAndLaunchWslHivewardd(
  distro: string,
  options: WslHivewarddDeployOptions = {}
): Promise<WslHivewarddLaunch> {
  const name = distro.trim()
  if (!name) {
    throw new Error('A WSL distro name is required')
  }
  const target: WslHivewarddHostTarget = {
    kind: 'wsl',
    id: options.environmentId ?? defaultWslHivewarddEnvironmentId(name),
    distro: name,
    label: options.label ?? name
  }
  const conn = (options.createTransport ?? defaultTransport)(target)
  try {
    return await launchOverTransport(name, target, conn, options)
  } finally {
    conn.dispose?.()
  }
}

async function launchOverTransport(
  name: string,
  target: WslHivewarddHostTarget,
  transport: HivewarddHostTransport,
  options: WslHivewarddDeployOptions
): Promise<WslHivewarddLaunch> {
  const { signal } = options
  let ownBuildVersion: string | null = null
  // Set by the serving probe; readyLaunch reads the pid itself for any other version.
  let probed: { fullVersion: string; pid: number | null } | null = null
  const conn = withOwnBuildLaunchEnv(transport, () => ownBuildVersion)
  // Acquire a holder before launch or WSL can idle-stop hivewardd's distro.
  const holder = options.holder ?? createWslDistroHolder({ userDataPath: userDataPath() })
  // Read GUID alongside deploy; failure leaves the record without one.
  const distroId = (options.readRegistryId ?? readWslDistroRegistryIdShared)(name).catch(() => null)
  const first = await holdWslDistroWithContext(name, target, conn, holder, signal)
  const { held, connectState } = first
  let context = first.context
  const hints = wslHivewarddConnectStateHints(connectState, context.activationRecord)
  const slot = managedHivewarddSlot(context, HIVEWARDD_MANAGED_REMOTE_PORT, signal)
  const recovery = await recoverInterruptedHivewarddActivation(slot, connectState ?? undefined)
  if (recovery.outcome === 'pending' || recovery.outcome === 'refused') {
    throw new Error(recovery.reason)
  }
  if (recovery.outcome === 'recovered') {
    context = { ...context, activationRecord: await readHivewarddActivationRecord(slot) }
  }
  // Adopt unrecorded hivewardd before deploy/wake or its instance lock blocks launch.
  const adoption = await adoptUnrecordedWslHivewardd(
    slot,
    context.activationRecord,
    undefined,
    hints.instanceLock(context.activationRecord)
  )
  if (adoption.outcome === 'adopted') {
    context = { ...context, activationRecord: adoption.record }
  }
  const localHivewarddDir = await materializeHivewarddArtifact(context.serverTarget, {
    signal,
    trustVerificationRecord: true,
    ...(options.templateDir ? { templateDir: options.templateDir } : {})
  })
  const appVersion = getAppEnvironment().getVersion()
  const candidateVersion = readLocalFullVersion(localHivewarddDir)
  ownBuildVersion = candidateVersion
  const failureHost = { kind: 'wsl', id: target.id } as const
  const intent = options.intent ?? 'connect'
  const admit = (record: HivewarddActivationRecord, admitIntent: HivewarddUpdateIntent) =>
    admitWslHivewarddLaunch(
      {
        slot,
        record,
        candidateVersion,
        appVersion,
        host: failureHost,
        intent: admitIntent,
        moveRunning: isWslMoveUnderwayOnHost(userDataPath(), name)
      },
      name,
      readyLaunch
    )
  const admitted = await admit(context.activationRecord, intent)
  if ('outcome' in admitted) {
    return admitted
  }
  context = { ...context, activationRecord: admitted }
  const incumbentVersion = context.activationRecord.active
  // Only version changes need incumbent census; same-version connects deploy as no-ops.
  const incumbent: WslHivewarddIncumbent | null =
    incumbentVersion && incumbentVersion !== candidateVersion
      ? await (options.readIncumbent ?? readWslHivewarddIncumbent)({
          context,
          slot,
          paired: options.pairedOffer ?? null
        })
      : null
  const deployOnce = (extra: Partial<HivewarddDeployOptions>) =>
    deployHivewardd({
      ...slot,
      conn,
      localHivewarddDir,
      target: context.serverTarget,
      ...managedHivewarddDeployPolicy(context, appVersion, intent),
      ...(incumbent
        ? {
            census: incumbent.census,
            recountCensus: incumbent.recount,
            releaseIncumbentAdmission: incumbent.releaseAdmission
          }
        : {}),
      force: intent === 'force',
      appVersion,
      recordedNodeRuntimeProbe: true,
      nodeRuntimeDownload: WSL_NODE_RUNTIME_DOWNLOAD_BUDGET,
      ...extra
    }).catch((error: unknown) => {
      if (!signal?.aborted) {
        recordWslHivewarddUpdateFailure(failureHost, incumbentVersion, {
          code: 'hivewardd_update_failed',
          reason: errorMessage(error)
        })
      }
      throw error
    })
  const { deployed, woken } = await deployWslHivewarddWithOneFence(
    slot,
    deployOnce,
    hints.deployPreRead(context.activationRecord)
  )
  if (deployed.outcome === 'installed-not-activated') {
    const failure = wslHivewarddDeferralFailure(deployed)
    recordWslHivewarddUpdateFailure(failureHost, incumbentVersion, failure)
    const restored =
      incumbentVersion && failure ? await readRestoredWslHivewarddRecord(slot, incumbentVersion) : null
    if (restored) {
      // After rollback proof, serve the restored incumbent on this connect too.
      const retried = await admit(restored, 'connect')
      if ('outcome' in retried) {
        return retried
      }
    }
    const deferredUpdate: WslHivewarddDeferredUpdate = {
      candidateVersion: deployed.fullVersion,
      code: await wslHivewarddDeferralCode(slot, deployed, appVersion),
      reason: deployed.reason,
      forceable:
        isForceableHivewarddDeferral(deployed.code) ||
        deployed.code === HIVEWARDD_ACTIVATION_POLICY_REFUSED_CODE
    }
    // Live-terminal deferrals keep the incumbent serving until Update/Force.
    if (
      incumbentVersion &&
      incumbent?.readiness &&
      isWaitingHivewarddUpdateDeferral(deployed.code) &&
      // Another client may have activated since census; refuse stale incumbent assumptions.
      (await readHivewarddActivationRecord(slot)).active === incumbentVersion
    ) {
      const serving = {
        fullVersion: incumbentVersion,
        readiness: incumbent.readiness
      }
      await pruneSupersededHivewarddCandidates(slot, context.serverTarget, deployed.fullVersion)
      return { ...(await readyLaunch(serving)), deferredUpdate }
    }
    return { outcome: 'deferred', distro: name, ...deferredUpdate }
  }
  clearHivewarddUpdateFailedThisLaunch(failureHost)
  const probe = async () => {
    const answer = await probeWslActiveHivewardd(context, localHivewarddDir, deployed.fullVersion, signal)
    probed = { fullVersion: deployed.fullVersion, pid: answer.pid }
    return answer.readiness
  }
  let readiness: ServeReadiness
  if (deployed.outcome === 'already-active') {
    // A stopped distro ended the active slot with it; the one-fence deploy already woke it.
    await (woken ? null : wakeAlreadyActiveHivewardd(slot))
    // Why once more: on a distro still booting, the hivewardd the wake saw serving can exit before
    // the probe; that is a stopped slot to start, not a failed connect.
    readiness = await probe().catch(async (error: unknown) => {
      if (!(error instanceof HivewarddActiveReadinessError) || error.verdict !== 'exited') {
        throw error
      }
      // A `wsl --shutdown` during a no-boot connect must not be undone by this second wake.
      if (options.requireRunning && !(await options.requireRunning())) {
        throw new WslDistroNotRunningError(name)
      }
      await wakeAlreadyActiveHivewardd(slot)
      return probe()
    })
  } else {
    readiness = await probe()
  }
  await pruneWslHivewarddVersionsUntilClean(target.id, {
    slot,
    serverTarget: context.serverTarget,
    activeVersion: deployed.fullVersion,
    readiness
  })
  return readyLaunch({ fullVersion: deployed.fullVersion, readiness })

  async function readyLaunch(serving: {
    fullVersion: string
    readiness: ServeReadiness
  }): Promise<Extract<WslHivewarddLaunch, { outcome: 'ready' }>> {
    // The serving probe already read it; an admission that serves an incumbent did not.
    const pid =
      probed?.fullVersion === serving.fullVersion
        ? probed.pid
        : await readWslHivewarddPid(context, serving.fullVersion, signal)
    return {
      outcome: 'ready',
      distro: name,
      distroId: await distroId,
      port: hivewarddBoundPort(serving.readiness) ?? HIVEWARDD_MANAGED_REMOTE_PORT,
      fullVersion: serving.fullVersion,
      pid,
      readiness: serving.readiness,
      holder: held.outcome,
      ...(adoption.outcome === 'adopted'
        ? { adoptedInstance: { version: adoption.version, pid: adoption.pid } }
        : {})
    }
  }
}

function defaultTransport(target: WslHivewarddHostTarget): WslHivewarddHostTransport {
  return createWslHivewarddHostTransport({ target })
}

function userDataPath(): string {
  return getAppEnvironment().getPath('userData')
}
