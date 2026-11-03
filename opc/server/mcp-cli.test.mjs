import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WebSocketServer } from 'ws'
import { runMcp } from './mcp-cli.mjs'

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  })

async function withFetch(stub, run) {
  const original = globalThis.fetch
  globalThis.fetch = stub
  try {
    await run()
  } finally {
    globalThis.fetch = original
  }
}

async function captureLogs(run) {
  const original = console.log
  const lines = []
  console.log = (...values) => lines.push(values.join(' '))
  try {
    await run()
    return lines.join('\n')
  } finally {
    console.log = original
  }
}

test('ls prints only public fields; add parses stdio/http without leaking env values', async () => {
  const calls = []
  const output = await captureLogs(() =>
    withFetch(
      async (url, options) => {
        calls.push({ url, options })
        if (url.endsWith('/available')) {
          return json([
            {
              name: 'demo',
              transport: 'stdio',
              description: '示例',
              command: 'secret-command',
              env: { TOKEN: 'secret-value' },
              url: 'http://localhost/secret'
            }
          ])
        }
        return json({ ok: true })
      },
      async () => {
        await runMcp(['ls'], {
          endpoint: (path) => `http://remote${path}`,
          localEndpoint: (path) => `http://local${path}`
        })
        await runMcp(
          [
            'add',
            'demo',
            '--desc',
            '说明',
            '--cwd',
            '/tmp/demo',
            '--env',
            'TOKEN=a=b',
            '--env',
            'EMPTY=',
            '--',
            'node',
            'server.mjs',
            '--flag',
            'x y'
          ],
          {
            endpoint: (path) => `http://remote${path}`,
            localEndpoint: (path) => `http://local${path}`
          }
        )
        await runMcp(['add', 'web', '--desc', 'HTTP', '--url', 'http://127.0.0.1:9000/mcp'], {
          endpoint: (path) => `http://remote${path}`,
          localEndpoint: (path) => `http://local${path}`
        })
      }
    )
  )

  assert.match(output, /^demo  stdio  示例$/m)
  assert.doesNotMatch(output, /secret|a=b|EMPTY/)
  assert.equal(calls[0].url, 'http://remote/api/mcp/available')
  assert.equal(calls[1].url, 'http://local/api/mcp/shares')
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    name: 'demo',
    enabled: true,
    transport: 'stdio',
    command: 'node',
    args: ['server.mjs', '--flag', 'x y'],
    cwd: '/tmp/demo',
    env: { TOKEN: 'a=b', EMPTY: '' },
    description: '说明'
  })
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    name: 'web',
    enabled: true,
    transport: 'http',
    url: 'http://127.0.0.1:9000/mcp',
    description: 'HTTP'
  })
})

test('off posts the complete local share without envKeys/sessions; rm uses an encoded local path', async () => {
  const calls = []
  await captureLogs(() =>
    withFetch(
      async (url, options) => {
        calls.push({ url, options })
        if (options.method !== 'POST') {
          return json([
            {
              name: 'demo',
              description: '说明',
              enabled: true,
              transport: 'stdio',
              command: 'node',
              args: ['server.mjs'],
              cwd: '/tmp/demo',
              envKeys: ['TOKEN'],
              allowMachines: ['machine-1'],
              sessions: 2
            }
          ])
        }
        return json({ ok: true })
      },
      async () => {
        const options = {
          endpoint: (path) => `http://remote${path}`,
          localEndpoint: (path) => `http://local${path}`
        }
        await runMcp(['off', 'demo'], options)
        await runMcp(['rm', 'a/b'], options)
      }
    )
  )

  assert.equal(calls[0].url, 'http://local/api/mcp/shares')
  assert.equal(calls[1].url, 'http://local/api/mcp/shares')
  const saved = JSON.parse(calls[1].options.body)
  assert.deepEqual(saved, {
    name: 'demo',
    description: '说明',
    enabled: false,
    transport: 'stdio',
    command: 'node',
    args: ['server.mjs'],
    cwd: '/tmp/demo',
    allowMachines: ['machine-1']
  })
  assert.equal('env' in saved, false)
  assert.equal(calls[2].url, 'http://local/api/mcp/shares/a%2Fb/remove')
  assert.deepEqual(JSON.parse(calls[2].options.body), {})
})

test('agent-launched management commands identify themselves for the local-only guard', async () => {
  const previous = process.env.ORCA_TERMINAL_HANDLE
  process.env.ORCA_TERMINAL_HANDLE = 'agent-terminal'
  try {
    await withFetch(
      async (_url, options) => {
        assert.equal(options.headers['x-opc-caller'], 'agent')
        return json({ error: { message: 'Agent 不能修改 MCP 共享配置' } }, 403)
      },
      async () => {
        await assert.rejects(
          runMcp(['add', 'demo', '--', 'node'], {
            localEndpoint: (path) => `http://local${path}`
          }),
          /Agent 不能修改/
        )
      }
    )
  } finally {
    if (previous === undefined) {
      delete process.env.ORCA_TERMINAL_HANDLE
    } else {
      process.env.ORCA_TERMINAL_HANDLE = previous
    }
  }
})

test('config emits verified Claude/Codex/Kimi syntax with POSIX-safe dynamic arguments', async () => {
  const output = await captureLogs(() =>
    runMcp(['config', "a'b c"], {
      machine: { name: 'ignored' },
      on: "Team's Mac"
    })
  )
  const name = "'a'\\''b c'"
  const machine = "'Team'\\''s Mac'"
  assert.equal(
    output,
    [
      `Claude Code:\nclaude mcp add ${name} -- hiwd mcp ${name} --on ${machine}`,
      `Codex:\ncodex mcp add ${name} -- hiwd mcp ${name} --on ${machine}`,
      `Kimi:\nkimi mcp add ${name} -- hiwd mcp ${name} --on ${machine}`
    ].join('\n')
  )
  await assert.rejects(runMcp(['config', 'demo'], {}), /--on/)
})

test('invalid argument counts and add forms reject before any request', async () => {
  const invalid = [
    [],
    ['ls', 'extra'],
    ['add'],
    ['add', 'demo'],
    ['add', 'demo', '--'],
    ['add', 'demo', '--env', 'MISSING_EQUALS', '--', 'node'],
    ['add', 'demo', '--env', '=empty-key', '--', 'node'],
    ['add', 'demo', '--url', 'http://localhost', '--cwd', '/tmp'],
    ['add', 'demo', '--url', 'http://localhost', '--', 'node'],
    ['rm'],
    ['rm', 'demo', 'extra'],
    ['on'],
    ['off', 'demo', 'extra'],
    ['unknown', 'extra']
  ]
  for (const args of invalid) {
    await assert.rejects(
      runMcp(args, { endpoint: () => assert.fail('unexpected request') }),
      Error,
      args.join(' ')
    )
  }
  await assert.rejects(
    runMcp(['rm', 'demo'], {
      machine: { self: false },
      localEndpoint: () => assert.fail('unexpected local request')
    }),
    /只能在本机/
  )
})

const moduleUrl = pathToFileURL(fileURLToPath(new URL('./mcp-cli.mjs', import.meta.url))).href
const bridgeSource = `
  import { runMcp } from ${JSON.stringify(moduleUrl)};
  try {
    await runMcp([process.argv[1]], { endpoint: (path) => process.argv[2] + path });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
`

function bridgeChild(base, name) {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', bridgeSource, name, base],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  )
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  return { child, done }
}

async function stopWebSocketServer(wss, server) {
  for (const client of wss.clients) {
    client.terminate()
  }
  await new Promise((resolve) => wss.close(resolve))
  await new Promise((resolve) => server.close(resolve))
}

test(
  'stdio bridge preserves lines, CRLF, UTF-8, EOF tails and ordinary remote text frames',
  { timeout: 10000 },
  async () => {
    const server = createServer()
    const wss = new WebSocketServer({ server })
    const received = []
    const paths = []
    const ordinary = ' {"type":"error","code":"other","message":"leave raw"} '
    wss.on('connection', (ws, request) => {
      paths.push(request.url)
      ws.send(ordinary)
      ws.on('message', (raw) => {
        const line = raw.toString()
        received.push(line)
        ws.send(line)
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { child, done } = bridgeChild(`http://127.0.0.1:${server.address().port}`, 'demo server')
    const first = '{"jsonrpc":"2.0","method":"中文"}'
    const tail = '{"id":2,"value":"a=b"}'
    try {
      child.stdin.end(`\n${first}\r\n\n${tail}`)
      const result = await done
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.signal, null)
      assert.equal(result.stderr, '')
      assert.deepEqual(received, [first, tail])
      assert.deepEqual(paths, ['/api/mcp/demo%20server/connect'])
      assert.equal(result.stdout, `${ordinary}\n${first}\n${tail}\n`)
    } finally {
      child.kill()
      await stopWebSocketServer(wss, server)
    }
  }
)

test(
  'McpConnectError stays off stdout and rejects with its contract code',
  { timeout: 10000 },
  async () => {
    const server = createServer()
    const wss = new WebSocketServer({ server })
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'error', code: 'disabled', message: '已停用' }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { child, done } = bridgeChild(`http://127.0.0.1:${server.address().port}`, 'demo')
    try {
      const result = await done
      assert.equal(result.code, 1)
      assert.equal(result.stdout, '')
      assert.equal(result.stderr.trim(), '[disabled] 已停用')
    } finally {
      child.stdin.destroy()
      child.kill()
      await stopWebSocketServer(wss, server)
    }
  }
)
