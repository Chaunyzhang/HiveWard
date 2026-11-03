import { createHash } from 'node:crypto'
import { validFingerprint, validTlsPort } from './lan-tls.mjs'

export const clean = (value) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 200
export const validPeer = (p) =>
  p &&
  clean(p.id) &&
  clean(p.name) &&
  clean(p.address) &&
  /^[a-f0-9]{64}$/.test(p.inboundToken) &&
  /^[a-f0-9]{64}$/.test(p.outboundToken) &&
  validFingerprint(p.fingerprint) &&
  validTlsPort(p.tlsPort)

export const validHelloMachine = (hello, machineId, expectedId) =>
  clean(hello.id) &&
  clean(hello.name) &&
  hello.id !== machineId &&
  (!expectedId || hello.id === expectedId)
export const validOrganizationSummary = (organization) =>
  clean(organization?.id) &&
  clean(organization?.name) &&
  Number.isInteger(organization?.members) &&
  organization.members >= 1

export const validInvitationBody = (body, kind, fingerprint, now) =>
  ['invite', 'request'].includes(kind) &&
  validFingerprint(fingerprint) &&
  validFingerprint(body.commitment) &&
  validTlsPort(body.machine?.tlsPort) &&
  clean(body.id) &&
  clean(body.machine?.id) &&
  clean(body.machine?.name) &&
  clean(body.machine?.user) &&
  clean(body.organization?.id) &&
  clean(body.organization?.name) &&
  /^[a-f0-9]{64}$/.test(body.capability) &&
  (kind !== 'request' || /^[a-f0-9]{64}$/.test(body.token)) &&
  Number.isInteger(body.machine.port) &&
  body.machine.port >= 1 &&
  body.machine.port <= 65535 &&
  Number.isFinite(body.expires) &&
  body.expires > now

export const memberCredentials = (machine, identity, i, token, pairedAt) => {
  const added = {
    ...i.machine,
    inboundToken: i.token,
    outboundToken: token,
    pairedAt
  }
  const result = [
    {
      ...machine,
      ...identity,
      address: '',
      inboundToken: token,
      outboundToken: i.token,
      pairedAt
    }
  ]
  return { added, result }
}

export function invitationCode(inviter, recipient, id, nonceA, nonceB) {
  const hash = createHash('sha256')
    .update(JSON.stringify(['hiveward-lan-sas-v1', inviter, recipient, id, nonceA, nonceB]))
    .digest()
  return (hash.readBigUInt64BE() % 1000000n).toString().padStart(6, '0')
}
export const nonceCommitment = (nonce) => createHash('sha256').update(nonce).digest('hex')

export const publicInvitation = (i) => ({
  id: i.id,
  kind: i.kind ?? 'invite',
  direction: i.direction,
  status: i.status,
  machine: i.machine,
  organization: i.organization,
  expiresAt: new Date(i.expires).toISOString(),
  verifyCode: i.verifyCode
})
