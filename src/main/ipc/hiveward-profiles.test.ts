import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ProfileStoragePaths from '../hiveward-profiles/profile-storage-paths'

const {
  handlers,
  appExitMock,
  appQuitMock,
  appRelaunchMock,
  relaunchAppMock,
  destroySystemTrayMock,
  createLocalHiveWardProfileMock,
  getHiveWardProfileListStateMock,
  seedNewHiveWardProfileTelemetryConsentMock,
  setActiveHiveWardProfileMock,
  transferHiveWardProfileProjectMock,
  hasHiveWardProfileStateDatabaseMock
} = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  appExitMock: vi.fn(),
  appQuitMock: vi.fn(),
  appRelaunchMock: vi.fn(),
  relaunchAppMock: vi.fn(),
  destroySystemTrayMock: vi.fn(),
  createLocalHiveWardProfileMock: vi.fn(),
  getHiveWardProfileListStateMock: vi.fn(),
  seedNewHiveWardProfileTelemetryConsentMock: vi.fn(),
  setActiveHiveWardProfileMock: vi.fn(),
  transferHiveWardProfileProjectMock: vi.fn(),
  hasHiveWardProfileStateDatabaseMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    exit: appExitMock,
    quit: appQuitMock,
    relaunch: appRelaunchMock
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

vi.mock('../tray/system-tray', () => ({
  destroySystemTray: destroySystemTrayMock
}))

vi.mock('../app-relaunch', () => ({
  relaunchApp: relaunchAppMock
}))

vi.mock('../hiveward-profiles/profile-index-store', () => ({
  createLocalHiveWardProfile: createLocalHiveWardProfileMock,
  getHiveWardProfileListState: getHiveWardProfileListStateMock,
  seedNewHiveWardProfileTelemetryConsent: seedNewHiveWardProfileTelemetryConsentMock,
  setActiveHiveWardProfile: setActiveHiveWardProfileMock
}))

function makeStoreMock(flushPendingOrThrowAsync = vi.fn()) {
  const freezeWrites = vi.fn()
  const resumeMaintenance = vi.fn(async () => {})
  return {
    flushPendingOrThrowAsync,
    freezeWrites,
    resumeMaintenance,
    beginProfileMaintenance: vi.fn(async (options: unknown) => {
      await flushPendingOrThrowAsync(options)
      freezeWrites()
      return { resume: resumeMaintenance }
    }),
    getSettings: () => ({})
  }
}

vi.mock('../hiveward-profiles/profile-project-transfer', () => ({
  transferHiveWardProfileProject: transferHiveWardProfileProjectMock
}))

vi.mock('../hiveward-profiles/profile-storage-paths', async (importOriginal) => ({
  ...(await importOriginal<typeof ProfileStoragePaths>()),
  hasHiveWardProfileStateDatabase: hasHiveWardProfileStateDatabaseMock
}))

import { registerHiveWardProfileHandlers } from './hiveward-profiles'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

const ipcEvent = { sender: { isDestroyed: () => false, send: vi.fn() } }

describe('registerHiveWardProfileHandlers', () => {
  beforeEach(() => {
    // Reinstall AppEnvironment per test after global beforeEach resets its fake.
    installFakeAppEnvironment({ getPath: () => '/tmp/hiveward-user-data' })
    vi.useFakeTimers()
    handlers.clear()
    ipcEvent.sender.send.mockClear()
    appExitMock.mockReset()
    appQuitMock.mockReset()
    appRelaunchMock.mockReset()
    relaunchAppMock.mockReset()
    relaunchAppMock.mockImplementation(() => appRelaunchMock())
    destroySystemTrayMock.mockReset()
    createLocalHiveWardProfileMock.mockReset()
    getHiveWardProfileListStateMock.mockReset()
    seedNewHiveWardProfileTelemetryConsentMock.mockReset()
    setActiveHiveWardProfileMock.mockReset()
    transferHiveWardProfileProjectMock.mockReset()
    hasHiveWardProfileStateDatabaseMock.mockReset().mockReturnValue(false)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('registers list and create handlers', async () => {
    const listState = {
      activeProfileId: 'local-default',
      profiles: [{ id: 'local-default', name: 'Personal' }]
    }
    const createState = {
      ...listState,
      profile: { id: 'local-work', name: 'Work' }
    }
    getHiveWardProfileListStateMock.mockReturnValue(listState)
    createLocalHiveWardProfileMock.mockReturnValue(createState)

    registerHiveWardProfileHandlers(makeStoreMock() as never)

    await expect(Promise.resolve(handlers.get('hivewardProfiles:list')?.(ipcEvent))).resolves.toEqual({
      ...listState,
      multiProfileUi: false
    })
    await expect(
      Promise.resolve(handlers.get('hivewardProfiles:createLocal')?.(ipcEvent, { name: 'Work' }))
    ).resolves.toBe(createState)
    expect(createLocalHiveWardProfileMock).toHaveBeenCalledWith({ name: 'Work' })
  })

  it('reports multiProfileUi when the env flag is set', async () => {
    const previous = process.env.HIVEWARD_MULTI_PROFILE_UI
    process.env.HIVEWARD_MULTI_PROFILE_UI = '1'
    try {
      getHiveWardProfileListStateMock.mockReturnValue({
        activeProfileId: 'local-default',
        profiles: []
      })
      registerHiveWardProfileHandlers(makeStoreMock() as never)

      await expect(Promise.resolve(handlers.get('hivewardProfiles:list')?.(ipcEvent))).resolves.toEqual(
        {
          activeProfileId: 'local-default',
          profiles: [],
          multiProfileUi: true
        }
      )
    } finally {
      if (previous === undefined) {
        delete process.env.HIVEWARD_MULTI_PROFILE_UI
      } else {
        process.env.HIVEWARD_MULTI_PROFILE_UI = previous
      }
    }
  })

  it('marks the target profile active, flushes, and relaunches', async () => {
    const flush = vi.fn()
    const onBeforeRelaunch = vi.fn()
    getHiveWardProfileListStateMock.mockReturnValue({
      activeProfileId: 'local-default',
      profiles: []
    })
    setActiveHiveWardProfileMock.mockReturnValue({
      activeProfileId: 'local-work',
      profiles: []
    })
    registerHiveWardProfileHandlers(makeStoreMock(flush) as never, { onBeforeRelaunch })

    const resultPromise = Promise.resolve(
      handlers.get('hivewardProfiles:switch')?.(ipcEvent, { profileId: 'local-work' })
    )

    await expect(resultPromise).resolves.toEqual({ status: 'relaunching' })
    expect(setActiveHiveWardProfileMock).toHaveBeenCalledWith('local-work')
    expect(flush).toHaveBeenCalledOnce()
    expect(onBeforeRelaunch).toHaveBeenCalledOnce()
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(
      setActiveHiveWardProfileMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
    expect(flush).toHaveBeenCalledBefore(onBeforeRelaunch)
    expect(appRelaunchMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(150)

    expect(appRelaunchMock).toHaveBeenCalledOnce()
    expect(relaunchAppMock).toHaveBeenCalledWith('profile-switch')
    // Profile switches must run normal quit teardown for scrollback, PTYs and daemon checkpoints.
    expect(appQuitMock).toHaveBeenCalledOnce()
    expect(appExitMock).not.toHaveBeenCalled()
  })

  it('does not mark a profile active when current profile flush fails', async () => {
    const flush = vi.fn(() => {
      throw new Error('flush_failed')
    })
    getHiveWardProfileListStateMock.mockReturnValue({
      activeProfileId: 'local-default',
      profiles: []
    })
    registerHiveWardProfileHandlers(makeStoreMock(flush) as never)

    await expect(
      Promise.resolve(handlers.get('hivewardProfiles:switch')?.(ipcEvent, { profileId: 'local-work' }))
    ).rejects.toThrow('flush_failed')

    expect(setActiveHiveWardProfileMock).not.toHaveBeenCalled()
    expect(appRelaunchMock).not.toHaveBeenCalled()
  })

  it('does not switch profiles when persistence cannot reach quiescence', async () => {
    const flush = vi.fn(() => new Promise<void>(() => {}))
    const onBeforeRelaunch = vi.fn()
    getHiveWardProfileListStateMock.mockReturnValue({
      activeProfileId: 'local-default',
      profiles: []
    })
    registerHiveWardProfileHandlers(makeStoreMock(flush) as never, { onBeforeRelaunch })

    const switchProfile = Promise.resolve(
      handlers.get('hivewardProfiles:switch')?.(ipcEvent, { profileId: 'local-work' })
    )
    const rejection = expect(switchProfile).rejects.toThrow('hiveward_profile_persistence_timeout')
    await vi.advanceTimersByTimeAsync(60_000)
    await rejection

    expect(setActiveHiveWardProfileMock).not.toHaveBeenCalled()
    expect(appRelaunchMock).not.toHaveBeenCalled()
    expect(onBeforeRelaunch).not.toHaveBeenCalled()
  })

  it('does not relaunch when switching to the active profile', async () => {
    getHiveWardProfileListStateMock.mockReturnValue({
      activeProfileId: 'local-default',
      profiles: []
    })
    registerHiveWardProfileHandlers(makeStoreMock() as never)

    await expect(
      Promise.resolve(
        handlers.get('hivewardProfiles:switch')?.(ipcEvent, { profileId: 'local-default' })
      )
    ).resolves.toEqual({ status: 'already-active' })

    expect(setActiveHiveWardProfileMock).not.toHaveBeenCalled()
    expect(appRelaunchMock).not.toHaveBeenCalled()
  })

  it('rejects invalid profile ids', async () => {
    registerHiveWardProfileHandlers(makeStoreMock() as never)

    await expect(
      Promise.resolve(handlers.get('hivewardProfiles:switch')?.(ipcEvent, { profileId: ' ' }))
    ).rejects.toThrow('invalid_hiveward_profile_id')
  })

  it('transfers projects between inactive profiles after flushing active state', async () => {
    const flush = vi.fn()
    const result = {
      status: 'transferred',
      mode: 'copy',
      sourceProfileId: 'personal',
      targetProfileId: 'work',
      sourceRepoId: 'repo-1',
      targetRepoId: 'repo-2',
      targetProjectId: 'repo:repo-2'
    }
    getHiveWardProfileListStateMock.mockReturnValue({
      activeProfileId: 'personal',
      profiles: []
    })
    transferHiveWardProfileProjectMock.mockReturnValue(result)
    registerHiveWardProfileHandlers(makeStoreMock(flush) as never)

    await expect(
      Promise.resolve(
        handlers.get('hivewardProfiles:transferProject')?.(ipcEvent, {
          sourceProfileId: ' personal ',
          targetProfileId: ' work ',
          repoId: ' repo-1 ',
          mode: 'copy'
        })
      )
    ).resolves.toBe(result)

    expect(flush).toHaveBeenCalledOnce()
    expect(transferHiveWardProfileProjectMock).toHaveBeenCalledWith(
      {
        sourceProfileId: 'personal',
        targetProfileId: 'work',
        repoId: 'repo-1',
        mode: 'copy'
      },
      '/tmp/hiveward-user-data'
    )
  })

  it('moves a project out of the active profile and relaunches into the target profile', async () => {
    const flush = vi.fn()
    const onBeforeRelaunch = vi.fn()
    const result = {
      status: 'transferred',
      mode: 'move',
      sourceProfileId: 'personal',
      targetProfileId: 'work',
      sourceRepoId: 'repo-1',
      targetRepoId: 'repo-1',
      targetProjectId: 'repo:repo-1'
    }
    getHiveWardProfileListStateMock.mockReturnValue({
      activeProfileId: 'personal',
      profiles: []
    })
    transferHiveWardProfileProjectMock.mockReturnValue(result)
    registerHiveWardProfileHandlers(makeStoreMock(flush) as never, { onBeforeRelaunch })

    await expect(
      Promise.resolve(
        handlers.get('hivewardProfiles:transferProject')?.(ipcEvent, {
          sourceProfileId: 'personal',
          targetProfileId: 'work',
          repoId: 'repo-1',
          mode: 'move'
        })
      )
    ).resolves.toEqual({ ...result, willRelaunch: true })

    expect(onBeforeRelaunch).toHaveBeenCalledOnce()
    expect(flush).toHaveBeenCalledOnce()
    expect(transferHiveWardProfileProjectMock).toHaveBeenCalledWith(
      {
        sourceProfileId: 'personal',
        targetProfileId: 'work',
        repoId: 'repo-1',
        mode: 'move'
      },
      '/tmp/hiveward-user-data'
    )
    expect(setActiveHiveWardProfileMock).toHaveBeenCalledWith('work')
    expect(appRelaunchMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(150)

    expect(appRelaunchMock).toHaveBeenCalledOnce()
    expect(ipcEvent.sender.send).toHaveBeenCalledWith('app:restart-committed')
    expect(relaunchAppMock).toHaveBeenCalledWith('profile-transfer')
    expect(appQuitMock).toHaveBeenCalledOnce()
    expect(appExitMock).not.toHaveBeenCalled()
  })

  it('relaunches the closed source when a completed move cannot update the profile index', async () => {
    const store = makeStoreMock()
    getHiveWardProfileListStateMock.mockReturnValue({ activeProfileId: 'personal', profiles: [] })
    transferHiveWardProfileProjectMock.mockReturnValue({ status: 'transferred', mode: 'move' })
    setActiveHiveWardProfileMock.mockImplementationOnce(() => {
      throw new Error('profile index disk full')
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies every Store operation exercised by these IPC handlers.
    registerHiveWardProfileHandlers(store as never)

    await expect(
      handlers.get('hivewardProfiles:transferProject')?.(ipcEvent, {
        sourceProfileId: 'personal',
        targetProfileId: 'work',
        repoId: 'repo-1',
        mode: 'move'
      })
    ).rejects.toThrow('profile index disk full')

    expect(store.freezeWrites).toHaveBeenCalledOnce()
    expect(store.resumeMaintenance).not.toHaveBeenCalled()
    expect(ipcEvent.sender.send).toHaveBeenCalledWith('app:restart-committed')
    await vi.advanceTimersByTimeAsync(150)
    expect(relaunchAppMock).toHaveBeenCalledWith('profile-transfer')
    expect(appQuitMock).toHaveBeenCalledOnce()
  })

  it('keeps the active profile writable during a transfer between inactive profiles', async () => {
    const store = makeStoreMock()
    getHiveWardProfileListStateMock.mockReturnValue({ activeProfileId: 'active', profiles: [] })
    transferHiveWardProfileProjectMock.mockReturnValue({ status: 'transferred', mode: 'copy' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies the Store operations exercised by the handlers.
    registerHiveWardProfileHandlers(store as never)
    await handlers.get('hivewardProfiles:transferProject')?.(ipcEvent, {
      sourceProfileId: 'personal',
      targetProfileId: 'work',
      repoId: 'repo-1',
      mode: 'copy'
    })
    expect(store.beginProfileMaintenance).not.toHaveBeenCalled()
    expect(store.freezeWrites).not.toHaveBeenCalled()
    expect(store.flushPendingOrThrowAsync).toHaveBeenCalledBefore(transferHiveWardProfileProjectMock)
  })

  it('rejects transfers that would mutate the active target profile offline', async () => {
    getHiveWardProfileListStateMock.mockReturnValue({
      activeProfileId: 'work',
      profiles: []
    })
    registerHiveWardProfileHandlers(makeStoreMock() as never)

    await expect(
      Promise.resolve(
        handlers.get('hivewardProfiles:transferProject')?.(ipcEvent, {
          sourceProfileId: 'personal',
          targetProfileId: 'work',
          repoId: 'repo-1',
          mode: 'copy'
        })
      )
    ).rejects.toThrow('active_target_hiveward_profile_transfer_requires_relaunch')

    expect(transferHiveWardProfileProjectMock).not.toHaveBeenCalled()
  })

  it('freezes a newly migrated source after transfer failure and reopens its current profile', async () => {
    const store = makeStoreMock()
    const onBeforeRelaunch = vi.fn()
    getHiveWardProfileListStateMock.mockReturnValue({ activeProfileId: 'personal', profiles: [] })
    transferHiveWardProfileProjectMock.mockImplementation(() => {
      hasHiveWardProfileStateDatabaseMock.mockReturnValue(true)
      throw new Error('source commit interrupted')
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies every Store operation exercised by these IPC handlers.
    registerHiveWardProfileHandlers(store as never, { onBeforeRelaunch })

    await expect(
      Promise.resolve(
        handlers.get('hivewardProfiles:transferProject')?.(ipcEvent, {
          sourceProfileId: 'personal',
          targetProfileId: 'work',
          repoId: 'repo-1',
          mode: 'move'
        })
      )
    ).rejects.toThrow('source commit interrupted')

    expect(store.flushPendingOrThrowAsync).toHaveBeenCalledBefore(transferHiveWardProfileProjectMock)
    expect(store.freezeWrites).toHaveBeenCalledOnce()
    expect(store.freezeWrites).toHaveBeenCalledBefore(onBeforeRelaunch)
    expect(setActiveHiveWardProfileMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(150)
    expect(ipcEvent.sender.send).toHaveBeenCalledWith('app:restart-committed')
    expect(relaunchAppMock).toHaveBeenCalledWith('profile-transfer')
    expect(appQuitMock).toHaveBeenCalledOnce()
  })

  it('keeps an active JSON source writable after validation fails without a migration', async () => {
    const store = makeStoreMock()
    const onBeforeRelaunch = vi.fn()
    getHiveWardProfileListStateMock.mockReturnValue({ activeProfileId: 'personal', profiles: [] })
    transferHiveWardProfileProjectMock.mockImplementation(() => {
      throw new Error('unknown_source_repo')
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies every Store operation exercised by these IPC handlers.
    registerHiveWardProfileHandlers(store as never, { onBeforeRelaunch })

    await expect(
      Promise.resolve(
        handlers.get('hivewardProfiles:transferProject')?.(ipcEvent, {
          sourceProfileId: 'personal',
          targetProfileId: 'work',
          repoId: 'repo-1',
          mode: 'move'
        })
      )
    ).rejects.toThrow('unknown_source_repo')

    expect(store.resumeMaintenance).toHaveBeenCalledOnce()
    expect(onBeforeRelaunch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(150)
    expect(relaunchAppMock).not.toHaveBeenCalled()
  })

  it.each([
    null,
    {},
    { sourceProfileId: 4 },
    {
      sourceProfileId: 'personal',
      targetProfileId: 'work',
      repoId: 'repo-1',
      mode: 'invalid'
    }
  ])('rejects malformed transfer arguments before disk work: %j', async (args) => {
    const store = makeStoreMock()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies every Store operation exercised by these IPC handlers.
    registerHiveWardProfileHandlers(store as never)
    await expect(
      Promise.resolve(handlers.get('hivewardProfiles:transferProject')?.(ipcEvent, args))
    ).rejects.toThrow('invalid_hiveward_profile_project_transfer')
    expect(store.flushPendingOrThrowAsync).not.toHaveBeenCalled()
    expect(transferHiveWardProfileProjectMock).not.toHaveBeenCalled()
  })
})
