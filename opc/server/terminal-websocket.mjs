import { clientFrame, terminalDecoder, viewport } from './terminal-stream-codec.mjs'

const streamPath = /^\/api\/orca\/terminals\/([^/]+)\/stream$/
const reject = (socket, status) =>
  socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)

export function installTerminalWebSockets({
  server,
  lanServer,
  lan,
  fromThisMachine,
  streaming,
  mcp
}) {
  if (!streaming) {
    const unavailable = (req, socket, head, isLan = false) => {
      if (!mcp?.accept(req, socket, head, isLan)) {
        reject(socket, 503)
      }
    }
    server.on('upgrade', (req, socket, head) => unavailable(req, socket, head))
    lanServer?.on('upgrade', (req, socket, head) => unavailable(req, socket, head, true))
    return () => {}
  }
  const wss = new streaming.WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false
  })
  const connections = new Set()
  const alive = new WeakSet()
  const heartbeat = setInterval(() => {
    for (const ws of connections) {
      if (!alive.has(ws)) {
        ws.terminate()
      } else {
        alive.delete(ws)
        ws.ping()
      }
    }
  }, 30000)
  heartbeat.unref()
  function accept(req, socket, head, isLan) {
    if (mcp?.accept(req, socket, head, isLan)) {
      return
    }
    try {
      if (isLan ? !lan.authenticate(req) : !fromThisMachine(req, server.address().port)) {
        return reject(socket, 403)
      }
      let url = new URL(req.url, 'http://localhost')
      const proxy = !isLan && /^\/api\/m\/([^/]+)\/(.*)$/.exec(url.pathname)
      let peer
      if (proxy) {
        const target = lan.streamTarget(decodeURIComponent(proxy[1]))
        url = new URL(`/api/${proxy[2]}${url.search}`, 'http://localhost')
        peer = target.peer
      }
      const match = streamPath.exec(url.pathname)
      if (req.method !== 'GET' || !match) {
        return reject(socket, 404)
      }
      const size = viewport({
        cols: Number(url.searchParams.get('cols')),
        rows: Number(url.searchParams.get('rows'))
      })
      wss.handleUpgrade(req, socket, head, (ws) => {
        connections.add(ws)
        alive.add(ws)
        ws.on('pong', () => alive.add(ws))
        const authorized = () => {
          if (isLan) {
            return !!lan.authenticate(req)
          }
          if (!peer) {
            return true
          }
          try {
            return lan.streamTarget(peer.id).peer?.outboundToken === peer.outboundToken
          } catch {
            return false
          }
        }
        const revoke = () => {
          if (!authorized()) {
            ws.terminate()
          }
        }
        const unsubscribe = lan.onMembershipChange?.(revoke)
        let session
        let upstream
        const send = (frame) => {
          if (ws.readyState !== 1) {
            return
          }
          if (ws.bufferedAmount > 4 * 1024 * 1024) {
            return ws.terminate()
          }
          ws.send(JSON.stringify(frame))
          if (frame.type === 'error' || frame.type === 'exit') {
            ws.close()
          }
        }
        const fail = (error) => send({ type: 'error', message: error.message })
        ws.on('error', () => ws.terminate())
        ws.on('close', () => {
          unsubscribe?.()
          connections.delete(ws)
          session?.close()
          upstream?.terminate()
        })
        try {
          if (peer) {
            const connection = lan.streamConnection(peer)
            upstream = new streaming.WebSocket(
              `wss://${connection.address}${url.pathname}${url.search}`,
              {
                agent: connection.agent,
                headers: { authorization: `Bearer ${peer.outboundToken}` },
                maxPayload: 12 * 1024 * 1024,
                handshakeTimeout: 10000,
                perMessageDeflate: false
              }
            )
            upstream.on('message', (data, binary) => {
              if (binary) {
                return fail(new Error('Unexpected binary terminal frame'))
              }
              try {
                send(JSON.parse(data.toString()))
              } catch (error) {
                fail(error)
              }
            })
            upstream.on('error', () => fail(new Error('Remote terminal unavailable')))
            upstream.on('close', () => ws.close())
          } else {
            const decode = terminalDecoder(send)
            session = streaming.open(decodeURIComponent(match[1]), size, (event) => {
              try {
                decode(event)
              } catch (error) {
                fail(error)
              }
            })
          }
          ws.on('message', (raw, binary) => {
            try {
              if (!authorized()) {
                return ws.terminate()
              }
              if (binary) {
                throw new Error('Only JSON text frames are accepted')
              }
              const frame = clientFrame(raw.toString())
              if (upstream) {
                if (upstream.readyState !== 1) {
                  throw new Error('Remote terminal not ready')
                }
                if (upstream.bufferedAmount > 1024 * 1024) {
                  throw new Error('Terminal input queue full')
                }
                upstream.send(JSON.stringify(frame))
              } else if (frame.type === 'input') {
                session.input(frame.data)
              } else {
                session.resize(frame)
              }
            } catch (error) {
              fail(error)
            }
          })
        } catch (error) {
          fail(error)
        }
      })
    } catch {
      reject(socket, 400)
    }
  }
  server.on('upgrade', (req, socket, head) => accept(req, socket, head, false))
  lanServer?.on('upgrade', (req, socket, head) => accept(req, socket, head, true))
  return () => {
    clearInterval(heartbeat)
    for (const ws of connections) {
      ws.terminate()
    }
    wss.close()
  }
}
