import type {
  TransferHiveWardProfileProjectArgs,
  TransferHiveWardProfileProjectResult
} from '../../shared/hiveward-profiles'
import type { Store } from '../persistence/loading-store/store'
import { transferHiveWardProfileProject } from './profile-project-transfer'
import { hasHiveWardProfileStateDatabase } from './profile-storage-paths'
import { profileHasPendingProjectMove } from './profile-project-move-intent'
import { flushActiveProfileBeforeFileMutation } from './profile-persistence-deadline'

/** Keep the active Store stopped until file mutation either succeeds or proves unchanged. */
export async function transferActiveProfileProject(
  args: TransferHiveWardProfileProjectArgs,
  userDataPath: string,
  store: Pick<Store, 'beginProfileMaintenance'>,
  reopenSource: () => Promise<void>
): Promise<TransferHiveWardProfileProjectResult> {
  const hadDatabase = hasHiveWardProfileStateDatabase(args.sourceProfileId, userDataPath)
  const pendingMove = profileHasPendingProjectMove(args.sourceProfileId, userDataPath)
  const maintenance = await flushActiveProfileBeforeFileMutation(store, { flush: !pendingMove })
  let result: TransferHiveWardProfileProjectResult
  try {
    if (profileHasPendingProjectMove(args.sourceProfileId, userDataPath)) {
      throw new Error('active_source_hiveward_profile_move_requires_recovery')
    }
    result = transferHiveWardProfileProject(args, userDataPath)
  } catch (error) {
    const needsRecovery =
      (!hadDatabase && hasHiveWardProfileStateDatabase(args.sourceProfileId, userDataPath)) ||
      profileHasPendingProjectMove(args.sourceProfileId, userDataPath)
    // Further writes would invalidate a retained move's recovery revision.
    await (needsRecovery ? reopenSource() : maintenance.resume())
    throw error
  }
  if (result.status !== 'transferred' || args.mode !== 'move') {
    await maintenance.resume()
  }
  return result
}
