import { hivewardEnvironment } from '../../../src/shared/hiveward-environment.mjs'
import { readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
const metaPath =
  hivewardEnvironment.HIVEWARD_RUNTIME_META ??
  join(homedir(), 'Library/Application Support/HiveWard-Dev/hiveward-runtime.json')
export function call(method, params = {}) {
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  return new Promise((resolve, reject) => {
    const socket = createConnection(meta.transports.find((t) => t.kind === 'unix').endpoint)
    const id = randomUUID()
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('RPC timeout'))
    }, 30000)
    let buf = ''
    socket.setEncoding('utf8')
    socket.on('error', reject)
    socket.on('connect', () =>
      socket.write(
        `${JSON.stringify({
          id,
          authToken: meta.authToken,
          method,
          params,
          ...(method.startsWith('orchestration.')
            ? { orchestrationContractVersion: 1, orchestrationRequestId: id }
            : {})
        })}\n`
      )
    )
    socket.on('data', (data) => {
      buf += data.toString()
      for (;;) {
        const end = buf.indexOf('\n')
        if (end === -1) {
          return
        }
        const line = buf.slice(0, end)
        buf = buf.slice(end + 1)
        if (!line) {
          continue
        }
        const frame = JSON.parse(line)
        if (frame.id !== id) {
          continue
        }
        clearTimeout(timer)
        socket.end()
        resolve(frame)
      }
    })
  })
}
if (process.argv[1]?.endsWith('/rpc.mjs')) {
  console.log(
    JSON.stringify(await call(process.argv[2], JSON.parse(process.argv[3] ?? '{}')), null, 2)
  )
}
