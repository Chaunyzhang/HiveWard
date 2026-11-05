import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const data = await mkdtemp(join(tmpdir(), 'hiveward-quota-'))
process.env.HIVEWARD_DATA_DIR = data
const q = await import('./quota-stop.mjs')

test.after(() => rm(data, { recursive: true, force: true }))

const usage = (windows, updatedAt = new Date(10_000).toISOString()) => ({
  available: true,
  providers: [{ id: 'kimi', name: 'Kimi', status: 'ok', windows, updatedAt }]
})
const stop = { reason: 'quota', line: 'API error (429)', at: new Date(1000).toISOString() }
const row = (extra = {}) => ({
  id: 'task_k',
  dispatchId: 'dispatch_k',
  turnStop: { reason: 'errored', body: 'exceeded_current_quota', at: stop.at },
  handle: 'k1',
  agent: 'kimi',
  prompt: '改首页标题',
  by: { kind: 'cli', id: 'leader', label: 'Leader' },
  status: 'dispatched',
  errorStop: stop,
  ...extra
})

test('额度：用满的窗口里取最晚的恢复时间；引擎读不到的那家没有恢复时间', () => {
  const u = usage([
    { label: '5 小时', usedPercent: 100, resetsAt: '2026-11-03T03:25:00.000Z' },
    { label: '每周', usedPercent: 40, resetsAt: '2026-11-09T00:00:00.000Z' }
  ])
  assert.deepEqual(q.providerQuota(u, 'kimi'), {
    known: true,
    updatedAt: new Date(10_000).toISOString(),
    exhausted: true,
    resetsAt: '2026-11-03T03:25:00.000Z'
  })
  assert.equal(q.providerQuota(u, 'claude').known, false)
  const live = new Set(['k1'])
  const alerts = q.quotaAlerts(u, q.quotaStopped([row()], live))
  assert.deepEqual(alerts, [
    {
      agent: 'kimi',
      name: 'Kimi',
      exhausted: true,
      resetsAt: '2026-11-03T03:25:00.000Z',
      stopped: 1,
      handles: ['k1']
    }
  ])
  // 引擎没有 Kimi 的数据，但下属撞上了额度报错：照样提示，只是没有恢复时间
  assert.equal(q.quotaAlerts(null, q.quotaStopped([row()], live))[0].resetsAt, undefined)
  // 终端关了的、已经恢复的不算
  assert.equal(q.quotaStopped([row()], new Set()).size, 0)
  assert.equal(q.quotaStopped([row({ errorStop: { ...stop, reason: 'auth' } })], live).size, 0)
})

test('恢复时间那句：同一天只写时分，拿不到时间只写额度用完', () => {
  const now = new Date(2026, 10, 3, 1, 0).getTime()
  assert.equal(
    q.quotaLabel(new Date(2026, 10, 3, 3, 25).toISOString(), now),
    '额度用完 · 约 03:25 恢复'
  )
  assert.equal(
    q.quotaLabel(new Date(2026, 10, 4, 9, 5).toISOString(), now),
    '额度用完 · 约 11/4 09:05 恢复'
  )
  assert.equal(q.quotaLabel(undefined, now), '额度用完')
})

function resumer({ rows, usage: u, autoResume = true, clock }) {
  const sent = []
  const events = []
  const r = q.createQuotaResumer({
    call: async (method, params) => {
      if (method === 'terminal.read') {
        assert.equal(params.limit, 2000)
        return { terminal: { tail: [] } }
      }
      assert.equal(method, 'orchestration.send')
      sent.push(params)
    },
    readUsage: async () => u,
    now: () => clock.now,
    rows: () => rows,
    settings: () => ({ autoResume }),
    record: (event) => events.push(event)
  })
  return { r, sent, events }
}

test('到了恢复时间才叫下属接着做，丢掉的消息一并重发，写进时间线；不重复叫', async () => {
  const rows = [
    row(),
    row({
      id: 'dsp_lost',
      prompt: '顺便把页脚电话改成 400 开头',
      status: 'failed',
      dropped: { text: '顺便把页脚电话', at: stop.at }
    })
  ]
  await writeFile(join(data, 'dispatches.json'), JSON.stringify(rows))
  const clock = { now: 5000 }
  const u = usage([{ label: '5 小时', usedPercent: 100, resetsAt: new Date(60_000).toISOString() }])
  const { r, sent, events } = resumer({ rows, usage: u, clock })
  const terminals = [{ handle: 'k1', agent: 'kimi' }]
  await r.observe(terminals)
  assert.equal(sent.length, 0)
  clock.now = 60_000
  await r.observe(terminals)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].to, 'dispatch:dispatch_k')
  assert.match(sent[0].body, /^额度恢复了，接着做刚才的活/)
  assert.match(sent[0].body, /顺便把页脚电话改成 400 开头/)
  assert.match(events[0].title, /Kimi 额度恢复，已让下属接着做，并重发了出错时丢掉的 1 条消息/)
  const saved = JSON.parse(await readFile(join(data, 'dispatches.json'), 'utf8'))
  const lost = saved.find((d) => d.id === 'dsp_lost')
  assert.equal(lost.status, 'failed')
  assert.equal(lost.dropped.resentAt, undefined)
  assert.ok(rows[1].dropped.resentAt)
  clock.now += 1000
  await r.observe(terminals)
  assert.equal(sent.length, 1)
})

test('引擎显示又能用了（数据比报错新）就叫；数据比报错旧不作数；读不到额度的隔 30 分钟试一次；开关关了不叫', async () => {
  const clock = { now: 20_000 }
  let t = resumer({ rows: [row()], usage: usage([{ label: '5 小时', usedPercent: 30 }]), clock })
  await t.r.observe([{ handle: 'k1' }])
  assert.equal(t.sent.length, 1)

  t = resumer({
    rows: [row()],
    usage: usage([{ label: '5 小时', usedPercent: 30 }], new Date(500).toISOString()),
    clock
  })
  await t.r.observe([{ handle: 'k1' }])
  assert.equal(t.sent.length, 0)

  t = resumer({ rows: [row()], usage: null, clock })
  await t.r.observe([{ handle: 'k1' }])
  assert.equal(t.sent.length, 0)
  clock.now = 1000 + q.RESUME_RETRY_MS
  await t.r.observe([{ handle: 'k1' }])
  assert.equal(t.sent.length, 1)
  assert.equal(t.sent[0].body, q.RESUME_TEXT)

  t = resumer({ rows: [row()], usage: null, autoResume: false, clock })
  await t.r.observe([{ handle: 'k1' }])
  assert.equal(t.sent.length, 0)
})

test('「额度恢复后自动继续」默认开，存得下', () => {
  assert.equal(q.quotaSettings().autoResume, true)
  assert.deepEqual(q.saveQuotaSettings({ autoResume: false }), { autoResume: false })
  assert.equal(q.quotaSettings().autoResume, false)
  assert.throws(() => q.saveQuotaSettings({ autoResume: 'no' }), { code: 'bad_request' })
})
