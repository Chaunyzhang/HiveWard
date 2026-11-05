import { test, expect } from './helpers/hiveward-app'
import { waitForSessionReady } from './helpers/store'

test.describe('Settings sidebar search on the Shortcuts pane', () => {
  test('pane-title-only query keeps rows visible and local search usable', async ({ hivewardPage }) => {
    await waitForSessionReady(hivewardPage)

    await hivewardPage.evaluate(async () => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      // Pin English instead of following the host locale.
      await store.getState().updateSettings({ uiLanguage: 'en' })
      store.getState().openSettingsPage()
    })

    const searchInput = hivewardPage.getByPlaceholder('Search settings')
    await expect(searchInput).toBeVisible()
    await expect(searchInput).toBeFocused()
    await searchInput.fill('shortcuts')

    await expect(hivewardPage.getByRole('heading', { name: 'Shortcuts', exact: true })).toBeVisible()

    // Regression: a pane-title-only query used to blank the whole list (0/112).
    await expect(hivewardPage.getByText('Go to File', { exact: true })).toBeVisible()
    await expect(hivewardPage.getByText('No shortcuts match those filters.')).not.toBeVisible()

    // Keep pane search working with a global query; the old empty base list broke their intersection.
    const localSearch = hivewardPage.getByPlaceholder('Search command or keys')
    await localSearch.fill('go to')
    await expect(hivewardPage.getByText('Go to File', { exact: true })).toBeVisible()
    await expect(hivewardPage.getByText('Force Reload', { exact: true })).not.toBeVisible()

    await localSearch.clear()
    await searchInput.fill('worktree')
    await expect(hivewardPage.getByText('Create worktree', { exact: true })).toBeVisible()
    await expect(hivewardPage.getByText('Go to File', { exact: true })).not.toBeVisible()
  })
})
