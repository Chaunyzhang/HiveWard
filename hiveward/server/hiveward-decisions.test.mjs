import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveHivewardDecision, decisionScreenshot } from './hiveward-decisions.mjs'

const decision = {
  id: 'question_1',
  objectiveId: 'run_1',
  source: 'question',
  options: ['同意', '拒绝']
}
const run = { id: 'run_1', coordinatorAddress: 'term_leader' }
function transport(rows = [run]) {
  const calls = []
  return {
    calls,
    read: async (method) => {
      assert.equal(method, 'orchestration.runList')
      return { runs: rows }
    },
    send: async (...args) => {
      calls.push(args)
      return { message: { id: 'answer_1' } }
    }
  }
}

test('提问答复调用原生 reply，指定问题、运行与负责人', async () => {
  const t = transport()
  await resolveHivewardDecision(decision, { choice: '同意' }, { kind: 'owner' }, t.read, t.send)
  assert.deepEqual(t.calls, [
    [
      { address: 'term_leader', sessionId: undefined },
      'orchestration.reply',
      {
        id: 'question_1',
        run: 'run_1',
        from: 'term_leader',
        body: '同意'
      }
    ]
  ])
})

test('决策门直接 gateResolve，不能把状态邮件当作已解决', async () => {
  const t = transport()
  await resolveHivewardDecision(
    { ...decision, source: 'gate' },
    { choice: '同意', note: '先验证' },
    { kind: 'owner' },
    t.read,
    t.send
  )
  assert.equal(t.calls[0][1], 'orchestration.gateResolve')
  assert.deepEqual(JSON.parse(t.calls[0][2].resolution), {
    choice: '同意',
    note: '先验证',
    custom: false,
    hivewardOwner: true
  })
})

test('外部老板会话用原生 session envelope，保持邮箱身份', async () => {
  const t = transport([
    {
      ...run,
      coordinatorAddress: 'hiveward_session_id:hiveward_test',
      hivewardSession: { sessionId: 'hiveward_test', dispatcher: { id: '老板', kind: 'owner' } }
    }
  ])
  await resolveHivewardDecision(decision, { choice: '同意' }, { kind: 'owner' }, t.read, t.send)
  assert.equal(t.calls[0][0].sessionId, 'hiveward_test')
  assert.equal(t.calls[0][2].from, 'hiveward_session_id:hiveward_test')
})

test('其他 Agent 不能代负责人回答或拍板', async () => {
  const t = transport()
  await assert.rejects(
    resolveHivewardDecision(
      decision,
      { choice: '同意' },
      { kind: 'agent', id: 'term_other' },
      t.read,
      t.send
    ),
    { status: 403 }
  )
  assert.equal(t.calls.length, 0)
})

test('非法选项和空答案不能进入原生动作；自定义答案明确放行', async () => {
  const t = transport()
  for (const choice of ['', '别的']) {
    await assert.rejects(
      resolveHivewardDecision(decision, { choice }, { kind: 'owner' }, t.read, t.send),
      { status: 400 }
    )
  }
  assert.equal(t.calls.length, 0)
  await resolveHivewardDecision(
    decision,
    { choice: '补充说明', custom: true },
    { kind: 'agent', id: 'term_leader' },
    t.read,
    t.send
  )
  assert.equal(t.calls[0][2].body, '补充说明')
})

test('运行已消失时不能向猜测的负责人发送', async () => {
  const t = transport([])
  await assert.rejects(
    resolveHivewardDecision(decision, { choice: '同意' }, { kind: 'owner' }, t.read, t.send),
    { status: 404 }
  )
  assert.equal(t.calls.length, 0)
})

test('原生 RPC 拒绝必须传回，不能假装待办已解决', async () => {
  const t = transport()
  await assert.rejects(
    resolveHivewardDecision(decision, { choice: '同意' }, { kind: 'owner' }, t.read, async () => {
      throw new Error('consumer_fenced')
    }),
    /consumer_fenced/
  )
  assert.equal(decisionScreenshot('无截图'), undefined)
})

test('老板亲自派的单申请浏览器操作：选同意执行就建独立审批 Task 和 gate、批掉，再把 gate-id 回给 Agent', async () => {
  const question = 'HiveWard 浏览器操作确认：{"terminal":"term_worker","action":"eval"}'
  const owner = {
    ...run,
    coordinatorAddress: 'hiveward_session_id:hiveward_owner',
    hivewardSession: {
      sessionId: 'hiveward_owner',
      dispatcher: { id: 'hiveward-owner', kind: 'owner' }
    }
  }
  const calls = []
  const send = async (party, method, params) => {
    calls.push([method, params])
    if (method === 'orchestration.taskCreate') {
      return { task: { id: 'task_approval' } }
    }
    if (method === 'orchestration.gateCreate') {
      return { gate: { id: 'gate_1' } }
    }
    return {}
  }
  await resolveHivewardDecision(
    { ...decision, body: question, options: ['同意执行', '拒绝'] },
    { choice: '同意执行' },
    { kind: 'owner' },
    async () => ({ runs: [owner] }),
    send
  )
  assert.deepEqual(
    calls.map(([m]) => m),
    [
      'orchestration.taskCreate',
      'orchestration.gateCreate',
      'orchestration.gateResolve',
      'orchestration.taskUpdate',
      'orchestration.reply'
    ]
  )
  assert.equal(calls[1][1].question, question)
  assert.equal(calls[1][1].task, 'task_approval')
  assert.equal(JSON.parse(calls[2][1].resolution).hivewardOwner, true)
  assert.deepEqual([calls[3][1].id, calls[3][1].status], ['task_approval', 'completed'])
  assert.equal(calls[4][1].id, 'question_1')
  assert.match(calls[4][1].body, /--confirm gate_1/)
})

test('浏览器操作申请选拒绝、或负责人不是老板时只回话，不建 gate', async () => {
  const question = 'HiveWard 浏览器操作确认：{"terminal":"term_worker","action":"eval"}'
  const t = transport()
  await resolveHivewardDecision(
    { ...decision, body: question, options: ['同意执行', '拒绝'] },
    { choice: '同意执行' },
    { kind: 'owner' },
    t.read,
    t.send
  )
  const owner = transport([
    { ...run, hivewardSession: { sessionId: 's', dispatcher: { id: 'o', kind: 'owner' } } }
  ])
  await resolveHivewardDecision(
    { ...decision, body: question, options: ['同意执行', '拒绝'] },
    { choice: '拒绝' },
    { kind: 'owner' },
    owner.read,
    owner.send
  )
  assert.deepEqual(
    [...t.calls, ...owner.calls].map((c) => c[1]),
    ['orchestration.reply', 'orchestration.reply']
  )
})
