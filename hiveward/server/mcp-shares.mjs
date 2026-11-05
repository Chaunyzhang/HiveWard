import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './data-dir.mjs'
import { openHttpMcpSession, openStdioMcpSession } from './mcp-sessions.mjs'
import { appendTimelineEvents } from './timeline.mjs'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
const mcpError = (code, message) => Object.assign(new Error(message), { code })
const httpError = (status, code, message) => Object.assign(new Error(message), { status, code })

function normalizedShare(input, previous) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw httpError(400, 'bad_request', 'MCP 共享配置必须是对象')
  }
  if (typeof input.name !== 'string' || !/^[a-z0-9-]+$/.test(input.name)) {
    throw httpError(400, 'invalid_name', 'MCP 名字只能包含小写字母、数字和 -')
  }
  if (!['stdio', 'http'].includes(input.transport) || typeof input.enabled !== 'boolean') {
    throw httpError(400, 'bad_request', 'MCP 共享需要有效的 transport 和 enabled')
  }
  if (
    input.description !== undefined &&
    (typeof input.description !== 'string' || input.description.length > 1000)
  ) {
    throw httpError(400, 'bad_request', 'MCP 说明无效')
  }
  if (
    input.allowMachines !== undefined &&
    (!Array.isArray(input.allowMachines) ||
      input.allowMachines.some((id) => typeof id !== 'string' || !id))
  ) {
    throw httpError(400, 'bad_request', 'allowMachines 必须是机器 id 数组')
  }
  if (input.env !== undefined) {
    if (
      !input.env ||
      typeof input.env !== 'object' ||
      Array.isArray(input.env) ||
      Object.entries(input.env).some(([key, value]) => !key || typeof value !== 'string')
    ) {
      throw httpError(400, 'bad_request', 'env 必须是字符串键值对象')
    }
  }
  const share = {
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    enabled: input.enabled,
    transport: input.transport,
    ...(input.allowMachines?.length ? { allowMachines: [...new Set(input.allowMachines)] } : {}),
    env: input.env === undefined ? { ...previous?.env } : { ...input.env }
  }
  if (input.transport === 'stdio') {
    if (typeof input.command !== 'string' || !input.command) {
      throw httpError(400, 'bad_request', 'stdio MCP 必须有 command')
    }
    if (
      input.args !== undefined &&
      (!Array.isArray(input.args) || input.args.some((a) => typeof a !== 'string'))
    ) {
      throw httpError(400, 'bad_request', 'MCP args 必须是字符串数组')
    }
    if (input.cwd !== undefined && (typeof input.cwd !== 'string' || !input.cwd)) {
      throw httpError(400, 'bad_request', 'MCP cwd 必须是非空字符串')
    }
    share.command = input.command
    share.args = [...(input.args ?? [])]
    if (input.cwd) {
      share.cwd = input.cwd
    }
  } else {
    let url
    try {
      url = new URL(input.url)
    } catch {
      throw httpError(400, 'invalid_url', 'HTTP MCP 需要有效 URL')
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !LOOPBACK.has(url.hostname) ||
      url.username ||
      url.password
    ) {
      throw httpError(400, 'invalid_url', 'HTTP MCP 只允许本机 loopback 地址')
    }
    share.url = url.toString()
  }
  return share
}

function readShares(directory) {
  try {
    const value = JSON.parse(readFileSync(join(directory, 'mcp-shares.json'), 'utf8'))
    if (!Array.isArray(value)) {
      throw new Error('MCP shares must be an array')
    }
    return value.map((share) => normalizedShare({ ...share, env: share.env ?? {} }))
  } catch (error) {
    if (error.code === 'ENOENT') {
      return []
    }
    throw error
  }
}

function writeShares(directory, shares) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, 'mcp-shares.json')
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(shares, null, 2)}\n`, { mode: 0o600 })
    chmodSync(temp, 0o600)
    renameSync(temp, file)
  } finally {
    try {
      unlinkSync(temp)
    } catch {}
  }
}

async function jsonBody(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (Buffer.byteLength(raw) > 65536) {
      throw httpError(413, 'body_too_large', 'MCP 配置请求过大')
    }
  }
  try {
    return JSON.parse(raw || '{}')
  } catch {
    throw httpError(400, 'bad_request', '请求体不是 JSON')
  }
}

function duration(ms) {
  if (ms < 1000) {
    return '不到 1 秒'
  }
  if (ms < 60000) {
    return `${Math.round(ms / 1000)} 秒`
  }
  return `${Math.floor(ms / 60000)} 分 ${Math.round((ms % 60000) / 1000)} 秒`
}

export function createMcpService({
  directory = dataDir(),
  machine = { id: 'local', name: '本机' },
  recordEvent = appendTimelineEvents,
  maxSessions = 4,
  stdioOptions,
  httpOptions
} = {}) {
  let shares = readShares(directory)
  const sessions = new Map()
  let closed = false
  const event = (title) => {
    try {
      recordEvent({
        id: `mcp:${randomUUID()}`,
        ts: new Date().toISOString(),
        kind: 'system',
        title
      })
    } catch {}
  }
  const publicShare = (share) => ({
    name: share.name,
    ...(share.description ? { description: share.description } : {}),
    enabled: share.enabled,
    transport: share.transport,
    ...(share.transport === 'stdio'
      ? {
          command: share.command,
          args: [...(share.args ?? [])],
          ...(share.cwd ? { cwd: share.cwd } : {})
        }
      : { url: share.url }),
    envKeys: Object.keys(share.env).sort(),
    ...(share.allowMachines ? { allowMachines: [...share.allowMachines] } : {}),
    sessions: sessions.get(share.name)?.size ?? 0
  })
  const available = (peer) =>
    shares
      .filter(
        (share) =>
          share.enabled && (!peer || !share.allowMachines || share.allowMachines.includes(peer.id))
      )
      .map((share) => ({
        name: share.name,
        ...(share.description ? { description: share.description } : {}),
        transport: share.transport
      }))
  const closeShare = async (name) => {
    await Promise.all([...(sessions.get(name) ?? [])].map((session) => session.close()))
  }
  const save = async (input) => {
    const previous = shares.find((share) => share.name === input?.name)
    const share = normalizedShare(input, previous)
    shares = [...shares.filter((item) => item.name !== share.name), share].sort((a, b) =>
      a.name.localeCompare(b.name)
    )
    writeShares(directory, shares)
    await closeShare(share.name)
    event(
      `${!previous ? '新增' : previous.enabled !== share.enabled ? (share.enabled ? '开启' : '关闭') : '修改'} MCP：${share.name}`
    )
    return publicShare(share)
  }
  const remove = async (name) => {
    const previous = shares.find((share) => share.name === name)
    if (!previous) {
      throw httpError(404, 'not_shared', 'MCP 共享不存在')
    }
    shares = shares.filter((share) => share.name !== name)
    writeShares(directory, shares)
    await closeShare(name)
    event(`删除 MCP 共享：${name}`)
    return { ok: true }
  }
  const open = (name, peer, handlers) => {
    if (closed) {
      throw mcpError('start_failed', 'HiveWard 正在关闭')
    }
    const share = shares.find((item) => item.name === name)
    if (!share) {
      throw mcpError('not_shared', '这台电脑没有这个 MCP 共享')
    }
    if (!share.enabled) {
      throw mcpError('disabled', '这个 MCP 共享已关闭')
    }
    if (peer && share.allowMachines && !share.allowMachines.includes(peer.id)) {
      throw mcpError('forbidden', '这台电脑不在 MCP 共享允许名单里')
    }
    const active = sessions.get(name) ?? new Set()
    if (active.size >= maxSessions) {
      throw mcpError('too_many_sessions', `这个 MCP 已达到 ${maxSessions} 个并发连接上限`)
    }
    sessions.set(name, active)
    const startedAt = Date.now()
    let session
    let driver
    let finished = false
    const close = () => {
      if (finished) {
        return session.closePromise
      }
      finished = true
      active.delete(session)
      if (!active.size) {
        sessions.delete(name)
      }
      handlers.exit()
      event(
        `${peer?.name ?? machine.name} 断开 MCP：${name}（用时 ${duration(Date.now() - startedAt)}）`
      )
      session.closePromise = Promise.resolve()
        .then(() => driver.close())
        .catch(() => {})
      return session.closePromise
    }
    const fail = (code, message) => {
      if (!finished) {
        handlers.fail(code, message)
        void close()
      }
    }
    driver =
      share.transport === 'stdio'
        ? openStdioMcpSession(share, { send: handlers.send, fail, exit: close }, stdioOptions)
        : openHttpMcpSession(share, { send: handlers.send, fail, exit: close }, httpOptions)
    session = { input: (text) => driver.input(text), close, closePromise: null }
    active.add(session)
    event(`${peer?.name ?? machine.name} 连上了 MCP：${name}`)
    return session
  }
  return {
    checkForward(_req, url) {
      if (/^\/api\/m\/[^/]+\/(?:api\/)?mcp\/shares(?:\/|$)/.test(url.pathname)) {
        throw httpError(403, 'mcp_local_only', 'MCP 共享配置只能直接在本机查看和修改')
      }
    },
    async handle(req, res, url, { remote = false, peer = null } = {}) {
      if (!url.pathname.startsWith('/api/mcp/')) {
        return false
      }
      const json = (body) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(body))
      }
      if (url.pathname === '/api/mcp/available') {
        if (req.method !== 'GET') {
          throw httpError(405, 'method_not_allowed', '方法不支持')
        }
        if (remote && !peer) {
          throw httpError(403, 'forbidden', 'MCP 只允许已认证组织成员')
        }
        json(available(peer))
        return true
      }
      if (
        url.pathname === '/api/mcp/shares' ||
        /^\/api\/mcp\/shares\/[^/]+\/remove$/.test(url.pathname)
      ) {
        if (remote) {
          throw httpError(403, 'mcp_local_only', 'MCP 共享配置只能在本机查看和修改')
        }
        if (req.method === 'POST' && req.headers['x-hiveward-caller'] === 'agent') {
          throw httpError(403, 'mcp_local_only', 'Agent 不能修改 MCP 共享配置')
        }
        if (url.pathname === '/api/mcp/shares' && req.method === 'GET') {
          json(shares.map(publicShare))
        } else if (url.pathname === '/api/mcp/shares' && req.method === 'POST') {
          json(await save(await jsonBody(req)))
        } else if (req.method === 'POST') {
          const name = decodeURIComponent(url.pathname.split('/')[4])
          json(await remove(name))
        } else {
          throw httpError(405, 'method_not_allowed', '方法不支持')
        }
        return true
      }
      if (url.pathname.startsWith('/api/mcp/')) {
        throw httpError(404, 'not_found', 'MCP 接口不存在')
      }
      return false
    },
    open,
    close: async () => {
      closed = true
      await Promise.all([...sessions.keys()].map(closeShare))
    }
  }
}
