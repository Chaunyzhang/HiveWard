import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildWindowsCmdShimCommandLine,
  parseWindowsCommandLine
} from '@orca/process-host/windows-command-line'
import {
  createLineDecoder,
  createSseDecoder,
  openHttpMcpSession,
  openStdioMcpSession
} from './mcp-sessions.mjs'

const message = (id, method = 'tools/call', extra = {}) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: { name: 'echo', arguments: { text: '你好' } },
    ...extra
  })
const waitFor = async (predicate, timeout = 5000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('condition timed out')
}

test('NDJSON and SSE decoders preserve UTF-8 across chunks and CRLF', () => {
  const lines = []
  const ndjson = createLineDecoder(
    (line) => lines.push(line),
    () => assert.fail('overflow')
  )
  const bytes = Buffer.from(`${message(1)}\r\n${message(2)}\n`)
  for (const byte of bytes) {
    ndjson.write(Buffer.from([byte]))
  }
  ndjson.end()
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).id),
    [1, 2]
  )
  const events = []
  const sse = createSseDecoder(
    (data) => events.push(data),
    (error) => assert.fail(error)
  )
  const sseBytes = Buffer.from(
    `: comment\r\nevent: message\r\ndata: ${message(3)}\r\n\r\ndata: ${message(4)}\n\n`
  )
  for (const byte of sseBytes) {
    sse.write(Buffer.from([byte]))
  }
  sse.end()
  assert.deepEqual(
    events.map((line) => JSON.parse(line).id),
    [3, 4]
  )
})

test('Windows batch command lines preserve spaced paths and quoted arguments', () => {
  const program = 'C:\\Program Files\\Hive Ward\\echo.cmd'
  const args = ['--label', 'a "quoted" value', 'C:\\ending\\']
  const commandLine = buildWindowsCmdShimCommandLine(program, args)
  assert.match(commandLine, /^\/d \/v:off \/s \/c "/)
  const inner = commandLine.slice('/d /v:off /s /c "'.length, -1)
  assert.deepEqual(parseWindowsCommandLine(inner), [program, ...args])
  assert.throws(() => buildWindowsCmdShimCommandLine(program, ['bad\nargument']))
})

test('stdio MCP session round-trips JSON-RPC and kills its child on close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opc-mcp-stdio-'))
  try {
    const stub = join(directory, 'stdio-stub.mjs')
    const pidFile = join(directory, 'pid')
    await writeFile(
      stub,
      `import { writeFileSync } from 'node:fs'\nimport { spawn } from 'node:child_process'\nimport readline from 'node:readline'\nconst child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})\nwriteFileSync(${JSON.stringify(pidFile)}, process.pid+'\\n'+child.pid)\nconst rl=readline.createInterface({input:process.stdin})\nrl.on('line',(line)=>{const q=JSON.parse(line);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{method:q.method,text:q.params?.arguments?.text}})+'\\n')})\n`
    )
    const received = []
    const failures = []
    let exited = false
    const session = openStdioMcpSession(
      { command: process.execPath, args: [stub], env: {} },
      {
        send: (text) => received.push(text),
        fail: (code, message) => failures.push({ code, message }),
        exit: () => {
          exited = true
        }
      }
    )
    session.input(message(1, 'initialize'))
    await waitFor(() => received.length === 1)
    assert.deepEqual(JSON.parse(received[0]).result, { method: 'initialize', text: '你好' })
    const [pid, childPid] = (await readFile(pidFile, 'utf8')).split('\n').map(Number)
    await session.close()
    await waitFor(() => exited)
    assert.equal(failures.length, 0)
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('HTTP MCP session supports JSON, fragmented SSE, session headers and DELETE', async () => {
  const requests = []
  const http = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
    }
    const body = raw ? JSON.parse(raw) : null
    requests.push({ method: req.method, session: req.headers['mcp-session-id'], body })
    if (req.method === 'DELETE') {
      res.writeHead(200)
      res.end()
      return
    }
    const response = { jsonrpc: '2.0', id: body.id, result: { method: body.method } }
    res.setHeader('mcp-session-id', 'session-test')
    if (body.method === 'tools/list') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const event = `event: message\r\ndata: ${JSON.stringify(response)}\r\n\r\n`
      for (const part of [event.slice(0, 9), event.slice(9, 31), event.slice(31)]) {
        res.write(part)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      res.end()
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(response))
    }
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const received = []
  const failures = []
  const session = openHttpMcpSession(
    { url: `http://127.0.0.1:${http.address().port}/mcp?private=query` },
    {
      send: (text) => received.push(text),
      fail: (code, message) => failures.push({ code, message }),
      exit: () => {}
    }
  )
  try {
    session.input(message(1, 'initialize'))
    await waitFor(() => received.length === 1)
    session.input(message(2, 'tools/list'))
    await waitFor(() => received.length === 2)
    session.input(message(3, 'tools/call'))
    await waitFor(() => received.length === 3)
    assert.deepEqual(
      received.map((text) => JSON.parse(text).id),
      [1, 2, 3]
    )
    await session.close()
    await waitFor(() => requests.some((request) => request.method === 'DELETE'))
    assert.deepEqual(
      requests.map((request) => request.method),
      ['POST', 'POST', 'POST', 'DELETE']
    )
    assert.equal(requests[0].session, undefined)
    assert.ok(requests.slice(1).every((request) => request.session === 'session-test'))
    assert.deepEqual(failures, [])
  } finally {
    await session.close()
    await new Promise((resolve) => http.close(resolve))
  }
})
