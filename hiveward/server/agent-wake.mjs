import { dispatcherEnvelope } from './hiveward-dispatcher.mjs'
import { rpc } from './api-runtime.mjs'

export const formatWakeMessages = (messages) =>
  messages.map((message) => `${message.subject}\n${message.body}`).join('\n\n')

// 邮箱持久化、唤醒指针和投递状态均归引擎；这里仅兼容 hiwd inbox 的网页接口。
export function createAgentWakeService({ call = rpc } = {}) {
  return {
    async waitForInbox(party, timeoutMs) {
      const receipt = await call(
        'orchestration.check',
        {
          terminal: typeof party === 'string' ? party : party.address,
          wait: true,
          timeoutMs
        },
        typeof party === 'string' ? {} : dispatcherEnvelope(party)
      )
      return receipt
    },
    start() {},
    close() {}
  }
}
