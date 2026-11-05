import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 只读这里造的对话记录，不碰真实 ~/.claude
const home = mkdtempSync(join(tmpdir(), 'hw-seat-session-'))
process.env.HOME = home
const { summarizeSeat } = await import('./seat-occupants.mjs')
test.after(() => rmSync(home, { recursive: true, force: true }))

const cwd = '/tmp/hw-seat-cwd'
let next = 0
function sessionWith(records, ageMs = 0) {
  const sessionId = `session-${++next}`
  const dir = join(home, '.claude/projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sessionId}.jsonl`)
  writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`)
  const at = (Date.now() - ageMs) / 1000
  utimesSync(file, at, at)
  return {
    occupant: { kind: 'session', sessionId, agent: 'claude-desktop', cwd },
    agent: 'claude-desktop'
  }
}
const ask = {
  type: 'user',
  message: { role: 'user', content: '查一下为什么空闲' },
  timestamp: '2026-11-05T15:00:00Z',
  uuid: 'u1'
}
const toolUse = (name, id = 't1') => ({
  type: 'assistant',
  message: {
    role: 'assistant',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id, name, input: {} }]
  },
  timestamp: '2026-11-05T15:00:05Z',
  uuid: `a-${id}`
})
const done = {
  type: 'assistant',
  message: {
    role: 'assistant',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: '查清了' }]
  },
  timestamp: '2026-11-05T15:01:00Z',
  uuid: 'a-done'
}

test('外部会话一轮没结束算干活', () => {
  const s = summarizeSeat(sessionWith([ask, toolUse('Bash')]), [], [])
  assert.equal(s.state, 'working')
  assert.equal(s.liveness, 'live')
})
test('外部会话这轮结束了算空闲', () => {
  const s = summarizeSeat(sessionWith([ask, toolUse('Bash'), done]), [], [])
  assert.equal(s.state, 'idle')
  assert.equal(s.activity, '查清了')
})
test('外部会话在问老板算等待', () => {
  assert.equal(
    summarizeSeat(sessionWith([ask, toolUse('AskUserQuestion')]), [], []).state,
    'pending'
  )
})
test('干到一半 30 分钟没动静，不再担保它活着', () => {
  const s = summarizeSeat(sessionWith([ask, toolUse('Bash')], 31 * 60 * 1000), [], [])
  assert.equal(s.state, 'working')
  assert.equal(s.liveness, 'unverifiable')
})
test('结束了的会话放多久都还是空闲、活着', () => {
  const s = summarizeSeat(sessionWith([ask, done], 5 * 60 * 60 * 1000), [], [])
  assert.equal(s.state, 'idle')
  assert.equal(s.liveness, 'live')
})
test('找不到对话记录时保持未知', () => {
  const s = summarizeSeat(
    { occupant: { kind: 'session', sessionId: 'missing', agent: 'claude-desktop', cwd } },
    [],
    []
  )
  assert.equal(s.liveness, 'unverifiable')
  assert.equal(s.state, 'idle')
})
