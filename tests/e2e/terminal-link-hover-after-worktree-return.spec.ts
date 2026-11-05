import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/hiveward-app'
import {
  ensureTerminalVisible,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { waitForPtyShellEcho } from './terminal-pty-readiness'

// After worktree hide, Linkifier clears currentLink but retains _lastBufferCell; returning to the same cell skips providers until scroll.
// File-path links lack a compensating click fallback, so require relinkification on reveal.
type HoverProbe = { col: number; row: number; tabId: string }

async function locateHoverProbe(page: Page, needle: string): Promise<HoverProbe> {
  return page.evaluate((needle) => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId ?? null
    const tabId =
      state?.activeTabType === 'terminal'
        ? (state?.activeTabId ?? null)
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!tabId || !pane) {
      throw new Error('active terminal pane unavailable')
    }
    const terminal = pane.terminal
    const buffer = terminal.buffer.active
    let hit: { row: number; col: number } | null = null
    for (let row = 0; row < terminal.rows; row += 1) {
      const line = buffer.getLine(buffer.viewportY + row)
      if (!line) {
        continue
      }
      const idx = line.translateToString(true).indexOf(needle)
      if (idx !== -1) {
        hit = { row, col: idx }
        break
      }
    }
    if (!hit) {
      throw new Error('link text not visible in terminal viewport')
    }
    const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen')
    if (!screen) {
      throw new Error('xterm-screen element unavailable')
    }
    // Aim at link center to tolerate rounding.
    return {
      col: hit.col + Math.floor(needle.length / 2),
      row: hit.row,
      tabId
    }
  }, needle)
}

// Dispatch hover and return the active link; poll because file-path candidates resolve asynchronously.
async function hoverAndReadActiveLinkText(page: Page, probe: HoverProbe): Promise<string | null> {
  await page.evaluate(({ col, row, tabId }) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const screen = pane?.terminal.element?.querySelector<HTMLElement>('.xterm-screen')
    if (!pane || !screen) {
      throw new Error('xterm-screen element unavailable')
    }
    const rect = screen.getBoundingClientRect()
    const clientX = rect.left + (col + 0.5) * (rect.width / pane.terminal.cols)
    const clientY = rect.top + (row + 0.5) * (rect.height / pane.terminal.rows)
    screen.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX, clientY })
    )
  }, probe)
  return readActiveLinkText(page, probe.tabId)
}

async function readActiveLinkText(page: Page, tabId: string): Promise<string | null> {
  return page.evaluate(
    ({ tabId }) => {
      const manager = window.__paneManagers?.get(tabId)
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      const core = pane?.terminal as unknown as
        | { _core?: { linkifier?: { currentLink?: { link?: { text?: string } } } } }
        | undefined
      return core?._core?.linkifier?.currentLink?.link?.text ?? null
    },
    { tabId }
  )
}

async function readTerminalCursor(page: Page, tabId: string): Promise<string | null> {
  return page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const screen = pane?.terminal.element?.querySelector<HTMLElement>('.xterm-screen')
    return screen ? getComputedStyle(screen).cursor : null
  }, tabId)
}

async function isTerminalSurfaceVisible(page: Page, tabId: string): Promise<boolean> {
  return page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    return Boolean(pane?.container.isConnected && pane.container.getClientRects().length > 0)
  }, tabId)
}

async function activateHoveredLink(page: Page, probe: HoverProbe): Promise<void> {
  await page.evaluate(({ col, row, tabId }) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const screen = pane?.terminal.element?.querySelector<HTMLElement>('.xterm-screen')
    if (!pane || !screen) {
      throw new Error('xterm-screen element unavailable')
    }
    const rect = screen.getBoundingClientRect()
    const clientX = rect.left + (col + 0.5) * (rect.width / pane.terminal.cols)
    const clientY = rect.top + (row + 0.5) * (rect.height / pane.terminal.rows)
    const isMac = navigator.userAgent.includes('Mac')
    const modifier = { metaKey: isMac, ctrlKey: !isMac }
    screen.dispatchEvent(
      new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        clientX,
        clientY,
        ...modifier
      })
    )
    screen.dispatchEvent(
      new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX,
        clientY,
        ...modifier
      })
    )
  }, probe)
}

async function dispatchScreenMouseLeave(page: Page, tabId: string): Promise<void> {
  await page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const screen = pane?.terminal.element?.querySelector<HTMLElement>('.xterm-screen')
    // Model surface hide: clear current link while retaining its cell cache.
    screen?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, cancelable: true }))
  }, tabId)
}

async function activeWorktreePath(page: Page): Promise<string> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const id = state?.activeWorktreeId
    return (
      Object.values(state?.worktreesByRepo ?? {})
        .flat()
        .find((w) => w.id === id)?.path ?? ''
    )
  })
}

// Require hover relinkification after worktree return; contains tolerates provider display text differing from the echoed token.
async function assertLinkRecoversAfterReturn(
  page: Page,
  args: {
    firstWorktreeId: string
    secondWorktreeId: string
    needle: string
    expectContains: string
  }
): Promise<HoverProbe> {
  const probe = await locateHoverProbe(page, args.needle)

  await expect
    .poll(() => hoverAndReadActiveLinkText(page, probe), {
      timeout: 5_000,
      message: 'baseline hover never established the link'
    })
    .toContain(args.expectContains)

  await dispatchScreenMouseLeave(page, probe.tabId)
  await switchToWorktree(page, args.secondWorktreeId)
  await waitForActiveTerminalManager(page, 30_000)
  // Wait for the intermediate hidden commit so React cannot batch away the lifecycle transition.
  await expect.poll(() => isTerminalSurfaceVisible(page, probe.tabId)).toBe(false)

  await switchToWorktree(page, args.firstWorktreeId)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  await expect.poll(() => isTerminalSurfaceVisible(page, probe.tabId)).toBe(true)

  // Hover the same cell without scroll; reveal reset must re-linkify it.
  await expect
    .poll(() => hoverAndReadActiveLinkText(page, probe), {
      timeout: 5_000,
      message: 'link did not re-establish on hover after returning to the worktree'
    })
    .toContain(args.expectContains)

  // Require pointer affordance plus currentLink, which xterm needs for click activation.
  await expect.poll(() => readTerminalCursor(page, probe.tabId)).toBe('pointer')
  return probe
}

test.describe('Terminal link hover after worktree return', () => {
  test.beforeEach(async ({ hivewardPage }) => {
    await waitForSessionReady(hivewardPage)
  })

  test('re-establishes a URL link on hover after the pointer leaves the terminal', async ({
    hivewardPage
  }) => {
    await ensureTerminalVisible(hivewardPage)
    await waitForActiveTerminalManager(hivewardPage, 30_000)
    const ptyId = await waitForActivePanePtyId(hivewardPage)
    await waitForPtyShellEcho(hivewardPage, ptyId, 15_000)

    const url = `https://example.com/hiveward-link-${randomUUID()}`
    await sendToTerminal(hivewardPage, ptyId, `echo ${url}\r`)
    await expect
      .poll(() => getTerminalContent(hivewardPage, 4000), {
        timeout: 10_000,
        message: 'URL fixture did not reach the terminal buffer'
      })
      .toContain(url)

    // Let streamed-output reset finish before building the mouseleave cache state.
    await hivewardPage.waitForTimeout(300)
    const probe = await locateHoverProbe(hivewardPage, url)
    await expect
      .poll(() => hoverAndReadActiveLinkText(hivewardPage, probe), {
        timeout: 5_000,
        message: 'baseline hover never established the URL link'
      })
      .toContain(url)

    await dispatchScreenMouseLeave(hivewardPage, probe.tabId)
    await expect.poll(() => readActiveLinkText(hivewardPage, probe.tabId)).toBeNull()
    await expect.poll(() => readTerminalCursor(hivewardPage, probe.tabId)).not.toBe('pointer')

    await expect
      .poll(() => hoverAndReadActiveLinkText(hivewardPage, probe), {
        timeout: 5_000,
        message: 'URL link did not re-establish after terminal mouseleave'
      })
      .toContain(url)
    await expect.poll(() => readTerminalCursor(hivewardPage, probe.tabId)).toBe('pointer')
  })

  test('re-establishes a file-path link on hover after switching worktrees and back', async ({
    hivewardPage
  }) => {
    const firstWorktreeId = await waitForActiveWorktree(hivewardPage)
    const secondWorktreeId = (await getAllWorktreeIds(hivewardPage)).find(
      (id) => id !== firstWorktreeId
    )
    test.skip(!secondWorktreeId, 'link-hover repro needs the seeded secondary worktree')
    if (!secondWorktreeId) {
      return
    }

    await ensureTerminalVisible(hivewardPage)
    await waitForActiveTerminalManager(hivewardPage, 30_000)
    const ptyId = await waitForActivePanePtyId(hivewardPage)
    await waitForPtyShellEcho(hivewardPage, ptyId, 15_000)

    const worktreePath = await activeWorktreePath(hivewardPage)
    const fileName = `hiveward-linkfile-${randomUUID().slice(0, 8)}.txt`
    const filePath = path.join(worktreePath, fileName)
    writeFileSync(filePath, 'hiveward file link target\n')
    const needle = `./${fileName}`

    try {
      await sendToTerminal(hivewardPage, ptyId, `echo ${needle}\r`)
      await expect
        .poll(() => getTerminalContent(hivewardPage, 4000), {
          timeout: 10_000,
          message: 'file-link fixture did not reach the terminal buffer'
        })
        .toContain(fileName)

      const probe = await assertLinkRecoversAfterReturn(hivewardPage, {
        firstWorktreeId,
        secondWorktreeId,
        needle,
        expectContains: fileName
      })
      await activateHoveredLink(hivewardPage, probe)
      // Require rendered editor header after activation; store state alone can hide a blank editor.
      await expect(hivewardPage.locator('.editor-header-path').first()).toContainText(fileName, {
        timeout: 20_000
      })
    } finally {
      await hivewardPage.evaluate((filePath) => {
        const state = window.__store?.getState()
        if (state?.openFiles.some((file) => file.filePath === filePath)) {
          state.closeFile(filePath)
        }
      }, filePath)
      rmSync(filePath, { force: true })
    }
  })

  test('re-establishes a URL link on hover after switching worktrees and back', async ({
    hivewardPage
  }) => {
    const firstWorktreeId = await waitForActiveWorktree(hivewardPage)
    const secondWorktreeId = (await getAllWorktreeIds(hivewardPage)).find(
      (id) => id !== firstWorktreeId
    )
    test.skip(!secondWorktreeId, 'link-hover repro needs the seeded secondary worktree')
    if (!secondWorktreeId) {
      return
    }

    await ensureTerminalVisible(hivewardPage)
    await waitForActiveTerminalManager(hivewardPage, 30_000)
    const ptyId = await waitForActivePanePtyId(hivewardPage)
    await waitForPtyShellEcho(hivewardPage, ptyId, 15_000)

    const url = `https://example.com/hiveward-link-${randomUUID()}`
    await sendToTerminal(hivewardPage, ptyId, `echo ${url}\r`)
    await expect
      .poll(() => getTerminalContent(hivewardPage, 4000), {
        timeout: 10_000,
        message: 'URL fixture did not reach the terminal buffer'
      })
      .toContain(url)

    await assertLinkRecoversAfterReturn(hivewardPage, {
      firstWorktreeId,
      secondWorktreeId,
      needle: url,
      expectContains: url
    })
  })
})
