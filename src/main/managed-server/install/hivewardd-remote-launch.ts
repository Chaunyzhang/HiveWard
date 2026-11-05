// Redirect detached candidate stdout to its version directory so readiness does not hold SSH open.
import type { HivewarddLaunchEnvEntry } from '../../ssh/hivewardd-host-transport'
import {
  HIVEWARDD_LAUNCHER_FILENAME,
  HIVEWARDD_SERVER_ENTRY_FILENAME
} from '../../../shared/hivewardd-artifacts'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  remoteBasename,
  remoteDirname,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'
import { RELAY_REMOTE_DIR } from '../../ssh/remote-exec/remote-frame-protocol'
import { HIVEWARDD_WSL_HOST_ENV } from '../../ipc/wsl-guest-windows-drive-path'
import {
  assertPosixHivewarddHost as assertPosixHost,
  HIVEWARDD_LOG_FILENAME,
  HIVEWARDD_PID_FILENAME,
  HIVEWARDD_LAUNCH_MACHINE_COMMAND,
  HIVEWARDD_PID_MACHINE_FILENAME,
  HIVEWARDD_READINESS_FILENAME,
  HIVEWARDD_READINESS_MAX_BYTES,
  posixProcessAliveShellFunction,
  posixProcessArgsShellFunction
} from './hivewardd-remote-host-support'
import type { ServeReadiness } from '../../server/serve-readiness'
import { selectHivewarddSlotRuntimeCommand } from './hivewardd-remote-runtime'
import { HIVEWARDD_STOP_REQUEST_FILENAME } from '../../../shared/hivewardd-stop-request'
import { hivewarddWindowsSlotOpCommand } from './hivewardd-remote-windows-node'
import {
  captureHivewarddLaunchSshSessionCommand,
  recordsHivewarddLaunchSshSession,
  writeHivewarddLaunchSshSessionCommand
} from '../../ssh/hivewardd-launch-ssh-session'
import {
  HIVEWARDD_E2E_IDLE_TIMEOUT_ENV,
  readHivewarddE2EIdleTimeoutMs
} from '../../../shared/hivewardd-idle-exit'
import { HIVEWARDD_MANAGED_ACTIVATION_ROOT_ENV } from '../../../shared/hivewardd-managed-launch-env'

export type HivewarddLaunchSpec = {
  remoteInstallDir: string
  nodePath: string
  fullVersion: string
  /** Shared across versions; rollback requires a snapshot. */
  userDataDir: string
  bindHost: string
  port: number
  /** Shared activation fence; managed SSH launches may idle out. */
  activationRoot: string
}

/** Older hivewardd versions ignore these launch variables. */
export function hivewarddManagedLaunchEnv(
  spec: HivewarddLaunchSpec,
  env: NodeJS.ProcessEnv = process.env
): [string, string][] {
  const e2eTimeout = readHivewarddE2EIdleTimeoutMs(env)
  return [
    [HIVEWARDD_MANAGED_ACTIVATION_ROOT_ENV, spec.activationRoot],
    ...(e2eTimeout === null
      ? []
      : [[HIVEWARDD_E2E_IDLE_TIMEOUT_ENV, String(e2eTimeout)] satisfies [string, string]])
  ]
}

/** WSL without systemd kills nohup children with wsl.exe --exec; use a separate session. */
export type HivewarddLaunchDetach = 'nohup' | 'setsid'

const HIVEWARDD_SETSID_PID_WAIT_TRIES = 100

/** Halving V8's 16 MB semi-spaces saves ~30 MB idle RSS; a CLI flag because the heap cannot be resized later. */
export const HIVEWARDD_RUNTIME_V8_FLAGS = '--max-semi-space-size=8'

/** Pass bind explicitly so launch policy cannot change with installed-version defaults. */
export function hivewarddLaunchCommand(
  host: RemoteHostPlatform,
  spec: HivewarddLaunchSpec,
  detach: HivewarddLaunchDetach = 'nohup',
  hostEnv: readonly HivewarddLaunchEnvEntry[] = []
): string {
  assertPosixHost(host)
  const dir = quotePosixShell(spec.remoteInstallDir)
  // Relative artifact paths reduce command size; every use follows the same-shell cd.
  const readiness = quotePosixShell(HIVEWARDD_READINESS_FILENAME)
  const log = quotePosixShell(HIVEWARDD_LOG_FILENAME)
  // PID writes run outside nohup’s backgrounded cd; reuse one absolute path to stay within command budgets.
  const pidFile = '"$hivewardd_pid"'
  // Liveness matches runtime argv against the absolute entry path.
  const entry = quotePosixShell(
    joinRemotePath(host, spec.remoteInstallDir, HIVEWARDD_LAUNCHER_FILENAME)
  )
  const baseDir = remoteDirname(spec.remoteInstallDir.replace(/\/+$/u, ''), host)
  // Tighten only the managed root, never an unrelated custom-slot parent.
  const privateDirs = [
    ...(remoteBasename(baseDir, host) === RELAY_REMOTE_DIR ? [baseDir] : []),
    spec.remoteInstallDir
  ]
  // Capture in the launching shell; detached subshell variables do not return here.
  const recordSession = detach === 'nohup' && recordsHivewarddLaunchSshSession(host)
  const launchEnv = [
    `HIVEWARD_VERSION=${quotePosixShell(spec.fullVersion)}`,
    `HIVEWARD_USER_DATA=${quotePosixShell(spec.userDataDir)}`,
    ...hivewarddManagedLaunchEnv(spec).map(([name, value]) => `${name}=${quotePosixShell(value)}`)
  ]
  return [
    `hivewardd_pid=${quotePosixShell(joinRemotePath(host, spec.remoteInstallDir, HIVEWARDD_PID_FILENAME))};`,
    // Record the launching machine before detaching; absent boot identity leaves it unverified.
    `{ ${HIVEWARDD_LAUNCH_MACHINE_COMMAND};}>"$hivewardd_pid${HIVEWARDD_PID_MACHINE_FILENAME.slice(HIVEWARDD_PID_FILENAME.length)}" 2>/dev/null;`,
    ...(recordSession ? [captureHivewarddLaunchSshSessionCommand()] : []),
    // Preserve login umask for daemon children creating user files.
    'hivewardd_login_umask=$(umask);',
    // Pairing-token artifacts need umask 077 from creation; semicolon also covers the external PID write.
    'umask 077;',
    // Tighten existing artifacts best-effort; umask cannot repair their modes.
    `{ chmod 700 ${privateDirs.map(quotePosixShell).join(' ')} 2>/dev/null || :; } &&`,
    `cd ${dir} &&`,
    `${selectHivewarddSlotRuntimeCommand(host, spec.remoteInstallDir, spec.nodePath)} &&`,
    // Truncate so relaunch cannot activate on the previous process’s readiness.
    `: > ${readiness} &&`,
    // Required: truncating redirects retain old file modes.
    `chmod 600 ${readiness} &&`,
    `{ chmod 600 ${pidFile} ${log} 2>/dev/null || :; } &&`,
    `rm -f ${quotePosixShell(HIVEWARDD_STOP_REQUEST_FILENAME)} &&`,
    ...(detach === 'setsid' ? [`rm -f ${pidFile} &&`] : []),
    ...(detach === 'setsid'
      ? setsidLaunchTail(entry, spec, readiness, log, pidFile, launchEnv, hostEnv)
      : [
          // Open redirects under 077 before restoring daemon login umask.
          '{ umask "$hivewardd_login_umask" &&',
          ...launchEnv,
          // exec keeps $! equal to runtime PID; in-place launcher loading also preserves older clients’ argv checks.
          `exec nohup "$hivewardd_runtime" ${HIVEWARDD_RUNTIME_V8_FLAGS} ${entry}`,
          `--json --bind ${quotePosixShell(spec.bindHost)} --port ${String(spec.port)};`,
          `} > ${readiness} 2>> ${log} < /dev/null &`,
          `echo $! > ${pidFile} &&`,
          ...(recordSession
            ? [`${writeHivewarddLaunchSshSessionCommand(host, spec.userDataDir)} &&`]
            : []),
          `cat ${pidFile}`
        ])
  ].join(' ')
}

/** setsid -f exits its parent, so the exec child records $$; BusyBox uses background setsid without -f. */
function setsidLaunchTail(
  entry: string,
  spec: HivewarddLaunchSpec,
  readiness: string,
  log: string,
  pidFile: string,
  launchEnv: readonly string[],
  hostEnv: readonly HivewarddLaunchEnvEntry[]
): string[] {
  return [
    ...launchEnv,
    // Only WSL setsid launches receive this marker.
    `${HIVEWARDD_WSL_HOST_ENV}=1`,
    ...hostEnv.map(launchEnvAssignment),
    'sh -c \'hivewardd_detach() { if setsid -f true >/dev/null 2>&1; then setsid -f "$@"; ' +
      'else setsid "$@" & fi; }; hivewardd_detach "$@"\' hivewardd-detach',
    `sh -c 'echo $$ > "$1" && umask "$2" && shift 2 && exec "$@"' hivewardd-launch ${pidFile}`,
    '"$hivewardd_login_umask"',
    `"$hivewardd_runtime" ${HIVEWARDD_RUNTIME_V8_FLAGS} ${entry}`,
    `--json --bind ${quotePosixShell(spec.bindHost)} --port ${String(spec.port)}`,
    `> ${readiness} 2>> ${log} < /dev/null &&`,
    `hivewardd_wait=0; while [ ! -s ${pidFile} ] && [ "$hivewardd_wait" -lt ${HIVEWARDD_SETSID_PID_WAIT_TRIES} ];`,
    'do sleep 0.05; hivewardd_wait=$((hivewardd_wait + 1)); done;',
    `cat ${pidFile}`
  ]
}

function launchEnvAssignment([name, value, mode]: HivewarddLaunchEnvEntry): string {
  if (mode !== 'keep-existing') {
    return `${assertEnvName(name)}=${quotePosixShell(value)}`
  }
  // Inside "${NAME:-default}" quotes are literal, so only quote-free defaults are expressible.
  if (!/^[A-Za-z0-9._=:,/-]+$/.test(value)) {
    throw new Error(`hivewardd_launch_env_default_invalid:${name}`)
  }
  return `${assertEnvName(name)}="\${${name}:-${value}}"`
}

function assertEnvName(name: string): string {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    throw new Error(`hivewardd_launch_env_name_invalid:${name}`)
  }
  return name
}

export function readHivewarddReadinessCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string
): string {
  assertPosixHost(host)
  const readiness = quotePosixShell(
    joinRemotePath(host, remoteInstallDir, HIVEWARDD_READINESS_FILENAME)
  )
  return `head -c ${HIVEWARDD_READINESS_MAX_BYTES + 1} ${readiness} 2>/dev/null || true`
}

/** LIVE/DEAD/UNKNOWN distinguish proven state from missing/denied identity probes.
 * No PID or readiness file means NEVER_LAUNCHED, which also proves this slot has no process. */
export function hivewarddLivenessProbeCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string
): string {
  if (isWindowsRemoteHost(host)) {
    return hivewarddWindowsSlotOpCommand(host, remoteInstallDir, 'liveness', [remoteInstallDir])
  }
  const pidFile = quotePosixShell(joinRemotePath(host, remoteInstallDir, HIVEWARDD_PID_FILENAME))
  const readiness = quotePosixShell(
    joinRemotePath(host, remoteInstallDir, HIVEWARDD_READINESS_FILENAME)
  )
  const launcher = quotePosixShell(joinRemotePath(host, remoteInstallDir, HIVEWARDD_LAUNCHER_FILENAME))
  const server = quotePosixShell(
    joinRemotePath(host, remoteInstallDir, HIVEWARDD_SERVER_ENTRY_FILENAME)
  )
  return [
    posixProcessAliveShellFunction({ refuseUnverifiable: true }),
    posixProcessArgsShellFunction(),
    // PID reuse needs argv identity; absent ps leaves conservative liveness checks to decide.
    `hivewardd_launcher=${launcher}; hivewardd_server=${server};`,
    // The probe's own shell, or the shell wrapping it, carries the slot paths in its argv; after a
    // restart either can hold the old PID. A shell elsewhere may be an older launcher's live parent.
    'hivewardd_reused() { { [ "$1" = "$$" ] || [ "$1" = "$PPID" ]; } && return 0; ' +
      'args=$(hivewardd_args "$1") && [ -n "$args" ] && ' +
      'case "$args" in *"$hivewardd_launcher"* | *"$hivewardd_server"*) return 1;; *) return 0;; esac; };',
    `pid=$(cat ${pidFile} 2>/dev/null);`,
    'case "$pid" in',
    `"" ) if [ -e ${pidFile} ] || [ -e ${readiness} ]; then echo UNKNOWN; else echo ${HIVEWARDD_NEVER_LAUNCHED}; fi;;`,
    '*[!0-9]* ) echo UNKNOWN;;',
    '* ) if hivewardd_reused "$pid"; then echo DEAD; elif hivewardd_alive "$pid"; then echo LIVE; else echo DEAD; fi;;',
    'esac'
  ].join(' ')
}

export const HIVEWARDD_NEVER_LAUNCHED = 'NEVER_LAUNCHED'

export type HivewarddLiveness = 'LIVE' | 'DEAD' | 'UNKNOWN' | typeof HIVEWARDD_NEVER_LAUNCHED

export function parseHivewarddLiveness(output: string): HivewarddLiveness {
  const value = output.trim().split('\n').pop()?.trim()
  return value === 'LIVE' || value === 'DEAD' || value === HIVEWARDD_NEVER_LAUNCHED ? value : 'UNKNOWN'
}

/** Only DEAD/NEVER_LAUNCHED permit lifecycle changes; UNKNOWN proves nothing. */
export function hivewarddLivenessProvenExited(liveness: HivewarddLiveness): boolean {
  return liveness === 'DEAD' || liveness === HIVEWARDD_NEVER_LAUNCHED
}

export function hivewarddLivenessAnswerBlocksGc(output: string): boolean {
  return hivewarddLivenessBlocksGc(parseHivewarddLiveness(output))
}

export function hivewarddLivenessBlocksGc(liveness: HivewarddLiveness): boolean {
  return !hivewarddLivenessProvenExited(liveness)
}

export type HivewarddReadinessParse =
  | { state: 'ready'; readiness: ServeReadiness }
  | { state: 'pending' }
  | { state: 'malformed'; reason: string }

/** Treat an unfinished last line as pending; polling can race a candidate stdout append. */
export function parseHivewarddReadinessOutput(raw: string): HivewarddReadinessParse {
  if (Buffer.byteLength(raw, 'utf8') > HIVEWARDD_READINESS_MAX_BYTES) {
    return { state: 'malformed', reason: 'readiness payload exceeds the 256 KiB limit' }
  }
  const lines = raw.split('\n')
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // Only an unterminated last line can recover from a partial write.
      return index === lines.length - 1
        ? { state: 'pending' }
        : { state: 'malformed', reason: 'readiness line is not valid JSON' }
    }
    if (typeof parsed !== 'object' || parsed === null) {
      continue
    }
    const payload = parsed as { type?: unknown }
    if (payload.type !== 'hiveward_server_ready') {
      return {
        state: 'malformed',
        reason: `expected an hiveward_server_ready line, got type=${JSON.stringify(payload.type)}`
      }
    }
    return { state: 'ready', readiness: toServeReadiness(payload as Record<string, unknown>) }
  }
  return { state: 'pending' }
}

function toServeReadiness(payload: Record<string, unknown>): ServeReadiness {
  return {
    runtimeId: typeof payload.runtimeId === 'string' ? payload.runtimeId : '',
    boundEndpoint: typeof payload.boundEndpoint === 'string' ? payload.boundEndpoint : null,
    advertisedEndpoint:
      typeof payload.advertisedEndpoint === 'string' ? payload.advertisedEndpoint : null,
    managedWslCliReconciliation:
      payload.managedWslCliReconciliation === 'pending' ||
      payload.managedWslCliReconciliation === 'failed'
        ? payload.managedWslCliReconciliation
        : 'settled',
    pairing: payload.pairing as ServeReadiness['pairing'],
    ...(payload.health ? { health: payload.health as ServeReadiness['health'] } : {})
  }
}
