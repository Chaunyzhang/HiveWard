import { test, expect } from './helpers/hiveward-app'
import {
  activateGoldenWorktree,
  cleanupGoldenWorktree,
  createGoldenWorktree
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

test('preserves highlighted editor text across worktree tab switches', async ({
  hivewardPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = createGoldenWorktree(testRepoPath, 'editor-selection')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))

  await waitForSessionReady(hivewardPage)
  await activateGoldenWorktree(hivewardPage, testRepoPath, fixture.worktreePath)
  await hivewardPage.evaluate(() => {
    const state = window.__store?.getState()
    state?.setRightSidebarTab('explorer')
    state?.setRightSidebarOpen(true)
  })

  const explorer = hivewardPage.locator('[data-hiveward-explorer-shell]')
  const rowNamed = (name: string) =>
    explorer.locator('[data-file-explorer-row]').filter({
      has: hivewardPage.locator('[data-file-explorer-row-name]').getByText(name, { exact: true })
    })

  await rowNamed('package.json').dblclick()
  const monaco = hivewardPage.locator('.monaco-editor').first()
  await expect(monaco).toBeVisible({ timeout: 25_000 })
  await monaco.click()
  await hivewardPage.keyboard.press('ControlOrMeta+f')
  const findInput = monaco.locator('.find-widget .input[aria-label="Find"]')
  await expect(findInput).toBeVisible()
  await findInput.fill('hiveward-e2e-test')
  await hivewardPage.keyboard.press('Enter')
  await hivewardPage.keyboard.press('Escape')

  await expect
    .poll(() => hivewardPage.evaluate(() => window.__monacoEditorE2E?.snapshot().selection ?? null), {
      message: 'Monaco did not select the searched text'
    })
    .not.toBeNull()
  const selectedRange = await hivewardPage.evaluate(
    () => window.__monacoEditorE2E?.snapshot().selection ?? null
  )
  if (!selectedRange) {
    throw new Error('Monaco selection disappeared before the tab switch')
  }
  expect([selectedRange.selectionStartLineNumber, selectedRange.selectionStartColumn]).not.toEqual([
    selectedRange.positionLineNumber,
    selectedRange.positionColumn
  ])
  if (process.env.HIVEWARD_E2E_RECORD_VIDEO === '1') {
    await hivewardPage.waitForTimeout(700)
  }

  await rowNamed('src').click()
  await rowNamed('index.ts').click()
  await expect(hivewardPage.locator('.editor-header-path').first()).toContainText('index.ts', {
    timeout: 20_000
  })

  await hivewardPage.locator('[data-tab-id]').filter({ hasText: 'package.json' }).last().click()
  await expect(hivewardPage.locator('.editor-header-path').first()).toContainText('package.json', {
    timeout: 20_000
  })
  await expect
    .poll(() => hivewardPage.evaluate(() => window.__monacoEditorE2E?.snapshot().selection ?? null))
    .toEqual(selectedRange)
  await expect(monaco.locator('.selected-text').first()).toBeVisible()
  if (process.env.HIVEWARD_E2E_RECORD_VIDEO === '1') {
    await hivewardPage.waitForTimeout(700)
  }
})
