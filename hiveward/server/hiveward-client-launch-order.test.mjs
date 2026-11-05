import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { call, closeRuntimeConnection, configureRuntimeMetadata } from './hiveward-client.mjs'
import { configureExitRegionGuard, createExitRegionGuard } from './agent-exit-region.mjs'
import { configureTerminalCli } from './terminal-cli.mjs'

test('terminal.create validates caller parameters before decorating Windows agent launches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hiveward-client-launch-order-'))
  const hostPlatform = process.platform
  const endpoint =
    hostPlatform === 'win32'
      ? `\\\\.\\pipe\\hiveward-client-launch-${process.pid}-${randomUUID()}`
      : join(root, 'rpc.sock')
  const requests = []
  const sockets = new Set()
  const runtime = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buffer = ''
    socket.on('data', (data) => {
      buffer += data.toString()
      let end
      while ((end = buffer.indexOf('\n')) !== -1) {
        const request = JSON.parse(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
        requests.push(request)
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, result: { handle: 'fixture' } })}\n`
        )
      }
    })
  })
  runtime.listen(endpoint)
  await once(runtime, 'listening')
  await writeFile(
    join(root, 'runtime.json'),
    JSON.stringify({
      authToken: 'fixture',
      transports: [{ kind: hostPlatform === 'win32' ? 'named-pipe' : 'unix', endpoint }]
    })
  )

  const originalRuntimeMeta = process.env.HIVEWARD_RUNTIME_META
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  const cliDirectory = 'C:\\HiveWard\\resources\\opc\\bin'
  try {
    delete process.env.HIVEWARD_RUNTIME_META
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    configureTerminalCli(cliDirectory)
    configureExitRegionGuard(
      createExitRegionGuard({
        directory: join(root, 'policy'),
        capture: async () => ({ env: {}, shell: 'powershell.exe' }),
        probe: async () => ({ country: 'US', method: 'fixture', source: null })
      })
    )
    configureRuntimeMetadata(join(root, 'runtime.json'))

    for (const agent of ['claude', 'codex']) {
      const result = await call('terminal.create', {
        command: agent,
        launchAgent: agent,
        cwd: root
      })
      assert.equal(result.handle, 'fixture')
    }

    assert.equal(requests.length, 2)
    assert.deepEqual(
      requests.map((request) => request.params.command),
      ['claude', 'codex']
    )
    for (const request of requests) {
      assert.equal(request.authToken, 'fixture')
      assert.equal(request.params.shell, 'powershell.exe')
      assert.ok(request.params.env.Path.split(';').includes(cliDirectory))
      assert.equal(request.params.env.PATH, request.params.env.Path)
      assert.equal(
        request.params.env.HIVEWARD_BRIDGE,
        process.env.HIVEWARD_BRIDGE || 'http://127.0.0.1:47615'
      )
    }

    for (const params of [
      { command: 'claude', env: { HTTPS_PROXY: 'http://127.0.0.1:7890' } },
      { command: 'codex', shell: 'cmd.exe' }
    ]) {
      await assert.rejects(call('terminal.create', params), (error) => {
        assert.equal(error.code, 'exit_region_blocked')
        assert.equal(error.details?.reason, 'unsupported_launch_environment')
        return true
      })
    }
    assert.equal(requests.length, 2)
  } finally {
    closeRuntimeConnection()
    configureTerminalCli(undefined)
    configureExitRegionGuard(undefined)
    if (originalRuntimeMeta === undefined) {
      delete process.env.HIVEWARD_RUNTIME_META
    } else {
      process.env.HIVEWARD_RUNTIME_META = originalRuntimeMeta
    }
    Object.defineProperty(process, 'platform', platformDescriptor)
    for (const socket of sockets) {
      socket.destroy()
    }
    await new Promise((resolve) => runtime.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})
