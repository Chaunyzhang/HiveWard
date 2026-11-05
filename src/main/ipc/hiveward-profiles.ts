import { ipcMain, type WebContents } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import { relaunchApp, type AppRelaunchReason } from '../app-relaunch'
import { quitProcess } from '../startup/process-quit-request'
import type {
  CreateLocalHiveWardProfileArgs,
  CreateLocalHiveWardProfileResult,
  FindHiveWardProfileProjectsByPathArgs,
  FindHiveWardProfileProjectsByPathResult,
  HiveWardProfileListResult,
  SwitchHiveWardProfileArgs,
  SwitchHiveWardProfileResult,
  TransferHiveWardProfileProjectArgs,
  TransferHiveWardProfileProjectResult
} from '../../shared/hiveward-profiles'
import {
  createLocalHiveWardProfile,
  getHiveWardProfileListState,
  setActiveHiveWardProfile
} from '../hiveward-profiles/profile-index-store'
import { getProfileUserDataPath } from '../hiveward-profiles/profile-storage-paths'
import { isMultiProfileUiEnabled } from '../hiveward-profiles/profile-ui-scope'
import { transferHiveWardProfileProject } from '../hiveward-profiles/profile-project-transfer'
import { transferActiveProfileProject } from '../hiveward-profiles/profile-active-transfer'
import { findHiveWardProfileProjectsByPath } from '../hiveward-profiles/profile-project-presence'
import {
  flushActiveProfileBeforeFileMutation,
  flushActiveProfileBeforeRelaunch
} from '../hiveward-profiles/profile-persistence-deadline'
import { normalizeExecutionHostId } from '../../shared/execution-host'
import { profileIdFromArgs } from './hiveward-profile-id-arg'
import { transferProjectArgsFromUnknown } from './hiveward-profile-project-transfer-args'

type RegisterHiveWardProfileHandlersOptions = {
  onBeforeRelaunch?: () => void | Promise<void>
  onAuthMutation?: () => void
  onBeforeSignOut?: () => void
  onAfterSignOut?: () => void
}

function findProjectsByPathArgsFromUnknown(args: unknown): FindHiveWardProfileProjectsByPathArgs {
  if (!args || typeof args !== 'object') {
    throw new Error('invalid_hiveward_profile_project_path')
  }
  const candidate = args as FindHiveWardProfileProjectsByPathArgs
  const path = typeof candidate.path === 'string' ? candidate.path.trim() : ''
  if (!path) {
    throw new Error('invalid_hiveward_profile_project_path')
  }
  let executionHostId: FindHiveWardProfileProjectsByPathArgs['executionHostId'] = null
  if (candidate.executionHostId !== null && candidate.executionHostId !== undefined) {
    if (typeof candidate.executionHostId !== 'string') {
      throw new Error('invalid_hiveward_profile_project_path')
    }
    executionHostId = normalizeExecutionHostId(candidate.executionHostId)
    if (!executionHostId) {
      throw new Error('invalid_hiveward_profile_project_path')
    }
  }
  return {
    path,
    connectionId:
      typeof candidate.connectionId === 'string' ? candidate.connectionId.trim() || null : null,
    executionHostId,
    excludeProfileId:
      typeof candidate.excludeProfileId === 'string'
        ? candidate.excludeProfileId.trim() || null
        : null
  }
}

async function runBeforeProfileRelaunch(
  onBeforeRelaunch?: () => void | Promise<void>
): Promise<void> {
  try {
    await onBeforeRelaunch?.()
  } catch (error) {
    console.warn(
      '[hiveward-profiles] Pre-relaunch cleanup failed; continuing profile switch:',
      error instanceof Error ? error.name : typeof error
    )
  }
}

type ProfileRelaunchReason = Extract<AppRelaunchReason, `profile-${string}`>

function scheduleProfileRelaunch(reason: ProfileRelaunchReason, sender: WebContents): void {
  if (!sender.isDestroyed()) {
    sender.send('app:restart-committed')
  }
  setTimeout(() => {
    relaunchApp(reason)
    // Normal quit preserves renderer scrollback, PTY teardown, stats flush and final daemon checkpoints.
    quitProcess()
  }, 150)
}

export function registerHiveWardProfileHandlers(
  store: Store,
  options: RegisterHiveWardProfileHandlersOptions = {}
): void {
  ipcMain.handle('hivewardProfiles:list', (): HiveWardProfileListResult => ({
    ...getHiveWardProfileListState(),
    multiProfileUi: isMultiProfileUiEnabled()
  }))

  ipcMain.handle(
    'hivewardProfiles:createLocal',
    (_event, args?: CreateLocalHiveWardProfileArgs): CreateLocalHiveWardProfileResult => {
      const result = createLocalHiveWardProfile(args)
      return result
    }
  )

  ipcMain.handle(
    'hivewardProfiles:switch',
    async (event, args: SwitchHiveWardProfileArgs): Promise<SwitchHiveWardProfileResult> => {
      const profileId = profileIdFromArgs(args)
      const current = getHiveWardProfileListState()
      if (profileId === current.activeProfileId) {
        return { status: 'already-active' }
      }

      // Flush the source profile before switching the startup index; keep its writer alive through relaunch cleanup.
      await flushActiveProfileBeforeRelaunch(store)
      setActiveHiveWardProfile(profileId)
      await runBeforeProfileRelaunch(options.onBeforeRelaunch)

      scheduleProfileRelaunch('profile-switch', event.sender)

      return { status: 'relaunching' }
    }
  )

  ipcMain.handle(
    'hivewardProfiles:transferProject',
    async (
      event,
      rawArgs: TransferHiveWardProfileProjectArgs
    ): Promise<TransferHiveWardProfileProjectResult> => {
      const args = transferProjectArgsFromUnknown(rawArgs)
      const current = getHiveWardProfileListState()
      if (args.targetProfileId === current.activeProfileId) {
        throw new Error('active_target_hiveward_profile_transfer_requires_relaunch')
      }
      if (args.mode === 'move' && args.sourceProfileId === current.activeProfileId) {
        // Finish transfer before relaunch side effects so validation failure cannot strand the app quitting.
        const result = await transferActiveProfileProject(
          args,
          getProfileUserDataPath(),
          store,
          async () => {
            await runBeforeProfileRelaunch(options.onBeforeRelaunch)
            scheduleProfileRelaunch('profile-transfer', event.sender)
          }
        )
        if (result.status === 'transferred') {
          await runBeforeProfileRelaunch(options.onBeforeRelaunch)
          try {
            setActiveHiveWardProfile(args.targetProfileId)
          } finally {
            // The source has already changed and its writer cannot resume.
            scheduleProfileRelaunch('profile-transfer', event.sender)
          }
          return { ...result, willRelaunch: true }
        }
        return result
      }
      if (args.sourceProfileId !== current.activeProfileId) {
        await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
        return transferHiveWardProfileProject(args, getProfileUserDataPath())
      }
      const maintenance = await flushActiveProfileBeforeFileMutation(store)
      try {
        return transferHiveWardProfileProject(args, getProfileUserDataPath())
      } finally {
        await maintenance.resume()
      }
    }
  )

  ipcMain.handle(
    'hivewardProfiles:findProjectProfiles',
    (_event, rawArgs: FindHiveWardProfileProjectsByPathArgs): FindHiveWardProfileProjectsByPathResult =>
      findHiveWardProfileProjectsByPath(
        findProjectsByPathArgsFromUnknown(rawArgs),
        getProfileUserDataPath()
      )
  )
}
