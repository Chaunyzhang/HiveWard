import { join } from 'node:path'
import { hashHivewarddLauncher } from '../../shared/hivewardd-build-identity'
import { HIVEWARDD_LAUNCHER_FILENAME } from '../../shared/hivewardd-artifacts'

export function computeLocalHivewarddBuildHash(localHivewarddDir: string): string {
  return hashHivewarddLauncher(join(localHivewarddDir, HIVEWARDD_LAUNCHER_FILENAME))
}
