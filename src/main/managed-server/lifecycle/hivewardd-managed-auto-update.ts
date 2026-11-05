import {
  planManagedHivewarddAutoUpdate,
  type ManagedHivewarddAutoUpdateSkip
} from './hivewardd-managed-update-decision'
import { materializeHivewarddArtifact } from '../../hivewardd/hivewardd-artifact-materializer'
import {
  HivewarddArtifactsUnavailableError,
  HivewarddHostUnsupportedError
} from '../../hivewardd/hivewardd-host-unavailable'
import { findIncompleteManagedHivewarddMigration } from './hivewardd-managed-migration-status'
import { HIVEWARDD_ACTIVATION_FENCE_BUSY_CODE } from '../activation/hivewardd-activation-fence-hold'
import { resolveLinkedHivewarddContext } from './hivewardd-managed-runtime-context'
import {
  runManagedHivewarddUpdate,
  withManagedHivewarddLifecycle
} from '../../ssh/hivewardd-runtime-maintenance'
import type { HivewarddUpdateDeferCode } from '../../ssh/hivewardd-update-plan'
import { readLocalFullVersion } from '../install/remote-versioned-install'

export type ManagedHivewarddAutoUpdateOutcome =
  | { outcome: 'skipped'; reason: ManagedHivewarddAutoUpdateSkip }
  | { outcome: 'updated'; activeVersion: string }
  | { outcome: 'deferred'; code: string; reason: string }
  /** Candidate rejection or update failure; consult host state before assuming the incumbent serves. */
  | { outcome: 'failed'; reason: string }

const WAITING_CODES: ReadonlySet<string> = new Set<
  HivewarddUpdateDeferCode | typeof HIVEWARDD_ACTIVATION_FENCE_BUSY_CODE
>([
  HIVEWARDD_ACTIVATION_FENCE_BUSY_CODE,
  'hivewardd_update_terminals_running',
  'hivewardd_update_terminal_census_unavailable',
  'hivewardd_update_strands_live_terminals',
  'hivewardd_update_daemon_protocol_unverifiable',
  'hivewardd_update_ends_in_process_terminals'
])

/** Temporary deferrals retry on later connects; interrupted activations require recovery. */
export function isWaitingHivewarddUpdateDeferral(code: string): boolean {
  return WAITING_CODES.has(code)
}

export function autoUpdateManagedHivewarddEnvironment(
  userDataPath: string,
  args: {
    environmentId: string
    appVersion: string
    /** Read under the lifecycle lock to observe prior overlapping attempts. */
    failedBefore: () => boolean
    onUpdating: () => void
  }
): Promise<ManagedHivewarddAutoUpdateOutcome> {
  return withManagedHivewarddLifecycle(userDataPath, args.environmentId, async (managed) => {
    // Restarting during migration would race cutover staging.
    if (findIncompleteManagedHivewarddMigration(userDataPath, managed.environment.id)) {
      return { outcome: 'skipped', reason: 'migrating' }
    }
    const context = await resolveLinkedHivewarddContext(managed.environment, managed.deployment)
    const candidateVersion = await bundledManagedHivewarddVersion(context.serverTarget)
    const plan = planManagedHivewarddAutoUpdate({
      record: context.activationRecord,
      candidateVersion,
      appVersion: args.appVersion,
      failedBefore: args.failedBefore()
    })
    if (plan.action === 'skip') {
      return { outcome: 'skipped', reason: plan.reason }
    }
    args.onUpdating()
    let lockedSkip: ManagedHivewarddAutoUpdateSkip | null = null
    try {
      const result = await runManagedHivewarddUpdate(userDataPath, managed, context, {
        // Another desktop may activate or stop a newer build during upload; recheck under the fence.
        admitRecord: (record) => {
          const locked = planManagedHivewarddAutoUpdate({
            record,
            candidateVersion,
            appVersion: args.appVersion,
            failedBefore: false
          })
          if (locked.action === 'update') {
            return null
          }
          lockedSkip = locked.reason
          return `Auto-update skipped under the host fence: ${locked.reason}.`
        }
      })
      if (lockedSkip) {
        return { outcome: 'skipped', reason: lockedSkip }
      }
      if (result.outcome !== 'deferred') {
        return { outcome: 'updated', activeVersion: result.activeVersion }
      }
      return isWaitingHivewarddUpdateDeferral(result.code)
        ? { outcome: 'deferred', code: result.code, reason: result.reason }
        : { outcome: 'failed', reason: result.reason }
    } catch (error) {
      return { outcome: 'failed', reason: error instanceof Error ? error.message : String(error) }
    }
  })
}

type HivewarddTarget = Parameters<typeof materializeHivewarddArtifact>[0]

// Packaged templates cannot change during this session; avoid repeated hashing.
const bundledVersions = new Map<HivewarddTarget, Promise<string | null>>()

/** This build's hivewardd version for `target`; null when the build bundles none for it. */
export function bundledManagedHivewarddVersion(target: HivewarddTarget): Promise<string | null> {
  let version = bundledVersions.get(target)
  if (!version) {
    version = materializeHivewarddArtifact(target).then(readLocalFullVersion, (error: unknown) => {
      if (
        error instanceof HivewarddHostUnsupportedError ||
        error instanceof HivewarddArtifactsUnavailableError
      ) {
        return null
      }
      throw error
    })
    // A transient local failure must not stick for the session.
    version.catch(() => bundledVersions.delete(target))
    bundledVersions.set(target, version)
  }
  return version
}

export function resetBundledHivewarddVersionsForTests(): void {
  bundledVersions.clear()
}
