// Win32-OpenSSH kills session jobs; require native breakaway without WMI/PowerShell, then record PID plus creation time.
import {
  HIVEWARDD_WINDOWS_BREAKAWAY_CONTRACT,
  parseWindowsBreakawayLaunchReport,
  WINDOWS_BREAKAWAY_ENV_FLAG,
  WINDOWS_BREAKAWAY_LAUNCH_FLAG,
  WINDOWS_BREAKAWAY_PROCESS_FILE_FLAG,
  WINDOWS_BREAKAWAY_STDERR_FLAG,
  WINDOWS_BREAKAWAY_STDERR_KEEP_PREVIOUS_FLAG,
  WINDOWS_BREAKAWAY_STDOUT_FLAG
} from '../../../shared/windows-breakaway-launch'
import { joinRemotePath, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import {
  hivewarddWindowsNodeCommandLine,
  hivewarddWindowsSlotOpCommand,
  readHivewarddWindowsEncodedAnswer
} from './hivewardd-remote-windows-node'
import {
  HIVEWARDD_WINDOWS_ENTRY_MARKER,
  HIVEWARDD_WINDOWS_RUNTIME_MARKER
} from '../host-state/hivewardd-windows-host-script'
import {
  HIVEWARDD_LOG_FILENAME,
  HIVEWARDD_READINESS_FILENAME,
  HIVEWARDD_WINDOWS_PROCESS_FILENAME
} from './hivewardd-remote-host-support'
import { hivewarddManagedLaunchEnv, type HivewarddLaunchSpec } from './hivewardd-remote-launch'
import { HIVEWARDD_WINDOWS_LAUNCH_REFUSED_CODE } from '../../hivewardd/hivewardd-host-unavailable'

export class HivewarddWindowsLaunchRefusedError extends Error {
  readonly code = HIVEWARDD_WINDOWS_LAUNCH_REFUSED_CODE
  constructor(reason: string) {
    super(
      `The Windows host refused to start hivewardd outside the SSH session (${reason}). hivewardd needs ` +
        'a job that allows breakaway and a slot with the process-tree launcher; it never falls ' +
        'back to WMI.'
    )
    this.name = 'HivewarddWindowsLaunchRefusedError'
  }
}

/** Resolve pinned slot runtime and remove stale instance-stop intent before launch. */
export function windowsHivewarddLaunchRuntimeCommand(
  host: RemoteHostPlatform,
  slotDir: string
): string {
  return hivewarddWindowsSlotOpCommand(host, slotDir, 'slot-runtime', [slotDir, 'clear-stop-request'])
}

export function readWindowsHivewarddSlotRuntime(output: string): string {
  const runtime = readHivewarddWindowsEncodedAnswer(output, HIVEWARDD_WINDOWS_RUNTIME_MARKER)
  if (!runtime) {
    throw new Error('The Windows host did not name the runtime this hivewardd slot needs.')
  }
  return runtime
}

/** Older host scripts omit entry, implying the legacy single-file launcher. */
export function readWindowsHivewarddSlotEntry(
  output: string,
  host: RemoteHostPlatform,
  slotDir: string
): string {
  return (
    readHivewarddWindowsEncodedAnswer(output, HIVEWARDD_WINDOWS_ENTRY_MARKER) ??
    joinRemotePath(host, slotDir, 'hivewardd.js')
  )
}

export function windowsHivewarddLaunchCommand(
  host: RemoteHostPlatform,
  spec: HivewarddLaunchSpec,
  slotRuntime: string,
  slotEntry = joinRemotePath(host, spec.remoteInstallDir, 'hivewardd.js')
): string {
  const dir = spec.remoteInstallDir
  return hivewarddWindowsNodeCommandLine(slotRuntime, [
    slotEntry,
    WINDOWS_BREAKAWAY_LAUNCH_FLAG,
    // CREATE_ALWAYS removes stale readiness before the launcher returns.
    WINDOWS_BREAKAWAY_STDOUT_FLAG,
    joinRemotePath(host, dir, HIVEWARDD_READINESS_FILENAME),
    WINDOWS_BREAKAWAY_STDERR_FLAG,
    joinRemotePath(host, dir, HIVEWARDD_LOG_FILENAME),
    // Preserve previous stderr for crash diagnosis across restart.
    WINDOWS_BREAKAWAY_STDERR_KEEP_PREVIOUS_FLAG,
    WINDOWS_BREAKAWAY_PROCESS_FILE_FLAG,
    joinRemotePath(host, dir, HIVEWARDD_WINDOWS_PROCESS_FILENAME),
    WINDOWS_BREAKAWAY_ENV_FLAG,
    `HIVEWARD_VERSION=${spec.fullVersion}`,
    WINDOWS_BREAKAWAY_ENV_FLAG,
    `HIVEWARD_USER_DATA=${spec.userDataDir}`,
    ...hivewarddManagedLaunchEnv(spec).flatMap(([name, value]) => [
      WINDOWS_BREAKAWAY_ENV_FLAG,
      `${name}=${value}`
    ]),
    HIVEWARDD_WINDOWS_BREAKAWAY_CONTRACT.argsFlag,
    '--json',
    '--bind',
    spec.bindHost,
    '--port',
    String(spec.port)
  ])
}

/** Return launched PID or surface native-breakaway refusal/failure. */
export function readWindowsHivewarddLaunchReport(output: string): number {
  const report = parseWindowsBreakawayLaunchReport(HIVEWARDD_WINDOWS_BREAKAWAY_CONTRACT, output)
  if (report?.method === 'breakaway') {
    return report.pid
  }
  if (report?.method === 'unavailable') {
    throw new HivewarddWindowsLaunchRefusedError(
      report.step ? `${report.reason} at ${report.step}` : report.reason
    )
  }
  const detail =
    report?.method === 'failed'
      ? `${report.reason}${report.step ? ` at ${report.step}` : ''} (code ${String(report.code ?? 0)})`
      : 'no launch report'
  throw new Error(`hivewardd's Windows launcher did not start the candidate: ${detail}.`)
}
