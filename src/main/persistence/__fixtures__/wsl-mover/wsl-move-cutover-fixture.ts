import { HIVEWARDD_MIGRATION_MANIFEST_VERSION } from '../../../../shared/hivewardd-migration/hivewardd-migration-manifest-validation'
import type { HivewarddMigrationDormantStatePayload } from '../../../../shared/hivewardd-migration/hivewardd-migration-manifest'
import {
  wslMoveJournalKey,
  type WslMoveCutover,
  type WslMoveCutoverPhase
} from '../../../../shared/wsl-move/wsl-move-cutover'
import { computeHivewarddMigrationManifestSha256 } from '../../../hivewardd/hivewardd-migration-manifest-digest'

export function wslMoveCutoverFixture(
  migrationId = 'move-1',
  phase: WslMoveCutoverPhase = 'prepared',
  extra: Partial<WslMoveCutover> = {},
  scope: { repoIds?: string[]; folderWorkspaceIds?: string[] } = {},
  dormantState?: HivewarddMigrationDormantStatePayload,
  distro = 'Ubuntu'
): WslMoveCutover {
  const repoIds = scope.repoIds ?? ['repo-1']
  const folderWorkspaceIds = scope.folderWorkspaceIds ?? []
  const unsigned = {
    version: HIVEWARDD_MIGRATION_MANIFEST_VERSION,
    migrationId,
    createdAt: '2026-10-13T00:00:00.000Z',
    source: {
      kind: 'local-wsl' as const,
      distro,
      scopeRepoIds: repoIds,
      scopeFolderWorkspaceIds: folderWorkspaceIds,
      generation: 1
    },
    payload: {
      repositories: repoIds.map((id) => ({
        id,
        path: `/home/dev/${id}`,
        displayName: id,
        badgeColor: '#000',
        addedAt: 0
      })),
      projectGroups: [],
      folderWorkspaces: folderWorkspaceIds.map((id) => ({
        id,
        projectGroupId: 'group',
        name: id,
        folderPath: `/srv/${id}`,
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        createdAt: 0,
        updatedAt: 0
      })),
      ...(dormantState ? { dormantState } : {})
    },
    destinationEnvironmentId: `wsl:${distro}`
  }
  const manifest = { ...unsigned, manifestSha256: computeHivewarddMigrationManifestSha256(unsigned) }
  return {
    version: 1,
    migrationId,
    phase,
    startedAt: '2026-10-13T00:00:00.000Z',
    updatedAt: '2026-10-13T00:00:00.000Z',
    destinationEnvironmentId: `wsl:${distro}`,
    destinationName: distro,
    journalKey: wslMoveJournalKey(distro),
    manifestSha256: manifest.manifestSha256,
    provenExitedSessionIds: [],
    rewrittenStores: [],
    manifest,
    ...extra
  }
}
