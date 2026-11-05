import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { orchestrationFixture } from './tests/orchestration-module-fixture.mjs'
import { topology } from './orchestration.mjs'
import { summarizeSeat } from './seat-occupants.mjs'

const seat = {
  terminal: 'term_ceo',
  occupant: { kind: 'terminal', terminal: 'term_ceo' },
  agent: 'claude'
}
const detail = (id, workspacePath, ceo) => ({
  business: {
    id,
    name: id,
    workspacePath,
    status: 'active',
    ceo,
    projects: [],
    counts: { tasksOpen: 0, tasksDone: 0, decisionsPending: 0 }
  },
  workers: [],
  tasks: []
})

test('座位终端关了投影成 offline，不是故障', () => {
  const ceo = summarizeSeat(seat, [], [])
  assert.equal(ceo.state, 'offline')
  const { nodes } = topology([detail('b', '/b', ceo)], [], false, [detail('b', '/b', ceo)])
  assert.equal(nodes.find((n) => n.id === 'ceo:b').state, 'offline')
  assert.equal(nodes.find((n) => n.id === 'business:b').attention, false)
})

test('终端已释放 / 停掉 / 放弃 / 复核通过的派单不再作为在线下属', async (t) => {
  for (const settle of ['released', 'stopped', 'abandoned', 'accepted']) {
    await t.test(settle, async (sub) => {
      const f = await orchestrationFixture(sub)
      if (settle === 'released') {
        f.shown.terminal = null
      } else if (settle === 'accepted') {
        f.report()
        f.messages.unshift({
          id: 'accepted',
          run_id: f.run.id,
          from_handle: f.run.coordinator_handle,
          type: 'status',
          payload: JSON.stringify({
            hivewardReview: {
              taskId: f.task.id,
              dispatchId: f.task.dispatch_id,
              verdict: 'accept',
              reviewedBy: { kind: 'agent', id: f.run.coordinator_handle },
              acceptedAt: '2026-11-04T12:00:00Z'
            }
          })
        })
      } else {
        f.shown.worker.state = settle
        f.shown.dispatch.lastFailure = settle
      }
      const source = await f.project()
      assert.equal(source.dispatches[0].online, false)
      const { nodes } = topology([], source.dispatches, true, [])
      assert.equal(
        nodes.some((n) => n.kind === 'worker'),
        false
      )
    })
  }
})

test('活的待复核派单仍作为在线下属', async (t) => {
  const f = await orchestrationFixture(t)
  f.report()
  const source = await f.project()
  assert.equal(source.dispatches[0].online, true)
  const { nodes } = topology([], source.dispatches, true, [])
  assert.equal(nodes.find((n) => n.kind === 'worker').review, 'awaiting')
})

test('历史派单投影成已结算，不算进行中', async (t) => {
  const f = await orchestrationFixture(t)
  await writeFile(
    join(f.root, 'dispatches.json'),
    JSON.stringify([
      { id: 'old_open', prompt: '旧进行中', status: 'dispatched', by: { kind: 'cli', id: 'old' } },
      { id: 'old_done', prompt: '旧完成', status: 'completed', by: { kind: 'cli', id: 'old' } }
    ])
  )
  const rows = f.api.legacyDispatches().map((row) => f.api.dispatchTask(row, ''))
  const open = rows.find((row) => row.id === 'old_open')
  assert.equal(open.historical, true)
  assert.equal(open.status, 'failed')
  assert.equal(open.review, undefined)
  assert.equal(rows.find((row) => row.id === 'old_done').status, 'completed')
})

test('派单方停掉 / 放弃的 Task 投影成失败，不算待决策', async (t) => {
  for (const lastFailure of ['stopped', 'abandoned']) {
    await t.test(lastFailure, async (sub) => {
      const f = await orchestrationFixture(sub)
      f.task.status = 'blocked'
      f.shown.worker.state = lastFailure
      f.shown.dispatch.lastFailure = lastFailure
      assert.equal((await f.project()).orphanTasks[0].status, 'failed')
    })
  }
})

test('已汇报又被停掉的派单不保留待复核', async (t) => {
  const f = await orchestrationFixture(t)
  f.report()
  f.shown.worker.state = 'stopped'
  f.shown.dispatch.lastFailure = 'stopped'
  const task = (await f.project()).orphanTasks[0]
  assert.equal(task.status, 'failed')
  assert.equal(task.review, undefined)
})
