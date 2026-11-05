import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../native-chat-types'
import { hivewardTaskList } from './hiveward-task-list'

function call(name: string, input: unknown, callId?: string): NativeChatMessage {
  return {
    id: callId ?? name,
    role: 'assistant',
    timestamp: 1000,
    source: 'transcript',
    blocks: [{ type: 'tool-call', name, input, callId }]
  }
}

it('HiveWard 计划沿用原生 TodoWrite / update_plan 归一化，最新整表替换', () => {
  const plan = hivewardTaskList([
    call('TodoWrite', { todos: [{ content: '旧计划', status: 'pending' }] }),
    call(
      'update_plan',
      JSON.stringify({
        plan: [
          { step: '扫描', status: 'completed' },
          { step: '修复', status: 'inProgress' }
        ]
      })
    )
  ])
  expect(plan.items).toEqual([
    { text: '扫描', status: 'completed' },
    { text: '修复', status: 'in_progress' }
  ])
  expect(plan.updatedAt).toBe('1970-01-01T00:00:01.000Z')
})

it('HiveWard Claude TaskCreate / TaskUpdate 沿原生工具消息增量更新', () => {
  expect(
    hivewardTaskList([
      call('TaskCreate', { subject: '后台' }, 'a'),
      call('TaskCreate', { subject: '网页' }, 'b'),
      call('TaskUpdate', { taskId: '1', status: 'completed' }),
      call('TaskUpdate', { taskId: '2', status: 'in_progress', subject: '改网页' })
    ]).items
  ).toEqual([
    { text: '后台', status: 'completed' },
    { text: '改网页', status: 'in_progress' }
  ])
})

it('HiveWard 桌面计划的 advance 去重，done / start 保留原语义', () => {
  const initial = call(
    'mcp__ccd_turn__update_plan',
    {
      items: [
        { content: '看', status: 'in_progress' },
        { content: '改', status: 'pending' },
        { content: '测', status: 'pending' }
      ]
    },
    'initial'
  )
  const advance = call('mcp__ccd_turn__update_plan', { advance: true }, 'advance')
  expect(hivewardTaskList([initial, advance, advance]).items.map((t) => t.status)).toEqual([
    'completed',
    'in_progress',
    'pending'
  ])
  expect(
    hivewardTaskList([
      initial,
      call('mcp__ccd_turn__update_plan', { done: [1, 2], start: 3 })
    ]).items.map((t) => t.status)
  ).toEqual(['completed', 'completed', 'in_progress'])
})

it('HiveWard 计划不读取用户引用的工具或失败调用', () => {
  const failed = call('TodoWrite', { todos: [{ content: '失败', status: 'pending' }] })
  failed.blocks = [{ type: 'tool-call', name: 'TodoWrite', input: { todos: [] }, state: 'failed' }]
  expect(
    hivewardTaskList([
      { ...call('TodoWrite', { todos: [{ content: '引用', status: 'pending' }] }), role: 'user' },
      failed
    ]).items
  ).toEqual([])
})
