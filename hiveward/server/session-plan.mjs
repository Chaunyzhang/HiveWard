import { dispatches } from './dispatches.mjs'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { locateTerminalSession } from './business-terminals.mjs'
import { rpc } from './api-runtime.mjs'
import { readOpenCodeTodos } from './opencode-transcripts.mjs'

// 计划使用原生 transcript / task-list；Kimi 暂无原生 reader，仅保留 wire 读取。

const cache = new Map()

const STATUS = {
  pending: 'pending',
  todo: 'pending',
  in_progress: 'in_progress',
  doing: 'in_progress',
  completed: 'completed',
  done: 'completed',
  // OpenCode 取消掉的项：不用再做了
  cancelled: 'completed'
}
const status = (s) => STATUS[String(s ?? '').toLowerCase()] ?? 'pending'

const args = (raw) => {
  if (typeof raw !== 'string') {
    return raw ?? {}
  }
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/** 一次工具调用 → 新的整张计划（返回数组），或对旧计划的改动（返回函数），认不出返回 null */
export function planUpdate(name, input) {
  if (name !== 'SetTodoList' || !Array.isArray(input?.todos)) {
    return null
  }
  return input.todos.map((t) => ({ text: String(t.title ?? ''), status: status(t.status) }))
}

/** 一行对话记录里的工具调用：[名字, 参数] */
function calls(agent, rec) {
  if (agent === 'kimi') {
    const p = rec.message?.payload
    return rec.message?.type === 'ToolCall'
      ? [[p?.function?.name, args(p?.function?.arguments)]]
      : []
  }
  return []
}

/** 读对话记录里最后一版计划；没列过返回 [] */
export async function readPlan(agent, path, call = rpc) {
  if (agent === 'opencode') {
    const todos = readOpenCodeTodos(path)
    const updated = Math.max(...todos.map((t) => t.updated).filter(Number.isFinite))
    return {
      items: todos.map((t) => ({ text: String(t.content ?? ''), status: status(t.status) })),
      updatedAt: Number.isFinite(updated) ? new Date(updated).toISOString() : null
    }
  }
  if (agent !== 'kimi') {
    const result = await call('nativeChat.readSession', {
      agent,
      sessionId: path,
      transcriptPath: path,
      limit: 2000
    })
    return result.hivewardTaskList ?? { items: [], updatedAt: null }
  }
  let c = cache.get(path)
  if (!c || c.agent !== agent) {
    cache.set(path, (c = { agent, offset: 0, rest: '', plan: [], at: null }))
  }
  const size = statSync(path).size
  if (size < c.offset) {
    Object.assign(c, { offset: 0, rest: '', plan: [], at: null })
  }
  if (size > c.offset) {
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(size - c.offset)
      readSync(fd, buf, 0, buf.length, c.offset)
      c.offset = size
      const lines = (c.rest + buf.toString('utf8')).split('\n')
      c.rest = lines.pop() ?? ''
      for (const line of lines) {
        if (
          !line.includes('TodoWrite') &&
          !line.includes('Task') &&
          !line.includes('plan') &&
          !line.includes('Todo')
        ) {
          continue
        }
        let rec
        try {
          rec = JSON.parse(line)
        } catch {
          continue
        }
        if (rec.isSidechain) {
          continue
        }
        for (const [name, input] of calls(agent, rec)) {
          const next = planUpdate(name, input)
          if (next) {
            c.plan = next
            c.at = rec.timestamp
              ? new Date(
                  typeof rec.timestamp === 'number' ? rec.timestamp * 1000 : rec.timestamp
                ).toISOString()
              : c.at
          }
        }
      }
    } finally {
      closeSync(fd)
    }
  }
  return { items: c.plan.map(({ text, status }) => ({ text, status })), updatedAt: c.at }
}

/** 路由：GET /api/hiveward/terminals/:handle/plan */
export const sessionPlanRoutes = [
  [
    'GET',
    /^\/api\/hiveward\/terminals\/([^/]+)\/plan$/,
    async (_req, [handle]) => {
      const worker = dispatches().findLast((d) => d.handle === handle)
      if (worker && !['kimi', 'opencode'].includes(worker.agent)) {
        const output = await rpc('orchestration.workerRead', {
          dispatch: worker.dispatchId,
          source: 'auto',
          limit: 2000
        })
        return {
          agent: output.provider ?? worker.agent,
          source: output.sourceIdentity,
          ...(output.hivewardTaskList ?? { items: [], updatedAt: null }),
          warnings: output.warnings,
          limited: output.transcript?.limited ?? false,
          fallbackReason: output.fallbackReason
        }
      }

      const { agent, path } = await locateTerminalSession(handle)
      if (!agent || !path) {
        return { agent: agent ?? null, source: null, items: [], updatedAt: null }
      }
      return { agent, source: path, ...(await readPlan(agent, path)) }
    }
  ]
]
