import { test, expect } from './helpers/hiveward-app'
import { getStoreState, waitForSessionReady } from './helpers/store'

test.describe('Feature tour modal', () => {
  test.beforeEach(async ({ hivewardPage }) => {
    await waitForSessionReady(hivewardPage)
  })

  test('opens and renders the workflow rail', async ({ hivewardPage }) => {
    await hivewardPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      store.getState().openModal('feature-wall', { source: 'help_menu' })
    })

    await expect(hivewardPage.getByRole('dialog', { name: 'Get to know HiveWard' })).toBeVisible({
      timeout: 10_000
    })

    const rail = hivewardPage.getByRole('navigation', { name: 'Workflows' })
    await expect(rail.getByRole('tab')).toHaveCount(5)
    await expect(rail.getByRole('tab', { name: /Workspaces/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    await expect(hivewardPage.locator('[data-ws-id]')).toHaveCount(3)

    await rail.getByRole('tab', { name: /Workspaces/i }).focus()
    await hivewardPage.keyboard.press('ArrowDown')
    await expect(rail.getByRole('tab', { name: /Tasks/i })).toHaveAttribute('aria-selected', 'true')
    await hivewardPage.keyboard.press('ArrowDown')
    await expect(rail.getByRole('tab', { name: /Agents/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    await rail.getByRole('tab', { name: /Workbench/i }).click()
    await rail.getByRole('button', { name: /Browser/i }).click()
    await expect(
      hivewardPage.getByText(
        "Run your app in HiveWard's browser, send selected UI elements to agents, and let your agents interact with your webpage."
      )
    ).toBeVisible()
    await expect(hivewardPage.getByRole('heading', { name: 'Browser Use skill' })).toBeVisible()
    await expect(
      hivewardPage.getByText("Enables agents to navigate and verify pages in HiveWard's browser.")
    ).toBeVisible()
    await expect(hivewardPage.getByRole('heading', { name: 'CLI skill' })).toHaveCount(0)
    await expect(hivewardPage.getByText('With the HiveWard CLI skill', { exact: false })).toHaveCount(0)
  })

  test('shows unified task copy without leaving the walkthrough', async ({ hivewardPage }) => {
    await hivewardPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      store.setState({
        preflightStatus: {
          git: { installed: true },
          gh: { installed: true, authenticated: false },
          glab: { installed: false, authenticated: false },
          bitbucket: { configured: false, authenticated: false, account: null },
          azureDevOps: {
            configured: false,
            authenticated: false,
            account: null,
            baseUrl: null,
            tokenConfigured: false
          },
          gitea: {
            configured: false,
            authenticated: false,
            account: null,
            baseUrl: null,
            tokenConfigured: false
          }
        },
        preflightStatusChecked: true,
        preflightStatusLoading: false,
        linearStatus: { connected: false, viewer: null },
        linearStatusChecked: true
      })
      store.getState().openModal('feature-wall', { source: 'help_menu' })
    })

    await expect(hivewardPage.getByRole('dialog', { name: 'Get to know HiveWard' })).toBeVisible({
      timeout: 10_000
    })
    await hivewardPage
      .getByRole('navigation', { name: 'Workflows' })
      .getByRole('tab', { name: /Tasks/i })
      .click()
    await expect(hivewardPage.getByText('Start work directly from GitHub or Linear.')).toBeVisible()
    await expect(hivewardPage.getByText('Connect GitHub or Linear once')).toHaveCount(0)
    await expect(hivewardPage.getByRole('dialog', { name: 'Get to know HiveWard' })).toBeVisible()
    await expect
      .poll(async () => getStoreState<string>(hivewardPage, 'activeView'))
      .not.toBe('settings')
  })

  test('continue advances through workflow substeps before the next workflow', async ({
    hivewardPage
  }) => {
    await hivewardPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      store.getState().openModal('feature-wall', { source: 'help_menu' })
    })

    const rail = hivewardPage.getByRole('navigation', { name: 'Workflows' })
    const continueButton = hivewardPage.getByRole('button', { name: /^Continue/ })

    await continueButton.click()
    await expect(rail.getByRole('tab', { name: /Tasks/i })).toHaveAttribute('aria-selected', 'true')

    await continueButton.click()
    await expect(rail.getByRole('tab', { name: /Agents/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await expect(rail.getByRole('button', { name: /Visibility/i })).toHaveAttribute(
      'aria-current',
      'step'
    )

    await continueButton.click()
    await expect(rail.getByRole('button', { name: /Orchestration/i })).toHaveAttribute(
      'aria-current',
      'step'
    )
    await expect(rail.getByRole('tab', { name: /Workbench/i })).toHaveAttribute(
      'aria-selected',
      'false'
    )

    await continueButton.click()
    await expect(rail.getByRole('button', { name: /Usage/i })).toHaveAttribute(
      'aria-current',
      'step'
    )

    await continueButton.click()
    await expect(rail.getByRole('tab', { name: /Workbench/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await expect(rail.getByRole('button', { name: /Terminal/i })).toHaveAttribute(
      'aria-current',
      'step'
    )
  })

  test('does not pre-check configured workflows until the user visits them', async ({
    hivewardPage,
    electronApp
  }) => {
    await electronApp.evaluate(
      ({ ipcMain }, preflightStatus) => {
        ipcMain.removeHandler('preflight:check')
        ipcMain.handle('preflight:check', () => preflightStatus)
        ipcMain.removeHandler('linear:status')
        ipcMain.handle('linear:status', () => ({ connected: false, viewer: null }))
        ipcMain.removeHandler('jira:status')
        ipcMain.handle('jira:status', () => ({ connected: false, viewer: null }))
      },
      {
        git: { installed: true },
        gh: { installed: true, authenticated: true },
        glab: { installed: false, authenticated: false },
        bitbucket: { configured: false, authenticated: false, account: null },
        azureDevOps: {
          configured: false,
          authenticated: false,
          account: null,
          baseUrl: null,
          tokenConfigured: false
        },
        gitea: {
          configured: false,
          authenticated: false,
          account: null,
          baseUrl: null,
          tokenConfigured: false
        }
      }
    )
    await hivewardPage.evaluate(async () => {
      for (const key of [
        'hiveward.featureWall.visitedWorkflows.v1',
        'hiveward.featureWall.visitedAgentSteps.v1',
        'hiveward.featureWall.visitedWorkbenchSteps.v1',
        'hiveward.featureWall.visitedReviewSteps.v1',
        'hiveward.featureWall.completedWorkflows.v1',
        'hiveward.featureWall.completedAgentSteps.v1',
        'hiveward.featureWall.completedWorkbenchSteps.v1',
        'hiveward.featureWall.completedReviewSteps.v1'
      ]) {
        localStorage.removeItem(key)
      }
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      // Seed through the status actions so each result gets the current execution context.
      await Promise.all([
        store.getState().refreshPreflightStatus({ force: true }),
        store.getState().checkLinearConnection(true),
        store.getState().checkJiraConnection()
      ])
      store.getState().openModal('feature-wall', { source: 'help_menu' })
    })

    const rail = hivewardPage.getByRole('navigation', { name: 'Workflows' })
    const workspacesTab = rail.locator('[data-feature-wall-workflow-id="workspaces"]')
    const tasksTab = rail.locator('[data-feature-wall-workflow-id="tasks"]')
    await expect(workspacesTab.locator('[aria-label="Completed"]')).toHaveCount(1)
    await expect(tasksTab.locator('[aria-label="Completed"]')).toHaveCount(0)
    await tasksTab.click()
    await expect(tasksTab.locator('[aria-label="Completed"]')).toHaveCount(1)
    await expect(workspacesTab.locator('[aria-label="Completed"]')).toHaveCount(1)
  })

  test('keeps persisted completed setup-backed substeps checked when reopened', async ({
    hivewardPage
  }) => {
    await hivewardPage.evaluate(() => {
      localStorage.setItem(
        'hiveward.featureWall.completedAgentSteps.v1',
        JSON.stringify(['orchestration'])
      )
      localStorage.setItem(
        'hiveward.featureWall.completedWorkbenchSteps.v1',
        JSON.stringify(['browser'])
      )
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      store.getState().openModal('feature-wall', { source: 'help_menu' })
    })

    const rail = hivewardPage.getByRole('navigation', { name: 'Workflows' })

    await rail.getByRole('tab', { name: /Agents/i }).click()
    await expect(
      rail.getByRole('button', { name: /Orchestration/i }).locator('[aria-label="Completed"]')
    ).toHaveCount(1)

    await rail.getByRole('tab', { name: /Workbench/i }).click()
    await expect(
      rail.getByRole('button', { name: /Browser/i }).locator('[aria-label="Completed"]')
    ).toHaveCount(1)
  })
})
