import { describe, expect, it, vi } from 'vitest'
import type { HiveWardRuntimeService } from '../runtime/hiveward-runtime'
import { HivewarddFeatureReadiness } from '../runtime/rpc/hivewardd-feature-readiness'

const steps = vi.hoisted(() => new Array<string>())
vi.mock('../runtime/terminal/adoption/unshown-live-terminal-placement', () => ({
  placeUnshownLiveTerminalsBestEffort: async () => {
    steps.push('placement')
  }
}))
vi.mock('../../shared/layout-owner-switch', () => ({ HIVEWARD_LAYOUT_OWNER_IS_MAIN: true }))

import { restoreHivewarddTerminalAuthority } from './hivewardd-restored-terminal-authority'

describe('restoreHivewarddTerminalAuthority', () => {
  it('opens each latch only once its phase is done, with reconcile ungated in between', async () => {
    const readiness = new HivewarddFeatureReadiness(['orchestration', 'unshownPlacement'])
    const latches = (): string =>
      `orchestration=${readiness.isOpen('orchestration')} placement=${readiness.isOpen('unshownPlacement')}`
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the two restore phases are called.
    const runtime = {
      refreshRestoredOrchestrationAuthority: async () => {
        steps.push(`orchestration ${latches()}`)
      },
      reconcileLegacyWorkerTerminals: async () => {
        steps.push(`reconcile ${latches()}`)
      }
    } as unknown as HiveWardRuntimeService

    await restoreHivewarddTerminalAuthority(runtime, (_name, run) => run(), readiness)

    expect(steps).toEqual([
      'orchestration orchestration=false placement=false',
      'reconcile orchestration=true placement=false',
      'placement'
    ])
    expect(readiness.isOpen('unshownPlacement')).toBe(true)
  })
})
