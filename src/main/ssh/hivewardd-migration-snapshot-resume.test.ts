import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { toSshExecutionHostId } from '../../shared/execution-host'
import type {
  HivewarddMigrationCatalogState,
  HivewarddMigrationManifest
} from '../../shared/hivewardd-migration/hivewardd-migration-manifest'
import type { HivewarddMigrationSnapshotChunkRequest } from '../../shared/hivewardd-migration/hivewardd-migration-scrollback'
import type { SshTarget } from '../../shared/ssh-types'
import { closeTestStores, createSqliteTestStore } from '../persistence/persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import { createHivewarddMigrationManifest } from './hivewardd-migration-manifest-export'
import { transferHivewarddMigrationSnapshots } from './hivewardd-migration-snapshot-coordinator'

const TARGET: SshTarget = {
  id: 'ssh-prod',
  label: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'deploy',
  generation: 1
}
const WORKTREE_ID = 'repo-1::/srv/app'
const OUTPUT = 'dormant output\r\n'

const directories: string[] = []
afterEach(async () => {
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function openStore(dataFile: string): Store {
  return createSqliteTestStore(Store, { dataFile })
}

/** Model relay ssh: partitions that retain dormant-tab scrollback inline. */
function relayProfile(): { store: Store; dataFile: string } {
  const directory = mkdtempSync(join(tmpdir(), 'hivewardd-snapshot-resume-'))
  directories.push(directory)
  const dataFile = join(directory, 'hiveward-data.json')
  const store = openStore(dataFile)
  store.addSshTarget(TARGET)
  store.addRepo({
    id: 'repo-1',
    path: '/srv/app',
    displayName: 'App',
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git',
    connectionId: TARGET.id
  })
  store.setWorkspaceSession(
    {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [WORKTREE_ID]: [
          {
            id: 'tab-1',
            ptyId: null,
            worktreeId: WORKTREE_ID,
            title: 'Shell',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: 'leaf-1' },
          activeLeafId: 'leaf-1',
          expandedLeafId: null,
          buffersByLeafId: { 'leaf-1': OUTPUT }
        }
      }
    },
    toSshExecutionHostId(TARGET.id)
  )
  return { store, dataFile }
}

function destination(manifest: HivewarddMigrationManifest, failFirst: boolean) {
  const [snapshot] = manifest.payload.dormantState?.terminalScrollbackSnapshots ?? []
  let received = 0
  let fail = failFirst
  const state = (): Extract<HivewarddMigrationCatalogState, { state: 'staged' }> => ({
    state: 'staged',
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256,
    stagedAt: '2026-10-05T00:00:00.000Z',
    snapshotUploads: [{ ...snapshot!, receivedBytes: received }]
  })
  return {
    readState: async () => state(),
    stageChunk: async (request: HivewarddMigrationSnapshotChunkRequest) => {
      if (fail) {
        fail = false
        throw new Error('transport lost')
      }
      received = request.offset + Buffer.from(request.bytesBase64, 'base64').length
      return {
        migrationId: request.migrationId,
        manifestSha256: request.manifestSha256,
        ref: request.ref,
        acknowledgedOffset: received
      }
    },
    received: () => received
  }
}

async function transfer(
  store: Store,
  manifest: HivewarddMigrationManifest,
  remote: ReturnType<typeof destination>
): Promise<void> {
  await transferHivewarddMigrationSnapshots({
    source: store,
    manifest,
    state: await remote.readState(),
    destination: remote
  })
}

describe('resuming a scrollback upload the journal still holds', () => {
  it('retries after the tab closed and the upload was interrupted', async () => {
    const { store } = relayProfile()
    const manifest = createHivewarddMigrationManifest(store, TARGET)
    store.syncHivewarddMigrationScrollbackRetention([manifest])
    store.setWorkspaceSession(getDefaultWorkspaceSession(), toSshExecutionHostId(TARGET.id))
    const remote = destination(manifest, true)

    await expect(transfer(store, manifest, remote)).rejects.toThrow('transport lost')
    await transfer(store, manifest, remote)

    expect(remote.received()).toBe(Buffer.byteLength(OUTPUT))
  })

  it('recovers after a restart, from the journal alone', async () => {
    const { store, dataFile } = relayProfile()
    const manifest = createHivewarddMigrationManifest(store, TARGET)
    store.syncHivewarddMigrationScrollbackRetention([manifest])
    store.setWorkspaceSession(getDefaultWorkspaceSession(), toSshExecutionHostId(TARGET.id))
    await store.flushPendingOrThrowAsync()
    await closeTestStores()

    const restarted = openStore(dataFile)
    restarted.syncHivewarddMigrationScrollbackRetention([manifest])
    const remote = destination(manifest, false)
    await transfer(restarted, manifest, remote)

    expect(remote.received()).toBe(Buffer.byteLength(OUTPUT))
  })
})
