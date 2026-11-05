import { expect, test } from './helpers/hiveward-app'
import {
  configureGoldenStubAgent,
  getGoldenStubAgentLaunchEnv,
  GOLDEN_STUB_EXIT_MARKER,
  launchGoldenStubAgentFromNewTab
} from './helpers/golden-stub-agent'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForRestoredTerminalInputReady } from './helpers/restored-terminal-input-readiness'
import {
  focusActiveTerminalInput,
  waitForActivePanePtyId,
  waitForTerminalOutput
} from './helpers/terminal'

test.use({ launchEnv: getGoldenStubAgentLaunchEnv() })

// Split the marker so terminal input echo cannot impersonate successful shell execution.
function buildSplitMarkerEcho(prefix: string, suffix: string): { command: string; marker: string } {
  const command =
    process.platform === 'win32'
      ? `Write-Output ('${prefix}' + '${suffix}')`
      : `echo "${prefix}""${suffix}"`
  return { command, marker: `${prefix}${suffix}` }
}

test('opens a clean live shell after an agent exits', async ({ hivewardPage }) => {
  await waitForSessionReady(hivewardPage)
  await waitForActiveWorktree(hivewardPage)
  await ensureTerminalVisible(hivewardPage)
  await configureGoldenStubAgent(hivewardPage)
  await launchGoldenStubAgentFromNewTab(hivewardPage)

  await hivewardPage.keyboard.type('exit')
  await hivewardPage.keyboard.press('Enter')
  await waitForTerminalOutput(hivewardPage, GOLDEN_STUB_EXIT_MARKER, 15_000)

  const tabsBeforeShell = await hivewardPage.locator('[data-testid="sortable-tab"]').count()
  await hivewardPage.getByRole('button', { name: 'New tab' }).click({ force: true })
  await hivewardPage
    .getByRole('menuitem', { name: /New Terminal/i })
    .first()
    .click({ force: true })
  await expect(hivewardPage.locator('[data-testid="sortable-tab"]')).toHaveCount(tabsBeforeShell + 1)
  const shellPtyId = await waitForActivePanePtyId(hivewardPage)
  // A bound pane can precede transport readiness; wait or marker keystrokes may be dropped.
  expect(await waitForRestoredTerminalInputReady(hivewardPage, shellPtyId)).toBe(true)

  const afterAgent = buildSplitMarkerEcho('after-', 'agent')
  await focusActiveTerminalInput(hivewardPage)
  await hivewardPage.keyboard.type(afterAgent.command)
  await hivewardPage.keyboard.press('Enter')
  await waitForTerminalOutput(hivewardPage, afterAgent.marker, 15_000)

  const afterShiftEnter = buildSplitMarkerEcho('after-shift-', 'enter')
  await hivewardPage.keyboard.press('Shift+Enter')
  await hivewardPage.keyboard.type(afterShiftEnter.command)
  await hivewardPage.keyboard.press('Enter')
  await waitForTerminalOutput(hivewardPage, afterShiftEnter.marker, 15_000)
  await expect(hivewardPage.locator('[data-testid="sortable-tab"]')).toHaveCount(tabsBeforeShell + 1)
})
