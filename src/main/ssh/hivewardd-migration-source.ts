/** Expose fenced-source checks/release through the cutover port; conversion owns terminal assessment, export and fence acquisition. */
import type { HivewarddMigrationSourceKind } from '../../shared/hivewardd-migration/hivewardd-migration-source-kind'
import type {
  HivewarddMigrationCatalogPayload,
  HivewarddMigrationManifest
} from '../../shared/hivewardd-migration/hivewardd-migration-manifest'
import type { HivewarddMigrationSourceCutover } from '../../shared/hivewardd-migration/hivewardd-migration-source-cutover'
import type { HivewarddMigrationManifestExportOptions } from './hivewardd-migration-manifest-export'
import type {
  HivewarddMigrationFenceResult,
  HivewarddMigrationFenceState
} from './hivewardd-migration-source-fence'
import type { HivewarddMigrationTerminalVerdict } from './hivewardd-migration-terminal-gate'

export type HivewarddMigrationSourceCutoverPort = {
  /** Before every stage and commit; throws unless the fenced source still matches the journal. */
  verifyFence: (cutover: HivewarddMigrationSourceCutover) => void
  /** Drops the fence, then the journal; only on proof the destination holds nothing. */
  releaseFence: (cutover: HivewarddMigrationSourceCutover) => Promise<void>
}

type HivewarddMigrationFenceAcquireArgs = {
  destinationEnvironmentId: string
  destinationName: string
  terminalProof: HivewarddMigrationTerminalVerdict
  now?: () => Date
  signal?: AbortSignal
}

export type HivewarddMigrationSource = HivewarddMigrationSourceCutoverPort & {
  readonly kind: HivewarddMigrationSourceKind
  readonly journalKey: string
  collectCatalog: () => HivewarddMigrationCatalogPayload
  /** Rewrite paths before signing; export must not mutate source. */
  exportManifest: (options?: HivewarddMigrationManifestExportOptions) => HivewarddMigrationManifest
  /** Before the fence. Loss of contact is `unverifiable`, never `exited`. */
  assessTerminals: () => Promise<HivewarddMigrationTerminalVerdict>
  retireProvenExitedTerminals: (proof: HivewarddMigrationTerminalVerdict) => void
  /** Throws when the journal cannot be read: an unreadable record keeps the source fenced. */
  resolveFence: () => HivewarddMigrationFenceState
  /** Journal, then fence, then flush, then the terminal re-check under the fence. */
  acquireFence: (args: HivewarddMigrationFenceAcquireArgs) => Promise<HivewarddMigrationFenceResult>
}
