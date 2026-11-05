import { HivewardDispatcher } from '../../../shared/rpc-contract/hiveward-orchestration-session-params'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  isHiveWardPrefixedSessionId,
  isHiveWardSessionId
} from '../../../shared/hiveward-session-address'
import type { OrchestrationDb } from './db'
import type { OrchestrationSessionCaller } from './orchestration-caller-identity'
import { mailboxAddressOf } from './orchestration-caller-identity'
import { OrchestrationError } from './orchestration-error'

export const HIVEWARD_EXTERNAL_SESSIONS_SQL = `
CREATE TABLE IF NOT EXISTS hiveward_external_sessions (
  session_id TEXT PRIMARY KEY,
  external_key TEXT NOT NULL UNIQUE,
  dispatcher_json TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  workspace_path TEXT NOT NULL
);`

const SessionRow = z.object({
  session_id: z.string(),
  external_key: z.string(),
  dispatcher_json: z.string(),
  workspace_id: z.string(),
  workspace_path: z.string()
})

export function hivewardExternalSessions(db: OrchestrationDb) {
  return db.db
    .prepare('SELECT * FROM hiveward_external_sessions ORDER BY external_key')
    .all()
    .map((value) => {
      const row = SessionRow.parse(value)
      return {
        sessionId: row.session_id,
        externalKey: row.external_key,
        dispatcher: HivewardDispatcher.parse(JSON.parse(row.dispatcher_json)),
        workspaceId: row.workspace_id,
        workspacePath: row.workspace_path
      }
    })
}

export function registerHivewardExternalSession(
  db: OrchestrationDb,
  args: {
    key: string
    dispatcher: z.infer<typeof HivewardDispatcher>
    workspaceId: string
    path: string
  }
) {
  db.db
    .prepare(`INSERT INTO hiveward_external_sessions
    (session_id, external_key, dispatcher_json, workspace_id, workspace_path) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(external_key) DO UPDATE SET dispatcher_json=excluded.dispatcher_json,
      workspace_id=excluded.workspace_id, workspace_path=excluded.workspace_path`)
    .run(
      `hiveward_${randomUUID()}`,
      args.key,
      JSON.stringify(args.dispatcher),
      args.workspaceId,
      args.path
    )
  return hivewardExternalSessions(db).find((row) => row.externalKey === args.key)!
}

export function hivewardExternalCaller(
  db: OrchestrationDb,
  sessionId: string
): OrchestrationSessionCaller {
  const row = hivewardExternalSessions(db).find((row) => row.sessionId === sessionId)
  if (!row || !isHiveWardPrefixedSessionId(sessionId) || !isHiveWardSessionId(sessionId)) {
    throw new OrchestrationError('hiveward_session_unknown', 'HiveWard 外部会话尚未登记。')
  }
  const key = { terminalHandle: null, hivewardSessionId: sessionId }
  return {
    ...key,
    address: mailboxAddressOf(key)!,
    paneKey: null,
    sessionId,
    workspaceId: row.workspaceId,
    hivewardExternal: true
  }
}
