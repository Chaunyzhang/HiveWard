import { readFileSync } from 'node:fs'
import { test, expect } from './helpers/hiveward-app'
import {
  cleanupMarkdownFixture,
  closeActiveEditorTab,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-editor-fixture'
import {
  expectEditableNestedToggles,
  expectFileKeepsNesting,
  expectPassthroughFallback,
  expectSentinelInsideNestedToggle,
  NESTED_TOGGLE_FIXTURE_DIRECTORY,
  NESTED_TOGGLE_MARKDOWN,
  placeCaretInNestedToggleBody,
  UNSUPPORTED_NESTED_TOGGLE_MARKDOWN
} from './helpers/markdown-nested-toggle'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test.describe('Markdown nested toggle regression', () => {
  test.beforeEach(async ({ hivewardPage }) => {
    await waitForSessionReady(hivewardPage)
    await waitForActiveWorktree(hivewardPage)
  })

  test('a plain details block opens as an editable toggle', async ({ hivewardPage }, testInfo) => {
    const context = await getActiveWorktreeContext(hivewardPage)
    let filePath: string | null = null

    try {
      filePath = await createMarkdownFixture(
        context,
        NESTED_TOGGLE_FIXTURE_DIRECTORY,
        'plain-details',
        testInfo.workerIndex,
        '<details>\n<summary>Toggle</summary>\n\nBody\n\n</details>\n'
      )
      await openMarkdownFixture(hivewardPage, context, filePath)
      const editor = await waitForRichMarkdownEditor(hivewardPage)
      const toggle = editor.locator('[data-type="details"]')

      await expect(toggle).toHaveCount(1)
      await expect(toggle.locator('summary')).toHaveText('Toggle')
      await expect(editor.locator('[data-raw-markdown-html-block]')).toHaveCount(0)
      const screenshotPath = testInfo.outputPath('plain-details-rich-editor.png')
      await hivewardPage.screenshot({ path: screenshotPath })
      await testInfo.attach('plain-details-rich-editor', {
        path: screenshotPath,
        contentType: 'image/png'
      })
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })

  test('a nested toggle on disk reopens as editable toggles', async ({ hivewardPage }, testInfo) => {
    const context = await getActiveWorktreeContext(hivewardPage)
    let filePath: string | null = null

    try {
      filePath = await createMarkdownFixture(
        context,
        NESTED_TOGGLE_FIXTURE_DIRECTORY,
        'nested-toggle-reopen',
        testInfo.workerIndex,
        NESTED_TOGGLE_MARKDOWN
      )
      await openMarkdownFixture(hivewardPage, context, filePath)
      await waitForRichMarkdownEditor(hivewardPage)

      await expectEditableNestedToggles(hivewardPage)
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })

  test('editing a nested toggle survives save and reopen', async ({ hivewardPage }, testInfo) => {
    const context = await getActiveWorktreeContext(hivewardPage)
    const sentinel = `editedInsideNestedToggle${Date.now()}`
    let filePath: string | null = null

    try {
      filePath = await createMarkdownFixture(
        context,
        NESTED_TOGGLE_FIXTURE_DIRECTORY,
        'nested-toggle-edit',
        testInfo.workerIndex,
        NESTED_TOGGLE_MARKDOWN
      )
      await openMarkdownFixture(hivewardPage, context, filePath)
      await waitForRichMarkdownEditor(hivewardPage)
      await expectEditableNestedToggles(hivewardPage)

      await placeCaretInNestedToggleBody(hivewardPage)
      await hivewardPage.keyboard.type(` ${sentinel}`)
      await expectSentinelInsideNestedToggle(hivewardPage, sentinel)

      // Save through the real shortcut and assert the bytes that landed on disk.
      await hivewardPage.keyboard.press('ControlOrMeta+S')
      const savedPath = filePath
      await expect
        .poll(() => readFileSync(savedPath, 'utf8'), { timeout: 10_000 })
        .toContain(sentinel)
      expectFileKeepsNesting(readFileSync(savedPath, 'utf8'), sentinel)

      // Reopen the saved bytes from scratch; the reported bug appeared only after reparsing.
      await closeActiveEditorTab(hivewardPage, savedPath)
      await openMarkdownFixture(hivewardPage, context, savedPath)
      await waitForRichMarkdownEditor(hivewardPage)
      await expectEditableNestedToggles(hivewardPage)
      await expectSentinelInsideNestedToggle(hivewardPage, sentinel)
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })

  test('a nested toggle that cannot be represented stays raw passthrough', async ({
    hivewardPage
  }, testInfo) => {
    const context = await getActiveWorktreeContext(hivewardPage)
    let filePath: string | null = null

    try {
      filePath = await createMarkdownFixture(
        context,
        NESTED_TOGGLE_FIXTURE_DIRECTORY,
        'nested-toggle-unsupported',
        testInfo.workerIndex,
        UNSUPPORTED_NESTED_TOGGLE_MARKDOWN
      )
      await openMarkdownFixture(hivewardPage, context, filePath)
      await waitForRichMarkdownEditor(hivewardPage)

      await expectPassthroughFallback(hivewardPage)
    } finally {
      await cleanupMarkdownFixture(filePath)
    }
  })
})
