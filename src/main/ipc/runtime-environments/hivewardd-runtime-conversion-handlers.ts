import { ipcMain } from 'electron'
import type {
  HivewarddManagedConversionResult,
  HivewarddManagedPendingMigrationRow
} from '../../../shared/hivewardd-managed-runtime'
import { listPendingManagedHivewarddMigrations } from '../../managed-server/lifecycle/hivewardd-managed-migration-status'
import { convertSshTargetToManagedHivewardd } from '../../managed-server/lifecycle/hivewardd-runtime-conversion'
import { conversionCollaborators } from '../../managed-server/lifecycle/hivewardd-runtime-conversion-wiring'
import { requiredString } from './hivewardd-runtime-lifecycle-handlers'

export function registerHivewarddRuntimeConversionHandlers(getUserDataPath: () => string): void {
  ipcMain.handle(
    'runtimeEnvironments:convertSshHostToManagedHivewardd',
    (
      _event,
      args: { sshTargetId: string; name: string }
    ): Promise<HivewarddManagedConversionResult> => {
      return convertSshTargetToManagedHivewardd(getUserDataPath(), {
        sshTargetId: requiredString(args?.sshTargetId, 'SSH target'),
        name: requiredString(args?.name, 'Server name'),
        ...conversionCollaborators()
      })
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:listPendingHivewarddMigrations',
    (): HivewarddManagedPendingMigrationRow[] => listPendingManagedHivewarddMigrations(getUserDataPath())
  )
}
