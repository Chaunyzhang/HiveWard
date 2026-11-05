import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/hiveward-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import { waitForPtyShellEcho } from './terminal-pty-readiness'
import {
  claudeTranscriptLines,
  seedClaudeProviderSession,
  toggleTerminalTabToChatView
} from './helpers/native-chat-transcript-fixture'

test.use({ hivewardAppExtraEnv: { HIVEWARD_BACKGROUND_LAUNCH: '1' } })

const sourceImage = path.resolve(
  __dirname,
  '..',
  '..',
  'docs',
  'site',
  'public',
  'docs',
  'ways-to-run-run-on.png'
)

function transcript(sessionId: string, imagePath: string): string {
  return claudeTranscriptLines({
    sessionId,
    userText: 'Show the inline image preview.',
    assistantText: [
      'The table uses the actual local image source:',
      '',
      '| Preview | Details |',
      '| --- | --- |',
      `| ![Inline chat screenshot](${imagePath}) | [Ordinary file link](${imagePath}) |`
    ].join('\n')
  })
}

test('opens a native-chat Markdown table image in the image dialog without a file popup', async ({
  electronApp,
  hivewardPage,
  testRepoPath
}, testInfo) => {
  expect(existsSync(sourceImage)).toBe(true)
  const imagePath = path.join(testRepoPath, `inline-chat-preview-${randomUUID()}.png`)
  const sessionId = `e2e-inline-image-${randomUUID()}`
  const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'hiveward-e2e-inline-image-'))
  const transcriptPath = path.join(scratchDir, `${sessionId}.jsonl`)
  copyFileSync(sourceImage, imagePath)

  try {
    await waitForSessionReady(hivewardPage)
    await waitForActiveWorktree(hivewardPage)
    await ensureTerminalVisible(hivewardPage)
    await waitForActiveTerminalManager(hivewardPage)
    const boundPane = await waitForPaneIdentitySnapshot(hivewardPage, 1)
    const ptyId = await waitForActivePanePtyId(hivewardPage)
    await waitForPtyShellEcho(hivewardPage, ptyId, 15_000)
    const descriptor = await waitForActivePaneHookDescriptor(hivewardPage)
    expect(descriptor.paneKey).toBe(`${boundPane.tabId}:${boundPane.activeLeafId}`)
    const [tabId] = descriptor.paneKey.split(':')
    writeFileSync(transcriptPath, transcript(sessionId, imagePath))
    await hivewardPage.evaluate(async () => {
      await window.__store?.getState().updateSettings({ terminalLinkClickBehavior: 'actions' })
    })
    await seedClaudeProviderSession(hivewardPage, {
      paneKey: descriptor.paneKey,
      worktreeId: descriptor.worktreeId,
      sessionId,
      transcriptPath
    })
    await toggleTerminalTabToChatView(hivewardPage, { tabId, worktreeId: descriptor.worktreeId })

    const chat = hivewardPage.locator('[data-native-chat-root="true"]')
    const image = chat.getByRole('button', { name: 'View image: Inline chat screenshot' })
    await expect(image).toBeVisible({ timeout: 30_000 })
    const ordinaryFileLink = chat.getByRole('link', { name: 'Ordinary file link' })
    await expect(ordinaryFileLink).toBeVisible()
    await chat
      .locator('table')
      .screenshot({ path: testInfo.outputPath('01-table-image-light.png') })

    await ordinaryFileLink.click()
    const ordinaryFilePopup = hivewardPage.locator('[data-link-action-popover]')
    await expect(ordinaryFilePopup).toBeVisible()
    await expect(ordinaryFilePopup).toContainText(imagePath)
    await expect(ordinaryFilePopup.getByRole('button', { name: 'Open file' })).toBeVisible()
    await ordinaryFilePopup.screenshot({
      path: testInfo.outputPath('02-ordinary-file-popup-light.png')
    })
    await hivewardPage.keyboard.press('Escape')
    await expect(ordinaryFilePopup).toHaveCount(0)
    await expect(ordinaryFileLink).toBeFocused()

    await image.click()
    const dialog = hivewardPage.getByRole('dialog', { name: 'Inline chat screenshot' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('img', { name: 'Inline chat screenshot' })).toBeVisible()
    await expect(ordinaryFilePopup).toHaveCount(0)
    await expect(hivewardPage.getByRole('menu')).toHaveCount(0)
    await dialog.screenshot({ path: testInfo.outputPath('03-image-dialog-light.png') })

    const zoomIn = dialog.getByRole('button', { name: 'Zoom in' })
    await expect(zoomIn).toBeEnabled()
    await zoomIn.click()
    await expect(dialog.getByRole('button', { name: 'Fit to screen' })).toBeEnabled()
    const actions = dialog.getByRole('button', { name: 'File actions' })
    await expect(actions).toBeVisible()
    await actions.click()
    await expect(hivewardPage.getByRole('menu')).toBeVisible()
    await dialog.screenshot({ path: testInfo.outputPath('04-image-dialog-actions-light.png') })
    await hivewardPage.keyboard.press('Escape')
    await expect(hivewardPage.getByRole('menu')).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(image).toBeFocused()

    await image.focus()
    await hivewardPage.keyboard.press('Enter')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(image).toBeFocused()

    await image.focus()
    await hivewardPage.keyboard.press('Space')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(image).toBeFocused()

    await hivewardPage.evaluate(() => document.documentElement.classList.add('dark'))
    await image.click()
    await expect(dialog).toBeVisible()
    await dialog.screenshot({ path: testInfo.outputPath('05-image-dialog-dark.png') })
    await hivewardPage.setViewportSize({ width: 480, height: 560 })
    await expect(dialog).toBeVisible()
    await dialog.screenshot({ path: testInfo.outputPath('06-image-dialog-dark-narrow.png') })
    await hivewardPage.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    const windows = await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({
        visible: window.isVisible(),
        focused: window.isFocused()
      }))
    )
    expect(windows.length).toBeGreaterThan(0)
    expect(windows.every((window) => !window.visible && !window.focused)).toBe(true)
    const finalPane = await waitForPaneIdentitySnapshot(hivewardPage, 1)
    expect(finalPane.tabId).toBe(boundPane.tabId)
    expect(finalPane.activeLeafId).toBe(boundPane.activeLeafId)
    expect(finalPane.ptyIdsByLeafId).toEqual(boundPane.ptyIdsByLeafId)
    expect(
      await hivewardPage.evaluate(
        ({ worktreeId, tabId, leafId }) => {
          const state = window.__store?.getState()
          const tab = state?.unifiedTabsByWorktree[worktreeId]?.find(
            (candidate) => candidate.contentType === 'terminal' && candidate.entityId === tabId
          )
          return Boolean(
            leafId &&
            tab?.viewMode === 'chat' &&
            state?.terminalLayoutsByTabId[tabId]?.chatLeafId === leafId
          )
        },
        {
          worktreeId: descriptor.worktreeId,
          tabId: boundPane.tabId,
          leafId: boundPane.activeLeafId
        }
      )
    ).toBe(true)
    await expect(chat).toBeAttached()
  } finally {
    rmSync(imagePath, { force: true })
    rmSync(scratchDir, { recursive: true, force: true })
  }
})
