import { ensureWindowsAppDataPath } from './startup/windows-app-data-path'
import {
  migrateHiveWardLaunchAgentsAfterReady,
  prepareHiveWardProfiles
} from './startup/hiveward-profile-migration'
import { adoptHiveWardKeychainIdentity } from './startup/hiveward-keychain-migration'
import { app, clipboard, dialog, type BrowserWindow } from 'electron'
import { createMacAppActivationHandler } from './window/macos-app-activation'
import { isBackgroundLaunch, isHivewarddSidecarLaunch } from './window/foreground-activation-policy'
import { createDesktopHandoff, desktopHandoffArguments } from './window/macos-desktop-handoff'
import {
  focusExistingWindow as focusExistingWindowAction,
  setMainWindowOpener
} from './startup/main-window-actions'
import { openMainWindow as openMainWindowController } from './startup/main-window-controller'
import { mainProcessState as state } from './startup/main-process-state'
import { runMainProcessPreflight } from './startup/main-process-preflight'
import { runWslHolderUninstallPreflight } from './startup/wsl-holder-uninstall-preflight'
import { runAgentHooksUninstallPreflight } from './startup/agent-hooks-uninstall-preflight'
import { enableLinearRegexpFallback } from './startup/linear-regexp-fallback'
import { initializeMainProcessReady } from './startup/main-process-ready'
import { installMainProcessQuitHandlers } from './startup/main-process-quit'
import { shouldActivateDesktopForSecondInstance } from './startup/single-instance-lock'
import { resolveOsOpenedDocuments } from './startup/os-opened-documents'
import {
  formatProfileStateStartupFailure,
  isDivergedProfileStateFailure,
  profileStateStartupFailureClass
} from './persistence/profile-state/profile-state-startup-failure'
import { recordDurableCrashBreadcrumb } from './crash-reporting/durable-crash-breadcrumb'
import {
  chooseProfileStateCopy,
  chooseProfileStateRepair,
  presentProfileStateStartupRecoveryDialog,
  readProfileStateCopySavedTimes
} from './persistence/profile-state/profile-state-startup-recovery-dialog'
import { profileStateDesktopRecoveryArgs } from './startup/profile-state-recovery-preflight'
import { prepareEarlyMainUiLanguage, translateMain } from './i18n/main-i18n'
import { ProfileStateRecoveryRequiredError } from './persistence/profile-state/profile-state-recovery-required'
import { getProfileUserDataPath } from './hiveward-profiles/profile-storage-paths'
import { leaseAppImageGenerationForCurrentProcess } from './cli/appimage-generation-lease'
import { deleteLegacyWslHostWakeList } from './wsl/wsl-host-early-wake'
import { configureWslHostsGateFromDisk } from './wsl/wsl-host-gate-startup'
import { ignoreInheritedWslHostsGateState } from '../shared/wsl-host-internal-gate'
import {
  registerHiveWardProtocolClient,
  normalizeHiveWardProtocolUrl
} from './startup/hiveward-protocol-registration'
import { clearWindowsStdHandleInheritance } from './startup/windows-std-handle-inheritance'
import { installWindowsIsolatedSpawner } from './startup/windows-isolated-spawner'
import { dropE2eSpawnLogOutsideE2e } from './startup/e2e-spawn-log-env'

// Before anything spawns, so no daemon, PTY or agent inherits it outside e2e.
dropE2eSpawnLogOutsideE2e()

function openMainWindow(options: { revealOnDidFinishLoad?: boolean } = {}): BrowserWindow {
  return openMainWindowController(options)
}

setMainWindowOpener(openMainWindow)

function focusExistingWindow(): void {
  focusExistingWindowAction()
}

const requestDesktopHandoff = createDesktopHandoff({
  drainArguments: () => desktopHandoffArguments(state)
})

function requestDesktopActivation(argv: readonly string[] = []): void {
  state.osOpenedDocuments.capture(argv, publishOsOpenedDocuments)
  // Duplicate serve launches must not activate a desktop on a headless server (#11935).
  if (!shouldActivateDesktopForSecondInstance(argv)) {
    return
  }
  // The sidecar’s throwaway profile must never become the user’s window.
  if (isHivewarddSidecarLaunch()) {
    requestDesktopHandoff()
    return
  }
  state.desktopActivationGate?.requestActivation()
}

/** Buffer documents until listener readiness; webContents.send silently drops unhandled messages. */
function publishOsOpenedDocuments(): void {
  const targetWindow = state.mainWindow
  if (!state.osDocumentOpenListenerReady || !targetWindow || targetWindow.isDestroyed()) {
    return
  }
  // Consume before awaiting to prevent duplicate renderer pulls; restore if delivery fails.
  const filePaths = state.osOpenedDocuments.consume()
  if (filePaths.length === 0) {
    return
  }
  void resolveOsOpenedDocuments(filePaths)
    .then((documents) => {
      if (targetWindow.isDestroyed() || targetWindow.webContents.isDestroyed()) {
        state.osOpenedDocuments.restore(filePaths)
        return
      }
      if (documents.length > 0) {
        targetWindow.webContents.send('ui:openMarkdownFiles', documents)
      }
    })
    .catch((error) => {
      state.osOpenedDocuments.restore(filePaths)
      console.warn('[os-open] Failed to resolve OS-opened documents:', error)
    })
}

const handleMacAppActivation = createMacAppActivationHandler({
  getWindow: () => state.mainWindow,
  requestActivation: requestDesktopActivation
})

// Before anything spawns: no child may inherit HiveWard's std handles.
clearWindowsStdHandleInheritance()
installWindowsIsolatedSpawner()
// A relaunch or installer inherits the parent's published WSL gate state; this process recomputes.
ignoreInheritedWslHostsGateState()
// The uninstaller's holder release and hook removal run instead of the app, never alongside it.
app.on('open-url', (event, value) => {
  const url = normalizeHiveWardProtocolUrl(value)
  if (!url) {
    return
  }
  event.preventDefault()
  void app.whenReady().then(() => requestDesktopActivation([url]))
})

function startHiveWardMain(): void {
  ensureWindowsAppDataPath(app)
  try {
    // ready 前必须是同步的：资料目录要赶在 Chromium 落盘之前选好。
    prepareHiveWardProfiles(app)
  } catch (error) {
    console.error('[hiveward] profile preparation failed; continuing with default profile', error)
  }
  const preflightReady =
    !runWslHolderUninstallPreflight() &&
    !runAgentHooksUninstallPreflight() &&
    runMainProcessPreflight({
      focusExistingWindow,
      requestDesktopActivation
    })

  // Skip userData writes after losing the single-instance lock.
  if (preflightReady) {
    enableLinearRegexpFallback()
    void leaseAppImageGenerationForCurrentProcess()
    // Before any gate check: saved WSL work keeps a closed gate serving it.
    configureWslHostsGateFromDisk(app.getPath('userData'), app.getVersion())
    // A launch restore is passive (E9): it never boots a WSL host's distro, so drop the old wake list.
    if (process.platform === 'win32') {
      deleteLegacyWslHostWakeList(app.getPath('userData'))
    }
    // macOS can deliver Open With before ready; claim only supported paths.
    app.on('open-file', (event, filePath) => {
      if (!state.osOpenedDocuments.captureFilePaths([filePath], publishOsOpenedDocuments)) {
        return
      }
      event.preventDefault()
      // Cold-start activation must wait for Electron readiness; sidecars have no pending window.
      if (app.isReady() || isHivewarddSidecarLaunch()) {
        requestDesktopActivation()
      }
    })
    registerHiveWardProtocolClient(app, {
      platform: process.platform,
      desktopLaunch: !state.isServeMode && !isBackgroundLaunch() && !isHivewarddSidecarLaunch()
    })
    // The first renderer pulls on mount; nothing listens this early.
    state.osOpenedDocuments.capture(process.argv)
    installMainProcessQuitHandlers()
    void app.whenReady().then(async () => {
      // launchd 只决定后台服务怎么起，不影响 userData，放到 ready 后异步切换。
      void migrateHiveWardLaunchAgentsAfterReady()
      const keychain = await adoptHiveWardKeychainIdentity({
        platform: process.platform,
        dev: !app.isPackaged,
        execPath: process.execPath
      })
      if (keychain.use === 'legacy') {
        app.setName(keychain.appName)
        if (state.devInstanceIdentity) {
          state.devInstanceIdentity = { ...state.devInstanceIdentity, appName: keychain.appName }
        }
      }
      try {
        await initializeMainProcessReady({
          openMainWindow,
          handleMacAppActivation
        })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const message =
          formatProfileStateStartupFailure(error) ?? `HiveWard could not finish starting: ${detail}`
        const failureClass = profileStateStartupFailureClass(error)
        if (failureClass !== undefined) {
          recordDurableCrashBreadcrumb('profile_state_startup_failed', {
            failure_class: failureClass
          })
        }
        console.error(`[profile-state] ${message}`)
        if (!state.isServeMode && !isBackgroundLaunch()) {
          try {
            await prepareEarlyMainUiLanguage()
            const userDataPath = getProfileUserDataPath()
            if (isDivergedProfileStateFailure(error)) {
              const choice = await chooseProfileStateCopy({
                ...readProfileStateCopySavedTimes(userDataPath),
                showMessageBox: (options) => dialog.showMessageBox(options),
                translate: translateMain
              })
              if (choice !== undefined) {
                // Recovery needs both profile locks, which only a fresh process can own safely.
                app.relaunch({
                  args: profileStateDesktopRecoveryArgs(process.argv, {
                    userDataPath,
                    selector: { kind: choice }
                  })
                })
              }
              app.exit(1)
              return
            }
            if (
              error instanceof ProfileStateRecoveryRequiredError &&
              error.repairableSections !== undefined
            ) {
              const sections = error.repairableSections
              if (
                await chooseProfileStateRepair({
                  sections,
                  showMessageBox: (options) => dialog.showMessageBox(options),
                  translate: translateMain
                })
              ) {
                app.relaunch({
                  args: profileStateDesktopRecoveryArgs(process.argv, {
                    userDataPath,
                    profileId: error.profileId,
                    selector: {
                      kind: 'repair',
                      sections: sections.map(({ domain, backupId }) => ({ domain, backupId }))
                    }
                  })
                })
              }
              app.exit(1)
              return
            }
            await presentProfileStateStartupRecoveryDialog({
              message:
                formatProfileStateStartupFailure(error, translateMain) ??
                translateMain(
                  'startupFailure.finishFailed',
                  'HiveWard could not finish starting: {{detail}}',
                  { detail }
                ),
              ...(failureClass === 'recovery-required' || failureClass === 'ambiguous-authority'
                ? { recoveryCommand: 'hiveward profile state exports' }
                : {}),
              showMessageBox: (options) => dialog.showMessageBox(options),
              copyToClipboard: (text) => clipboard.writeText(text),
              translate: translateMain
            })
          } catch (dialogError) {
            console.warn('[profile-state] Recovery dialog failed; exiting safely:', dialogError)
          }
        }
        app.exit(1)
      }
    })
  }
}
try {
  startHiveWardMain()
} catch (error) {
  console.error('[hiveward] startup failed', error)
  app.exit(1)
}
