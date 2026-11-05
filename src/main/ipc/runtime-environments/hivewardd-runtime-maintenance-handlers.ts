import { ipcMain } from 'electron'
import { registerManagedServerActions } from '../../runtime/managed-server-actions-registry'
import {
  createManagedHivewarddActions,
  reclaimManagedHivewarddStaleLock,
  restartManagedHivewardd,
  type ManagedHivewarddActionOptions
} from './managed-hivewardd-actions'
import { requiredString } from './hivewardd-runtime-lifecycle-handlers'

export function registerHivewarddRuntimeMaintenanceHandlers(options: ManagedHivewarddActionOptions): void {
  const actions = createManagedHivewarddActions(options)
  // CLI runtime RPC uses these same managedServer actions.
  registerManagedServerActions(actions)
  ipcMain.handle(
    'runtimeEnvironments:updateHivewardd',
    async (
      _event,
      args: {
        selector: string
        force?: boolean
        pastLiveTerminals?: { incumbentVersion?: unknown }
      }
    ) => {
      const incumbentVersion = args?.pastLiveTerminals?.incumbentVersion
      const pastLiveTerminals =
        args?.pastLiveTerminals &&
        (typeof incumbentVersion === 'string' || incumbentVersion === null)
          ? { incumbentVersion }
          : undefined
      return actions.update(
        requiredString(args?.selector, 'Server'),
        args?.force === true,
        pastLiveTerminals
      )
    }
  )
  ipcMain.handle('runtimeEnvironments:rollbackHivewardd', async (_event, args: { selector: string }) =>
    actions.rollback(requiredString(args?.selector, 'Server'))
  )
  ipcMain.handle(
    'runtimeEnvironments:recoverHivewardd',
    async (_event, args: { selector: string; acceptChangedState?: boolean }) =>
      actions.recover(requiredString(args?.selector, 'Server'), args?.acceptChangedState === true)
  )
  ipcMain.handle('runtimeEnvironments:restartHivewardd', async (_event, args: { selector: string }) =>
    restartManagedHivewardd(options, requiredString(args?.selector, 'Server'))
  )
  ipcMain.handle(
    'runtimeEnvironments:reclaimHivewarddStaleLock',
    async (_event, args: { selector: string; yes?: boolean; expectNonce?: string }) =>
      reclaimManagedHivewarddStaleLock(
        options,
        requiredString(args?.selector, 'Server'),
        // A confirmation without the checked record's nonce could clear a lock written since.
        args?.yes === true
          ? { yes: true, expectNonce: requiredString(args.expectNonce, 'The checked lock') }
          : { yes: false }
      )
  )
  ipcMain.handle('runtimeEnvironments:stopHivewardd', async (_event, args: { selector: string }) =>
    actions.stop(requiredString(args?.selector, 'Server'))
  )
  ipcMain.handle(
    'runtimeEnvironments:cancelHivewarddStop',
    async (_event, args: { selector: string }) =>
      actions.cancelStop(requiredString(args?.selector, 'Server'))
  )
  ipcMain.handle('runtimeEnvironments:forgetHivewardd', async (_event, args: { selector: string }) =>
    actions.forget(requiredString(args?.selector, 'Server'))
  )
}
