import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const root = await mkdtemp(join(tmpdir(), 'hiveward-mcp-acceptance-'))
const hiwd = fileURLToPath(new URL('../hiwd.mjs', import.meta.url))
const stdioFixture = fileURLToPath(new URL('./mcp-stdio-fixture.mjs', import.meta.url))
const bridgeFixture = fileURLToPath(new URL('./mcp-bridge-fixture.mjs', import.meta.url))
const children = new Set()
const sockets = new Set()
const logs = { A: '', B: '' }
const marker = `MCP_PRIVATE_${Date.now()}`
let httpStub

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) {
      return
    }
    await sleep(30)
  }
  throw new Error('acceptance condition timed out')
}
async function freePort() {
  const server = createNetServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}
async function api(base, path, body, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const data = await response.json().catch(() => null)
  return { status: response.status, data }
}
function cli(base, args, { input, keepOpen = false } = {}) {
  const env = { ...process.env, HIVEWARD_BRIDGE: base, HIVEWARD_BACKGROUND_LAUNCH: '1' }
  for (const key of [
    'HIVEWARD_TERMINAL_HANDLE',
    'CLAUDE_CODE_SESSION_ID',
    'CODEX_THREAD_ID',
    'HIVEWARD_DISPATCHER'
  ]) {
    delete env[key]
  }
  const child = spawn(process.execPath, [hiwd, ...args], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  children.add(child)
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      children.delete(child)
      resolve({ code, signal, stdout, stderr })
    })
  })
  if (!keepOpen) {
    child.stdin.end(input)
  } else if (input) {
    child.stdin.write(input)
  }
  return { child, done, stdout: () => stdout, stderr: () => stderr }
}
async function runCli(base, args, options) {
  const command = `$ HIVEWARD_BRIDGE=${base} node hiveward/server/hiwd.mjs ${args.join(' ')}`
  const result = await cli(base, args, options).done
  console.log(`${command}\nexit=${result.code}\nstdout:\n${result.stdout}stderr:\n${result.stderr}`)
  return result
}
async function conversation(base, args, requests) {
  const running = cli(base, args, { keepOpen: true })
  for (const request of requests) {
    running.child.stdin.write(`${JSON.stringify(request)}\n`)
    await waitFor(() =>
      running
        .stdout()
        .split('\n')
        .some((line) => {
          try {
            return JSON.parse(line).id === request.id
          } catch {
            return false
          }
        })
    )
  }
  running.child.stdin.end()
  const result = await running.done
  console.log(
    `$ HIVEWARD_BRIDGE=${base} node hiveward/server/hiwd.mjs ${args.join(' ')}\nexit=${result.code}\nstdout:\n${result.stdout}stderr:\n${result.stderr}`
  )
  return result
}
async function startBridge(name, ports) {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'machine.json'), JSON.stringify({ id: name, name }))
  const child = spawn(process.execPath, [bridgeFixture], {
    env: {
      ...process.env,
      HIVEWARD_DATA_DIR: directory,
      HIVEWARD_PORT: String(ports.local),
      HIVEWARD_LAN_PORT: String(ports.plain),
      HIVEWARD_LAN_TLS_PORT: String(ports.tls),
      HIVEWARD_DISCOVERY_PORT: String(ports.discovery),
      HIVEWARD_RUNTIME_META: join(root, 'no-real-hiveward.json'),
      HIVEWARD_BACKGROUND_LAUNCH: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  children.add(child)
  child.stdout.on('data', (chunk) => (logs[name] += chunk))
  child.stderr.on('data', (chunk) => (logs[name] += chunk))
  const base = `http://127.0.0.1:${ports.local}`
  await waitFor(async () => {
    if (child.exitCode !== null) {
      throw new Error(`${name} bridge exited: ${logs[name]}`)
    }
    return (await api(base, '/api/machines').catch(() => null))?.status === 200
  })
  return { name, base, directory, child, ...ports }
}
async function stopBridge(instance) {
  if (instance.child.exitCode !== null) {
    children.delete(instance.child)
    return
  }
  const exited = once(instance.child, 'exit')
  console.log(`$ kill -TERM ${instance.child.pid} # ${instance.name} test bridge only`)
  instance.child.kill('SIGTERM')
  await exited
  children.delete(instance.child)
}
function wsUrl(instance, path) {
  return `${instance.base.replace('http:', 'ws:')}${path}`
}
async function openWs(url) {
  const ws = new WebSocket(url)
  sockets.add(ws)
  ws.on('close', () => sockets.delete(ws))
  await once(ws, 'open')
  return ws
}
async function wsRequest(ws, request) {
  const incoming = once(ws, 'message')
  ws.send(JSON.stringify(request))
  return JSON.parse((await incoming)[0].toString())
}
async function connectError(url) {
  const ws = new WebSocket(url)
  const incoming = once(ws, 'message')
  const closed = once(ws, 'close')
  try {
    await once(ws, 'open')
    const frame = JSON.parse((await incoming)[0].toString())
    await closed
    return frame
  } finally {
    ws.terminate()
  }
}
async function processGone(pid) {
  try {
    process.kill(pid, 0)
  } catch (error) {
    return error.code === 'ESRCH'
  }
  return false
}
async function scan(directory, needle) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      found.push(...(await scan(path, needle)))
    } else if ((await readFile(path)).includes(needle)) {
      found.push(path)
    }
  }
  return found
}

let A
let B
try {
  const [aLocal, aPlain, aTls, bLocal, bPlain, bTls, discovery] = await Promise.all(
    Array.from({ length: 7 }, freePort)
  )
  B = await startBridge('B', { local: bLocal, plain: bPlain, tls: bTls, discovery })
  A = await startBridge('A', { local: aLocal, plain: aPlain, tls: aTls, discovery })
  console.log(`SERVERS A=${A.base} B=${B.base} data=${root}`)

  const invited = await api(A.base, '/api/machines/invite', { address: `127.0.0.1:${B.plain}` })
  assert.equal(invited.status, 200, JSON.stringify(invited))
  const machinesAtB = await api(B.base, '/api/machines')
  const incoming = machinesAtB.data.invitations.find((item) => item.id === invited.data.id)
  assert.equal(incoming.verifyCode, invited.data.verifyCode)
  const accepted = await api(B.base, `/api/machines/invitations/${invited.data.id}/accept`, {})
  assert.equal(accepted.status, 200, JSON.stringify(accepted))
  await waitFor(async () => {
    const remote = await api(A.base, '/api/m/B/mcp/available')
    const machine = (await api(A.base, '/api/machines')).data.machines.find(
      (item) => item.id === 'B'
    )
    return remote.status === 200 && machine?.paired && machine?.secure
  })
  console.log('PAIR invite/verify/accept: paired=true secure=true remoteAvailable=[]')

  const pidFile = join(root, 'stdio-pid')
  let result = await runCli(B.base, [
    'mcp',
    'add',
    'echo',
    '--desc',
    'TLS echo',
    '--env',
    `MCP_FIXTURE_PID_FILE=${pidFile}`,
    '--',
    process.execPath,
    stdioFixture
  ])
  assert.equal(result.code, 0, result.stderr)
  result = await runCli(A.base, ['mcp', 'ls', '--on', 'B'])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /echo  stdio  TLS echo/)
  result = await runCli(A.base, ['mcp', 'config', 'echo', '--on', 'B'])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /claude mcp add 'echo' -- hiwd mcp 'echo' --on 'B'/)
  assert.match(result.stdout, /codex mcp add/)
  assert.match(result.stdout, /kimi mcp add/)

  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: marker } }
    }
  ]
  result = await conversation(A.base, ['mcp', 'echo', '--on', 'B'], requests)
  assert.equal(result.code, 0, result.stderr)
  const stdioReplies = result.stdout.trim().split('\n').map(JSON.parse)
  assert.deepEqual(
    stdioReplies.map((reply) => reply.id),
    [1, 2, 3]
  )
  assert.equal(stdioReplies[0].result.serverInfo.name, 'hiveward-test-echo')
  assert.equal(stdioReplies[1].result.tools[0].name, 'echo')
  assert.equal(stdioReplies[2].result.content[0].text, marker)
  const pid = Number(await readFile(pidFile, 'utf8'))
  await waitFor(() => processGone(pid))
  console.log(`STDIO initialize/tools-list/tools-call OK; B child pid=${pid} alive=false`)
  result = await conversation(
    B.base,
    ['mcp', 'echo'],
    requests.map((request, index) => ({ ...request, id: index + 31 }))
  )
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(
    result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).id),
    [31, 32, 33]
  )
  console.log('LOCAL hiwd mcp echo (without --on) OK')

  httpStub = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
    }
    const body = raw ? JSON.parse(raw) : null
    httpStub.requests.push({ method: req.method, session: req.headers['mcp-session-id'], body })
    if (req.method === 'DELETE') {
      res.writeHead(200)
      res.end()
      return
    }
    const response =
      body.method === 'tools/call'
        ? {
            jsonrpc: '2.0',
            id: body.id,
            result: { content: [{ type: 'text', text: body.params.arguments.text }] }
          }
        : body.method === 'tools/list'
          ? { jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'http-echo' }] } }
          : { jsonrpc: '2.0', id: body.id, result: { serverInfo: { name: 'http-fixture' } } }
    res.setHeader('mcp-session-id', 'acceptance-session')
    if (body.method === 'tools/list') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const event = `event: message\r\ndata: ${JSON.stringify(response)}\r\n\r\n`
      res.write(event.slice(0, 17))
      await sleep(5)
      res.write(event.slice(17))
      res.end()
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(response))
    }
  })
  httpStub.requests = []
  httpStub.listen(0, '127.0.0.1')
  await once(httpStub, 'listening')
  const httpUrl = `http://127.0.0.1:${httpStub.address().port}/mcp?fixture=1`
  result = await runCli(B.base, ['mcp', 'add', 'web', '--url', httpUrl])
  assert.equal(result.code, 0, result.stderr)
  result = await conversation(
    A.base,
    ['mcp', 'web', '--on', 'B'],
    requests.map((request, index) => ({ ...request, id: index + 11 }))
  )
  assert.equal(result.code, 0, result.stderr)
  const httpReplies = result.stdout.trim().split('\n').map(JSON.parse)
  assert.deepEqual(
    httpReplies.map((reply) => reply.id),
    [11, 12, 13]
  )
  assert.equal(httpReplies[2].result.content[0].text, marker)
  await waitFor(() => httpStub.requests.some((request) => request.method === 'DELETE'))
  assert.deepEqual(
    httpStub.requests.map((request) => request.method),
    ['POST', 'POST', 'POST', 'DELETE']
  )
  assert.ok(httpStub.requests.slice(1).every((request) => request.session === 'acceptance-session'))
  console.log(
    `HTTP JSON+SSE OK; methods=${httpStub.requests.map((request) => request.method).join(',')}; session=${httpStub.requests.at(-1).session}`
  )

  assert.equal((await connectError(wsUrl(A, '/api/m/B/mcp/missing/connect'))).code, 'not_shared')
  result = await runCli(B.base, ['mcp', 'add', 'off', '--', process.execPath, stdioFixture])
  assert.equal(result.code, 0, result.stderr)
  result = await runCli(B.base, ['mcp', 'off', 'off'])
  assert.equal(result.code, 0, result.stderr)
  result = await runCli(B.base, ['mcp', 'on', 'off'])
  assert.equal(result.code, 0, result.stderr)
  result = await runCli(B.base, ['mcp', 'off', 'off'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal((await connectError(wsUrl(A, '/api/m/B/mcp/off/connect'))).code, 'disabled')
  const forbiddenSave = await api(B.base, '/api/mcp/shares', {
    name: 'private',
    enabled: true,
    transport: 'stdio',
    command: process.execPath,
    args: [stdioFixture],
    allowMachines: ['not-A']
  })
  assert.equal(forbiddenSave.status, 200)
  assert.equal((await connectError(wsUrl(A, '/api/m/B/mcp/private/connect'))).code, 'forbidden')
  const stranger = new WebSocket(`wss://127.0.0.1:${B.tls}/api/mcp/echo/connect`, {
    rejectUnauthorized: false
  })
  stranger.on('error', () => {})
  const [, strangerResponse] = await once(stranger, 'unexpected-response')
  assert.equal(strangerResponse.statusCode, 403)
  stranger.terminate()
  const forwardedWrite = await api(A.base, '/api/m/B/mcp/shares', {
    name: 'blocked',
    enabled: true,
    transport: 'stdio',
    command: 'blocked'
  })
  assert.equal(forwardedWrite.status, 403)
  assert.equal(forwardedWrite.data.error.code, 'mcp_local_only')
  const available = await api(A.base, '/api/m/B/mcp/available')
  assert.equal(available.status, 200)
  assert.deepEqual(
    available.data.map((item) => item.name),
    ['echo', 'web']
  )
  assert.equal(JSON.stringify(available.data).includes(process.execPath), false)
  assert.equal(JSON.stringify(available.data).includes(pidFile), false)
  assert.equal(JSON.stringify(available.data).includes('fixture=1'), false)
  console.log('PERMISSIONS not_shared disabled forbidden nonmember=403 forwardedWrite=403')
  console.log(`AVAILABLE ${JSON.stringify(available.data)}`)
  result = await runCli(B.base, ['mcp', 'rm', 'off'])
  assert.equal(result.code, 0, result.stderr)

  const clients = await Promise.all(
    Array.from({ length: 4 }, () => openWs(wsUrl(A, '/api/m/B/mcp/echo/connect')))
  )
  const initialized = await Promise.all(
    clients.map((ws, index) =>
      wsRequest(ws, { jsonrpc: '2.0', id: index + 1, method: 'initialize', params: {} })
    )
  )
  assert.deepEqual(
    initialized.map((reply) => reply.id),
    [1, 2, 3, 4]
  )
  assert.equal(
    (await connectError(wsUrl(A, '/api/m/B/mcp/echo/connect'))).code,
    'too_many_sessions'
  )
  const isolated = await Promise.all(
    clients.map((ws, index) =>
      wsRequest(ws, {
        jsonrpc: '2.0',
        id: index + 21,
        method: 'tools/call',
        params: { name: 'echo', arguments: { text: `isolated-${index}` } }
      })
    )
  )
  assert.deepEqual(
    isolated.map((reply) => reply.result.content[0].text),
    ['isolated-0', 'isolated-1', 'isolated-2', 'isolated-3']
  )
  await Promise.all(
    clients.map((ws) => {
      const closed = once(ws, 'close')
      ws.close()
      return closed
    })
  )
  await waitFor(async () => {
    const shares = await api(B.base, '/api/mcp/shares')
    return shares.data.find((share) => share.name === 'echo')?.sessions === 0
  })
  console.log('CONCURRENCY sessions=4 fifth=too_many_sessions isolated=true sessionsAfterClose=0')

  const foundA = await scan(A.directory, marker)
  const foundB = await scan(B.directory, marker)
  const timelineEvents = JSON.parse(await readFile(join(B.directory, 'timeline.json'), 'utf8'))
  const timelineText = JSON.stringify(timelineEvents)
  assert.deepEqual(foundA, [])
  assert.deepEqual(foundB, [])
  assert.equal(logs.A.includes(marker) || logs.B.includes(marker), false)
  assert.equal(timelineText.includes(marker), false)
  const mcpEvents = timelineEvents
    .map((event) => event.title)
    .filter((title) => title.includes('MCP'))
  assert.ok(mcpEvents.some((title) => title.includes('连上了 MCP：echo')))
  assert.ok(mcpEvents.some((title) => title.includes('断开 MCP：echo')))
  assert.ok(mcpEvents.includes('新增 MCP：off'))
  assert.ok(mcpEvents.includes('开启 MCP：off'))
  assert.ok(mcpEvents.includes('关闭 MCP：off'))
  assert.ok(mcpEvents.includes('删除 MCP 共享：off'))
  console.log(
    `PRIVACY dataA=${JSON.stringify(foundA)} dataB=${JSON.stringify(foundB)} logs=false timeline=false`
  )
  console.log(`TIMELINE ${JSON.stringify(mcpEvents)}`)

  const longRunning = cli(A.base, ['mcp', 'echo', '--on', 'B'], {
    input: `${JSON.stringify(requests[0])}\n`,
    keepOpen: true
  })
  await waitFor(() => longRunning.stdout().includes('"id":1'))
  const shutdownPid = Number(await readFile(pidFile, 'utf8'))
  await stopBridge(B)
  const disconnected = await longRunning.done
  assert.equal(disconnected.code, 1)
  assert.match(disconnected.stderr, /MCP 连接已关闭/)
  await waitFor(() => processGone(shutdownPid))
  console.log(
    `SHUTDOWN remoteDisconnectExit=${disconnected.code}; B child pid=${shutdownPid} alive=false`
  )
  await stopBridge(A)
  console.log('PASS all MCP acceptance checks')
} finally {
  for (const ws of sockets) {
    ws.terminate()
  }
  if (httpStub) {
    await new Promise((resolve) => httpStub.close(resolve))
    httpStub.closeAllConnections()
  }
  await Promise.all(
    [...children].map(async (child) => {
      if (child.exitCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGTERM')
        await exited
      }
    })
  )
  await rm(root, { recursive: true, force: true })
}
