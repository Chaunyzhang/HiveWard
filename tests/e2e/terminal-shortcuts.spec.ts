// Drive DOM keydown→capture→policy→transport→IPC for every terminal chord.
// Intercept main pty:write for exact bytes without OS-specific readline; assert action effects through panes/search/buffer.
// Skip platform-only chords where runtime policy would never emit them.

import { test, expect } from './helpers/hiveward-app'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../src/shared/constants'
import {
  execInTerminal,
  sendToTerminal,
  countVisibleTerminalPanes,
  waitForActiveTerminalManager,
  waitForTerminalOutput,
  waitForPaneCount,
  getTerminalContent,
  waitForActivePanePtyId,
  focusActiveTerminalInput
} from './helpers/terminal'
import { waitForSessionReady, waitForActiveWorktree, ensureTerminalVisible } from './helpers/store'
import {
  clearTerminalPtyWriteLog as clearPtyWriteLog,
  installTerminalPtyWriteSpy as installMainProcessPtyWriteSpy,
  readTerminalPtyWrites as getPtyWrites
} from './helpers/terminal-pty-write-spy'
import {
  armKittyKeyboardFromPty,
  getKittyKeyboardFlags,
  interruptAndExpectEtx
} from './helpers/terminal-kitty-keyboard'

async function setActivePaneForegroundAgent(
  page: Page,
  agent: 'droid' | 'antigravity' | null
): Promise<string> {
  return page.evaluate((agent) => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!state || !tabId || !pane) {
      throw new Error('No active terminal pane for foreground-agent setup')
    }
    const paneKey = `${tabId}:${pane.leafId}`
    state.setPaneForegroundAgent(paneKey, {
      agent,
      shellForeground: false,
      // The shortcut only emits CSI-u for a process identity confirmed to
      // belong to this PTY; keep the fixture aligned with that trust gate.
      routingTrusted: agent === 'droid'
    })
    return paneKey
  }, agent)
}

async function focusFloatingTerminal(page: Page): Promise<void> {
  await page
    .locator(
      `[data-floating-terminal-panel][aria-hidden="false"] [data-terminal-tab-id] .xterm-helper-textarea`
    )
    .first()
    .focus()
}

async function seedFloatingTerminalTabSwitchScenario(page: Page): Promise<{
  backgroundFirstTabId: string
  floatingFirstTabId: string
  floatingSecondTabId: string
}> {
  return page.evaluate((floatingWorktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const backgroundWorktreeId = state.activeWorktreeId
    if (!backgroundWorktreeId) {
      throw new Error('No active background worktree')
    }

    const backgroundFirst =
      state.tabsByWorktree[backgroundWorktreeId]?.find(
        (tab) => tab.id === state.activeTabIdByWorktree[backgroundWorktreeId]
      ) ??
      state.tabsByWorktree[backgroundWorktreeId]?.find((tab) => tab.id === state.activeTabId) ??
      state.createTab(backgroundWorktreeId)
    state.createTab(backgroundWorktreeId)
    state.setActiveTab(backgroundFirst.id)
    state.setActiveTabType('terminal', window.__store?.getState().activeWorktreeId ?? null)

    const floatingFirst = state.createTab(floatingWorktreeId, undefined, undefined, {
      activate: false
    })
    state.activateTab(floatingFirst.id)
    const floatingGroupId =
      state.activeGroupIdByWorktree[floatingWorktreeId] ??
      state.groupsByWorktree[floatingWorktreeId]?.[0]?.id
    const floatingSecond = state.createTab(floatingWorktreeId, floatingGroupId, undefined, {
      activate: false
    })
    state.activateTab(floatingFirst.id)

    return {
      backgroundFirstTabId: backgroundFirst.id,
      floatingFirstTabId: floatingFirst.id,
      floatingSecondTabId: floatingSecond.id
    }
  }, FLOATING_TERMINAL_WORKTREE_ID)
}

async function getActiveFloatingTerminalTabId(page: Page): Promise<string | null> {
  return page.evaluate((floatingWorktreeId) => {
    const state = window.__store?.getState()
    if (!state) {
      return null
    }
    const groupId = state.activeGroupIdByWorktree[floatingWorktreeId]
    const group =
      (groupId
        ? state.groupsByWorktree[floatingWorktreeId]?.find((candidate) => candidate.id === groupId)
        : null) ??
      state.groupsByWorktree[floatingWorktreeId]?.find((candidate) => candidate.activeTabId) ??
      null
    const activeTab = group?.activeTabId
      ? state.unifiedTabsByWorktree[floatingWorktreeId]?.find((tab) => tab.id === group.activeTabId)
      : null
    return activeTab?.contentType === 'terminal' ? activeTab.entityId : null
  }, FLOATING_TERMINAL_WORKTREE_ID)
}

async function getActiveBackgroundTerminalTabId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    return worktreeId ? (state.activeTabIdByWorktree[worktreeId] ?? state.activeTabId) : null
  })
}

async function getActiveTerminalViewport(
  page: Page
): Promise<{ viewportY: number; baseY: number }> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const buffer = pane?.terminal.buffer.active
    if (!buffer) {
      throw new Error('No active terminal buffer')
    }
    return {
      viewportY: buffer.viewportY,
      baseY: buffer.baseY
    }
  })
}

async function pressShiftedRussianLayoutKey(page: Page): Promise<{
  keydownDefaultPrevented: boolean
  keypressSent: boolean
  inputSent: boolean
  terminalInputSent: boolean
  keyupSent: boolean
}> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    pane?.terminal.focus()
    const textarea = pane?.container.querySelector(
      '.xterm-helper-textarea'
    ) as HTMLTextAreaElement | null
    if (!pane || !textarea) {
      throw new Error('No xterm helper textarea to receive keyboard input')
    }
    textarea.focus()

    const keydown = new KeyboardEvent('keydown', {
      key: 'Ф',
      code: 'KeyA',
      shiftKey: true,
      bubbles: true,
      cancelable: true
    })
    Object.defineProperty(keydown, 'keyCode', { get: () => 65 })
    Object.defineProperty(keydown, 'which', { get: () => 65 })
    textarea.dispatchEvent(keydown)

    if (keydown.defaultPrevented) {
      return {
        keydownDefaultPrevented: true,
        keypressSent: false,
        inputSent: false,
        terminalInputSent: false,
        keyupSent: false
      }
    }

    const keypress = new KeyboardEvent('keypress', {
      key: 'Ф',
      code: 'KeyA',
      shiftKey: true,
      bubbles: true,
      cancelable: true
    })
    Object.defineProperty(keypress, 'keyCode', { get: () => 1060 })
    Object.defineProperty(keypress, 'charCode', { get: () => 1060 })
    Object.defineProperty(keypress, 'which', { get: () => 1060 })
    textarea.dispatchEvent(keypress)

    const makeTextInputEvent = (): InputEvent => {
      const input = new InputEvent('input', {
        data: 'Ф',
        inputType: 'insertText',
        bubbles: true,
        cancelable: false,
        composed: false
      })
      // Populate InputEvent fields explicitly for older Linux Chromium whose synthetic init drops them.
      Object.defineProperties(input, {
        data: { get: () => 'Ф' },
        inputType: { get: () => 'insertText' },
        composed: { get: () => false }
      })
      return input
    }

    // Supply input-event text because Linux untrusted keypress may lack charCode.
    const input = makeTextInputEvent()
    textarea.dispatchEvent(input)

    const keyup = new KeyboardEvent('keyup', {
      key: 'Ф',
      code: 'KeyA',
      shiftKey: true,
      bubbles: true,
      cancelable: true
    })
    Object.defineProperty(keyup, 'keyCode', { get: () => 65 })
    Object.defineProperty(keyup, 'which', { get: () => 65 })
    textarea.dispatchEvent(keyup)

    // Linux CI drops untrusted InputEvent data; use xterm.input for the same PTY route.
    // Keep keydown assertion to catch kitty sequences leaking from shifted layout keys.
    pane.terminal.input('Ф')

    return {
      keydownDefaultPrevented: false,
      keypressSent: true,
      inputSent: true,
      terminalInputSent: true,
      keyupSent: true
    }
  })
}

async function pressAndExpectWrite(
  page: Page,
  app: ElectronApplication,
  chord: string,
  expectedData: string,
  repetitions = 1
): Promise<void> {
  await clearPtyWriteLog(app)
  await focusActiveTerminalInput(page)
  for (let index = 0; index < repetitions; index++) {
    await page.keyboard.press(chord)
  }

  // Match exact bytes: single control codes can occur inside unrelated prompt/paste writes.
  await expect
    .poll(async () => (await getPtyWrites(app)).filter((write) => write === expectedData).length, {
      timeout: 5_000,
      message: `Expected chord "${chord}" to write ${JSON.stringify(expectedData)}`
    })
    .toBeGreaterThanOrEqual(repetitions)
}

const isMac = process.platform === 'darwin'
const mod = isMac ? 'Meta' : 'Control'

// Mac splits use Cmd+D/Cmd+Shift+D; Linux/Windows reserve Ctrl+D for EOF (#586) and use Ctrl+Shift+D/Alt+Shift+D.
const splitVerticalChord = isMac ? `${mod}+d` : `${mod}+Shift+d`
const splitHorizontalChord = isMac ? `${mod}+Shift+d` : 'Alt+Shift+d'

// Poll confirmation/count because fresh split may transiently report a running child.
async function closeActivePaneAndSettle(page: Page, expectedCount: number): Promise<void> {
  // Focus PaneManager’s active textarea, not the first of multiple split panes.
  await focusActiveTerminalInput(page)
  await page.keyboard.press(`${mod}+w`)
  // The "Stop running command?" confirm surfaces a "Stop and Close" action when
  // the pane still reports a running child.
  const confirmButton = page.getByRole('button', { name: /Stop and Close/i })
  await expect
    .poll(
      async () => {
        if (await confirmButton.isVisible().catch(() => false)) {
          // Surface click errors directly instead of hiding actionability/strictness failure behind a count timeout.
          await confirmButton.click().catch((err) => {
            console.warn('closeActivePaneAndSettle: confirm click failed', err)
          })
        }
        return countVisibleTerminalPanes(page)
      },
      {
        timeout: 10_000,
        message: `Expected ${expectedCount} visible terminal panes after close`
      }
    )
    .toBe(expectedCount)
}

// Serialize shared layout/buffer/expand state and the singleton main pty:write spy to prevent interleaved chord effects.
test.describe.configure({ mode: 'serial' })
test.describe('Terminal Shortcuts', () => {
  test.beforeEach(async ({ hivewardPage }) => {
    await waitForSessionReady(hivewardPage)
    await waitForActiveWorktree(hivewardPage)
    await ensureTerminalVisible(hivewardPage)
    const hasPaneManager = await waitForActiveTerminalManager(hivewardPage, 30_000)
      .then(() => true)
      .catch(() => false)
    test.skip(
      !hasPaneManager,
      'Electron automation in this environment never mounts the live TerminalPane manager.'
    )
    await waitForPaneCount(hivewardPage, 1, 30_000)
  })

  test('Shift+Enter follows the pane Kitty keyboard state', async ({ hivewardPage, electronApp }) => {
    await installMainProcessPtyWriteSpy(electronApp)
    const ptyId = await waitForActivePanePtyId(hivewardPage)

    await pressAndExpectWrite(hivewardPage, electronApp, 'Shift+Enter', '\x1b\r')
    if (process.platform === 'win32') {
      return
    }

    // Drive the production PTY-output mirror that shortcut policy reads, not renderer-local flags.
    // Disarm before exit because host grounding clears flags left armed.
    await execInTerminal(hivewardPage, ptyId, "printf '\\033[>1u'; read -r _; printf '\\033[<u'")
    await expect.poll(() => getKittyKeyboardFlags(hivewardPage)).toBe(1)
    await pressAndExpectWrite(hivewardPage, electronApp, 'Shift+Enter', '\x1b[13;2u')

    await sendToTerminal(hivewardPage, ptyId, '\r')
    await expect.poll(() => getKittyKeyboardFlags(hivewardPage)).toBe(0)
    await pressAndExpectWrite(hivewardPage, electronApp, 'Shift+Enter', '\x1b\r')
  })

  test('Droid gets CSI-u Shift+Enter on Windows without changing Antigravity', async ({
    hivewardPage,
    electronApp
  }) => {
    test.skip(process.platform !== 'win32', 'Windows ConPTY encoding contract')
    await installMainProcessPtyWriteSpy(electronApp)
    await waitForActivePanePtyId(hivewardPage)
    const paneKey = await setActivePaneForegroundAgent(hivewardPage, 'droid')
    try {
      await pressAndExpectWrite(hivewardPage, electronApp, 'Shift+Enter', '\x1b[13;2u', 2)
      await setActivePaneForegroundAgent(hivewardPage, 'antigravity')
      await pressAndExpectWrite(hivewardPage, electronApp, 'Shift+Enter', '\x1b\r')
    } finally {
      await hivewardPage.evaluate(
        (key) => window.__store?.getState().clearPaneForegroundAgent(key),
        paneKey
      )
    }
  })

  test('Windows forwards genuine Ctrl+Alt text chords to the PTY', async ({
    hivewardPage,
    electronApp
  }) => {
    test.skip(process.platform !== 'win32', 'Windows xterm AltGr classification regression')
    await installMainProcessPtyWriteSpy(electronApp)
    await waitForActivePanePtyId(hivewardPage)

    await pressAndExpectWrite(hivewardPage, electronApp, 'Control+Alt+u', '\x1b\x15')
    await pressAndExpectWrite(hivewardPage, electronApp, 'Control+Alt+2', '\x1b2')
    await pressAndExpectWrite(hivewardPage, electronApp, 'Control+Alt+;', '\x1b;')
  })

  test('Ctrl+Enter protects local ConPTY shells without breaking trusted TUI chords', async ({
    hivewardPage,
    electronApp
  }) => {
    await installMainProcessPtyWriteSpy(electronApp)
    await waitForActivePanePtyId(hivewardPage)

    if (process.platform === 'win32') {
      await pressAndExpectWrite(hivewardPage, electronApp, 'Control+Enter', '\r')
      const paneKey = await setActivePaneForegroundAgent(hivewardPage, 'droid')
      try {
        // Droid queries CSI-u without activating live flags; trusted process evidence preserves cue/queue.
        await pressAndExpectWrite(hivewardPage, electronApp, 'Control+Enter', '\x1b[13;5u')
      } finally {
        await hivewardPage.evaluate(
          (key) => window.__store?.getState().clearPaneForegroundAgent(key),
          paneKey
        )
      }
      return
    }

    // Preserve the established query-only Droid/Grok contract outside local ConPTY.
    await pressAndExpectWrite(hivewardPage, electronApp, 'Control+Enter', '\x1b[13;5u')
  })

  test('plain Ctrl+C sends ETX and leaves a surviving app its kitty flags', async ({
    hivewardPage,
    electronApp
  }) => {
    test.skip(process.platform === 'win32', 'POSIX trap and printf fixture')
    await installMainProcessPtyWriteSpy(electronApp)
    const ptyId = await waitForActivePanePtyId(hivewardPage)
    // SIGINT during shell startup kills the shell, so interrupt only a ready prompt.
    await execInTerminal(hivewardPage, ptyId, 'echo "CTRL_C_""READY"')
    await waitForTerminalOutput(hivewardPage, 'CTRL_C_READY')
    // An app that survives SIGINT, like an agent TUI, and disarms its own flags on exit.
    await armKittyKeyboardFromPty(
      hivewardPage,
      ptyId,
      `bash -c 'trap "" INT; printf "\\033[=31u"; read -r _; printf "\\033[=0u"'`
    )

    await interruptAndExpectEtx(hivewardPage, electronApp)

    // Require xterm and policy mirror to retain encoding after unproven app death (Shift+Enter stays CSI-u).
    expect(await getKittyKeyboardFlags(hivewardPage)).toBe(31)
    await pressAndExpectWrite(hivewardPage, electronApp, 'Shift+Enter', '\x1b[13;2u')

    await sendToTerminal(hivewardPage, ptyId, '\r')
    await expect.poll(async () => await getKittyKeyboardFlags(hivewardPage)).toBe(0)
    await pressAndExpectWrite(hivewardPage, electronApp, 'Shift+Enter', '\x1b\r')
  })

  test('the host grounds kitty flags an app killed by Ctrl+C left armed', async ({
    hivewardPage,
    electronApp
  }) => {
    test.skip(process.platform === 'win32', 'POSIX printf fixture')
    await installMainProcessPtyWriteSpy(electronApp)
    const ptyId = await waitForActivePanePtyId(hivewardPage)
    await execInTerminal(hivewardPage, ptyId, 'echo "CTRL_C_""READY"')
    await waitForTerminalOutput(hivewardPage, 'CTRL_C_READY')
    // `cat` dies on SIGINT with the flags still armed, like a crashed TUI.
    await armKittyKeyboardFromPty(hivewardPage, ptyId, `printf '\\033[=31u'; cat`)

    await interruptAndExpectEtx(hivewardPage, electronApp)

    await expect
      .poll(async () => await getKittyKeyboardFlags(hivewardPage), {
        timeout: 5_000,
        message: 'the host did not ground the dead app kitty flags at command end'
      })
      .toBe(0)
    await clearPtyWriteLog(electronApp)
    await focusActiveTerminalInput(hivewardPage)
    await hivewardPage.keyboard.type('x')
    await expect
      .poll(async () => (await getPtyWrites(electronApp)).some((write) => write === 'x'), {
        timeout: 5_000,
        message: 'Post-interrupt keyboard input stayed in Kitty CSI-u mode'
      })
      .toBe(true)
    expect((await getPtyWrites(electronApp)).join('')).not.toContain('\x1b[')
    await hivewardPage.keyboard.press('Backspace')
  })

  test('unselected Cmd+C reaches a Kitty app, including after Ctrl+C', async ({
    hivewardPage,
    electronApp
  }) => {
    test.skip(process.platform !== 'darwin', 'macOS copy binding')
    await installMainProcessPtyWriteSpy(electronApp)
    const ptyId = await waitForActivePanePtyId(hivewardPage)
    await execInTerminal(hivewardPage, ptyId, 'echo "CMD_C_""READY"')
    await waitForTerminalOutput(hivewardPage, 'CMD_C_READY')
    const select = (text: string | null): Promise<string> =>
      hivewardPage.evaluate(async (selectedText) => {
        const state = window.__store!.getState()
        const pane = window.__paneManagers!.get(state.activeTabId!)!.getActivePane()!
        if (selectedText === null) {
          pane.terminal.clearSelection()
          return ''
        }
        await new Promise<void>((resolve) =>
          pane.terminal.write(`\r\n${selectedText}\r\n`, resolve)
        )
        const buffer = pane.terminal.buffer.active
        pane.terminal.select(0, buffer.baseY + buffer.cursorY - 1, selectedText.length)
        return pane.terminal.getSelection()
      }, text)
    // Presses Cmd+C, then a marker chord whose write proves the Cmd+C bytes had their turn.
    const pressCmdC = async (marker: string, markerWrite: string): Promise<string[]> => {
      await clearPtyWriteLog(electronApp)
      await focusActiveTerminalInput(hivewardPage)
      await hivewardPage.keyboard.press('Meta+c')
      await hivewardPage.keyboard.press(marker)
      await expect.poll(async () => await getPtyWrites(electronApp)).toContain(markerWrite)
      const writes = await getPtyWrites(electronApp)
      return writes.slice(0, writes.indexOf(markerWrite))
    }
    const kittyCmdC = ['\x1b[99;9;99u', '\x1b[99;9:3u']
    const originalClipboard = await electronApp.evaluate(({ clipboard }) => clipboard.readText())
    try {
      await select(null)
      expect(await pressCmdC('x', 'x')).toEqual([])
      await hivewardPage.keyboard.press('Backspace')

      // An app that survives SIGINT, like an agent TUI, and disarms its own flags on exit.
      await armKittyKeyboardFromPty(
        hivewardPage,
        ptyId,
        `bash -c 'trap "" INT; printf "\\033[=31u"; read -r _; printf "\\033[=0u"'`
      )
      await select(null)
      expect(await pressCmdC('Shift+Enter', '\x1b[13;2u')).toEqual(kittyCmdC)

      const selectedText = await select('Terminal copy selection')
      expect(selectedText).toBe('Terminal copy selection')
      await electronApp.evaluate(({ clipboard }) => clipboard.writeText(''))
      expect(await pressCmdC('Shift+Enter', '\x1b[13;2u')).toEqual([])
      await expect
        .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
        .toBe(selectedText)

      await interruptAndExpectEtx(hivewardPage, electronApp)
      expect(await getKittyKeyboardFlags(hivewardPage)).toBe(31)
      await select(null)
      expect(await pressCmdC('Shift+Enter', '\x1b[13;2u')).toEqual(kittyCmdC)

      await sendToTerminal(hivewardPage, ptyId, '\r')
      await expect.poll(async () => await getKittyKeyboardFlags(hivewardPage)).toBe(0)
      expect(await pressCmdC('x', 'x')).toEqual([])
      await hivewardPage.keyboard.press('Backspace')
    } finally {
      await electronApp.evaluate(
        ({ clipboard }, text) => clipboard.writeText(text),
        originalClipboard
      )
    }
  })

  test('@headful Codex-like background output stays visible without disabling WebGL in auto mode', async ({
    hivewardPage
  }) => {
    const hasPane = await hivewardPage.evaluate(() => {
      const state = window.__store?.getState()
      const worktreeId = state?.activeWorktreeId
      const tabId =
        state?.activeTabType === 'terminal'
          ? state.activeTabId
          : worktreeId
            ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
            : null
      const manager = tabId ? window.__paneManagers?.get(tabId) : null
      manager?.setTerminalGpuAcceleration('auto')
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      return Boolean(pane)
    })
    test.skip(!hasPane, 'No active terminal pane for renderer validation')
    const webglActive = await hivewardPage
      .waitForFunction(
        () => {
          const state = window.__store?.getState()
          const worktreeId = state?.activeWorktreeId
          const tabId =
            state?.activeTabType === 'terminal'
              ? state.activeTabId
              : worktreeId
                ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
                : null
          const manager = tabId ? window.__paneManagers?.get(tabId) : null
          const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
          return Boolean(pane?.webglAddon)
        },
        null,
        { timeout: 5_000 }
      )
      .then(() => true)
      .catch(() => false)
    test.skip(!webglActive, 'WebGL was not active in this headful environment')

    const ptyId = await waitForActivePanePtyId(hivewardPage)
    const marker = `CODEX_BG_${Date.now()}`
    await execInTerminal(hivewardPage, ptyId, `printf '\\033[48;2;52;52;52m  ${marker}  \\033[0m\\n'`)
    await waitForTerminalOutput(hivewardPage, marker)

    await expect
      .poll(
        () =>
          hivewardPage.evaluate((expectedMarker) => {
            const state = window.__store?.getState()
            const worktreeId = state?.activeWorktreeId
            const tabId =
              state?.activeTabType === 'terminal'
                ? state.activeTabId
                : worktreeId
                  ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
                  : null
            const manager = tabId ? window.__paneManagers?.get(tabId) : null
            const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
            const activeBuffer = pane?.terminal.buffer.active
            const terminalText = activeBuffer
              ?.getLine(activeBuffer.baseY + activeBuffer.cursorY)
              ?.translateToString(true)
              .trim()
            const visibleText = pane?.container.textContent ?? ''
            return {
              markerVisible:
                visibleText.includes(expectedMarker) || terminalText === expectedMarker,
              hasComplexScriptOutput: pane?.hasComplexScriptOutput === true,
              hasWebgl: Boolean(pane?.webglAddon)
            }
          }, marker),
        {
          timeout: 5_000,
          message: 'Background SGR output did not stay visible on the auto renderer'
        }
      )
      .toEqual({
        markerVisible: true,
        hasComplexScriptOutput: false,
        hasWebgl: true
      })
  })

  test('floating terminal owns tab switch shortcuts while focused', async ({ hivewardPage }) => {
    const scenario = await seedFloatingTerminalTabSwitchScenario(hivewardPage)
    await hivewardPage.evaluate(async () => {
      const state = window.__store?.getState()
      if (state?.settings?.floatingTerminalEnabled !== true) {
        await state?.updateSettings({ floatingTerminalEnabled: true })
      }
      if (!document.querySelector('[data-floating-terminal-panel][aria-hidden="false"]')) {
        window.dispatchEvent(new CustomEvent('hiveward-toggle-floating-terminal'))
      }
    })
    await expect(
      hivewardPage.locator('[data-floating-terminal-panel][aria-hidden="false"]')
    ).toBeVisible()
    await focusFloatingTerminal(hivewardPage)

    await hivewardPage.keyboard.press(`${mod}+Shift+BracketRight`)
    await expect
      .poll(() => getActiveFloatingTerminalTabId(hivewardPage), {
        timeout: 5_000,
        message: 'floating terminal did not switch to the next tab'
      })
      .toBe(scenario.floatingSecondTabId)
    await expect
      .poll(() => getActiveBackgroundTerminalTabId(hivewardPage), {
        timeout: 1_000,
        message: 'background terminal tab changed while floating terminal was focused'
      })
      .toBe(scenario.backgroundFirstTabId)

    await focusFloatingTerminal(hivewardPage)
    await hivewardPage.keyboard.press(`${mod}+Shift+BracketLeft`)
    await expect
      .poll(() => getActiveFloatingTerminalTabId(hivewardPage), {
        timeout: 5_000,
        message: 'floating terminal did not switch back to the previous tab'
      })
      .toBe(scenario.floatingFirstTabId)
    await expect(getActiveBackgroundTerminalTabId(hivewardPage)).resolves.toBe(
      scenario.backgroundFirstTabId
    )
  })

  test('all terminal chords reach the PTY or fire their action', async ({
    hivewardPage,
    electronApp
  }) => {
    await installMainProcessPtyWriteSpy(electronApp)

    const ptyId = await waitForActivePanePtyId(hivewardPage)
    const marker = `SHORTCUT_TEST_${Date.now()}`
    await execInTerminal(hivewardPage, ptyId, `echo ${marker}`)
    await waitForTerminalOutput(hivewardPage, marker)

    // Alt+←/→ → readline backward-word / forward-word (\eb / \ef).
    await pressAndExpectWrite(hivewardPage, electronApp, 'Alt+ArrowLeft', '\x1bb')
    await pressAndExpectWrite(hivewardPage, electronApp, 'Alt+ArrowRight', '\x1bf')

    // Ctrl+←/→ on non-mac → readline backward-word / forward-word (\eb / \ef).
    // macOS reserves Ctrl+Arrow; Windows ConPTY leaves it to PSReadLine.
    if (!isMac && process.platform !== 'win32') {
      await pressAndExpectWrite(hivewardPage, electronApp, 'Control+ArrowLeft', '\x1bb')
      await pressAndExpectWrite(hivewardPage, electronApp, 'Control+ArrowRight', '\x1bf')
    }

    // Alt+Backspace → Esc+DEL (readline backward-kill-word).
    await pressAndExpectWrite(hivewardPage, electronApp, 'Alt+Backspace', '\x1b\x7f')

    // Ctrl+Backspace → \x17 (unix-word-rubout).
    await pressAndExpectWrite(hivewardPage, electronApp, 'Control+Backspace', '\x17')

    // The shell has not enabled KKP, so Shift+Enter must not leak CSI-u text.
    await pressAndExpectWrite(hivewardPage, electronApp, 'Shift+Enter', '\x1b\r')

    if (isMac) {
      // Cmd+←/→ → Ctrl+A / Ctrl+E (beginning/end of line).
      await pressAndExpectWrite(hivewardPage, electronApp, 'Meta+ArrowLeft', '\x01')
      await pressAndExpectWrite(hivewardPage, electronApp, 'Meta+ArrowRight', '\x05')

      // Cmd+Backspace → Ctrl+U (kill line). Cmd+Delete → Ctrl+K (kill to EOL).
      await pressAndExpectWrite(hivewardPage, electronApp, 'Meta+Backspace', '\x15')
      await pressAndExpectWrite(hivewardPage, electronApp, 'Meta+Delete', '\x0b')
    }

    await focusActiveTerminalInput(hivewardPage)
    await hivewardPage.keyboard.press(`${mod}+k`)
    await expect
      .poll(async () => (await getTerminalContent(hivewardPage)).includes(marker), {
        timeout: 5_000,
        message: 'Cmd+K did not clear the terminal buffer'
      })
      .toBe(false)

    const panesBeforeSplit = await countVisibleTerminalPanes(hivewardPage)
    await focusActiveTerminalInput(hivewardPage)
    await hivewardPage.keyboard.press(splitVerticalChord)
    await waitForPaneCount(hivewardPage, panesBeforeSplit + 1)
    // Require the split PTY binding before close to avoid racing unfinished creation.
    await waitForActivePanePtyId(hivewardPage)

    await focusActiveTerminalInput(hivewardPage)
    await hivewardPage.keyboard.press(`${mod}+BracketRight`)
    await focusActiveTerminalInput(hivewardPage)
    await hivewardPage.keyboard.press(`${mod}+BracketLeft`)
    expect(await countVisibleTerminalPanes(hivewardPage)).toBe(panesBeforeSplit + 1)

    // Test expand while split remains open because it requires >1 pane.
    const readExpanded = async (): Promise<boolean> =>
      hivewardPage.evaluate(() => {
        const state = window.__store?.getState()
        const tabId = state?.activeTabId
        if (!state || !tabId) {
          return false
        }
        return state.expandedPaneByTabId[tabId] === true
      })
    expect(await readExpanded()).toBe(false)
    await focusActiveTerminalInput(hivewardPage)
    await hivewardPage.keyboard.press(`${mod}+Shift+Enter`)
    await expect
      .poll(readExpanded, { timeout: 3_000, message: 'Cmd+Shift+Enter did not expand pane' })
      .toBe(true)
    await focusActiveTerminalInput(hivewardPage)
    await hivewardPage.keyboard.press(`${mod}+Shift+Enter`)
    await expect
      .poll(readExpanded, { timeout: 3_000, message: 'Cmd+Shift+Enter did not collapse pane' })
      .toBe(false)

    await closeActivePaneAndSettle(hivewardPage, panesBeforeSplit)

    const panesBeforeHSplit = await countVisibleTerminalPanes(hivewardPage)
    await focusActiveTerminalInput(hivewardPage)
    await hivewardPage.keyboard.press(splitHorizontalChord)
    await waitForPaneCount(hivewardPage, panesBeforeHSplit + 1)
    await waitForActivePanePtyId(hivewardPage)
    await closeActivePaneAndSettle(hivewardPage, panesBeforeHSplit)

    await focusActiveTerminalInput(hivewardPage)
    await hivewardPage.keyboard.press(`${mod}+f`)
    const searchInput = hivewardPage.locator('[data-terminal-search-root] input').first()
    // Wait for search-input focus: React’s Escape handler otherwise loses an early key to xterm.
    await expect(searchInput).toBeFocused({ timeout: 3_000 })
    await hivewardPage.keyboard.press('Escape')
    await expect(hivewardPage.locator('[data-terminal-search-root]').first()).toBeHidden({
      timeout: 3_000
    })
  })

  test('Cmd+Up/Down scrolls terminal viewport without writing to the PTY on macOS', async ({
    hivewardPage,
    electronApp
  }) => {
    test.skip(!isMac, 'Cmd+Up/Down terminal scroll navigation is macOS-only')

    await installMainProcessPtyWriteSpy(electronApp)

    const ptyId = await waitForActivePanePtyId(hivewardPage)
    const marker = `CMD_ARROW_SCROLL_${Date.now()}`
    await execInTerminal(hivewardPage, ptyId, `for i in {1..120}; do echo ${marker}_$i; done`)
    await waitForTerminalOutput(hivewardPage, `${marker}_120`)

    await expect
      .poll(
        async () => {
          const viewport = await getActiveTerminalViewport(hivewardPage)
          return viewport.baseY > 0 && viewport.viewportY === viewport.baseY
        },
        {
          timeout: 5_000,
          message: 'terminal did not settle at the bottom with scrollback for Cmd+Up/Down repro'
        }
      )
      .toBe(true)

    await clearPtyWriteLog(electronApp)
    await focusActiveTerminalInput(hivewardPage)
    await hivewardPage.keyboard.press('Meta+ArrowUp')
    await expect
      .poll(async () => getActiveTerminalViewport(hivewardPage), {
        timeout: 5_000,
        message: 'Cmd+Up did not scroll the terminal viewport to the top'
      })
      .toMatchObject({ viewportY: 0 })
    expect(await getPtyWrites(electronApp)).toEqual([])

    await focusActiveTerminalInput(hivewardPage)
    await hivewardPage.keyboard.press('Meta+ArrowDown')
    await expect
      .poll(
        async () => {
          const viewport = await getActiveTerminalViewport(hivewardPage)
          return viewport.viewportY === viewport.baseY
        },
        {
          timeout: 5_000,
          message: 'Cmd+Down did not scroll the terminal viewport to the bottom'
        }
      )
      .toBe(true)
    expect(await getPtyWrites(electronApp)).toEqual([])
  })

  test('Shift with Russian layout text reaches the PTY as Cyrillic under kitty keyboard reporting', async ({
    hivewardPage,
    electronApp
  }) => {
    test.skip(process.platform === 'win32', 'ConPTY panes withhold the kitty protocol')
    await installMainProcessPtyWriteSpy(electronApp)
    // Probe real PTY binding before input so onData cannot race disconnected sendInput; then clear spy writes.
    const ptyId = await waitForActivePanePtyId(hivewardPage)
    await armKittyKeyboardFromPty(hivewardPage, ptyId, `printf '\\033[=31u'; cat`)
    await clearPtyWriteLog(electronApp)

    const dispatch = await pressShiftedRussianLayoutKey(hivewardPage)

    expect(dispatch).toEqual({
      keydownDefaultPrevented: false,
      keypressSent: true,
      inputSent: true,
      terminalInputSent: true,
      keyupSent: true
    })
    await expect
      .poll(async () => (await getPtyWrites(electronApp)).some((write) => write.includes('Ф')), {
        timeout: 5_000,
        message: 'Shift+Russian layout text did not reach the PTY as Cyrillic'
      })
      .toBe(true)
    const writes = await getPtyWrites(electronApp)
    const joinedWrites = writes.join('')
    expect(joinedWrites).not.toContain('\x1b[97:1060;2;1060u')
    expect(joinedWrites).not.toContain('\x1b[97:1060;2:3u')
    await sendToTerminal(hivewardPage, ptyId, '\x03')
  })
})
