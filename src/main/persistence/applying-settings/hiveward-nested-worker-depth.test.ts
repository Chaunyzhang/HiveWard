import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { closeTestStores, createStore, testState, writeDataFile } from '../persistence-test-harness'

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'hiveward-nested-depth-'))
})

afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

it.each([
  { saved: undefined, expected: 4 },
  { saved: 1, expected: 4 },
  { saved: 2, expected: 2 },
  { saved: 3, expected: 3 },
  { saved: 7, expected: 7 }
])('旧用户层级 $saved 升级、重开后为 $expected', async ({ saved, expected }) => {
  const legacy = getDefaultPersistedState(testState.dir)
  if (saved === undefined) {
    delete legacy.settings.nestedWorkerMaxDepth
  } else {
    legacy.settings.nestedWorkerMaxDepth = saved
  }
  writeDataFile(legacy)
  const store = await createStore()
  expect(store.getSettings().nestedWorkerMaxDepth).toBe(expected)
  store.flush()
  await closeTestStores()
  const reopened = await createStore()
  expect(reopened.getSettings().nestedWorkerMaxDepth).toBe(expected)
})
