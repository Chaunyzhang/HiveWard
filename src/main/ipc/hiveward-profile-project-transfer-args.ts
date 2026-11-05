import type { TransferHiveWardProfileProjectArgs } from '../../shared/hiveward-profiles'

export function transferProjectArgsFromUnknown(args: unknown): TransferHiveWardProfileProjectArgs {
  if (
    typeof args !== 'object' ||
    args === null ||
    !('sourceProfileId' in args) ||
    typeof args.sourceProfileId !== 'string' ||
    !('targetProfileId' in args) ||
    typeof args.targetProfileId !== 'string' ||
    !('repoId' in args) ||
    typeof args.repoId !== 'string' ||
    !('mode' in args) ||
    (args.mode !== 'move' && args.mode !== 'copy')
  ) {
    throw new Error('invalid_hiveward_profile_project_transfer')
  }
  const sourceProfileId = args.sourceProfileId.trim()
  const targetProfileId = args.targetProfileId.trim()
  const repoId = args.repoId.trim()
  if (!sourceProfileId || !targetProfileId || !repoId) {
    throw new Error('invalid_hiveward_profile_project_transfer')
  }
  return { sourceProfileId, targetProfileId, repoId, mode: args.mode }
}
