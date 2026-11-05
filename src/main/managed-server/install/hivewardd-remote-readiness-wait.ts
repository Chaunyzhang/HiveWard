// Wait on-host in one bounded exec; repeated SSH polling spawned process bursts and triggered Windows EDR.
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'
import {
  HIVEWARDD_PID_FILENAME,
  HIVEWARDD_PID_MACHINE_FILENAME,
  HIVEWARDD_READINESS_FILENAME,
  HIVEWARDD_READINESS_MAX_BYTES,
  HIVEWARDD_LAUNCH_MACHINE_COMMAND
} from './hivewardd-remote-host-support'
import {
  parseHivewarddReadinessOutput,
  readHivewarddReadinessCommand,
  type HivewarddReadinessParse
} from './hivewardd-remote-launch'
import {
  hivewarddWindowsSlotOpCommand,
  readHivewarddWindowsEncodedAnswer
} from './hivewardd-remote-windows-node'
import { HIVEWARDD_WINDOWS_READINESS_MARKER } from '../host-state/hivewardd-windows-host-script'

// Stay below the 30-second exec timeout so waits can answer before channel expiry.
export const HIVEWARDD_READINESS_WAIT_MAX_SECONDS = 20

const HIVEWARDD_LAUNCH_EXITED_MARKER = 'HIVEWARDD_LAUNCH_EXITED'

function posixReadinessWaitCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string,
  waitSeconds: number
): string {
  const file = quotePosixShell(joinRemotePath(host, remoteInstallDir, HIVEWARDD_READINESS_FILENAME))
  const read = `head -c ${HIVEWARDD_READINESS_MAX_BYTES + 1} ${file} 2>/dev/null`
  const pidFile = quotePosixShell(joinRemotePath(host, remoteInstallDir, HIVEWARDD_PID_FILENAME))
  const pidMachine = quotePosixShell(
    joinRemotePath(host, remoteInstallDir, HIVEWARDD_PID_MACHINE_FILENAME)
  )
  return [
    // Fail early only on proven exit from the launching machine; shared homes and unverified PIDs must keep waiting.
    `hivewardd_launch_here() { hivewardd_recorded=$(cat ${pidMachine} 2>/dev/null) && [ -n "$hivewardd_recorded" ] && [ "$hivewardd_recorded" = "$(${HIVEWARDD_LAUNCH_MACHINE_COMMAND} 2>/dev/null)" ]; };`,
    `hivewardd_launch_exited() { hivewardd_launch_here || return 1; pid=$(cat ${pidFile} 2>/dev/null); case "$pid" in "" | *[!0-9]*) return 1;; esac;`,
    'probe_error=$(LC_ALL=C kill -0 "$pid" 2>&1) || { case "$probe_error" in *"No such process"*) return 0;; esac; return 1; };',
    'case "$(ps -o stat= -p "$pid" 2>/dev/null)" in Z*) return 0;; esac; return 1; };',
    // Probe fractional sleep once; POSIX hosts may support only integer seconds.
    'if sleep 0.25 2>/dev/null; then hivewardd_readiness_wait_step=0.25;',
    'else hivewardd_readiness_wait_step=1; fi;',
    // Bound elapsed time, not iterations: slow filesystem reads otherwise overrun the client exec deadline.
    `hivewardd_readiness_wait_end=$(($(date +%s) + ${waitSeconds}));`,
    'while [ "$(date +%s)" -lt "$hivewardd_readiness_wait_end" ]; do',
    `[ "$(${read} | wc -l)" -gt 0 ] && break;`,
    `[ "$(${read} | wc -c)" -gt ${HIVEWARDD_READINESS_MAX_BYTES} ] && break;`,
    `hivewardd_launch_exited && { echo ${HIVEWARDD_LAUNCH_EXITED_MARKER}; break; };`,
    'sleep "$hivewardd_readiness_wait_step"; done;',
    `${read} || true`
  ].join(' ')
}

export function hivewarddReadinessWaitCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string,
  waitSeconds: number
): string {
  const seconds = Math.max(0, Math.min(HIVEWARDD_READINESS_WAIT_MAX_SECONDS, Math.ceil(waitSeconds)))
  if (!isWindowsRemoteHost(host)) {
    return posixReadinessWaitCommand(host, remoteInstallDir, seconds)
  }
  return hivewarddWindowsSlotOpCommand(host, remoteInstallDir, 'readiness-wait', [
    joinRemotePath(host, remoteInstallDir, HIVEWARDD_READINESS_FILENAME),
    String(HIVEWARDD_READINESS_MAX_BYTES),
    String(seconds)
  ])
}

export function parseHivewarddReadinessWaitOutput(
  host: RemoteHostPlatform,
  output: string
): HivewarddReadinessParse {
  return parseHivewarddReadinessOutput(
    isWindowsRemoteHost(host)
      ? (readHivewarddWindowsEncodedAnswer(output, HIVEWARDD_WINDOWS_READINESS_MARKER) ?? '')
      : withoutLaunchExitedMarker(output)
  )
}

export function hivewarddLaunchExitedDuringWait(host: RemoteHostPlatform, output: string): boolean {
  return !isWindowsRemoteHost(host) && output.startsWith(`${HIVEWARDD_LAUNCH_EXITED_MARKER}\n`)
}

function withoutLaunchExitedMarker(output: string): string {
  return output.startsWith(`${HIVEWARDD_LAUNCH_EXITED_MARKER}\n`)
    ? output.slice(HIVEWARDD_LAUNCH_EXITED_MARKER.length + 1)
    : output
}

export function readHivewarddReadinessNowCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string
): string {
  // Windows host wait with zero delay substitutes for the unavailable head command.
  return isWindowsRemoteHost(host)
    ? hivewarddReadinessWaitCommand(host, remoteInstallDir, 0)
    : readHivewarddReadinessCommand(host, remoteInstallDir)
}
