import { test, expect } from './helpers/hiveward-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  stageNodeScriptForTerminal,
  type StagedTerminalNodeScript
} from './helpers/run-node-script-in-terminal'
import { worktreeRow } from './worktree-row-locators'

test('Pi EOF removes the completed agent row from the live Electron sidebar (#12907)', async ({
  hivewardPage
}, testInfo) => {
  await waitForSessionReady(hivewardPage)
  const worktreeId = await waitForActiveWorktree(hivewardPage)
  await ensureTerminalVisible(hivewardPage)
  await waitForActiveTerminalManager(hivewardPage)
  const ptyId = await waitForActivePanePtyId(hivewardPage)
  await hivewardPage.evaluate(() => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('window.__store is unavailable')
    }
    state.setAgentActivityDisplayMode('full')
    if (!state.worktreeCardProperties.includes('inline-agents')) {
      state.setWorktreeCardProperties([...state.worktreeCardProperties, 'inline-agents'])
    }
  })

  const script: StagedTerminalNodeScript = stageNodeScriptForTerminal(
    "process.stdout.write('PI_EOF_AGENT_READY\\r\\n\\x1b]0;Pi\\x07'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"
  )
  // Exit the POSIX shell after Node accepts EOF so the surviving shell cannot hide agent cleanup.
  await sendToTerminal(hivewardPage, ptyId, `${script.command}; exit\r`)
  try {
    await waitForTerminalOutput(hivewardPage, 'PI_EOF_AGENT_READY', 15_000)
    const agentRows = worktreeRow(hivewardPage, worktreeId).locator('[aria-label="Agents"] > div')
    await expect(agentRows).toHaveCount(1)
    await hivewardPage.screenshot({ path: testInfo.outputPath('pi-row-before-eof.png') })

    await sendToTerminal(hivewardPage, ptyId, '\u0004')
    await expect(agentRows).toHaveCount(0, { timeout: 15_000 })
    await hivewardPage.screenshot({ path: testInfo.outputPath('pi-row-after-eof.png') })
  } finally {
    script.cleanup()
  }
})
