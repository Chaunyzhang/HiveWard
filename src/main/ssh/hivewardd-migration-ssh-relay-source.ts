import { HIVEWARDD_MIGRATION_SSH_RELAY_SOURCE_KIND } from '../../shared/hivewardd-migration/hivewardd-migration-source-kind'
import type { SshTarget } from '../../shared/ssh-types'
import { collectHivewarddMigrationSourceCatalog } from '../persistence/migrating-hivewardd-catalog/hivewardd-source-catalog'
import type { Store } from '../persistence/loading-store/store'
import { createHivewarddMigrationManifest } from './hivewardd-migration-manifest-export'
import { IDENTITY_HIVEWARDD_MIGRATION_PATH_REWRITER } from './hivewardd-migration-path-rewrite'
import type {
  HivewarddMigrationSource,
  HivewarddMigrationSourceCutoverPort
} from './hivewardd-migration-source'
import { assertHivewarddMigrationSourceUnchanged } from './hivewardd-migration-source-assertions'
import {
  fenceHivewarddMigrationSource,
  releaseHivewarddMigrationFence,
  resolveHivewarddMigrationFence
} from './hivewardd-migration-source-fence'
import {
  assessHivewarddMigrationTerminals,
  retireProvenExitedLeases,
  type CensusHostRelayTerminals
} from './hivewardd-migration-terminal-gate'
import type { SshTargetHivewarddClaims } from './targets/ssh-target-hivewardd-claims'
import type { HivewarddMigrationPreflightStore } from './targets/ssh-target-hivewardd-preflight'
import type { HivewarddMigrationPaneLeasePredicate } from './hivewardd-migration-bridged-panes'

type SshRelayCutoverDeps = {
  userDataPath: string
  store: HivewarddMigrationPreflightStore
  claims: SshTargetHivewarddClaims
  /** Rebuild copied stores for every check so later edits remain visible. */
  freshSource?: () => HivewarddMigrationPreflightStore
  signal?: AbortSignal
}

export function sshRelayMigrationCutoverPort(
  deps: SshRelayCutoverDeps
): HivewarddMigrationSourceCutoverPort {
  return {
    verifyFence: (cutover) =>
      assertHivewarddMigrationSourceUnchanged(
        { userDataPath: deps.userDataPath, store: deps.freshSource?.() ?? deps.store },
        cutover
      ),
    releaseFence: (cutover) => releaseHivewarddMigrationFence(deps, cutover)
  }
}

export function createSshRelayMigrationSource(
  deps: SshRelayCutoverDeps & {
    store: HivewarddMigrationPreflightStore &
      Pick<Store, 'getSshRemotePtyLeases' | 'markSshRemotePtyLease'>
    target: SshTarget
    /** Every relay endpoint on the host's account; without it exit can never be proven. */
    censusHost?: CensusHostRelayTerminals | null
    isBridgedPaneLease?: HivewarddMigrationPaneLeasePredicate
  }
): HivewarddMigrationSource {
  const { userDataPath, store, target } = deps
  return {
    ...sshRelayMigrationCutoverPort(deps),
    kind: HIVEWARDD_MIGRATION_SSH_RELAY_SOURCE_KIND,
    journalKey: target.id,
    collectCatalog: () => collectHivewarddMigrationSourceCatalog(store, target),
    exportManifest: (options = {}) =>
      createHivewarddMigrationManifest(store, target, {
        ...options,
        rewrite: IDENTITY_HIVEWARDD_MIGRATION_PATH_REWRITER
      }),
    assessTerminals: () => assessHivewarddMigrationTerminals(store, target.id, deps.censusHost),
    retireProvenExitedTerminals: (proof) => retireProvenExitedLeases(store, target.id, proof),
    resolveFence: () => resolveHivewarddMigrationFence(userDataPath, target),
    acquireFence: (args) =>
      fenceHivewarddMigrationSource({
        userDataPath,
        store,
        claims: deps.claims,
        targetId: target.id,
        isBridgedPaneLease: deps.isBridgedPaneLease,
        ...args
      })
  }
}
