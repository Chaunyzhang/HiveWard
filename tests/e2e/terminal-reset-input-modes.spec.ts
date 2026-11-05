// Require Reset Terminal to ground modes in the host model across park/reveal; renderer-only reset would re-arm the fresh xterm.
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/hiveward-app'
import { parkHiddenTabBehindDecoy } from './helpers/terminal-hidden-parking'
import {
  ensureTerminalVisible,
  getActiveTabId,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  focusActiveTerminalInput,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { openTerminalContextMenu } from './helpers/terminal-pane-title-actions'
import {
  clearTerminalPtyWriteLog,
  installTerminalPtyWriteSpy,
  readTerminalPtyWrites
} from './helpers/terminal-pty-write-spy'
import { waitForPtyShellEcho } from './terminal-pty-readiness'

const PARKING_DELAY_MS = Number(process.env.HIVEWARD_E2E_TERMINAL_PARKING_DELAY_MS) || 500
const KITTY_SHIFT_ENTER = '\x1b[13;2u'

test.use({
  hivewardAppExtraEnv: { HIVEWARD_E2E_TERMINAL_PARKING_DELAY_MS: String(PARKING_DELAY_MS) }
})

type XtermInputModes = { kittyFlags: number | null; mouse: string | null }

async function readXtermInputModes(page: Page): Promise<XtermInputModes> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const tabId = state?.activeTabId ?? null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: xterm exposes kitty flags only on its private core; null when absent.
    const terminal = pane?.terminal as
      | {
          modes?: { mouseTrackingMode?: string }
          _core?: { coreService?: { kittyKeyboard?: { flags?: number } } }
        }
      | undefined
    return {
      kittyFlags: terminal?._core?.coreService?.kittyKeyboard?.flags ?? null,
      mouse: terminal?.modes?.mouseTrackingMode ?? null
    }
  })
}

// Why Shift+Enter: the policy emits CSI-u only when the pane mirror reports kitty flags.
async function readShiftEnterWrite(page: Page, app: ElectronApplication): Promise<string> {
  await clearTerminalPtyWriteLog(app)
  await focusActiveTerminalInput(page)
  await page.keyboard.press('Shift+Enter')
  let written = ''
  await expect
    .poll(
      async () => {
        written = (await readTerminalPtyWrites(app)).join('')
        return written.length
      },
      { timeout: 5_000, message: 'Shift+Enter wrote nothing' }
    )
    .toBeGreaterThan(0)
  return written
}

async function expectGrounded(page: Page, app: ElectronApplication, when: string): Promise<void> {
  await expect
    .poll(() => readXtermInputModes(page), { timeout: 10_000, message: `xterm armed ${when}` })
    .toEqual({ kittyFlags: 0, mouse: 'none' })
  expect(await readShiftEnterWrite(page, app)).not.toContain(KITTY_SHIFT_ENTER)
}

async function activateTerminalTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((tabId) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('HiveWard store unavailable')
    }
    state.setActiveTabType('terminal', window.__store?.getState().activeWorktreeId ?? null)
    state.setActiveTab(tabId)
  }, tabId)
  await expect.poll(() => getActiveTabId(page)).toBe(tabId)
  await waitForActiveTerminalManager(page, 30_000)
}

test('Reset Terminal grounds modes an unhooked crash left armed, through park and reveal', async ({
  hivewardPage,
  electronApp
}) => {
  test.skip(process.platform === 'win32', 'ConPTY panes withhold the kitty protocol')
  await installTerminalPtyWriteSpy(electronApp)
  await waitForSessionReady(hivewardPage)
  const worktreeId = await waitForActiveWorktree(hivewardPage)
  await ensureTerminalVisible(hivewardPage)
  await waitForActiveTerminalManager(hivewardPage, 30_000)
  const tabId = await getActiveTabId(hivewardPage)
  if (!tabId) {
    throw new Error('no active terminal tab')
  }
  const ptyId = await waitForActivePanePtyId(hivewardPage)
  await waitForPtyShellEcho(hivewardPage, ptyId, 15_000)

  // `exec` drops the shell hooks, so no OSC 133;D ever lets the host ground the
  // modes the printf arms and leaves behind.
  await sendToTerminal(hivewardPage, ptyId, 'exec bash --norc --noprofile\r')
  await sendToTerminal(hivewardPage, ptyId, "printf '\\033[>5u\\033[?1000h\\033[?1006h'\r")
  await expect
    .poll(() => readXtermInputModes(hivewardPage), { timeout: 10_000 })
    .toEqual({ kittyFlags: 5, mouse: 'vt200' })
  expect(await readShiftEnterWrite(hivewardPage, electronApp)).toContain(KITTY_SHIFT_ENTER)

  await openTerminalContextMenu(hivewardPage)
  await hivewardPage.getByRole('menuitem', { name: 'Reset Terminal', exact: true }).click()
  await expectGrounded(hivewardPage, electronApp, 'after Reset Terminal')

  await parkHiddenTabBehindDecoy(hivewardPage, worktreeId, tabId, { parkDelayMs: PARKING_DELAY_MS })
  await activateTerminalTab(hivewardPage, tabId)
  await waitForActivePanePtyId(hivewardPage)
  await expectGrounded(hivewardPage, electronApp, 'after park and reveal')
})
