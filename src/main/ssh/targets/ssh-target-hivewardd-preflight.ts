/** Read-only export preflight: catalog rows and representable dormant state can migrate; ownership, live leases and untransferred dependencies block. */
import { isLiveSshPtyLease } from '../../../shared/ssh-types'
import type { Store } from '../../persistence/loading-store/store'
import type {
  HivewarddMigrationBlocker,
  HivewarddMigrationPreflight
} from '../../../shared/hivewardd-migration/hivewardd-migration-preflight'
import {
  createHivewarddMigrationManifest,
  type HivewarddMigrationExportStore
} from '../hivewardd-migration-manifest-export'
import {
  collectTargetCatalogBlockers,
  resolveHivewarddPreflightTarget
} from './ssh-target-hivewardd-claims'
import { collectUntransferredDependentBlockers } from './ssh-target-hivewardd-dependents'
import {
  preservesHivewarddMigrationBridgedPanes,
  type HivewarddMigrationPaneLeasePredicate
} from '../hivewardd-migration-bridged-panes'

export type HivewarddMigrationPreflightStore = HivewarddMigrationExportStore &
  Pick<
    Store,
    'getSshTarget' | 'getSshRemotePtyLeases' | 'inspectHivewarddMigrationUntransferredDependencies'
  >

/** `owner` passes the environment's own fence only when its migration journal is on disk. */
export function preflightHivewarddMigrationExport(
  store: HivewarddMigrationPreflightStore,
  targetId: string,
  owner?: { environmentId: string; recorded: boolean },
  /** COMPAT(legacy-relay-bridge): leases a bridged proof left running for the bridge. */
  bridgedPtyIds: readonly string[] = []
): HivewarddMigrationPreflight {
  const resolved = resolveHivewarddPreflightTarget(store, targetId, owner)
  if ('result' in resolved) {
    return resolved.result
  }
  const { target } = resolved
  const blockers: HivewarddMigrationBlocker[] = [...collectTargetCatalogBlockers(store, target)]
  const terminalLeases = store
    .getSshRemotePtyLeases(targetId)
    .filter((lease) => isLiveSshPtyLease(lease) && !bridgedPtyIds.includes(lease.ptyId))
    .map(({ ptyId, worktreeId, tabId, leafId, state, updatedAt }) => ({
      ptyId,
      worktreeId,
      tabId,
      leafId,
      state,
      updatedAt
    }))
  if (terminalLeases.length > 0) {
    // A relay PTY cannot move to hivewardd; its work must finish first.
    blockers.push({
      code: 'hivewardd_migration_direct_ssh_terminal_leases',
      category: 'live-or-unverifiable',
      terminalLeases
    })
  }
  blockers.push(
    ...collectUntransferredDependentBlockers(store, createHivewarddMigrationManifest(store, target))
  )
  return {
    targetId,
    targetLabel: target.label,
    claimable: !blockers.some(isBlockingHivewarddMigrationBlocker),
    blockers
  }
}

/** Confirmed Move anyway can leave saved state, but desktop drafts that cannot be left still block. */
export function leaveBehindClearsHivewarddMigrationBlockers(
  store: HivewarddMigrationPreflightStore & Pick<Store, 'createHivewarddMigrationLeaveBehindView'>,
  targetId: string,
  bridgedPtyIds: readonly string[] = [],
  isBridgedPaneLease?: HivewarddMigrationPaneLeasePredicate
): boolean {
  const view = store.createHivewarddMigrationLeaveBehindView(targetId)
  const preflight = preflightHivewarddMigrationExport(
    {
      ...view,
      getSshTarget: (id) => store.getSshTarget(id),
      getSshRemotePtyLeases: (id) => store.getSshRemotePtyLeases(id)
    },
    targetId,
    undefined,
    bridgedPtyIds
  )
  const target = store.getSshTarget(targetId)
  return (
    preflight.claimable &&
    target !== undefined &&
    preservesHivewarddMigrationBridgedPanes(
      createHivewarddMigrationManifest(view, target).payload,
      store.getSshRemotePtyLeases(targetId),
      bridgedPtyIds,
      isBridgedPaneLease
    )
  )
}

/** Only saved state blocks: a confirmed "Move anyway" may leave it on this desktop. */
export function onlyLeavableHivewarddMigrationBlockers(
  blockers: readonly HivewarddMigrationBlocker[]
): boolean {
  const blocking = blockers.filter(isBlockingHivewarddMigrationBlocker)
  return (
    blocking.length > 0 &&
    blocking.every((blocker) => blocker.code === 'hivewardd_migration_dependent_state')
  )
}

export function isBlockingHivewarddMigrationBlocker(blocker: HivewarddMigrationBlocker): boolean {
  return (
    blocker.category !== 'drainable-static-state' &&
    blocker.code !== 'hivewardd_migration_saved_port_forwards'
  )
}
