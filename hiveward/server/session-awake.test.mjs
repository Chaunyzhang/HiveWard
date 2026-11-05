import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createSessionAwake } from './session-awake.mjs'

function fakeService(mode = 'auto') {
  const s = { mode, calls: [] }
  return {
    s,
    getStatus: () => ({ mode: s.mode, active: s.mode === 'on' }),
    setMode: (m) => {
      s.calls.push(m)
      s.mode = m
    }
  }
}

const readJson = async (req) => JSON.parse(await req.toArray().then((c) => c.join('')))

test('holds the engine awake while a session wants it, then restores the old mode', async () => {
  const service = fakeService('auto')
  let alive = ['a', 'b']
  const awake = createSessionAwake({ service, listHandles: async () => alive })
  try {
    awake.hold('a')
    awake.hold('b')
    assert.equal(service.s.mode, 'on')
    awake.release('a')
    assert.equal(service.s.mode, 'on', 'b 还按着')
    // b 的终端关了：巡检时松开，回到原来的 auto
    alive = ['a']
    await awake.prune()
    assert.equal(service.s.mode, 'auto')
    assert.deepEqual(awake.holding(), [])
    // 松开没按过的不动模式
    awake.release('zzz')
    assert.equal(service.s.calls.at(-1), 'auto')
  } finally {
    awake.dispose()
  }
})

test('routes: GET status, POST toggle, LAN cannot toggle', async () => {
  const service = fakeService('off')
  const awake = createSessionAwake({ service, listHandles: async () => ['t1'] })
  try {
    const [get, post] = awake.routes(readJson)
    const url = new URL('http://x/api/session-awake?handle=t1')
    assert.deepEqual(await get[2](null, [], url), {
      handle: 't1',
      on: false,
      active: false,
      mode: 'off'
    })
    const body = (o) => Readable.from([JSON.stringify(o)])
    assert.deepEqual(await post[2](body({ handle: 't1', on: true }), [], url, {}), {
      handle: 't1',
      on: true,
      active: true,
      mode: 'on'
    })
    await assert.rejects(post[2](body({ handle: 't1', on: false }), [], url, { isLan: true }), {
      status: 403
    })
    assert.equal((await post[2](body({ handle: 't1', on: false }), [], url, {})).mode, 'off')
    await assert.rejects(get[2](null, [], new URL('http://x/api/session-awake')), { status: 400 })
  } finally {
    awake.dispose()
  }
})
