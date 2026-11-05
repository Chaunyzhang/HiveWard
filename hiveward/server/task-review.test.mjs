import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { orchestrationFixture } from './tests/orchestration-module-fixture.mjs'

for (const status of ['pending', 'ready', 'dispatched', 'blocked', 'completed', 'failed']) {
  test(`Task ${status} 没有 worker_done 时绝不推断交活`, async (t) => {
    const f = await orchestrationFixture(t)
    f.task.status = status
    const s = await f.project()
    assert.equal(s.orphanTasks[0].status, status)
    assert.equal(s.orphanTasks[0].report, undefined)
    assert.equal(s.orphanTasks[0].review, undefined)
    assert.ok(f.calls.every((c) => c.method.startsWith('orchestration.')))
  })
}
for (const outcome of ['succeeded', 'failed']) {
  test(`只读 worker_done ${outcome} 的摘要、文件和报告路径`, async (t) => {
    const f = await orchestrationFixture(t)
    f.report(outcome)
    const s = await f.project()
    assert.equal(s.orphanTasks[0].report.outcome, outcome)
    assert.equal(s.orphanTasks[0].report.summary, f.messages[0].body)
    assert.equal(s.orphanTasks[0].report.filesModified[0], 'result.txt')
    assert.equal(s.orphanTasks[0].report.reportPath, '/tmp/report.md')
    assert.equal(s.orphanTasks[0].review.state, 'awaiting')
  })
}
for (const reason of ['finished', 'errored', 'needs-input', 'exited']) {
  test(`${reason} 提醒保持 Task 未结算，绝不进入待复核`, async (t) => {
    const f = await orchestrationFixture(t)
    f.messages.push({
      type: 'escalation',
      body: '最后一屏：测试输出',
      created_at: '2026-11-04T11:00:00Z',
      payload: JSON.stringify({
        dispatchId: f.task.dispatch_id,
        stopReason: reason
      })
    })
    const s = await f.project()
    assert.equal(s.dispatches[0].turnStop.reason, reason)
    assert.equal(s.orphanTasks[0].report, undefined)
    assert.equal(s.orphanTasks[0].review, undefined)
    assert.equal(!!s.orphanTasks[0].errorStop, reason === 'errored')
  })
}
for (const mismatch of ['dispatchId', 'outcome']) {
  test(`worker_done 的 ${mismatch} 不匹配时不产生汇报`, async (t) => {
    const f = await orchestrationFixture(t)
    f.report()
    const payload = JSON.parse(f.messages[0].payload)
    payload[mismatch] = 'invalid'
    f.messages[0].payload = JSON.stringify(payload)
    assert.equal((await f.project()).orphanTasks[0].report, undefined)
  })
}
for (const outcome of ['succeeded', 'failed']) {
  for (const kind of ['owner', 'agent']) {
    test(`${kind} 接受 ${outcome} 汇报，通过引擎释放并保存工作记录`, async (t) => {
      const f = await orchestrationFixture(t)
      f.report(outcome)
      await f.project()
      const review = await f.module('task-review.mjs')
      const result = await review.reviewTask(
        f.task.id,
        { verdict: 'accept' },
        { kind, id: f.run.coordinator_handle }
      )
      assert.equal(result.release.state, 'released')
      assert.equal(result.task.review.state, 'accepted')
      assert.equal(f.records.length, 1)
      assert.ok(
        f.calls.some(
          (c) =>
            c.method === 'orchestration.workerRelease' && c.params.dispatch === f.task.dispatch_id
        )
      )
      assert.ok(!f.calls.some((c) => c.method.startsWith('terminal.')))
      assert.equal((await f.project()).orphanTasks[0].review.state, 'accepted')
    })
  }
}
for (const kind of ['owner', 'agent']) {
  test(`${kind} 打回走 dispatch 地址后续 Task，不往终端写字`, async (t) => {
    const f = await orchestrationFixture(t)
    f.report()
    await f.project()
    const review = await f.module('task-review.mjs')
    const result = await review.reviewTask(
      f.task.id,
      { verdict: 'rework', note: '补检查结果' },
      { kind, id: f.run.coordinator_handle }
    )
    assert.equal(result.followUp.message.id, 'message_followup')
    const sent = f.calls.find((c) => c.method === 'orchestration.send')
    assert.equal(sent.params.to, `dispatch:${f.task.dispatch_id}`)
    assert.equal(sent.params.body, '补检查结果')
    assert.equal(f.records.length, 0)
    assert.ok(!f.calls.some((c) => c.method.startsWith('terminal.')))
  })
}
for (const [body, status] of [
  [{ verdict: 'wrong' }, 400],
  [{ verdict: 'rework' }, 400],
  [{ verdict: 'accept', note: 2 }, 400]
]) {
  test(`复核参数 ${JSON.stringify(body)} 拒绝且无副作用`, async (t) => {
    const f = await orchestrationFixture(t)
    const review = await f.module('task-review.mjs')
    await assert.rejects(review.reviewTask(f.task.id, body, { kind: 'owner' }), { status })
    assert.equal(f.calls.length, 0)
  })
}
for (const caller of [
  { kind: 'agent', id: '' },
  { kind: 'agent', id: 'term_stranger' }
]) {
  test(`其他派单方 ${caller.id || '缺身份'} 不可复核`, async (t) => {
    const f = await orchestrationFixture(t)
    f.report()
    await f.project()
    const review = await f.module('task-review.mjs')
    await assert.rejects(review.reviewTask(f.task.id, { verdict: 'accept' }, caller), {
      status: 403
    })
    assert.ok(!f.calls.some((c) => c.method === 'orchestration.workerRelease'))
  })
}
for (const verdict of ['accept', 'rework']) {
  test(`没有 worker_done 时 ${verdict} 被拒绝`, async (t) => {
    const f = await orchestrationFixture(t)
    await f.project()
    const review = await f.module('task-review.mjs')
    await assert.rejects(
      review.reviewTask(f.task.id, { verdict, note: '补充' }, { kind: 'owner' }),
      { status: 409 }
    )
  })
}
test('历史 dispatches.json 只读，不再进入当前派单与复核判断', async (t) => {
  const f = await orchestrationFixture(t)
  const text = JSON.stringify([
    {
      id: 'dsp_old',
      prompt: '旧任务',
      status: 'completed',
      review: { state: 'awaiting' },
      by: { kind: 'owner', id: 'old' }
    }
  ])
  const path = join(f.root, 'dispatches.json')
  await writeFile(path, text)
  const rows = f.api.legacyDispatches()
  assert.equal(rows[0].historical, true)
  assert.equal(rows[0].review, undefined)
  await f.project()
  assert.ok(!f.api.dispatches().some((d) => d.id === 'dsp_old'))
  assert.equal(await readFile(path, 'utf8'), text)
})

test('复核通过用原生留档消息，不成为复核人自己的未读', async (t) => {
  const f = await orchestrationFixture(t)
  f.report()
  await f.project()
  const review = await f.module('task-review.mjs')
  await review.reviewTask(f.task.id, { verdict: 'accept' }, { kind: 'owner' })
  const sent = f.calls.find((c) => c.method === 'orchestration.send')
  assert.equal(sent.params.type, 'heartbeat')
  assert.equal(JSON.parse(sent.params.payload).dispatchId, undefined)
  assert.equal(JSON.parse(sent.params.payload).hivewardReview.dispatchId, f.task.dispatch_id)
  assert.equal(f.messages.find((m) => m.id !== 'done_test').type, 'heartbeat')
  assert.equal((await f.project()).dispatches[0].review.state, 'accepted')
})

test('Agent 对派出去的 Agent 说话用它自己的身份发到 dispatch 地址', async (t) => {
  const f = await orchestrationFixture(t)
  f.report()
  await f.project()
  const dispatches = await f.module('dispatches.mjs')
  await dispatches.recordTerminalTell('term_worker', '接着做 B', { address: 'term_other' })
  const sent = f.calls.filter((c) => c.method === 'orchestration.send')
  assert.deepEqual(
    sent.map((c) => [c.params.from, c.params.to, c.params.body]),
    [['term_other', `dispatch:${f.task.dispatch_id}`, '接着做 B']]
  )
})

for (const [title, expected] of [
  ['复核没通过', 'rework'],
  ['后续安排', undefined]
]) {
  test(`交活后原单上开出「${title}」的下一轮：复核状态 ${expected ?? '不再等复核'}`, async (t) => {
    const f = await orchestrationFixture(t)
    f.report()
    f.followUp(title)
    const s = await f.project()
    assert.equal(s.orphanTasks.find((x) => x.id === f.task.id).review?.state, expected)
  })
}

test('交活后先复核通过、老板再接着说话：仍显示已通过', async (t) => {
  const f = await orchestrationFixture(t)
  f.report()
  await f.project()
  const review = await f.module('task-review.mjs')
  await review.reviewTask(f.task.id, { verdict: 'accept' }, { kind: 'owner' })
  f.followUp('后续安排')
  const s = await f.project()
  assert.equal(s.orphanTasks.find((x) => x.id === f.task.id).review.state, 'accepted')
})
