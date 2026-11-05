import { test, expect } from './helpers/hiveward-app'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  getActiveTabType,
  getOpenFiles,
  ensureTerminalVisible
} from './helpers/store'
import { clickFileInExplorer, openFileExplorer } from './helpers/file-explorer'

async function switchToTerminal(
  page: Parameters<typeof getActiveWorktreeId>[0],
  worktreeId: string
): Promise<void> {
  await page.evaluate((targetWorktreeId) => {
    const store = window.__store
    if (!store) {
      return
    }

    const state = store.getState()
    const terminalTab = (state.tabsByWorktree[targetWorktreeId] ?? [])[0]
    if (terminalTab) {
      state.setActiveTab(terminalTab.id)
    }
    state.setActiveTabType('terminal', store.getState().activeWorktreeId)
  }, worktreeId)
}

async function switchToEditor(
  page: Parameters<typeof getActiveWorktreeId>[0],
  fileId: string
): Promise<void> {
  await page.evaluate((targetFileId) => {
    const store = window.__store
    if (!store) {
      return
    }

    const state = store.getState()
    if (state.openFiles.some((file) => file.id === targetFileId)) {
      state.setActiveFile(targetFileId)
      state.setActiveTabType('editor', store.getState().activeWorktreeId)
    }
  }, fileId)
}

test.describe('File Open & Markdown Preview', () => {
  test.beforeEach(async ({ hivewardPage }) => {
    await waitForSessionReady(hivewardPage)
    await waitForActiveWorktree(hivewardPage)
    await ensureTerminalVisible(hivewardPage)
  })

  test('opening the right sidebar shows file explorer', async ({ hivewardPage }) => {
    await openFileExplorer(hivewardPage)

    // Assert the rendered explorer shell; store selection alone cannot detect mount failure.
    await expect(hivewardPage.locator('[data-hiveward-explorer-shell]')).toBeVisible({ timeout: 5_000 })
  })

  test('clicking a file in the file explorer opens it in an editor tab', async ({ hivewardPage }) => {
    const worktreeId = (await getActiveWorktreeId(hivewardPage))!
    await openFileExplorer(hivewardPage)

    const filesBefore = await getOpenFiles(hivewardPage, worktreeId)

    const clickedFile = await clickFileInExplorer(hivewardPage, [
      'package.json',
      'tsconfig.json',
      '.gitignore',
      'README.md'
    ])
    expect(clickedFile).not.toBeNull()

    await expect.poll(async () => getActiveTabType(hivewardPage), { timeout: 5_000 }).toBe('editor')

    await expect
      .poll(async () => (await getOpenFiles(hivewardPage, worktreeId)).length, { timeout: 5_000 })
      .toBeGreaterThan(filesBefore.length)

    // Assert the rendered path; allow first-open lazy EditorPanel/Monaco/Markdown chunks to mount.
    await expect(hivewardPage.locator('.editor-header-path').first()).toContainText(clickedFile!, {
      timeout: 20_000
    })
  })

  test('opening a .md file shows markdown content', async ({ hivewardPage }) => {
    await openFileExplorer(hivewardPage)
    const clickedFile = await clickFileInExplorer(hivewardPage, ['README.md', 'CLAUDE.md'])
    expect(clickedFile).not.toBeNull()

    await expect.poll(async () => getActiveTabType(hivewardPage), { timeout: 5_000 }).toBe('editor')

    // Assert the file’s real heading so a blank editor cannot pass via store state.
    const expectedHeading = clickedFile?.endsWith('README.md')
      ? /HiveWard E2E Test Repo/i
      : /CLAUDE\.md/i
    // Allow cold EditorPanel → Markdown chunk loading and ProseMirror boot before the heading paints.
    await expect(hivewardPage.getByRole('heading', { name: expectedHeading, level: 1 })).toBeVisible({
      timeout: 25_000
    })
  })

  test('editor tab retains state when switching to terminal and back', async ({ hivewardPage }) => {
    const worktreeId = (await getActiveWorktreeId(hivewardPage))!
    await openFileExplorer(hivewardPage)

    const clickedFile = await clickFileInExplorer(hivewardPage, [
      'package.json',
      'tsconfig.json',
      '.gitignore'
    ])
    expect(clickedFile).not.toBeNull()

    await expect.poll(async () => getActiveTabType(hivewardPage), { timeout: 5_000 }).toBe('editor')

    const openFilesBefore = await getOpenFiles(hivewardPage, worktreeId)
    expect(openFilesBefore.length).toBeGreaterThan(0)

    const editorFileId = openFilesBefore[0].id

    await switchToTerminal(hivewardPage, worktreeId)
    await expect.poll(async () => getActiveTabType(hivewardPage), { timeout: 3_000 }).not.toBe('editor')

    await switchToEditor(hivewardPage, editorFileId)
    await expect.poll(async () => getActiveTabType(hivewardPage), { timeout: 3_000 }).toBe('editor')

    const openFilesAfter = await getOpenFiles(hivewardPage, worktreeId)
    expect(openFilesAfter.length).toBe(openFilesBefore.length)
    expect(openFilesAfter[0].filePath).toBe(openFilesBefore[0].filePath)
  })
})
