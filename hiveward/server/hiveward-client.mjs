import { compatibleRuntimeMetadata } from '../shared/profile-paths.mjs'
import { WORKER_START_TIMEOUT_MS } from '../shared/orchestration-budgets.mjs'
import { terminalCliParams } from './terminal-cli.mjs'
// 直连本机 HiveWard 引擎（与 `hiveward` CLI 同一条路）：
// 读 ~/Library/Application Support/HiveWard/hiveward-runtime.json 拿 unix socket + authToken，
// 每行发一个 JSON { id, authToken, method, params }，回包同样按行、按 id 对应。
// 只做一问一答；HiveWard 的实时订阅只开在需要配对的 websocket 上（见 docs/HiveWard-DESIGN.md §9.1）。
import { exitRegionGuard } from './agent-exit-region.mjs'
import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dataDir } from './data-dir.mjs'
import { join } from 'node:path'

let META_PATH = process.env.HIVEWARD_RUNTIME_META ?? compatibleRuntimeMetadata(join(dataDir(), '..'))
const TIMEOUT_MS = 15_000

export class HiveWardUnavailable extends Error {}

let conn = null // { socket, meta, waiters }

export function configureRuntimeMetadata(path) {
  closeRuntimeConnection()
  META_PATH = process.env.HIVEWARD_RUNTIME_META ?? path
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
    throw new HiveWardUnavailable('读不到 HiveWard 引擎的运行时信息，HiveWard 引擎没开？')
  }
  const unix = meta?.transports?.find((t) => t.kind === 'unix' || t.kind === 'named-pipe')
  if (!unix || !meta.authToken) {
    throw new HiveWardUnavailable('HiveWard 引擎的运行时信息不完整')
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
  socket.on('error', () => fail(new HiveWardUnavailable('连不上 HiveWard 引擎')))
  socket.on('close', () => fail(new HiveWardUnavailable('HiveWard 引擎断开了连接')))
  return c
}

/** 调一个 HiveWard RPC 方法；成功返回 result，失败抛错（带 HiveWard 的错误码）。 */
export async function call(method, params, { hivewardSessionId } = {}) {
  if (method === 'terminal.create') {
    await exitRegionGuard().beforeRpc(method, params)
    params = terminalCliParams(params)
  }
  if (!conn) {
    conn = open()
  }
  const c = conn
  const id = randomUUID()
  const frame = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        c.waiters.delete(id)
        reject(new HiveWardUnavailable(`HiveWard 引擎响应超时：${method}`))
      },
      method === 'orchestration.workerStart' || method === 'orchestration.send'
        ? WORKER_START_TIMEOUT_MS
        : method === 'orchestration.check' && params?.wait
          ? params.timeoutMs + 5000
          : TIMEOUT_MS
    )
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
        ...(hivewardSessionId ? { hivewardSessionId } : {}),
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
      throw new HiveWardUnavailable(frame.error.message)
    }
    const err = new Error(frame.error?.message ?? 'hiveward_error')
    err.code = frame.error?.code
    if (['invalid_params', 'invalid_argument', 'agent_unconfigured'].includes(err.code)) {
      err.status = 400
    }
    throw err
  }
  return frame.result
}
