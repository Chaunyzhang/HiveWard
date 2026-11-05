import { Agent, request } from 'node:https'
import { connect } from 'node:tls'
import { createHash } from 'node:crypto'

export const validFingerprint = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export const validTlsPort = (value) => Number.isInteger(value) && value > 0 && value <= 65535
export const tlsError = (code, message) => Object.assign(new Error(message), { status: 403, code })
export function socketFingerprint(socket) {
  const raw = socket.encrypted && socket.getPeerCertificate?.().raw
  return raw ? createHash('sha256').update(raw).digest('hex') : null
}
export function tlsAddress(address, port) {
  if (!validTlsPort(port)) {
    throw tlsError('tls_rejoin_required', '对方没有 TLS 身份，请重新加入组织')
  }
  const url = new URL(`https://${address}`)
  url.port = String(port)
  return url.host
}
export function pinnedAgent(identity, fingerprint) {
  if (!validFingerprint(fingerprint)) {
    throw tlsError('tls_rejoin_required', '旧成员没有证书指纹，请退出后重新加入组织')
  }
  const agent = new Agent({ keepAlive: false, maxCachedSessions: 0 })
  agent.createConnection = (options, callback) => {
    let completed = false
    const finish = (error) => {
      if (completed) {
        return
      }
      completed = true
      socket.setTimeout(0)
      if (error) {
        socket.destroy()
        callback(error)
      } else {
        callback(null, socket)
      }
    }
    // HTTP cannot write credentials until this callback releases the verified TLS socket.
    const socket = connect(
      {
        ...options,
        key: identity.key,
        cert: identity.cert,
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2',
        session: undefined
      },
      () => {
        finish(
          socketFingerprint(socket) === fingerprint
            ? null
            : tlsError(
                'tls_fingerprint_mismatch',
                '对方证书指纹已改变，已拒绝连接；请核实后重新加入组织'
              )
        )
      }
    )
    socket.setTimeout(5000, () => finish(tlsError('tls_timeout', 'TLS 握手超时')))
    socket.once('error', finish)
  }
  return agent
}
export function pinnedRequest(identity, peer, path, options, response) {
  return request(
    `https://${tlsAddress(peer.address, peer.tlsPort)}${path}`,
    {
      ...options,
      agent: pinnedAgent(identity, peer.fingerprint)
    },
    response
  )
}
export async function tlsJson(identity, peer, path, { body, token, timeout = 1500 } = {}) {
  return new Promise((resolve, reject) => {
    const req = pinnedRequest(
      identity,
      peer,
      path,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {})
        }
      },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          raw += chunk
          if (raw.length > 4 * 1024 * 1024) {
            req.destroy(new Error('LAN 响应过大'))
          }
        })
        res.on('error', reject)
        res.on('end', () => {
          try {
            const value = JSON.parse(raw)
            if (res.statusCode < 200 || res.statusCode >= 300) {
              throw Object.assign(new Error(value.error?.message ?? `HTTP ${res.statusCode}`), {
                status: res.statusCode,
                code: value.error?.code ?? 'remote_error'
              })
            }
            resolve(value)
          } catch (error) {
            reject(error)
          }
        })
      }
    )
    const timer = setTimeout(() => req.destroy(tlsError('tls_timeout', '加密请求超时')), timeout)
    req.once('close', () => clearTimeout(timer))
    req.once('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
