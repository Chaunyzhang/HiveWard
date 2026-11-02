import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, open, realpath, rm, stat } from 'node:fs/promises'
import { createServer, get, request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createFileService } from '../files.mjs'

const SIZE = 1024 ** 3
const base = process.platform === 'win32' ? homedir() : '/tmp'
const root = await realpath(await mkdtemp(join(base, 'opc-files-streaming-')))
const home = join(root, 'home')
const business = join(home, 'Business')
await mkdir(business, { recursive: true })
const service = createFileService({
  directory: join(root, 'data'),
  home,
  businessRows: async () => [
    { id: 'business', name: 'Streaming', workspacePath: business, status: 'active' }
  ],
  attributes: { check: async () => {} },
  recordEvent: () => {}
})
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://files.test')
    if (!(await service.handle(req, res, url))) {
      res.writeHead(404).end()
    }
  } catch (error) {
    if (res.headersSent) {
      return res.destroy()
    }
    res.writeHead(error.status ?? 502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: error.code, message: error.message } }))
  }
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`
const source = join(business, 'source-1gb.bin')
const uploaded = join(home, 'HiveWard 收件箱', 'uploaded-1gb.bin')
async function upload() {
  return new Promise((resolve, reject) => {
    const req = request(
      `${origin}/api/files/write?path=${encodeURIComponent(uploaded)}`,
      {
        method: 'POST',
        headers: { 'content-length': String(SIZE) }
      },
      (res) => {
        let body = ''
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode, body }))
      }
    )
    req.on('error', reject)
    pipeline(createReadStream(source), req).catch(reject)
  })
}

async function download(path, range) {
  const res = await new Promise((resolve, reject) => {
    const req = get(
      `${origin}/api/files/read?path=${encodeURIComponent(path)}`,
      {
        headers: range ? { range } : {}
      },
      resolve
    )
    req.on('error', reject)
  })
  let bytes = 0
  const counter = new Writable({
    write(chunk, _encoding, callback) {
      bytes += chunk.length
      callback()
    }
  })
  await pipeline(res, counter)
  return { status: res.statusCode, headers: res.headers, bytes }
}

let peak = 0
const timer = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().rss)
}, 20)
try {
  const file = await open(source, 'w')
  await file.truncate(SIZE)
  await file.close()
  await download(source, 'bytes=0-1023')
  const baseline = process.memoryUsage().rss
  peak = baseline

  const sent = await upload()
  assert.equal(sent.status, 200, sent.body)
  assert.equal((await stat(uploaded)).size, SIZE)
  const received = await download(uploaded)
  assert.equal(received.status, 200)
  assert.equal(received.bytes, SIZE)
  const range = await download(uploaded, `bytes=${SIZE - 4}-${SIZE - 1}`)
  assert.equal(range.status, 206)
  assert.equal(range.bytes, 4)
  assert.equal(range.headers['content-range'], `bytes ${SIZE - 4}-${SIZE - 1}/${SIZE}`)
  clearInterval(timer)
  const growth = peak - baseline
  assert.ok(growth < 128 * 1024 ** 2, `RSS grew by ${growth} bytes`)
  console.log(
    `ACCEPT 1GB stream ${JSON.stringify({
      uploadStatus: sent.status,
      uploadedBytes: (await stat(uploaded)).size,
      downloadedBytes: received.bytes,
      rssBaselineMiB: (baseline / 1024 ** 2).toFixed(1),
      rssPeakMiB: (peak / 1024 ** 2).toFixed(1),
      rssGrowthMiB: (growth / 1024 ** 2).toFixed(1)
    })}`
  )
  console.log(`ACCEPT Range ${range.headers['content-range']} bytes=${range.bytes}`)
} finally {
  clearInterval(timer)
  service.close()
  await new Promise((resolve) => {
    server.close(resolve)
    server.closeAllConnections()
  })
  await rm(root, { recursive: true, force: true })
}
