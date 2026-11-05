import test from 'node:test'
import assert from 'node:assert/strict'
import { bindHivewardSeat } from './hiveward-seat-runtime.mjs'
import { summarizeSeat } from './seat-occupants.mjs'

test('座位复用原生当前 Run，不另造首句队列', async () => {
  const calls = []
  const party = { address: 'term_leader' }
  const result = await bindHivewardSeat(party, '带项目', async (_party, method) => {
    calls.push(method)
    return { run: { id: 'run_existing' } }
  })
  assert.deepEqual(calls, ['orchestration.runCurrent'])
  assert.deepEqual(result, { party, runId: 'run_existing' })
})

test('新负责人使用原生 runCreate，保留真实 party 和任务说明', async () => {
  const party = { address: 'hiveward_session_id:hiveward_test', sessionId: 'hiveward_test' }
  const result = await bindHivewardSeat(party, '岗位职责', async (from, method, params) => {
    assert.equal(from, party)
    if (method === 'orchestration.runCurrent') {
      return { run: null }
    }
    assert.equal(method, 'orchestration.runCreate')
    assert.deepEqual(params, { from: party.address, objective: '岗位职责' })
    return { run: { id: 'run_created' } }
  })
  assert.equal(result.runId, 'run_created')
})

test('座位状态使用原生 worker 及 hook，不根据会话文件时间猜活跃', () => {
  const seat = {
    terminal: 'term_leader',
    agent: 'kimi',
    occupant: { kind: 'terminal', terminal: 'term_leader' }
  }
  const crew = { status: 'ok', sections: { managedBy: [], managing: [], talkingWith: [] } }
  const result = summarizeSeat(
    seat,
    [{ handle: 'term_leader', agentStatus: { status: 'waiting' } }],
    [
      {
        handle: 'term_leader',
        liveness: 'live',
        status: 'dispatched',
        turnStop: { reason: 'needs-input', body: '等人确认' }
      }
    ],
    crew
  )
  assert.equal(result.state, 'pending')
  assert.equal(result.activity, '等人确认')
  assert.equal(result.crew, crew)
  assert.equal(
    summarizeSeat({ occupant: { kind: 'session', sessionId: 'missing' } }, [], []).liveness,
    'unverifiable'
  )
})

test('Kimi defaults to K3.1 Pro and explicit models override for all providers', async () => {
  const { agentCommand } = await import('./business-terminals.mjs')
  assert.equal(agentCommand('kimi'), "kimi --yolo --model 'kimi-code/k3.1-pro'")
  // OpenCode 默认跑 OpenCode Go 的 DeepSeek 4.1 Flash，完全访问用 --auto
  assert.equal(
    agentCommand('opencode'),
    "opencode --auto --model 'opencode-go/deepseek-v4.1-flash'"
  )
  for (const agent of ['kimi', 'codex', 'claude', 'opencode']) {
    const command = agentCommand(agent, { model: 'explicit-model' })
    assert.match(command, /--model 'explicit-model'$/)
    assert.equal((command.match(/--model/g) ?? []).length, 1)
  }
  assert.doesNotMatch(agentCommand('claude'), /--model/)
  assert.doesNotMatch(agentCommand('codex'), /--model/)
})
