import { afterEach, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { HIVEWARD_BROWSER_GATE_METHODS } from '../rpc/methods/orchestration/hiveward-browser-gate-methods'

const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

it('HiveWard 浏览器 gate：原生 gate 与一次性消费记录共用 SQLite，拒绝错操作和重复消费', () => {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const run = db.createRun({
    objective: '浏览器审批',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: 'repo::worktree::term_coord'
  })
  const task = db.createTask({ runId: run.id, spec: '审批浏览器操作' })
  const gate = db.createGate({
    taskId: task.id,
    question: `HiveWard 浏览器操作确认：${JSON.stringify({ terminal: 'term_worker', action: 'click', reason: '发布', url: 'https://example.invalid', request: { ref: 'e1' } })}`,
    options: ['同意执行', '拒绝']
  })
  const method = HIVEWARD_BROWSER_GATE_METHODS[0]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: 此方法只消费 getOrchestrationDb，SQLite 使用真实原生存储。
  const context = { runtime: { getOrchestrationDb: () => db } } as Parameters<
    typeof method.handler
  >[1]
  const params = { gateId: gate.id, terminal: 'term_worker', question: gate.question }
  expect(method.handler(params, context)).toEqual({ consumed: false })
  db.resolveGate(gate.id, JSON.stringify({ choice: '同意执行', hivewardOwner: false }))
  expect(method.handler(params, context)).toEqual({ consumed: false })
  db.resolveGate(gate.id, JSON.stringify({ choice: '同意执行', hivewardOwner: true }))
  expect(method.handler({ ...params, question: '另一个操作' }, context)).toEqual({
    consumed: false
  })
  expect(method.handler({ ...params, terminal: 'term_other' }, context)).toEqual({
    consumed: false
  })
  expect(method.handler(params, context)).toEqual({ consumed: true })
  expect(method.handler(params, context)).toEqual({ consumed: false })
  expect(db.getMessageById(`hiveward_browser_gate_${gate.id}`)).toMatchObject({
    run_id: gate.run_id,
    from_handle: 'term_worker',
    delivery_contract: 'audit_only'
  })
})
