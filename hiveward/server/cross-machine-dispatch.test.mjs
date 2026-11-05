import test from 'node:test'
import assert from 'node:assert/strict'
import { hivewardWorkerStartFixture } from './tests/hiveward-worker-start-fixture.mjs'

test('跨实例派单在派单方创建原生 Task，交活身份保持源 coordinator', async () => {
  const party = { address: 'hiveward_session_id:hiveward_source', sessionId: 'hiveward_source' }
  const f = await hivewardWorkerStartFixture({ party })
  const worker = await f.startWorker(
    {
      path: '/tmp/hiveward-peer/project',
      on: 'peer',
      prompt: '输出成品',
      agent: 'kimi',
      model: 'model'
    },
    { kind: 'agent', id: 'source', cwd: '/tmp/hiveward-source/project' }
  )
  assert.equal(worker.runId, 'run_home')
  assert.equal(worker.identity, party)
  assert.equal(worker.dispatchId, 'ctx_remote')
  const start = f.calls.find((c) => c.method === 'orchestration.workerStart').params
  assert.equal(start.from, party.address)
  assert.equal(start.agent, 'kimi')
  assert.equal(start.model, 'model')
  assert.equal(start.spec, '输出成品')
  assert.equal(
    f.calls.some((c) => c.method === 'terminal.create' || c.method === 'terminal.send'),
    false
  )
})
