import test from 'node:test'
import assert from 'node:assert/strict'
import { hivewardWorkerStartFixture } from './tests/hiveward-worker-start-fixture.mjs'
import { orchestrationFixture } from './tests/orchestration-module-fixture.mjs'

test('Kimi 就绪失败说明失败阶段和下一步，不把未知结果说成失败', async () => {
  for (const state of ['failed', 'outcome_unknown']) {
    const f = await hivewardWorkerStartFixture({
      result: {
        state,
        failedStage: 'agent_readiness',
        lastError: 'timeout'
      }
    })
    await assert.rejects(
      f.startWorker(
        { agent: 'kimi', path: '/tmp/project', prompt: '回复 OK' },
        { kind: 'agent', id: 'caller' }
      ),
      (error) => {
        assert.match(error.message, /kimi 没有就绪/)
        assert.match(error.message, /登录、信任或确认提示/)
        assert.equal(error.message.includes('派单已失败'), state === 'failed')
        return error.code === 'worker_start_failed'
      }
    )
  }
})

test('就绪失败的 Task 投影保持失败及原因，网页关闭释放残留终端', async (t) => {
  const f = await orchestrationFixture(t)
  f.task.status = 'failed'
  f.shown.worker.state = 'failed'
  f.shown.worker.lastError = 'timeout'
  const snapshot = await f.project()
  assert.equal(snapshot.orphanTasks[0].status, 'failed')
  assert.equal(snapshot.orphanTasks[0].blockedReason, 'timeout')
  const api = await f.module('worker-close.mjs')
  const calls = []
  const closer = api.createWorkerCloser({
    call: async (method, params) => calls.push({ method, params })
  })
  await closer.closeNow('term_worker')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'orchestration.workerRelease')
  assert.equal(calls[0].params.dispatch, f.task.dispatch_id)
})
