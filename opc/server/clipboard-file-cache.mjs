import { join } from 'node:path'
import { readdir, rm, stat } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { createFileService } from './files.mjs'
import { fileError } from './file-path-policy.mjs'
import {
  drainClipboardRequest,
  readClipboardJson,
  validClipboardManifest
} from './clipboard-protocol.mjs'

const MANIFEST_LIMIT = 8 * 1024 * 1024
const CACHE_AGE = 24 * 60 * 60 * 1000

export function createClipboardFileCache({
  directory,
  home = join(directory, 'clipboard-home'),
  cacheRoot = join(home, 'HiveWard Clipboard Cache'),
  settings,
  arrive,
  apply,
  onSkipped,
  cleanupInterval = 60 * 60 * 1000,
  cacheMaxAge = CACHE_AGE
}) {
  const files = createFileService({
    directory: join(directory, 'clipboard-file-service'),
    home,
    defaultInbox: cacheRoot,
    businessRows: async () => [],
    recordEvent: () => {}
  })
  const sessions = new Map()
  const pending = new Set()
  const activeRequests = new Set()
  let cleaning = false
  const timer = setInterval(() => void clean().catch(() => {}), cleanupInterval)
  timer.unref()
  void clean().catch(() => {})

  function handle(req, res, url, { remote = false, peer = null } = {}) {
    if (!url.pathname.startsWith('/api/clipboard/files')) {
      return Promise.resolve(false)
    }
    activeRequests.add(req)
    const work = route(req, res, url, { remote, peer })
    pending.add(work)
    const done = () => {
      pending.delete(work)
      activeRequests.delete(req)
    }
    void work.then(done, done)
    return work
  }

  async function route(req, res, url, { remote, peer }) {
    if (!remote || !peer || !settings().enabled) {
      throw fileError(403, 'clipboard_disabled', '剪贴板同步未开启或通道未认证')
    }
    if (req.method !== 'POST') {
      throw fileError(405, 'method_not_allowed', '方法不支持')
    }
    if (url.pathname === '/api/clipboard/files') {
      const manifest = validClipboardManifest(await readClipboardJson(req, MANIFEST_LIMIT), peer.id)
      if (!settings().enabled) {
        throw fileError(403, 'clipboard_disabled', '剪贴板同步已关闭')
      }
      if (manifest.totalBytes > settings().maxFileBytes) {
        onSkipped(peer, manifest)
        json(res, { ok: true, skipped: 'files_too_large' })
        return true
      }
      if (!sessions.has(manifest.eventId)) {
        sessions.set(manifest.eventId, {
          id: manifest.eventId,
          peerId: peer.id,
          manifest,
          ticket: arrive(),
          received: 0,
          complete: new Map(),
          requests: new Set(),
          active: true,
          ready: false,
          updated: Date.now()
        })
      }
      json(res, { ok: true })
      return true
    }
    const match = /^\/api\/clipboard\/files\/([a-f0-9-]{36})\/(entry|directory|commit)$/.exec(
      url.pathname
    )
    const session = match && sessions.get(match[1])
    if (!match || !session || session.peerId !== peer.id || !session.active) {
      throw fileError(404, 'clipboard_transfer_not_found', '剪贴板文件会话不存在或已停止')
    }
    session.updated = Date.now()
    if (match[2] === 'commit') {
      await drainClipboardRequest(req)
      if (!settings().enabled || !session.active) {
        throw fileError(403, 'clipboard_disabled', '剪贴板同步已关闭')
      }
      await commit(session, peer, res)
      return true
    }
    if (session.ready) {
      await drainClipboardRequest(req)
      json(res, { ok: true })
      return true
    }
    const index = Number(url.searchParams.get('index'))
    const entry = session.manifest.entries[index]
    if (
      !Number.isInteger(index) ||
      !entry ||
      entry.type !== (match[2] === 'entry' ? 'file' : 'directory')
    ) {
      throw fileError(400, 'invalid_clipboard_entry', '文件项目索引或类型无效')
    }
    session.requests.add(req)
    try {
      if (match[2] === 'directory') {
        await drainClipboardRequest(req)
        if (!settings().enabled || !session.active) {
          throw fileError(403, 'clipboard_disabled', '剪贴板同步已关闭')
        }
        const input = requestWithHeaders(
          Readable.from([JSON.stringify({ path: absolute(session, entry) })]),
          {
            'content-type': 'application/json'
          }
        )
        await files.handle(input, res, new URL('/api/files/mkdir', 'http://x'), { remote, peer })
        session.complete.set(index, 0)
      } else {
        await writeFile(req, res, session, entry, index, peer)
      }
    } finally {
      session.requests.delete(req)
    }
    return true
  }

  async function writeFile(req, res, session, entry, index, peer) {
    let size = 0
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length
        session.received += chunk.length
        if (!session.active || !settings().enabled || session.received > settings().maxFileBytes) {
          callback(
            fileError(413, 'clipboard_files_too_large', '剪贴板文件超过接收上限或同步已关闭')
          )
          return
        }
        callback(null, chunk)
      }
    })
    const input = requestWithHeaders(counter, req.headers)
    req.on('aborted', () => counter.destroy())
    req.on('close', () => {
      if (!req.readableEnded) {
        counter.destroy()
      }
    })
    req.pipe(counter)
    const target = new URL('/api/files/write', 'http://x')
    target.searchParams.set('path', absolute(session, entry))
    await files.handle(input, res, target, { remote: true, peer })
    session.complete.set(index, size)
    if (size !== entry.size) {
      session.active = false
    }
  }

  async function commit(session, peer, res) {
    if (!session.ready) {
      const complete = session.manifest.entries.every(
        (entry, index) =>
          session.complete.has(index) &&
          (entry.type === 'directory' || session.complete.get(index) === entry.size)
      )
      if (!complete || session.received !== session.manifest.totalBytes || !session.active) {
        throw fileError(409, 'clipboard_transfer_incomplete', '剪贴板文件尚未完整接收')
      }
      const paths = session.manifest.entries
        .filter((entry) => !entry.path.includes('/'))
        .map((entry) => absolute(session, entry))
      const applied = await apply({
        ticket: session.ticket,
        peer,
        payload: { kind: 'files', paths },
        count: session.manifest.count,
        bytes: session.manifest.totalBytes
      })
      session.ready = true
      if (applied) {
        await removeOtherReady(session.id)
      }
      json(res, { ok: true, applied })
      return
    }
    json(res, { ok: true })
  }

  function absolute(session, entry) {
    return join(cacheRoot, session.id, ...entry.path.split('/'))
  }

  async function removeOtherReady(id) {
    for (const [key, session] of sessions) {
      if (key !== id && session.ready) {
        await rm(join(cacheRoot, key), { recursive: true, force: true })
        sessions.delete(key)
      }
    }
  }

  async function clean() {
    if (cleaning) {
      return
    }
    cleaning = true
    try {
      const cutoff = Date.now() - cacheMaxAge
      for (const [id, session] of sessions) {
        if (session.updated < cutoff) {
          session.active = false
          for (const req of session.requests) {
            req.destroy()
          }
          try {
            await rm(join(cacheRoot, id), { recursive: true, force: true })
            sessions.delete(id)
          } catch {}
        }
      }
      let items
      try {
        items = await readdir(cacheRoot, { withFileTypes: true })
      } catch {
        return
      }
      for (const item of items) {
        if (!item.isDirectory() || !/^[a-f0-9-]{36}$/.test(item.name) || sessions.has(item.name)) {
          continue
        }
        const target = join(cacheRoot, item.name)
        try {
          const info = await stat(target)
          if (info.mtimeMs < cutoff) {
            await rm(target, { recursive: true, force: true })
          }
        } catch {}
      }
    } finally {
      cleaning = false
    }
  }

  async function clear() {
    for (const req of activeRequests) {
      req.destroy()
    }
    for (const session of sessions.values()) {
      session.active = false
      for (const req of session.requests) {
        req.destroy()
      }
    }
    sessions.clear()
    await Promise.allSettled(pending)
    await rm(cacheRoot, { recursive: true, force: true })
  }

  return {
    handle,
    clear,
    close: async () => {
      clearInterval(timer)
      await clear()
      files.close()
    },
    cacheRoot
  }
}

function requestWithHeaders(stream, headers) {
  return Object.assign(stream, { headers, method: 'POST' })
}

function json(res, body) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
