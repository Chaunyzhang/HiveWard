import { expect, test } from './helpers/hiveward-app'
import {
  configureGoldenStubAgent,
  getGoldenStubAgentLaunchEnv,
  launchGoldenStubAgentFromNewTab
} from './helpers/golden-stub-agent'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePanePtyId, waitForTerminalOutput } from './helpers/terminal'

test.use({ launchEnv: getGoldenStubAgentLaunchEnv() })

test('account switch actions return keyboard input to the terminal', async ({
  hivewardPage
}, testInfo) => {
  await waitForSessionReady(hivewardPage)
  await waitForActiveWorktree(hivewardPage)
  await ensureTerminalVisible(hivewardPage)
  await configureGoldenStubAgent(hivewardPage)
  await launchGoldenStubAgentFromNewTab(hivewardPage)

  for (const action of ['outside', 'keep', 'escape', 'restart'] as const) {
    const ptyId = await waitForActivePanePtyId(hivewardPage)
    await hivewardPage.evaluate(
      ({ ptyId, action }) => {
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is unavailable')
        }
        store.getState().markCodexRestartNotices([
          {
            ptyId,
            previousAccountLabel: 'Previous account',
            nextAccountLabel: `Current account (${action})`
          }
        ])
      },
      { ptyId, action }
    )
    const dialog = hivewardPage.getByRole('dialog').filter({ hasText: 'Account switched' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toBeFocused()
    if (action === 'outside') {
      const cardText = await dialog.getByText(/Restart this session to use/).boundingBox()
      const backdrop = await dialog.boundingBox()
      if (!cardText || !backdrop) {
        throw new Error('Account prompt has no rendered bounds')
      }
      await hivewardPage.mouse.move(cardText.x + 8, cardText.y + 8)
      await hivewardPage.mouse.down()
      await hivewardPage.mouse.move(backdrop.x + 8, backdrop.y + 8)
      await hivewardPage.mouse.up()
      await expect(dialog).toBeVisible()
      await hivewardPage.screenshot({ path: testInfo.outputPath('account-switched.png') })
      await dialog.click({ position: { x: 8, y: 8 } })
    } else if (action === 'escape') {
      await hivewardPage.keyboard.press('Escape')
    } else {
      await dialog
        .getByRole('button', {
          name: action === 'keep' ? 'Keep old account' : 'Restart',
          exact: true
        })
        .click()
    }
    await expect(dialog).toHaveCount(0)
    const input = hivewardPage.locator('.xterm-helper-textarea:focus')
    await expect(input).toHaveCount(1)
    if (action === 'restart') {
      // This check covers the focus handoff; process replacement is a separate contract.
      break
    }
    // A printed reply proves input reached the process without an extra terminal click.
    const marker = `ACCOUNT_SWITCH_${action.toUpperCase()}`
    await hivewardPage.keyboard.type(marker)
    await hivewardPage.keyboard.press('Enter')
    await waitForTerminalOutput(hivewardPage, `[GOLDEN_STUB_AGENT_SUBMITTED] ${marker}`, 20_000)
    await expect(input).toHaveCount(1)
    await hivewardPage.screenshot({ path: testInfo.outputPath(`after-${action}.png`) })
  }
})
