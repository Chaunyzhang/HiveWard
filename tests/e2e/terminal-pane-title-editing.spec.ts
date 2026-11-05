import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/hiveward-app'
import { splitActiveTerminalPane, waitForPaneCount } from './helpers/terminal'
import { getActiveWorktreeId, getActiveTabId, getWorktreeTabs } from './helpers/store'
import { pressShortcut } from './helpers/shortcuts'
import {
  setPaneTitleFromTerminalMenu,
  openTerminalContextMenu
} from './helpers/terminal-pane-title-actions'
import {
  readVisibleXtermContainerBox,
  expectTerminalToReserveTitleSpace
} from './helpers/terminal-pane-geometry'
import { registerTerminalPaneMountReadiness } from './helpers/terminal-pane-mount-readiness'

async function openPaneTitleContextMenu(page: Page, title: string): Promise<void> {
  const modifiers: ('Alt' | 'Control' | 'Meta' | 'Shift')[] = (await page.evaluate(() =>
    navigator.userAgent.includes('Windows')
  ))
    ? ['Control']
    : []
  const isMac = await page.evaluate(() => navigator.userAgent.includes('Mac'))
  const titleBar = page.locator('.pane-title-bar', { hasText: title }).first()
  await expect(titleBar).toBeVisible()
  await titleBar.click({
    button: isMac ? 'left' : 'right',
    position: { x: 20, y: 10 },
    modifiers: isMac ? ['Control'] : modifiers
  })
  await expect(page.getByText('Set Title…', { exact: true })).toBeVisible()
}

async function getTabCustomTitle(
  page: Page,
  worktreeId: string,
  tabId: string
): Promise<string | null> {
  return page.evaluate(
    ({ targetWorktreeId, targetTabId }) => {
      const state = window.__store!.getState()
      const tab = (state.tabsByWorktree[targetWorktreeId] ?? []).find(
        (entry) => entry.id === targetTabId
      )
      return tab?.customTitle ?? null
    },
    { targetWorktreeId: worktreeId, targetTabId: tabId }
  )
}

async function expectTabCustomTitle(
  page: Page,
  worktreeId: string,
  tabId: string,
  expected: string | null
): Promise<void> {
  await expect
    .poll(() => getTabCustomTitle(page, worktreeId, tabId), { timeout: 3_000 })
    .toBe(expected)
}

async function expectSavedLayoutNotToContainTitle(
  page: Page,
  tabId: string,
  title: string
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ targetTabId, title }) => {
            const layout = window.__store!.getState().terminalLayoutsByTabId[targetTabId]
            return Object.values(layout?.titlesByLeafId ?? {}).includes(title)
          },
          { targetTabId: tabId, title }
        ),
      { timeout: 3_000 }
    )
    .toBe(false)
}

// Serialize headful scenarios; visible-window runs require an isolated display.
test.describe.configure({ mode: 'serial' })
test.describe('Terminal Panes', () => {
  registerTerminalPaneMountReadiness()

  test('first Set Title from terminal context menu stays open for typing', async ({ hivewardPage }) => {
    const title = `First menu title ${Date.now()}`

    await openTerminalContextMenu(hivewardPage)
    await hivewardPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = hivewardPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await hivewardPage.waitForTimeout(250)
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()

    await titleInput.fill(title)
    await titleInput.press('Enter')

    await expect(titleInput).toHaveCount(0)
    await expect(hivewardPage.locator('.pane-title-text', { hasText: title })).toHaveCount(1)
  })

  test('Set Title editor renders in HiveWard overlay while terminal reserves title space', async ({
    hivewardPage
  }) => {
    const title = `Reserved overlay title ${Date.now()}`
    const terminalBoxBefore = await readVisibleXtermContainerBox(hivewardPage)

    await openTerminalContextMenu(hivewardPage)
    await hivewardPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = hivewardPage.locator('.pane-title-overlay-layer .pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await expect(hivewardPage.getByText('Set Title…', { exact: true })).toBeHidden()
    await expect(hivewardPage.locator('.pane .pane-title-input')).toHaveCount(0)
    await expect(hivewardPage.locator('.pane[data-has-title]')).toHaveCount(1)
    await expect
      .poll(() =>
        hivewardPage
          .locator('.pane-title-bar')
          .first()
          .evaluate((titleBar) => getComputedStyle(titleBar).backgroundColor)
      )
      .not.toBe('rgba(0, 0, 0, 0)')
    const terminalBoxEditing = await readVisibleXtermContainerBox(hivewardPage)
    expectTerminalToReserveTitleSpace(terminalBoxEditing, terminalBoxBefore)

    await titleInput.fill(title)
    await titleInput.press('Enter')
    await expect(hivewardPage.locator('.pane-title-text', { hasText: title })).toBeVisible()
    await expect(hivewardPage.locator('.pane[data-has-title]')).toHaveCount(1)
    expectTerminalToReserveTitleSpace(
      await readVisibleXtermContainerBox(hivewardPage),
      terminalBoxBefore
    )
  })

  test('Set Title context menu opens from the title overlay strip', async ({ hivewardPage }) => {
    const title = `Overlay menu title ${Date.now()}`
    const updatedTitle = `Overlay menu updated ${Date.now()}`

    await setPaneTitleFromTerminalMenu(hivewardPage, title)
    await openPaneTitleContextMenu(hivewardPage, title)
    await hivewardPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = hivewardPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await expect(titleInput).toHaveValue(title)
    await titleInput.fill(updatedTitle)
    await titleInput.press('Enter')

    await expect(hivewardPage.locator('.pane-title-text', { hasText: updatedTitle })).toHaveCount(1)
    await expect(hivewardPage.locator('.pane-title-text', { hasText: title })).toHaveCount(0)
  })

  test('Set Title commits when tabbing away from the title input', async ({ hivewardPage }) => {
    const title = `Tab commit title ${Date.now()}`

    await openTerminalContextMenu(hivewardPage)
    await hivewardPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = hivewardPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await titleInput.fill(title)
    await titleInput.press('Tab')

    await expect(titleInput).toHaveCount(0)
    await expect(hivewardPage.locator('.pane-title-text', { hasText: title })).toHaveCount(1)
  })

  test('Set Title overlay hides with its inactive terminal tab', async ({ hivewardPage }) => {
    const title = `Hidden tab title ${Date.now()}`
    const worktreeId = (await getActiveWorktreeId(hivewardPage))!

    await setPaneTitleFromTerminalMenu(hivewardPage, title)
    await expect(hivewardPage.locator('.pane-title-text', { hasText: title })).toBeVisible()

    await pressShortcut(hivewardPage, 't')
    await expect
      .poll(async () => (await getWorktreeTabs(hivewardPage, worktreeId)).length, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(2)
    await expect(hivewardPage.locator('.pane-title-text', { hasText: title })).toBeHidden()

    await pressShortcut(hivewardPage, 'BracketLeft', { shift: true })
    await expect(hivewardPage.locator('.pane-title-text', { hasText: title })).toBeVisible()
  })

  test('Set Title still commits by blur after focus settles', async ({ hivewardPage }) => {
    const title = `Blur commit title ${Date.now()}`

    await openTerminalContextMenu(hivewardPage)
    await hivewardPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = hivewardPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await hivewardPage.waitForTimeout(100)
    await titleInput.fill(title)
    await hivewardPage
      .locator('.xterm:visible')
      .first()
      .click({ position: { x: 40, y: 60 } })

    await expect(titleInput).toHaveCount(0)
    await expect(hivewardPage.locator('.pane-title-text', { hasText: title })).toHaveCount(1)
  })

  test('Set Title stays pane-local during agent title churn', async ({ hivewardPage }) => {
    const worktreeId = (await getActiveWorktreeId(hivewardPage))!
    const tabId = (await getActiveTabId(hivewardPage))!
    const paneTitle = `Codex pane ${Date.now()}`
    const removeButtonTitle = `Remove button label ${Date.now()}`
    const splitTitle = `Split label ${Date.now()}`
    const runtimeTitle = '⠋ Codex working'

    await setPaneTitleFromTerminalMenu(hivewardPage, paneTitle)
    await expect(hivewardPage.locator('.pane-title-text', { hasText: paneTitle })).toBeVisible()
    await expectTabCustomTitle(hivewardPage, worktreeId, tabId, null)

    await hivewardPage.getByRole('button', { name: `Edit pane title: ${paneTitle}` }).focus()
    await hivewardPage.keyboard.press('Enter')
    const paneTitleInput = hivewardPage.getByRole('textbox', { name: 'Pane title' })
    await expect(paneTitleInput).toBeVisible()
    await expect(paneTitleInput).toBeFocused()
    await hivewardPage.keyboard.press('Escape')
    await expect(paneTitleInput).toHaveCount(0)
    await expect(hivewardPage.locator('.pane-title-text', { hasText: paneTitle })).toBeVisible()

    await hivewardPage.evaluate(
      ({ targetTabId, title }) => {
        window.__store!.getState().updateTabTitle(targetTabId, title)
      },
      { targetTabId: tabId, title: runtimeTitle }
    )

    // OSC titles may churn continuously; pane-local Set Title must remain visible while tab runtime title follows the active PTY.
    await expect(hivewardPage.locator('.pane-title-text', { hasText: paneTitle })).toBeVisible()
    await expect(
      hivewardPage.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`)
    ).toHaveAttribute('data-tab-title', runtimeTitle)
    await expectTabCustomTitle(hivewardPage, worktreeId, tabId, null)

    await setPaneTitleFromTerminalMenu(hivewardPage, '')
    await expect(hivewardPage.locator('.pane-title-text', { hasText: paneTitle })).toBeHidden()
    await expectSavedLayoutNotToContainTitle(hivewardPage, tabId, paneTitle)

    await setPaneTitleFromTerminalMenu(hivewardPage, removeButtonTitle)
    await setPaneTitleFromTerminalMenu(hivewardPage, '')
    await expect(hivewardPage.locator('.pane-title-text', { hasText: removeButtonTitle })).toBeHidden()
    await expectSavedLayoutNotToContainTitle(hivewardPage, tabId, removeButtonTitle)

    await setPaneTitleFromTerminalMenu(hivewardPage, splitTitle)
    await expectTabCustomTitle(hivewardPage, worktreeId, tabId, null)

    await splitActiveTerminalPane(hivewardPage, 'vertical')
    await waitForPaneCount(hivewardPage, 2)
    await expect(hivewardPage.locator('.pane-title-text', { hasText: splitTitle })).toBeVisible()

    await hivewardPage.evaluate(
      ({ targetTabId, title }) => {
        window.__store!.getState().updateTabTitle(targetTabId, title)
      },
      { targetTabId: tabId, title: runtimeTitle }
    )
    await expect(
      hivewardPage.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`)
    ).toHaveAttribute('data-tab-title', runtimeTitle)
  })
})
