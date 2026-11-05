import type { Page } from '@stablyai/playwright-test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect } from './helpers/hiveward-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { seedLineageScenario } from './worktree-lineage-state'
import { worktreeRow } from './worktree-row-locators'

// HIVEWARD_CAPTURE_EVIDENCE=1 writes before/after screenshots to pr-evidence/; default CI runs behavioral assertions only.
const CAPTURE_EVIDENCE = process.env.HIVEWARD_CAPTURE_EVIDENCE === '1'
const SHOT_DIR = resolve(process.cwd(), 'pr-evidence')

async function captureSidebar(page: Page, name: string): Promise<void> {
  if (!CAPTURE_EVIDENCE) {
    return
  }
  mkdirSync(SHOT_DIR, { recursive: true })
  await sidebar(page).screenshot({ path: resolve(SHOT_DIR, name) })
}

// Seed two parent agents for the compact summary alongside the child-workspace chip.
async function seedTwoParentAgents(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate((worktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    if (!state.worktreeCardProperties.includes('inline-agents')) {
      state.setWorktreeCardProperties([...state.worktreeCardProperties, 'inline-agents'])
    }
    while ((store.getState().tabsByWorktree[worktreeId] ?? []).length < 2) {
      store.getState().createTab(worktreeId)
    }
    const tabs = (store.getState().tabsByWorktree[worktreeId] ?? []).slice(0, 2)
    const now = Date.now()
    const specs = [
      { state: 'working' as const, prompt: 'Refactor auth middleware', agentType: 'claude' },
      { state: 'done' as const, prompt: 'Write unit tests for parser', agentType: 'codex' }
    ]
    tabs.forEach((tab, index) => {
      const spec = specs[index]!
      const leafId = crypto.randomUUID()
      store
        .getState()
        .setAgentStatus(
          `${tab.id}:${leafId}`,
          { state: spec.state, prompt: spec.prompt, agentType: spec.agentType },
          spec.agentType,
          { updatedAt: now, stateStartedAt: now }
        )
    })
  }, worktreeId)
}

function sidebar(page: Page) {
  return page.locator('[data-worktree-sidebar]').first()
}

function compactSummary(page: Page, parentId: string) {
  return worktreeRow(page, parentId).locator('button.compact-agent-summary-button').first()
}

function childWorkspacesChip(page: Page, parentId: string) {
  return worktreeRow(page, parentId)
    .getByRole('button', { name: /child workspace/i })
    .first()
}

test.describe('Worktree lineage agent-list expansion independence', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeEach(async ({ hivewardPage }) => {
    await waitForSessionReady(hivewardPage)
    await waitForActiveWorktree(hivewardPage)
  })

  test('toggling child worktrees does not collapse the expanded agent summary', async ({
    hivewardPage
  }) => {
    const { parentId, childId } = await seedLineageScenario(hivewardPage)
    const parentRow = worktreeRow(hivewardPage, parentId)
    const childRow = worktreeRow(hivewardPage, childId)

    await parentRow.click()
    await expect(parentRow).toHaveAttribute('aria-current', 'page')

    await seedTwoParentAgents(hivewardPage, parentId)

    await expect(compactSummary(hivewardPage, parentId)).toBeVisible({ timeout: 10_000 })
    await expect(childWorkspacesChip(hivewardPage, parentId)).toBeVisible()
    await expect(childRow).toBeVisible()
    await expect(compactSummary(hivewardPage, parentId)).toHaveAttribute('aria-expanded', 'false')
    await captureSidebar(hivewardPage, '1-before-both-collapsed.png')

    await compactSummary(hivewardPage, parentId).click()
    await expect(compactSummary(hivewardPage, parentId)).toHaveAttribute('aria-expanded', 'true')
    await captureSidebar(hivewardPage, '2-agents-expanded.png')

    // Collapse children to remount the parent card; require expanded agent summary to survive.
    await childWorkspacesChip(hivewardPage, parentId).click()
    await expect(childRow).toBeHidden()

    await expect(compactSummary(hivewardPage, parentId)).toHaveAttribute('aria-expanded', 'true')
    await captureSidebar(hivewardPage, '3-after-children-toggle-agents-still-expanded.png')
  })
})
