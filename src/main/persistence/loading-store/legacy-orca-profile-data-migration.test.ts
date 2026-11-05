import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { PersistedTrustedHiveWardHooks } from '../../../shared/hiveward-yaml-hook-types'
import {
  closeTestStores,
  createStore,
  readPersistedState,
  testState,
  writeDataFile
} from '../persistence-test-harness'

const TRUSTED_HOOKS: PersistedTrustedHiveWardHooks = {
  '/repo': { all: { approvedAt: 1 } }
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'hiveward-orca-profile-data-'))
})

afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

it('moves old Orca profile domains and hook approvals to their HiveWard names', async () => {
  const legacy = getDefaultPersistedState(testState.dir)
  legacy.settings.nestedWorkerMaxDepth = 1
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture deliberately seeds pre-rename Orca keys removed by the migration under test.
  const legacyKeys = legacy as typeof legacy & {
    orcadMigrationImportReceipts?: unknown[]
    orcadMigrationEvictedReceipts?: unknown[]
    orcadMigrationStagedCatalogs?: unknown[]
  }
  legacyKeys.orcadMigrationImportReceipts = []
  legacyKeys.orcadMigrationEvictedReceipts = []
  legacyKeys.orcadMigrationStagedCatalogs = []
  delete legacy.ui.trustedHiveWardHooks
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture deliberately seeds the old hook-trust key removed by the migration under test.
  ;(legacy.ui as typeof legacy.ui & { trustedOrcaHooks?: typeof TRUSTED_HOOKS }).trustedOrcaHooks =
    TRUSTED_HOOKS
  writeDataFile(legacy)

  const store = await createStore()
  expect(store.getSettings().nestedWorkerMaxDepth).toBe(4)
  store.flush()
  await closeTestStores()

  const saved = readPersistedState()
  expect(saved).not.toHaveProperty('orcadMigrationImportReceipts')
  expect(saved).not.toHaveProperty('orcadMigrationEvictedReceipts')
  expect(saved).not.toHaveProperty('orcadMigrationStagedCatalogs')
  expect(saved).toMatchObject({
    hivewarddMigrationImportReceipts: [],
    hivewarddMigrationEvictedReceipts: [],
    hivewarddMigrationStagedCatalogs: []
  })
  expect(saved.ui).not.toHaveProperty('trustedOrcaHooks')
  expect(saved.ui.trustedHiveWardHooks).toEqual(TRUSTED_HOOKS)

  const reopened = await createStore()
  expect(reopened.getSettings().nestedWorkerMaxDepth).toBe(4)
  expect(reopened.getUI().trustedHiveWardHooks).toEqual(TRUSTED_HOOKS)
})
