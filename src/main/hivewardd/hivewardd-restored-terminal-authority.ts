import { HIVEWARD_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import type { HiveWardRuntimeService } from '../runtime/hiveward-runtime'
import type { HivewarddFeatureReadiness } from '../runtime/rpc/hivewardd-feature-readiness'
import { placeUnshownLiveTerminalsBestEffort } from '../runtime/terminal/adoption/unshown-live-terminal-placement'
import type { createHivewarddStartupTiming } from './hivewardd-startup-timing'

/** Restored orchestration authority, the legacy terminal reconcile and unshown placement, in order. */
export async function restoreHivewarddTerminalAuthority(
  runtime: HiveWardRuntimeService,
  timed: ReturnType<typeof createHivewarddStartupTiming>['time'],
  readiness: HivewarddFeatureReadiness
): Promise<void> {
  await timed('orchestration', () => runtime.refreshRestoredOrchestrationAuthority())
  readiness.open('orchestration')
  // Terminal inventory stays on the critical path: no latch, every client needs it at connect.
  await timed('reconcile-terminals', () => runtime.reconcileLegacyWorkerTerminals())
  if (HIVEWARD_LAYOUT_OWNER_IS_MAIN) {
    await placeUnshownLiveTerminalsBestEffort(runtime)
  }
  readiness.open('unshownPlacement')
}
