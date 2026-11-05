import { expect, test } from './helpers/hiveward-app'
import type { Page } from '@stablyai/playwright-test'
import { focusActiveTerminalInput } from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  browserAddressBar,
  createBrowserSplit,
  createTerminalBrowserSplit,
  focusBrowserAddressBar,
  focusBrowserGroup,
  guestModifier,
  pressKeyInBrowserGuest,
  shortcutModifier as modifier,
  waitForFocusedGroup
} from './helpers/browser-split-fixture'

function browserFindInput(page: Page) {
  return page.getByPlaceholder('Find in page...')
}

function browserFindCloseButton(page: Page) {
  return browserFindInput(page).locator('xpath=..').getByTitle('Close')
}

function browserSplitFindInput(page: Page, browserTabId: string) {
  return page
    .locator(`[data-browser-overlay-tab-id="${browserTabId}"]`)
    .getByPlaceholder('Find in page...')
}

async function pressFindInBrowserGuest(
  page: Page,
  browserTabId: string,
  browserPageId: string
): Promise<void> {
  await pressKeyInBrowserGuest(page, browserTabId, browserPageId, 'F', [guestModifier])
}

function terminalFindInput(page: Page) {
  return page.locator('[data-terminal-search-root] input:visible')
}

test.describe('browser split shortcuts', () => {
  test.beforeEach(async ({ hivewardPage }) => {
    await waitForSessionReady(hivewardPage)
    await waitForActiveWorktree(hivewardPage)
    await ensureTerminalVisible(hivewardPage)
  })

  test('routes repeated Find shortcuts to the focused terminal or browser split', async ({
    hivewardPage
  }) => {
    const fixture = await createTerminalBrowserSplit(hivewardPage)

    await hivewardPage.evaluate(({ terminalGroupId }) => {
      const state = window.__store?.getState()
      const worktreeId = state?.activeWorktreeId
      if (state && worktreeId) {
        state.focusGroup(worktreeId, terminalGroupId)
      }
    }, fixture)
    await focusActiveTerminalInput(hivewardPage)
    await waitForFocusedGroup(hivewardPage, fixture.terminalGroupId)
    await hivewardPage.keyboard.press(`${modifier}+f`)
    await expect(terminalFindInput(hivewardPage)).toBeFocused()
    await expect(browserFindInput(hivewardPage)).toBeHidden()
    await hivewardPage.keyboard.press('Escape')

    await focusBrowserGroup(hivewardPage, fixture.browserGroupId)
    await focusBrowserAddressBar(hivewardPage, fixture.browserTabId)
    await hivewardPage.keyboard.press(`${modifier}+f`)
    await expect(browserFindInput(hivewardPage)).toBeFocused()
    await expect(terminalFindInput(hivewardPage)).toBeHidden()
    await browserFindCloseButton(hivewardPage).click()
    await expect(browserFindInput(hivewardPage)).toBeHidden()

    await hivewardPage.keyboard.press(`${modifier}+f`)
    await expect(browserFindInput(hivewardPage)).toBeFocused()
    await browserFindCloseButton(hivewardPage).click()

    await hivewardPage.evaluate(({ browserTabId }) => {
      window.__store?.getState().closeBrowserTab(browserTabId)
    }, fixture)
    await expect(
      hivewardPage.locator(`[data-browser-overlay-tab-id="${fixture.browserTabId}"]`)
    ).toHaveCount(0)

    await focusActiveTerminalInput(hivewardPage)
    await hivewardPage.keyboard.press(`${modifier}+f`)
    await expect(terminalFindInput(hivewardPage)).toBeFocused()
    await expect(browserFindInput(hivewardPage)).toBeHidden()
  })

  test('opens Find only in the browser split whose guest owns the shortcut', async ({
    hivewardPage
  }) => {
    const fixture = await createBrowserSplit(hivewardPage)

    await pressFindInBrowserGuest(hivewardPage, fixture.firstBrowserTabId, fixture.firstBrowserPageId)

    await expect(browserSplitFindInput(hivewardPage, fixture.firstBrowserTabId)).toBeVisible()
    await expect(browserSplitFindInput(hivewardPage, fixture.secondBrowserTabId)).toBeHidden()
    await expect
      .poll(() =>
        hivewardPage.evaluate(
          ({ browserPageId, browserTabId }) =>
            window.__store
              ?.getState()
              .browserPagesByWorkspace[browserTabId]?.find((page) => page.id === browserPageId)
              ?.loadError?.code ?? null,
          {
            browserPageId: fixture.firstBrowserPageId,
            browserTabId: fixture.firstBrowserTabId
          }
        )
      )
      .toBeNull()
  })

  test('keeps browser Find available when split focus state is temporarily missing', async ({
    hivewardPage
  }) => {
    const fixture = await createTerminalBrowserSplit(hivewardPage)
    await focusBrowserGroup(hivewardPage, fixture.browserGroupId)
    const addressBar = browserAddressBar(hivewardPage, fixture.browserTabId)
    await focusBrowserAddressBar(hivewardPage, fixture.browserTabId)

    await hivewardPage.evaluate(() => {
      const store = window.__store
      const worktreeId = store?.getState().activeWorktreeId
      if (!store || !worktreeId) {
        throw new Error('Active worktree unavailable')
      }
      store.setState((state) => {
        const activeGroupIdByWorktree = { ...state.activeGroupIdByWorktree }
        delete activeGroupIdByWorktree[worktreeId]
        return { activeGroupIdByWorktree }
      })
    })
    await expect(addressBar).toBeFocused()

    await hivewardPage.keyboard.press(`${modifier}+f`)
    await expect(browserFindInput(hivewardPage)).toBeFocused()
    await expect(terminalFindInput(hivewardPage)).toBeHidden()
  })

  test('keeps browser Find available when the focused split ID is stale', async ({ hivewardPage }) => {
    const fixture = await createTerminalBrowserSplit(hivewardPage)
    await focusBrowserGroup(hivewardPage, fixture.browserGroupId)
    const addressBar = browserAddressBar(hivewardPage, fixture.browserTabId)
    await focusBrowserAddressBar(hivewardPage, fixture.browserTabId)

    await hivewardPage.evaluate(() => {
      const store = window.__store
      const worktreeId = store?.getState().activeWorktreeId
      if (!store || !worktreeId) {
        throw new Error('Active worktree unavailable')
      }
      store.setState((state) => ({
        activeGroupIdByWorktree: {
          ...state.activeGroupIdByWorktree,
          [worktreeId]: 'removed-group'
        }
      }))
    })
    await expect(addressBar).toBeFocused()

    await hivewardPage.keyboard.press(`${modifier}+f`)
    await expect(browserFindInput(hivewardPage)).toBeFocused()
    await expect(terminalFindInput(hivewardPage)).toBeHidden()
  })
})
