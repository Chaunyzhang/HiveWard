import { randomUUID } from 'node:crypto'
import { TERMINAL_SUBSCRIBE_METHODS } from '../runtime/rpc/methods/terminal/terminal-subscribe-method'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  type TerminalStreamFrame
} from '../../shared/terminal-stream-protocol'
import { mainProcessState } from '../startup/main-process-state'

type Viewport = { cols: number; rows: number }
type StreamEvent = { type: string; payload?: Uint8Array | string }

export function openHiveWardTerminalStream(
  terminal: string,
  initial: Viewport,
  emit: (event: StreamEvent) => void
) {
  const runtime = mainProcessState.runtime
  if (!runtime) {
    throw new Error('Runtime unavailable')
  }
  const controller = new AbortController()
  const id = `hiveward:${randomUUID()}`
  let handler: ((frame: TerminalStreamFrame) => void) | undefined
  let streamId = 0
  let size = initial
  let ready = false
  // 显示这个终端的窗口要它按自己的大小排版（不只是登记大小）
  let claimed = false
  const pendingInput: string[] = []
  let pendingBytes = 0
  const names = new Map([
    [TerminalStreamOpcode.SnapshotStart, 'snapshot-start'],
    [TerminalStreamOpcode.SnapshotChunk, 'snapshot-chunk'],
    [TerminalStreamOpcode.SnapshotEnd, 'snapshot-end'],
    [TerminalStreamOpcode.Output, 'output']
  ])
  const control = (opcode: TerminalStreamOpcode, payload: Uint8Array) => {
    if (!handler) {
      throw new Error('Terminal snapshot is not ready')
    }
    handler({ opcode, streamId, seq: 0, payload })
  }
  const method = TERMINAL_SUBSCRIBE_METHODS[0]
  void method
    .handler(
      method.params.parse({
        terminal,
        client: { id, type: 'desktop' },
        viewport: initial,
        capabilities: { terminalBinaryStream: 1, desktopViewportClaims: 1, writeUnavailable: 1 }
      }),
      {
        runtime,
        connectionId: id,
        requestId: id,
        signal: controller.signal,
        sendBinary(bytes) {
          const frame = decodeTerminalStreamFrame(bytes)
          if (!frame) {
            throw new Error('Invalid engine terminal frame')
          }
          const type = names.get(frame.opcode)
          if (type) {
            emit({ type, payload: frame.payload })
          }
          if (frame.opcode === TerminalStreamOpcode.SnapshotEnd) {
            ready = true
            control(
              claimed ? TerminalStreamOpcode.ClaimViewport : TerminalStreamOpcode.Resize,
              encodeTerminalStreamJson(size)
            )
            for (const data of pendingInput.splice(0)) {
              input(data)
            }
            pendingBytes = 0
          }
          if (frame.opcode === TerminalStreamOpcode.Error) {
            emit({ type: 'error', payload: 'Engine terminal stream failed' })
          }
          if (frame.opcode === TerminalStreamOpcode.WriteUnavailable) {
            emit({ type: 'error', payload: 'Terminal input unavailable' })
          }
          return true
        },
        registerBinaryStreamHandler(nextId, next) {
          streamId = nextId
          handler = next
          return () => {
            handler = undefined
          }
        }
      },
      (event) => {
        if (!event || typeof event !== 'object' || !('type' in event)) {
          return
        }
        const frame = event
        if (frame.type === 'end' && !controller.signal.aborted) {
          emit({ type: 'exit' })
        }
        if (frame.type === 'subscribed' && 'streamId' in frame && frame.streamId === null) {
          emit({ type: 'error', payload: 'Terminal PTY did not become ready' })
        }
      }
    )
    .catch((error) => {
      if (!controller.signal.aborted) {
        emit({ type: 'error', payload: error.message })
      }
    })
  function input(data: string): void {
    if (!ready) {
      pendingBytes += Buffer.byteLength(data)
      if (pendingBytes > 1024 * 1024) {
        throw new Error('Terminal input queue full')
      }
      pendingInput.push(data)
      return
    }
    control(TerminalStreamOpcode.ClaimViewport, encodeTerminalStreamJson(size))
    control(TerminalStreamOpcode.Input, new TextEncoder().encode(data))
  }
  return {
    input,
    resize(next: Viewport & { claim?: boolean }) {
      size = { cols: next.cols, rows: next.rows }
      claimed ||= next.claim === true
      if (ready) {
        control(
          next.claim ? TerminalStreamOpcode.ClaimViewport : TerminalStreamOpcode.Resize,
          encodeTerminalStreamJson(size)
        )
      }
    },
    close() {
      controller.abort()
    }
  }
}
