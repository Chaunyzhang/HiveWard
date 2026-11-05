import { expect, test } from './helpers/hiveward-app'
import {
  configureGoldenStubAgent,
  getGoldenStubAgentLaunchEnv,
  launchGoldenStubAgentFromNewTab
} from './helpers/golden-stub-agent'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { focusActiveTerminalInput, getTerminalContent } from './helpers/terminal'

test.use({ launchEnv: getGoldenStubAgentLaunchEnv() })

test('launches an agent TUI with a live multiline composer', async ({ hivewardPage }) => {
  await waitForSessionReady(hivewardPage)
  await waitForActiveWorktree(hivewardPage)
  await ensureTerminalVisible(hivewardPage)
  await configureGoldenStubAgent(hivewardPage)
  await launchGoldenStubAgentFromNewTab(hivewardPage)

  const activeTab = hivewardPage.locator('[data-testid="sortable-tab"][data-active="true"]')
  await expect(activeTab).toHaveAttribute('data-tab-title', /Codex|Golden Stub Agent/i)

  await focusActiveTerminalInput(hivewardPage)
  await hivewardPage.keyboard.type('hello from e2e')
  await hivewardPage.keyboard.press('Shift+Enter')
  await hivewardPage.keyboard.type('second line')

  await expect
    .poll(() => getTerminalContent(hivewardPage), { timeout: 10_000 })
    .toContain('> hello from e2e\r\n  second line')
  expect(await getTerminalContent(hivewardPage)).not.toContain('GOLDEN_STUB_AGENT_SUBMITTED')
})
