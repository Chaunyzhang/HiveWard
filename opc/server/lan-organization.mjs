import { invitationCode, nonceCommitment, publicInvitation as publicInvite } from './lan-invitation-verification.mjs'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { userInfo } from 'node:os'
import {
  socketFingerprint,
  validFingerprint,
  validTlsPort
} from './lan-tls.mjs'

const secret = () => randomBytes(32).toString('hex')
const fail = (status, code, message) => Object.assign(new Error(message), { status, code })
const clean = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 200
const validPeer = (p) =>
  p &&
  clean(p.id) &&
  clean(p.name) &&
  clean(p.address) &&
  /^[a-f0-9]{64}$/.test(p.inboundToken) &&
  /^[a-f0-9]{64}$/.test(p.outboundToken) &&
  validFingerprint(p.fingerprint) &&
  validTlsPort(p.tlsPort)

export function createOrganization({
  machine,
  lanPort,
  identity,
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
  if (!state.tlsVersion) {
    if (peers().some((p) => !validPeer(p))) {
      state.organization = null
      state.deliveries = []
      state.receipts = []
    }
    state.tlsVersion = 1
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
            fingerprint: d.fingerprint,
            tlsPort: d.tlsPort,
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
      ...list
        .filter(validPeer)
        .map((p) => ({
          address: p.address,
          fingerprint: p.fingerprint,
          tlsPort: p.tlsPort,
          token: p.outboundToken,
          body
        }))
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
    snapshot() {
      expire()
      return {
        organization: publicOrg(),
        organizationNotices: state.notices,
        invitations: [...invitations.values()].filter((i) => i.verifyCode).map(publicInvite),
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
        if (!validFingerprint(hello.fingerprint) || !validTlsPort(hello.tlsPort)) {
          throw fail(409, 'tls_rejoin_required', '对方需要升级 TLS 后重新加入')
        }
        if (
          !clean(hello.id) ||
          !clean(hello.name) ||
          hello.id === machine.id ||
          (expectedId && hello.id !== expectedId)
        ) {
          throw fail(400, 'invalid_peer', '机器身份不符')
        }
        if (peers().some((p) => p.id === hello.id && validPeer(p))) {
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
          machine: {
            id: hello.id,
            name: hello.name,
            address,
            fingerprint: hello.fingerprint,
            tlsPort: hello.tlsPort
          },
          nonce: secret(),
          organization: publicOrg(),
          expires: now() + ttl,
          capability: secret(),
          token: secret()
        }
        const response = await remote(address, '/lan/invitations', {
          fingerprint: hello.fingerprint,
          tlsPort: hello.tlsPort,
          body: {
            id: i.id,
            machine: { ...machine, ...identity(), user: userInfo().username, port: lanPort },
            commitment: nonceCommitment(i.nonce),
            organization: i.organization,
            expires: i.expires,
            capability: i.capability
          }
        })
        if (!validFingerprint(response.nonce)) {
          throw fail(400, 'invalid_nonce', '邀请随机数无效')
        }
        i.verifyCode = invitationCode(
          identity().fingerprint,
          hello.fingerprint,
          i.id,
          i.nonce,
          response.nonce
        )
        await remote(address, `/lan/invitations/${i.id}/verify`, {
          ...i.machine,
          body: { capability: i.capability, nonce: i.nonce }
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
        if (i.status !== 'pending' || !i.verifyCode) {
          throw fail(409, `invite_${i.status}`, `邀请状态：${i.status}`)
        }
        if (action === 'cancel' && i.direction === 'sent') {
          await remote(i.machine.address, `/lan/invitations/${id}/cancel`, {
            ...i.machine,
            body: { capability: i.capability }
          })
          i.status = 'cancelled'
        } else if (['accept', 'reject'].includes(action) && i.direction === 'incoming') {
          if (action === 'accept' && state.organization) {
            throw fail(409, 'already_in_organization', '请先退出当前组织')
          }
          const token = secret()
          const result = await remote(i.machine.address, `/lan/invitations/${id}/decision`, {
            ...i.machine,
            body: { capability: i.capability, accept: action === 'accept', token },
            timeout: 15000
          })
          if (action === 'accept') {
            if (!Array.isArray(result.peers) || !result.peers.every(validPeer)) {
              throw fail(502, 'invalid_peer', '成员凭据无效')
            }
            const inviter = result.peers.find((p) => p.id === i.machine.id)
            if (!inviter || inviter.fingerprint !== i.machine.fingerprint) {
              throw fail(403, 'tls_fingerprint_mismatch', '邀请方身份变化')
            }
            inviter.address = i.machine.address
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
          ...peers()
            .filter(validPeer)
            .map((p) => ({
              recipient: p.id,
              address: p.address,
              fingerprint: p.fingerprint,
              tlsPort: p.tlsPort,
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
          !validFingerprint(socketFingerprint(req.socket)) ||
          !validFingerprint(body.commitment) ||
          !validTlsPort(body.machine?.tlsPort) ||
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
            fingerprint: socketFingerprint(req.socket),
            tlsPort: body.machine.tlsPort,
            address: `${ip.includes(':') ? `[${ip}]` : ip}:${body.machine.port}`
          },
          organization: { id: body.organization.id, name: body.organization.name },
          capability: body.capability,
          commitment: body.commitment,
          nonce: secret(),
          expires: Math.min(body.expires, now() + ttl)
        }
        invitations.set(i.id, i)
        return { nonce: i.nonce }
      }
      const match = /^\/lan\/invitations\/([^/]+)\/(decision|cancel|verify)$/.exec(path)
      if (match) {
        return exclusive(async () => {
          const i = invitations.get(match[1])
          if (
            !i ||
            body.capability !== i.capability ||
            socketFingerprint(req.socket) !== i.machine.fingerprint
          ) {
            throw fail(401, 'unauthorized', '邀请凭据无效')
          }
          if (match[2] === 'verify' && i.direction === 'incoming') {
            if (
              i.status !== 'pending' ||
              !validFingerprint(body.nonce) ||
              nonceCommitment(body.nonce) !== i.commitment
            ) {
              throw fail(403, 'invalid_commitment', '确认码握手无效')
            }
            if (!i.verifyCode) {
              i.verifyCode = invitationCode(
                i.machine.fingerprint,
                identity().fingerprint,
                i.id,
                body.nonce,
                i.nonce
              )
              onInvite(publicInvite(i))
            }
            return { ok: true }
          }
          if (!i.verifyCode) {
            throw fail(403, 'verification_required', '请先完成确认码核对')
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
              ...identity(),
              address: '',
              inboundToken: body.token,
              outboundToken: i.token,
              pairedAt: added.pairedAt
            }
          ]
          for (const p of peers().filter(validPeer)) {
            const pair = { ...added, inboundToken: secret(), outboundToken: secret() }
            const delivery = {
              recipient: p.id,
              address: p.address,
              fingerprint: p.fingerprint,
              tlsPort: p.tlsPort,
              token: p.outboundToken,
              path: '/lan/organization/member',
              body: { organizationId: state.organization.id, peer: pair }
            }
            state.deliveries.push(delivery)
            persist()
            try {
              await remote(p.address, delivery.path, {
                ...p,
                token: delivery.token,
                body: delivery.body
              })
              state.deliveries = state.deliveries.filter((d) => d !== delivery)
              persist()
            } catch {}
            result.push({
              id: p.id,
              name: p.name,
              address: p.address,
              fingerprint: p.fingerprint,
              tlsPort: p.tlsPort,
              inboundToken: pair.outboundToken,
              outboundToken: pair.inboundToken,
              pairedAt: added.pairedAt
            })
          }
          replace([...peers().filter((p) => p.id !== added.id), added])
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
        .update(
          `${socketFingerprint(req.socket)}/${req.headers?.authorization ?? ''}/${body.organizationId}/${body.id}`
        )
        .digest('hex')
      if (path === '/lan/organization/remove' && state.receipts.includes(receipt)) {
        return { ok: true }
      }
      if (!authenticated) {
        throw fail(401, 'unauthorized', '需要组织成员令牌')
      }
      return exclusive(async () => {
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
