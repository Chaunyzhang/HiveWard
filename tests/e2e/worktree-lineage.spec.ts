import type { Locator, Page } from '@stablyai/playwright-test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect } from './helpers/hiveward-app'
import { addRepoWithWorkspaces, linkWorkspaces } from './helpers/repo-with-workspaces'
import { SIDEBAR_INPUTS_BUILD } from './helpers/sidebar-inputs-build'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  markWorkspaceTerminalSlept,
  seedLineageScenario,
  seedWorkspaceAgentStatus,
  seedWorkspaceLiveTerminal
} from './worktree-lineage-state'
import { worktreeRow } from './worktree-row-locators'

function worktreeOption(page: Page, worktreeId: string) {
  return worktreeRow(page, worktreeId)
}

async function captureEvidence(page: Page, name: string, locator?: Locator): Promise<void> {
  if (process.env.HIVEWARD_CAPTURE_EVIDENCE !== '1') {
    return
  }
  const outputDir = resolve(process.cwd(), 'pr-evidence')
  mkdirSync(outputDir, { recursive: true })
  const path = resolve(outputDir, name)
  if (locator) {
    await locator.screenshot({ path })
    return
  }
  await page.screenshot({ path })
}

async function captureSidebarEvidence(page: Page, name: string): Promise<void> {
  await captureEvidence(page, name, page.locator('[data-worktree-sidebar]').first())
}

test.describe('Worktree Lineage', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeEach(async ({ hivewardPage }) => {
    await waitForSessionReady(hivewardPage)
    await waitForActiveWorktree(hivewardPage)
  })

  test('renders existing child lineage in the sidebar', async ({ hivewardPage }) => {
    const { parentId, childId } = await seedLineageScenario(hivewardPage)
    const parentRow = worktreeOption(hivewardPage, parentId)
    const childRow = worktreeOption(hivewardPage, childId)

    await expect(parentRow).toBeVisible()
    await parentRow.click()
    await expect(parentRow).toHaveAttribute('aria-current', 'page')

    await expect(childRow).toBeVisible()
    const childToggle = parentRow.getByRole('button', { name: 'Hide 1 child workspace' })
    await expect(childToggle).toBeVisible({ timeout: 10_000 })
    await expect(childRow).toBeVisible()

    const positions = await hivewardPage.evaluate(
      ({ parentId, childId }) => {
        const rowFor = (worktreeId: string) =>
          [...document.querySelectorAll<HTMLElement>('[data-worktree-id]')].find(
            (element) => element.dataset.worktreeId === worktreeId
          )
        const parent = rowFor(parentId)
        const child = rowFor(childId)
        if (!parent || !child) {
          return null
        }
        return {
          parentTop: parent.getBoundingClientRect().top,
          childTop: child.getBoundingClientRect().top
        }
      },
      { parentId, childId }
    )
    expect(positions).not.toBeNull()
    expect(positions!.childTop).toBeGreaterThan(positions!.parentTop)

    await childToggle.click()
    await expect(parentRow.getByRole('button', { name: 'Show 1 child workspace' })).toBeVisible()
    await expect(childRow).toBeHidden()

    await parentRow.getByRole('button', { name: 'Show 1 child workspace' }).click()
    await hivewardPage.evaluate(async (childId) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      // Clear via store to isolate lineage rendering from nested context-menu hit testing.
      await store.getState().updateWorktreeLineage(childId, { noParent: true })
    }, childId)
    await expect
      .poll(
        () =>
          hivewardPage.evaluate((childId) => {
            const store = window.__store
            return Boolean(store?.getState().worktreeLineageById[childId])
          }, childId),
        {
          timeout: 10_000,
          message: 'Child lineage entry did not clear from the store'
        }
      )
      .toBe(false)
    await expect(childRow).toBeVisible()
  })

  test('renders legacy-only inline lineage when side-map hydration is absent', async ({
    hivewardPage
  }) => {
    test.skip(
      SIDEBAR_INPUTS_BUILD,
      "the window's legacy inline link is unused when rows come from main"
    )
    const { parentId, childId } = await seedLineageScenario(hivewardPage, { inlineOnly: true })
    const parentRow = worktreeOption(hivewardPage, parentId)
    const childRow = worktreeOption(hivewardPage, childId)

    await expect(parentRow.getByRole('button', { name: 'Hide 1 child workspace' })).toBeVisible()
    await expect(childRow).toBeVisible()
    await expect
      .poll(async () => {
        const [parentBox, childBox] = await Promise.all([
          parentRow.boundingBox(),
          childRow.boundingBox()
        ])
        return parentBox && childBox ? childBox.y > parentBox.y : false
      })
      .toBe(true)
    // The link must come from the records alone, not a side map hydrated after the seed.
    expect(
      await hivewardPage.evaluate((id) => window.__store!.getState().worktreeLineageById[id], childId)
    ).toBeUndefined()
    await captureSidebarEvidence(hivewardPage, 'legacy-inline-lineage-nested.png')
  })

  test('injects filtered parents structurally without showing a parent badge', async ({
    hivewardPage
  }) => {
    const { parentId, childId } = await seedLineageScenario(hivewardPage)

    await hivewardPage.evaluate(
      ({ parentId, childId }) => {
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is not available')
        }
        store.setState((current) => ({
          worktreesByRepo: Object.fromEntries(
            Object.entries(current.worktreesByRepo).map(([repoId, repoWorktrees]) => [
              repoId,
              repoWorktrees.map((worktree) =>
                worktree.id === parentId
                  ? {
                      ...worktree,
                      branch: worktree.branch || 'refs/heads/main',
                      isMainWorktree: true
                    }
                  : worktree
              )
            ])
          )
        }))
        const state = store.getState()
        state.setHideDefaultBranchWorkspace(true)
        state.setShowActiveOnly(true)
        state.setActiveWorktree(childId)
      },
      { parentId, childId }
    )

    const parentRow = worktreeOption(hivewardPage, parentId)
    const childRow = worktreeOption(hivewardPage, childId)

    await expect(parentRow).toBeVisible()
    await expect(childRow).toBeVisible()
    await expect(childRow).not.toContainText(/\bfrom\b/)

    const positions = await hivewardPage.evaluate(
      ({ parentId, childId }) => {
        const rowFor = (worktreeId: string) =>
          [...document.querySelectorAll<HTMLElement>('[data-worktree-id]')].find(
            (element) => element.dataset.worktreeId === worktreeId
          )
        const parent = rowFor(parentId)
        const child = rowFor(childId)
        if (!parent || !child) {
          return null
        }
        return {
          parentTop: parent.getBoundingClientRect().top,
          childTop: child.getBoundingClientRect().top
        }
      },
      { parentId, childId }
    )
    expect(positions).not.toBeNull()
    expect(positions!.childTop).toBeGreaterThan(positions!.parentTop)
  })

  test('updates nested child preview status when the child terminal sleeps', async ({
    hivewardPage
  }) => {
    const { parentId, childId } = await seedLineageScenario(hivewardPage)
    const parentRow = worktreeOption(hivewardPage, parentId)
    const childRow = worktreeOption(hivewardPage, childId)

    await expect(parentRow).toBeVisible()
    await expect(childRow).toBeVisible()

    const childTabId = await seedWorkspaceLiveTerminal(hivewardPage, childId)
    await expect(childRow).toContainText('Active')

    await markWorkspaceTerminalSlept(hivewardPage, { worktreeId: childId, tabId: childTabId })
    await expect(childRow).toContainText('Inactive')
  })

  test('sleeps a workspace and every descendant from the parent context menu', async ({
    hivewardPage
  }, testInfo) => {
    // A repo's own checkout offers no delete, so the parent is one of its worktrees.
    const repo = await addRepoWithWorkspaces(hivewardPage, testInfo, 2)
    const [parentId, childId] = [repo.ids[0]!, repo.ids[1]!]
    await linkWorkspaces(hivewardPage, [{ childId, parentId }])
    await hivewardPage.evaluate(() => window.__store!.getState().setShowSleepingWorkspaces(true))
    const parentTabId = await seedWorkspaceLiveTerminal(hivewardPage, parentId)
    const childTabId = await seedWorkspaceLiveTerminal(hivewardPage, childId)

    await hivewardPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      store.setState({
        shutdownWorktreeBrowsers: async (worktreeId: string) => {
          store.setState((current) => ({
            browserTabsByWorktree: { ...current.browserTabsByWorktree, [worktreeId]: [] }
          }))
        },
        shutdownWorktreeTerminals: async (worktreeId: string) => {
          const tabIds = (store.getState().tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
          store.setState((current) => ({
            ptyIdsByTabId: {
              ...current.ptyIdsByTabId,
              ...Object.fromEntries(tabIds.map((tabId) => [tabId, []]))
            }
          }))
        }
      })
    })

    await worktreeOption(hivewardPage, parentId).click({ button: 'right' })
    const sleepSubtree = hivewardPage.getByRole('menuitem', {
      name: 'Sleep with Descendants (1)'
    })
    await expect(sleepSubtree).toBeVisible()
    await expect(sleepSubtree).toBeEnabled()
    await expect(hivewardPage.getByRole('menuitem', { name: 'Delete with Descendants…' })).toBeVisible()
    await captureEvidence(hivewardPage, 'workspace-descendant-actions.png')
    await sleepSubtree.click()

    await expect
      .poll(() =>
        hivewardPage.evaluate(
          ({ parentTabId, childTabId }) => {
            const state = window.__store?.getState()
            return {
              parentPtys: state?.ptyIdsByTabId[parentTabId],
              childPtys: state?.ptyIdsByTabId[childTabId]
            }
          },
          { parentTabId, childTabId }
        )
      )
      .toEqual({ parentPtys: [], childPtys: [] })
  })

  test('shows parent and child agent rows while the parent workspace is active', async ({
    hivewardPage
  }) => {
    const { parentId, childId } = await seedLineageScenario(hivewardPage)
    const parentRow = worktreeOption(hivewardPage, parentId)
    const childRow = worktreeOption(hivewardPage, childId)

    await parentRow.click()
    await expect(parentRow).toHaveAttribute('aria-current', 'page')
    await expect(childRow).toBeVisible()

    const parentAgentPrompt = await seedWorkspaceAgentStatus(hivewardPage, parentId, 'PARENT')
    const childAgentPrompt = await seedWorkspaceAgentStatus(hivewardPage, childId, 'CHILD')

    await expect(
      parentRow.getByRole('treeitem').filter({ hasText: parentAgentPrompt })
    ).toBeVisible()
    await expect(childRow.getByRole('treeitem').filter({ hasText: childAgentPrompt })).toBeVisible()
  })
})
