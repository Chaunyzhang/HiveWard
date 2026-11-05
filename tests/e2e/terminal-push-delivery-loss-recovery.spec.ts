// v1.4.121-rc.0 (2026-07-06): pty:data pushes vanished while invoke stayed healthy, leaving unconsumed/unACKed output.
// Blackhole dispatcher receipt/ACK/handling; require invoke-based watchdog confirmation and main write-off/snapshot-restore without push or reload.
// At 500ms ticks, production’s 10s minimum ACK silence yields ~11–13s healing; allow 30s.
import { test, expect } from './helpers/hiveward-app'
import { waitForSessionReady, waitForActiveWorktree, ensureTerminalVisible } from './helpers/store'
import {
  waitForActiveTerminalManager,
  waitForActivePanePtyId,
  execInTerminal,
  getTerminalContent
} from './helpers/terminal'

type DeliveryWatchdogWindow = Window & {
  __terminalDeliveryWatchdog?: {
    blackhole: (on: boolean) => void
    configure: (config: {
      intervalMs?: number
      stallTicksToHeal?: number
      healCooldownMs?: number
    }) => void
    snapshot: () => {
      receivedPtyDataEventCount: number
      stallStreakTicks: number
      healCount: number
      blackholed: boolean
    }
  }
}

test.describe('terminal push-delivery loss recovery', () => {
  test.afterEach(async ({ hivewardPage }) => {
    await hivewardPage.evaluate(() => {
      ;(window as DeliveryWatchdogWindow).__terminalDeliveryWatchdog?.blackhole(false)
    })
  })

  test('watchdog repaints wedged terminals from the main buffer without push delivery or reload', async ({
    hivewardPage
  }) => {
    test.setTimeout(120_000)
    await waitForSessionReady(hivewardPage)
    await waitForActiveWorktree(hivewardPage)
    await ensureTerminalVisible(hivewardPage)
    await waitForActiveTerminalManager(hivewardPage)
    const ptyId = await waitForActivePanePtyId(hivewardPage)

    // Arithmetic keeps the asserted baseline out of command echo.
    await execInTerminal(hivewardPage, ptyId, 'echo live-before-$((41+1))')
    await expect
      .poll(async () => getTerminalContent(hivewardPage), { timeout: 15_000 })
      .toContain('live-before-42')

    await hivewardPage.evaluate(() => {
      const watchdog = (window as DeliveryWatchdogWindow).__terminalDeliveryWatchdog
      if (!watchdog) {
        throw new Error('delivery watchdog e2e hook missing — exposeStore build?')
      }
      watchdog.configure({ intervalMs: 500, healCooldownMs: 3_000 })
      watchdog.blackhole(true)
    })

    await execInTerminal(hivewardPage, ptyId, 'echo wedged-$((100+23))')

    await hivewardPage.waitForTimeout(1_500)
    expect(await getTerminalContent(hivewardPage)).not.toContain('wedged-123')

    // Assert invoke heal/write-off/restore request, not wedged pane text: desktop-only local PTYs lack a main emulator in headless E2E.
    // Their snapshot fallback serializes blackholed renderer xterm, which cannot contain the withheld bytes.
    await expect
      .poll(
        async () =>
          hivewardPage.evaluate(
            () =>
              (window as DeliveryWatchdogWindow).__terminalDeliveryWatchdog?.snapshot()
                ?.healCount ?? 0
          ),
        { timeout: 30_000 }
      )
      .toBeGreaterThan(0)

    await hivewardPage.evaluate(() => {
      ;(window as DeliveryWatchdogWindow).__terminalDeliveryWatchdog?.blackhole(false)
    })
    await execInTerminal(hivewardPage, ptyId, 'echo live-after-$((200+56))')
    await expect
      .poll(async () => getTerminalContent(hivewardPage), { timeout: 15_000 })
      .toContain('live-after-256')
  })
})
