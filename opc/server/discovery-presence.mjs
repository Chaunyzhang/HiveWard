// Advertisements are hints; only a matching HTTP identity renews presence.
export function createDiscoveryPresence({
  probe,
  found,
  removed,
  now = Date.now,
  interval = 5000,
  ttl = 10000
}) {
  const records = new Map()
  let closed = false
  async function check(record) {
    if (record.pending || closed) {
      return
    }
    record.pending = true
    try {
      const hello = await probe(record.value.address)
      if (closed || records.get(record.value.id) !== record) {
        return
      }
      if (hello.id !== record.value.id || typeof hello.name !== 'string') {
        throw new Error('Identity mismatch')
      }
      record.verified = now()
      found({
        ...record.value,
        name: hello.name,
        version: hello.version,
        platform: hello.platform ?? record.value.platform,
        lastSeenAt: new Date(now()).toISOString()
      })
    } catch {
      if (!closed && records.get(record.value.id) === record) {
        removed(record.value.id)
      }
    } finally {
      record.pending = false
    }
  }
  function sweep() {
    for (const [id, record] of records) {
      if (now() - record.seen >= ttl) {
        records.delete(id)
        removed(id)
      } else {
        if (record.verified === undefined || now() - record.verified >= interval) {
          void check(record)
        }
      }
    }
  }
  const timer = setInterval(sweep, interval)
  timer.unref()
  return {
    async found(value) {
      if (closed) {
        return
      }
      let record = records.get(value.id)
      if (!record || record.value.address !== value.address) {
        if (!record && records.size >= 256) {
          return
        }
        removed(value.id)
        record = { value, seen: now() }
        records.set(value.id, record)
      }
      record.seen = now()
      if (record.verified === undefined || now() - record.verified >= interval) {
        await check(record)
      }
    },
    removed(id) {
      records.delete(id)
      removed(id)
    },
    sweep,
    close() {
      closed = true
      clearInterval(timer)
      records.clear()
    }
  }
}
