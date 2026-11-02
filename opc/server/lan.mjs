import { randomUUID, timingSafeEqual, createHmac } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { execFileSync } from 'node:child_process'
import { request } from 'node:http'
import { dataDir } from './data-dir.mjs'
import { createOrganization } from './lan-organization.mjs'
import { discoverUdp, discoverBonjour } from './lan-discovery.mjs'
import { createDiscoveryPresence } from './discovery-presence.mjs'
export { resolveV4 } from './lan-discovery.mjs'

// Packaged apps keep package.json at the app root; source checkouts keep it in desktop/.
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../desktop/package.json', import.meta.url))).version
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw e
    }
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version
  }
})()
const error = (status, code, message) => Object.assign(new Error(message), { status, code })
const iso = () => new Date().toISOString()
const validToken = (t) => typeof t === 'string' && /^[a-f0-9]{64}$/.test(t)
const sameToken = (a, b) =>
  validToken(a) && validToken(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
const save = (file, value) => {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
}
const read = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') {
      return fallback()
    }
    throw e
  }
}
export function addressOf(value) {
  if (typeof value !== 'string' || !value.trim() || /[\s/@?#\\]/.test(value)) {
    throw error(400, 'bad_request', '地址应为 IP、主机名或 host:port')
  }
  let url
  try {
    url = new URL(`http://${value}`)
  } catch {
    throw error(400, 'bad_request', '无效地址')
  }
  // URL omits the default HTTP port even when the user explicitly supplied :80.
  const port =
    url.port || (value.match(/:(\d+)$/)?.[1] ? String(Number(value.match(/:(\d+)$/)[1])) : '8788')
  return `${url.hostname}:${port}`
}
async function jsonBody(req) {
  let raw = ''
  for await (const part of req) {
    raw += part
    if (raw.length > 16384) {
      throw error(413, 'bad_request', '请求体过大')
    }
  }
  try {
    return JSON.parse(raw || '{}')
  } catch {
    throw error(400, 'bad_request', '请求体不是 JSON')
  }
}
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export function createLan({ lanPort, directory = dataDir(), onInvite, now, inviteTtl, exitRegion }) {
  const dir = directory
  mkdirSync(dir, { recursive: true })
  const machineFile = join(dir, 'machine.json'),
    peersFile = join(dir, 'peers.json')
  const machine = read(machineFile, () => {
    let name = hostname()
    try {
      if (process.platform !== 'darwin') {
        throw new Error('Not macOS')
      }
      name =
        execFileSync('scutil', ['--get', 'ComputerName'], {
          encoding: 'utf8',
          timeout: 2000
        }).trim() || name
    } catch {}
    const value = { id: randomUUID(), name }
    save(machineFile, value)
    return value
  })
  let peers = read(peersFile, () => [])
  save(peersFile, peers)
  const discovered = new Map(),
    observations = new Map(),
    pending = new Map()
  let stopped = false
  const persist = () => save(peersFile, peers)
  const membershipListeners = new Set()
  const organization = createOrganization({
    machine,
    lanPort,
    read,
    save,
    file: join(dir, 'organization.json'),
    peers: () => peers,
    replace: (next) => {
      peers = next
      persist()
      for (const listener of membershipListeners) {
        listener()
      }
      refreshAll()
    },
    remote,
    onInvite,
    now,
    ttl: inviteTtl
  })
  const publicMachine = (p) => {
    const o = observations.get(p.id)
    return {
      id: p.id,
      name: p.name,
      self: false,
      paired: true,
      discovered: discovered.has(p.id),
      invite: null,
      address: p.address,
      status: o?.status ?? 'offline',
      ...(o?.lastSeenAt ? { lastSeenAt: o.lastSeenAt } : {}),
      ...(o?.version ? { version: o.version } : {}),
      exitRegion: o?.exitRegion ?? null,
      ...(o?.status === 'online' && o.summary ? { summary: o.summary } : {})
    }
  }
  async function remote(address, path, { token, body, timeout = 1500 } = {}) {
    const r = await fetch(`http://${address}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'content-type': 'application/json'
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
      redirect: 'error'
    })
    const data = await r.json()
    if (!r.ok) {
      throw error(
        r.status,
        data.error?.code ?? 'remote_error',
        data.error?.message ?? `HTTP ${r.status}`
      )
    }
    return data
  }
  async function refresh(p) {
    if (pending.has(p.id)) {
      return pending.get(p.id)
    }
    const work = (async () => {
      const old = observations.get(p.id)
      let reached = false
      try {
        const hello = await remote(p.address, '/lan/hello')
        if (hello.id !== p.id) {
          throw new Error('机器身份不符')
        }
        if (stopped || !peers.includes(p)) {
          return
        }
        await organization.reconcileLegacy(p)
        reached = true
        observations.set(p.id, {
          ...old,
          status: 'online',
          lastSeenAt: iso(),
          version: hello.version
        })
        const region = await remote(p.address, '/api/exit-region', { token: p.outboundToken, timeout: 15000 }).catch(() => null)
        if (stopped || !peers.includes(p)) {
          return
        }
        observations.set(p.id, { ...observations.get(p.id), exitRegion: region })
        const [overview, terminals] = await Promise.all([
          remote(p.address, '/api/overview', { token: p.outboundToken, timeout: 10000 }),
          remote(p.address, '/api/orca/terminals', { token: p.outboundToken, timeout: 10000 })
        ])
        if (stopped || !peers.includes(p)) {
          return
        }
        observations.set(p.id, {
          status: 'online',
          lastSeenAt: iso(),
          version: hello.version,
          exitRegion: region,
          summary: {
            orcaReachable: overview.health.reachable,
            agents: terminals.terminals.filter((t) => t.agent && t.connected).length,
            tasksOpen: overview.businesses.reduce((n, b) => n + b.counts.tasksOpen, 0),
            decisionsPending: overview.decisionsPending
          }
        })
      } catch {
        if (!stopped && peers.includes(p)) {
          observations.set(p.id, {
            ...observations.get(p.id),
            status: reached ? 'online' : 'offline',
            summary: undefined
          })
        }
      }
    })().finally(() => pending.delete(p.id))
    pending.set(p.id, work)
    return work
  }
  const refreshAll = () => {
    for (const p of peers) {
      void refresh(p)
    }
  }
  const timer = setInterval(refreshAll, 5000)
  timer.unref()
  refreshAll()

  function authenticate(req) {
    const token = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1]
    return peers.find((p) => sameToken(token, p.inboundToken))
  }
  async function lanRequest(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/lan/hello') {
      send(res, 200, { ...machine, version: VERSION })
      return true
    }
    if (
      req.method === 'POST' &&
      (url.pathname.startsWith('/lan/invitations') || url.pathname.startsWith('/lan/organization/'))
    ) {
      const result = await organization.receive(
        req,
        url.pathname,
        await jsonBody(req),
        authenticate(req)
      )
      if (result !== undefined) {
        send(res, 200, result)
        return true
      }
    }
    if (req.method === 'POST' && url.pathname === '/lan/probe') {
      const body = await jsonBody(req)
      const known = peers.find((p) => p.id === body.id)
      if (!known || !validToken(body.nonce)) {
        throw error(401, 'unauthorized', '未知成员')
      }
      send(res, 200, {
        proof: createHmac('sha256', known.inboundToken).update(body.nonce).digest('hex')
      })
      return true
    }
    const peer = authenticate(req)
    if (!peer) {
      throw error(401, 'unauthorized', '需要已配对电脑的令牌')
    }
    if (!url.pathname.startsWith('/api/') || (/^\/api\/(app|m|machines)(\/|$)/.test(url.pathname) || (url.pathname.startsWith('/api/exit-region/') && req.method !== 'GET'))) {
      throw error(403, 'forbidden', '局域网端口不开放此接口')
    }
    return false
  }
  async function localRequest(req, res, url, handle) {
    const proxy = /^\/api\/m\/([^/]+)\/(.*)$/.exec(url.pathname)
    if (proxy) {
      const id = decodeURIComponent(proxy[1])
      const path = `${proxy[2].startsWith('api/') ? '/' : '/api/'}${proxy[2]}${url.search}`
      if (id === machine.id) {
        if (/^\/api\/m(\/|$)/.test(new URL(path, 'http://x').pathname)) {
          throw error(400, 'bad_request', '不支持多跳转发')
        }
        req.url = path
        await handle(req, res, false)
      } else {
        const p = peers.find((p) => p.id === id)
        if (!p) {
          throw error(404, 'machine_not_paired', '电脑尚未配对')
        }
        forward(req, res, p, path)
      }
      return true
    }
    if (req.method === 'GET' && url.pathname === '/api/machines') {
      const snapshot = organization.snapshot()
      const localExitRegion = exitRegion ? await exitRegion() : null
      const candidates = new Map([...discovered.values()].map((d) => [d.id, d]))
      for (const i of snapshot.invitations) {
        if (!candidates.has(i.machine.id)) {
          candidates.set(i.machine.id, i.machine)
        }
      }
      const machines = [
        {
          ...machine,
          self: true,
          exitRegion: localExitRegion,
          paired: !!snapshot.organization,
          discovered: false,
          invite: null,
          status: 'online',
          version: VERSION
        },
        ...peers.map(publicMachine),
        ...[...candidates.values()]
          .filter((d) => !peers.some((p) => p.id === d.id))
          .map((d) => ({
            ...d,
            self: false,
            paired: false,
            discovered: discovered.has(d.id),
            status: discovered.has(d.id) ? 'online' : 'offline'
          }))
      ].map((m) => ({
        exitRegion: null,
        ...m,
        invite:
          snapshot.invitations.find((i) => i.machine.id === m.id && i.status === 'pending')
            ?.direction ?? null
      }))
      send(res, 200, { ...snapshot, machines })
      return true
    }
    if (req.method !== 'POST') {
      return false
    }
    if (url.pathname === '/api/machines/invite') {
      const b = await jsonBody(req)
      const address = addressOf(b.address ?? discovered.get(b.machineId)?.address)
      send(res, 200, await organization.invite(address, b.machineId))
      return true
    }
    const invitation = /^\/api\/machines\/invitations\/([^/]+)\/(accept|reject|cancel)$/.exec(
      url.pathname
    )
    if (invitation) {
      send(res, 200, await organization.action(invitation[1], invitation[2]))
      return true
    }
    if (url.pathname === '/api/machines/organization/leave') {
      send(res, 200, await organization.remove(machine.id))
      return true
    }
    if (url.pathname === '/api/machines/organization/rename') {
      send(res, 200, await organization.rename((await jsonBody(req)).name))
      return true
    }
    const action = /^\/api\/machines\/([^/]+)\/(rename|remove)$/.exec(url.pathname)
    if (!action) {
      return false
    }
    const id = decodeURIComponent(action[1])
    if (action[2] === 'remove') {
      send(res, 200, await organization.remove(id))
      return true
    }
    const { name } = await jsonBody(req)
    if (typeof name !== 'string' || !name.trim() || name.length > 200) {
      throw error(400, 'bad_request', '名字无效')
    }
    if (id === machine.id) {
      machine.name = name.trim()
      save(machineFile, machine)
    } else {
      const p = peers.find((p) => p.id === id)
      if (!p) {
        throw error(404, 'machine_not_paired', '电脑尚未加入组织')
      }
      p.name = name.trim()
      persist()
    }
    send(res, 200, { ok: true })
    return true
  }
  function forward(req, res, p, path) {
    let upstream, deadline
    const offline = () => {
      observations.set(p.id, { ...observations.get(p.id), status: 'offline', summary: undefined })
      if (!res.headersSent) {
        send(res, 503, { error: { code: 'machine_offline', message: '连不上对方电脑' } })
      } else {
        res.destroy()
      }
      upstream?.destroy()
    }
    const headers = { authorization: `Bearer ${p.outboundToken}` }
    for (const key of ['content-type', 'content-length', 'accept']) {
      if (req.headers[key]) {
        headers[key] = req.headers[key]
      }
    }
    upstream = request(
      `http://${p.address}${path}`,
      { method: req.method, headers },
      (response) => {
        if (response.statusCode === 401) {
          response.resume()
          send(res, 401, {
            error: { code: 'machine_unpaired', message: '对方已解除配对，请重新配对' }
          })
        } else {
          res.writeHead(
            response.statusCode,
            response.headers['content-type']
              ? { 'content-type': response.headers['content-type'] }
              : {}
          )
          response.pipe(res)
          response.on('error', () => res.destroy())
        }
      }
    )
    // 超时不等于掉线（可能只是这个接口慢，比如截图）：回 504，不把对方标成离线
    deadline = setTimeout(() => {
      if (!res.headersSent) {
        send(res, 504, { error: { code: 'machine_timeout', message: '对方电脑响应超时' } })
      } else {
        res.destroy()
      }
      upstream?.destroy()
    }, 15000)
    upstream.on('error', () => {
      if (res.writableEnded || res.destroyed) {
        return
      }
      if (res.headersSent) {
        res.destroy()
      } // 传到一半断了
      else {
        offline()
      }
    })
    res.on('close', () => {
      clearTimeout(deadline)
      upstream.destroy()
    })
    req.on('aborted', () => upstream.destroy())
    req.pipe(upstream)
  }
  const checkingAddresses = new Set()
  const found = (d) => {
    if (d.id === machine.id || stopped) {
      return
    }
    if (!discovered.has(d.id) && discovered.size >= 256) {
      return
    }
    discovered.set(d.id, d)
    const peer = peers.find((p) => p.id === d.id)
    if (!peer || peer.address === d.address || checkingAddresses.has(peer.id)) {
      return
    }
    checkingAddresses.add(peer.id)
    const nonce = createHmac('sha256', peer.outboundToken).update(randomUUID()).digest('hex')
    void remote(d.address, '/lan/probe', { body: { id: machine.id, nonce } })
      .then((result) => {
        const expected = createHmac('sha256', peer.outboundToken).update(nonce).digest('hex')
        if (!stopped && peers.includes(peer) && sameToken(result.proof, expected)) {
          peer.address = d.address
          persist()
          void refresh(peer)
        }
      })
      .catch(() => {})
      .finally(() => checkingAddresses.delete(peer.id))
  }
  const removed = (id) => discovered.delete(id)
  const presence = createDiscoveryPresence({
    probe: (address) => remote(addressOf(address), '/lan/hello', { timeout: 1000 }),
    found,
    removed
  })
  const candidate = (value) => {
    if (value.id !== machine.id) {
      void presence.found(value)
    }
  }
  const stopUdp = lanPort ? discoverUdp(machine, lanPort, candidate, presence.removed) : () => {}
  const stopDiscovery =
    lanPort && process.platform === 'darwin'
      ? discoverBonjour(machine, lanPort, VERSION, candidate, presence.removed, {
          directory: join(dir, 'bonjour-processes')
        })
      : () => {}
  return {
    lanRequest,
    localRequest,
    authenticate,
    onMembershipChange(listener) {
      membershipListeners.add(listener)
      return () => membershipListeners.delete(listener)
    },
    streamTarget(id) {
      if (id === machine.id) {
        return {}
      }
      const peer = peers.find((p) => p.id === id)
      if (!peer) {
        throw error(404, 'machine_not_paired', '电脑尚未配对')
      }
      return { peer }
    },
    close() {
      stopped = true
      clearInterval(timer)
      presence.close()
      const discoveryClosed = stopDiscovery()
      stopUdp()
      organization.close()
      return discoveryClosed
    }
  }
}
