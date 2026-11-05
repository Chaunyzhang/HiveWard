import type { HiveWardRuntimeService } from '../hiveward-runtime'

export const availableRevealWorkspace: HiveWardRuntimeService['prepareStructuredAgentSessionRevealWorkspace'] =
  async () => ({
    current: () => true,
    check: () => {},
    release: Object.assign(() => {}, { isCurrent: () => true })
  })
