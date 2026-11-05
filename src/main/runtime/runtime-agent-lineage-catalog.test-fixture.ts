import { vi } from 'vitest'
import { HiveWardRuntimeService } from './hiveward-runtime'
import { RpcDispatcher } from './rpc/dispatcher'
import { WORKTREE_CATALOG_METHODS } from './rpc/methods/worktree-catalog-methods'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import type { RuntimeAgentLineageCatalogTestModule } from '../../shared/runtime-agent-lineage-consumer.test-fixture'

export function createLineageCatalogDispatcher(build: () => RuntimeWorktreePsSummary) {
  const runtime = new HiveWardRuntimeService()
  vi.spyOn(runtime, 'getRuntimeId').mockReturnValue('lineage-test')
  vi.spyOn(runtime, 'getWorktreePs').mockImplementation(async () => ({
    worktrees: [build()],
    totalCount: 1,
    truncated: false
  }))
  return new RpcDispatcher({ runtime, methods: WORKTREE_CATALOG_METHODS })
}

export default { createLineageCatalogDispatcher } satisfies RuntimeAgentLineageCatalogTestModule
