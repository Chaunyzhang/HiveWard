import test from 'node:test'
import assert from 'node:assert/strict'
import { orchestrationFixture } from './tests/orchestration-module-fixture.mjs'

test('联邦 Task / worker_done 仍投影本机原生存储；终端同名不借本机信息', async (t) => {
  const f = await orchestrationFixture(t)
  f.shown.server = { environmentId: 'environment_peer', name: 'peer' }
  const source = await f.project()
  const row = source.dispatches[0]
  assert.equal(row.handle, `dispatch:${row.dispatchId}`)
  assert.equal(row.execution.environmentId, 'environment_peer')
  f.report()
  const completed = await f.project()
  assert.equal(completed.dispatches[0].report.outcome, 'succeeded')
})
