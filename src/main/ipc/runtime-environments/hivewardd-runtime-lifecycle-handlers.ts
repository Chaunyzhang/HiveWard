import { ipcMain } from 'electron'
import type { HivewarddManagedRuntimeStatus } from '../../../shared/hivewardd-managed-runtime'
import { createManagedHivewarddEnvironment } from '../../managed-server/lifecycle/hivewardd-runtime-deployment'
import { getManagedHivewarddRuntimeStatus } from '../../managed-server/lifecycle/hivewardd-runtime-status'

export function registerHivewarddRuntimeLifecycleHandlers(options: {
  getUserDataPath: () => string
}): void {
  ipcMain.handle(
    'runtimeEnvironments:deployHivewardd',
    async (_event, args: { name: string; sshTargetId: string; force?: boolean }) =>
      createManagedHivewarddEnvironment(options.getUserDataPath(), {
        name: requiredString(args?.name, 'Server name'),
        sshTargetId: requiredString(args?.sshTargetId, 'SSH target'),
        force: args?.force === true
      })
  )
  ipcMain.handle(
    'runtimeEnvironments:getHivewarddStatus',
    (_event, args: { selector: string }): Promise<HivewarddManagedRuntimeStatus> =>
      getManagedHivewarddRuntimeStatus(
        options.getUserDataPath(),
        requiredString(args?.selector, 'Server')
      )
  )
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`)
  }
  return value.trim()
}
