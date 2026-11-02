// 直连本机 Orca 引擎（与 `orca` CLI 同一条路）：
// 读 ~/Library/Application Support/OPC-Engine/opc-runtime.json 拿 unix socket + authToken，
// 每行发一个 JSON { id, authToken, method, params }，回包同样按行、按 id 对应。
// 只做一问一答；Orca 的实时订阅只开在需要配对的 websocket 上（见 docs/OPC-DESIGN.md §9.1）。
import { exitRegionGuard } from './agent-exit-region.mjs'
import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

let META_PATH =
  process.env.ORCA_RUNTIME_META ??
  join(homedir(), 'Library/Application Support/OPC-Engine/opc-runtime.json')
const TIMEOUT_MS = 15_000

export class OrcaUnavailable extends Error {}

let conn = null // { socket, meta, waiters }

export function configureRuntimeMetadata(path) {
  closeRuntimeConnection()
  META_PATH = process.env.ORCA_RUNTIME_META ?? path
}
export function closeRuntimeConnection() {
  conn?.socket.destroy()
  conn = null
}

function open() {
  let meta
  try {
    meta = JSON.parse(readFileSync(META_PATH, 'utf8'))
  } catch {
    throw new OrcaUnavailable('读不到 Orca 运行时信息，Orca 没开？')
  }
  const unix = meta?.transports?.find((t) => t.kind === 'unix')
  if (!unix || !meta.authToken) {
    throw new OrcaUnavailable('Orca 运行时信息不完整')
  }

  const socket = createConnection(unix.endpoint)
  socket.setEncoding('utf8')
  const waiters = new Map()
  const c = { socket, meta, waiters }
  let buf = ''
  socket.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) {
        continue
      }
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        continue
      }
      if (frame._keepalive) {
        continue
      }
      const w = waiters.get(frame.id)
      if (w) {
        waiters.delete(frame.id)
        w.resolve(frame)
      }
    }
  })
  const fail = (err) => {
    if (conn === c) {
      conn = null
    }
    for (const w of waiters.values()) {
      w.reject(err)
    }
    waiters.clear()
  }
  socket.on('error', () => fail(new OrcaUnavailable('连不上 Orca')))
  socket.on('close', () => fail(new OrcaUnavailable('Orca 断开了连接')))
  return c
}

/** 调一个 Orca RPC 方法；成功返回 result，失败抛错（带 Orca 的错误码）。 */
export async function call(method, params) {
  if (method === 'terminal.create') {
    await exitRegionGuard().beforeRpc(method, params)
  }
  if (!conn) {
    conn = open()
  }
  const c = conn
  const id = randomUUID()
  const frame = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      c.waiters.delete(id)
      reject(new OrcaUnavailable(`Orca 响应超时：${method}`))
    }, TIMEOUT_MS)
    c.waiters.set(id, {
      resolve: (f) => (clearTimeout(timer), resolve(f)),
      reject: (e) => (clearTimeout(timer), reject(e))
    })
    c.socket.write(
      `${JSON.stringify({
        id,
        authToken: c.meta.authToken,
        method,
        params,
        ...(method.startsWith('orchestration.')
          ? {
              orchestrationContractVersion: 1,
              orchestrationRequestId: id
            }
          : {})
      })}\n`
    )
  })
  if (!frame.ok) {
    if (['runtime_unavailable', 'runtime_not_ready'].includes(frame.error?.code)) {
      throw new OrcaUnavailable(frame.error.message)
    }
    const err = new Error(frame.error?.message ?? 'orca_error')
    err.code = frame.error?.code
    throw err
  }
  return frame.result
}
