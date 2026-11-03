import { WebSocket, WebSocketServer } from 'ws'

const connectPath = /^\/api\/mcp\/([^/]+)\/connect$/
const reject = (socket, status) =>
  socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)

export function createMcpWebSocketHandler({
  server,
  lan,
  fromThisMachine,
  service,
  pingInterval = 30000,
  idleTimeout = 30 * 60 * 1000
}) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024 * 1024,
    perMessageDeflate: false
  })
  const connections = new Set()
  const heartbeat = setInterval(() => {
    const now = Date.now()
    for (const connection of connections) {
      if (!connection.alive || now - connection.lastActivity > idleTimeout) {
        connection.ws.terminate()
      } else {
        connection.alive = false
        connection.ws.ping()
      }
    }
  }, pingInterval)
  heartbeat.unref()

  function accept(req, socket, head, isLan) {
    let url
    let upstreamPeer
    let member
    try {
      url = new URL(req.url, 'http://localhost')
      const proxy = !isLan && /^\/api\/m\/([^/]+)\/(.*)$/.exec(url.pathname)
      if (proxy) {
        upstreamPeer = lan.streamTarget(decodeURIComponent(proxy[1])).peer
        url = new URL(`/api/${proxy[2]}${url.search}`, 'http://localhost')
      }
      const match = connectPath.exec(url.pathname)
      if (!match) {
        return false
      }
      if (req.method !== 'GET') {
        reject(socket, 404)
        return true
      }
      if (isLan) {
        member = lan.authenticate(req)
        if (!member) {
          reject(socket, 403)
          return true
        }
      } else if (!fromThisMachine(req, server.address().port)) {
        reject(socket, 403)
        return true
      }
      const name = decodeURIComponent(match[1])
      wss.handleUpgrade(req, socket, head, (ws) => {
        const connection = { ws, alive: true, lastActivity: Date.now() }
        connections.add(connection)
        let upstream
        let session
        let failed = false
        let unsubscribed = false
        const pending = []
        const touch = () => {
          connection.lastActivity = Date.now()
        }
        const send = (text) => {
          touch()
          if (ws.readyState !== WebSocket.OPEN) {
            return
          }
          if (ws.bufferedAmount > 4 * 1024 * 1024) {
            ws.terminate()
            return
          }
          ws.send(text)
        }
        const fail = (code, message) => {
          if (failed || ws.readyState !== WebSocket.OPEN) {
            return
          }
          failed = true
          send(JSON.stringify({ type: 'error', code, message }))
          ws.close()
        }
        const authorized = () => {
          if (isLan) {
            return !!lan.authenticate(req)
          }
          if (!upstreamPeer) {
            return true
          }
          try {
            return (
              lan.streamTarget(upstreamPeer.id).peer?.outboundToken === upstreamPeer.outboundToken
            )
          } catch {
            return false
          }
        }
        const unsubscribe = lan.onMembershipChange?.(() => {
          if (!authorized()) {
            ws.terminate()
          }
        })
        const cleanup = () => {
          if (unsubscribed) {
            return
          }
          unsubscribed = true
          unsubscribe?.()
          connections.delete(connection)
          void session?.close()
          upstream?.terminate()
        }
        ws.on('pong', () => {
          connection.alive = true
        })
        ws.on('error', () => ws.terminate())
        ws.on('close', cleanup)
        if (upstreamPeer) {
          const upstreamUrl = `/api/mcp/${encodeURIComponent(name)}/connect`
          const connectionOptions = lan.streamConnection(upstreamPeer)
          upstream = new WebSocket(`wss://${connectionOptions.address}${upstreamUrl}`, {
            agent: connectionOptions.agent,
            headers: { authorization: `Bearer ${upstreamPeer.outboundToken}` },
            maxPayload: 4 * 1024 * 1024,
            handshakeTimeout: 10000,
            perMessageDeflate: false
          })
          upstream.on('open', () => {
            for (const text of pending.splice(0)) {
              upstream.send(text)
            }
          })
          upstream.on('message', (data, binary) => {
            if (binary) {
              fail('start_failed', '远端 MCP 发来了二进制帧')
              return
            }
            send(data.toString())
          })
          upstream.on('error', () => fail('start_failed', '远端 MCP 不可用'))
          upstream.on('close', () => ws.close())
        } else {
          try {
            session = service.open(name, member, {
              send,
              fail,
              exit: () => ws.close()
            })
          } catch (error) {
            fail(error.code ?? 'start_failed', error.message)
          }
        }
        ws.on('message', (raw, binary) => {
          touch()
          if (!authorized()) {
            ws.terminate()
            return
          }
          if (binary) {
            ws.close(1003, 'MCP only accepts text frames')
            return
          }
          const text = raw.toString()
          if (upstream) {
            if (upstream.readyState === WebSocket.OPEN) {
              if (upstream.bufferedAmount > 4 * 1024 * 1024) {
                ws.terminate()
                return
              }
              upstream.send(text)
            } else if (upstream.readyState === WebSocket.CONNECTING && pending.length < 128) {
              pending.push(text)
            } else {
              ws.terminate()
            }
            return
          }
          try {
            if (session && session.input(text) === false) {
              ws.terminate()
            }
          } catch {
            ws.close(1003, 'Invalid MCP JSON-RPC frame')
          }
        })
      })
      return true
    } catch {
      reject(socket, 400)
      return true
    }
  }

  return {
    accept,
    close() {
      clearInterval(heartbeat)
      for (const { ws } of connections) {
        ws.terminate()
      }
      wss.close()
    }
  }
}
