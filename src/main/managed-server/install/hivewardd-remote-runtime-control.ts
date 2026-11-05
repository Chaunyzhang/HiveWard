import { HIVEWARDD_STARTUP_READINESS_TIMEOUT_MS } from '../../../shared/hivewardd-profile-preflight'
import {
  hivewarddLaunchCommand,
  parseHivewarddReadinessOutput,
  type HivewarddLaunchSpec,
  type HivewarddReadinessParse
} from './hivewardd-remote-launch'
import {
  readWindowsHivewarddLaunchReport,
  readWindowsHivewarddSlotRuntime,
  readWindowsHivewarddSlotEntry,
  windowsHivewarddLaunchCommand,
  windowsHivewarddLaunchRuntimeCommand
} from './hivewardd-remote-launch-windows'
import {
  HIVEWARDD_READINESS_WAIT_MAX_SECONDS,
  hivewarddLaunchExitedDuringWait,
  hivewarddReadinessWaitCommand,
  parseHivewarddReadinessWaitOutput
} from './hivewardd-remote-readiness-wait'
import type { HivewarddHostTransport } from '../../ssh/hivewardd-host-transport'
import { errorMessage } from '../../../shared/error-message'
import {
  execCommand,
  isUnconfirmedSshCommandTermination
} from '../../ssh/remote-exec/remote-exec-command'
import {
  currentHivewarddFence,
  isHivewarddFenceLost,
  HivewarddFenceLostError,
  posixHivewarddFenceGuard
} from '../activation/hivewardd-activation-fence-scope'
import { hivewarddWindowsHomeOpCommand } from './hivewardd-remote-windows-node'
import { HIVEWARDD_WINDOWS_FENCE_ARG } from '../host-state/hivewardd-windows-host-fence-ops'
import { isWindowsRemoteHost, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'

// Pause even after early host answers to avoid a tight retry loop.
const READINESS_RETRY_PAUSE_MS = 1_000

export type HivewarddRemoteExecTarget = {
  conn: HivewarddHostTransport
  host: RemoteHostPlatform
  signal?: AbortSignal
  /** Locates the runtime store for host-record scripts; required on Windows, unused elsewhere. */
  remoteHome?: string
}

/** A held activation fence must still name this run before any host step. */
export async function execHivewarddRemote(
  target: HivewarddRemoteExecTarget,
  command: string,
  signal = target.signal,
  maxOutputChars?: number
): Promise<string> {
  const fence = currentHivewarddFence()
  const run = (line: string): Promise<string> =>
    execCommand(target.conn, line, {
      wrapCommand: target.host.commandDialect !== 'powershell',
      signal,
      ...(maxOutputChars ? { maxOutputChars } : {})
    })
  try {
    if (!fence) {
      return await run(command)
    }
    if (!isWindowsRemoteHost(target.host)) {
      return await run(`${posixHivewarddFenceGuard(fence)} ${command}`)
    }
    // Host ops check ownership internally; other commands need a preceding check.
    if (!command.includes(HIVEWARDD_WINDOWS_FENCE_ARG) && target.remoteHome) {
      await run(hivewarddWindowsHomeOpCommand(target.host, target.remoteHome, 'fence-check', []))
    }
    return await run(command)
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    throw isHivewarddFenceLost(error) ? new HivewarddFenceLostError() : error
  }
}

/** Only confirmed failures use fallback; unconfirmed failures and lost fences propagate. */
export function execHivewarddRemoteOr(
  target: HivewarddRemoteExecTarget,
  command: string,
  fallback = ''
): Promise<string> {
  return execHivewarddRemote(target, command).catch((error: unknown) => {
    if (isUnconfirmedSshCommandTermination(error) || error instanceof HivewarddFenceLostError) {
      throw error
    }
    return fallback
  })
}

/** Recovery paths must finish even when the request that started them was cancelled. */
export function withoutAbortSignal<T extends { signal?: AbortSignal }>(
  options: T
): Omit<T, 'signal'> {
  const { signal: _signal, ...rest } = options
  return rest
}

export async function launchHivewarddAndAwaitReadiness(
  target: HivewarddRemoteExecTarget & {
    readinessTimeoutMs?: number
    sleep?: (ms: number) => Promise<void>
  },
  spec: HivewarddLaunchSpec
): Promise<HivewarddReadinessParse> {
  if (isWindowsRemoteHost(target.host)) {
    const slotAnswer = await execHivewarddRemote(
      target,
      windowsHivewarddLaunchRuntimeCommand(target.host, spec.remoteInstallDir)
    )
    const slotRuntime = readWindowsHivewarddSlotRuntime(slotAnswer)
    const slotEntry = readWindowsHivewarddSlotEntry(slotAnswer, target.host, spec.remoteInstallDir)
    readWindowsHivewarddLaunchReport(
      await execHivewarddRemote(
        target,
        windowsHivewarddLaunchCommand(target.host, spec, slotRuntime, slotEntry)
      )
    )
  } else {
    await execHivewarddRemote(
      target,
      hivewarddLaunchCommand(
        target.host,
        spec,
        target.conn.hivewarddLaunchDetach ?? 'nohup',
        (await target.conn.hivewarddLaunchEnv?.({ fullVersion: spec.fullVersion })) ?? []
      )
    )
  }
  const deadline = Date.now() + (target.readinessTimeoutMs ?? HIVEWARDD_STARTUP_READINESS_TIMEOUT_MS)
  const sleep = target.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  let last = parseHivewarddReadinessOutput('')
  let lastWaitError: unknown
  // Always read once, even if client scheduling outlasted the deadline.
  for (let first = true; first || Date.now() < deadline; first = false) {
    target.signal?.throwIfAborted()
    const waitSeconds = Math.min(
      HIVEWARDD_READINESS_WAIT_MAX_SECONDS,
      Math.ceil((deadline - Date.now()) / 1000)
    )
    let output: string
    try {
      output = await execHivewarddRemote(
        target,
        hivewarddReadinessWaitCommand(target.host, spec.remoteInstallDir, waitSeconds)
      )
    } catch (error) {
      if (
        (error instanceof Error && error.name === 'AbortError') ||
        isUnconfirmedSshCommandTermination(error) ||
        error instanceof HivewarddFenceLostError
      ) {
        throw error
      }
      // Failed reads do not prove launch failure; stopping here could kill a healthy candidate.
      lastWaitError = error
      console.warn(`[hivewardd] readiness wait failed; retrying: ${errorMessage(error)}`)
      await sleep(READINESS_RETRY_PAUSE_MS)
      continue
    }
    target.signal?.throwIfAborted()
    lastWaitError = undefined
    last = parseHivewarddReadinessWaitOutput(target.host, output)
    // An exited launch answers as the deadline would, so callers attach the same log tail.
    if (last.state !== 'pending' || hivewarddLaunchExitedDuringWait(target.host, output)) {
      return last
    }
    await sleep(READINESS_RETRY_PAUSE_MS)
  }
  if (lastWaitError !== undefined) {
    throw lastWaitError
  }
  return last
}
