// Require @headful WebGL: DOM fallback cannot reproduce canvas staleness after split reparenting.

import { test, expect } from './helpers/hiveward-app'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  switchToWorktree,
  ensureTerminalVisible
} from './helpers/store'
import { waitForActiveTerminalManager, waitForPaneCount } from './helpers/terminal'
import {
  createAndActivateWorktreeWithManualSplit,
  removeWorktreeViaStore,
  waitForAllPanesToHaveContent,
  checkWebglState
} from './helpers/dead-terminal'

const STRESS_ITERATIONS = 5

test.describe('Dead Terminal Reproduction @headful', () => {
  const createdWorktreeIds: string[] = []

  test.beforeEach(async ({ hivewardPage }) => {
    await waitForSessionReady(hivewardPage)
    await waitForActiveWorktree(hivewardPage)
    await ensureTerminalVisible(hivewardPage)
  })

  test.afterEach(async ({ hivewardPage }) => {
    for (const id of createdWorktreeIds) {
      await removeWorktreeViaStore(hivewardPage, id)
    }
    createdWorktreeIds.length = 0
  })

  test('@headful manual-split flow does not produce dead terminals', async ({ hivewardPage }) => {
    test.setTimeout(120_000)
    const homeWorktreeId = await waitForActiveWorktree(hivewardPage)
    await waitForActiveTerminalManager(hivewardPage, 30_000)
    await checkWebglState(hivewardPage, 'home-initial')

    for (let i = 0; i < STRESS_ITERATIONS; i++) {
      const direction = i % 2 === 0 ? 'vertical' : 'horizontal'
      const newId = await createAndActivateWorktreeWithManualSplit(
        hivewardPage,
        `setup-${i}`,
        direction
      )
      createdWorktreeIds.push(newId)

      await expect.poll(async () => getActiveWorktreeId(hivewardPage), { timeout: 10_000 }).toBe(newId)
      await ensureTerminalVisible(hivewardPage)
      await waitForActiveTerminalManager(hivewardPage, 30_000)
      await waitForPaneCount(hivewardPage, 2, 15_000)
      await checkWebglState(hivewardPage, `setup-${i}`)
      await waitForAllPanesToHaveContent(hivewardPage, `setup-${i} both panes`)

      await switchToWorktree(hivewardPage, homeWorktreeId)
      await expect
        .poll(async () => getActiveWorktreeId(hivewardPage), { timeout: 10_000 })
        .toBe(homeWorktreeId)
      await removeWorktreeViaStore(hivewardPage, newId)
      createdWorktreeIds.pop()
    }
  })

  test('@headful manual-split then switch-back does not leave panes dead', async ({ hivewardPage }) => {
    test.setTimeout(120_000)
    const homeWorktreeId = await waitForActiveWorktree(hivewardPage)
    await waitForActiveTerminalManager(hivewardPage, 30_000)

    for (let i = 0; i < STRESS_ITERATIONS; i++) {
      const newId = await createAndActivateWorktreeWithManualSplit(
        hivewardPage,
        `switchback-${i}`,
        'vertical'
      )
      createdWorktreeIds.push(newId)

      await expect.poll(async () => getActiveWorktreeId(hivewardPage), { timeout: 10_000 }).toBe(newId)
      await ensureTerminalVisible(hivewardPage)
      await waitForActiveTerminalManager(hivewardPage, 30_000)
      await waitForPaneCount(hivewardPage, 2, 15_000)
      await waitForAllPanesToHaveContent(hivewardPage, `switchback-${i} initial`)

      await switchToWorktree(hivewardPage, homeWorktreeId)
      await expect
        .poll(async () => getActiveWorktreeId(hivewardPage), { timeout: 10_000 })
        .toBe(homeWorktreeId)
      await ensureTerminalVisible(hivewardPage)
      await waitForActiveTerminalManager(hivewardPage, 15_000)

      await switchToWorktree(hivewardPage, newId)
      await expect.poll(async () => getActiveWorktreeId(hivewardPage), { timeout: 10_000 }).toBe(newId)
      await ensureTerminalVisible(hivewardPage)
      await waitForActiveTerminalManager(hivewardPage, 15_000)
      await waitForAllPanesToHaveContent(hivewardPage, `switchback-${i} after return`)

      await switchToWorktree(hivewardPage, homeWorktreeId)
      await expect
        .poll(async () => getActiveWorktreeId(hivewardPage), { timeout: 10_000 })
        .toBe(homeWorktreeId)
      await removeWorktreeViaStore(hivewardPage, newId)
      createdWorktreeIds.pop()
    }
  })

  test('@headful rapid switching between many manual-split worktrees', async ({ hivewardPage }) => {
    test.setTimeout(120_000)
    const homeWorktreeId = await waitForActiveWorktree(hivewardPage)
    await waitForActiveTerminalManager(hivewardPage, 30_000)

    const worktreeIds = [homeWorktreeId]
    for (let i = 0; i < 4; i++) {
      const newId = await createAndActivateWorktreeWithManualSplit(
        hivewardPage,
        `multi-${i}`,
        'vertical'
      )
      createdWorktreeIds.push(newId)
      worktreeIds.push(newId)

      await expect.poll(async () => getActiveWorktreeId(hivewardPage), { timeout: 10_000 }).toBe(newId)
      await ensureTerminalVisible(hivewardPage)
      await waitForActiveTerminalManager(hivewardPage, 30_000)
      await waitForPaneCount(hivewardPage, 2, 15_000)
      await waitForAllPanesToHaveContent(hivewardPage, `multi-create-${i}`)
    }

    for (let round = 0; round < 3; round++) {
      for (const wId of worktreeIds) {
        await switchToWorktree(hivewardPage, wId)
        await expect.poll(async () => getActiveWorktreeId(hivewardPage), { timeout: 10_000 }).toBe(wId)
        await ensureTerminalVisible(hivewardPage)
        await waitForActiveTerminalManager(hivewardPage, 15_000)
        await waitForAllPanesToHaveContent(hivewardPage, `multi-r${round}-${wId.slice(0, 8)}`)
      }
    }
  })
})
