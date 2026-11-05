import type { OrchestrationDb } from '../orchestration-db'

const LEGACY_SESSION_COLUMNS = [
  {
    table: 'runs',
    legacy: 'coordinator_orca_session_id',
    current: 'coordinator_hiveward_session_id'
  },
  {
    table: 'runs',
    legacy: 'coordinator_orca_session_id_generation',
    current: 'coordinator_hiveward_session_id_generation'
  },
  {
    table: 'dispatch_contexts',
    legacy: 'assignee_orca_session_id',
    current: 'assignee_hiveward_session_id'
  },
  {
    table: 'dispatch_contexts',
    legacy: 'creator_orca_session_id',
    current: 'creator_hiveward_session_id'
  }
] as const

const SESSION_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_dispatch_session_presentation
    ON dispatch_contexts(status, completed_at) WHERE assignee_hiveward_session_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_runs_coordinator_hiveward_session_id
    ON runs(coordinator_hiveward_session_id) WHERE coordinator_hiveward_session_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_dispatch_assignee_hiveward_session_id
    ON dispatch_contexts(assignee_hiveward_session_id) WHERE assignee_hiveward_session_id IS NOT NULL;
`

/** Move pre-rename Orca session columns and their indexes into the current names in one pass. */
export function migrateV47(this: OrchestrationDb, current: number): void {
  if (current >= 47) {
    return
  }
  const legacyNames = LEGACY_SESSION_COLUMNS.map(({ legacy }) => legacy)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sqlite_master always returns type/name strings for the selected catalog rows.
  const legacyObjects = this.db
    .prepare(
      `SELECT type, name FROM sqlite_master
       WHERE type IN ('index', 'trigger', 'view') AND sql IS NOT NULL
         AND (${legacyNames.map(() => '(sql LIKE ? OR name LIKE ?)').join(' OR ')})`
    )
    .all(...legacyNames.flatMap((name) => [`%${name}%`, `%${name}%`])) as {
    type: string
    name: string
  }[]

  // Indexes and derived objects name the columns a rebuild drops; the runtime recreates its own after migration.
  for (const { type, name } of legacyObjects) {
    this.db.exec(`DROP ${type.toUpperCase()} IF EXISTS "${name.replaceAll('"', '""')}"`)
  }

  for (const { table, legacy, current: target } of LEGACY_SESSION_COLUMNS) {
    if (!this.hasColumn(table, legacy)) {
      continue
    }
    if (!this.hasColumn(table, target)) {
      this.db.exec(`ALTER TABLE ${table} RENAME COLUMN ${legacy} TO ${target}`)
      continue
    }
    this.db
      .prepare(
        `UPDATE ${table} SET ${target} = ${legacy} WHERE ${target} IS NULL AND ${legacy} IS NOT NULL`
      )
      .run()
    this.db.exec(`ALTER TABLE ${table} DROP COLUMN ${legacy}`)
  }

  this.db.exec(SESSION_INDEX_SQL)
}
