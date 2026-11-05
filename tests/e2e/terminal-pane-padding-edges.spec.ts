import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/hiveward-app'
import { ensureTerminalVisible } from './helpers/store'
import { waitForActiveTerminalManager } from './helpers/terminal'
import { setPaneTitleFromTerminalMenu } from './helpers/terminal-pane-title-actions'

function readTerminalInsets(
  page: Page
): Promise<Record<'left' | 'right' | 'top' | 'bottom', number>> {
  return page
    .locator('.xterm:visible')
    .first()
    .evaluate((xterm) => {
      const container = xterm.closest('.xterm-container')
      const pane = xterm.closest('.pane')
      if (!container || !pane) {
        throw new Error('No visible terminal pane found')
      }
      const outer = pane.getBoundingClientRect()
      const inner = container.getBoundingClientRect()
      return {
        left: Math.round(inner.left - outer.left),
        right: Math.round(outer.right - inner.right),
        top: Math.round(inner.top - outer.top),
        bottom: Math.round(outer.bottom - inner.bottom)
      }
    })
}

test('terminal padding insets both edges of each axis', async ({ hivewardPage }) => {
  await ensureTerminalVisible(hivewardPage, 30_000)
  await waitForActiveTerminalManager(hivewardPage, 30_000)
  await hivewardPage.evaluate(async () => {
    await window.__store?.getState().updateSettings({ terminalPaddingX: 40, terminalPaddingY: 20 })
  })

  await expect
    .poll(() => readTerminalInsets(hivewardPage))
    .toEqual({ left: 40, right: 40, top: 20, bottom: 20 })

  // A pane title replaces the top padding but must keep the bottom inset.
  await setPaneTitleFromTerminalMenu(hivewardPage, 'Padding check')
  await expect
    .poll(() => readTerminalInsets(hivewardPage))
    .toEqual({ left: 40, right: 40, top: 24, bottom: 20 })
})
