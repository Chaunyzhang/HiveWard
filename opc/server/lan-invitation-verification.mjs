import { createHash } from 'node:crypto'

export function invitationCode(inviter, recipient, id, nonceA, nonceB) {
  const hash = createHash('sha256')
    .update(JSON.stringify(['hiveward-lan-sas-v1', inviter, recipient, id, nonceA, nonceB]))
    .digest()
  return (hash.readBigUInt64BE() % 1000000n).toString().padStart(6, '0')
}
export const nonceCommitment = (nonce) => createHash('sha256').update(nonce).digest('hex')

export const publicInvitation = (i) => ({
  id: i.id,
  direction: i.direction,
  status: i.status,
  machine: i.machine,
  organization: i.organization,
  expiresAt: new Date(i.expires).toISOString(),
  verifyCode: i.verifyCode
})
