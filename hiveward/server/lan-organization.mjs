import {
  clean,
  invitationCode,
  INVITATION_PROTOCOL,
  memberCredentials,
  nonceCommitment,
  publicInvitation as publicInvite,
  validHelloMachine,
  validInvitationBody,
  validOrganizationSummary,
  validPeer
} from './lan-invitation-verification.mjs'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { userInfo } from 'node:os'
import { socketFingerprint, validFingerprint, validTlsPort } from './lan-tls.mjs'

const secret = () => randomBytes(32).toString('hex')
const fail = (status, code, message) => Object.assign(new Error(message), { status, code })
const ensure = (condition, status, code, message) => {
  if (!condition) {
    throw fail(status, code, message)
  }
}
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
  const defaultOrganization = () => ({ id: randomUUID(), name: `${machine.name}的组织` })
  if (!state.tlsVersion) {
    if (peers().some((p) => !validPeer(p))) {
      state.organization = null
      state.deliveries = []
      state.receipts = []
    }
    state.tlsVersion = 1
    persist()
  }
  if (!state.organization) {
    state.organization = defaultOrganization()
    persist()
  }
  const publicOrg = () => ({
    id: state.organization.id,
    name: state.organization.name,
    members: [
      machine.id,
      ...peers()
        .filter(validPeer)
        .map((p) => p.id)
    ]
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
    ensure(!busy, 409, 'organization_busy', '组织正在更新，请重试')
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
  async function acceptMember(i, token) {
    ensure(state.organization?.id === i.organization.id, 409, 'organization_changed', '组织已变更')
    const { added, result } = memberCredentials(
      machine,
      identity(),
      i,
      token,
      new Date(now()).toISOString()
    )
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
    result[0].address = 'observed:1'
    i.result = { peers: result }
    return i.result
  }
  const timer = setInterval(() => {
    expire()
    void deliver()
  }, 1000)
  timer.unref()
  function detach(id) {
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
  }
  async function remove(id) {
    const list = peers()
    if (id !== machine.id && !list.some((p) => p.id === id)) {
      throw fail(404, 'machine_not_paired', '电脑不在组织内')
    }
    detach(id)
    const body = { id, organizationId: state.organization?.id }
    state.revoked.push({ key: `${body.organizationId}/${id}`, at: now() })
    state.deliveries.push(
      ...list.filter(validPeer).map((p) => ({
        address: p.address,
        fingerprint: p.fingerprint,
        tlsPort: p.tlsPort,
        token: p.outboundToken,
        body
      }))
    )
    replace(id === machine.id ? [] : list.filter((p) => p.id !== id))
    state.organization = id === machine.id ? defaultOrganization() : state.organization
    persist()
    await deliver()
    return { ok: true, pending: state.deliveries.filter((d) => !d.path).length }
  }
  async function fetchHello(address, expectedId) {
    const hello = await remote(address, '/lan/hello')
    if (!validFingerprint(hello.fingerprint) || !validTlsPort(hello.tlsPort)) {
      throw fail(409, 'tls_rejoin_required', '对方需要升级 TLS 后重新加入')
    }
    if (!validHelloMachine(hello, machine.id, expectedId)) {
      throw fail(400, 'invalid_peer', '机器身份不符')
    }
    return hello
  }
  function pendingFor(id) {
    const pending = [...invitations.values()].filter(
      (item) => item.machine.id === id && item.status === 'pending'
    )
    const visible = pending.find((item) => item.verifyCode)
    ensure(visible || !pending.length, 409, 'invite_pending', '已有待处理邀请')
    return visible
  }
  async function start(address, expectedId, kind) {
    ensure(lanPort, 409, 'lan_disabled', '局域网服务未开启')
    expire()
    const hello = await fetchHello(address, expectedId)
    const request = kind === 'request'
    const organization = hello.organization
    if (request && !validOrganizationSummary(organization)) {
      throw fail(409, 'organization_unavailable', '对方组织信息无效')
    }
    if (request && state.organization?.id === organization.id) {
      throw fail(409, 'already_in_organization', '已在同一组织')
    }
    if (peers().some((p) => p.id === hello.id && validPeer(p))) {
      throw fail(409, 'already_member', '已是组织成员')
    }
    const existing = pendingFor(hello.id)
    if (existing) {
      return publicInvite(existing)
    }
    const i = {
      id: randomUUID(),
      kind,
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
      organization: request ? { id: organization.id, name: organization.name } : publicOrg(),
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
        verificationProtocol: INVITATION_PROTOCOL,
        organization: i.organization,
        expires: i.expires,
        capability: i.capability,
        ...(request ? { kind, token: i.token } : {})
      }
    })
    ensure(validFingerprint(response.nonce), 400, 'invalid_nonce', '邀请随机数无效')
    i.verificationProtocol = INVITATION_PROTOCOL
    i.verifyCode = invitationCode(
      request ? hello.fingerprint : identity().fingerprint,
      request ? identity().fingerprint : hello.fingerprint,
      i.id,
      request ? response.nonce : i.nonce,
      request ? i.nonce : response.nonce,
      i.verificationProtocol
    )
    await remote(address, `/lan/invitations/${i.id}/verify`, {
      ...i.machine,
      body: { capability: i.capability, nonce: i.nonce }
    })
    invitations.set(i.id, i)
    return publicInvite(i)
  }
  const decide = (i, body) =>
    remote(i.machine.address, `/lan/invitations/${i.id}/decision`, {
      ...i.machine,
      body,
      timeout: 15000
    })
  async function install(i, list, leave = false) {
    ensure(Array.isArray(list) && list.every(validPeer), 502, 'invalid_peer', '成员凭据无效')
    const inviter = list.find((p) => p.id === i.machine.id)
    if (!inviter || inviter.fingerprint !== i.machine.fingerprint) {
      throw fail(403, 'tls_fingerprint_mismatch', '邀请方身份变化')
    }
    inviter.address = i.machine.address
    if (leave) {
      await remove(machine.id)
    }
    replace(list)
    state.organization = { id: i.organization.id, name: i.organization.name }
    persist()
  }
  return {
    close: () => clearInterval(timer),
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
    summary() {
      const { id, name, members } = publicOrg()
      return { id, name, members: members.length }
    },
    invite: (address, expectedId) => exclusive(() => start(address, expectedId, 'invite')),
    requestJoin: (address, expectedId) => exclusive(() => start(address, expectedId, 'request')),
    async action(id, action) {
      return exclusive(async () => {
        expire()
        const i = invitations.get(id)
        ensure(i, 404, 'invite_not_found', '邀请不存在')
        const retry =
          i.kind === 'request' &&
          i.direction === 'incoming' &&
          action === 'accept' &&
          i.status === 'accepted' &&
          i.result
        if ((i.status !== 'pending' && !retry) || !i.verifyCode) {
          throw fail(409, `invite_${i.status}`, `邀请状态：${i.status}`)
        }
        if (action === 'cancel' && i.direction === 'sent') {
          await remote(i.machine.address, `/lan/invitations/${id}/cancel`, {
            ...i.machine,
            body: { capability: i.capability }
          })
          i.status = 'cancelled'
        } else if (['accept', 'reject'].includes(action) && i.direction === 'incoming') {
          if (i.kind === 'request') {
            if (action === 'accept') {
              i.result ??= await acceptMember(i, i.joinToken)
            }
            await decide(i, {
              capability: i.capability,
              accept: action === 'accept',
              ...(action === 'accept' ? { peers: i.result.peers } : {})
            })
          } else {
            if (action === 'accept' && peers().some(validPeer)) {
              throw fail(409, 'already_in_organization', '请先退出当前组织')
            }
            const token = secret()
            const result = await decide(i, {
              capability: i.capability,
              accept: action === 'accept',
              token
            })
            if (action === 'accept') {
              await install(i, result.peers)
            }
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
        ensure(state.organization && clean(name), 400, 'bad_request', '组织不存在或名字无效')
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
        ensure(arrivals.length < 5, 429, 'invite_rate_limited', '邀请过于频繁，请稍后重试')
        arrivals.push(now())
        const kind = body.kind ?? 'invite'
        if (!validInvitationBody(body, kind, socketFingerprint(req.socket), now())) {
          throw fail(400, 'bad_request', '无效邀请')
        }
        if (kind === 'invite' && peers().some(validPeer)) {
          throw fail(409, 'already_in_organization', '对方已加入组织')
        }
        if (kind === 'request' && state.organization?.id !== body.organization.id) {
          throw fail(409, 'organization_changed', '组织身份不符')
        }
        if (kind === 'request' && peers().some((p) => p.id === body.machine.id && validPeer(p))) {
          throw fail(409, 'already_member', '已是组织成员')
        }
        ensure(!invitations.has(body.id), 409, 'invite_exists', '邀请已存在')
        const ip = req.socket.remoteAddress.replace(/^::ffff:/, '')
        const i = {
          id: body.id,
          kind,
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
          organization:
            kind === 'request'
              ? { id: state.organization.id, name: state.organization.name }
              : { id: body.organization.id, name: body.organization.name },
          capability: body.capability,
          commitment: body.commitment,
          verificationProtocol: INVITATION_PROTOCOL,
          nonce: secret(),
          ...(kind === 'request' ? { joinToken: body.token, token: secret() } : {}),
          expires: Math.min(body.expires, now() + ttl)
        }
        invitations.set(i.id, i)
        return { nonce: i.nonce, verificationProtocol: i.verificationProtocol }
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
                i.kind === 'request' ? identity().fingerprint : i.machine.fingerprint,
                i.kind === 'request' ? i.machine.fingerprint : identity().fingerprint,
                i.id,
                i.kind === 'request' ? i.nonce : body.nonce,
                i.kind === 'request' ? body.nonce : i.nonce,
                i.verificationProtocol
              )
              onInvite(publicInvite(i))
            }
            return { ok: true }
          }
          ensure(i.verifyCode, 403, 'verification_required', '请先完成确认码核对')
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
          ensure(i.status === 'pending', 409, `invite_${i.status}`, `邀请状态：${i.status}`)
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
          ensure(body.accept === true, 400, 'bad_request', '无效决定')
          if (i.kind === 'request') {
            await install(i, body.peers, true)
            i.status = 'accepted'
            i.result = { ok: true }
            return i.result
          }
          ensure(/^[a-f0-9]{64}$/.test(body.token), 400, 'bad_request', '无效决定')
          return acceptMember(i, body.token)
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
      ensure(authenticated, 401, 'unauthorized', '需要组织成员令牌')
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
          detach(body.id)
          replace(body.id === machine.id ? [] : peers().filter((p) => p.id !== body.id))
          state.organization = body.id === machine.id ? defaultOrganization() : state.organization
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
