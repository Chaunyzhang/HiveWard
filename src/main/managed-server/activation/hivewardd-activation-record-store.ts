import { identifyLegacyHiveWardRecord } from './legacy-hiveward-host-identity'
import { HIVEWARDD_SERVER_ENTRY_FILENAME } from '../../../shared/hivewardd-artifacts'
import { HIVEWARDD_INSTALL_MODEL, remoteInstallDirName } from '../install/remote-install-model'
// Unreadable activation records must fail closed; treating them as absent could overwrite a live install and its rollback target.
import type { HivewarddHostTransport } from '../../ssh/hivewardd-host-transport'
import { RELAY_REMOTE_DIR } from '../../ssh/remote-exec/remote-frame-protocol'
import {
  HIVEWARDD_ACTIVATION_FILENAME,
  emptyHivewarddActivationRecord,
  parseHivewarddActivationRecord,
  serializeHivewarddActivationRecord,
  type HivewarddActivationReadResult,
  type HivewarddActivationRecord
} from './hivewardd-activation-record'
import { joinRemotePath, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import {
  readBoundedHivewarddRemoteRecord,
  writeAtomicHivewarddRemoteRecord
} from '../install/hivewardd-remote-record-file'

const HIVEWARDD_ACTIVATION_RECORD_MAX_BYTES = 64 * 1024

type ActivationRecordTarget = {
  conn: HivewarddHostTransport
  host: RemoteHostPlatform
  remoteHome: string
  signal?: AbortSignal
}

export function hivewarddActivationPath(host: RemoteHostPlatform, remoteHome: string): string {
  return joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR, HIVEWARDD_ACTIVATION_FILENAME)
}

async function readActivationRecordState(
  options: ActivationRecordTarget
): Promise<HivewarddActivationReadResult> {
  const read = await readBoundedHivewarddRemoteRecord(
    options,
    hivewarddActivationPath(options.host, options.remoteHome),
    HIVEWARDD_ACTIVATION_RECORD_MAX_BYTES
  )
  return read.state === 'absent' ? read : parseHivewarddActivationRecord(read.raw)
}

export async function readHivewarddActivationRecord(
  options: ActivationRecordTarget
): Promise<HivewarddActivationRecord> {
  const parsed = await readActivationRecordState(options)
  if (parsed.state === 'ok') {
    return identifyLegacyHiveWardRecord(parsed.record, async (version) => {
      const path = joinRemotePath(
        options.host,
        options.remoteHome,
        RELAY_REMOTE_DIR,
        remoteInstallDirName(HIVEWARDD_INSTALL_MODEL, version),
        HIVEWARDD_SERVER_ENTRY_FILENAME
      )
      const bundle = await readBoundedHivewarddRemoteRecord(options, path, 32 * 1024 * 1024)
      if (bundle.state === 'absent') {
        return ''
      }
      return bundle.raw
    })
  }
  if (parsed.state === 'unreadable') {
    throw new Error(`Cannot read this host's hivewardd activation record: ${parsed.reason}`)
  }
  return emptyHivewarddActivationRecord()
}

/** Refuse replacement of unreadable records, including schemas written by newer clients. */
export async function writeHivewarddActivationRecord(
  options: ActivationRecordTarget,
  record: HivewarddActivationRecord
): Promise<void> {
  const existing = await readActivationRecordState(options)
  if (existing.state === 'unreadable') {
    throw new Error(`Refusing to overwrite this host's hivewardd activation record: ${existing.reason}`)
  }
  await writeAtomicHivewarddRemoteRecord(
    options,
    hivewarddActivationPath(options.host, options.remoteHome),
    serializeHivewarddActivationRecord(record)
  )
}
