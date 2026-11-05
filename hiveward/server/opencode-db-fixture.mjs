// 测试用：按 OpenCode 1.x 的表结构（session / message / part / todo，只取用到的列）建一个小库
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA = `
CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text,
  directory text NOT NULL, title text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);
CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
CREATE TABLE todo (session_id text NOT NULL, content text NOT NULL, status text NOT NULL,
  priority text NOT NULL, position integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);
`

export function openCodeDbFixture(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec(SCHEMA)
  let clock = 1_000
  const tick = () => ++clock
  return {
    session(id, directory, born, { parent = null } = {}) {
      db.prepare(
        'INSERT INTO session (id, project_id, parent_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(id, 'project', parent, directory, id, born, born)
    },
    /** 一条消息连同它的片段；info 是 message.data，parts 是 part.data 列表 */
    message(sessionId, id, info, parts = [], at = tick()) {
      db.prepare(
        'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
      ).run(id, sessionId, at, at, JSON.stringify({ time: { created: at }, ...info }))
      parts.forEach((part, i) => {
        db.prepare(
          'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(`${id}-p${i}`, id, sessionId, at, at, JSON.stringify(part))
      })
    },
    todo(sessionId, position, content, status, at = tick()) {
      db.prepare(
        'INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(sessionId, content, status, 'medium', position, at, at)
    },
    close: () => db.close()
  }
}
