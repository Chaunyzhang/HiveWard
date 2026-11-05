import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 时间线写进临时目录，不碰真实数据
const dir = mkdtempSync(join(tmpdir(), 'hw-idle-close-'))
process.env.HIVEWARD_DATA_DIR = dir
const {
  idleRunTerminals,
  createAutomationRunIdleCloser,
  patrolReady,
  AUTOMATION_RUN_IDLE_CLOSE_MS
} = await import('./automation-run-idle-close.mjs')
const { patrolSettings, setPatrolSettings } = await import('./patrol-settings.mjs')
const { recentTimelineEvents } = await import('./timeline.mjs')
test.after(() => rmSync(dir, { recursive: true, force: true }))

const HOUR = AUTOMATION_RUN_IDLE_CLOSE_MS
const now = Date.parse('2026-11-05T16:00:00Z')
const run = (n, extra = {}) => ({
  id: `run-${n}`,
  title: `HiveWard · GitHub run ${n}`,
  status: 'completed',
  sessionKind: 'terminal',
  terminalPtyId: `pty-${n}`,
  runContext: { path: '/repo' },
  ...extra
})
const terminal = (n) => ({ handle: `term-${n}`, ptyId: `pty-${n}` })
const done = (ago) => ({ status: 'idle', lastStatus: { state: 'done', stateStartedAt: now - ago } })

test('空闲满一小时的巡检终端关掉，不满的留着', () => {
  const closing = idleRunTerminals({
    runs: [run(1), run(2)],
    terminals: [terminal(1), terminal(2)],
    statuses: new Map([
      ['term-1', done(HOUR + 1)],
      ['term-2', done(HOUR - 60_000)]
    ]),
    seats: new Set(),
    now,
    idleMs: HOUR
  })
  assert.deepEqual(
    closing.map((c) => c.terminal.handle),
    ['term-1']
  )
})

test('在干活、在等权限、这轮还没结束的不关', () => {
  const closing = idleRunTerminals({
    runs: [run(1), run(2), run(3), run(4, { status: 'dispatched' })],
    terminals: [terminal(1), terminal(2), terminal(3), terminal(4)],
    statuses: new Map([
      ['term-1', { status: 'working', lastStatus: { state: 'working', stateStartedAt: 0 } }],
      ['term-2', { status: 'permission', lastStatus: { state: 'waiting', stateStartedAt: 0 } }],
      ['term-3', null],
      ['term-4', done(5 * HOUR)]
    ]),
    seats: new Set(),
    now,
    idleMs: HOUR
  })
  assert.deepEqual(closing, [])
})

test('老板接着跟它说话、又干完一轮，从这次结束重新算', () => {
  // 上一轮 3 小时前就结束了，但 10 分钟前又干完一轮：状态进入 done 的时间是 10 分钟前
  const closing = idleRunTerminals({
    runs: [run(1)],
    terminals: [terminal(1)],
    statuses: new Map([['term-1', done(10 * 60_000)]]),
    seats: new Set(),
    now,
    idleMs: HOUR
  })
  assert.deepEqual(closing, [])
})

test('座位上的终端、已经关掉的终端、聊天模式的运行都不碰', () => {
  const closing = idleRunTerminals({
    runs: [run(1), run(2), run(3, { sessionKind: 'chat' })],
    terminals: [terminal(1), terminal(3)],
    statuses: new Map([
      ['term-1', done(5 * HOUR)],
      ['term-3', done(5 * HOUR)]
    ]),
    seats: new Set(['term-1']),
    now,
    idleMs: HOUR
  })
  assert.deepEqual(closing, [])
})

test('巡检一遍：只管 HiveWard 项目定时巡检，关掉后记进时间线', async () => {
  const calls = []
  const call = async (method, params) => {
    calls.push([method, params])
    if (method === 'automation.list') {
      return {
        automations: [
          { id: 'auto-own', creationKey: 'hiveward-project-schedule:project-1' },
          { id: 'auto-other', creationKey: null }
        ]
      }
    }
    if (method === 'terminal.list') {
      return { terminals: [terminal(1), terminal(2)] }
    }
    if (method === 'automation.runs') {
      assert.equal(params.automationId, 'auto-own')
      return { runs: [run(1), run(2)] }
    }
    if (method === 'terminal.agentStatus') {
      return { agentStatus: params.terminal === 'term-1' ? done(2 * HOUR) : done(60_000) }
    }
    if (method === 'terminal.close') {
      return { close: { handle: params.terminal } }
    }
    throw new Error(`unexpected ${method}`)
  }
  const closer = createAutomationRunIdleCloser({
    call,
    now: () => now,
    seats: () => new Set(),
    projects: () => [
      { id: 'project-1', businessId: 'business-1', schedule: { automationId: 'auto-own' } }
    ]
  })
  assert.deepEqual(await closer.sweep(), ['term-1'])
  assert.deepEqual(
    calls.filter(([m]) => m === 'terminal.close'),
    [['terminal.close', { terminal: 'term-1' }]]
  )
  const [event] = recentTimelineEvents('business-1', 5)
  assert.equal(event.projectId, 'project-1')
  assert.match(event.title, /GitHub run 1 空闲满 60 分钟，自动关掉终端/)
})

test('没有 HiveWard 定时巡检时不读终端', async () => {
  const methods = []
  const closer = createAutomationRunIdleCloser({
    call: async (method) => {
      methods.push(method)
      return { automations: [{ id: 'x', creationKey: 'someone-else' }] }
    }
  })
  assert.deepEqual(await closer.sweep(), [])
  assert.deepEqual(methods, ['automation.list'])
})

test('空闲多久关按设置走：改成 30 分钟，空闲 40 分钟的就关', async () => {
  assert.deepEqual(patrolSettings(), { idleCloseMinutes: 60 })
  assert.throws(() => setPatrolSettings({ idleCloseMinutes: 5 }), { status: 400 })
  assert.throws(() => setPatrolSettings({ idleCloseMinutes: '30' }), { status: 400 })
  assert.deepEqual(setPatrolSettings({ idleCloseMinutes: 30 }), { idleCloseMinutes: 30 })
  try {
    const call = async (method, params) => {
      if (method === 'automation.list') {
        return { automations: [{ id: 'auto-own', creationKey: 'hiveward-project-schedule:p' }] }
      }
      if (method === 'terminal.list') {
        return { terminals: [terminal(1), terminal(2)] }
      }
      if (method === 'automation.runs') {
        return { runs: [run(1), run(2)] }
      }
      if (method === 'terminal.agentStatus') {
        return { agentStatus: done(params.terminal === 'term-1' ? 40 * 60_000 : 20 * 60_000) }
      }
      if (method === 'terminal.close') {
        return {}
      }
      throw new Error(`unexpected ${method}`)
    }
    const closer = createAutomationRunIdleCloser({
      call,
      now: () => now,
      seats: () => new Set(),
      projects: () => []
    })
    assert.deepEqual(await closer.sweep(), ['term-1'])
  } finally {
    setPatrolSettings({ idleCloseMinutes: 60 })
  }
})

test('前置检查：上一轮还在干活或在等权限就不巡检；空闲、问完老板在等回话的算做完', async () => {
  const states = new Map()
  const call = async (method, params) => {
    if (method === 'terminal.list') {
      return { terminals: [terminal(1), terminal(2)] }
    }
    if (method === 'automation.runs') {
      assert.equal(params.automationId, 'auto-own')
      // 这一轮自己还没开终端
      return { runs: [run(1), run(2), run(3, { status: 'dispatching', terminalPtyId: null })] }
    }
    if (method === 'terminal.agentStatus') {
      return { agentStatus: states.get(params.terminal) }
    }
    throw new Error(`unexpected ${method}`)
  }
  const project = { id: 'p', schedule: { automationId: 'auto-own' } }
  states.set('term-1', done(HOUR))
  states.set('term-2', done(60_000))
  assert.deepEqual(await patrolReady(project, call), { ready: true })
  states.set('term-2', { status: 'working', lastStatus: { state: 'working' } })
  assert.deepEqual(await patrolReady(project, call), {
    ready: false,
    busy: [{ run: 'run-2', terminal: 'term-2' }]
  })
  states.set('term-2', { status: 'permission', lastStatus: { state: 'waiting' } })
  assert.equal((await patrolReady(project, call)).ready, false)
  assert.deepEqual(await patrolReady({ id: 'p' }, call), { ready: true })
})
