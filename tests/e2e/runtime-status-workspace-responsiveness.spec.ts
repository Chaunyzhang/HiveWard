import { test, expect } from './helpers/hiveward-app'
import {
  seedAccumulatedWorkspaceFixture,
  cleanupAccumulatedWorkspaceFixture
} from './accumulated-workspace-fixture'
import {
  ensureTerminalVisible,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { waitForActiveTerminalManager, waitForTerminalOutput } from './helpers/terminal'

test('runtime probe evidence preserves palette switching and terminal output at workspace scale', async ({
  hivewardPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(hivewardPage)
  const source = await waitForActiveWorktree(hivewardPage)
  const target = (await getAllWorktreeIds(hivewardPage)).find((id) => id !== source)
  if (!target) {
    throw new Error('Expected a second seeded workspace')
  }
  await switchToWorktree(hivewardPage, target)
  await ensureTerminalVisible(hivewardPage)
  await waitForActiveTerminalManager(hivewardPage)
  const targetName = await hivewardPage.evaluate(
    (id) =>
      window
        .__store!.getState()
        .getKnownWorktreeById(id)
        ?.branch.replace(/^refs\/heads\//, ''),
    target
  )
  if (!targetName) {
    throw new Error('Missing workspace name')
  }
  await switchToWorktree(hivewardPage, source)
  const fixture = await seedAccumulatedWorkspaceFixture(hivewardPage)
  const cdp = await hivewardPage.context().newCDPSession(hivewardPage)
  await cdp.send('Performance.enable')
  const beforeMetrics = await cdp.send('Performance.getMetrics')
  const publications: number[] = []
  const gaps: number[] = []
  const traffic = hivewardPage.evaluate(async () => {
    const store = window.__store!
    const durations: number[] = []
    const gaps: number[] = []
    let last = performance.now()
    for (let sequence = 1; sequence <= 120; sequence += 1) {
      await new Promise((resolve) => setTimeout(resolve, 16))
      const now = performance.now()
      gaps.push(now - last)
      last = now
      const start = performance.now()
      store.getState().setRuntimeEnvironmentStatus(
        'probe-fixture',
        {
          checkedAt: sequence,
          status: null,
          snapshot: {
            environmentId: 'probe-fixture',
            pairingRevision: 1,
            sequence,
            checkedAt: sequence,
            status: null,
            verification: 'unavailable',
            transport: 'ready'
          }
        },
        { suppressDisconnectToast: true }
      )
      durations.push(performance.now() - start)
    }
    store.getState().clearRuntimeEnvironmentStatus('probe-fixture')
    return { durations, gaps }
  })
  try {
    await hivewardPage.evaluate(() => window.__store!.getState().openModal('worktree-palette'))
    const palette = hivewardPage.getByRole('dialog', { name: 'Jump to...' })
    await expect(palette).toBeVisible()
    await palette.getByRole('combobox').fill(targetName)
    await expect(palette.locator('[cmdk-item][data-selected="true"]')).toContainText(targetName)
    await palette.screenshot({ path: testInfo.outputPath('palette-during-probes.png') })
    await palette.getByRole('combobox').press('Enter')
    await expect(palette).toBeHidden()
    const row = hivewardPage.locator(
      `[data-worktree-sidebar] [role="option"][data-worktree-id=${JSON.stringify(target)}]`
    )
    await expect(row).toHaveAttribute('aria-current', 'page')
    await waitForActiveTerminalManager(hivewardPage)
    const terminal = hivewardPage
      .locator('[data-terminal-tab-id]:visible .xterm-helper-textarea')
      .first()
    await terminal.fill('echo RUNTIME_PROBE_TYPING_OK')
    await terminal.press('Enter')
    await waitForTerminalOutput(hivewardPage, 'RUNTIME_PROBE_TYPING_OK')
    await hivewardPage.screenshot({ path: testInfo.outputPath('terminal-after-switch.png') })
    const measured = await traffic
    publications.push(...measured.durations)
    gaps.push(...measured.gaps)
    expect(publications).toHaveLength(120)
    expect(
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible())
      )
    ).toBe(true)
    const afterMetrics = await cdp.send('Performance.getMetrics')
    const metric = (metrics: { metrics: { name: string; value: number }[] }, name: string) =>
      metrics.metrics.find((metric) => metric.name === name)?.value ?? 0
    const sorted = [...publications].sort((a, b) => a - b)
    const report = {
      fixture,
      publications: publications.length,
      publicationMs: {
        median: sorted[Math.floor(sorted.length / 2)],
        max: Math.max(...publications)
      },
      timerGapMs: { max: Math.max(...gaps) },
      rendererTaskMs:
        (metric(afterMetrics, 'TaskDuration') - metric(beforeMetrics, 'TaskDuration')) * 1000,
      heapUsedDelta:
        metric(afterMetrics, 'JSHeapUsedSize') - metric(beforeMetrics, 'JSHeapUsedSize')
    }
    console.log('[runtime-probe-workspace]', JSON.stringify(report))
    await testInfo.attach('runtime-probe-workspace', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json'
    })
  } finally {
    await traffic
    await cdp.detach()
    await cleanupAccumulatedWorkspaceFixture(hivewardPage)
  }
})
