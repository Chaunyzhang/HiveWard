import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeSeat } from './seat-occupants.mjs'
const seat = {
  terminal: 'term_leader',
  agent: 'claude',
  occupant: { kind: 'terminal', terminal: 'term_leader' }
}

test('原生下属已结束，座位不按文件时间伪造活跃', () => {
  const s = summarizeSeat(
    seat,
    [],
    [{ handle: seat.terminal, status: 'completed', liveness: 'exited' }]
  )
  assert.equal(s.liveness, 'exited')
  assert.equal(s.state, 'offline')
})
test('原生 permission 提醒等待输入，仍保留真实 liveness', () => {
  const s = summarizeSeat(
    seat,
    [{ handle: seat.terminal, agentStatus: { status: 'permission' } }],
    [
      {
        handle: seat.terminal,
        status: 'dispatched',
        liveness: 'live',
        turnStop: { reason: 'needs-input', body: '请确认' }
      }
    ]
  )
  assert.equal(s.state, 'pending')
  assert.equal(s.activity, '请确认')
  assert.equal(s.liveness, 'live')
})
test('外部座位没有原生运行证据时保持未知', () => {
  assert.equal(
    summarizeSeat({ occupant: { kind: 'session', sessionId: 'external' } }, [], []).liveness,
    'unverifiable'
  )
})
test('座位终端关了是离线，不是故障', () => {
  const s = summarizeSeat(seat, [], [])
  assert.equal(s.state, 'offline')
  assert.equal(s.liveness, 'unverifiable')
})
test('引擎报过错仍然算故障，即使终端已关', () => {
  const s = summarizeSeat(
    seat,
    [],
    [
      {
        handle: seat.terminal,
        status: 'failed',
        liveness: 'unverifiable',
        turnStop: { reason: 'errored' }
      }
    ]
  )
  assert.equal(s.state, 'failed')
})
test('原生 working 状态显示工作，不读取 transcript', () => {
  assert.equal(
    summarizeSeat(seat, [{ handle: seat.terminal, agentStatus: { status: 'working' } }], []).state,
    'working'
  )
})
test('crew 是原生投影，同步保留管理与被管理关系', () => {
  const crew = {
    status: 'ok',
    sections: {
      managedBy: [{ partyKey: 'manager' }],
      managing: [{ partyKey: 'worker' }],
      talkingWith: []
    }
  }
  assert.equal(summarizeSeat(seat, [], [], crew).crew, crew)
})
