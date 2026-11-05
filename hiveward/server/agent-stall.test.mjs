import test from 'node:test'
import assert from 'node:assert/strict'
import { findStartupDialogBlockedSignals } from '../../src/main/runtime/startup-dialog-blocked-signals.ts'

test('原生启动阻塞识别明确更新提示，不把任意回车当作准许', () => {
  assert.deepEqual(
    findStartupDialogBlockedSignals(
      'Unhandled exception\nPress ENTER to continue...'.toLowerCase()
    ),
    []
  )
  assert.equal(
    findStartupDialogBlockedSignals('update available\npress enter to continue')[0].reason,
    'agent-update-prompt'
  )
})

test('原生启动阻塞区分目录、模型迁移和 hooks 审查', () => {
  for (const [text, reason] of [
    ['choose working directory to\npress enter to continue', 'agent-cwd-prompt'],
    ['codex just got an upgrade\npress enter to continue', 'codex-model-migration-prompt'],
    ['hooks need review\npress enter to confirm', 'agent-hooks-review-prompt']
  ]) {
    assert.equal(findStartupDialogBlockedSignals(text)[0].reason, reason)
  }
})

test('原生启动阻塞保留最新提示位置，不把会话中选择器当启动对话', () => {
  const heading = 'update available\npress enter to continue'
  assert.equal(
    findStartupDialogBlockedSignals(`${heading}\n${heading}`)[0].index,
    heading.length + 1
  )
  assert.deepEqual(findStartupDialogBlockedSignals('enter confirm · esc back'), [])
})
