import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, mkdir, opendir, stat, rename, link, unlink, realpath } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { fileShares } from './file-shares.mjs'
import { fileError } from './file-path-policy.mjs'
import { windowsFileAttributes } from './file-windows-attributes.mjs'
import { appendTimelineEvents } from './timeline.mjs'

export const FILE_MAX_BYTES = 2 * 1024 ** 3
export const FILE_LIST_LIMIT = 1000
export function fileRange(value, size) {
  if (!value) {
    return { start: 0, end: size - 1, partial: false }
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  if (!match || (!match[1] && !match[2])) {
    throw fileError(416, 'invalid_range', '只支持单段字节 Range')
  }
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
  const end = match[1] ? (match[2] ? Math.min(size - 1, Number(match[2])) : size - 1) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
    throw fileError(416, 'invalid_range', 'Range 超出文件大小')
  }
  return { start, end, partial: true }
}
async function jsonBody(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (Buffer.byteLength(raw) > 65536) {
      throw fileError(413, 'body_too_large', '设置请求过大')
    }
  }
  try {
    return JSON.parse(raw || '{}')
  } catch {
    throw fileError(400, 'bad_request', '请求体不是 JSON')
  }
}

export function createFileService({
  maxBytes = FILE_MAX_BYTES,
  listLimit = FILE_LIST_LIMIT,
  recordEvent = appendTimelineEvents,
  linkFile = link,
  renameFile = rename,
  ...options
} = {}) {
  const attributes = options.attributes ?? windowsFileAttributes(options.platform)
  const shares = fileShares({ ...options, attributes })
  const locks = new Set()
  const json = (res, body) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  const event = (title, detail, path) =>
    recordEvent({
      id: `file:${randomUUID()}`,
      ts: new Date().toISOString(),
      kind: 'system',
      title,
      detail,
      path
    })
  async function directory(value, context) {
    const target = await shares.resolve(value, { write: true, create: true, agent: context.agent })
    let current = target.existing
    for (const part of target.missing) {
      current = shares.policy.path.join(current, part)
      await mkdir(current).catch((e) => {
        if (e.code !== 'EEXIST') {
          throw e
        }
      })
      await shares.resolve(current, { write: true, agent: context.agent })
    }
    if (!(await stat(target.path)).isDirectory()) {
      throw fileError(400, 'not_directory', '父路径不是目录')
    }
    return target.path
  }
  async function list(value) {
    const target = await shares.resolve(value)
    const entries = []
    let truncated = false,
      scanned = 0
    const dir = await opendir(target.path)
    for await (const item of dir) {
      if (++scanned > listLimit * 10 || entries.length >= listLimit) {
        truncated = true
        break
      }
      try {
        const child = await shares.resolve(shares.policy.path.join(target.path, item.name))
        const info = await stat(child.path)
        if (!info.isDirectory() && (!info.isFile() || info.size > maxBytes)) {
          continue
        }
        entries.push({
          name: item.name,
          path: child.path,
          type: info.isDirectory() ? 'dir' : 'file',
          ...(info.isFile() ? { size: info.size } : {}),
          modifiedAt: info.mtime.toISOString()
        })
      } catch (e) {
        if (!['file_forbidden', 'ENOENT', 'EACCES'].includes(e.code)) {
          throw e
        }
      }
    }
    entries.sort(
      (a, b) => (a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1) || a.name.localeCompare(b.name)
    )
    const parent = shares.policy.path.dirname(target.path)
    return {
      path: target.path,
      parent:
        shares.policy.within(parent, target.root.path) && parent !== target.path ? parent : null,
      entries,
      truncated
    }
  }
  async function read(req, res, value) {
    const target = await shares.resolve(value)
    const file = await open(target.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const info = await file.stat()
      if (!info.isFile()) {
        throw fileError(400, 'not_file', '路径不是普通文件')
      }
      if (info.size > maxBytes) {
        throw fileError(413, 'file_too_large', `单文件上限 ${maxBytes} 字节`)
      }
      await shares.resolve(await realpath(target.path))
      let range
      try {
        range = fileRange(req.headers.range, info.size)
      } catch (e) {
        res.setHeader('content-range', `bytes */${info.size}`)
        throw e
      }
      res.writeHead(range.partial ? 206 : 200, {
        'content-type': 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        'content-length': info.size ? range.end - range.start + 1 : 0,
        'accept-ranges': 'bytes',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(shares.policy.path.basename(target.path)).replaceAll("'", '%27')}`,
        ...(range.partial
          ? { 'content-range': `bytes ${range.start}-${range.end}/${info.size}` }
          : {})
      })
      if (!info.size) {
        res.end()
        return
      }
      await pipeline(
        file.createReadStream({ start: range.start, end: range.end, autoClose: false }),
        res
      )
    } finally {
      await file.close()
    }
  }
  async function publish(temp, target) {
    let linked = false
    try {
      await linkFile(temp, target)
      linked = true
    } catch (e) {
      if (e.code === 'EEXIST') {
        throw fileError(409, 'file_exists', '文件已存在')
      }
      if (!['EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'ENOSYS', 'EXDEV'].includes(e.code)) {
        throw e
      }
    }
    if (linked) {
      await unlink(temp)
      return
    }
    // exFAT/network drives: reserve without clobbering, then atomically replace the placeholder.
    let reservation
    try {
      reservation = await open(target, 'wx', 0o600)
    } catch (e) {
      if (e.code === 'EEXIST') {
        throw fileError(409, 'file_exists', '文件已存在')
      }
      throw e
    }
    let identity
    try {
      identity = await reservation.stat()
      await reservation.close()
      reservation = undefined
      await renameFile(temp, target)
    } catch (e) {
      await reservation?.close().catch(() => {})
      const current = identity ? await stat(target).catch(() => null) : null
      if (
        current &&
        current.size === 0 &&
        current.dev === identity.dev &&
        current.ino === identity.ino &&
        current.birthtimeMs === identity.birthtimeMs
      ) {
        await unlink(target).catch(() => {})
      }
      throw e
    }
  }
  async function write(req, url, context) {
    const declared = req.headers['content-length']
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
      throw fileError(413, 'file_too_large', `单文件上限 ${maxBytes} 字节`)
    }
    let value = url.searchParams.get('path')
    if (!value) {
      let name
      try {
        name = decodeURIComponent(req.headers['x-opc-filename'] ?? '')
      } catch {
        throw fileError(400, 'invalid_path', '文件名编码无效')
      }
      if (!name || name.includes('/') || name.includes('\\')) {
        throw fileError(400, 'invalid_path', '需要 x-opc-filename 文件名')
      }
      value = shares.policy.path.join((await shares.roots()).inbox, name)
    }
    const target = await shares.resolve(value, { write: true, create: true, agent: context.agent })
    const key = target.shared.platform === 'win32' ? target.path.toLowerCase() : target.path
    if (locks.has(key)) {
      throw fileError(409, 'file_busy', '该文件正在写入')
    }
    locks.add(key)
    let temp, file
    try {
      const overwrite = url.searchParams.get('overwrite') === '1'
      const existing = await stat(target.path).catch((e) => {
        if (e.code === 'ENOENT') {
          return null
        }
        throw e
      })
      if (existing && !overwrite) {
        throw fileError(409, 'file_exists', '文件已存在，需 overwrite=1 才能覆盖')
      }
      if (existing && !existing.isFile()) {
        throw fileError(400, 'not_file', '目标不是普通文件')
      }
      const parent = await directory(shares.policy.path.dirname(target.path), context)
      temp = shares.policy.path.join(parent, `.opc-upload-${randomUUID()}.tmp`)
      file = await open(temp, 'wx', 0o600)
      let size = 0
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length
        if (size > maxBytes) {
          req.resume()
          throw fileError(413, 'file_too_large', `单文件上限 ${maxBytes} 字节`)
        }
        let offset = 0
        while (offset < chunk.length) {
          const written = await file.write(chunk, offset)
          offset += written.bytesWritten
        }
      }
      await file.sync()
      await file.close()
      file = undefined
      await shares.resolve(parent, { write: true, agent: context.agent })
      await shares.resolve(target.path, { write: true, create: true, agent: context.agent })
      await (overwrite ? rename(temp, target.path) : publish(temp, target.path))
      temp = undefined
      if (context.remote) {
        event(`收到文件：${context.peer.name || context.peer.id}`, target.path, target.path)
      }
      return { path: target.path, size }
    } finally {
      await file?.close()
      if (temp) {
        await unlink(temp).catch(() => {})
      }
      locks.delete(key)
    }
  }
  return {
    close: () => attributes.close?.(),
    checkForward(req, url) {
      if (
        req.method === 'POST' &&
        /^\/api\/m\/[^/]+\/(?:api\/)?files\/(?:settings|received)$/.test(url.pathname)
      ) {
        throw fileError(
          403,
          'file_settings_local_only',
          '本机文件设置和收件记录不接受 /api/m/ 转发'
        )
      }
    },
    async handle(req, res, url, { remote = false, peer = null, forwarded = false } = {}) {
      if (!url.pathname.startsWith('/api/files/')) {
        return false
      }
      if (remote && !peer) {
        throw fileError(
          403,
          'file_secure_channel_required',
          '文件接口只允许加密且已核对证书的组织通道，请先完成 TLS 配对'
        )
      }
      const context = {
        remote,
        peer,
        agent:
          req.headers['x-opc-caller'] === 'agent' ||
          (remote && req.headers['x-opc-caller'] !== 'human')
      }
      const action = url.pathname.slice('/api/files/'.length)
      if (action === 'settings') {
        if (req.method === 'POST' && (remote || forwarded)) {
          throw fileError(
            403,
            'file_settings_local_only',
            '共享设置只能在目标电脑本机修改，不能经 /api/m/ 转发'
          )
        }
        if (req.method === 'GET') {
          json(res, await shares.settings())
        } else if (req.method === 'POST') {
          json(res, await shares.setSettings(await jsonBody(req)))
        } else {
          throw fileError(405, 'method_not_allowed', '方法不支持')
        }
      } else if (action === 'roots' && req.method === 'GET') {
        json(res, { ...(await shares.roots()), maxBytes })
      } else if (action === 'list' && req.method === 'GET') {
        json(res, await list(url.searchParams.get('path')))
      } else if (action === 'read' && req.method === 'GET') {
        await read(req, res, url.searchParams.get('path'))
      } else if (action === 'write' && req.method === 'POST') {
        json(res, await write(req, url, context))
      } else if (action === 'mkdir' && req.method === 'POST') {
        json(res, { path: await directory((await jsonBody(req)).path, context) })
      } else if (action === 'received' && req.method === 'POST' && !remote && !forwarded) {
        const body = await jsonBody(req)
        if (
          ![body.machine, body.path, body.localPath].every(
            (x) => typeof x === 'string' && x && x.length < 4096
          )
        ) {
          throw fileError(400, 'bad_request', '缺少文件传输信息')
        }
        event(`Agent 取回文件：${body.machine}`, `${body.path} → ${body.localPath}`, body.localPath)
        json(res, { ok: true })
      } else {
        throw fileError(404, 'not_found', '文件接口不存在')
      }
      return true
    }
  }
}
