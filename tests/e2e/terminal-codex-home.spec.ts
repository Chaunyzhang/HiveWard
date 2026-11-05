import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/hiveward-app'
import {
  execInTerminal,
  getTerminalContent,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type CodexHomeProbe = {
  codexHome: string | null
  hivewardCodexHome: string | null
}

function readCodexHomeProbe(pageContent: string, marker: string): CodexHomeProbe | null {
  const match = new RegExp(`${marker}:(\\{[^\\r\\n]+\\})`).exec(pageContent)
  if (!match) {
    return null
  }
  return JSON.parse(match[1] ?? 'null') as CodexHomeProbe | null
}

test.describe('Terminal Codex runtime home', () => {
  test.beforeEach(async ({ hivewardPage }) => {
    await waitForSessionReady(hivewardPage)
    await waitForActiveWorktree(hivewardPage)
    await ensureTerminalVisible(hivewardPage)
  })

  test('terminal process receives the selected account Codex home', async ({
    electronApp,
    hivewardPage
  }) => {
    const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const accountId = 'e2e-terminal-home'
    const managedHomePath = path.join(userData, 'codex-accounts', accountId, 'home')
    mkdirSync(managedHomePath, { recursive: true })
    writeFileSync(path.join(managedHomePath, '.hiveward-managed-home'), `${accountId}\n`)
    writeFileSync(
      path.join(managedHomePath, 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'e2e-placeholder' })
    )
    await hivewardPage.evaluate(
      async ({ accountId, managedHomePath }) => {
        const state = window.__store!.getState()
        await state.updateSettings({
          codexManagedAccounts: [
            {
              id: accountId,
              email: 'terminal-home@example.invalid',
              managedHomePath,
              createdAt: 1,
              updatedAt: 1,
              lastAuthenticatedAt: 1
            }
          ],
          activeCodexManagedAccountId: accountId,
          activeCodexManagedAccountIdsByRuntime: { host: accountId, wsl: {} }
        })
        const tab = state.createTab(state.activeWorktreeId!)
        state.setActiveTab(tab.id)
        state.setActiveTabType('terminal', window.__store?.getState().activeWorktreeId ?? null)
      },
      { accountId, managedHomePath }
    )
    await waitForActiveTerminalManager(hivewardPage)
    const ptyId = await waitForActivePanePtyId(hivewardPage)
    const marker = `__HIVEWARD_CODEX_HOME_E2E_${Date.now()}__`
    const command = [
      'node -e',
      `"console.log('${marker}:' + JSON.stringify({codexHome: process.env.CODEX_HOME || null, hivewardCodexHome: process.env.HIVEWARD_CODEX_HOME || null}))"`
    ].join(' ')

    await execInTerminal(hivewardPage, ptyId, command)

    let probe: CodexHomeProbe | null = null
    await expect
      .poll(
        async () => {
          probe = readCodexHomeProbe(await getTerminalContent(hivewardPage), marker)
          return probe
        },
        { timeout: 15_000, message: 'Terminal did not expose the selected Codex account home' }
      )
      .toEqual({ codexHome: managedHomePath, hivewardCodexHome: managedHomePath })
  })
})
