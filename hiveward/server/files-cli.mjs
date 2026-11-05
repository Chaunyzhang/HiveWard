import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { compose, Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const DEFAULT_CAT_MAX = 1024 * 1024
const PROGRESS_MIN = 16 * 1024 ** 2
const terminalText = (value) =>
  String(value).replace(
    // oxlint-disable-next-line no-control-regex -- 转义远端文本里的终端控制字符
    /[\0-\x1f\x7f-\x9f]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  )

export const remoteFileName = (path) => path.split(/[/\\]/).at(-1)
export const remoteChild = (directory, name, platform) =>
  `${directory}${directory.endsWith('/') || directory.endsWith('\\') ? '' : platform === 'win32' ? '\\' : '/'}${name}`

async function responseError(res) {
  const data = await res.json().catch(() => null)
  throw new Error(data?.error?.message ?? `HTTP ${res.status}`)
}

async function limitedBytes(res, limit) {
  if (!res.body) {
    return Buffer.alloc(0)
  }
  const reader = res.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      return Buffer.concat(chunks, size)
    }
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new Error(`文本超过 --max 上限（${limit - 1} 字节），请调大 --max 或改用 get`)
    }
    chunks.push(Buffer.from(value))
  }
}

function progress(total, label) {
  let bytes = 0
  let last = 0
  const enabled = total >= PROGRESS_MIN
  return Object.assign(
    new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length
        const now = Date.now()
        if (enabled && (now - last >= 250 || bytes === total)) {
          last = now
          const percent = Math.min(100, Math.floor((bytes / total) * 100))
          process.stderr.write(`\r${label} ${percent}%（${bytes}/${total} 字节）`)
        }
        callback(null, chunk)
      },
      flush(callback) {
        if (enabled) {
          process.stderr.write('\n')
        }
        callback()
      }
    }),
    { bytes: () => bytes }
  )
}

function catMax(values) {
  const index = values.indexOf('--max')
  if (index === -1) {
    return DEFAULT_CAT_MAX
  }
  const value = values.splice(index, 2)[1]
  if (!/^\d+$/.test(value ?? '') || Number(value) < 1 || !Number.isSafeInteger(Number(value))) {
    throw new Error('--max 需要正整数字节数')
  }
  return Number(value)
}

function localText(bytes) {
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('不是有效的 UTF-8 文本；二进制文件请用 hiwd files get 下载')
  }
  // oxlint-disable-next-line no-control-regex -- 二进制和终端控制字符都不能写到终端
  if (/\0|[\x01-\x08\x0b\x0e-\x1f\x7f-\x9f]/.test(text)) {
    throw new Error('检测到二进制内容，未写入终端；请用 hiwd files get 下载')
  }
  return text
}

export async function runFiles(args, { endpoint, localEndpoint = endpoint, machine } = {}) {
  const [action, ...values] = args
  const request = async (path, { local = false, ...options } = {}) => {
    try {
      return await fetch((local ? localEndpoint : endpoint)(path), {
        ...options,
        headers: { 'x-hiveward-caller': 'agent', ...options.headers },
        duplex: 'half'
      })
    } catch (error) {
      throw new Error(`连不上 HiveWard（${error.message}）`)
    }
  }
  const json = async (path, options) => {
    const res = await request(path, options)
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      throw new Error(data?.error?.message ?? `HTTP ${res.status}`)
    }
    return data
  }

  switch (action) {
    case 'roots': {
      const data = await json('/api/files/roots')
      console.log(
        `收件箱：${terminalText(data.inbox)}\n平台：${terminalText(data.platform)} · 单文件上限 ${data.maxBytes} 字节`
      )
      console.log(
        data.roots
          .map(
            (root) =>
              `${terminalText(root.id)}  [${terminalText(root.kind)}${root.writable ? '，可写' : '，只读'}]  ${terminalText(root.label)}  ${terminalText(root.path)}`
          )
          .join('\n')
      )
      break
    }
    case 'ls': {
      if (values.length !== 1) {
        throw new Error('用法：hiwd files ls <路径> [--on <机器>]')
      }
      const data = await json(`/api/files/list?path=${encodeURIComponent(values[0])}`)
      console.log(
        `# ${terminalText(data.path)}${data.parent ? `\n上级：${terminalText(data.parent)}` : ''}`
      )
      console.log(
        data.entries
          .map(
            (entry) =>
              `${entry.type === 'dir' ? '目录' : '文件'}  ${entry.size ?? '-'}  ${terminalText(entry.name)}  ${terminalText(entry.path)}`
          )
          .join('\n')
      )
      if (data.truncated) {
        console.log('（结果过多，已截断）')
      }
      break
    }
    case 'cat': {
      const max = catMax(values)
      if (values.length !== 1) {
        throw new Error('用法：hiwd files cat <路径> [--max <字节>] [--on <机器>]')
      }
      const res = await request(`/api/files/read?path=${encodeURIComponent(values[0])}`, {
        headers: { range: `bytes=0-${max}` }
      })
      if (!res.ok) {
        await responseError(res)
      }
      const declared = Number(
        res.headers.get('content-range')?.match(/\/(\d+)$/)?.[1] ??
          res.headers.get('content-length')
      )
      if (declared > max) {
        await res.body?.cancel()
        throw new Error(`文本超过 --max 上限（${max} 字节），请调大 --max 或改用 get`)
      }
      const bytes = await limitedBytes(res, max + 1)
      if (bytes.length > max) {
        throw new Error(`文本超过 --max 上限（${max} 字节），请调大 --max 或改用 get`)
      }
      process.stdout.write(localText(bytes))
      break
    }
    case 'get': {
      if (values.length < 1 || values.length > 2) {
        throw new Error('用法：hiwd files get <远程路径> [本地路径] [--on <机器>]')
      }
      const [remote, local] = values
      const name = remoteFileName(remote)
      if (!name) {
        throw new Error('远程路径缺少文件名')
      }
      const res = await request(`/api/files/read?path=${encodeURIComponent(remote)}`)
      if (!res.ok) {
        await responseError(res)
      }
      let output = resolve(local ?? name)
      const existing = await stat(output).catch((error) => {
        if (error.code === 'ENOENT') {
          return null
        }
        throw error
      })
      if (existing?.isDirectory()) {
        output = join(output, name)
      }
      await mkdir(dirname(output), { recursive: true })
      const temp = join(dirname(output), `.hiveward-download-${randomUUID()}.tmp`)
      const meter = progress(Number(res.headers.get('content-length')) || 0, '下载')
      try {
        if (!res.body) {
          throw new Error('文件响应没有内容')
        }
        await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(temp, { mode: 0o600 }))
        await rename(temp, output)
      } finally {
        await unlink(temp).catch(() => {})
      }
      console.log(`${output}  ${meter.bytes()} 字节`)
      if (machine && !machine.self) {
        try {
          await json('/api/files/received', {
            local: true,
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ machine: machine.name, path: remote, localPath: output })
          })
        } catch (error) {
          console.error(`hiwd: 文件已下载，但时间线登记失败（${error.message}）`)
        }
      }
      break
    }
    case 'put': {
      if (values.length < 1 || values.length > 2) {
        throw new Error('用法：hiwd files put <本地文件> [远程目录] [--on <机器>]')
      }
      const [local, remoteDirectory] = values
      const source = resolve(local)
      const info = await stat(source)
      if (!info.isFile()) {
        throw new Error('只能上传普通文件')
      }
      const roots = await json('/api/files/roots')
      if (info.size > roots.maxBytes) {
        throw new Error(`单文件上限 ${roots.maxBytes} 字节`)
      }
      const name = basename(source)
      const remote = remoteDirectory ? remoteChild(remoteDirectory, name, roots.platform) : null
      const meter = progress(info.size, '上传')
      const res = await request(
        `/api/files/write${remote ? `?path=${encodeURIComponent(remote)}` : ''}`,
        {
          method: 'POST',
          headers: {
            'content-length': String(info.size),
            ...(remote ? {} : { 'x-hiveward-filename': encodeURIComponent(name) })
          },
          body: compose(createReadStream(source), meter)
        }
      )
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        throw new Error(data?.error?.message ?? `HTTP ${res.status}`)
      }
      console.log(`${terminalText(data.path)}  ${data.size} 字节`)
      break
    }
    default:
      throw new Error(
        '用法：hiwd files roots | ls <路径> | cat <路径> [--max <字节>] | get <远程路径> [本地路径] | put <本地文件> [远程目录]'
      )
  }
}
