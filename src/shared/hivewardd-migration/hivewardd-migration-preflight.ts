import type { FolderWorkspace } from '../folder-workspace-types'
import type { Repo } from '../repo-types'
import type { SavedPortForward, SshRemotePtyLease } from '../ssh-types'

export const HIVEWARDD_MIGRATION_DEPENDENCY_KINDS = [
  'saved-port-forward',
  'terminal-lease',
  'terminal-recovery',
  'workspace-session',
  'worktree-metadata',
  'worktree-lineage',
  'workspace-lineage',
  'sparse-preset',
  'retired-worktree-name',
  'automation',
  'automation-run',
  'mobile-tab-selection',
  'ui-routing'
] as const

export type HivewarddMigrationDependencyKind = (typeof HIVEWARDD_MIGRATION_DEPENDENCY_KINDS)[number]

export type HivewarddMigrationDependency = {
  kind: HivewarddMigrationDependencyKind
  count: number
  /** A bounded sample of what holds the reference, so the user can find and clear it. */
  names?: string[]
}

export type HivewarddMigrationRepository = Pick<Repo, 'id' | 'path' | 'displayName' | 'kind'>
export type HivewarddMigrationFolderWorkspace = Pick<FolderWorkspace, 'id' | 'name' | 'folderPath'>
export type HivewarddMigrationTerminalLease = Pick<
  SshRemotePtyLease,
  'ptyId' | 'worktreeId' | 'tabId' | 'leafId' | 'state' | 'updatedAt'
>

export type HivewarddMigrationBlocker =
  | {
      code: 'hivewardd_migration_target_not_found'
      category: 'registration'
    }
  | {
      code: 'hivewardd_migration_target_owned'
      category: 'exclusive-ownership'
      holder:
        | { kind: 'runtime'; runtimeId: string }
        | { kind: 'managed-server'; environmentId: string }
    }
  | {
      /** Owned by the asking environment, but no durable record of why. */
      code: 'hivewardd_migration_owner_unrecorded'
      category: 'exclusive-ownership'
    }
  | {
      code: 'hivewardd_migration_direct_ssh_repositories'
      category: 'drainable-static-state'
      repositories: HivewarddMigrationRepository[]
    }
  | {
      code: 'hivewardd_migration_direct_ssh_folder_workspaces'
      category: 'drainable-static-state'
      folderWorkspaces: HivewarddMigrationFolderWorkspace[]
    }
  | {
      code: 'hivewardd_migration_direct_ssh_terminal_leases'
      category: 'live-or-unverifiable'
      terminalLeases: HivewarddMigrationTerminalLease[]
    }
  | {
      code: 'hivewardd_migration_saved_port_forwards'
      category: 'client-owned-state'
      portForwards: SavedPortForward[]
    }
  | {
      code: 'hivewardd_migration_dependent_state'
      category: 'client-owned-state'
      dependencies: HivewarddMigrationDependency[]
    }
  | {
      code: 'hivewardd_migration_dependency_unverifiable'
      category: 'live-or-unverifiable'
      sources: HivewarddMigrationDependencyKind[]
    }

export type HivewarddMigrationPreflight = {
  targetId: string
  targetLabel: string | null
  claimable: boolean
  blockers: HivewarddMigrationBlocker[]
}
