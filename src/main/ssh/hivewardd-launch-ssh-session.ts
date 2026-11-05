/** macOS pins Local Network attribution at spawn: SSH-launched terminals can lose LAN access after sshd-session exits (#25934; Apple TN3179). Record the nearest session plus start time and matching slot PID; preserve earlier attribution while a live terminal daemon survives hivewardd restarts. */
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import { HIVEWARDD_PID_FILENAME } from '../managed-server/install/hivewardd-remote-host-support'

export const HIVEWARDD_LAUNCH_SSH_SESSION_FILENAME = '.hivewardd-launch-ssh-session'

const LOCAL_NETWORK_PRIVACY_MAJOR = 15
// Bounds the ancestor walk; real chains are a few processes deep.
const MAX_ANCESTOR_DEPTH = 32

export function recordsHivewarddLaunchSshSession(host: RemoteHostPlatform): boolean {
  return host.os === 'darwin'
}

/** Choose the nearest sshd ancestor, which exits with this session; a listener farther up would remain alive. */
export function hivewarddSshSessionAncestorShellFunction(): string {
  return (
    'hivewardd_ssh_session() { hivewardd_sp=$1; hivewardd_si=0; ' +
    `while [ "$hivewardd_si" -lt ${MAX_ANCESTOR_DEPTH} ]; do ` +
    'case "$hivewardd_sp" in "" | *[!0-9]* | 0 | 1) return 1;; esac; ' +
    'hivewardd_sc=$(ps -o comm= -p "$hivewardd_sp" 2>/dev/null) || return 1; ' +
    'case "${hivewardd_sc##*/}" in sshd*) ' +
    'hivewardd_ss=$(ps -o lstart= -p "$hivewardd_sp" 2>/dev/null) || return 1; ' +
    // Why unquoted: normalizes lstart's padding so a later read compares equal.
    'echo "$hivewardd_sp" $hivewardd_ss; return 0;; esac; ' +
    'hivewardd_sp=$(ps -o ppid= -p "$hivewardd_sp" 2>/dev/null | tr -d " "); ' +
    'hivewardd_si=$((hivewardd_si + 1)); done; return 1; };'
  )
}

/** Capture before detach without failing launch. */
export function captureHivewarddLaunchSshSessionCommand(): string {
  return (
    `${hivewarddSshSessionAncestorShellFunction()} ` +
    'hivewardd_session=$(hivewardd_ssh_session "$$" 2>/dev/null) || hivewardd_session=;'
  )
}

function recordPath(host: RemoteHostPlatform, userDataDir: string): string {
  return quotePosixShell(joinRemotePath(host, userDataDir, HIVEWARDD_LAUNCH_SSH_SESSION_FILENAME))
}

/** Return 0 for this root's live daemon, 1 for absence, 2 for unreadable argv; PID files alone may name recycled processes. */
function liveDaemonShellFunction(host: RemoteHostPlatform, userDataDir: string): string {
  const daemonDir = quotePosixShell(joinRemotePath(host, userDataDir, 'daemon'))
  return (
    `hivewardd_daemon_live() { hivewardd_ddir=${daemonDir}; for hivewardd_df in "$hivewardd_ddir"/daemon-v*.pid; do ` +
    '[ -f "$hivewardd_df" ] || continue; ' +
    'hivewardd_dp=$(sed -n \'s/.*"pid":\\([0-9][0-9]*\\).*/\\1/p\' "$hivewardd_df" | head -n 1); ' +
    '[ -n "$hivewardd_dp" ] || continue; ' +
    'kill -0 "$hivewardd_dp" 2>/dev/null || continue; ' +
    'hivewardd_da=$(ps -o args= -p "$hivewardd_dp" 2>/dev/null); [ -n "$hivewardd_da" ] || return 2; ' +
    'case "$hivewardd_da" in *daemon-entry*"$hivewardd_ddir"* | *"$hivewardd_ddir"*daemon-entry*) return 0;; esac; ' +
    'done; return 1; };'
  )
}

/** After recording $!, preserve the live daemon's earlier session; otherwise record this launch's session. */
export function writeHivewarddLaunchSshSessionCommand(
  host: RemoteHostPlatform,
  userDataDir: string
): string {
  const file = recordPath(host, userDataDir)
  return (
    // First-deploy detach may run before hivewardd creates its data root.
    `{ hivewardd_bg=$!; ( umask 077; mkdir -p ${quotePosixShell(userDataDir)} ); ` +
    `${liveDaemonShellFunction(host, userDataDir)} ` +
    'hivewardd_daemon_live; hivewardd_dl=$?; ' +
    'if [ "$hivewardd_dl" = 0 ]; then ' +
    `hivewardd_prev=$(cat ${file}); rm -f ${file}; set -- $hivewardd_prev; ` +
    `[ "$#" -lt 3 ] || { shift; ( umask 077; echo "$hivewardd_bg" "$@" > ${file} ); }; ` +
    // Unreadable daemon identity leaves attribution unknown, never assigned to this launch.
    `elif [ "$hivewardd_dl" = 2 ]; then rm -f ${file}; ` +
    `else rm -f ${file}; [ -z "$hivewardd_session" ] || ` +
    `( umask 077; echo "$hivewardd_bg" $hivewardd_session > ${file} ); fi; :; } 2>/dev/null`
  )
}

export function hivewarddLaunchSshSessionProbeCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string,
  userDataDir: string
): string {
  const file = recordPath(host, userDataDir)
  const pidFile = quotePosixShell(joinRemotePath(host, remoteInstallDir, HIVEWARDD_PID_FILENAME))
  return [
    'hivewardd_mac=$(sw_vers -productVersion 2>/dev/null) || { echo NOT_APPLICABLE; exit 0; };',
    'hivewardd_major=${hivewardd_mac%%.*};',
    'case "$hivewardd_major" in "" | *[!0-9]*) echo UNVERIFIABLE; exit 0;; esac;',
    `[ "$hivewardd_major" -ge ${LOCAL_NETWORK_PRIVACY_MAJOR} ] || { echo NOT_APPLICABLE; exit 0; };`,
    `hivewardd_rec=$(cat ${file} 2>/dev/null) || { echo NOT_RECORDED; exit 0; };`,
    `hivewardd_pid=$(cat ${pidFile} 2>/dev/null);`,
    'set -- $hivewardd_rec;',
    'case "$1:$2" in *[!0-9:]* | :* | *:) echo NOT_RECORDED; exit 0;; esac;',
    '[ "$1" = "$hivewardd_pid" ] || { echo NOT_RECORDED; exit 0; };',
    'hivewardd_sshd=$2; shift 2; hivewardd_want=$*;',
    // A ps that can't list this shell can't prove another process absent.
    'ps -o pid= -p "$$" >/dev/null 2>&1 || { echo UNVERIFIABLE; exit 0; };',
    'hivewardd_now=$(ps -o lstart= -p "$hivewardd_sshd" 2>/dev/null); hivewardd_now=$(echo $hivewardd_now);',
    // A reused PID with another start time is a different process: the session is gone.
    'if [ -z "$hivewardd_now" ] || [ "$hivewardd_now" != "$hivewardd_want" ]; then echo EXITED; else echo LIVE; fi'
  ].join(' ')
}

/** `not-recorded` covers older launches and clients: the condition is unknown, never assumed. */
export type HivewarddLaunchSshSession =
  | 'live'
  | 'exited'
  | 'unverifiable'
  | 'not-recorded'
  | 'not-applicable'

export function parseHivewarddLaunchSshSession(output: string): HivewarddLaunchSshSession {
  switch (output.trim().split('\n').pop()?.trim() ?? '') {
    case 'LIVE':
      return 'live'
    case 'EXITED':
      return 'exited'
    case 'NOT_RECORDED':
      return 'not-recorded'
    case 'NOT_APPLICABLE':
      return 'not-applicable'
    default:
      return 'unverifiable'
  }
}
