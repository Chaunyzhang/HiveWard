import type {
  TerminalStreamClientFrame,
  TerminalStreamServerFrame,
} from '@shared/api'

export type SocketState = 'connecting' | 'live' | 'reconnecting' | 'ended'

/**
 * 终端 WebSocket 连接：断了自动重连（退避到最多 5 秒），收到 exit / error 后不再重连。
 * url 每次重连时重新取（带上当前终端大小）。close() 之后不再有任何回调。
 */
export function openTerminalSocket({
  url,
  onFrame,
  onState,
}: {
  url: () => string
  onFrame: (frame: TerminalStreamServerFrame) => void
  onState: (state: SocketState) => void
}) {
  let ws: WebSocket | null = null
  let closed = false
  let ended = false
  let retry = 0
  let timer = 0

  const connect = () => {
    onState(retry === 0 ? 'connecting' : 'reconnecting')
    ws = new WebSocket(url())
    ws.onmessage = (e) => {
      if (closed || typeof e.data !== 'string') {
        return
      }
      const frame: TerminalStreamServerFrame = JSON.parse(e.data)
      if (frame.type === 'snapshot') {
        retry = 0
        onState('live')
      }
      if (frame.type === 'exit' || frame.type === 'error') {
        ended = true
        onState('ended')
      }
      onFrame(frame)
    }
    ws.onclose = () => {
      if (closed || ended) {
        return
      }
      onState('reconnecting')
      timer = window.setTimeout(connect, Math.min(5000, 500 * 2 ** retry++))
    }
  }
  connect()

  return {
    send(frame: TerminalStreamClientFrame) {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(frame))
      }
    },
    close() {
      closed = true
      window.clearTimeout(timer)
      ws?.close()
    },
  }
}
