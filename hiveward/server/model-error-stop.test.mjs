import test from 'node:test'
import assert from 'node:assert/strict'
import { droppedQueuedMessages, errorStopReason } from './model-error-stop.mjs'
import * as screens from './model-error-screens-fixture.mjs'

for (const [text, reason] of [
  [screens.KIMI_QUOTA, 'quota'],
  [screens.CLAUDE_USAGE, 'quota'],
  [screens.CLAUDE_OVERLOADED, 'overloaded'],
  [screens.CLAUDE_AUTH, 'auth'],
  [screens.CODEX_USAGE, 'quota'],
  [screens.CODEX_RATE, 'rate_limit']
]) {
  test(`引擎 errored 提醒分类为 ${reason}：${text.slice(0, 35)}`, () => {
    assert.equal(errorStopReason(text), reason)
  })
}

test('Kimi 丢掉的排队消息：认出原文，去重', () => {
  assert.deepEqual(droppedQueuedMessages(screens.KIMI_QUOTA), ['顺便把页脚的电话也改成 400 开头的'])
  assert.deepEqual(
    droppedQueuedMessages(
      'Queued message dropped: 甲\nQueued message dropped: 甲\nQueued message dropped: 乙'
    ),
    ['甲', '乙']
  )
  assert.deepEqual(droppedQueuedMessages(screens.CLAUDE_USAGE), [])
})

test('Kimi 丢掉的消息在当前一屏以上也能识别', () => {
  const history = `Queued message dropped: 原始消息\n${'后续输出\n'.repeat(120)}`
  assert.deepEqual(droppedQueuedMessages(history), ['原始消息'])
})
