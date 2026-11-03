import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStallDismisser, pausedForEnter } from './agent-stall.mjs'

test('只认最后一行非空的「Press ENTER to continue...」', () => {
  assert.equal(pausedForEnter('Exception boom\n\x1b[1mPress ENTER to continue...\x1b[0m\n\n'), true)
  // 按过之后它还留在上面，界面已经重画：不算
  assert.equal(pausedForEnter('Press ENTER to continue...\n• Used Shell\n── input ──'), false)
  assert.equal(pausedForEnter(''), false)
})

test('连续两轮都停着才按回车，只按跑着 Agent 的终端，记一条时间线', async () => {
  const screens = {
    k: 'Unhandled exception in event loop:\nPress ENTER to continue...',
    shell: 'Press ENTER to continue...'
  }
  const sent = []
  const events = []
  const call = async (method, params) => {
    if (method === 'terminal.read') {
      return { terminal: { tail: screens[params.terminal].split('\n') } }
    }
    sent.push(params)
    screens[params.terminal] = '── input ──'
    return {}
  }
  const stalls = createStallDismisser({ call, record: (e) => events.push(e) })
  const terminals = [
    { handle: 'k', agent: 'kimi', title: 'Kimi Code' },
    { handle: 'shell', agent: null }
  ]
  await stalls.observe(terminals)
  assert.deepEqual(sent, [])
  await stalls.observe(terminals)
  assert.deepEqual(sent, [{ terminal: 'k', text: '\r', enter: false }])
  assert.equal(events.length, 1)
  assert.match(events[0].title, /Kimi Code.*自动按回车/)
  await stalls.observe(terminals)
  assert.equal(sent.length, 1)
})

test('中间恢复过的不算连续', async () => {
  const screens = ['Press ENTER to continue...', '── input ──', 'Press ENTER to continue...']
  let round = 0
  const sent = []
  const call = async (method, params) =>
    method === 'terminal.read' ? { terminal: { tail: [screens[round]] } } : sent.push(params)
  const stalls = createStallDismisser({ call, record: () => {} })
  for (round = 0; round < 3; round++) {
    await stalls.observe([{ handle: 'k', agent: 'kimi' }])
  }
  assert.equal(sent.length, 0)
})
