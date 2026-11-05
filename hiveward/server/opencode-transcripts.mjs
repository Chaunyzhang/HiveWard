// OpenCode 的对话记录不是一个个文件，而是一个 SQLite 库：
//   <XDG_DATA_HOME 或 ~/.local/share>/opencode/opencode.db（OPENCODE_DB 可改名 / 改路径）
//   session（directory = 启动目录）/ message（data.role、data.time、data.finish）/ part（text / reasoning / tool …）/ todo
// 照 HiveWard（src/shared/opencode-sqlite-session-path.ts）把一个会话记成「<库路径>#<会话 id>」，只读打开，读完就关。
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const SEPARATOR = '#'
// 只读最近这么多条消息：对话页最多显示 300 条，一条消息能拆出好几项
const MESSAGE_LIMIT = 300

/** 照 HiveWard resolveOpenCodeDatabasePath：OPENCODE_DB 绝对路径优先，否则放在数据目录里 */
export function openCodeDatabasePath(home, env = process.env) {
  const selection = env?.OPENCODE_DB?.trim()
  if (selection === ':memory:') {
    return null
  }
  const dataDirectory = join(
    env?.XDG_DATA_HOME?.trim() || join(home, '.local', 'share'),
    'opencode'
  )
  return selection && isAbsolute(selection)
    ? selection
    : join(dataDirectory, selection || 'opencode.db')
}

export const openCodeRef = (dbPath, sessionId) => `${dbPath}${SEPARATOR}${sessionId}`

/** 「<库路径>#<会话 id>」拆回来；库文件名得像 opencode.db，否则不认 */
export function splitOpenCodeRef(ref) {
  if (typeof ref !== 'string') {
    return null
  }
  const at = ref.lastIndexOf(SEPARATOR)
  if (at <= 0 || at === ref.length - 1) {
    return null
  }
  const dbPath = ref.slice(0, at)
  const name = dbPath.split(/[\\/]/).at(-1) ?? ''
  return /^opencode(?:-[A-Za-z0-9_.-]+)?\.db$/i.test(name)
    ? { dbPath, sessionId: ref.slice(at + 1) }
    : null
}

function withDatabase(dbPath, read) {
  // 照 HiveWard：node:sqlite 用到时再加载，运行时没有就当读不到
  const sqlite = process.getBuiltinModule?.('node:sqlite')
  if (!sqlite?.DatabaseSync || !dbPath || !existsSync(dbPath)) {
    return null
  }
  let db
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true, timeout: 1500 })
    return read(db)
  } catch {
    // OpenCode 正在写、库被锁或表结构对不上：这一轮当读不到，下一轮再读
    return null
  } finally {
    try {
      db?.close()
    } catch {
      /* 关不掉也不影响下一次打开 */
    }
  }
}

/** 这个目录里的顶层会话（子代理会话不算），born / m 是创建 / 更新时间（毫秒） */
export function openCodeSessions(dbPath, cwd) {
  return (
    withDatabase(dbPath, (db) =>
      db
        .prepare(
          'SELECT id, time_created AS born, time_updated AS m FROM session WHERE directory = ? AND parent_id IS NULL'
        )
        .all(cwd)
        .map((row) => ({ ...row, p: openCodeRef(dbPath, row.id) }))
    ) ?? []
  )
}

/** 会话有没有变：消息、片段的最后更新时间和片段数；会话不在了返回 null */
export function openCodeSessionStamp(ref) {
  const at = splitOpenCodeRef(ref)
  return at
    ? withDatabase(at.dbPath, (db) => {
        const row = db
          .prepare(
            `SELECT (SELECT max(time_updated) FROM message WHERE session_id = ?) AS message,
                    (SELECT max(time_updated) FROM part WHERE session_id = ?) AS part,
                    (SELECT count(*) FROM part WHERE session_id = ?) AS parts`
          )
          .get(at.sessionId, at.sessionId, at.sessionId)
        return row ? `${row.message}:${row.part}:${row.parts}` : null
      })
    : null
}

/** 最近的消息和它们的片段，按时间顺序；片段 data 原样解析 */
export function readOpenCodeMessages(ref) {
  const at = splitOpenCodeRef(ref)
  const rows = at
    ? withDatabase(at.dbPath, (db) =>
        db
          .prepare(
            `SELECT m.id AS messageId, m.data AS message, p.id AS partId, p.data AS part
             FROM (SELECT id, data, time_created FROM message WHERE session_id = ?
                   ORDER BY time_created DESC, id DESC LIMIT ${MESSAGE_LIMIT}) m
             LEFT JOIN part p ON p.message_id = m.id
             ORDER BY m.time_created, m.id, p.id`
          )
          .all(at.sessionId)
      )
    : null
  const messages = []
  for (const row of rows ?? []) {
    let message = messages.at(-1)
    if (message?.id !== row.messageId) {
      message = { id: row.messageId, info: parse(row.message) ?? {}, parts: [] }
      messages.push(message)
    }
    const part = row.partId ? parse(row.part) : null
    if (part) {
      message.parts.push({ id: row.partId, ...part })
    }
  }
  return messages
}

/** OpenCode 自己的待办（todowrite 写进 todo 表），按位置排；没有返回 [] */
export function readOpenCodeTodos(ref) {
  const at = splitOpenCodeRef(ref)
  return at
    ? (withDatabase(at.dbPath, (db) =>
        db
          .prepare(
            'SELECT content, status, time_updated AS updated FROM todo WHERE session_id = ? ORDER BY position'
          )
          .all(at.sessionId)
      ) ?? [])
    : []
}

function parse(text) {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}
