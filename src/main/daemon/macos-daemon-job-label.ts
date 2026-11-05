import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { PROTOCOL_VERSION } from './daemon-protocol-version'

const NEW_LABEL_PREFIX = 'app.hiveward.terminal.'
// 旧后台还在跑，只能用于查找/接管，不能用于新启动。
const LEGACY_LABEL_PREFIX = 'local.opc.app.terminal.'

function jobLabel(prefix: string, userDataPath: string, protocolVersion: number): string {
  const profileKey = createHash('sha256').update(resolve(userDataPath)).digest('hex').slice(0, 16)
  return `${prefix}${profileKey}.v${protocolVersion}`
}

export function macDaemonJobLabel(
  userDataPath: string,
  protocolVersion = PROTOCOL_VERSION
): string {
  return jobLabel(NEW_LABEL_PREFIX, userDataPath, protocolVersion)
}

export function legacyMacDaemonJobLabel(
  userDataPath: string,
  protocolVersion = PROTOCOL_VERSION
): string {
  return jobLabel(LEGACY_LABEL_PREFIX, userDataPath, protocolVersion)
}
