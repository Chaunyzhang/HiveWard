import type { z } from 'zod'
import { defineMethod } from '../core'
import type { HiveWardRuntimeService } from '../../hiveward-runtime'
import {
  HIVEWARDD_TERMINAL_CENSUS_METHOD,
  HivewarddTerminalCensusParamsSchema,
  type HivewarddTerminalCensus
} from '../../../../shared/hivewardd-terminal-census'

const SPAWN_SETTLE_MS = 10_000
const UNVERIFIABLE: HivewarddTerminalCensus = {
  liveSessions: null,
  startedSinceActivation: null,
  daemonProtocolVersion: null
}

export const HIVEWARDD_TERMINAL_CENSUS_METHODS = [
  defineMethod({
    name: HIVEWARDD_TERMINAL_CENSUS_METHOD,
    permission: 'host-admin',
    params: HivewarddTerminalCensusParamsSchema,
    handler: async (params, { runtime }) => {
      if (params.closeAdmissionForMs === undefined) {
        return countTerminals(params, runtime)
      }
      // Before counting: a terminal admitted after the count would die with the stop, uncounted.
      const admission = runtime.terminalUpdateAdmission
      const admissionClosedUntil = admission.close(params.closeAdmissionForMs)
      // A spawn admitted before the close may still be starting; count only once it has.
      if (admissionClosedUntil > 0 && !(await admission.waitForSpawnsToSettle(SPAWN_SETTLE_MS))) {
        return { ...UNVERIFIABLE, admissionClosedUntil }
      }
      return { ...(await countTerminals(params, runtime)), admissionClosedUntil }
    }
  })
]

async function countTerminals(
  params: z.infer<typeof HivewarddTerminalCensusParamsSchema>,
  runtime: Pick<HiveWardRuntimeService, 'releaseFinishedAutomationRunTerminals'>
): Promise<HivewarddTerminalCensus> {
  // Import lazily: daemon modules install xterm's global window and must not contaminate every dispatcher process.
  const { collectHivewarddTerminalCensus } = await import('../../../hivewardd/hivewardd-terminal-census')
  if (!params.releaseFinishedAutomationTerminals) {
    return collectHivewarddTerminalCensus(params.activatedAt)
  }
  const before = await collectHivewarddTerminalCensus(params.activatedAt)
  const released = await runtime.releaseFinishedAutomationRunTerminals()
  return settledCensus(
    () => collectHivewarddTerminalCensus(params.activatedAt),
    before.liveSessions === null ? null : before.liveSessions - released
  )
}

/** Closed sessions leave the daemon a moment after the close; wait briefly for the count to drop. */
async function settledCensus(
  collect: () => Promise<HivewarddTerminalCensus>,
  expectedAtMost: number | null
): Promise<HivewarddTerminalCensus> {
  let census = await collect()
  for (let attempt = 0; attempt < 15 && expectedAtMost !== null; attempt += 1) {
    if (census.liveSessions === null || census.liveSessions <= expectedAtMost) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
    census = await collect()
  }
  return census
}
