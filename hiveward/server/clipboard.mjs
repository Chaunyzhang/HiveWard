import { createClipboardStore } from './clipboard-store.mjs'
import { createClipboardFileCache } from './clipboard-file-cache.mjs'
import { broadcastClipboard } from './clipboard-send.mjs'
import { fileError } from './file-path-policy.mjs'
import { dataDir } from './data-dir.mjs'
import { readClipboardJson, validClipboardPush } from './clipboard-protocol.mjs'
import {
  createClipboardWriteCoordinator,
  payloadFingerprint
} from './clipboard-write-coordinator.mjs'

const BODY_LIMIT = 96 * 1024 * 1024

export function createClipboardService({
  directory = dataDir(),
  home,
  machine = { id: 'local', name: '本机' },
  members = () => [],
  request,
  adapter = null,
  notify = () => {},
  cacheOptions = {}
}) {
  const store = createClipboardStore(directory)
  let generation = 0
  let arrival = 0
  let reading = false
  let queued = false
  let stopped = false
  let stopWatch = null
  let sendController = null
  let settingsChain = Promise.resolve()
  const seen = new Set()
  const receiver = createClipboardWriteCoordinator({
    adapter,
    active: () => store.settings().enabled && !stopped,
    current: (ticket) => ticket === arrival,
    record: (peer, payload, details) => record('received', peer, payload.kind, details)
  })

  const cache = createClipboardFileCache({
    directory,
    home,
    ...cacheOptions,
    settings: store.settings,
    arrive: () => ++arrival,
    apply: receiver.apply,
    onSkipped: (peer, manifest) => skippedFiles(peer, manifest)
  })

  function record(direction, target, kind, details = {}) {
    return store.add({ direction, machine: target, kind, ...details })
  }

  function changed(ticket) {
    if (reading) {
      queued = true
      return
    }
    reading = true
    void readAndSend(ticket).finally(() => {
      reading = false
      if (queued && !stopped) {
        queued = false
        changed(generation)
      }
    })
  }

  async function readAndSend(ticket) {
    let kind = 'text'
    let classified = false
    try {
      const value = await adapter.read()
      kind = value.kind ?? 'text'
      if (ticket !== generation || !store.settings().enabled) {
        return
      }
      if (value.skipped) {
        invalidateReceived()
        classified = true
        record('sent', machine, kind, { skipped: value.skipped })
        return
      }
      const fingerprint = payloadFingerprint(value)
      if (receiver.echo(fingerprint, ticket)) {
        classified = true
        return
      }
      invalidateReceived()
      classified = true
      await broadcastClipboard({
        payload: value,
        machine,
        members,
        request,
        maxFileBytes: store.settings().maxFileBytes,
        isCurrent: () => ticket === generation && store.settings().enabled && !stopped,
        signal: sendController.signal,
        record: (target, eventKind, details) => record('sent', target, eventKind, details)
      })
    } catch {
      if (ticket === generation && store.settings().enabled && !stopped) {
        if (!classified) {
          invalidateReceived()
        }
        record('sent', machine, kind, { skipped: 'send_failed' })
      }
    }
  }

  function syncWatch() {
    stopWatch?.()
    stopWatch = null
    if (!adapter || stopped || !store.settings().enabled) {
      return
    }
    stopWatch =
      adapter.watch(() => {
        generation++
        receiver.change(generation)
        sendController?.abort()
        sendController = new AbortController()
        changed(generation)
      }) ?? (() => {})
  }

  function invalidateReceived() {
    arrival++
    receiver.local(generation)
  }

  function skippedFiles(peer, manifest) {
    record('received', peer, 'files', {
      count: manifest.count,
      bytes: manifest.totalBytes ?? manifest.bytes,
      skipped: 'files_too_large'
    })
    try {
      notify({
        type: 'files_too_large',
        machine: { id: peer.id, name: peer.name },
        count: manifest.count,
        bytes: manifest.totalBytes ?? manifest.bytes
      })
    } catch {}
  }

  function queueSettings(req, res) {
    const work = settingsChain.then(() => updateSettings(req, res))
    settingsChain = work.then(
      () => {},
      () => {}
    )
    return work
  }

  async function updateSettings(req, res) {
    const status = store.setSettings(await readClipboardJson(req, 4096))
    if (!status.settings.enabled) {
      generation++
      arrival++
      sendController?.abort()
      receiver.local(generation)
      syncWatch()
      await cache.clear()
    } else {
      syncWatch()
    }
    json(res, status)
  }

  async function handle(req, res, url, { remote = false, peer = null, forwarded = false } = {}) {
    if (!url.pathname.startsWith('/api/clipboard')) {
      return false
    }
    if (remote && !peer) {
      throw fileError(
        403,
        'clipboard_secure_channel_required',
        '剪贴板只允许加密且已认证的成员通道'
      )
    }
    if (url.pathname === '/api/clipboard' && req.method === 'GET') {
      json(res, store.status())
      return true
    }
    if (url.pathname === '/api/clipboard/settings') {
      if (req.method !== 'POST') {
        throw fileError(405, 'method_not_allowed', '方法不支持')
      }
      if (remote || forwarded) {
        throw fileError(403, 'clipboard_settings_local_only', '剪贴板设置只能在本机修改')
      }
      await queueSettings(req, res)
      return true
    }
    if (await cache.handle(req, res, url, { remote, peer })) {
      return true
    }
    if (!remote || !peer || !store.settings().enabled) {
      throw fileError(403, 'clipboard_disabled', '接收方剪贴板同步未开启')
    }
    if (url.pathname === '/api/clipboard/push' && req.method === 'POST') {
      const body = validClipboardPush(await readClipboardJson(req, BODY_LIMIT), peer.id)
      if (seen.has(body.eventId)) {
        json(res, { ok: true })
        return true
      }
      remember(body.eventId)
      const ticket = ++arrival
      const applied = await receiver.apply({
        ticket,
        peer,
        payload: body.payload,
        bytes: body.bytes
      })
      json(res, { ok: true, applied })
      return true
    }
    if (url.pathname === '/api/clipboard/notice' && req.method === 'POST') {
      const body = await readClipboardJson(req, 4096)
      if (
        body.origin !== peer.id ||
        body.kind !== 'files' ||
        body.reason !== 'files_too_large' ||
        !/^[a-f0-9-]{36}$/.test(body.eventId) ||
        !Number.isSafeInteger(body.count) ||
        body.count < 1 ||
        body.count > 1000 ||
        !Number.isSafeInteger(body.bytes) ||
        body.bytes < 0
      ) {
        throw fileError(400, 'bad_request', '剪贴板提醒无效')
      }
      skippedFiles(peer, body)
      json(res, { ok: true })
      return true
    }
    throw fileError(404, 'not_found', '剪贴板接口不存在')
  }

  function remember(id) {
    seen.add(id)
    if (seen.size > 200) {
      seen.delete(seen.values().next().value)
    }
  }

  return {
    handle,
    checkForward(req, url) {
      if (
        req.method === 'POST' &&
        /^\/api\/m\/[^/]+\/(?:api\/)?clipboard\/settings$/.test(url.pathname)
      ) {
        throw fileError(403, 'clipboard_settings_local_only', '剪贴板设置不能经 /api/m/ 转发')
      }
    },
    start: syncWatch,
    close: async () => {
      stopped = true
      generation++
      arrival++
      sendController?.abort()
      receiver.local(generation)
      syncWatch()
      await settingsChain
      adapter?.close()
      await cache.close()
    }
  }
}

function json(res, body) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
