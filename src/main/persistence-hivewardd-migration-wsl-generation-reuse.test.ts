/**
 * R47: "Use on this computer again" can hand a later WSL move the generation number an earlier one
 * used. The host stages, commits and keeps receipts by migration id and manifest digest, so two
 * moves sharing a generation never collide; only the desktop's planner reads the generation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HivewarddMigrationManifest } from '../shared/hivewardd-migration/hivewardd-migration-manifest'
import type { Repo } from '../shared/repo-types'
import { manifest } from './persistence/migrating-hivewardd-catalog/persistence-hivewardd-migration-catalog-fixture'
import { createStore, testState } from './persistence/persistence-test-harness'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

const GENERATION = 3

function wslMove(migrationId: string, repoId: string): HivewarddMigrationManifest {
  const repo: Repo = {
    id: repoId,
    path: `/home/dev/${repoId}`,
    displayName: repoId,
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git'
  }
  return manifest({
    migrationId,
    source: {
      kind: 'local-wsl',
      distro: 'Ubuntu',
      scopeRepoIds: [repoId],
      scopeFolderWorkspaceIds: [],
      generation: GENERATION
    },
    payload: { repositories: [repo], projectGroups: [], folderWorkspaces: [] }
  })
}

describe('two WSL moves that share a generation number', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'hiveward-wsl-generation-reuse-'))
  })
  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('stage and commit independently, each under its own receipt', async () => {
    const store = createStore()
    const earlier = wslMove('move-earlier', 'repo-a')
    const later = wslMove('move-later', 'repo-b')
    expect(earlier.manifestSha256).not.toBe(later.manifestSha256)

    expect(store.stageHivewarddMigrationCatalog(earlier).state).toBe('staged')
    expect(store.stageHivewarddMigrationCatalog(later).state).toBe('staged')
    expect(store.commitStagedHivewarddMigrationCatalog(earlier)).toMatchObject({
      state: 'committed',
      receipt: { migrationId: 'move-earlier', repositoryIds: ['repo-a'] }
    })
    // The earlier commit neither committed nor dropped the later stage.
    expect(store.getHivewarddMigrationCatalogState(later).state).toBe('staged')
    expect(store.commitStagedHivewarddMigrationCatalog(later)).toMatchObject({
      state: 'committed',
      receipt: { migrationId: 'move-later', repositoryIds: ['repo-b'] }
    })
    await store.flushPendingOrThrowAsync()

    const restored = createStore()
    for (const move of [earlier, later]) {
      expect(restored.getHivewarddMigrationCatalogState(move)).toMatchObject({
        state: 'committed',
        migrationId: move.migrationId,
        manifestSha256: move.manifestSha256
      })
    }
    expect(
      restored
        .getRepos()
        .map((repo) => repo.id)
        .sort()
    ).toEqual(['repo-a', 'repo-b'])
  })

  it('abort one without touching the other', () => {
    const store = createStore()
    const earlier = wslMove('move-earlier', 'repo-a')
    const later = wslMove('move-later', 'repo-b')
    store.stageHivewarddMigrationCatalog(earlier)
    store.stageHivewarddMigrationCatalog(later)

    expect(store.abortStagedHivewarddMigrationCatalog(later)).toMatchObject({ aborted: true })
    expect(store.getHivewarddMigrationCatalogState(earlier).state).toBe('staged')
    expect(store.commitStagedHivewarddMigrationCatalog(earlier).state).toBe('committed')
    expect(store.getHivewarddMigrationCatalogState(later).state).toBe('absent')
  })
})
