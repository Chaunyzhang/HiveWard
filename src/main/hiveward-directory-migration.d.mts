export type HiveWardDirectoryMigration = {
  status: 'current' | 'migrated' | 'initialized' | 'deferred' | 'failed'
  path: string | null
  backup?: string | null
  reason?: string
  phase?: string
  legacyPresent?: boolean
  recovered?: boolean
  files?: number
  bytes?: number
}

type MigrationLayout = {
  source: string
  target: string
  criticalJsonFiles?: string[]
  renames?: string[][]
}

type AsyncMigrationOptions = MigrationLayout & {
  acquireSourceLease: (source: string) => Promise<null | (() => void | Promise<void>)>
  transformStaging?: (root: string) => Promise<void>
  copyTree?: (source: string, target: string, options: Record<string, unknown>) => Promise<void>
}

type SyncMigrationOptions = MigrationLayout & {
  acquireSourceLease: (source: string) => null | (() => void)
  transformStaging?: (root: string) => void
  copyTree?: (source: string, target: string, options: Record<string, unknown>) => void
}

export function migrateHiveWardDirectory(
  options: AsyncMigrationOptions
): Promise<HiveWardDirectoryMigration>
export function migrateHiveWardDirectorySync(
  options: SyncMigrationOptions
): HiveWardDirectoryMigration
