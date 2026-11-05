/** Activate under a durable host fence/journal only after candidate readiness. Recover the incumbent only with safe profile state; retain changed state/snapshot for explicit recovery. */
import { logHivewarddActivationOutcome } from '../managed-server/activation/hivewardd-activation-outcome-log'
import { join } from 'node:path'
import type { HivewarddHostTransport } from './hivewardd-host-transport'
import type { HivewarddUpdateForce } from './hivewardd-update-plan'
import { HIVEWARDD_INSTALL_MODEL } from '../managed-server/install/remote-install-model'
import {
  computeRemoteInstallDir,
  readLocalFullVersion
} from '../managed-server/install/remote-versioned-install'
import { readHivewarddActivationRecord } from '../managed-server/activation/hivewardd-activation-record-store'
import type { HivewarddActivationRecord } from '../managed-server/activation/hivewardd-activation-record'
import type { HivewarddActivationVerdict } from '../managed-server/activation/hivewardd-activation-gate'
import type { HivewarddTerminalCensus } from '../../shared/hivewardd-terminal-census'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import { installHivewarddBundle } from '../managed-server/install/hivewardd-remote-install'
import { getAppEnvironment } from '../../shared/app-environment'
import type { NodeRuntimeTarget } from '../../shared/node-runtime-pin'
import { HIVEWARDD_STARTUP_READINESS_TIMEOUT_MS } from '../../shared/hivewardd-profile-preflight'
import { materializeHivewarddArtifact } from '../hivewardd/hivewardd-artifact-materializer'
import { readHivewarddBundleTarget } from './hivewardd-deployment-target'
import { resolveHivewarddRuntimeTarget } from '../managed-server/lifecycle/hivewardd-runtime-target'
import {
  hivewarddNodeRuntimeInstallOptions,
  type NodeRuntimeDownloadBudget
} from './hivewardd-node-runtime-install-options'
import {
  hivewarddActivationFenceExists,
  resolveHivewarddActivationReadinessTimeout,
  withHivewarddActivationLock
} from '../managed-server/activation/hivewardd-activation-lock'
import {
  activateInstalledHivewardd,
  HIVEWARDD_ACTIVATION_POLICY_REFUSED_CODE
} from './hivewardd-installed-activation'
import { refuseHivewarddHostIdentity } from './hivewardd-host-version-admission'
import { hivewarddActivationFenceRefusal } from '../managed-server/activation/hivewardd-activation-fence-hold'

export type HivewarddDeployOptions = {
  conn: HivewarddHostTransport
  host: RemoteHostPlatform
  remoteHome: string
  /** An already assembled bundle; otherwise materialize the packaged template for this host. */
  localHivewarddDir?: string
  /** The bundle's runtime target; read from `localHivewarddDir` or probed when absent. */
  target?: NodeRuntimeTarget
  /** Where the pinned runtime archive is cached; defaults beside the hivewardd artifact cache. */
  runtimeCacheRoot?: string
  nodePath: string
  userDataDir: string
  bindHost: string
  port: number
  /** Caller supplies a protocol-aware census; unanswered host evidence must never become zero live terminals. */
  census: HivewarddTerminalCensus
  /** Bind census to its incumbent record; a changed locked record makes earlier counts unverifiable. */
  censusRecord?: HivewarddActivationRecord
  /** WSL only: the record and fence this connect read moments ago; skips the same pre-upload reads. */
  preRead?: { record: HivewarddActivationRecord; fenceOpen: boolean }
  /** WSL only: a same-version deploy skips its fence; the caller's wake re-checks under its own. */
  sameVersionFencedByCaller?: boolean
  /** Recount under fence just before stopping the same incumbent; uploads may outdate initial counts and failures stay unverifiable. */
  recountCensus: () => Promise<HivewarddTerminalCensus>
  /** Best-effort reopen when incumbent keeps serving; admission also expires server-side. */
  releaseIncumbentAdmission: () => Promise<void>
  force?: HivewarddUpdateForce
  /** The HiveWard app version activating, recorded so an older client never downgrades the host. */
  appVersion?: string
  /** Reapply version policy under lock because peer activation/stop may land during upload. */
  admitRecord?: (record: HivewarddActivationRecord, candidateVersion: string) => string | null
  readinessTimeoutMs?: number
  /** WSL only; SSH hosts always re-hash the runtime (see `installHivewarddBundle`). */
  recordedNodeRuntimeProbe?: boolean
  /** WSL only: bounded Node runtime downloads; SSH keeps the default timing. */
  nodeRuntimeDownload?: NodeRuntimeDownloadBudget
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
}

export type HivewarddDeployResult =
  | { outcome: 'installed-and-activated'; fullVersion: string; verdict: HivewarddActivationVerdict }
  | { outcome: 'already-active'; fullVersion: string }
  | { outcome: 'installed-not-activated'; fullVersion: string; code: string; reason: string }

export async function deployHivewardd(
  input: HivewarddDeployOptions,
  retryClearedFence = true
): Promise<HivewarddDeployResult> {
  const target =
    input.target ??
    (input.localHivewarddDir
      ? readHivewarddBundleTarget(input.localHivewarddDir)
      : await resolveHivewarddRuntimeTarget(input))
  const runtimeCacheRoot =
    input.runtimeCacheRoot ?? join(getAppEnvironment().getPath('userData'), 'hivewardd-artifacts')
  const options = {
    ...input,
    target,
    readinessTimeoutMs: resolveHivewarddActivationReadinessTimeout(
      input.readinessTimeoutMs,
      HIVEWARDD_STARTUP_READINESS_TIMEOUT_MS
    ),
    ...hivewarddNodeRuntimeInstallOptions(target, runtimeCacheRoot, input),
    localHivewarddDir:
      input.localHivewarddDir ?? (await materializeHivewarddArtifact(target, { signal: input.signal }))
  }
  const fullVersion = readLocalFullVersion(options.localHivewarddDir)
  const remoteDir = computeRemoteInstallDir(HIVEWARDD_INSTALL_MODEL, options.remoteHome, fullVersion)
  const held = async (): Promise<HivewarddDeployResult> => {
    const { cleared, ...refusal } = await hivewarddActivationFenceRefusal(options, 'update')
    // Retry one cleared abandoned fence; repeated abandonment must surface to the caller.
    if (cleared && retryClearedFence) {
      return deployHivewardd(
        {
          ...input,
          preRead: undefined,
          sameVersionFencedByCaller: undefined,
          target,
          localHivewarddDir: options.localHivewarddDir
        },
        false
      )
    }
    return { outcome: 'installed-not-activated', fullVersion, ...refusal }
  }
  // Refuse before upload, then re-read both admission inputs under fence.
  const preUploadRecord = options.preRead?.record ?? (await readHivewarddActivationRecord(options))
  if (refuseHivewarddHostIdentity(preUploadRecord)) {
    return {
      outcome: 'installed-not-activated',
      fullVersion,
      code: HIVEWARDD_ACTIVATION_POLICY_REFUSED_CODE,
      reason: '无法确认主机上的服务属于 HiveWard，已保留原安装。'
    }
  }
  const censusRecord = options.censusRecord ?? preUploadRecord
  // An unanswered probe only skips this shortcut; lock acquisition still arbitrates.
  if (
    !options.preRead?.fenceOpen &&
    (await hivewarddActivationFenceExists(options).catch(() => false))
  ) {
    return held()
  }

  await installHivewarddBundle(options, fullVersion, remoteDir)
  if (options.sameVersionFencedByCaller && preUploadRecord.active === fullVersion) {
    return { outcome: 'already-active', fullVersion }
  }

  return logHivewarddActivationOutcome(
    `update to ${fullVersion}`,
    () =>
      withHivewarddActivationLock(
        options,
        (lock) =>
          activateInstalledHivewardd({ ...options, censusRecord }, fullVersion, remoteDir, lock),
        held
      ),
    ['installed-and-activated', 'already-active']
  )
}
