import type { FolderWorkspace } from '../folder-workspace-types'
import type { Automation, AutomationRun } from '../automations-types'
import type { HivewarddMigrationManifestVersion } from './hivewardd-migration-manifest-validation'
import type { ProjectGroup } from '../project-group-types'
import type { Repo } from '../repo-types'
import type { SparsePreset } from '../worktree/create-types'
import type { WorkspaceLineage, WorktreeLineage } from '../worktree/lineage-types'
import type { WorktreeMeta } from '../worktree/meta-types'
import type { RetiredNameRegistry } from '../worktree/retired-name-registry'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import type { HivewarddMigrationClientStatePayload } from './hivewardd-migration-client-state'
import type {
  HivewarddMigrationSnapshotUploadState,
  HivewarddMigrationTerminalScrollbackSnapshot
} from './hivewardd-migration-scrollback'
import type { HivewarddMigrationBlobUploadState } from './hivewardd-migration-blob-transfer'

import { isRecord } from './hivewardd-migration-manifest-fields'

/** The relay-era SSH source: on the wire it never carries `kind` (see hivewardd-migration-source-kind). */
export type HivewarddMigrationSshManifestSource = {
  sshTargetId: string
  sshTargetGeneration: number | null
  targetLabel: string
}

/** Explicit desktop WSL project scope prevents destination path inference; generation orders delta moves. */
export type HivewarddMigrationLocalWslManifestSource = {
  kind: 'local-wsl'
  distro: string
  /** The distro's registry id, when known: a re-registered distro of the same name is another one. */
  distroGuid?: string
  scopeRepoIds: string[]
  scopeFolderWorkspaceIds: string[]
  generation: number
}

export type HivewarddMigrationManifestSource =
  | HivewarddMigrationSshManifestSource
  | HivewarddMigrationLocalWslManifestSource

export type HivewarddMigrationCatalogPayload = {
  repositories: Repo[]
  projectGroups: ProjectGroup[]
  folderWorkspaces: FolderWorkspace[]
  dormantState?: HivewarddMigrationDormantStatePayload
}

export type HivewarddMigrationDormantWorktreeMeta = {
  sourceKey: string
  worktreeId: string
  meta: WorktreeMeta
}

export type HivewarddMigrationDormantWorktreeLineage = {
  sourceKey: string
  worktreeId: string
  lineage: WorktreeLineage
}

export type HivewarddMigrationDormantWorkspaceLineage = {
  sourceKey: string
  childWorkspaceKey: string
  lineage: WorkspaceLineage
}

export type HivewarddMigrationDormantRetiredNames = {
  repoId: string
  registry: RetiredNameRegistry
}

export type HivewarddMigrationDormantRetirementNamespace = {
  sourceNamespaceKeys: string[]
  namespaceKey: string
  registry: RetiredNameRegistry
}

export type HivewarddMigrationDormantStatePayload = {
  version: 1
  worktreeMeta: HivewarddMigrationDormantWorktreeMeta[]
  worktreeLineage: HivewarddMigrationDormantWorktreeLineage[]
  workspaceLineage: HivewarddMigrationDormantWorkspaceLineage[]
  sparsePresets: SparsePreset[]
  retiredWorktreeNames: HivewarddMigrationDormantRetiredNames[]
  retiredWorktreeNamespaces: HivewarddMigrationDormantRetirementNamespace[]
  workspaceSession?: WorkspaceSessionState
  terminalScrollbackSnapshots?: HivewarddMigrationTerminalScrollbackSnapshot[]
  automations?: Automation[]
  automationRuns?: AutomationRun[]
  /** Client-owned durable intent projected to the destination authority. */
  clientState?: HivewarddMigrationClientStatePayload
}

export type HivewarddMigrationManifest = {
  version: HivewarddMigrationManifestVersion
  migrationId: string
  createdAt: string
  source: HivewarddMigrationManifestSource
  payload: HivewarddMigrationCatalogPayload
  /** Destination runtime identity used to re-key desktop routing after commit. */
  destinationEnvironmentId?: string
  manifestSha256: string
}

export type HivewarddMigrationImportReceipt = {
  version: HivewarddMigrationManifestVersion
  migrationId: string
  manifestSha256: string
  source: HivewarddMigrationManifestSource
  importedAt: string
  repositoryIds: string[]
  projectGroupIds: string[]
  folderWorkspaceIds: string[]
}

export type HivewarddMigrationStagedCatalog = {
  version: HivewarddMigrationManifestVersion
  manifest: HivewarddMigrationManifest
  stagedAt: string
}

export type HivewarddMigrationCatalogState =
  | {
      state: 'absent'
      migrationId: string
      manifestSha256: string
    }
  | {
      state: 'staged'
      migrationId: string
      manifestSha256: string
      stagedAt: string
      snapshotUploads?: HivewarddMigrationSnapshotUploadState[]
      /** Blobs staged so far; absent from hosts without the blob channel. */
      blobUploads?: HivewarddMigrationBlobUploadState[]
    }
  | {
      state: 'committed'
      migrationId: string
      manifestSha256: string
      receipt: HivewarddMigrationImportReceipt
    }

export type HivewarddMigrationCatalogAbortResult = HivewarddMigrationCatalogState & {
  aborted: boolean
  durableAbsent?: true
}

export type HivewarddMigrationCatalogReference = Pick<
  HivewarddMigrationManifest,
  'migrationId' | 'manifestSha256'
>

/** An abort by reference: no receipt, since an evicted one is rebuilt only from the manifest. */
export type HivewarddMigrationCatalogReferenceAbortResult = HivewarddMigrationCatalogReference & {
  state: 'absent' | 'committed'
  aborted: boolean
  durableAbsent?: true
  /** The receipt was flushed before this answer; older hosts never send it. */
  durableCommitted?: true
}

export function hivewarddMigrationManifestHashInput(
  manifest: Omit<HivewarddMigrationManifest, 'manifestSha256'>
): string {
  return serializeHivewarddMigrationValue(manifest)
}

export function serializeHivewarddMigrationValue(value: unknown): string {
  return JSON.stringify(canonicalizeJsonValue(value))
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue)
  }
  if (!isRecord(value)) {
    return value
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalizeJsonValue(entry)])
  )
}
