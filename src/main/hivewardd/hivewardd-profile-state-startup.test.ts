import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  createProfileStateStoreForStartupMock,
  emitMock,
  ensureActiveHiveWardProfileMock,
  initHiveWardProfilePathsMock,
  initSshHostKeyStoreFileMock
} = vi.hoisted(() => ({
  createProfileStateStoreForStartupMock: vi.fn(),
  emitMock: vi.fn(),
  ensureActiveHiveWardProfileMock: vi.fn(),
  initHiveWardProfilePathsMock: vi.fn(),
  initSshHostKeyStoreFileMock: vi.fn()
}))

vi.mock('../persistence/profile-state/profile-state-startup-authority', () => ({
  createProfileStateStoreForStartup: createProfileStateStoreForStartupMock
}))
vi.mock('../hiveward-profiles/profile-index-store', () => ({
  ensureActiveHiveWardProfile: ensureActiveHiveWardProfileMock,
  initHiveWardProfilePaths: initHiveWardProfilePathsMock
}))
vi.mock('../ssh/ssh-host-key-store', () => ({
  initSshHostKeyStoreFile: initSshHostKeyStoreFileMock
}))
vi.mock('./hivewardd-profile-state-telemetry', () => ({
  emitHivewarddProfileStateAuthoritySelected: emitMock
}))

const {
  createHivewarddProfileStateStartup,
  hivewarddProfileWriterIdleStopMs,
  WSL_HOST_PROFILE_WRITER_IDLE_STOP_MS
} = await import('./hivewardd-profile-state-startup')

beforeEach(() => {
  vi.resetAllMocks()
  ensureActiveHiveWardProfileMock.mockReturnValue({
    dataFile: '/tmp/profile/hiveward-data.json',
    stateDatabaseFile: '/tmp/profile/profile-state.db',
    profile: { id: 'profile-1' }
  })
})

describe('hivewardd profile-state startup', () => {
  it('selects the capable authority once and publishes bounded metadata', async () => {
    const store = { getSettings: vi.fn() }
    createProfileStateStoreForStartupMock.mockReturnValue({
      store,
      authority: { readSerializedState: vi.fn() },
      backend: 'sqlite',
      classification: 'json-only',
      migrated: true
    })

    const result = await createHivewarddProfileStateStartup('/tmp/user-data')

    expect(initHiveWardProfilePathsMock).toHaveBeenCalledOnce()
    expect(ensureActiveHiveWardProfileMock).toHaveBeenCalledWith('/tmp/user-data')
    expect(initSshHostKeyStoreFileMock).toHaveBeenCalledWith('/tmp/profile/hiveward-data.json')

    expect(createProfileStateStoreForStartupMock).toHaveBeenCalledWith({
      userDataPath: '/tmp/user-data',
      dataFile: '/tmp/profile/hiveward-data.json',
      databaseFile: '/tmp/profile/profile-state.db',
      profileId: 'profile-1',
      runtime: 'hivewardd',
      storageAuthority: 'runtime'
    })
    expect(result.store).toBe(store)
    expect(result.authority).toEqual({
      backend: 'sqlite',
      classification: 'json-only',
      authority_mode: 'sqlite-established',
      runtime: 'hivewardd',
      migrated: true
    })
    expect(emitMock).toHaveBeenCalledWith(result.authority)
  })

  it('publishes nothing before the profile writer is ready', async () => {
    let refuse = (_error: Error) => {}
    createProfileStateStoreForStartupMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          refuse = reject
        })
    )
    const startup = createHivewarddProfileStateStartup('/tmp/user-data')
    const failure = new Error('writer startup refused')
    const rejected = expect(startup).rejects.toBe(failure)
    expect(initSshHostKeyStoreFileMock).not.toHaveBeenCalled()
    expect(emitMock).not.toHaveBeenCalled()
    refuse(failure)
    await rejected
  })

  it('closes a ready writer if sidecar initialization fails', async () => {
    const store = { freezeWritesAsync: vi.fn(async () => {}) }
    createProfileStateStoreForStartupMock.mockResolvedValueOnce({
      store,
      backend: 'sqlite',
      classification: 'sqlite-only',
      migrated: false
    })
    const failure = new Error('sidecar initialization refused')
    initSshHostKeyStoreFileMock.mockImplementationOnce(() => {
      throw failure
    })
    await expect(createHivewarddProfileStateStartup('/tmp/user-data')).rejects.toBe(failure)
    expect(store.freezeWritesAsync).toHaveBeenCalledOnce()
    expect(emitMock).not.toHaveBeenCalled()
  })
})

describe('hivewardd profile writer idle stop', () => {
  it('stops an idle writer after a minute on a WSL host only', () => {
    expect(hivewarddProfileWriterIdleStopMs(() => true)).toBe(WSL_HOST_PROFILE_WRITER_IDLE_STOP_MS)
    expect(WSL_HOST_PROFILE_WRITER_IDLE_STOP_MS).toBe(60_000)
    expect(hivewarddProfileWriterIdleStopMs(() => false)).toBeUndefined()
  })
})
