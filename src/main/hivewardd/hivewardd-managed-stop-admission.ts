import type { HivewarddManagedStopRequest } from '../../shared/hivewardd-stop-request'
import { persistHivewarddDaemonRetirementRecord } from './hivewardd-completed-stop-receipt'
import type { HivewarddDaemonRetirement } from './hivewardd-daemon-retirement'
import { stopHivewarddAutomationScheduler } from './hivewardd-automations'
import { holdHivewarddTerminalAdmissionUntilExit } from './hivewardd-stop-terminal-admission'

// Keep daemon imports lazy so entry loading cannot initialize native code.
async function retireLazily(): Promise<HivewarddDaemonRetirement> {
  const { retireHivewarddDaemonIfIdle } = await import('./hivewardd-daemon-retirement')
  return retireHivewarddDaemonIfIdle()
}

/** Record managed-stop outcomes without vetoing the stop. */
export async function prepareHivewarddManagedStop(
  request: HivewarddManagedStopRequest,
  retire: () => Promise<HivewarddDaemonRetirement> = retireLazily,
  stopAutomations: () => void = stopHivewarddAutomationScheduler,
  holdTerminalAdmission: () => void = holdHivewarddTerminalAdmissionUntilExit
): Promise<void> {
  // Fence spawns before potentially slow daemon retirement.
  holdTerminalAdmission()
  // Stop dispatch before census so new runs cannot race shutdown.
  stopAutomations()
  if (!request.retireIdleDaemon) {
    return
  }
  const outcome = await retire().catch((error: unknown): HivewarddDaemonRetirement => ({
    retirement: 'unverifiable',
    liveSessions: null,
    reason: `Retirement failed: ${error instanceof Error ? error.message : String(error)}`
  }))
  try {
    persistHivewarddDaemonRetirementRecord(request, outcome)
  } catch (error) {
    // Missing retirement records remain unverifiable to the completion reader.
    console.error('[hivewardd] could not record daemon retirement:', error)
  }
}
