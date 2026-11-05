import { beforeEach, describe, vi } from 'vitest'
import { registerHeadlessCloseKeepsPublicationEpochTests } from './headless-close-keeps-publication-epoch.spec'
import { registerHeadlessTabOrderStabilityTests } from './headless-tab-order-stability.spec'
import { registerHiveWardRuntimeMoveHeadlessMobileSessionTabTests } from './hiveward-runtime-move-headless-mobile-session-tab.spec'
import { registerHiveWardRuntimeHeadlessHydrationRepoGateTests } from './hiveward-runtime-headless-hydration-repo-gate.spec'

const layoutOwner = vi.hoisted(() => ({ isMain: false }))
vi.mock('../../shared/layout-owner-switch', () => ({
  get HIVEWARD_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))

describe.each([false, true])('layout owner on main: %s', (isMain) => {
  beforeEach(() => {
    layoutOwner.isMain = isMain
  })

  registerHeadlessCloseKeepsPublicationEpochTests()
  registerHeadlessTabOrderStabilityTests()
  registerHiveWardRuntimeMoveHeadlessMobileSessionTabTests()
  registerHiveWardRuntimeHeadlessHydrationRepoGateTests()
})
