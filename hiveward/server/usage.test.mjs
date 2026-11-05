import { test } from 'node:test'
import assert from 'node:assert/strict'
import { usageRoutes, usageSummary } from './usage.mjs'

const win = (usedPercent, windowMinutes, resetsAt = null) => ({
  usedPercent,
  windowMinutes,
  resetsAt,
  resetDescription: null
})

test('只列有数据的那几家，百分比夹在 0–100，重置时间转成 ISO', () => {
  const r = usageSummary({
    claude: {
      provider: 'claude',
      session: win(12.5, 300, Date.UTC(2026, 10, 3, 12)),
      weekly: win(130, 10080),
      status: 'ok',
      error: null,
      updatedAt: 1,
      planType: 'max'
    },
    codex: {
      provider: 'codex',
      session: null,
      weekly: null,
      status: 'idle',
      error: null,
      updatedAt: 0
    },
    kimi: {
      provider: 'kimi',
      session: null,
      weekly: null,
      status: 'error',
      error: '没登录',
      updatedAt: 0
    },
    grok: null
  })
  assert.deepEqual(
    r.providers.map((p) => p.id),
    ['claude', 'kimi']
  )
  const claude = r.providers[0]
  assert.equal(claude.plan, 'max')
  assert.deepEqual(
    claude.windows.map((w) => [w.label, w.usedPercent]),
    [
      ['5 小时', 12.5],
      ['每周', 100]
    ]
  )
  assert.equal(claude.windows[0].resetsAt, '2026-11-03T12:00:00.000Z')
  assert.equal(r.providers[1].error, '没登录')
})

test('不在桌面 App 里（没有 usage）就没有这个接口；引擎还没算出来时 available 为 false', async () => {
  assert.deepEqual(usageRoutes(undefined), [])
  assert.deepEqual(usageSummary(null), { available: false, providers: [] })
  const [[, , get]] = usageRoutes({ getState: () => null, refresh: async () => null })
  assert.equal((await get()).available, false)
})
