import { spawnProcess } from '@orca/process-host'
import { forceTerminateProcessTree } from '@orca/process-host/process-tree-termination'
import { StringDecoder } from 'node:string_decoder'

const MAX_LINE_BYTES = 4 * 1024 * 1024

export function validMcpMessage(text) {
  if (typeof text !== 'string' || !text || /[\r\n]/.test(text)) {
    return false
  }
  try {
    const value = JSON.parse(text)
    return value?.jsonrpc === '2.0' && typeof value === 'object' && !Array.isArray(value)
  } catch {
    return false
  }
}

export function createLineDecoder(onLine, onOverflow) {
  const decoder = new StringDecoder('utf8')
  let buffered = ''
  let overflowed = false
  const take = (line) => {
    if (line.endsWith('\r')) {
      line = line.slice(0, -1)
    }
    if (line) {
      onLine(line)
    }
  }
  const append = (text, flush = false) => {
    if (overflowed) {
      return
    }
    buffered += text
    let newline
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
        overflowed = true
        buffered = ''
        onOverflow()
        return
      }
      take(line)
    }
    if (Buffer.byteLength(buffered) > MAX_LINE_BYTES) {
      overflowed = true
      buffered = ''
      onOverflow()
      return
    }
    if (flush && buffered) {
      take(buffered)
      buffered = ''
    }
  }
  return {
    write: (chunk) => append(decoder.write(chunk)),
    end: () => append(decoder.end(), true)
  }
}

export function createSseDecoder(onData, onError) {
  const decoder = new StringDecoder('utf8')
  let buffered = ''
  let data = []
  const dispatch = () => {
    if (data.length) {
      const text = data.join('\n')
      data = []
      if (!validMcpMessage(text)) {
        onError(new Error('MCP SSE 消息无效'))
        return
      }
      onData(text)
    }
  }
  const line = (value) => {
    if (value.endsWith('\r')) {
      value = value.slice(0, -1)
    }
    if (!value) {
      dispatch()
    } else if (!value.startsWith(':')) {
      const colon = value.indexOf(':')
      const field = colon === -1 ? value : value.slice(0, colon)
      let content = colon === -1 ? '' : value.slice(colon + 1)
      if (content.startsWith(' ')) {
        content = content.slice(1)
      }
      if (field === 'data') {
        data.push(content)
      }
    }
  }
  const append = (text, flush = false) => {
    buffered += text
    let newline
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const value = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      line(value)
    }
    if (flush) {
      if (buffered) {
        line(buffered)
        buffered = ''
      }
      dispatch()
    }
  }
  return {
    write: (chunk) => append(decoder.write(chunk)),
    end: () => append(decoder.end(), true)
  }
}

const stderrTail = (current, chunk) => {
  const next = Buffer.concat([current, chunk])
  return next.subarray(Math.max(0, next.length - 2048))
}

export function openStdioMcpSession(
  share,
  { send, fail, exit },
  { spawn = spawnProcess, terminate = forceTerminateProcessTree } = {}
) {
  let child
  try {
    child = spawn({
      program: share.command,
      args: share.args ?? [],
      cwd: share.cwd,
      env: { ...process.env, ...share.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true
    })
  } catch (error) {
    throw Object.assign(new Error(`无法启动 MCP：${error.message}`), { code: 'start_failed' })
  }
  let closed = false
  let stderr = Buffer.alloc(0)
  let received = false
  const stop = (code, message) => {
    if (!closed) {
      fail(code, message)
    }
  }
  const lines = createLineDecoder(
    (line) => {
      if (!validMcpMessage(line)) {
        stop('start_failed', 'MCP 子进程输出了无效的 JSON-RPC 消息')
        return
      }
      received = true
      send(line)
    },
    () => stop('start_failed', 'MCP 子进程消息超过 4 MiB')
  )
  child.stdout.on('data', (chunk) => lines.write(chunk))
  child.stderr.on('data', (chunk) => {
    stderr = stderrTail(stderr, chunk)
  })
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream.on('error', () => {})
  }
  child.once('error', (error) => {
    const tail = stderr.toString('utf8').trim()
    stop('start_failed', `无法启动 MCP：${error.message}${tail ? `\n${tail}` : ''}`)
  })
  child.once('exit', (code, signal) => {
    lines.end()
    if (!received && !closed) {
      const tail = stderr.toString('utf8').trim()
      stop(
        'start_failed',
        `MCP 进程在启动期间退出（${signal ?? code ?? 'unknown'}）${tail ? `\n${tail}` : ''}`
      )
    }
    exit()
  })
  return {
    input(text) {
      if (closed || !validMcpMessage(text)) {
        throw new Error('MCP 输入必须是一行 JSON-RPC 消息')
      }
      child.stdin.write(`${text}\n`)
      return child.stdin.writableLength <= 4 * 1024 * 1024
    },
    async close() {
      if (closed) {
        return
      }
      closed = true
      child.stdin.end()
      await terminate(child).catch(() => false)
    }
  }
}

export function openHttpMcpSession(
  share,
  { send, fail },
  { request = fetch, deleteTimeout = 5000 } = {}
) {
  const controller = new AbortController()
  const pending = new Set()
  let sessionId
  let closed = false
  let closePromise
  const failed = (error) => {
    if (!closed && !controller.signal.aborted) {
      fail('start_failed', error.message)
    }
  }
  const consume = async (response) => {
    const id = response.headers.get('mcp-session-id')
    if (id) {
      sessionId = id
    }
    if (!response.ok) {
      throw new Error(`MCP HTTP 返回 ${response.status}`)
    }
    const type = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (type.includes('text/event-stream')) {
      const events = createSseDecoder(send, (error) => {
        throw error
      })
      for await (const chunk of response.body) {
        events.write(chunk)
      }
      events.end()
      return
    }
    const text = await response.text()
    if (!text) {
      return
    }
    let value
    try {
      value = JSON.parse(text)
    } catch {
      throw new Error('MCP HTTP 回复不是 JSON 或 SSE')
    }
    const messages = Array.isArray(value) ? value : [value]
    for (const message of messages) {
      const encoded = JSON.stringify(message)
      if (!validMcpMessage(encoded)) {
        throw new Error('MCP HTTP 回复包含无效的 JSON-RPC 消息')
      }
      send(Array.isArray(value) ? encoded : text)
    }
  }
  const post = (text) => {
    const work = request(share.url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {})
      },
      body: text,
      signal: controller.signal,
      redirect: 'error'
    })
      .then(consume)
      .catch(() => {
        if (!controller.signal.aborted) {
          failed(new Error('MCP HTTP 请求失败'))
        }
      })
      .finally(() => pending.delete(work))
    pending.add(work)
  }
  return {
    input(text) {
      if (closed || !validMcpMessage(text)) {
        throw new Error('MCP 输入必须是一行 JSON-RPC 消息')
      }
      post(text)
      return pending.size <= 64
    },
    close() {
      if (closePromise) {
        return closePromise
      }
      closed = true
      controller.abort()
      closePromise = (async () => {
        await Promise.allSettled(pending)
        if (sessionId) {
          try {
            await request(share.url, {
              method: 'DELETE',
              headers: { 'mcp-session-id': sessionId },
              signal: AbortSignal.timeout(deleteTimeout),
              redirect: 'error'
            })
          } catch {}
        }
      })()
      return closePromise
    }
  }
}
