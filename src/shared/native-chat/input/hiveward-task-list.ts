import { pairToolBlocks } from '../tools/native-chat-tool-pairs'
import type { NativeChatMessage } from '../native-chat-types'
import { normalizeNativeChatTaskList, type NativeChatTask } from './native-chat-task-list'
import { projectNativeChatTaskListFrames } from './native-chat-task-list-frames'

// 计划面板与原生对话共用任务归一化，增量工具只补主会话的状态变化。
export function hivewardTaskList(messages: readonly NativeChatMessage[]): {
  items: { text: string; status: NativeChatTask['status'] }[]
  updatedAt: string | null
} {
  let tasks: (NativeChatTask & { id?: string })[] = []
  let updatedAt: string | null = null
  const seen = new Set<string>()
  for (const message of projectNativeChatTaskListFrames(messages)) {
    if (message.role !== 'assistant') {
      continue
    }
    for (const { call: block, result } of pairToolBlocks(message.blocks)) {
      if (!block || result?.isError) {
        continue
      }
      if (block.type !== 'tool-call' || block.state === 'failed') {
        continue
      }
      if (block.callId && seen.has(block.callId)) {
        continue
      }
      if (block.callId) {
        seen.add(block.callId)
      }
      const list = normalizeNativeChatTaskList(block.name, block.input)
      if (list) {
        tasks = list.tasks
      } else {
        let input: unknown = block.input
        if (typeof input === 'string') {
          try {
            input = JSON.parse(input)
          } catch {
            continue
          }
        }
        if (!input || typeof input !== 'object') {
          continue
        }
        if (/(^|__)update_plan$/.test(block.name) && block.name !== 'update_plan') {
          if ('items' in input && Array.isArray(input.items)) {
            const list = normalizeNativeChatTaskList('TodoWrite', { todos: input.items })
            if (!list) {
              continue
            }
            tasks = list.tasks
          } else {
            tasks = tasks.map((t) => ({ ...t }))
            if ('advance' in input && input.advance) {
              const at = tasks.findIndex((t) => t.status === 'in_progress')
              if (at !== -1) {
                tasks[at].status = 'completed'
              }
              const next = tasks.findIndex((t, i) => i > at && t.status === 'pending')
              if (next !== -1) {
                tasks[next].status = 'in_progress'
              }
            }
            if ('done' in input && Array.isArray(input.done)) {
              for (const index of input.done) {
                if (typeof index === 'number' && tasks[index - 1]) {
                  tasks[index - 1].status = 'completed'
                }
              }
            }
            if ('start' in input && typeof input.start === 'number' && tasks[input.start - 1]) {
              for (const task of tasks) {
                if (task.status === 'in_progress') {
                  task.status = 'pending'
                }
              }
              tasks[input.start - 1].status = 'in_progress'
            }
          }
        } else if (
          block.name === 'TaskCreate' &&
          'subject' in input &&
          typeof input.subject === 'string'
        ) {
          tasks = [
            ...tasks,
            { id: String(tasks.length + 1), content: input.subject, status: 'pending' }
          ]
        } else if (block.name === 'TaskUpdate' && 'taskId' in input) {
          const id = String(input.taskId)
          const status = 'status' in input ? input.status : undefined
          tasks =
            status === 'deleted'
              ? tasks.filter((t) => t.id !== id)
              : tasks.map((t) =>
                  t.id === id
                    ? {
                        ...t,
                        ...('subject' in input && typeof input.subject === 'string'
                          ? { content: input.subject }
                          : {}),
                        ...(status === 'pending' ||
                        status === 'in_progress' ||
                        status === 'completed'
                          ? { status }
                          : {})
                      }
                    : t
                )
        } else {
          continue
        }
      }
      updatedAt = message.timestamp == null ? updatedAt : new Date(message.timestamp).toISOString()
    }
  }
  return { items: tasks.map((t) => ({ text: t.content, status: t.status })), updatedAt }
}
