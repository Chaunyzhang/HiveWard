// Require scrollback retention across tab, pane and worktree changes.

import { test, expect } from './helpers/hiveward-app'
import {
  discoverActivePtyId,
  execInTerminal,
  closeActiveTerminalPane,
  countVisibleTerminalPanes,
  focusLastTerminalPane,
  splitActiveTerminalPane,
  waitForTerminalOutput,
  waitForPaneCount,
  getTerminalContent
} from './helpers/terminal'
import {
  getActiveWorktreeId,
  getActiveTabType,
  getWorktreeTabs,
  getAllWorktreeIds,
  switchToOtherWorktree,
  switchToWorktree,
  ensureTerminalVisible
} from './helpers/store'
import { pressShortcut } from './helpers/shortcuts'
import { registerTerminalPaneMountReadiness } from './helpers/terminal-pane-mount-readiness'

// Serialize headful scenarios; visible-window runs require an isolated display.
test.describe.configure({ mode: 'serial' })
test.describe('Terminal Panes', () => {
  registerTerminalPaneMountReadiness()

  test('terminal pane retains content when switching tabs and back', async ({ hivewardPage }) => {
    const ptyId = await discoverActivePtyId(hivewardPage)
    const marker = `RETAIN_TEST_${Date.now()}`
    await execInTerminal(hivewardPage, ptyId, `echo ${marker}`)
    await waitForTerminalOutput(hivewardPage, marker)

    const worktreeId = (await getActiveWorktreeId(hivewardPage))!
    await pressShortcut(hivewardPage, 't')

    await expect
      .poll(async () => (await getWorktreeTabs(hivewardPage, worktreeId)).length, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(2)

    const activeType = await getActiveTabType(hivewardPage)
    expect(activeType).toBe('terminal')

    await pressShortcut(hivewardPage, 'BracketLeft', { shift: true })

    await expect
      .poll(async () => (await getTerminalContent(hivewardPage)).includes(marker), { timeout: 5_000 })
      .toBe(true)

    await pressShortcut(hivewardPage, 'BracketRight', { shift: true })
    await pressShortcut(hivewardPage, 'w')
  })

  test('terminal pane retains content when splitting and closing a pane', async ({ hivewardPage }) => {
    const ptyId = await discoverActivePtyId(hivewardPage)
    const marker = `SPLIT_RETAIN_${Date.now()}`
    await execInTerminal(hivewardPage, ptyId, `echo ${marker}`)
    await waitForTerminalOutput(hivewardPage, marker)

    const panesBefore = await countVisibleTerminalPanes(hivewardPage)

    await splitActiveTerminalPane(hivewardPage, 'vertical')
    await waitForPaneCount(hivewardPage, panesBefore + 1)

    await focusLastTerminalPane(hivewardPage)
    await closeActiveTerminalPane(hivewardPage)
    await waitForPaneCount(hivewardPage, panesBefore)

    await expect
      .poll(async () => (await getTerminalContent(hivewardPage)).includes(marker), { timeout: 5_000 })
      .toBe(true)
  })

  test('terminal pane retains content when switching worktrees and back', async ({ hivewardPage }) => {
    const allWorktreeIds = await getAllWorktreeIds(hivewardPage)
    if (allWorktreeIds.length < 2) {
      test.skip(true, 'Need at least 2 worktrees to test worktree switching')
      return
    }

    const worktreeId = (await getActiveWorktreeId(hivewardPage))!

    const ptyId = await discoverActivePtyId(hivewardPage)
    const marker = `WT_RETAIN_${Date.now()}`
    await execInTerminal(hivewardPage, ptyId, `echo ${marker}`)
    await waitForTerminalOutput(hivewardPage, marker)

    const otherId = await switchToOtherWorktree(hivewardPage, worktreeId)
    expect(otherId).not.toBeNull()
    await expect.poll(async () => getActiveWorktreeId(hivewardPage), { timeout: 5_000 }).toBe(otherId)

    await switchToWorktree(hivewardPage, worktreeId)
    await expect
      .poll(async () => getActiveWorktreeId(hivewardPage), { timeout: 5_000 })
      .toBe(worktreeId)

    // Poll the retained marker after worktree return: serialize-addon rebind can lag the activation cascade, so avoid an earlier manager-timing assertion.
    await ensureTerminalVisible(hivewardPage)

    await expect
      .poll(async () => (await getTerminalContent(hivewardPage)).includes(marker), { timeout: 20_000 })
      .toBe(true)
  })
})
