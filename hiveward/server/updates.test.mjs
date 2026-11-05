import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { updateRoutes } from './updates.mjs'

test('GET 只返回快照，局域网调用不能触发本机更新', async () => {
  let calls = 0
  const snapshot = { appVersion: '1.0.0', automatic: true, status: { state: 'idle' } }
  const routes = updateRoutes({
    snapshot: () => snapshot,
    check: () => {
      calls++
    }
  })
  const get = routes.find(([method]) => method === 'GET')[2]
  assert.deepEqual(await get(null, [], null, { isLan: false }), snapshot)
  assert.equal(calls, 0)
  const check = routes.find(([, pattern]) => pattern.test('/api/updates/check'))[2]
  await assert.rejects(check(null, [], null, { isLan: true }), /电脑上操作/)
  assert.equal(calls, 0)
  await check(null, [], null, { isLan: false })
  assert.equal(calls, 1)
})
test('自动检查开关必须明确传入布尔值', async () => {
  let enabled = true
  const route = updateRoutes({
    snapshot: () => ({ automatic: enabled }),
    setAutomatic: (value) => {
      enabled = value
    }
  }).find(([, pattern]) => pattern.test('/api/updates/automatic'))[2]
  await route(Readable.from(['{"enabled":false}']), [], null, { isLan: false })
  assert.equal(enabled, false)
  await assert.rejects(
    route(Readable.from(['{"enabled":"false"}']), [], null, { isLan: false }),
    /开关值/
  )
})

test('安装必须确认版本和 Agent 数量，确认前不启动安装', async () => {
  const installed = []
  const route = updateRoutes({
    snapshot: () => ({ status: { state: 'downloaded' } }),
    install: async (confirmation) => installed.push(confirmation)
  }).find(([, pattern]) => pattern.test('/api/updates/install'))[2]
  for (const body of [{}, { version: '1.1.0', workingAgents: -1 }]) {
    await assert.rejects(
      route(Readable.from([JSON.stringify(body)]), [], null, { isLan: false }),
      /需要确认/
    )
  }
  assert.equal(installed.length, 0)
  await route(Readable.from(['{"version":"1.1.0","workingAgents":3}']), [], null, { isLan: false })
  assert.deepEqual(installed, [{ version: '1.1.0', workingAgents: 3 }])
})
