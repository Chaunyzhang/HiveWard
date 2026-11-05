import { test, expect } from './helpers/hiveward-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { showActivePaneAsNativeChat } from './helpers/native-chat-view'
import { waitForActiveTerminalManager } from './helpers/terminal'

test('typing @ in the chat composer lists workspace files and inserts the chosen one', async ({
  hivewardPage
}, testInfo) => {
  await waitForSessionReady(hivewardPage)
  await waitForActiveWorktree(hivewardPage)
  await ensureTerminalVisible(hivewardPage)
  await waitForActiveTerminalManager(hivewardPage)
  await showActivePaneAsNativeChat(hivewardPage, 'claude', 'Claude')

  const composer = hivewardPage.getByRole('textbox', {
    name: 'Ask anything, @ to mention files, / for commands',
    exact: true
  })
  await expect(composer).toBeVisible()
  await composer.click()

  await hivewardPage.keyboard.type('review @')
  // The sidebar's worktree list is a listbox too.
  const files = hivewardPage.locator('[role="listbox"][id^="native-chat-picker-"]')
  await expect(files.getByRole('option', { name: /README\.md/ })).toBeVisible()
  await hivewardPage.screenshot({ path: testInfo.outputPath('mention-all-files.png') })

  await hivewardPage.keyboard.type('index')
  const match = files.getByRole('option', { name: /index\.ts/ })
  await expect(match).toHaveAttribute('aria-selected', 'true')
  await expect(files.getByRole('option', { name: /README\.md/ })).toHaveCount(0)
  await hivewardPage.screenshot({ path: testInfo.outputPath('mention-filtered.png') })

  await hivewardPage.keyboard.press('Enter')
  await expect(composer).toHaveText('review @src/index.ts ')
  await expect(files).toHaveCount(0)

  await hivewardPage.keyboard.type('@zzz-no-such-file')
  await expect(files).toContainText('No matching files')
  // A one-off app tooltip can be open and takes the first Escape for itself.
  await expect(async () => {
    await hivewardPage.keyboard.press('Escape')
    await expect(files).toHaveCount(0, { timeout: 1000 })
  }).toPass()
  await hivewardPage.keyboard.type('x')
  await expect(composer).toContainText('@zzz-no-such-filex')
  await expect(files).toHaveCount(0)
  await hivewardPage.keyboard.type(' @')
  await expect(files.getByRole('option', { name: /README\.md/ })).toBeVisible()
})
