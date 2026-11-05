import { setRuntimeBrowserCommandsFactory } from '../runtime/runtime-browser-commands-factory'
import { markHostShuttingDown } from '../host-shutdown-state'
import { setDesktopBrowserBridgeHostEnabled } from '../runtime/desktop-browser-bridge/desktop-browser-bridge-registry'
import { HIVEWARDD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/hivewardd-managed-launch-env'
import { startHivewarddBrowserProvider } from './hivewardd-browser-startup'
import { HivewarddRuntimeLifetime, type HivewarddRuntimeCleanup } from './hivewardd-runtime-lifetime'
import type { HivewarddManagedStopInstance } from '../../shared/hivewardd-stop-request'
import { acquireHivewarddInstanceLock } from './hivewardd-instance-lock'
import { HIVEWARDD_BUNDLED_LAUNCHER_ENV } from './hivewardd-bundled-runtime'
import { resolveHivewarddExitCode } from './hivewardd-exit-code'
import { recordAgentSessionRuntimeEnd } from '../runtime/agent-session/records/agent-session-runtime-end-record'
import { HIVEWARDD_SHUTDOWN_DEADLINE_MS } from './hivewardd-stop-deadlines'
import { holdHivewarddTerminalAdmissionUntilExit } from './hivewardd-stop-terminal-admission'
import {
  acquireProfileStateRuntimeAdmission,
  type ProfileStateRuntimeAdmission
} from '../persistence/profile-state/profile-state-access'

const bundledLauncherChannel = process.env[HIVEWARDD_BUNDLED_LAUNCHER_ENV] === '1'
delete process.env[HIVEWARDD_BUNDLED_LAUNCHER_ENV]

function createIdempotentHivewarddCleanup(cleanup: () => Promise<void>): () => Promise<void> {
  let completion: Promise<void> | null = null
  return () => {
    completion ??= Promise.resolve().then(cleanup)
    return completion
  }
}

/** Return whether this caller owns the stop; fatal faults supply a nonzero completed-stop code. */
export type HivewarddShutdownTrigger = (
  reason: string,
  onFailed?: () => void,
  stoppedExitCode?: number
) => boolean

/** Deduplicate launcher/child signals into one bounded stop; onFailed retracts clean-stop records. */
export function installHivewarddShutdownSignals(
  stop: () => Promise<void>,
  deadlineMs = HIVEWARDD_SHUTDOWN_DEADLINE_MS
): HivewarddShutdownTrigger {
  let stopping = false
  let exitCode = 0
  let failed = false
  let retractClean: (() => void) | undefined
  const markFailed = (): void => {
    if (!failed) {
      failed = true
      retractClean?.()
    }
  }
  const shutdown: HivewarddShutdownTrigger = (signal, onFailed, stoppedExitCode = 0) => {
    if (stopping) {
      // Fatal faults must escalate an in-progress clean stop to failure.
      if (stoppedExitCode !== 0 && exitCode === 0) {
        exitCode = stoppedExitCode
        onFailed?.()
        markFailed()
      }
      return false
    }
    stopping = true
    markHostShuttingDown()
    holdHivewarddTerminalAdmissionUntilExit()
    exitCode = stoppedExitCode
    retractClean = onFailed
    setTimeout(() => {
      console.error(`hivewardd: shutdown after ${signal} exceeded ${deadlineMs}ms — exiting`)
      markFailed()
      process.exit(1)
    }, deadlineMs)
    stop()
      .then(() => process.exit(exitCode))
      .catch((error) => {
        console.error(`hivewardd: shutdown after ${signal} failed:`, error)
        markFailed()
        process.exit(resolveHivewarddExitCode(error))
      })
    return true
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  // Survive terminal hangups; INT/TERM request graceful shutdown.
  if (process.platform !== 'win32') {
    process.on('SIGHUP', () => {})
  }
  if (bundledLauncherChannel && typeof process.send === 'function') {
    process.once('disconnect', () => shutdown('launcher disconnect'))
    if (!process.connected) {
      shutdown('launcher disconnect')
    }
  }
  return shutdown
}

export async function stopHivewarddStructuredAgentSessions(): Promise<void> {
  const { stopStructuredAgentSessionRuntime } =
    await import('../runtime/agent-session/structured-agent-session-runtime')
  await stopStructuredAgentSessionRuntime({ trigger: 'quit' })
}

export async function startHivewarddWithLifecycle<T extends object>(
  start: (registerRuntimeCleanup: (cleanup: HivewarddRuntimeCleanup) => void) => Promise<T>,
  cleanupHost: (runtimeCleanupSucceeded: boolean) => Promise<void>
): Promise<T & { stop(): Promise<void> }> {
  const runtime = new HivewarddRuntimeLifetime()
  const cleanup = createIdempotentHivewarddCleanup(async () => {
    // Stamp quit before awaiting teardown so dying chat agents read as restart rather than crash.
    recordAgentSessionRuntimeEnd('quit')
    // Startup failures reach cleanup without shutdown admission while RPC may already be serving.
    markHostShuttingDown()
    let runtimeCleanupSucceeded = false
    try {
      await runtime.stop()
      runtimeCleanupSucceeded = true
    } finally {
      await cleanupHost(runtimeCleanupSucceeded)
    }
  })
  try {
    const handle = await start((nextCleanup) => runtime.add(nextCleanup))
    return { ...handle, stop: cleanup }
  } catch (error) {
    try {
      await cleanup()
    } catch (cleanupError) {
      // Preserve the startup fault while recording cleanup failures.
      console.error('[hivewardd] startup cleanup failed:', cleanupError)
    }
    throw error
  }
}

/** Keep profile admission/lock until all runtime writers stop. */
export async function startHivewarddWithHost<T extends object>(
  userDataPath: string,
  start: (registerCleanup: (cleanup: HivewarddRuntimeCleanup) => void) => Promise<T>,
  runQuitHandlers: () => void | Promise<void>
): Promise<T & { stop(): Promise<void>; instance: HivewarddManagedStopInstance }> {
  const instanceLock = acquireHivewarddInstanceLock(userDataPath)
  const { pid, startedAtMs, nonce } = instanceLock.record
  const instance = { pid, startedAtMs, nonce, lockPath: instanceLock.path }
  let admission: ProfileStateRuntimeAdmission | undefined
  let browserProvider: ReturnType<typeof startHivewarddBrowserProvider> | undefined
  return startHivewarddWithLifecycle(
    async (registerCleanup) => {
      admission = acquireProfileStateRuntimeAdmission(userDataPath)
      // Browser authorization UI must not block RPC readiness.
      browserProvider = startHivewarddBrowserProvider({ userDataPath })
      // Only managed hosts have opted-in desktop bridges; user-started hosts route to paired page hosts.
      setDesktopBrowserBridgeHostEnabled(Boolean(process.env[HIVEWARDD_MANAGED_ACTIVATION_ROOT_ENV]))
      return { ...(await start(registerCleanup)), instance }
    },
    async (runtimeCleanupSucceeded) => {
      // Failed cleanup retains both ownership fences until process exit.
      const host = new HivewarddRuntimeLifetime(() => {
        if (runtimeCleanupSucceeded) {
          instanceLock.release()
        }
      })
      host.add(({ failed }) => {
        if (runtimeCleanupSucceeded && !failed) {
          admission?.release()
        }
      })
      host.add(() => runQuitHandlers())
      host.add(() => setRuntimeBrowserCommandsFactory(null))
      host.add(() => setDesktopBrowserBridgeHostEnabled(false))
      host.add(() => browserProvider?.stop())
      await host.stop()
    }
  )
}

export async function flushHivewarddProfileStoreForShutdown(
  store: { flushFinalOrThrowAsync(): Promise<void>; freezeWritesAsync(): Promise<void> },
  paneGrids?: { flushPaneGrids(): Promise<void> | null } | null
): Promise<void> {
  // A pane's grid still inside its write burst joins the final save.
  const flushing = paneGrids?.flushPaneGrids()
  if (flushing) {
    await flushing
  }
  try {
    await store.flushFinalOrThrowAsync()
  } finally {
    await store.freezeWritesAsync()
  }
}
