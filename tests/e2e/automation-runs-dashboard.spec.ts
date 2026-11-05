// A fresh profile may have no automation history; Runs navigation and its empty state must still work.

import { test, expect } from './helpers/hiveward-app'
import { waitForSessionReady } from './helpers/store'

test('opens the runs dashboard and returns to automations', async ({ hivewardPage }) => {
  await waitForSessionReady(hivewardPage)

  await hivewardPage.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    store.getState().openAutomationsPage()
  })

  const runsButton = hivewardPage.getByRole('button', { name: 'Runs' })
  await expect(runsButton).toBeVisible()
  await runsButton.click()

  await expect(hivewardPage.getByRole('navigation', { name: 'Automations breadcrumb' })).toBeVisible()
  await expect(hivewardPage.getByText('Successful · 24h')).toBeVisible()
  await expect(hivewardPage.getByText('Failed · 24h')).toBeVisible()
  await expect(hivewardPage.getByText('Successful · 7d')).toBeVisible()
  await expect(hivewardPage.getByText('Failed · 7d')).toBeVisible()
  await expect(hivewardPage.getByRole('button', { name: 'Filters' })).toBeVisible()
  await expect(hivewardPage.getByRole('button', { name: 'Refresh runs' })).toBeVisible()
  await expect(hivewardPage.getByText('Automation', { exact: true })).toBeVisible()
  await expect(hivewardPage.getByText('Triggered', { exact: true })).toBeVisible()
  await expect(hivewardPage.getByText('Status', { exact: true })).toBeVisible()

  await hivewardPage
    .getByRole('navigation', { name: 'Automations breadcrumb' })
    .getByRole('button', { name: 'Automations' })
    .click()
  await expect(hivewardPage.getByRole('heading', { name: 'Automations' })).toBeVisible()
  await expect(runsButton).toBeVisible()
})
