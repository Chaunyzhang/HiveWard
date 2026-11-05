import test from 'node:test'
import assert from 'node:assert/strict'
import { hivewardWorkerStartFixture } from './tests/hiveward-worker-start-fixture.mjs'

test('联邦派活只使用原生 source Task / Dispatch，不刷新远程 JSON 缓存', async (t) => {
  await t.test('目标环境和 Windows 路径原样交给 native workerStart', async () => {
    const f = await hivewardWorkerStartFixture()
    await f.startWorker(
      { on: 'peer', path: String.raw`C:\work\demo`, prompt: '检查', agent: 'codex' },
      { kind: 'agent', id: 'term_home', cwd: '/tmp/hiveward-home' }
    )
    const request = f.calls.find((c) => c.method === 'orchestration.workerStart').params
    assert.equal(request.on, 'peer')
    assert.equal(request.worktree, String.raw`path:C:\work\demo`)
    assert.equal(
      f.calls.some((c) => c.method === 'ensureRepo'),
      false
    )
  })
  await t.test('外部身份登记在派单方目录，不登记目标电脑路径', async () => {
    const f = await hivewardWorkerStartFixture({
      party: { address: 'hiveward_session_id:hiveward_external', sessionId: 'hiveward_external' }
    })
    await f.startWorker(
      { on: 'peer', path: '/remote/project', prompt: '检查' },
      { kind: 'agent', id: 'desktop', cwd: '/tmp/hiveward-home' }
    )
    assert.equal(
      f.calls.find((c) => c.method === 'resolveDispatcher').params.path,
      '/tmp/hiveward-home'
    )
    assert.equal(f.calls.find((c) => c.method === 'identity').params.sessionId, 'hiveward_external')
  })
  await t.test('同名远端终端使用 dispatch 地址，不绑定本机终端', async () => {
    const f = await hivewardWorkerStartFixture()
    const result = await f.startWorker(
      { on: 'peer', path: '/remote', prompt: '检查' },
      { kind: 'agent', id: 'term_home' }
    )
    assert.equal(result.terminal, 'dispatch:ctx_remote')
    assert.equal(result.execution.environmentId, 'environment_peer')
  })
  await t.test('原生联邦失败原样返回，不重试或返回旧缓存成功', async () => {
    const f = await hivewardWorkerStartFixture({
      error: Object.assign(new Error('peer_fenced'), { code: 'peer_fenced' })
    })
    await assert.rejects(
      f.startWorker(
        { on: 'peer', path: '/remote', prompt: '检查' },
        { kind: 'agent', id: 'term_home' }
      ),
      { code: 'peer_fenced' }
    )
    assert.equal(f.calls.filter((c) => c.method === 'orchestration.workerStart').length, 1)
  })
})
