import { afterEach, expect, it } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

const h = createOrchestrationWorkerReleaseHarness()
afterEach(() => h.cleanup())

it.each(['failed'] as const)('keeps a %s report until explicit review release', async (outcome) => {
  h.setup()
  h.runtime.setOrchestrationDb(h.db)
  const { taskId, dispatchId } = await h.startWorker()
  h.settle(taskId, dispatchId, outcome)
  expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
    ownership_state: 'owned',
    release_state: 'not_requested',
    auto_release_at: null
  })
  expect(h.db.claimDueWorkerTerminalAutoReleases(Date.now() + 24 * 60 * 60_000)).toBe(0)
  expect(await h.call('orchestration.workerRelease', { dispatch: dispatchId })).toMatchObject({
    state: 'released'
  })
})
