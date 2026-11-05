import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { HIVEWARDD_CLI_PACKAGE_FILENAME } from '../../shared/hivewardd-artifacts'
import { setAppEnvironment, type AppEnvironment } from '../../shared/app-environment'
import { setSecretStore } from '../../shared/secret-store'
import { resolveHivewarddInstallRoot, resolveHivewarddPath } from './hivewardd-app-paths'
import { getHivewarddCliLauncherPath } from './hivewardd-cli-launcher'
import { createHivewarddSecretStore, type HivewarddSecretStore } from './hivewardd-secret-store'
import { setSpeechServiceFactories } from '../speech/speech-runtime-service'
import { hivewarddSpeechServiceFactories } from './hivewardd-speech-services'

let quitRegisteredHandlers = (): void => {}

export function runHivewarddQuitHandlers(): void {
  quitRegisteredHandlers()
}

function createNodeAppEnvironment(): AppEnvironment {
  const quitHandlers: (() => void)[] = []
  // Synchronous quit handlers must not preempt the signal handler’s awaited runtime/browser teardown.
  quitRegisteredHandlers = (): void => {
    const errors: unknown[] = []
    for (const handler of quitHandlers.splice(0)) {
      try {
        handler()
      } catch (error) {
        errors.push(error)
      }
    }
    // Failed handlers may leave writers running and keep the instance lock held.
    if (errors.length > 0) {
      throw new AggregateError(errors, 'hivewardd_quit_handlers_failed')
    }
  }
  return {
    getPath: resolveHivewarddPath,
    getAppPath: () => resolveHivewarddInstallRoot(),
    getVersion: () => process.env.HIVEWARD_VERSION ?? '0.0.0-hivewardd',
    // Packaged gates production HTTPS/CLI/PATH policy; layout callers must inspect asar separately.
    isPackaged: () => true,
    getCliLauncherPath: getHivewarddCliLauncherPath,
    onWillQuit: (handler) => quitHandlers.push(handler),
    exit: (code = 0) => process.exit(code),
    getAppMetrics: () => []
  }
}

let hivewarddSecretStore: HivewarddSecretStore | null = null

export async function prepareHivewarddSecretStore(
  keyDir: string,
  userDataPath: string
): Promise<boolean> {
  if (!hivewarddSecretStore) {
    throw new Error('hivewardd_secret_store_not_installed — call installHivewarddHostAdapters() first')
  }
  return hivewarddSecretStore.prepare({ keyDir, userDataPath })
}

/** Stamp the bundle’s own release so inherited desktop versions cannot misidentify this server. */
export function stampHivewarddAppVersion(installRoot: () => string = resolveHivewarddInstallRoot): void {
  let version: unknown
  try {
    const path = join(installRoot(), ...HIVEWARDD_CLI_PACKAGE_FILENAME.split('/'))
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    version = parsed && typeof parsed === 'object' && 'version' in parsed ? parsed.version : null
  } catch {
    return
  }
  if (typeof version === 'string' && version.length > 0) {
    process.env.HIVEWARD_APP_VERSION = version
  }
}

export function installHivewarddHostAdapters(): void {
  stampHivewarddAppVersion()
  setAppEnvironment(createNodeAppEnvironment())
  hivewarddSecretStore = createHivewarddSecretStore()
  setSecretStore(hivewarddSecretStore)
  setSpeechServiceFactories(hivewarddSpeechServiceFactories)
}
