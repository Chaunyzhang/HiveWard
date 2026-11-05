import { createHash } from 'node:crypto'
import type { PairedRuntimeConnection } from '../../shared/paired-runtime-connection'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { BrowserClientPageAuthorityIdentity } from './browser-client-page-command-executor-dependencies'

export function derivePairedRuntimeBrowserAuthorityIdentity(input: {
  hivewardProfileId: string
  environment: Pick<KnownRuntimeEnvironment, 'id' | 'hivewarddDeployment'>
  pairingRevision: number
  authorityRuntimeId: string
  connection: PairedRuntimeConnection
}): BrowserClientPageAuthorityIdentity {
  const { hivewardProfileId, environment, pairingRevision, connection } = input
  const pairingIdentity = pairingAuthorityConnectionIdentity(
    hivewardProfileId,
    environment.id,
    pairingRevision,
    connection
  )
  return {
    // Managed SSH/WSL deployments re-pair in place, so cookie storage must outlive pairing revisions.
    authorityConnectionIdentity: environment.hivewarddDeployment
      ? deployedAuthorityConnectionIdentity(hivewardProfileId, environment.id, connection)
      : pairingIdentity,
    pairingAuthorityConnectionIdentity: pairingIdentity,
    legacyAuthorityConnectionIdentity: legacyAuthorityConnectionIdentity(
      hivewardProfileId,
      environment.id,
      pairingRevision,
      input.authorityRuntimeId,
      connection
    )
  }
}

// Exclude the per-process authorityRuntimeId so remote restarts preserve cookies.
function pairingAuthorityConnectionIdentity(
  hivewardProfileId: string,
  environmentId: string,
  pairingRevision: number,
  connection: PairedRuntimeConnection
): string {
  return connectionIdentityDigest([
    'paired-runtime-browser',
    hivewardProfileId,
    environmentId,
    pairingRevision,
    connection.hostPublicKeyB64,
    connection.pairedDeviceId ?? null
  ])
}

// Re-pairing rotates device ids and revisions; the server key still isolates cookie storage.
function deployedAuthorityConnectionIdentity(
  hivewardProfileId: string,
  environmentId: string,
  connection: PairedRuntimeConnection
): string {
  return connectionIdentityDigest([
    'paired-runtime-browser-deployed',
    hivewardProfileId,
    environmentId,
    connection.hostPublicKeyB64
  ])
}

/** Superseded per-process identity, kept only so its partition can be adopted. */
function legacyAuthorityConnectionIdentity(
  hivewardProfileId: string,
  environmentId: string,
  pairingRevision: number,
  authorityRuntimeId: string,
  connection: PairedRuntimeConnection
): string {
  return connectionIdentityDigest([
    'paired-runtime-browser',
    hivewardProfileId,
    environmentId,
    pairingRevision,
    authorityRuntimeId,
    connection.hostPublicKeyB64,
    connection.pairedDeviceId ?? null
  ])
}

function connectionIdentityDigest(components: readonly unknown[]): string {
  return `paired-runtime:${createHash('sha256').update(JSON.stringify(components)).digest('hex')}`
}
