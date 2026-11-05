import type { HiveWardRuntimeService } from '../runtime/hiveward-runtime'
import type { HivewarddRuntimeCleanup } from './hivewardd-runtime-lifetime'
import { EmulatorBridge } from '../emulator/emulator-bridge'
import { withTimeout } from '../../shared/promise-timeout-fallback'

// A stalled adb must not hold the final profile flush past hivewardd's shutdown deadline.
const EMULATOR_TEARDOWN_BUDGET_MS = 3_000

/** Android drives adb/emulator on any host; iOS backends report their own host-support errors. */
export function installHivewarddEmulatorBridge(
  runtime: HiveWardRuntimeService,
  registerCleanup: (cleanup: HivewarddRuntimeCleanup) => void
): void {
  const bridge = new EmulatorBridge()
  runtime.setEmulatorBridge(bridge)
  // Like desktop quit: stop the helpers and devices HiveWard started.
  registerCleanup(() =>
    withTimeout(bridge.destroyAllSessions(), EMULATOR_TEARDOWN_BUDGET_MS, undefined)
  )
}
