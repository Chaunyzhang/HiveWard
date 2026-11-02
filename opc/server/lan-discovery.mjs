import { join } from 'node:path'
import { dataDir } from './data-dir.mjs'
import {
  spawnBonjour,
  cleanupBonjourOrphans,
  cleanupLegacyRegistration
} from './bonjour-process.mjs'
import { createSocket } from 'node:dgram'
import { networkInterfaces } from 'node:os'

// Discovery never grants trust; tokens are exchanged only after local consent.
export function discoverUdp(machine, port, found, removed) {
  const socket = createSocket({ type: 'udp4', reuseAddr: true })
  const group = '239.255.87.88'
  const discoveryPort = 18889
  const seen = new Map()
  let ready = false
  const announce = () => {
    if (!ready) {
      return
    }
    const packet = Buffer.from(
      JSON.stringify({ protocol: 'hiveward-discovery-1', id: machine.id, name: machine.name, port })
    )
    socket.send(packet, discoveryPort, group, () => {})
    socket.send(packet, discoveryPort, '255.255.255.255', () => {})
    for (const [id, time] of seen) {
      if (Date.now() - time > 15000) {
        seen.delete(id)
        removed(id)
      }
    }
  }
  socket.on('error', () => {})
  socket.on('message', (buffer, info) => {
    if (buffer.length > 2048) {
      return
    }
    try {
      const d = JSON.parse(buffer.toString())
      if (
        d.protocol !== 'hiveward-discovery-1' ||
        typeof d.id !== 'string' ||
        !d.id ||
        d.id.length > 200 ||
        d.id === machine.id ||
        typeof d.name !== 'string' ||
        d.name.length > 200 ||
        !Number.isInteger(d.port) ||
        d.port < 1 ||
        d.port > 65535
      ) {
        return
      }
      if (!seen.has(d.id) && seen.size >= 256) {
        return
      }
      seen.set(d.id, Date.now())
      found({
        id: d.id,
        name: d.name,
        address: `${info.address}:${d.port}`,
        lastSeenAt: new Date().toISOString()
      })
    } catch {}
  })
  socket.bind(discoveryPort, () => {
    socket.setBroadcast(true)
    socket.setMulticastTTL(1)
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family === 'IPv4') {
          try {
            socket.addMembership(group, entry.address)
          } catch {}
        }
      }
    }
    ready = true
    announce()
  })
  const timer = setInterval(announce, 3000)
  timer.unref()
  socket.unref()
  return () => {
    ready = false
    clearInterval(timer)
    socket.close()
  }
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
export function resolveV4(
  host,
  timeout = 3000,
  spawn = (args) => spawnBonjour(args, join(dataDir(), 'bonjour-processes'))
) {
  if (IPV4.test(host) || process.platform !== 'darwin') {
    return Promise.resolve(host)
  }
  return new Promise((resolve) => {
    const addresses = []
    let settled = false
    const p = spawn(['-G', 'v4', host])
    const done = () => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      p.stop()
      resolve(addresses.find((ip) => !ip.startsWith('127.')) ?? addresses[0] ?? null)
    }
    const timer = setTimeout(done, timeout)
    let buffer = ''
    p.stdout.on('data', (data) => {
      buffer += data.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) {
        for (const m of line.matchAll(/\bAdd\s+\S+\s+\d+\s+\S+\s+(\d{1,3}(?:\.\d{1,3}){3})\b/g)) {
          addresses.push(m[1])
        }
      }
      if (addresses.some((ip) => !ip.startsWith('127.'))) {
        done()
      }
    })
    p.on('error', done)
    p.on('exit', done)
  })
}

export function discoverBonjour(
  machine,
  port,
  version,
  found,
  removed,
  {
    directory = join(dataDir(), 'bonjour-processes'),
    spawn = (args) => spawnBonjour(args, directory),
    cleanup = async () => {
      await cleanupBonjourOrphans(directory)
      await cleanupLegacyRegistration(machine, port)
    },
    resolve,
    interval = 5000,
    timeout = 4000
  } = {}
) {
  const children = new Set(),
    records = new Map(),
    timers = new Set()
  let closed = false
  let sequence = 0
  const resolveHost = resolve ?? ((host) => resolveV4(host, 3000, managedSpawn))
  function managedSpawn(args) {
    const p = spawn(args)
    children.add(p)
    p.on('error', () => {})
    p.on('close', () => children.delete(p))
    return p
  }
  function child(args, line) {
    const p = managedSpawn(args)
    let buffer = ''
    p.stdout.on('data', (data) => {
      if (closed) {
        return
      }
      buffer += data.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop().slice(-8192)
      for (const text of lines) {
        line?.(text)
      }
    })
    return p
  }
  function lookup(record) {
    if (closed || record.active || [...records.values()].filter((r) => r.active).length >= 16) {
      return
    }
    record.active = true
    record.lastAttempt = ++sequence
    let id,
      address,
      resolving = false,
      finished = false
    const finish = () => {
      if (finished) {
        return
      }
      finished = true
      clearTimeout(timer)
      timers.delete(timer)
      record.process.stop()
      record.active = false
    }
    const report = () => {
      if (finished || closed || records.get(record.key) !== record) {
        return
      }
      if (id && address) {
        record.id = id
        found({
          id,
          name: record.name,
          address,
          version: record.version,
          lastSeenAt: new Date().toISOString()
        })
        finish()
      }
    }
    record.process = child(['-L', record.name, record.type, record.domain], (text) => {
      if (finished) {
        return
      }
      const host = /can be reached at (.+?):(\d+)\s/.exec(text)
      const identity = /\bid=([^\s]+)/.exec(text),
        v = /\bv=([^\s]+)/.exec(text)
      if (identity) {
        id = identity[1]
      }
      if (v) {
        record.version = v[1]
      }
      if (host && !resolving) {
        resolving = true
        void resolveHost(host[1])
          .then((ip) => {
            if (ip) {
              address = `${ip}:${host[2]}`
            }
            report()
          })
          .catch(() => {})
      }
      report()
    })
    const timer = setTimeout(finish, timeout)
    timers.add(timer)
    record.process.once('error', finish)
    record.process.once('exit', finish)
  }
  const tick = setInterval(() => {
    for (const record of [...records.values()].sort(
      (a, b) => (a.lastAttempt ?? 0) - (b.lastAttempt ?? 0)
    )) {
      lookup(record)
    }
  }, interval)
  tick.unref()
  const initialized = cleanup()
    .then(() => {
      if (closed) {
        return
      }
      child([
        '-R',
        machine.name,
        '_opc._tcp',
        'local',
        String(port),
        `id=${machine.id}`,
        `v=${version}`
      ])
      child(['-B', '_opc._tcp'], (line) => {
        const m = /\b(Add|Rmv)\s+\d+\s+(\d+)\s+(\S+)\s+(_opc\._tcp\.?)\s+(.+?)\s*$/.exec(line)
        if (!m) {
          return
        }
        const [, action, iface, domain, type, name] = m
        const key = `${iface}/${domain}/${name}`
        const previous = records.get(key)
        if (action === 'Rmv') {
          previous?.process?.stop()
          records.delete(key)
          if (previous?.id && ![...records.values()].some((r) => r.id === previous.id)) {
            removed(previous.id)
          }
        } else if (!previous && records.size < 256) {
          const record = { key, domain, type, name }
          records.set(key, record)
          lookup(record)
        }
      })
    })
    .catch(() => {})
  let closing
  const close = () => {
    if (closing) {
      return closing
    }
    closed = true
    clearInterval(tick)
    for (const timer of timers) {
      clearTimeout(timer)
    }
    const stopped = [...children].map((p) => p.stop())
    records.clear()
    closing = Promise.all([initialized, ...stopped]).then(() => {})
    return closing
  }
  process.once('exit', close)
  return () => {
    process.removeListener('exit', close)
    return close()
  }
}
