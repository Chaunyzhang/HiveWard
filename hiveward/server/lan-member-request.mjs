import { fileError } from './file-path-policy.mjs'
import { pinnedRequest } from './lan-tls.mjs'

const RESPONSE_LIMIT = 64 * 1024

export function memberRequest(identity, peer, path, options = {}) {
  const { method = 'GET', body, headers = {}, signal, timeout = 120000 } = options
  return new Promise((resolve, reject) => {
    let settled = false
    const requestHeaders = {
      authorization: `Bearer ${peer.outboundToken}`,
      ...headers
    }
    let payload = body
    if (
      body &&
      typeof body === 'object' &&
      !Buffer.isBuffer(body) &&
      typeof body.pipe !== 'function'
    ) {
      payload = Buffer.from(JSON.stringify(body))
      requestHeaders['content-type'] = 'application/json; charset=utf-8'
      requestHeaders['content-length'] = payload.length
    }
    const finish = (callback, value) => {
      if (settled) {
        return
      }
      settled = true
      signal?.removeEventListener('abort', abort)
      callback(value)
    }
    const request = pinnedRequest(
      identity,
      peer,
      path,
      { method, headers: requestHeaders },
      (response) => {
        const chunks = []
        let size = 0
        response.on('data', (chunk) => {
          size += chunk.length
          if (size > RESPONSE_LIMIT) {
            request.destroy(fileError(413, 'clipboard_response_too_large', '成员响应过大'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let data = null
          try {
            data = raw ? JSON.parse(raw) : null
          } catch {
            finish(reject, fileError(502, 'invalid_member_response', '成员响应不是 JSON'))
            return
          }
          finish(resolve, { status: response.statusCode ?? 502, data })
        })
        response.on('error', (error) => finish(reject, error))
      }
    )
    const abort = () => {
      payload?.destroy?.()
      request.destroy(fileError(499, 'clipboard_aborted', '剪贴板同步已停止'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
    }
    request.setTimeout(timeout, () => {
      request.destroy(fileError(504, 'machine_timeout', '成员请求响应超时'))
    })
    request.on('error', (error) => {
      payload?.destroy?.()
      finish(reject, error)
    })
    if (payload) {
      if (typeof payload.pipe === 'function') {
        payload.on('error', (error) => request.destroy(error))
        payload.pipe(request)
      } else {
        request.end(payload)
      }
    } else {
      request.end()
    }
  })
}
