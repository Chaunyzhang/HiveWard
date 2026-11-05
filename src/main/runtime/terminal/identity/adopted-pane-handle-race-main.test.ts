// Restart adoption can publish a pane before its exported handle registers; any handle issued in that gap must stay valid or become stale.
import { expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../../shared/runtime-types'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'

vi.mock('../../../../shared/layout-owner-switch', () => ({ HIVEWARD_LAYOUT_OWNER_IS_MAIN: true }))

await import('../../hiveward-runtime-test-mocks.spec')
await import('../../hiveward-runtime-test-lifecycle.spec')
const { HEADLESS_LEAF_ID, TEST_WORKTREE_ID, TEST_WORKTREE_PATH } =
  await import('../../hiveward-runtime-test-fixtures.spec')
const { HiveWardRuntimeService } = await import('../../hiveward-runtime-test-mocks.spec')
const {
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('../../hiveward-runtime-test-fixtures.spec')

const TAB = '44444444-4444-4444-8444-444444444444'
// A daemon session id names its worktree, so a record can exist before registration.
const PTY = `${TEST_WORKTREE_ID}@@restored1`
const CONTROLLER_HANDLE = 'term_exported-before-restart'

it('gives a restored pane one handle: none before its adoption registers, then the terminal’s own', async () => {
  const harness = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: TAB,
            ptyId: PTY,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: { [TAB]: makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: PTY }) },
      terminalPtyIncarnationsByPaneKey: { [`${TAB}:${HEADLESS_LEAF_ID}`]: 'inc-restored' }
    })
  )
  const runtime = new HiveWardRuntimeService(harness.runtimeStore)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => [{ id: PTY, cwd: TEST_WORKTREE_PATH, title: 'sh' }]
  })
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })

  // Adopted starts can create the record before handle registration.
  runtime['getOrCreatePtyWorktreeRecord'](PTY)
  const before = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
  const handedOut = before.tabs.flatMap((tab) =>
    tab.type === 'terminal' && tab.status === 'ready' && tab.terminal ? [tab.terminal] : []
  )
  // The registration gap leaves the pane unnamed, without closing or removing its binding.
  expect(harness.getSession().terminalLayoutsByTabId[TAB]?.ptyIdsByLeafId?.[HEADLESS_LEAF_ID]).toBe(
    PTY
  )
  expect(harness.getSession().closedTerminalPanesByPaneKey ?? {}).toEqual({})

  runtime.registerPreAllocatedHandleForPty(PTY, CONTROLLER_HANDLE)
  runtime.registerPty(PTY, TEST_WORKTREE_ID, null, {
    tabId: TAB,
    leafId: HEADLESS_LEAF_ID,
    terminalHandle: CONTROLLER_HANDLE,
    incarnationId: 'inc-restored'
  })
  const after = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
  const settled = after.tabs.flatMap((tab) =>
    tab.type === 'terminal' && tab.status === 'ready' && tab.terminal ? [tab.terminal] : []
  )

  expect(settled).toEqual([CONTROLLER_HANDLE])
  expect(runtime['paneOfPty'](runtime['ptysById'].get(PTY)).paneKey).toBe(
    `${TAB}:${HEADLESS_LEAF_ID}`
  )
  expect(runtime['getLivePtyForHandle'](CONTROLLER_HANDLE)?.pty.ptyId).toBe(PTY)
  // Any handle handed out in the gap is that same handle, or no longer names the terminal.
  for (const handle of handedOut) {
    expect(handle === CONTROLLER_HANDLE || runtime['getLivePtyForHandle'](handle) === null).toBe(
      true
    )
  }
})

it('keeps a main-placed terminal handle across runtime restarts without exported metadata', async () => {
  const harness = makeRuntimeStoreWithWorkspaceSession({
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
  })
  const restarted = () => {
    const runtime = new HiveWardRuntimeService(harness.runtimeStore)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: PTY,
          incarnationId: 'inc-restored',
          title: 'bash',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })
    return runtime
  }
  const placeAndList = async (runtime: ReturnType<typeof restarted>) => {
    await runtime.placeUnshownLiveTerminals()
    const session = harness.getSession()
    const tab = session.tabsByWorktree[TEST_WORKTREE_ID]?.find(
      (candidate) => candidate.ptyId === PTY
    )
    const leafId = Object.entries(
      session.terminalLayoutsByTabId[tab?.id ?? '']?.ptyIdsByLeafId ?? {}
    ).find(([, ptyId]) => ptyId === PTY)?.[0]
    if (!tab || !leafId) {
      throw new Error('Expected main to persist the restored pane')
    }
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    const paneHandle = runtime.getTerminalHandleForPaneKey(`${tab.id}:${leafId}`)
    const [terminal] = (await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)).terminals
    if (!terminal) {
      throw new Error('Expected the restored terminal')
    }
    expect(terminal.handle).toBe(paneHandle)
    return terminal
  }

  const before = await placeAndList(restarted())
  const after = await placeAndList(restarted())

  expect(after.ptyId).toBe(before.ptyId)
  expect(after.incarnationId).toBe(before.incarnationId)
  expect(after.handle).toBe(before.handle)
})
