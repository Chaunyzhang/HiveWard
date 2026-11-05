import test from 'node:test'
import assert from 'node:assert/strict'
import { hivewardWorkerChat } from './hiveward-worker-chat.mjs'
import { showDispatchTasks } from './dispatch-prompt.mjs'
import {
  hivewardBrowserGateQuestion,
  consumeHivewardBrowserGate
} from './hiveward-browser-gate.mjs'

test('原生 worker transcript 保留推理角色、身份与分页，不猜下属交活', () => {
  const native = {
    source: 'transcript',
    sourceIdentity: 'hiveward-source',
    provider: 'codex',
    cursor: 'hiveward-cursor',
    transcript: {
      limited: true,
      messages: [
        { id: 'r1', role: 'reasoning', blocks: [{ type: 'text', text: '分析过程' }] },
        { id: 'a1', role: 'assistant', blocks: [{ type: 'text', text: '完成了' }] }
      ]
    },
    warnings: ['截断'],
    fallbackReason: null
  }
  const chat = hivewardWorkerChat(native)
  assert.deepEqual(
    chat.items.map((i) => [i.kind, i.text]),
    [
      ['thinking', '分析过程'],
      ['assistant', '完成了']
    ]
  )
  assert.equal(chat.cursor, native.cursor)
  assert.equal(chat.limited, true)
  assert.equal(chat.native, native)
  assert.equal(chat.report, undefined)
})

test('引擎读出的派单前言只显示任务原文，截断的按任务编号取原文，收消息提示不显示，老板直接说的话原样', () => {
  const preamble = (id, body) =>
    `You are working inside HiveWard, a multi-agent IDE.\nYour task ID is: ${id}\n=== TASK ===\n${body}`
  const native = {
    transcript: {
      messages: [
        { id: 'u1', role: 'user', blocks: [{ type: 'text', text: preamble('task_a', '做 A') }] },
        {
          id: 'u2',
          role: 'user',
          blocks: [{ type: 'text', text: `${preamble('task_b', '').slice(0, 76)}\n… (truncated)` }]
        },
        {
          id: 'n1',
          role: 'user',
          blocks: [
            {
              type: 'text',
              text: '\nYou have 1 orchestration message. Run `hiveward orchestration check --run run_1`.\n'
            }
          ]
        },
        { id: 'u3', role: 'user', blocks: [{ type: 'text', text: '顺便看看 C' }] }
      ]
    }
  }
  const chat = showDispatchTasks(hivewardWorkerChat(native), (id) =>
    id === 'task_b' ? '做 B 的原文' : undefined
  )
  assert.deepEqual(
    chat.items.map((i) => i.text),
    ['做 A', '做 B 的原文', '顺便看看 C']
  )
})

test('浏览器批准绑定完整动作、页面与 Agent，确认参数不进入待批准内容', async () => {
  const question = hivewardBrowserGateQuestion(
    'term_worker',
    'click',
    '发布',
    'https://example.invalid',
    { ref: 'e1', confirm: 'gate_old' }
  )
  assert.equal(question.includes('gate_old'), false)
  assert.notEqual(
    question,
    hivewardBrowserGateQuestion('term_worker', 'click', '发布', 'https://example.invalid', {
      ref: 'e2'
    })
  )
  let calls = 0
  const call = async (method, params) => {
    calls++
    assert.equal(method, 'orchestration.hivewardBrowserGateConsume')
    assert.deepEqual(params, { terminal: 'term_worker', gateId: 'gate_1', question })
    return { consumed: true }
  }
  assert.equal(await consumeHivewardBrowserGate('term_worker', undefined, question, call), false)
  assert.equal(calls, 0)
  assert.equal(await consumeHivewardBrowserGate('term_worker', 'gate_1', question, call), true)
})
