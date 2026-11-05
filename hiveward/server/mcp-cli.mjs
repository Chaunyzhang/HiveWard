import { hivewardEnvironment } from '../shared/environment.mjs'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { WebSocket } from 'ws'

const connectErrorCodes = new Set([
  'not_shared',
  'disabled',
  'forbidden',
  'start_failed',
  'too_many_sessions'
])
const usage =
  '用法：hiwd mcp ls | add <名字> [--desc 说明] [--cwd 目录] [--env K=V …] -- <命令> [参数…] | add <名字> [--desc 说明] --url <本机地址> | rm/on/off <名字> | config <名字> | <名字>'

async function api(base, path, options = {}) {
  let res
  try {
    res = await fetch(base(path), {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...options.headers
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    })
  } catch (error) {
    throw new Error(`连不上 HiveWard（${error.message}）`)
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(data?.error?.message ?? `HTTP ${res.status}`)
  }
  return data
}

function parseAdd(values) {
  const separator = values.indexOf('--')
  const options = separator === -1 ? values : values.slice(0, separator)
  const commandParts = separator === -1 ? [] : values.slice(separator + 1)
  let description
  let cwd
  let url
  let env
  for (let i = 0; i < options.length; i++) {
    const option = options[i]
    const value = () => {
      if (i + 1 >= options.length) {
        throw new Error(`${option} 缺少值`)
      }
      return options[++i]
    }
    if (option === '--desc') {
      if (description !== undefined) {
        throw new Error('--desc 不能重复')
      }
      description = value()
    } else if (option === '--cwd') {
      if (cwd !== undefined) {
        throw new Error('--cwd 不能重复')
      }
      cwd = value()
    } else if (option === '--url') {
      if (url !== undefined) {
        throw new Error('--url 不能重复')
      }
      url = value()
    } else if (option === '--env') {
      const pair = value()
      const equals = pair.indexOf('=')
      if (equals < 1) {
        throw new Error('--env 需要 K=V（值可以为空或含 =）')
      }
      env ??= {}
      env[pair.slice(0, equals)] = pair.slice(equals + 1)
    } else {
      throw new Error(`未知 MCP add 参数：${option}`)
    }
  }

  if (separator !== -1) {
    if (url !== undefined) {
      throw new Error('--url 不能和 stdio 命令一起使用')
    }
    if (!commandParts.length) {
      throw new Error('-- 后需要 MCP 命令')
    }
    return {
      enabled: true,
      transport: 'stdio',
      command: commandParts[0],
      args: commandParts.slice(1),
      ...(cwd === undefined ? {} : { cwd }),
      ...(env === undefined ? {} : { env }),
      ...(description === undefined ? {} : { description })
    }
  }
  if (url === undefined) {
    throw new Error('add 需要 --url，或用 -- 分隔 stdio 命令')
  }
  if (cwd !== undefined || env !== undefined) {
    throw new Error('--cwd/--env 只能用于 stdio MCP')
  }
  return {
    enabled: true,
    transport: 'http',
    url,
    ...(description === undefined ? {} : { description })
  }
}

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`
const managementHeaders = () =>
  process.env.HIVEWARD_TERMINAL_HANDLE ||
  process.env.CLAUDE_CODE_SESSION_ID ||
  process.env.CODEX_THREAD_ID ||
  hivewardEnvironment.HIVEWARD_DISPATCHER
    ? { 'x-hiveward-caller': 'agent' }
    : {}

function mcpConnectError(raw) {
  try {
    const frame = JSON.parse(raw.toString())
    if (
      frame?.type === 'error' &&
      connectErrorCodes.has(frame.code) &&
      typeof frame.message === 'string'
    ) {
      return frame
    }
  } catch {
    // 普通 MCP 文本不需要是外层 JSON 协议。
  }
  return null
}

async function connect(name, endpoint) {
  const url = new URL(endpoint(`/api/mcp/${encodeURIComponent(name)}/connect`))
  if (url.protocol === 'http:') {
    url.protocol = 'ws:'
  } else if (url.protocol === 'https:') {
    url.protocol = 'wss:'
  } else {
    throw new Error('MCP endpoint 必须是 http/https URL')
  }
  const ws = new WebSocket(url, { handshakeTimeout: 10000, perMessageDeflate: false })

  await new Promise((resolve, reject) => {
    let input
    let eof = false
    let settled = false
    let output = Promise.resolve()

    function cleanup() {
      if (input) {
        input.close()
        process.stdin.pause()
        input = null
      }
      ws.off('open', onOpen)
      ws.off('message', onMessage)
      ws.off('close', onClose)
      if (ws.readyState === WebSocket.CLOSED) {
        ws.off('error', onError)
      }
    }

    function fail(error) {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.terminate()
      }
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    function finish() {
      output.then(() => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        resolve()
      }, fail)
    }

    function send(line) {
      return new Promise((resolveSend, rejectSend) => {
        if (ws.readyState !== WebSocket.OPEN) {
          rejectSend(new Error('MCP 连接已关闭'))
          return
        }
        ws.send(line, (error) => (error ? rejectSend(error) : resolveSend()))
      })
    }

    function onOpen() {
      void (async () => {
        input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })
        for await (const line of input) {
          if (line) {
            await send(line)
          }
          if (settled) {
            return
          }
        }
        eof = true
        if (ws.readyState === WebSocket.OPEN) {
          ws.close()
        } else if (ws.readyState === WebSocket.CLOSED) {
          finish()
        }
      })().catch(fail)
    }

    function onMessage(raw, binary) {
      if (binary) {
        fail(new Error('MCP 连接收到不支持的二进制帧'))
        return
      }
      const error = mcpConnectError(raw)
      if (error) {
        fail(new Error(`[${error.code}] ${error.message}`))
        return
      }
      output = output.then(async () => {
        if (settled) {
          return
        }
        const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
        if (!process.stdout.write(Buffer.concat([bytes, Buffer.from('\n')]))) {
          await once(process.stdout, 'drain')
        }
      })
      output.catch(fail)
    }

    function onClose() {
      if (eof) {
        finish()
      } else {
        fail(new Error('MCP 连接已关闭'))
      }
    }

    function onError(error) {
      if (eof) {
        finish()
      } else {
        fail(error)
      }
    }

    ws.on('open', onOpen)
    ws.on('message', onMessage)
    ws.on('close', onClose)
    ws.on('error', onError)
  })
}

export async function runMcp(
  args,
  { endpoint, localEndpoint = endpoint, machine = null, on = null } = {}
) {
  const [action, ...values] = args
  const assertLocal = () => {
    if (machine && !machine.self) {
      throw new Error('MCP add/rm/on/off 只能在本机执行，不能使用 --on')
    }
  }
  switch (action) {
    case 'ls': {
      if (values.length) {
        throw new Error('用法：hiwd mcp ls [--on <机器>]')
      }
      const available = await api(endpoint, '/api/mcp/available')
      for (const item of available) {
        console.log(`${item.name}  ${item.transport}  ${item.description ?? ''}`)
      }
      return
    }
    case 'add': {
      assertLocal()
      const [name, ...options] = values
      if (!name) {
        throw new Error('hiwd mcp add 需要名字')
      }
      const config = parseAdd(options)
      await api(localEndpoint, '/api/mcp/shares', {
        method: 'POST',
        headers: managementHeaders(),
        body: { name, ...config }
      })
      console.log(`已共享 MCP：${name}`)
      return
    }
    case 'rm': {
      assertLocal()
      if (values.length !== 1 || !values[0]) {
        throw new Error('用法：hiwd mcp rm <名字>')
      }
      await api(localEndpoint, `/api/mcp/shares/${encodeURIComponent(values[0])}/remove`, {
        method: 'POST',
        headers: managementHeaders(),
        body: {}
      })
      console.log(`已移除 MCP：${values[0]}`)
      return
    }
    case 'on':
    case 'off': {
      assertLocal()
      if (values.length !== 1 || !values[0]) {
        throw new Error(`用法：hiwd mcp ${action} <名字>`)
      }
      const shares = await api(localEndpoint, '/api/mcp/shares')
      const share = shares.find((item) => item.name === values[0])
      if (!share) {
        throw new Error(`没找到 MCP「${values[0]}」`)
      }
      const { envKeys: _envKeys, sessions: _sessions, ...config } = share
      await api(localEndpoint, '/api/mcp/shares', {
        method: 'POST',
        headers: managementHeaders(),
        body: { ...config, enabled: action === 'on' }
      })
      console.log(`已${action === 'on' ? '启用' : '停用'} MCP：${values[0]}`)
      return
    }
    case 'config': {
      if (values.length !== 1 || !values[0]) {
        throw new Error('用法：hiwd mcp config <名字> --on <机器>')
      }
      if (!machine) {
        throw new Error('hiwd mcp config 需要 --on <机器>')
      }
      const name = shellQuote(values[0])
      const target = shellQuote(on ?? machine.name)
      for (const [label, cli] of [
        ['Claude Code', 'claude'],
        ['Codex', 'codex'],
        ['Kimi', 'kimi']
      ]) {
        console.log(`${label}:\n${cli} mcp add ${name} -- hiwd mcp ${name} --on ${target}`)
      }
      return
    }
    default:
      if (args.length === 1 && action) {
        await connect(action, endpoint)
        return
      }
      throw new Error(usage)
  }
}
