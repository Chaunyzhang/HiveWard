import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { userInfo } from 'node:os'

const secret = () => randomBytes(32).toString('hex')
const fail = (status, code, message) => Object.assign(new Error(message), { status, code })
const clean = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 200
const validPeer = (p) =>
  p &&
  clean(p.id) &&
  clean(p.name) &&
  clean(p.address) &&
  /^[a-f0-9]{64}$/.test(p.inboundToken) &&
  /^[a-f0-9]{64}$/.test(p.outboundToken)

export function createOrganization({
  machine,
  lanPort,
  read,
  save,
  file,
  peers,
  replace,
  remote,
  onInvite = () => {},
  now = Date.now,
  ttl = 120000
}) {
  let state = read(file, () => ({ organization: null, deliveries: [], revoked: [] }))
  state.revoked ??= []
  state.receipts ??= []
  state.notices ??= []
  const invitations = new Map()
  const arrivals = []
  let busy = false
  let retrying = false
  const persist = () => save(file, state)
  if (!state.organization && peers().length) {
    const ids = [machine.id, ...peers().map((p) => p.id)].sort()
    state.organization = { id: `legacy-${ids[0]}`, name: 'HiveWard 组织', legacy: true }
    persist()
  }
  const publicOrg = () =>
    state.organization
      ? {
          id: state.organization.id,
          name: state.organization.name,
          members: [machine.id, ...peers().map((p) => p.id)]
        }
      : null
  const publicInvite = (i) => ({
    id: i.id,
    direction: i.direction,
    status: i.status,
    machine: i.machine,
    organization: i.organization,
    expiresAt: new Date(i.expires).toISOString()
  })
  const expire = () => {
    for (const [id, i] of invitations) {
      if (i.status === 'pending' && now() >= i.expires) {
        i.status = 'expired'
      }
      if (now() - i.expires > 600000) {
        invitations.delete(id)
      }
    }
  }
  const exclusive = async (work) => {
    if (busy) {
      throw fail(409, 'organization_busy', '组织正在更新，请重试')
    }
    busy = true
    try {
      return await work()
    } finally {
      busy = false
    }
  }
  async function deliver() {
    if (retrying) {
      return
    }
    retrying = true
    try {
      for (const d of state.deliveries) {
        try {
          await remote(d.address, d.path ?? '/lan/organization/remove', {
            token: d.token,
            body: d.body
          })
          state.deliveries = state.deliveries.filter((x) => x !== d)
          persist()
        } catch {}
      }
    } finally {
      retrying = false
    }
  }
  const timer = setInterval(() => {
    expire()
    void deliver()
  }, 1000)
  timer.unref()
  async function remove(id) {
    const list = peers()
    if (id !== machine.id && !list.some((p) => p.id === id)) {
      throw fail(404, 'machine_not_paired', '电脑不在组织内')
    }
    for (const i of invitations.values()) {
      if (id === machine.id || i.machine.id === id) {
        i.result = undefined
        if (i.status === 'pending') {
          i.status = 'cancelled'
        }
      }
    }
    state.deliveries = state.deliveries.filter(
      (d) =>
        d.path !== '/lan/organization/member' ||
        (id !== machine.id && d.body.peer.id !== id && d.recipient !== id)
    )
    state.deliveries = state.deliveries.filter(
      (d) => !d.path || (id !== machine.id && d.recipient !== id)
    )
    const body = { id, organizationId: state.organization?.id }
    state.revoked.push({ key: `${body.organizationId}/${id}`, at: now() })
    state.deliveries.push(
      ...list.map((p) => ({ address: p.address, token: p.outboundToken, body }))
    )
    replace(id === machine.id ? [] : list.filter((p) => p.id !== id))
    if (id === machine.id) {
      state.organization = null
    }
    persist()
    await deliver()
    return { ok: true, pending: state.deliveries.filter((d) => !d.path).length }
  }
  return {
    close() {
      clearInterval(timer)
    },
    async reconcileLegacy(p) {
      if (!state.organization?.legacy) {
        return
      }
      const result = await remote(p.address, '/lan/organization/legacy', {
        token: p.outboundToken,
        body: { id: state.organization.id }
      }).catch((e) => {
        if (e.status === 409) {
          return { id: state.organization.id }
        }
        throw e
      })
      if (result.id < state.organization.id) {
        state.organization.id = result.id
        persist()
      }
    },
    snapshot() {
      expire()
      return {
        organization: publicOrg(),
        organizationNotices: state.notices,
        invitations: [...invitations.values()].map(publicInvite),
        pendingRemovals: state.deliveries.filter((d) => !d.path).length,
        pendingMembers: state.deliveries.filter((d) => d.path === '/lan/organization/member')
          .length,
        pendingOrganizationUpdates: state.deliveries.filter(
          (d) => d.path === '/lan/organization/rename'
        ).length
      }
    },
    async invite(address, expectedId) {
      return exclusive(async () => {
        if (!lanPort) {
          throw fail(409, 'lan_disabled', '局域网服务未开启')
        }
        expire()
        const hello = await remote(address, '/lan/hello')
        if (
          !clean(hello.id) ||
          !clean(hello.name) ||
          hello.id === machine.id ||
          (expectedId && hello.id !== expectedId)
        ) {
          throw fail(400, 'invalid_peer', '机器身份不符')
        }
        if (peers().some((p) => p.id === hello.id)) {
          throw fail(409, 'already_member', '已是组织成员')
        }
        if (
          [...invitations.values()].some((i) => i.machine.id === hello.id && i.status === 'pending')
        ) {
          throw fail(409, 'invite_pending', '已有待处理邀请')
        }
        if (!state.organization) {
          state.organization = { id: randomUUID(), name: `${machine.name}的组织` }
          persist()
        }
        const i = {
          id: randomUUID(),
          direction: 'sent',
          status: 'pending',
          machine: { id: hello.id, name: hello.name, address },
          organization: publicOrg(),
          expires: now() + ttl,
          capability: secret(),
          token: secret()
        }
        await remote(address, '/lan/invitations', {
          body: {
            id: i.id,
            machine: { ...machine, user: userInfo().username, port: lanPort },
            organization: i.organization,
            expires: i.expires,
            capability: i.capability
          }
        })
        invitations.set(i.id, i)
        return publicInvite(i)
      })
    },
    async action(id, action) {
      return exclusive(async () => {
        expire()
        const i = invitations.get(id)
        if (!i) {
          throw fail(404, 'invite_not_found', '邀请不存在')
        }
        if (i.status !== 'pending') {
          throw fail(409, `invite_${i.status}`, `邀请状态：${i.status}`)
        }
        if (action === 'cancel' && i.direction === 'sent') {
          await remote(i.machine.address, `/lan/invitations/${id}/cancel`, {
            body: { capability: i.capability }
          })
          i.status = 'cancelled'
        } else if (['accept', 'reject'].includes(action) && i.direction === 'incoming') {
          if (action === 'accept' && state.organization) {
            throw fail(409, 'already_in_organization', '请先退出当前组织')
          }
          const token = secret()
          const result = await remote(i.machine.address, `/lan/invitations/${id}/decision`, {
            body: { capability: i.capability, accept: action === 'accept', token },
            timeout: 15000
          })
          if (action === 'accept') {
            if (!Array.isArray(result.peers) || !result.peers.every(validPeer)) {
              throw fail(502, 'invalid_peer', '成员凭据无效')
            }
            result.peers.find((p) => p.id === i.machine.id).address = i.machine.address
            replace(result.peers)
            state.organization = { id: i.organization.id, name: i.organization.name }
            persist()
          }
          i.status = action === 'accept' ? 'accepted' : 'rejected'
        } else {
          throw fail(400, 'bad_request', '邀请方向或操作无效')
        }
        return publicInvite(i)
      })
    },
    remove: (id) => exclusive(() => remove(id)),
    async rename(name) {
      return exclusive(async () => {
        if (!state.organization || !clean(name)) {
          throw fail(400, 'bad_request', '组织不存在或名字无效')
        }
        state.organization.name = name.trim()
        state.deliveries = state.deliveries.filter((d) => d.path !== '/lan/organization/rename')
        state.deliveries.push(
          ...peers().map((p) => ({
            recipient: p.id,
            address: p.address,
            token: p.outboundToken,
            path: '/lan/organization/rename',
            body: { name: name.trim(), organizationId: state.organization.id }
          }))
        )
        persist()
        await deliver()
        return publicOrg()
      })
    },
    async receive(req, path, body, authenticated) {
      expire()
      if (path === '/lan/invitations') {
        while (arrivals.length && arrivals[0] <= now() - 60000) {
          arrivals.shift()
        }
        if (arrivals.length >= 5) {
          throw fail(429, 'invite_rate_limited', '邀请过于频繁，请稍后重试')
        }
        arrivals.push(now())
        if (state.organization) {
          throw fail(409, 'already_in_organization', '对方已加入组织')
        }
        if (
          !clean(body.id) ||
          !clean(body.machine?.id) ||
          !clean(body.machine?.name) ||
          !clean(body.machine?.user) ||
          !clean(body.organization?.id) ||
          !clean(body.organization?.name) ||
          !/^[a-f0-9]{64}$/.test(body.capability) ||
          !Number.isInteger(body.machine.port) ||
          body.machine.port < 1 ||
          body.machine.port > 65535 ||
          !Number.isFinite(body.expires) ||
          body.expires <= now()
        ) {
          throw fail(400, 'bad_request', '无效邀请')
        }
        if (invitations.has(body.id)) {
          throw fail(409, 'invite_exists', '邀请已存在')
        }
        const ip = req.socket.remoteAddress.replace(/^::ffff:/, '')
        const i = {
          id: body.id,
          direction: 'incoming',
          status: 'pending',
          machine: {
            id: body.machine.id,
            name: body.machine.name,
            user: body.machine.user,
            address: `${ip.includes(':') ? `[${ip}]` : ip}:${body.machine.port}`
          },
          organization: { id: body.organization.id, name: body.organization.name },
          capability: body.capability,
          expires: Math.min(body.expires, now() + ttl)
        }
        invitations.set(i.id, i)
        onInvite(publicInvite(i))
        return publicInvite(i)
      }
      const match = /^\/lan\/invitations\/([^/]+)\/(decision|cancel)$/.exec(path)
      if (match) {
        return exclusive(async () => {
          const i = invitations.get(match[1])
          if (!i || body.capability !== i.capability) {
            throw fail(401, 'unauthorized', '邀请凭据无效')
          }
          if (
            i.status === 'accepted' &&
            i.result &&
            match[2] === 'decision' &&
            body.accept === true
          ) {
            return i.result
          }
          if (i.status === 'cancelled' && i.direction === 'incoming' && match[2] === 'cancel') {
            return { ok: true }
          }
          if (
            i.status === 'rejected' &&
            i.direction === 'sent' &&
            match[2] === 'decision' &&
            body.accept === false
          ) {
            return { ok: true }
          }
          if (i.status !== 'pending') {
            throw fail(409, `invite_${i.status}`, `邀请状态：${i.status}`)
          }
          if (match[2] === 'cancel' && i.direction === 'incoming') {
            i.status = 'cancelled'
            return { ok: true }
          }
          if (match[2] !== 'decision' || i.direction !== 'sent') {
            throw fail(400, 'bad_request', '邀请方向错误')
          }
          if (body.accept === false) {
            i.status = 'rejected'
            return { ok: true }
          }
          if (body.accept !== true || !/^[a-f0-9]{64}$/.test(body.token)) {
            throw fail(400, 'bad_request', '无效决定')
          }
          if (state.organization?.id !== i.organization.id) {
            throw fail(409, 'organization_changed', '组织已变更')
          }
          const added = {
            ...i.machine,
            inboundToken: i.token,
            outboundToken: body.token,
            pairedAt: new Date(now()).toISOString()
          }
          const result = [
            {
              ...machine,
              address: '',
              inboundToken: body.token,
              outboundToken: i.token,
              pairedAt: added.pairedAt
            }
          ]
          for (const p of peers()) {
            const pair = { ...added, inboundToken: secret(), outboundToken: secret() }
            const delivery = {
              recipient: p.id,
              address: p.address,
              token: p.outboundToken,
              path: '/lan/organization/member',
              body: { organizationId: state.organization.id, peer: pair }
            }
            state.deliveries.push(delivery)
            persist()
            try {
              await remote(p.address, delivery.path, { token: delivery.token, body: delivery.body })
              state.deliveries = state.deliveries.filter((d) => d !== delivery)
              persist()
            } catch {}
            result.push({
              id: p.id,
              name: p.name,
              address: p.address,
              inboundToken: pair.outboundToken,
              outboundToken: pair.inboundToken,
              pairedAt: added.pairedAt
            })
          }
          replace([...peers(), added])
          i.status = 'accepted'
          // The recipient derives the inviter address from the observed invitation connection.
          result[0].address = 'observed:1'
          i.result = { peers: result }
          return i.result
        })
      }
      if (!path.startsWith('/lan/organization/')) {
        return undefined
      }
      const receipt = createHash('sha256')
        .update(`${req.headers?.authorization ?? ''}/${body.organizationId}/${body.id}`)
        .digest('hex')
      if (path === '/lan/organization/remove' && state.receipts.includes(receipt)) {
        return { ok: true }
      }
      if (!authenticated) {
        throw fail(401, 'unauthorized', '需要组织成员令牌')
      }
      return exclusive(async () => {
        if (
          path.endsWith('/legacy') &&
          state.organization?.legacy &&
          clean(body.id) &&
          body.id.startsWith('legacy-')
        ) {
          state.organization.id = [state.organization.id, body.id].sort()[0]
          persist()
          return { id: state.organization.id }
        }
        if (body.organizationId !== state.organization?.id) {
          throw fail(409, 'organization_changed', '组织身份不符')
        }
        if (path.endsWith('/member')) {
          if (
            state.revoked.some(
              (r) =>
                r.key === `${body.organizationId}/${body.peer?.id}` &&
                Date.parse(body.peer.pairedAt) <= r.at
            )
          ) {
            throw fail(409, 'member_removed', '成员已移出，需要新的组织邀请')
          }
          const existing = peers().find((p) => p.id === body.peer?.id)
          if (
            existing &&
            existing.inboundToken === body.peer.inboundToken &&
            existing.outboundToken === body.peer.outboundToken
          ) {
            return { ok: true }
          }
          if (!validPeer(body.peer) || body.peer.id === machine.id || existing) {
            throw fail(400, 'bad_request', '成员信息无效或已存在')
          }
          replace([...peers(), body.peer])
          return { ok: true }
        }
        if (path.endsWith('/remove')) {
          state.notices = [
            ...state.notices.slice(-49),
            {
              id: randomUUID(),
              type:
                body.id === machine.id
                  ? 'removed'
                  : body.id === authenticated.id
                    ? 'member-left'
                    : 'member-removed',
              actor: { id: authenticated.id, name: authenticated.name },
              machineId: body.id,
              organization: { id: state.organization.id, name: state.organization.name },
              createdAt: new Date(now()).toISOString()
            }
          ]
          state.receipts = [...state.receipts.slice(-255), receipt]
          state.revoked.push({ key: `${body.organizationId}/${body.id}`, at: now() })
          state.deliveries = state.deliveries.filter(
            (d) =>
              d.path !== '/lan/organization/member' ||
              (body.id !== machine.id && d.body.peer.id !== body.id && d.recipient !== body.id)
          )
          state.deliveries = state.deliveries.filter(
            (d) => !d.path || (body.id !== machine.id && d.recipient !== body.id)
          )
          for (const i of invitations.values()) {
            if (body.id === machine.id || i.machine.id === body.id) {
              i.result = undefined
              if (i.status === 'pending') {
                i.status = 'cancelled'
              }
            }
          }
          replace(body.id === machine.id ? [] : peers().filter((p) => p.id !== body.id))
          if (body.id === machine.id) {
            state.organization = null
          }
          persist()
          return { ok: true }
        }
        if (path.endsWith('/rename') && clean(body.name)) {
          state.organization.name = body.name.trim()
          persist()
          return { ok: true }
        }
        throw fail(400, 'bad_request', '无效组织操作')
      })
    }
  }
}
