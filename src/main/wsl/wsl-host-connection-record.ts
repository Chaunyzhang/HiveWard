import { refreshWslHostPairing } from '../../shared/runtime-environment-wsl-host-store'
import {
  readWslHostDeployments,
  type WslHostDeploymentRecord
} from '../../shared/wsl-host-deployment-store'
import {
  wslHostStatusDetailText,
  type WslHostCopyParams,
  type WslHostStatusDetailCode
} from '../../shared/wsl-host-failure-copy'
import type { WslHostStatus } from '../../shared/wsl-host-types'
import type { WslHivewarddConnection } from './wsl-hivewardd-connection'
import type { WslHivewarddConnectionStatus } from './wsl-hivewardd-connection-status'
import type { WslLivenessUnverifiableReason } from './wsl-hivewardd-liveness-verdict'

/** Saves an explicit re-pair or a moved bridge; true when the pairing changed. */
export function persistWslHostConnection(
  userDataPath: string,
  record: WslHostDeploymentRecord,
  connection: WslHivewarddConnection
): boolean {
  try {
    return refreshWslHostPairing(userDataPath, record.environmentId, {
      pairingCode: connection.pairingOffer,
      localPort: connection.localPort,
      remotePort: connection.remotePort
    }).pairingChanged
  } catch (error) {
    console.warn(`[wsl-hosts] Could not save the new pairing for ${record.distro}:`, error)
    return false
  }
}

/** Saves the host's live connection's pairing and ports; transports on a changed pairing retire. */
export function saveWslHostConnection(
  deps: { userDataPath: () => string; pairingChanged: (environmentId: string) => void },
  record: WslHostDeploymentRecord | null,
  connections: { get(distro: string): WslHivewarddConnection | null } | null
): void {
  const connection = record ? connections?.get(record.distro) : null
  if (record && connection && persistWslHostConnection(deps.userDataPath(), record, connection)) {
    deps.pairingChanged(record.environmentId)
  }
}

export function toWslHostStatus(
  record: WslHostDeploymentRecord,
  status: WslHivewarddConnectionStatus,
  connection: WslHivewarddConnection | null = null
): WslHostStatus {
  return {
    environmentId: record.environmentId,
    distro: record.distro,
    state: status.state,
    ...wslHostStatusDetail(record, status),
    // Ready serves the incumbent; deferred serves nothing, so retain its Update/Force explanation.
    deferredUpdate:
      status.state === 'ready'
        ? (connection?.deferredUpdate ?? null)
        : status.state === 'failed'
          ? (status.deferredUpdate ?? null)
          : null,
    ...(record.pendingStop ? { removalPending: true } : {})
  }
}

const UNVERIFIABLE_DETAIL_CODES: Record<WslLivenessUnverifiableReason, WslHostStatusDetailCode> = {
  'running-list-unavailable': 'runningListUnavailable',
  'guest-unanswered': 'guestUnanswered',
  'hivewardd-unanswered': 'hivewarddUnanswered'
}

type WslHostStatusDetail = Pick<WslHostStatus, 'detail' | 'detailCode' | 'detailParams'>

function codedDetail(
  detail: string,
  code: string | undefined,
  params: WslHostCopyParams | undefined
): WslHostStatusDetail {
  return {
    detail,
    ...(code ? { detailCode: code } : {}),
    ...(code && params ? { detailParams: params } : {})
  }
}

function wslHostStatusDetail(
  record: WslHostDeploymentRecord,
  status: WslHivewarddConnectionStatus
): WslHostStatusDetail {
  if (status.state === 'unverifiable') {
    const { text, code } = wslHostStatusDetailText(UNVERIFIABLE_DETAIL_CODES[status.reason])
    return { detail: text, detailCode: code }
  }
  if (status.state === 'failed') {
    return codedDetail(status.reason, status.reasonCode, status.reasonParams)
  }
  const stop = record.pendingStop
  return stop ? codedDetail(stop.reason, stop.reasonCode, stop.reasonParams) : { detail: null }
}

/** The registered WSL hosts; an unreadable store reads as none rather than failing the caller. */
export function readWslHostRecordsQuietly(userDataPath: string): WslHostDeploymentRecord[] {
  try {
    return readWslHostDeployments(userDataPath).deployments
  } catch (error) {
    console.warn('[wsl-hosts] Could not read WSL host records:', error)
    return []
  }
}
