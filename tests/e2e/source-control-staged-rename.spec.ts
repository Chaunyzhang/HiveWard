import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/hiveward-app'
import {
  cleanupGoldenWorktree,
  createGoldenWorktree,
  GOLDEN_CHANGED_PATH,
  GOLDEN_REMOVED_LINE,
  openGoldenSourceControl
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

const RENAMED_PATH = 'src/renamed.ts'
const EDITED_LINE = 'export const hello = "renamed and edited"'

test('shows the source version when reviewing a staged rename', async ({
  hivewardPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = createGoldenWorktree(testRepoPath, 'staged-rename')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  const source = path.join(fixture.worktreePath, GOLDEN_CHANGED_PATH)
  const content = readFileSync(source, 'utf8')
  writeFileSync(
    source,
    `${content}\n${Array.from({ length: 12 }, (_, i) => `export const stable${i} = ${i}`).join('\n')}\n`
  )
  execFileSync('git', ['add', '--', GOLDEN_CHANGED_PATH], { cwd: fixture.worktreePath })
  execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=.git/no-hooks',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'Seed rename context'
    ],
    { cwd: fixture.worktreePath }
  )
  execFileSync('git', ['mv', GOLDEN_CHANGED_PATH, RENAMED_PATH], { cwd: fixture.worktreePath })
  const renamed = path.join(fixture.worktreePath, RENAMED_PATH)
  writeFileSync(renamed, readFileSync(renamed, 'utf8').replace(GOLDEN_REMOVED_LINE, EDITED_LINE))
  execFileSync('git', ['add', '--', RENAMED_PATH], { cwd: fixture.worktreePath })

  await waitForSessionReady(hivewardPage)
  await openGoldenSourceControl(hivewardPage, testRepoPath, fixture)
  const row = hivewardPage
    .locator('[data-testid="source-control-entry"][data-source-control-area="staged"]')
    .filter({ hasText: 'renamed.ts' })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()
  await expect(hivewardPage.locator('.monaco-diff-editor')).toBeVisible({ timeout: 20_000 })
  await expect(
    hivewardPage.locator('.modified-in-monaco-diff-editor .view-line').filter({ hasText: EDITED_LINE })
  ).toBeVisible()
  await expect(
    hivewardPage
      .locator('.original-in-monaco-diff-editor .view-line')
      .filter({ hasText: GOLDEN_REMOVED_LINE })
  ).toBeVisible()
})
