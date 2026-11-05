import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { testHiveWardSessionId } from '../../../shared/hiveward-session-address-test-fixture'
import { OrchestrationDb } from './db'
import { SCHEMA_VERSION } from './db/contract-constants'
import { resolveOrchestrationMigrationStartVersion } from './orchestration-schema-version-skew'

const SESSION_ID = testHiveWardSessionId('5f0c1d9e-2b7a-4c3e-8f61-0a9d2e7b4c11')
const COORDINATOR_PANE = 'tab_coord:11111111-1111-4111-8111-111111111111'
const WORKER_PANE = 'tab_worker:22222222-2222-4222-8222-222222222222'

const LEGACY_INDEX_SQL = `
  CREATE INDEX idx_dispatch_session_presentation
    ON dispatch_contexts(status, completed_at) WHERE assignee_orca_session_id IS NOT NULL;
  CREATE INDEX idx_runs_coordinator_orca_session_id
    ON runs(coordinator_orca_session_id) WHERE coordinator_orca_session_id IS NOT NULL;
  CREATE INDEX idx_dispatch_assignee_orca_session_id
    ON dispatch_contexts(assignee_orca_session_id) WHERE assignee_orca_session_id IS NOT NULL;
`

type Seeded = { runId: string; dispatchId: string }

function seedCurrentRows(db: OrchestrationDb): Seeded {
  const run = db.createRun({
    objective: 'legacy coordinator',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: COORDINATOR_PANE
  })
  const task = db.createTask({ runId: run.id, spec: 'legacy worker' })
  const dispatch = db.createDispatchContext({
    taskId: task.id,
    assigneeHandle: 'term_worker',
    assigneePaneKey: WORKER_PANE,
    creator: { kind: 'terminal', handle: 'term_coord', paneKey: COORDINATOR_PANE },
    maxDepth: Number.MAX_SAFE_INTEGER
  })
  db.db
    .prepare(
      `UPDATE runs SET coordinator_hiveward_session_id = ?,
         coordinator_hiveward_session_id_generation = consumer_generation WHERE id = ?`
    )
    .run(SESSION_ID, run.id)
  db.db
    .prepare(
      `UPDATE dispatch_contexts SET assignee_hiveward_session_id = ?,
         creator_hiveward_session_id = ? WHERE id = ?`
    )
    .run(SESSION_ID, SESSION_ID, dispatch.id)
  return { runId: run.id, dispatchId: dispatch.id }
}

function dropNewSessionIndexes(db: Database.Database): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_dispatch_session_presentation;
    DROP INDEX IF EXISTS idx_runs_coordinator_hiveward_session_id;
    DROP INDEX IF EXISTS idx_dispatch_assignee_hiveward_session_id;
  `)
}

function dropObjectsReferencingNewSessionColumns(db: Database.Database): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sqlite_master always returns type/name strings for the selected catalog rows.
  const rows = db
    .prepare(
      `SELECT type, name FROM sqlite_master
       WHERE type IN ('index', 'trigger', 'view') AND sql IS NOT NULL
         AND (sql LIKE '%_hiveward_session_id%' OR name LIKE '%_hiveward_session_id%')`
    )
    .all() as { type: string; name: string }[]
  for (const { type, name } of rows) {
    db.exec(`DROP ${type.toUpperCase()} IF EXISTS "${name.replaceAll('"', '""')}"`)
  }
}

/** Boss database shape: both column sets exist, new columns are empty, old indexes still point at old columns. */
function makeMixedLegacyDatabase(path: string): Seeded {
  const seed = new OrchestrationDb(path)
  const seeded = seedCurrentRows(seed)
  seed.close()

  const raw = new Database(path)
  dropNewSessionIndexes(raw)
  raw.exec(`
    ALTER TABLE runs ADD COLUMN coordinator_orca_session_id TEXT;
    ALTER TABLE runs ADD COLUMN coordinator_orca_session_id_generation INTEGER;
    ALTER TABLE dispatch_contexts ADD COLUMN assignee_orca_session_id TEXT;
    ALTER TABLE dispatch_contexts ADD COLUMN creator_orca_session_id TEXT;
    UPDATE runs SET coordinator_orca_session_id = coordinator_hiveward_session_id,
      coordinator_orca_session_id_generation = coordinator_hiveward_session_id_generation;
    UPDATE dispatch_contexts SET assignee_orca_session_id = assignee_hiveward_session_id,
      creator_orca_session_id = creator_hiveward_session_id;
    UPDATE runs SET coordinator_hiveward_session_id = NULL,
      coordinator_hiveward_session_id_generation = NULL;
    UPDATE dispatch_contexts SET assignee_hiveward_session_id = NULL,
      creator_hiveward_session_id = NULL;
    ${LEGACY_INDEX_SQL}
  `)
  raw.pragma('user_version = 46')
  raw.close()
  return seeded
}

/** Pre-rename shape: only old column names and old-named indexes exist. */
function makeLegacyOnlyDatabase(path: string): Seeded {
  const seed = new OrchestrationDb(path)
  const seeded = seedCurrentRows(seed)
  seed.close()

  const raw = new Database(path)
  dropObjectsReferencingNewSessionColumns(raw)
  raw.exec(`
    ALTER TABLE runs ADD COLUMN coordinator_orca_session_id TEXT;
    ALTER TABLE runs ADD COLUMN coordinator_orca_session_id_generation INTEGER;
    ALTER TABLE dispatch_contexts ADD COLUMN assignee_orca_session_id TEXT;
    ALTER TABLE dispatch_contexts ADD COLUMN creator_orca_session_id TEXT;
    UPDATE runs SET coordinator_orca_session_id = coordinator_hiveward_session_id,
      coordinator_orca_session_id_generation = coordinator_hiveward_session_id_generation;
    UPDATE dispatch_contexts SET assignee_orca_session_id = assignee_hiveward_session_id,
      creator_orca_session_id = creator_hiveward_session_id;
    ALTER TABLE runs DROP COLUMN coordinator_hiveward_session_id;
    ALTER TABLE runs DROP COLUMN coordinator_hiveward_session_id_generation;
    ALTER TABLE dispatch_contexts DROP COLUMN assignee_hiveward_session_id;
    ALTER TABLE dispatch_contexts DROP COLUMN creator_hiveward_session_id;
    ${LEGACY_INDEX_SQL}
  `)
  raw.pragma('user_version = 46')
  raw.close()
  return seeded
}

function legacySessionColumns(db: Database.Database): string[] {
  return db
    .prepare(
      `SELECT name FROM pragma_table_info('runs')
       UNION ALL SELECT name FROM pragma_table_info('dispatch_contexts')`
    )
    .all()
    .map((row) => String(row.name))
    .filter((name) => name.includes('_orca_session_id'))
}

function objectsReferencingLegacySessionColumns(db: Database.Database): string[] {
  return db
    .prepare(
      `SELECT type || ':' || name AS label FROM sqlite_master
       WHERE type IN ('index', 'trigger', 'view') AND sql IS NOT NULL
         AND (sql LIKE '%_orca_session_id%' OR name LIKE '%_orca_session_id%')
       ORDER BY type, name`
    )
    .all()
    .map((row) => String(row.label))
}

function expectMigrated(path: string, seeded: Seeded): void {
  const db = new OrchestrationDb(path)
  try {
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(legacySessionColumns(db.db)).toEqual([])
    expect(objectsReferencingLegacySessionColumns(db.db)).toEqual([])
    expect(db.getRunRaw(seeded.runId)?.coordinator_hiveward_session_id).toBe(SESSION_ID)
    expect(db.getDispatchContextById(seeded.dispatchId)).toMatchObject({
      assignee_hiveward_session_id: SESSION_ID,
      creator_hiveward_session_id: SESSION_ID
    })
    const presentation = db.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_dispatch_session_presentation'"
      )
      .get()
    expect(String(presentation?.sql)).toContain('assignee_hiveward_session_id')
    expect(
      db.listSessionDispatchesForPresentation(Date.now()).map((candidate) => candidate.dispatch.id)
    ).toContain(seeded.dispatchId)
  } finally {
    db.close()
  }
}

describe('legacy Orca session data migration', () => {
  const tempRoots: string[] = []

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function tempDbPath(): string {
    const root = mkdtempSync(join(tmpdir(), 'hiveward-legacy-orca-session-'))
    tempRoots.push(root)
    return join(root, 'orchestration.db')
  }

  it('copies old columns into the new ones and rebuilds the three old indexes', () => {
    const path = tempDbPath()
    const seeded = makeMixedLegacyDatabase(path)
    expectMigrated(path, seeded)
  })

  it('renames old-only columns in place and rebuilds the three old indexes', () => {
    const path = tempDbPath()
    const seeded = makeLegacyOnlyDatabase(path)
    const probe = new Database(path)
    try {
      // Old-only columns must not look like a broken v6 database.
      expect(resolveOrchestrationMigrationStartVersion(probe, 46, SCHEMA_VERSION)).toBe(46)
    } finally {
      probe.close()
    }
    expectMigrated(path, seeded)
  })
})
