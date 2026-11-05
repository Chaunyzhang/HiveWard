import { afterEach, beforeEach, vi, type Mock } from 'vitest'

export type RuntimeClientModuleMocks = {
  callMock: Mock
  runtimeClientConstructorMock: Mock
  serveHiveWardAppMock: Mock
  getDefaultUserDataPathMock: Mock
}

export type WorktreeAwarenessMocks = {
  callMock: Mock
  serveHiveWardAppMock: Mock
  getDefaultUserDataPathMock: Mock
  addEnvironmentFromPairingCodeMock: Mock
  listEnvironmentsMock: Mock
  spawnMock: Mock
}

export async function createRuntimeClientModuleMock(mocks: RuntimeClientModuleMocks) {
  // Error formatting uses instanceof, so the mock must preserve the production classes.
  const { RuntimeClientError, RuntimeRpcFailureError } = await import('./runtime/types.js')

  class RuntimeClient {
    readonly isRemote: boolean
    call = mocks.callMock
    getCliStatus = vi.fn()
    openHiveWard = vi.fn()

    constructor(
      _userDataPath?: string,
      _requestTimeoutMs?: number,
      remotePairingCode?: string | null,
      environmentSelector?: string | null
    ) {
      mocks.runtimeClientConstructorMock(remotePairingCode, environmentSelector)
      const effectivePairingCode =
        remotePairingCode === undefined
          ? (process.env.HIVEWARD_PAIRING_CODE ?? process.env.HIVEWARD_REMOTE_PAIRING)
          : remotePairingCode
      const effectiveEnvironment =
        environmentSelector === undefined ? process.env.HIVEWARD_ENVIRONMENT : environmentSelector
      if (effectivePairingCode && effectiveEnvironment) {
        throw new RuntimeClientError(
          'invalid_argument',
          'Use either --pairing-code or --environment, not both.'
        )
      }
      this.isRemote = Boolean(effectivePairingCode || effectiveEnvironment)
    }
  }

  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError,
    serveHiveWardApp: mocks.serveHiveWardAppMock,
    getDefaultUserDataPath: mocks.getDefaultUserDataPathMock
  }
}

export async function createChildProcessModuleMock(spawnMock: Mock) {
  const { EventEmitter } = await import('node:events')
  return {
    spawn: spawnMock.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
        stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
        stdin: {
          write: vi.fn(),
          end: vi.fn()
        },
        kill: vi.fn()
      })
      process.nextTick(() => {
        child.emit('exit', 0, null)
        child.emit('close', 0, null)
      })
      return child
    })
  }
}

export function pairRuntimeEnvironment(listEnvironmentsMock: Mock, id: string, name = id): void {
  listEnvironmentsMock.mockReturnValue([
    {
      id,
      name,
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: null,
      runtimeId: null,
      endpoints: [
        {
          id: `ws-${id}`,
          kind: 'websocket',
          label: 'WebSocket',
          endpoint: 'ws://127.0.0.1:6768',
          deviceToken: 'token',
          publicKeyB64: 'pk'
        }
      ],
      preferredEndpointId: `ws-${id}`
    }
  ])
}

export function useWorktreeAwarenessEnvironment(mocks: WorktreeAwarenessMocks): void {
  const originalTerminalHandle = process.env.HIVEWARD_TERMINAL_HANDLE
  const originalUserDataPath = process.env.HIVEWARD_USER_DATA_PATH
  const originalDevCliInvocation = process.env.HIVEWARD_DEV_CLI_INVOCATION
  const originalPairingCode = process.env.HIVEWARD_PAIRING_CODE
  const originalRemotePairing = process.env.HIVEWARD_REMOTE_PAIRING
  const originalEnvironment = process.env.HIVEWARD_ENVIRONMENT
  const originalWorkspaceId = process.env.HIVEWARD_WORKSPACE_ID
  const originalWorktreeId = process.env.HIVEWARD_WORKTREE_ID

  beforeEach(() => {
    mocks.callMock.mockReset()
    delete process.env.HIVEWARD_TERMINAL_HANDLE
    delete process.env.HIVEWARD_USER_DATA_PATH
    delete process.env.HIVEWARD_DEV_CLI_INVOCATION
    delete process.env.HIVEWARD_WORKSPACE_ID
    delete process.env.HIVEWARD_WORKTREE_ID
    // Prevent claude-teams tests from leaking senderPaneKey into later assertions.
    delete process.env.HIVEWARD_PANE_KEY
    mocks.serveHiveWardAppMock.mockReset()
    mocks.getDefaultUserDataPathMock.mockClear()
    mocks.addEnvironmentFromPairingCodeMock.mockReset()
    mocks.listEnvironmentsMock.mockReset()
    mocks.spawnMock.mockClear()
    mocks.addEnvironmentFromPairingCodeMock.mockReturnValue({
      id: 'env-1',
      name: 'desk',
      createdAt: 100,
      updatedAt: 100,
      lastUsedAt: null,
      runtimeId: null,
      endpoints: [
        {
          id: 'ws-env-1',
          kind: 'websocket',
          label: 'WebSocket',
          endpoint: 'ws://127.0.0.1:6768',
          deviceToken: 'token',
          publicKeyB64: 'pk'
        }
      ],
      preferredEndpointId: 'ws-env-1'
    })
    mocks.listEnvironmentsMock.mockReturnValue([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalTerminalHandle === undefined) {
      delete process.env.HIVEWARD_TERMINAL_HANDLE
    } else {
      process.env.HIVEWARD_TERMINAL_HANDLE = originalTerminalHandle
    }
    if (originalUserDataPath === undefined) {
      delete process.env.HIVEWARD_USER_DATA_PATH
    } else {
      process.env.HIVEWARD_USER_DATA_PATH = originalUserDataPath
    }
    if (originalDevCliInvocation === undefined) {
      delete process.env.HIVEWARD_DEV_CLI_INVOCATION
    } else {
      process.env.HIVEWARD_DEV_CLI_INVOCATION = originalDevCliInvocation
    }
    if (originalPairingCode === undefined) {
      delete process.env.HIVEWARD_PAIRING_CODE
    } else {
      process.env.HIVEWARD_PAIRING_CODE = originalPairingCode
    }
    if (originalRemotePairing === undefined) {
      delete process.env.HIVEWARD_REMOTE_PAIRING
    } else {
      process.env.HIVEWARD_REMOTE_PAIRING = originalRemotePairing
    }
    if (originalEnvironment === undefined) {
      delete process.env.HIVEWARD_ENVIRONMENT
    } else {
      process.env.HIVEWARD_ENVIRONMENT = originalEnvironment
    }
    if (originalWorkspaceId === undefined) {
      delete process.env.HIVEWARD_WORKSPACE_ID
    } else {
      process.env.HIVEWARD_WORKSPACE_ID = originalWorkspaceId
    }
    if (originalWorktreeId === undefined) {
      delete process.env.HIVEWARD_WORKTREE_ID
    } else {
      process.env.HIVEWARD_WORKTREE_ID = originalWorktreeId
    }
  })
}
