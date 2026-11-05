import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/hiveward-app'
import { splitActiveTerminalPane, waitForPaneCount } from './helpers/terminal'
import { openTerminalContextMenu } from './helpers/terminal-pane-title-actions'
import { registerTerminalPaneMountReadiness } from './helpers/terminal-pane-mount-readiness'

async function installDelayedTerminalFocusSteals(
  page: Page,
  delaysMs: readonly number[]
): Promise<void> {
  await page.evaluate((delays) => {
    const focusTerminalAfterTitleFocus = (event: FocusEvent): void => {
      const target = event.target
      if (!(target instanceof HTMLInputElement) || !target.classList.contains('pane-title-input')) {
        return
      }
      document.removeEventListener('focusin', focusTerminalAfterTitleFocus, true)
      for (const delay of delays) {
        window.setTimeout(() => {
          const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
          textarea?.focus()
        }, delay)
      }
    }
    document.addEventListener('focusin', focusTerminalAfterTitleFocus, true)
  }, delaysMs)
}

// Serialize headful scenarios; visible-window runs require an isolated display.
test.describe.configure({ mode: 'serial' })
test.describe('Terminal Panes', () => {
  registerTerminalPaneMountReadiness()

  test('Set Title input stays open when clicked in a split terminal', async ({ hivewardPage }) => {
    await splitActiveTerminalPane(hivewardPage, 'vertical')
    await waitForPaneCount(hivewardPage, 2)
    await splitActiveTerminalPane(hivewardPage, 'horizontal')
    await waitForPaneCount(hivewardPage, 3)

    await openTerminalContextMenu(hivewardPage)
    await hivewardPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = hivewardPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()

    // Title controls own the strip: clicking the open input must not reach xterm and close the editor.
    await titleInput.evaluate((input) => {
      const pointerInit: PointerEventInit = {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: 'mouse'
      }
      input.dispatchEvent(new PointerEvent('pointerdown', pointerInit))
      input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      input.dispatchEvent(new PointerEvent('pointerup', pointerInit))
      input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
      input.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await expect
      .poll(
        () => titleInput.evaluate((input) => input.isConnected && document.activeElement === input),
        { timeout: 1_000 }
      )
      .toBe(true)

    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
  })

  test('Set Title survives an early blur during first focus handoff', async ({ hivewardPage }) => {
    await openTerminalContextMenu(hivewardPage)
    await hivewardPage.evaluate(() => {
      const blurOnFirstTitleFocus = (event: FocusEvent): void => {
        const target = event.target
        if (
          !(target instanceof HTMLInputElement) ||
          !target.classList.contains('pane-title-input')
        ) {
          return
        }
        document.removeEventListener('focusin', blurOnFirstTitleFocus, true)
        queueMicrotask(() => target.blur())
      }
      document.addEventListener('focusin', blurOnFirstTitleFocus, true)
    })
    await hivewardPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = hivewardPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await hivewardPage.waitForTimeout(250)
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
  })

  test('Set Title survives delayed terminal focus handoffs', async ({ hivewardPage }) => {
    await openTerminalContextMenu(hivewardPage)
    await installDelayedTerminalFocusSteals(hivewardPage, [50, 150, 300])
    await hivewardPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = hivewardPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await hivewardPage.waitForTimeout(600)
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
  })

  test('Set Title survives delayed terminal focus handoffs in a split pane', async ({
    hivewardPage
  }) => {
    await splitActiveTerminalPane(hivewardPage, 'vertical')
    await waitForPaneCount(hivewardPage, 2)

    await openTerminalContextMenu(hivewardPage)
    await installDelayedTerminalFocusSteals(hivewardPage, [50, 150, 300])
    await hivewardPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = hivewardPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await hivewardPage.waitForTimeout(600)
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
  })

  test('Set Title preserves draft text across terminal focus steals', async ({ hivewardPage }) => {
    const draftTitle = `Draft title ${Date.now()}`

    await openTerminalContextMenu(hivewardPage)
    await hivewardPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = hivewardPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await titleInput.fill(draftTitle)

    await hivewardPage.evaluate(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
      textarea?.focus()
    })

    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await expect(titleInput).toHaveValue(draftTitle)
  })

  test('Set Title does not submit when synthetic focus restore fails', async ({ hivewardPage }) => {
    const draftTitle = `Blocked focus title ${Date.now()}`

    await openTerminalContextMenu(hivewardPage)
    await hivewardPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = hivewardPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await titleInput.fill(draftTitle)
    await titleInput.evaluate((input) => {
      input.focus = () => {}
    })

    await hivewardPage.evaluate(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
      textarea?.focus()
    })

    await expect(titleInput).toBeVisible()
    await expect(titleInput).toHaveValue(draftTitle)
    await expect(hivewardPage.locator('.pane-title-text', { hasText: draftTitle })).toHaveCount(0)
  })

  test('Set Title still commits by blur after synthetic terminal focus steals', async ({
    hivewardPage
  }) => {
    const title = `Post steal blur title ${Date.now()}`

    await openTerminalContextMenu(hivewardPage)
    await installDelayedTerminalFocusSteals(hivewardPage, [50, 150])
    await hivewardPage.getByText('Set Title…', { exact: true }).click()

    const titleInput = hivewardPage.locator('.pane-title-input').first()
    await expect(titleInput).toBeVisible()
    await expect(titleInput).toBeFocused()
    await hivewardPage.waitForTimeout(300)
    await titleInput.fill(title)
    await hivewardPage
      .locator('.xterm:visible')
      .first()
      .click({ position: { x: 40, y: 60 } })

    await expect(titleInput).toHaveCount(0)
    await expect(hivewardPage.locator('.pane-title-text', { hasText: title })).toHaveCount(1)
  })
})
