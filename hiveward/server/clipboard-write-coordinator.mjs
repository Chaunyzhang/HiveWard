import { createHash } from 'node:crypto'
import { fileError } from './file-path-policy.mjs'

export function createClipboardWriteCoordinator({ adapter, active, current, record }) {
  let generation = 0
  let controller = new AbortController()
  let writing = false
  let applyChain = Promise.resolve()
  let nativeRead = Promise.resolve()
  let resolveNativeRead = null
  let confirmedEcho = null
  let suppress = null

  function change(ticket) {
    settle()
    generation = ticket
    if (writing) {
      controller.abort()
      controller = new AbortController()
    }
    nativeRead = new Promise((resolve) => {
      resolveNativeRead = resolve
    })
  }

  function echo(fingerprint, ticket) {
    if (suppress !== fingerprint) {
      return false
    }
    suppress = null
    confirmedEcho = { fingerprint, generation: ticket }
    settle(ticket)
    return true
  }

  function local() {
    suppress = null
    controller.abort()
    controller = new AbortController()
    settle()
  }

  function settle(ticket) {
    if (ticket !== undefined && ticket !== generation) {
      return
    }
    resolveNativeRead?.()
    resolveNativeRead = null
  }

  function apply({ ticket, peer, payload, count, bytes }) {
    const run = async () => {
      const signal = controller.signal
      if (!current(ticket) || !active() || signal.aborted) {
        return false
      }
      if (!adapter) {
        throw fileError(503, 'clipboard_unavailable', '本机剪贴板适配器不可用')
      }
      const fingerprint = payloadFingerprint(payload)
      suppress = fingerprint
      let failed = false
      writing = true
      try {
        await adapter.write(payload, { signal })
      } catch {
        failed = true
      } finally {
        writing = false
      }
      if (failed || signal.aborted) {
        const pendingRead = nativeRead
        await pendingRead
        if (
          confirmedEcho?.generation === generation &&
          confirmedEcho.fingerprint === fingerprint &&
          active()
        ) {
          record(peer, payload, { count, bytes })
          return true
        }
        if (signal.aborted || !current(ticket) || !active()) {
          return false
        }
        if (suppress === fingerprint) {
          suppress = null
        }
        throw fileError(502, 'clipboard_write_failed', '写入本机剪贴板失败')
      }
      if (!active() || signal.aborted) {
        return false
      }
      record(peer, payload, { count, bytes })
      return true
    }
    const result = applyChain.then(run, run)
    applyChain = result.then(
      () => {},
      () => {}
    )
    return result
  }

  return { change, echo, local, apply, settle }
}

export function payloadFingerprint(payload) {
  const hash = createHash('sha256')
  if (payload.kind === 'image') {
    hash.update(payload.png)
  } else if (payload.kind === 'files') {
    hash.update(JSON.stringify(payload.paths))
  } else {
    hash.update(JSON.stringify([payload.text, payload.html ?? null, payload.rtf ?? null]))
  }
  return `${payload.kind}:${hash.digest('hex')}`
}
