import { mkdtempSync, mkdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getManagedHivewarddFenceEnvironmentId } from '../../../shared/managed-hivewardd-ssh-owner'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../../shared/pairing'
import {
  addManagedHivewarddEnvironment,
  refreshManagedHivewarddPairing,
  removeManagedHivewarddEnvironment
} from '../../../shared/runtime-environment-managed-hivewardd-store'
import { listEnvironments, resolveEnvironment } from '../../../shared/runtime-environment-store'
import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import type { SshRemotePtyLease, SshTarget } from '../../../shared/ssh-types'
import { closeTestStores, createSqliteTestStore } from '../../persistence/persistence-test-harness'
import { Store } from '../../persistence/loading-store/store'
import { listHivewarddMigrationSourceCutovers } from '../../ssh/hivewardd-migration-cutover-journal'
import type { HivewarddManagedConversionArgs } from './hivewardd-runtime-conversion'
import { fakeHivewarddMigrationDestination } from '../../ssh/hivewardd-migration-destination-fake'
import { reconcileManagedHivewarddSshTargets, visibleRepos } from '../../ssh/hivewardd-retained-source'
import { SshConnectionStore } from '../../ssh/connection/ssh-connection-store'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../../shared/constants'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import { TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT } from '../../../shared/terminal-scrollback-limits'
import {
  getProfileTerminalScrollbackSnapshotRoot,
  getTerminalScrollbackSnapshotPath,
  makeTerminalScrollbackSnapshotRef
} from '../../terminal-scrollback-snapshots'

const mocks = vi.hoisted(() => {
  const state: { targetStore: unknown } = { targetStore: null }
  return { state, deploy: vi.fn(), ensureTunnel: vi.fn() }
})
vi.mock('../../ssh/targets/ssh-target-registry', () => ({
  getSshConnectionManager: () => ({}),
  getSshTargetRegistryStore: () => mocks.state.targetStore
}))
vi.mock('./hivewardd-runtime-deployment', () => ({ createManagedHivewarddEnvironment: mocks.deploy }))
vi.mock('./hivewardd-managed-tunnel', () => ({
  ensureHivewarddManagedTunnel: mocks.ensureTunnel,
  closeHivewarddManagedTunnel: async () => {}
}))

const { convertSshTargetToManagedHivewardd } = await import('./hivewardd-runtime-conversion')
const { abandonHivewarddConversion } = await import('../../ssh/hivewardd-conversion-abandon')

const TARGET: SshTarget = {
  id: 'ssh-prod',
  label: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'deploy',
  generation: 2
}

let userDataPath: string
let store: Store
let destination: ReturnType<typeof fakeHivewarddMigrationDestination>

beforeEach(() => {
  vi.resetAllMocks()
  userDataPath = mkdtempSync(join(tmpdir(), 'hivewardd-conversion-'))
  store = createSqliteTestStore(Store, { dataFile: join(userDataPath, 'hiveward-data.json') })
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SshConnectionStore wraps the real test store it is given.
  mocks.state.targetStore = new SshConnectionStore(store as never)
  destination = fakeHivewarddMigrationDestination()
  mocks.ensureTunnel.mockImplementation(resolveEnvironment)
  mocks.deploy.mockImplementation(async (path: string, args: { name: string }) => {
    const owner = getManagedHivewarddFenceEnvironmentId(store.getSshTarget(TARGET.id))
    if (!owner) {
      throw new Error('deploy without a fence')
    }
    if (!listEnvironments(path).some((entry) => entry.id === owner)) {
      addManagedHivewarddEnvironment(path, {
        id: owner,
        name: args.name,
        pairingCode: encodePairingOffer({
          v: PAIRING_OFFER_VERSION,
          endpoint: 'ws://127.0.0.1:46768/',
          deviceToken: 'device-token',
          publicKeyB64: 'public-key'
        }),
        hivewarddDeployment: {
          sshTargetId: TARGET.id,
          sshTargetGeneration: 2,
          localPort: 46_768,
          remotePort: 6_768
        }
      })
    }
    return { outcome: 'created', environment: {}, activeVersion: '1.0.0' }
  })
})

afterEach(async () => {
  await closeTestStores()
  rmSync(userDataPath, { recursive: true, force: true })
})

const releaseDirectSession = vi.fn(async () => {})
const convert = (
  censusHost: HivewarddManagedConversionArgs['censusHost'] = async () => ({
    verdict: 'exited',
    count: 0
  }),
  isBridgedPaneLease?: HivewarddManagedConversionArgs['isBridgedPaneLease']
) =>
  convertSshTargetToManagedHivewardd(userDataPath, {
    sshTargetId: TARGET.id,
    name: 'Managed',
    censusHost,
    isBridgedPaneLease,
    destinationFor: () => destination,
    releaseDirectSession,
    now: () => new Date('2026-10-02T00:00:00.000Z')
  })

describe('converting an SSH host into a managed server', () => {
  it.each(['live', 'unverifiable'] as const)(
    'offers and completes the move with unreadable scrollback while relay terminals are %s',
    async (verdict) => {
      const worktreeId = 'repo-1::/srv/app'
      const tabId = 'a0b28c21-0065-4056-93d5-46fe37604193'
      const leafId = '11111111-1111-4111-8111-111111111111'
      const ref = makeTerminalScrollbackSnapshotRef(tabId, leafId)
      const session = getDefaultWorkspaceSession()
      session.tabsByWorktree[worktreeId] = [
        {
          id: tabId,
          ptyId: null,
          worktreeId,
          title: 'Agent',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
      session.terminalLayoutsByTabId[tabId] = {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        scrollbackRefsByLeafId: { [leafId]: ref }
      }
      const hostId = toSshExecutionHostId(TARGET.id)
      const profile = getDefaultPersistedState(userDataPath)
      profile.repos = store.getRepos()
      profile.sshTargets = [TARGET]
      profile.workspaceSessionsByHostId = { [hostId]: session }
      profile.sshRemotePtyLeases = [
        {
          targetId: TARGET.id,
          ptyId: 'agent-pty',
          tabId,
          leafId,
          worktreeId,
          state: 'detached',
          createdAt: 1,
          updatedAt: 1
        },
        {
          targetId: TARGET.id,
          ptyId: 'older-agent-pty',
          tabId: 'closed-tab',
          leafId,
          worktreeId,
          state: 'expired',
          supersededBy: 'agent-pty',
          createdAt: 1,
          updatedAt: 1
        }
      ]
      const reportDirectory = join(userDataPath, 'reported-profile')
      mkdirSync(reportDirectory)
      const dataFile = join(reportDirectory, 'hiveward-data.json')
      writeFileSync(dataFile, JSON.stringify(profile))
      const snapshotRoot = getProfileTerminalScrollbackSnapshotRoot(dataFile)
      mkdirSync(snapshotRoot)
      const snapshotPath = getTerminalScrollbackSnapshotPath(ref, { snapshotRoot })!
      writeFileSync(snapshotPath, '')
      truncateSync(snapshotPath, TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT + 1)
      store = createSqliteTestStore(Store, { dataFile })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the registry wraps this real test store.
      mocks.state.targetStore = new SshConnectionStore(store as never)
      const retire = vi.spyOn(store, 'markSshRemotePtyLease')
      const census = async () => ({ verdict, count: 1 })
      const isBridgedPaneLease = (lease: SshRemotePtyLease): boolean => lease.ptyId === 'agent-pty'
      const refused = await convert(census, isBridgedPaneLease)
      expect(refused).toMatchObject({ outcome: 'refused', canLeaveBehind: true })
      expect(destination.commits).toBe(0)
      expect(store.getSshTarget(TARGET.id)?.managedServerLeaveBehind).toBeUndefined()
      store.updateSshTarget(TARGET.id, {
        managedServerLeaveBehind: { confirmedAt: '2026-10-23T00:00:00.000Z' }
      })
      await expect(convert(census, isBridgedPaneLease)).resolves.toMatchObject({
        outcome: 'converted'
      })
      expect(destination.commits).toBe(1)
      const [journal] = listHivewarddMigrationSourceCutovers(userDataPath)
      expect(journal?.bridgedPtyIds).toEqual(['agent-pty', 'older-agent-pty'])
      const moved = journal?.manifest.payload.dormantState?.workspaceSession
      expect(moved?.tabsByWorktree[worktreeId]?.map((tab) => tab.id)).toEqual([tabId])
      expect(moved?.terminalLayoutsByTabId[tabId]).toMatchObject({ root: { type: 'leaf', leafId } })
      expect(moved?.terminalLayoutsByTabId[tabId]?.scrollbackRefsByLeafId).toBeUndefined()
      expect(
        store.getWorkspaceSession(hostId)?.terminalLayoutsByTabId[tabId]?.scrollbackRefsByLeafId
      ).toEqual({ [leafId]: ref })
      expect(store.getSshRemotePtyLeases(TARGET.id)).toEqual([
        expect.objectContaining({ ptyId: 'agent-pty', state: 'detached', tabId, leafId }),
        expect.objectContaining({ ptyId: 'older-agent-pty', state: 'expired' })
      ])
      expect(retire).not.toHaveBeenCalled()
    }
  )

  it('commits first time with the pairing the tunnel re-paired to while it opened', async () => {
    mocks.ensureTunnel.mockImplementation(async (path: string, id: string) => {
      refreshManagedHivewarddPairing(
        path,
        id,
        encodePairingOffer({
          v: PAIRING_OFFER_VERSION,
          endpoint: 'ws://127.0.0.1:46768/',
          deviceToken: 'fresh-token',
          publicKeyB64: 'public-key'
        })
      )
      return resolveEnvironment(path, id)
    })
    const destinationFor = vi.fn((_environment: KnownRuntimeEnvironment) => destination)
    const result = await convertSshTargetToManagedHivewardd(userDataPath, {
      sshTargetId: TARGET.id,
      name: 'Managed',
      censusHost: async () => ({ verdict: 'exited', count: 0 }),
      destinationFor,
      releaseDirectSession,
      now: () => new Date('2026-10-02T00:00:00.000Z')
    })
    expect(result).toMatchObject({ outcome: 'converted' })
    expect(destination.commits).toBe(1)
    const used = destinationFor.mock.calls[0]![0]
    expect(getPreferredPairingOffer(used).deviceToken).toBe('fresh-token')
    // Repair must preserve the migration mark that prevents rollback across committed migration.
    expect(used.hivewarddMigratedAt).toBe('2026-10-02T00:00:00.000Z')
  })

  it('fences, deploys, marks the server, commits once, then keeps the source rows', async () => {
    const result = await convert()
    expect(result).toMatchObject({ outcome: 'converted' })
    expect(releaseDirectSession).toHaveBeenCalledWith(TARGET.id)
    expect(mocks.deploy).toHaveBeenCalledWith(
      userDataPath,
      expect.objectContaining({ migration: true })
    )
    const [environment] = listEnvironments(userDataPath)
    expect(environment?.hivewarddMigratedAt).toBe('2026-10-02T00:00:00.000Z')
    expect(destination.commits).toBe(1)
    // Retained source rows keep downgraded relay-era clients able to reach the host.
    expect(store.getRepos().map((repo) => repo.id)).toEqual(['repo-1'])
    const [journal] = listHivewarddMigrationSourceCutovers(userDataPath)
    expect(journal).toMatchObject({
      phase: 'destination-committed',
      sourceRetainedAt: '2026-10-02T00:00:00.000Z'
    })
    expect(store.getSshTarget(TARGET.id)?.owner).toBeUndefined()
    expect(getManagedHivewarddFenceEnvironmentId(store.getSshTarget(TARGET.id))).toBe(environment?.id)
    await expect(convert()).resolves.toMatchObject({
      outcome: 'converted',
      migrationId: journal?.migrationId
    })
    expect(destination.commits).toBe(1)
  })

  // COMPAT(legacy-relay-bridge): converting stops nothing, so a relay terminal no longer blocks it.
  it('converts while a relay terminal may still run, leaving its lease to the bridge', async () => {
    const lease = {
      targetId: TARGET.id,
      ptyId: 'p',
      state: 'expired' as const,
      createdAt: 1,
      updatedAt: 1
    }
    // Released clients detach leases on clean quit; crashes leave expired leases.
    const detached = { ...lease, ptyId: 'q', state: 'detached' as const }
    vi.spyOn(store, 'getSshRemotePtyLeases').mockReturnValue([lease, detached])
    const markLease = vi.spyOn(store, 'markSshRemotePtyLease')
    const uncounted = async () => ({ verdict: 'unverifiable' as const, count: 0 })
    await expect(convert(uncounted)).resolves.toMatchObject({ outcome: 'converted' })
    const [journal] = listHivewarddMigrationSourceCutovers(userDataPath)
    expect(journal).toMatchObject({ provenPtyIds: [], bridgedPtyIds: ['p', 'q'] })
    expect(markLease).not.toHaveBeenCalled()
  })

  it('refuses without any host census', async () => {
    await expect(convert(null)).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable'
    })
    expect(store.getSshTarget(TARGET.id)?.hivewarddFence).toBeUndefined()
  })

  it('converts on a live host census, which no lease of this target names', async () => {
    await expect(convert(async () => ({ verdict: 'live', count: 1 }))).resolves.toMatchObject({
      outcome: 'converted'
    })
    const [journal] = listHivewarddMigrationSourceCutovers(userDataPath)
    expect(journal).toMatchObject({ provenPtyIds: [], bridgedPtyIds: [] })
  })

  it('converts on a host census that proves its relays idle', async () => {
    await expect(convert(async () => ({ verdict: 'exited', count: 0 }))).resolves.toMatchObject({
      outcome: 'converted'
    })
  })

  it('keeps the fence across a deferred deploy and resumes the same migration', async () => {
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'deferred',
      candidateVersion: '1.0.0',
      code: 'hivewardd_update_terminals_running',
      reason: 'busy'
    })
    await expect(convert()).resolves.toMatchObject({ outcome: 'deferred' })
    const [fenced] = listHivewarddMigrationSourceCutovers(userDataPath)
    expect(fenced?.phase).toBe('source-fenced')
    await expect(convert()).resolves.toMatchObject({
      outcome: 'converted',
      migrationId: fenced?.migrationId
    })
    expect(destination.commits).toBe(1)
  })

  it('resumes after a lost commit reply without committing twice', async () => {
    const read = destination.readState.getMockImplementation()
    const commit = destination.commit.getMockImplementation()
    let reachable = true
    destination.readState.mockImplementation(async (manifest) => {
      if (!reachable) {
        throw new Error('socket closed')
      }
      return read!(manifest)
    })
    destination.commit.mockImplementationOnce(async (manifest) => {
      await commit!(manifest)
      reachable = false
      throw new Error('socket closed')
    })
    await expect(convert()).rejects.toThrow('socket closed')
    expect(listHivewarddMigrationSourceCutovers(userDataPath)[0]?.phase).toBe('destination-staged')
    reachable = true
    await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })
    expect(destination.commits).toBe(1)
    expect(listHivewarddMigrationSourceCutovers(userDataPath)[0]?.sourceRetainedAt).toBeDefined()
    expect(store.getRepos().map((repo) => repo.id)).toEqual(['repo-1'])
  })
})

describe('the source frozen during a conversion', () => {
  it('commits despite the UI moving focus to the host mid-conversion', async () => {
    const stage = destination.stage.getMockImplementation()!
    destination.stage.mockImplementationOnce(async (manifest) => {
      store.updateUI({ lastActiveRepoId: 'repo-1' })
      return stage(manifest)
    })
    await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })
  })

  it('still refuses a catalog change mid-conversion', async () => {
    const stage = destination.stage.getMockImplementation()!
    destination.stage.mockImplementationOnce(async (manifest) => {
      store.updateRepo(store.getRepo('repo-1')!, { displayName: 'Renamed' })
      return stage(manifest)
    })
    await expect(convert()).rejects.toThrow('hivewardd_migration_source_changed')
  })
})

describe('backing out a conversion whose server is registered but never committed', () => {
  const abandon = () =>
    abandonHivewarddConversion({
      userDataPath,
      store,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test registry is the SshConnectionStore built above.
      claims: (mocks.state.targetStore as SshConnectionStore).getHivewarddRuntimeClaims(),
      targetId: TARGET.id,
      destinationFor: () => destination
    })

  it('aborts the staged catalog, unregisters the server and gives the host back', async () => {
    destination.commit.mockRejectedValueOnce(new Error('hivewardd_migration_source_changed'))
    await expect(convert()).rejects.toThrow('hivewardd_migration_source_changed')
    expect(listHivewarddMigrationSourceCutovers(userDataPath)[0]?.phase).toBe('destination-staged')

    await expect(abandon()).resolves.toMatchObject({ outcome: 'released' })
    expect(destination.abort).toHaveBeenCalled()
    expect(listEnvironments(userDataPath)).toEqual([])
    expect(listHivewarddMigrationSourceCutovers(userDataPath)).toEqual([])
    expect(store.getSshTarget(TARGET.id)?.hivewarddFence).toBeUndefined()
    reconcileManagedHivewarddSshTargets(userDataPath, store)
    expect(store.getSshTarget(TARGET.id)?.hivewarddFence).toBeUndefined()
  })

  it('keeps the fence while the server cannot say what it holds', async () => {
    destination.commit.mockRejectedValueOnce(new Error('socket closed'))
    await expect(convert()).rejects.toThrow('socket closed')
    destination.readState.mockRejectedValue(new Error('socket closed'))
    await expect(abandon()).rejects.toThrow('socket closed')
    expect(listEnvironments(userDataPath)).toHaveLength(1)
    expect(listHivewarddMigrationSourceCutovers(userDataPath)).toHaveLength(1)
  })

  it('finishes the same move on a later attempt once the server answers again', async () => {
    destination.commit.mockRejectedValueOnce(new Error('socket closed'))
    await expect(convert()).rejects.toThrow()
    destination.readState.mockRejectedValueOnce(new Error('socket closed'))
    await expect(abandon()).rejects.toThrow('socket closed')
    const [held] = listHivewarddMigrationSourceCutovers(userDataPath)
    expect(store.getSshTarget(TARGET.id)?.hivewarddFence).toBeDefined()

    await expect(convert()).resolves.toMatchObject({
      outcome: 'converted',
      migrationId: held!.migrationId
    })
    expect(destination.commits).toBe(1)
    expect(listEnvironments(userDataPath)).toHaveLength(1)
  })

  it('clears a stale journal a stopped server left, so the host converts again', async () => {
    await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })
    const [environment] = listEnvironments(userDataPath)
    removeManagedHivewarddEnvironment(userDataPath, environment!.id)
    store.updateSshTarget(TARGET.id, { hivewarddFence: undefined })
    await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })
    expect(listHivewarddMigrationSourceCutovers(userDataPath)).toHaveLength(1)
  })
})

/** Frozen released-client target filtering; retain unknown fields and hide owned targets. */
function shippedBuildView(targets: SshTarget[]): SshTarget[] {
  return JSON.parse(JSON.stringify(targets)).filter(
    (target: SshTarget) => target.owner?.type !== 'on-demand-runtime'
  )
}

describe('a converted host across a downgrade and back', () => {
  async function convertRetained(): Promise<void> {
    await expect(convert()).resolves.toMatchObject({ outcome: 'converted' })
  }

  it('stays visible, with its projects, to an older build', async () => {
    await convertRetained()
    const visible = shippedBuildView(store.getSshTargets())
    expect(visible.map((target) => target.id)).toEqual([TARGET.id])
    expect(store.getRepos().filter((repo) => repo.connectionId === TARGET.id)).toHaveLength(1)
    expect(visibleRepos(store, () => userDataPath)).toEqual([])
  })

  it('goes back to managed after a downgrade that changed nothing', async () => {
    await convertRetained()
    reconcileManagedHivewarddSshTargets(userDataPath, store)
    expect(store.getSshTarget(TARGET.id)?.hivewarddFence?.sourceChangedAt).toBeUndefined()
    expect(visibleRepos(store, () => userDataPath)).toEqual([])
  })

  it('keeps a host an older build changed on the relay, never merging a second manifest', async () => {
    await convertRetained()
    store.addRepo({
      id: 'repo-2',
      path: '/srv/tool',
      displayName: 'Tool',
      badgeColor: '#737373',
      addedAt: 2,
      kind: 'git',
      connectionId: TARGET.id
    })
    reconcileManagedHivewarddSshTargets(userDataPath, store, () => new Date('2026-10-05T00:00:00Z'))
    expect(store.getSshTarget(TARGET.id)?.hivewarddFence).toMatchObject({
      sourceChangedAt: '2026-10-05T00:00:00.000Z'
    })
    expect(
      visibleRepos(store, () => userDataPath)
        .map((repo) => repo.id)
        .sort()
    ).toEqual(['repo-1', 'repo-2'])
    expect(destination.commits).toBe(1)
  })

  it('restores a fence the profile lost from the registered managed server', async () => {
    await convertRetained()
    store.updateSshTarget(TARGET.id, { hivewarddFence: undefined })
    reconcileManagedHivewarddSshTargets(userDataPath, store)
    expect(getManagedHivewarddFenceEnvironmentId(store.getSshTarget(TARGET.id))).toBe(
      listEnvironments(userDataPath)[0]?.id
    )
  })
})
