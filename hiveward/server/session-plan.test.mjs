import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readPlan } from './session-plan.mjs'

for (const agent of ['claude', 'codex']) {
  test(`${agent} 计划走原生 readSession / task-list，不在桥接重读 JSONL`, async () => {
    const plan = {
      items: [{ text: '改代码', status: 'in_progress' }],
      updatedAt: '2026-11-04T00:00:00.000Z'
    }
    const path = `/tmp/hiveward-not-opened-${agent}.jsonl`
    const result = await readPlan(agent, path, async (method, params) => {
      assert.equal(method, 'nativeChat.readSession')
      assert.deepEqual(params, { agent, sessionId: path, transcriptPath: path, limit: 2000 })
      return { hivewardTaskList: plan }
    })
    assert.deepEqual(result, plan)
  })
}

test('Kimi 原生 reader 尚不支持，保留 wire 增量计划读取', async () => {
  const root = await mkdtemp('/tmp/hiveward-kimi-plan-')
  const path = join(root, 'wire.jsonl')
  const line = (status) =>
    `${JSON.stringify({ timestamp: 1793700000, message: { type: 'ToolCall', payload: { function: { name: 'SetTodoList', arguments: JSON.stringify({ todos: [{ title: '提取音频', status }] }) } } } })}\n`
  try {
    await writeFile(path, line('doing'))
    assert.equal((await readPlan('kimi', path)).items[0].status, 'in_progress')
    await appendFile(path, line('done'))
    assert.deepEqual((await readPlan('kimi', path)).items, [
      { text: '提取音频', status: 'completed' }
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('原生 reader 错误必须传回，不从另一个会话猜计划', async () => {
  await assert.rejects(
    readPlan('claude', '/tmp/hiveward-plan.jsonl', async () => {
      throw new Error('连接断开')
    }),
    /连接断开/
  )
})

test('OpenCode todo 表尚无原生任务读取，保留准确的 SQLite 会话隔离', async () => {
  const root = await mkdtemp('/tmp/hiveward-opencode-plan-')
  const { openCodeDbFixture } = await import('./opencode-db-fixture.mjs')
  const path = join(root, 'opencode.db')
  const db = openCodeDbFixture(path)
  try {
    db.session('ses_plan', root, 1)
    db.todo('ses_plan', 0, '写测试', 'pending', 1000)
    db.todo('ses_plan', 1, '旧方案', 'cancelled', 2000)
    db.todo('other', 0, '其他会话', 'pending', 1000)
    assert.deepEqual((await readPlan('opencode', `${path}#ses_plan`)).items, [
      { text: '写测试', status: 'pending' },
      { text: '旧方案', status: 'completed' }
    ])
    assert.deepEqual((await readPlan('opencode', `${path}#ses_missing`)).items, [])
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})
