import test from 'node:test'
import assert from 'node:assert/strict'
import { orchestrationFixture } from './tests/orchestration-module-fixture.mjs'

for (const reported of [true, false]) {
  test(`手动关闭${reported ? '已汇报' : '未汇报'}下属调用引擎 ${reported ? 'release' : 'stop'}`, async (t) => {
    const f = await orchestrationFixture(t)
    if (reported) {
      f.report()
    }
    await f.project()
    const api = await f.module('worker-close.mjs')
    const calls = []
    const closer = api.createWorkerCloser({
      call: async (method, params) => calls.push({ method, params })
    })
    await closer.closeNow('term_worker')
    assert.equal(
      calls[0].method,
      reported ? 'orchestration.workerRelease' : 'orchestration.workerStop'
    )
    assert.equal(calls[0].params.dispatch, f.task.dispatch_id)
  })
}
test('网页关闭保留五秒撤销，撤销不会调用引擎', async (t) => {
  const f = await orchestrationFixture(t)
  const api = await f.module('worker-close.mjs')
  let calls = 0
  const closer = api.createWorkerCloser({ now: () => 1000, call: async () => calls++ })
  assert.equal(closer.requestClose('term_worker').closeAt, new Date(6000).toISOString())
  assert.ok(api.closingWorkers().has('term_worker'))
  assert.equal(closer.undo('term_worker'), true)
  assert.equal(closer.undo('term_worker'), false)
  assert.equal(calls, 0)
  closer.close()
})
test('重复点击关闭不会延长撤销期', async (t) => {
  const f = await orchestrationFixture(t)
  const api = await f.module('worker-close.mjs')
  let now = 1000
  const closer = api.createWorkerCloser({ now: () => now, call: async () => {} })
  const first = closer.requestClose('term_worker')
  now = 2000
  assert.equal(closer.requestClose('term_worker').closeAt, first.closeAt)
  closer.close()
})
test('CEO / Leader 座位不在下属关闭入口处理', async (t) => {
  const f = await orchestrationFixture(t)
  const api = await f.module('worker-close.mjs')
  const closer = api.createWorkerCloser({ call: async () => {}, seats: () => new Set(['leader']) })
  assert.throws(() => closer.requestClose('leader'), { code: 'not_worker' })
  closer.close()
})
test('没有编排下属不直接关终端；移除三十分钟巡检入口', async (t) => {
  const f = await orchestrationFixture(t)
  const api = await f.module('worker-close.mjs')
  const closer = api.createWorkerCloser({ call: async () => {} })
  await assert.rejects(closer.closeNow('missing'), { code: 'not_worker' })
  assert.equal(closer.observe, undefined)
  closer.close()
})
