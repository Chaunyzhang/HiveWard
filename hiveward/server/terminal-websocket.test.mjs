import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { installTerminalWebSockets } from './terminal-websocket.mjs'

test(
  'upgrade authorization, JSON frames and socket-owned teardown',
  { timeout: 5000 },
  async () => {
    const server = createServer()
    let closed = 0
    let resolveClosed
    const sessionClosed = new Promise((resolve) => {
      resolveClosed = resolve
    })
    const inputs = []
    const stop = installTerminalWebSockets({
      server,
      lan: {},
      fromThisMachine: (req) => req.headers.origin === 'http://allowed',
      streaming: {
        WebSocketServer,
        WebSocket,
        open(_h, _v, emit) {
          queueMicrotask(() => {
            emit({ type: 'snapshot-start', payload: Buffer.from('{"cols":80,"rows":24}') })
            emit({ type: 'snapshot-end' })
          })
          return {
            input: (s) => inputs.push(s),
            resize: () => {},
            close: () => {
              closed++
              resolveClosed()
            }
          }
        }
      }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = `ws://127.0.0.1:${server.address().port}/api/hiveward/terminals/t/stream?cols=80&rows=24`
    try {
      const denied = new WebSocket(url, { origin: 'http://evil' })
      denied.on('error', () => {})
      assert.equal((await once(denied, 'unexpected-response'))[1].statusCode, 403)
      denied.terminate()
      const ws = new WebSocket(url, { origin: 'http://allowed' })
      const first = once(ws, 'message')
      await once(ws, 'open')
      assert.equal(JSON.parse((await first)[0]).type, 'snapshot')
      ws.send(JSON.stringify({ type: 'input', data: '\u0003中文\r' }))
      // Ordered invalid frame provides an observable processing boundary for the preceding input.
      const failure = once(ws, 'message')
      ws.send('{')
      assert.equal(JSON.parse((await failure)[0]).type, 'error')
      await once(ws, 'close')
      assert.deepEqual(inputs, ['\u0003中文\r'])
    } finally {
      stop()
      await new Promise((r) => server.close(r))
    }
    await sessionClosed
    assert.equal(closed, 1)
  }
)

test(
  'membership revocation closes an already authorized LAN stream',
  { timeout: 5000 },
  async () => {
    const server = createServer()
    const lanServer = createServer()
    const listeners = new Set()
    let paired = true
    let resolveClosed
    const closed = new Promise((resolve) => {
      resolveClosed = resolve
    })
    const stop = installTerminalWebSockets({
      server,
      lanServer,
      fromThisMachine: () => true,
      lan: {
        authenticate: () => paired,
        onMembershipChange: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      },
      streaming: {
        WebSocketServer,
        WebSocket,
        open: () => ({
          input() {
            assert.fail('revoked input')
          },
          resize() {},
          close: resolveClosed
        })
      }
    })
    lanServer.listen(0, '127.0.0.1')
    await once(lanServer, 'listening')
    try {
      const ws = new WebSocket(
        `ws://127.0.0.1:${lanServer.address().port}/api/hiveward/terminals/t/stream?cols=80&rows=24`
      )
      await once(ws, 'open')
      const disconnected = once(ws, 'close')
      paired = false
      for (const listener of listeners) {
        listener()
      }
      await disconnected
      await closed
      assert.equal(listeners.size, 0)
    } finally {
      stop()
      await new Promise((resolve) => lanServer.close(resolve))
    }
  }
)
