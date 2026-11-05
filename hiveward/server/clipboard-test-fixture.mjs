import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createClipboardService } from './clipboard.mjs'

export const digest = (value) => createHash('sha256').update(value).digest('hex')

export function createFakeAdapter({ writeDelay = 0, readDelay = 0 } = {}) {
  let current = { kind: 'text', text: '' }
  let closed = false
  let reads = 0
  const watchers = new Set()
  const writes = []
  return {
    writes,
    reads: () => reads,
    watch(onChange) {
      watchers.add(onChange)
      return () => watchers.delete(onChange)
    },
    async read() {
      reads++
      if (readDelay) {
        await new Promise((resolve) => setTimeout(resolve, readDelay))
      }
      return clone(current)
    },
    async write(payload, options = {}) {
      if (writeDelay) {
        await abortableDelay(writeDelay, options.signal)
      }
      if (options.signal?.aborted) {
        throw new Error('test clipboard write aborted')
      }
      current = clone(payload)
      writes.push(clone(payload))
      queueMicrotask(() => emit())
    },
    copy(payload) {
      current = clone(payload)
      emit()
    },
    value: () => clone(current),
    watching: () => watchers.size > 0,
    close() {
      closed = true
      watchers.clear()
    },
    closed: () => closed
  }
  function emit() {
    for (const callback of watchers) {
      callback()
    }
  }
}

export async function createClipboardNetwork() {
  const root = await mkdtemp(join(tmpdir(), 'hiveward-clipboard-test-'))
  const network = new Map()
  const instances = []

  async function add(id, options = {}) {
    const directory = join(root, id, 'data')
    const home = join(root, id, 'home')
    const adapter = createFakeAdapter(options)
    const notices = []
    const requests = []
    const entry = {
      id,
      name: id,
      online: true,
      secure: true,
      port: 0
    }
    const service = createClipboardService({
      directory,
      home,
      machine: { id, name: id },
      adapter,
      members: () =>
        [...network.values()]
          .filter((peer) => peer.id !== id && peer.online && peer.secure)
          .map((peer) => ({
            id: peer.id,
            name: peer.name,
            self: false,
            paired: true,
            status: 'online',
            secure: peer.secure
          })),
      request: (target, path, requestOptions) => send(id, target, path, requestOptions),
      notify: (notice) => notices.push(notice),
      cacheOptions: { cleanupInterval: 60000, cacheMaxAge: 60000 }
    })
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://x')
        const remote = req.headers['x-test-remote'] === '1'
        const peerId = req.headers['x-test-peer']
        requests.push(url.pathname)
        service.checkForward(req, url)
        const handled = await service.handle(req, res, url, {
          remote,
          peer: remote ? { id: peerId, name: peerId } : null,
          forwarded: req.headers['x-test-forwarded'] === '1'
        })
        if (!handled) {
          res.writeHead(404).end()
        }
      } catch (error) {
        if (!res.headersSent) {
          res.writeHead(error.status ?? 500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { code: error.code ?? 'failed' } }))
        } else {
          res.destroy()
        }
      }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    entry.port = server.address().port
    network.set(id, entry)
    service.start()
    const instance = {
      id,
      directory,
      home,
      adapter,
      service,
      notices,
      requests,
      local: (path, body) => localRequest(entry.port, path, body),
      close: async () => {
        network.delete(id)
        await new Promise((resolve) => {
          server.close(resolve)
          server.closeAllConnections()
        })
        await service.close()
      }
    }
    instances.push(instance)
    return instance
  }

  async function send(from, target, path, options = {}) {
    const destination = network.get(target)
    if (!destination || !destination.online || !destination.secure) {
      throw new Error('test peer unavailable')
    }
    const body =
      options.body &&
      typeof options.body === 'object' &&
      !Buffer.isBuffer(options.body) &&
      typeof options.body.pipe !== 'function'
        ? JSON.stringify(options.body)
        : options.body
    const response = await fetch(`http://127.0.0.1:${destination.port}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        'x-test-remote': '1',
        'x-test-peer': from,
        ...(body && typeof body !== 'string' && typeof body.pipe === 'function'
          ? options.headers
          : { 'content-type': 'application/json', ...options.headers }),
        ...(typeof body === 'string' ? { 'content-length': Buffer.byteLength(body) } : {})
      },
      body,
      signal: options.signal,
      ...(body && typeof body !== 'string' && typeof body.pipe === 'function'
        ? { duplex: 'half' }
        : {})
    })
    const raw = await response.text()
    return { status: response.status, data: raw ? JSON.parse(raw) : null }
  }

  return {
    root,
    add,
    send,
    close: async () => {
      for (const instance of instances.toReversed()) {
        await instance.close()
      }
      await rm(root, { recursive: true, force: true })
    }
  }
}

async function localRequest(port, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return { status: response.status, data: await response.json() }
}

export async function waitFor(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('waitFor timeout')
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(new Error('test clipboard write aborted'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
    }
  })
}

function clone(value) {
  if (value.kind === 'image') {
    return { ...value, png: Buffer.from(value.png) }
  }
  if (value.kind === 'files') {
    return { ...value, paths: [...value.paths] }
  }
  return { ...value }
}
