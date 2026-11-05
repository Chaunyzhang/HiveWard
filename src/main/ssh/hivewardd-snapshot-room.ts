/** Check snapshot room before stopping a serving incumbent (#30491). */
import { hivewarddRemoteBaseDir } from '../managed-server/install/hivewardd-remote-windows-node'
import { execHivewarddRemoteOr } from '../managed-server/install/hivewardd-remote-runtime-control'
import {
  HIVEWARDD_STATE_SNAPSHOT_DIR,
  type HivewarddActivationRecord
} from '../managed-server/activation/hivewardd-activation-record'
import {
  hivewarddSnapshotShortfallKb,
  hivewarddSnapshotShortfallMessage,
  hivewarddSnapshotSpaceCommand,
  parseHivewarddSnapshotSpace
} from '../managed-server/host-state/hivewardd-state-snapshot-space'
import { joinRemotePath } from './ssh-remote-platform'
import { isUnconfirmedSshCommandTermination } from './remote-exec/remote-exec-command'
import type { HivewarddSlotOptions } from './hivewardd-recovery-slot'

export const HIVEWARDD_SNAPSHOT_SPACE_INSUFFICIENT_CODE = 'hivewardd_snapshot_space_insufficient'

export function hivewarddSnapshotsRoot(options: Pick<HivewarddSlotOptions, 'host' | 'remoteHome'>): string {
  return joinRemotePath(
    options.host,
    hivewarddRemoteBaseDir(options.host, options.remoteHome),
    HIVEWARDD_STATE_SNAPSHOT_DIR
  )
}

/** Unknown room proceeds to authoritative capture; return a refusal only for proven insufficient space. */
export async function hivewarddSnapshotRoomRefusal(
  options: HivewarddSlotOptions,
  record: HivewarddActivationRecord,
  fullVersion: string
): Promise<string | null> {
  const baseDir = hivewarddRemoteBaseDir(options.host, options.remoteHome)
  const command = hivewarddSnapshotSpaceCommand(
    options.host,
    options.userDataDir,
    hivewarddSnapshotsRoot(options),
    baseDir,
    record.snapshot ? [record.snapshot.dirName] : []
  )
  if (!command) {
    return null
  }
  const space = parseHivewarddSnapshotSpace(await measureRoom(options, command))
  const shortfall = hivewarddSnapshotShortfallKb(space)
  return space && shortfall !== null
    ? hivewarddSnapshotShortfallMessage(space, shortfall, {
        userDataDir: options.userDataDir,
        baseDir,
        fullVersion,
        active: record.active
      })
    : null
}

async function measureRoom(options: HivewarddSlotOptions, command: string): Promise<string> {
  try {
    return await execHivewarddRemoteOr(options, command)
  } catch (error) {
    // Unconfirmed read-only cleanup leaves room unknown; capture decides, unless caller cancelled.
    if (isUnconfirmedSshCommandTermination(error) && !options.signal?.aborted) {
      return ''
    }
    throw error
  }
}
