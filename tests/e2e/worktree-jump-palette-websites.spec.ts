import { expect, test } from './helpers/hiveward-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { startBrowserLinkServer } from './helpers/browser-link-server'

for (const theme of ['light', 'dark'] as const) {
  test(`Cmd+J offers a website first and opens it with Enter (${theme})`, async ({
    hivewardPage,
    electronApp
  }, testInfo) => {
    await waitForSessionReady(hivewardPage)
    await waitForActiveWorktree(hivewardPage)
    await hivewardPage.evaluate(async (theme) => {
      const state = window.__store!.getState()
      await state.updateSettingsOrThrow({ theme })
      state.openModal('worktree-palette')
    }, theme)
    const palette = hivewardPage.getByRole('dialog', { name: 'Jump to...' })
    const input = palette.locator('[cmdk-input]')
    const website = palette.locator('[cmdk-item][data-value="quick-action:navigate-to-url"]')
    await input.fill('brex.com')
    await expect(website).toContainText('Go to brex.com')
    await expect(website).toContainText('Open in a new browser tab')
    await expect(website).toHaveAttribute('data-selected', 'true')
    await expect(palette.locator('[cmdk-item]').first()).toContainText('Go to brex.com')
    const screenshot = testInfo.outputPath(`website-palette-${theme}.png`)
    await palette.screenshot({ path: screenshot, animations: 'disabled' })
    await testInfo.attach(`website-palette-${theme}`, {
      path: screenshot,
      contentType: 'image/png'
    })

    await input.fill('brex login')
    await expect(website).toHaveCount(0)

    await input.fill('readthedocs.io')
    await expect(website).toContainText('Go to readthedocs.io')
    await expect(website).toHaveAttribute('data-selected', 'true')

    await hivewardPage.evaluate(() => {
      window.__store!.setState((state) => ({
        worktreesByRepo: Object.fromEntries(
          Object.entries(state.worktreesByRepo).map(([repoId, worktrees]) => [
            repoId,
            worktrees.map((worktree) =>
              worktree.id === state.activeWorktreeId
                ? { ...worktree, displayName: 'project.dev server' }
                : worktree
            )
          ])
        )
      }))
    })
    await input.fill('project.dev')
    await expect(palette.locator('[cmdk-item]').first()).toContainText('Go to project.dev')
    await expect(website).toHaveAttribute('data-selected', 'true')

    const server = await startBrowserLinkServer()
    try {
      const address = server.sourceUrl.replace('http://', '')
      await input.fill(address)
      await expect(website).toContainText(`Go to ${address}`)
      await expect(website).toHaveAttribute('data-selected', 'true')
      await input.press('Enter')
      await expect(palette).toHaveCount(0)
      await expect(
        hivewardPage.locator('[data-hiveward-browser-address-bar="true"]').filter({ visible: true })
      ).toHaveValue(server.sourceUrl)
      await expect(
        hivewardPage.locator('[data-tab-id]').filter({ hasText: 'Source page' }).first()
      ).toBeVisible()
      expect(
        await electronApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every((window) => !window.isVisible())
        )
      ).toBe(true)
    } finally {
      await server.close()
    }
  })
}
