import { app } from 'electron'
import { resolveAppImageRuntimeIdentity } from '../appimage-runtime-identity'
import { prepareAppImageCopyForServe } from '../cli/appimage-serve-preparation'
import { CliInstaller } from '../cli/cli-installer'
import { installLinuxBareHivewarddispatcher } from '../cli/linux-bare-hiveward-dispatcher'

/** Headless serve has no renderer to run the normal cli:install flow, so it registers here. */
export async function registerCliForHeadlessServe(): Promise<void> {
  // Windows registry PATH installation cannot fix this server's existing child environments.
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return
  }
  const appImagePath =
    process.platform === 'linux' ? (resolveAppImageRuntimeIdentity()?.appImagePath ?? null) : null
  let appImageDeadlineAt: number | undefined
  if (appImagePath) {
    // Share one bounded AppImage extraction across CLI install/dispatcher and report progress.
    const preparation = await prepareAppImageCopyForServe({ appImagePath })
    if (preparation.status === 'unavailable') {
      console.warn(`[serve] hiveward CLI install skipped: ${preparation.reason}`)
      return
    }
    appImageDeadlineAt = preparation.deadlineAt
  }
  try {
    // Headless serve cannot answer osascript elevation; user-local CLI installation needs none.
    const cliStatus = await new CliInstaller({
      privilegedRunner: async () => {
        throw new Error('serve CLI auto-install must not request administrator privileges')
      },
      ...(appImageDeadlineAt === undefined ? {} : { appImageDeadlineAt })
    }).install()
    console.log(
      `[serve] hiveward CLI install: ${cliStatus.state}${cliStatus.commandPath ? ` (${cliStatus.commandPath})` : ''}`
    )
  } catch (error) {
    console.warn(
      '[serve] hiveward CLI install skipped:',
      error instanceof Error ? error.message : String(error)
    )
  }
  // Linux installs hiveward-ide; Claude Team invokes bare hiveward, requiring a best-effort user-local dispatcher.
  if (process.platform === 'linux' && app.isPackaged && process.resourcesPath) {
    try {
      const dispatcher = await installLinuxBareHivewarddispatcher({
        resourcesPath: process.resourcesPath,
        ...(appImageDeadlineAt === undefined ? {} : { appImageDeadlineAt })
      })
      console.log(
        `[serve] bare hiveward dispatcher ${dispatcher.state}: ${dispatcher.dispatcherPath}` +
          `${dispatcher.target ? ` -> ${dispatcher.target}` : ''}`
      )
    } catch (error) {
      console.warn(
        '[serve] bare hiveward dispatcher install skipped:',
        error instanceof Error ? error.message : String(error)
      )
    }
  }
}
