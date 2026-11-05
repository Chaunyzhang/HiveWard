import test from 'node:test'
import assert from 'node:assert/strict'
import { createAgentWakeService, formatWakeMessages } from './agent-wake.mjs'

for (const type of ['worker_done', 'escalation', 'question', 'reply']) {
  test(`hiwd inbox 直接读取引擎 ${type} 邮箱，不写自己的收件箱或终端`, async () => {
    const calls = []
    const messages = [{ type, subject: '下属消息', body: '汇报正文' }]
    const service = createAgentWakeService({
      call: async (method, params) => {
        calls.push({ method, params })
        return { messages }
      }
    })
    assert.equal((await service.waitForInbox('term_leader', 5000)).messages, messages)
    assert.deepEqual(calls, [
      {
        method: 'orchestration.check',
        params: { terminal: 'term_leader', wait: true, timeoutMs: 5000 }
      }
    ])
    assert.match(formatWakeMessages(messages), /汇报正文/)
  })
}
test('引擎邮箱失败直接上报，不回退到 HiveWard 自建队列', async () => {
  const service = createAgentWakeService({
    call: async () => {
      throw new Error('engine down')
    }
  })
  await assert.rejects(service.waitForInbox('term_leader', 1), /engine down/)
})
