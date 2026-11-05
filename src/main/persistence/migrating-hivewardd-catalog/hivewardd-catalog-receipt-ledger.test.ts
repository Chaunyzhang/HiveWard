import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { MAX_HIVEWARDD_MIGRATION_IMPORT_RECEIPTS } from '../../../shared/hivewardd-migration/hivewardd-migration-manifest-validation'
import { manifest } from './persistence-hivewardd-migration-catalog-fixture'
import {
  expireHivewarddMigrationStages,
  findHivewarddMigrationImportReceipt,
  HIVEWARDD_MIGRATION_STAGE_TTL_MS,
  recordHivewarddMigrationImportReceipt
} from './hivewardd-catalog-receipt-ledger'

const empty = { repositories: [], projectGroups: [], folderWorkspaces: [] }

function receiptFor(migrationId: string) {
  const input = manifest({ migrationId, payload: empty })
  return {
    input,
    receipt: {
      version: input.version,
      migrationId,
      manifestSha256: input.manifestSha256,
      source: input.source,
      importedAt: '2026-10-01T00:00:00.000Z',
      repositoryIds: [],
      projectGroupIds: [],
      folderWorkspaceIds: []
    }
  }
}

describe('hivewardd migration receipt ledger', () => {
  it('keeps answering for a commit whose receipt aged out of the bounded list', () => {
    const state = getDefaultPersistedState('/tmp/hivewardd-receipt-ledger')
    const first = receiptFor('migration-0')
    recordHivewarddMigrationImportReceipt(state, first.receipt)
    for (let index = 1; index <= MAX_HIVEWARDD_MIGRATION_IMPORT_RECEIPTS; index++) {
      recordHivewarddMigrationImportReceipt(state, receiptFor(`migration-${index}`).receipt)
    }
    expect(state.hivewarddMigrationImportReceipts).toHaveLength(MAX_HIVEWARDD_MIGRATION_IMPORT_RECEIPTS)
    expect(findHivewarddMigrationImportReceipt(state, first.input)).toEqual(first.receipt)
    expect(findHivewarddMigrationImportReceipt(state, receiptFor('never').input)).toBeUndefined()
  })

  it('expires a stage no client came back for', () => {
    const state = getDefaultPersistedState('/tmp/hivewardd-receipt-ledger')
    const stagedAt = '2026-10-01T00:00:00.000Z'
    state.hivewarddMigrationStagedCatalogs = [{ version: 1, manifest: manifest(), stagedAt }]
    const start = Date.parse(stagedAt)
    expect(expireHivewarddMigrationStages(state, start + HIVEWARDD_MIGRATION_STAGE_TTL_MS - 1)).toBe(false)
    expect(expireHivewarddMigrationStages(state, start + HIVEWARDD_MIGRATION_STAGE_TTL_MS)).toBe(true)
    expect(state.hivewarddMigrationStagedCatalogs).toEqual([])
  })
})
