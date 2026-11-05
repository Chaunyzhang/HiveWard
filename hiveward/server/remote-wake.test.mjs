import test from 'node:test'
import assert from 'node:assert/strict'
import { createAgentWakeService } from './agent-wake.mjs'

test('联邦交活从派单方原生 check 读取，不再接收自家远程唤醒', async () => {
  const calls = []
  const service = createAgentWakeService({
    call: async (method, params, envelope) => {
      calls.push({ method, params, envelope })
      return { messages: [{ type: 'worker_done' }] }
    }
  })
  const result = await service.waitForInbox(
    { address: 'hiveward_session_id:hiveward_home', sessionId: 'hiveward_home' },
    1000
  )
  assert.equal(result.messages[0].type, 'worker_done')
  assert.equal(calls[0].method, 'orchestration.check')
  assert.equal(calls[0].envelope.hivewardSessionId, 'hiveward_home')
  assert.equal(service.receiveRemote, undefined)
})
