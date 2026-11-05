import process from 'node:process'
import { profileStateAccessMachineIdentity } from '../persistence/profile-state/profile-state-access-identity'
import { readHivewarddProcessIncarnation } from './hivewardd-process-start-time'
import { HivewarddInstanceLockError } from './hivewardd-data-root-privacy'
import { hivewarddCloneMachineHint, hivewarddPeerIsLiveCloneMachine } from './hivewardd-lock-clone-machine'
import {
  hivewarddStaleLockReclaimCommand,
  type HivewarddReclaimHintRuntime
} from '../../shared/hivewardd-stale-lock-reclaim'

/** Match machine identity, then legacy boot identity; identity-less records require local-only storage. */
export function hivewarddLockHolderLocality(
  holder: HivewarddPeerMachine,
  self: HivewarddPeerMachine,
  dataRootIsOnLocalDisk: () => boolean,
  platform: NodeJS.Platform = process.platform
): 'local' | 'foreign' | 'unknown' {
  if (holder.machineIdentity && self.machineIdentity) {
    if (holder.machineIdentity !== self.machineIdentity) {
      return 'foreign'
    }
    return hivewarddPeerIsLiveCloneMachine(holder, self, dataRootIsOnLocalDisk, platform)
      ? 'unknown'
      : 'local'
  }
  if (holder.bootId && holder.bootId === self.bootId) {
    return 'local'
  }
  return dataRootIsOnLocalDisk() ? 'local' : 'unknown'
}

export type HivewarddPeerMachine = {
  machineIdentity?: string
  bootId?: string
  /** Latest of the record's own timestamp and its heartbeat mtime. */
  writtenAtMs?: number
  bootStartedAtMs?: number
  nowMs?: number
}

export function currentHivewarddPeerMachine(): HivewarddPeerMachine {
  const machineIdentity = profileStateAccessMachineIdentity()
  const bootId = readHivewarddProcessIncarnation(process.pid)?.bootId
  return { ...(machineIdentity ? { machineIdentity } : {}), ...(bootId ? { bootId } : {}) }
}

/** PIDs require a provable machine and boot match; unknown peers are never assumed exited. */
export function hivewarddPeerPidIsJudgeableHere(
  peer: HivewarddPeerMachine,
  self: HivewarddPeerMachine,
  dataRootIsOnLocalDisk: () => boolean
): boolean {
  if (peer.bootId && self.bootId && peer.bootId !== self.bootId) {
    return false
  }
  return hivewarddLockHolderLocality(peer, self, dataRootIsOnLocalDisk) === 'local'
}

export function hivewarddLockHolderUnverifiableError(lock: {
  holder: string
  foreign: boolean
  /** The holder runs on another machine that reports this machine-id. */
  cloneMachine?: { role: 'hivewardd' | 'desktop' }
  dataRoot: string
  lockPath: string
  /** Managed hosts may lack launchers on PATH, so name this runtime/entry in reclaim hints. */
  hintRuntime: HivewarddReclaimHintRuntime | null
}): HivewarddInstanceLockError {
  const command = hivewarddStaleLockReclaimCommand(lock.dataRoot, lock.hintRuntime)
  const reclaim =
    process.platform === 'linux'
      ? `run \`${command}\` on the machine it ran on to check and clear it, or `
      : ''
  const cloneHint = lock.cloneMachine ? ` ${hivewarddCloneMachineHint(lock.cloneMachine.role)}` : ''
  return new HivewarddInstanceLockError(
    'hivewardd_instance_lock_holder_unverifiable',
    `${lock.holder} holds the data root ${lock.dataRoot}${lock.foreign || lock.cloneMachine ? ' from another machine' : ''}. ` +
      'HiveWard cannot check from here whether it is still running, because this data root may be ' +
      `shared with other machines. Stop it there. If it is not running anywhere, ${reclaim}` +
      `delete ${lock.lockPath} once you are sure.${cloneHint}`
  )
}
