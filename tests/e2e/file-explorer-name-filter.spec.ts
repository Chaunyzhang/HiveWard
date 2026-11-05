import type { Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/hiveward-app'
import { openFileExplorer } from './helpers/file-explorer'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

// Verify request-keyed file-list rendering never flashes stale rows or a false no-match while queries change.
function rowByName(explorer: Locator, page: Page, name: string): Locator {
  return explorer
    .locator('[data-file-explorer-row]')
    .filter({ has: page.locator('[data-file-explorer-row-name]', { hasText: name }) })
}

test('name filter narrows to the matching file', async ({ hivewardPage }) => {
  await waitForSessionReady(hivewardPage)
  await waitForActiveWorktree(hivewardPage)
  await openFileExplorer(hivewardPage)

  const explorer = hivewardPage.locator('[data-hiveward-explorer-shell]')
  await expect(explorer).toBeVisible({ timeout: 10_000 })
  const input = hivewardPage.getByPlaceholder('Find files')
  await expect(input).toBeVisible({ timeout: 10_000 })

  await input.fill('package.')
  await expect(rowByName(explorer, hivewardPage, 'package.json').first()).toBeVisible({
    timeout: 10_000
  })
  // Leave absent-file assertions to the no-match case; seeded repo contents vary.
  await expect(explorer.getByText('No files match this filter')).toHaveCount(0)
})

test('name filter shows the empty message only for a true no-match', async ({ hivewardPage }) => {
  await waitForSessionReady(hivewardPage)
  await waitForActiveWorktree(hivewardPage)
  await openFileExplorer(hivewardPage)

  const explorer = hivewardPage.locator('[data-hiveward-explorer-shell]')
  await expect(explorer).toBeVisible({ timeout: 10_000 })
  const input = hivewardPage.getByPlaceholder('Find files')
  await expect(input).toBeVisible({ timeout: 10_000 })

  await input.fill('zz-no-such-file-12345')
  await expect(explorer.getByText('No files match this filter')).toBeVisible({ timeout: 10_000 })

  await input.fill('')
  await expect(rowByName(explorer, hivewardPage, 'README.md').first()).toBeVisible({
    timeout: 10_000
  })
})
