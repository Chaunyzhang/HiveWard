import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { runProcess } from '@orca/process-host'
import { createFileService, fileRange } from './files.mjs'
import { filePathPolicy } from './file-path-policy.mjs'
import { remoteChild, remoteFileName } from './files-cli.mjs'

const pathQuery = (route, path) => `${route}?path=${encodeURIComponent(path)}`
const jsonBody = (body) => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
})

async function instance(t, name, options = {}) {
  const base = process.platform === 'win32' ? homedir() : '/tmp'
  const root = await realpath(await mkdtemp(join(base, `opc-files-${name}-`)))
  const home = join(root, 'home')
  const business = join(home, 'Business')
  await Promise.all(
    [business, join(home, 'Downloads'), join(home, 'Desktop'), join(home, 'Documents')].map(
      (path) => mkdir(path, { recursive: true })
    )
  )
  const events = []
  const service = createFileService({
    directory: join(root, 'data'),
    home,
    businessRows: async () => [
      { id: 'business', name: `${name}业务`, workspacePath: business, status: 'active' }
    ],
    attributes: { check: async () => {} },
    recordEvent: (event) => events.push(event),
    ...options
  })
  const peers = new Map()
  const reply = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://files.test')
      if (req.method === 'GET' && url.pathname === '/api/machines') {
        return reply(res, 200, {
          machines: [
            { id: name, name, self: true, paired: true, status: 'online' },
            ...[...peers.values()].map((peer) => ({
              id: peer.id,
              name: peer.name,
              self: false,
              paired: true,
              status: 'online'
            }))
          ]
        })
      }
      service.checkForward(req, url)
      const proxy = /^\/api\/m\/([^/]+)\/(.+)$/.exec(url.pathname)
      if (proxy) {
        const target = peers.get(decodeURIComponent(proxy[1]))
        if (!target) {
          return reply(res, 404, { error: { code: 'not_found', message: 'unknown peer' } })
        }
        const headers = new Headers(req.headers)
        headers.delete('host')
        headers.delete('connection')
        headers.set('x-test-remote', '1')
        headers.set('x-test-secure', '1')
        headers.set('x-test-peer-name', name)
        const upstream = await fetch(`${target.base}/api/${proxy[2]}${url.search}`, {
          method: req.method,
          headers,
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
          duplex: 'half'
        })
        res.writeHead(upstream.status, Object.fromEntries(upstream.headers))
        if (!upstream.body) {
          return res.end()
        }
        return await pipeline(Readable.fromWeb(upstream.body), res)
      }
      const remote = req.headers['x-test-remote'] === '1'
      const peer =
        remote && req.headers['x-test-secure'] === '1'
          ? { id: 'peer', name: req.headers['x-test-peer-name'] || 'Peer' }
          : null
      if (!(await service.handle(req, res, url, { remote, peer }))) {
        reply(res, 404, { error: { code: 'not_found', message: req.url } })
      }
    } catch (error) {
      if (res.headersSent) {
        return res.destroy()
      }
      reply(res, error.status ?? 502, {
        error: { code: error.code ?? 'test_error', message: error.message }
      })
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const result = {
    id: name,
    name,
    root,
    home,
    business,
    inbox: join(home, 'HiveWard 收件箱'),
    events,
    peers,
    base: `http://127.0.0.1:${server.address().port}`
  }
  t.after(async () => {
    service.close()
    await new Promise((resolve) => {
      server.close(resolve)
      server.closeAllConnections()
    })
    await rm(root, { recursive: true, force: true })
  })
  return result
}

async function request(target, path, { body, ...options } = {}) {
  return fetch(target.base + path, { ...options, body, duplex: 'half' })
}

async function updateAgentWrite(target, agentWrite) {
  const roots = await (await request(target, '/api/files/roots')).json()
  const res = await request(target, '/api/files/settings', {
    method: 'POST',
    ...jsonBody({ roots: [], inbox: roots.inbox, agentWrite })
  })
  assert.equal(res.status, 200)
}

async function cli(target, ...args) {
  return runProcess({
    program: process.execPath,
    args: ['opc/server/hiwd.mjs', ...args],
    env: { ...process.env, OPC_BRIDGE: target.base, OPC_DISPATCHER: 'cli:files-test' },
    timeoutMs: 30000
  })
}

test('fileRange handles complete, bounded and suffix ranges', () => {
  assert.deepEqual(fileRange(undefined, 10), { start: 0, end: 9, partial: false })
  assert.deepEqual(fileRange('bytes=2-5', 10), { start: 2, end: 5, partial: true })
  assert.deepEqual(fileRange('bytes=2-99', 10), { start: 2, end: 9, partial: true })
  assert.deepEqual(fileRange('bytes=-3', 10), { start: 7, end: 9, partial: true })
  assert.deepEqual(fileRange('bytes=-99', 10), { start: 0, end: 9, partial: true })
  assert.deepEqual(fileRange(undefined, 0), { start: 0, end: -1, partial: false })
  for (const value of ['bytes=', 'bytes=0-0,2-3', 'bytes=9-2', 'bytes=10-11', 'items=0-1']) {
    assert.throws(
      () => fileRange(value, 10),
      (error) => error.status === 416
    )
  }
  assert.throws(
    () => fileRange('bytes=0-0', 0),
    (error) => error.status === 416
  )
  assert.throws(
    () => fileRange('bytes=-0', 10),
    (error) => error.status === 416
  )
})

test('Windows paths use win32 rules, case-insensitive roots and system-drive restrictions', () => {
  const policy = filePathPolicy({ platform: 'win32', home: 'C:\\Users\\Alice', systemDrive: 'C:' })
  assert.equal(policy.validate('D:\\视频\\a.mp4'), 'D:\\视频\\a.mp4')
  assert.equal(
    policy.validate('C:\\Users\\Alice\\Documents\\a.txt'),
    'C:\\Users\\Alice\\Documents\\a.txt'
  )
  assert.equal(
    policy.validate('C:\\Users\\Alice\\Documents\\Windows\\notes.txt'),
    'C:\\Users\\Alice\\Documents\\Windows\\notes.txt'
  )
  assert.throws(() => policy.validate('C:\\Users\\Alice\\Documents\\bad\\\u001bname.txt'))
  assert.equal(policy.validate('D:\\'), 'D:\\')
  assert.ok(policy.within('d:\\VIDEO\\a.mp4', 'D:\\video'))
  assert.ok(!policy.within('D:\\video-other\\a.mp4', 'D:\\video'))
  for (const path of [
    'C:\\',
    'C:\\Windows\\win.ini',
    'C:\\Users\\Alice\\AppData\\secret',
    'C:\\Users\\Alice\\..\\Bob\\a.txt',
    'C:\\Users\\Alice\\.secret',
    'C:\\Users\\Alice\\file.txt:stream',
    '\\\\server\\share\\a.txt',
    'relative\\a.txt'
  ]) {
    assert.throws(() => policy.validate(path), /./, path)
  }
  const posix = filePathPolicy({ platform: 'linux', home: '/home/alice' })
  assert.throws(() => posix.validate('/home/alice/../bob'))
  assert.throws(() => posix.validate('/etc/passwd'))
  console.log(
    'ACCEPT Windows path.win32: drive, separator, case, UNC, ADS, hidden and system roots'
  )
})

test('remote path helpers do not apply the source computer path format', () => {
  assert.equal(remoteFileName('D:\\资料\\报告.pdf'), '报告.pdf')
  assert.equal(remoteFileName('/home/alice/报告.pdf'), '报告.pdf')
  assert.equal(remoteChild('D:\\资料', '报告.pdf', 'win32'), 'D:\\资料\\报告.pdf')
  assert.equal(remoteChild('/home/bob/inbox/', '报告.pdf', 'linux'), '/home/bob/inbox/报告.pdf')
})

test('local roots, list, mkdir, atomic write, read and Range work', async (t) => {
  const target = await instance(t, 'local')
  const roots = await (await request(target, '/api/files/roots')).json()
  assert.equal(roots.platform, process.platform)
  assert.ok(roots.roots.some((root) => root.kind === 'business' && root.writable))
  assert.ok(roots.roots.some((root) => root.kind === 'inbox' && root.path === target.inbox))
  assert.equal(roots.maxBytes, 2 * 1024 ** 3)

  const nested = join(target.business, 'new', '报告.txt')
  const created = await request(target, pathQuery('/api/files/write', nested), {
    method: 'POST',
    body: '0123456789'
  })
  assert.equal(created.status, 200)
  assert.deepEqual(await created.json(), { path: nested, size: 10 })

  const duplicate = await request(target, pathQuery('/api/files/write', nested), {
    method: 'POST',
    body: 'replacement'
  })
  assert.equal(duplicate.status, 409)
  assert.equal((await duplicate.json()).error.code, 'file_exists')
  const overwritten = await request(
    target,
    `${pathQuery('/api/files/write', nested)}&overwrite=1`,
    {
      method: 'POST',
      body: 'abcdefghij'
    }
  )
  assert.equal(overwritten.status, 200)

  const made = await request(target, '/api/files/mkdir', {
    method: 'POST',
    ...jsonBody({ path: join(target.business, 'new', 'folder') })
  })
  assert.equal(made.status, 200)
  assert.ok((await stat(join(target.business, 'new', 'folder'))).isDirectory())
  const listing = await (
    await request(target, pathQuery('/api/files/list', join(target.business, 'new')))
  ).json()
  assert.deepEqual(
    listing.entries.map((entry) => entry.name),
    ['folder', '报告.txt']
  )
  assert.equal(listing.parent, target.business)

  const range = await request(target, pathQuery('/api/files/read', nested), {
    headers: { range: 'bytes=2-5' }
  })
  assert.equal(range.status, 206)
  assert.equal(range.headers.get('content-range'), 'bytes 2-5/10')
  assert.equal(range.headers.get('content-length'), '4')
  assert.equal(await range.text(), 'cdef')
  const suffix = await request(target, pathQuery('/api/files/read', nested), {
    headers: { range: 'bytes=-2' }
  })
  assert.equal(await suffix.text(), 'ij')
  const invalid = await request(target, pathQuery('/api/files/read', nested), {
    headers: { range: 'bytes=99-100' }
  })
  assert.equal(invalid.status, 416)
  assert.equal(invalid.headers.get('content-range'), 'bytes */10')
})

test('all endpoints reject traversal, absolute escapes, symlinks, hidden and oversized files', async (t) => {
  const target = await instance(t, 'guards', { maxBytes: 8 })
  const outside = join(target.root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'secret.txt'), 'secret')
  await writeFile(join(target.business, 'visible.txt'), 'visible')
  await writeFile(join(target.business, '.hidden.txt'), 'hidden')
  await mkdir(join(target.business, '.hidden-dir'))
  await writeFile(join(target.business, 'large.bin'), '123456789')
  await symlink(
    outside,
    join(target.business, 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )

  const rejected = [
    ['GET', pathQuery('/api/files/list', `${target.business}/../outside`)],
    ['GET', pathQuery('/api/files/read', join(outside, 'secret.txt'))],
    ['GET', pathQuery('/api/files/read', join(target.business, 'escape', 'secret.txt'))],
    ['GET', pathQuery('/api/files/list', join(target.business, 'escape'))],
    ['GET', pathQuery('/api/files/read', join(target.business, '.hidden.txt'))],
    ['GET', pathQuery('/api/files/list', join(target.business, '.hidden-dir'))],
    ['POST', pathQuery('/api/files/write', join(outside, 'new.txt'))],
    ['POST', pathQuery('/api/files/write', join(target.business, 'escape', 'new.txt'))]
  ]
  for (const [method, path] of rejected) {
    const res = await request(target, path, { method, body: method === 'POST' ? 'x' : undefined })
    assert.ok([400, 403].includes(res.status), `${method} ${path}: ${res.status}`)
    assert.ok(['invalid_path', 'file_forbidden'].includes((await res.json()).error.code))
  }
  const mkdirOutside = await request(target, '/api/files/mkdir', {
    method: 'POST',
    ...jsonBody({ path: join(outside, 'new') })
  })
  assert.equal(mkdirOutside.status, 403)

  const oversizedWrite = await request(
    target,
    pathQuery('/api/files/write', join(target.inbox, 'large.txt')),
    {
      method: 'POST',
      body: '123456789'
    }
  )
  assert.equal(oversizedWrite.status, 413)
  assert.equal((await oversizedWrite.json()).error.code, 'file_too_large')
  const oversizedRead = await request(
    target,
    pathQuery('/api/files/read', join(target.business, 'large.bin'))
  )
  assert.equal(oversizedRead.status, 413)
  const listing = await (
    await request(target, pathQuery('/api/files/list', target.business))
  ).json()
  assert.deepEqual(
    listing.entries.map((entry) => entry.name),
    ['visible.txt']
  )
  console.log(
    'ACCEPT guards: .., absolute escape, symlink, hidden, oversized read/write and mkdir rejected'
  )
})

test('remote files require an authenticated secure channel and settings stay local', async (t) => {
  const target = await instance(t, 'secure')
  const plain = await request(target, '/api/files/roots', { headers: { 'x-test-remote': '1' } })
  assert.equal(plain.status, 403)
  assert.equal((await plain.json()).error.code, 'file_secure_channel_required')

  const secure = { 'x-test-remote': '1', 'x-test-secure': '1', 'x-test-peer-name': 'Windows' }
  assert.equal((await request(target, '/api/files/roots', { headers: secure })).status, 200)
  const remoteSettings = await request(target, '/api/files/settings', {
    method: 'POST',
    headers: { ...secure, 'content-type': 'application/json' },
    body: JSON.stringify({ roots: [], inbox: target.inbox, agentWrite: 'inbox' })
  })
  assert.equal(remoteSettings.status, 403)
  assert.equal((await remoteSettings.json()).error.code, 'file_settings_local_only')
  console.log('ACCEPT insecure remote: 403 file_secure_channel_required; forwarded settings: 403')
})

test('agentWrite is an inbox, roots or none guard and writable roots remain authoritative', async (t) => {
  const target = await instance(t, 'agent')
  const secure = { 'x-test-remote': '1', 'x-test-secure': '1', 'x-test-peer-name': 'Mac' }
  const write = (path, headers = secure) =>
    request(target, pathQuery('/api/files/write', path), { method: 'POST', headers, body: 'x' })

  const businessPath = join(target.business, 'agent.txt')
  const denied = await write(businessPath)
  assert.equal(denied.status, 403)
  assert.equal((await denied.json()).error.code, 'agent_write_denied')
  const inboxPath = join(target.inbox, 'agent.txt')
  assert.equal((await write(inboxPath)).status, 200)
  assert.equal(target.events.at(-1).title, '收到文件：Mac')

  const human = await write(join(target.business, 'human.txt'), {
    ...secure,
    'x-opc-caller': 'human'
  })
  assert.equal(human.status, 200)
  const readOnly = await write(join(target.home, 'Downloads', 'human.txt'), {
    ...secure,
    'x-opc-caller': 'human'
  })
  assert.equal(readOnly.status, 403)
  assert.equal((await readOnly.json()).error.code, 'file_read_only')

  await updateAgentWrite(target, 'roots')
  assert.equal((await write(join(target.business, 'roots.txt'))).status, 200)
  await updateAgentWrite(target, 'none')
  const none = await write(join(target.inbox, 'none.txt'))
  assert.equal(none.status, 403)
  assert.equal((await none.json()).error.code, 'agent_write_denied')
  console.log('ACCEPT agentWrite: inbox, roots, none; read-only roots still deny human writes')
})

test('settings reject a regular-file inbox and malformed bodies', async (t) => {
  const target = await instance(t, 'settings')
  const ordinary = join(target.home, 'ordinary.txt')
  await writeFile(ordinary, 'x')
  for (const body of [
    null,
    { roots: [], inbox: ordinary, agentWrite: 'inbox' },
    { roots: [], inbox: target.inbox, agentWrite: 'invalid' }
  ]) {
    const res = await request(target, '/api/files/settings', { method: 'POST', ...jsonBody(body) })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error.code, 'bad_request')
  }
  const inbox = join(target.home, 'new-inbox', 'nested')
  const valid = await request(target, '/api/files/settings', {
    method: 'POST',
    ...jsonBody({ roots: [], inbox, agentWrite: 'inbox' })
  })
  assert.equal(valid.status, 200)
  assert.ok((await stat(inbox)).isDirectory())
})

test(
  'two isolated instances run the real CLI and record both transfer directions',
  { timeout: 90000 },
  async (t) => {
    const mac = await instance(t, 'Mac')
    const windows = await instance(t, 'Windows')
    mac.peers.set(windows.id, windows)
    windows.peers.set(mac.id, mac)
    const remoteText = join(windows.business, '你好.txt')
    await writeFile(remoteText, '跨电脑文本\n第二行')
    await writeFile(join(windows.business, 'binary.dat'), Buffer.from([0, 1, 2, 255]))
    await writeFile(join(windows.business, 'c1.dat'), Buffer.from([0xc2, 0x9b, 0x5b, 0x31, 0x6d]))

    const roots = await cli(mac, 'files', 'roots', '--on', 'Windows')
    assert.equal(roots.code, 0, roots.stderr)
    assert.match(roots.stdout, /收件箱：/)
    assert.match(roots.stdout, /Windows业务/)
    console.log(`ACCEPT hiwd files roots --on Windows\n${roots.stdout}`)

    const listing = await cli(mac, 'files', 'ls', windows.business, '--on', 'Windows')
    assert.equal(listing.code, 0, listing.stderr)
    assert.match(listing.stdout, /你好\.txt/)
    console.log(`ACCEPT hiwd files ls --on Windows\n${listing.stdout}`)

    const cat = await cli(mac, 'files', 'cat', remoteText, '--on', 'Windows')
    assert.equal(cat.code, 0, cat.stderr)
    assert.equal(cat.stdout, '跨电脑文本\n第二行')
    console.log(`ACCEPT hiwd files cat --on Windows\n${cat.stdout}`)
    const limited = await cli(mac, 'files', 'cat', remoteText, '--max', '4', '--on', 'Windows')
    assert.equal(limited.code, 1)
    assert.equal(limited.stdout, '')
    assert.match(limited.stderr, /--max/)
    const binary = await cli(
      mac,
      'files',
      'cat',
      join(windows.business, 'binary.dat'),
      '--on',
      'Windows'
    )
    assert.equal(binary.code, 1)
    assert.equal(binary.stdout, '')
    assert.match(binary.stderr, /二进制|UTF-8/)
    const c1 = await cli(mac, 'files', 'cat', join(windows.business, 'c1.dat'), '--on', 'Windows')
    assert.equal(c1.code, 1)
    assert.equal(c1.stdout, '')
    assert.match(c1.stderr, /二进制/)

    const downloaded = join(mac.root, 'downloads', '取回.txt')
    const get = await cli(mac, 'files', 'get', remoteText, downloaded, '--on', 'Windows')
    assert.equal(get.code, 0, get.stderr)
    assert.equal(await readFile(downloaded, 'utf8'), '跨电脑文本\n第二行')
    assert.ok(
      mac.events.some(
        (event) => event.title === 'Agent 取回文件：Windows' && event.path === downloaded
      )
    )
    console.log(`ACCEPT hiwd files get --on Windows\n${get.stdout}`)

    const upload = join(mac.root, '推送.txt')
    await writeFile(upload, '来自 Mac')
    const put = await cli(mac, 'files', 'put', upload, '--on', 'Windows')
    assert.equal(put.code, 0, put.stderr)
    assert.equal(await readFile(join(windows.inbox, '推送.txt'), 'utf8'), '来自 Mac')
    assert.ok(windows.events.some((event) => event.title === '收到文件：Mac'))
    console.log(`ACCEPT hiwd files put --on Windows\n${put.stdout}`)

    await updateAgentWrite(windows, 'roots')
    const putDirectory = await cli(mac, 'files', 'put', upload, windows.business, '--on', 'Windows')
    assert.equal(putDirectory.code, 0, putDirectory.stderr)
    assert.equal(await readFile(join(windows.business, '推送.txt'), 'utf8'), '来自 Mac')

    const forwardedSettings = await request(mac, '/api/m/Windows/files/settings', {
      method: 'POST',
      ...jsonBody({ roots: [], inbox: windows.inbox, agentWrite: 'none' })
    })
    assert.equal(forwardedSettings.status, 403)
    assert.equal((await forwardedSettings.json()).error.code, 'file_settings_local_only')

    await updateAgentWrite(mac, 'none')
    const localAgentDenied = await cli(mac, 'files', 'put', upload)
    assert.equal(localAgentDenied.code, 1)
    assert.match(localAgentDenied.stderr, /目标电脑限制 Agent 写入/)
  }
)

test('directory listing enforces its entry limit', async (t) => {
  const target = await instance(t, 'limit', { listLimit: 2 })
  await Promise.all(
    ['a.txt', 'b.txt', 'c.txt'].map((name) => writeFile(join(target.business, name), name))
  )
  const listing = await (
    await request(target, pathQuery('/api/files/list', target.business))
  ).json()
  assert.equal(listing.entries.length, 2)
  assert.equal(listing.truncated, true)
})

test('non-overwrite publish works without hardlink filesystem support', async (t) => {
  let linkAttempts = 0
  const target = await instance(t, 'no-hardlinks', {
    linkFile: async () => {
      linkAttempts++
      throw Object.assign(new Error('hardlinks unsupported'), { code: 'EPERM' })
    }
  })
  const path = join(target.inbox, 'exfat.txt')
  const created = await request(target, pathQuery('/api/files/write', path), {
    method: 'POST',
    body: 'no hardlinks'
  })
  assert.equal(created.status, 200)
  assert.equal(await readFile(path, 'utf8'), 'no hardlinks')
  assert.equal(linkAttempts, 1)
  const duplicate = await request(target, pathQuery('/api/files/write', path), {
    method: 'POST',
    body: 'replacement'
  })
  assert.equal(duplicate.status, 409)
  assert.equal(await readFile(path, 'utf8'), 'no hardlinks')
  assert.equal(linkAttempts, 1)
  console.log('ACCEPT no-hardlink publish: atomic fallback created once; duplicate returned 409')
})

test('failed no-hardlink rename removes temp but not a third-party replacement', async (t) => {
  let targetPath
  const target = await instance(t, 'no-hardlinks-race', {
    linkFile: async () => {
      throw Object.assign(new Error('hardlinks unsupported'), { code: 'EPERM' })
    },
    renameFile: async () => {
      await unlink(targetPath)
      await writeFile(targetPath, 'third party')
      throw Object.assign(new Error('injected rename failure'), { code: 'EIO' })
    }
  })
  targetPath = join(target.inbox, 'race.txt')
  const res = await request(target, pathQuery('/api/files/write', targetPath), {
    method: 'POST',
    body: 'upload'
  })
  assert.equal(res.status, 502)
  assert.equal(await readFile(targetPath, 'utf8'), 'third party')
  assert.deepEqual(
    (await readdir(target.inbox)).filter((name) => name.includes('.opc-upload-')),
    []
  )
})
