import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { openHivewarddStdioBridgeChannel } from '../ssh/hivewardd-stdio-bridge'
import { fakeWslBridgeChildren, posixHivewarddStdioBridge } from './wsl-hivewardd-bridge-test-child'
import { createWslHivewarddHostTransport } from './wsl-hivewardd-host-transport'
import { watchChannel } from './wsl-hivewardd-watch'

const servers: Server[] = []

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close()
  }
})

async function hivewarddLike(): Promise<{ port: number; sockets: Socket[] }> {
  const sockets: Socket[] = []
  const server = createServer((socket) => sockets.push(socket))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return { port: typeof address === 'object' && address ? address.port : 0, sockets }
}

async function openWatch(port: number) {
  const children = fakeWslBridgeChildren()
  const transport = createWslHivewarddHostTransport({
    target: { kind: 'wsl', id: 'wsl:ubuntu', distro: 'Ubuntu', label: 'Ubuntu' },
    spawn: children.spawn
  })
  const channel = await openHivewarddStdioBridgeChannel(transport, posixHivewarddStdioBridge(port))
  return { watch: await watchChannel(channel, 5_000), children }
}

describe('watchChannel', () => {
  it('holds a ready bridge and reports its exit code when hivewardd closes it', async () => {
    const hivewardd = await hivewarddLike()
    const { watch } = await openWatch(hivewardd.port)
    expect(watch.signal).toBe('ready')
    const exited = new Promise<number | null>((resolve) => watch.onExit(resolve))
    await new Promise((resolve) => setTimeout(resolve, 20))
    hivewardd.sockets[0].destroy()
    expect(await exited).toBe(0)
  })

  it('reads a refused port as refused and holds nothing', async () => {
    const hivewardd = await hivewarddLike()
    await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()))
    const { watch, children } = await openWatch(hivewardd.port)
    expect(watch.signal).toBe('refused')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(children.live()).toBe(0)
  })

  it('never reports an exit it caused itself', async () => {
    const hivewardd = await hivewarddLike()
    const { watch, children } = await openWatch(hivewardd.port)
    let reported = false
    watch.onExit(() => {
      reported = true
    })
    watch.close()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(children.live()).toBe(0)
    expect(reported).toBe(false)
  })
})
