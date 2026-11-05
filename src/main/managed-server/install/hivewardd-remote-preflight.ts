import { randomUUID } from 'node:crypto'
import { HIVEWARDD_NODE_RUNTIME_IDENTITY } from '../../../shared/hivewardd-node-runtime-identity'
import { HIVEWARDD_NODE_RUNTIME_MARKER_FILENAME } from '../../../shared/hivewardd-artifacts'
import {
  HIVEWARDD_PROFILE_PREFLIGHT_FLAG,
  HIVEWARDD_PROFILE_PREFLIGHT_TIMEOUT_MS,
  parseHivewarddProfilePreflight,
  type HivewarddProfilePreflightResponse
} from '../../../shared/hivewardd-profile-preflight'
import { assertPosixHivewarddHost } from './hivewardd-remote-host-support'
import {
  hivewarddWindowsNodeCommandLine,
  hivewarddWindowsSlotOpCommand,
  readHivewarddWindowsEncodedAnswer
} from './hivewardd-remote-windows-node'
import { readWindowsHivewarddSlotEntry } from './hivewardd-remote-launch-windows'
import { HIVEWARDD_WINDOWS_RUNTIME_MARKER } from '../host-state/hivewardd-windows-host-script'
import { hivewarddNodeSlotRuntimeCommand, selectHivewarddSlotEntryCommand } from './hivewardd-remote-runtime'
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'
import type { HivewarddHostTransport } from '../../ssh/hivewardd-host-transport'

export function hivewarddProfilePreflightCommand(
  host: RemoteHostPlatform,
  directory: string,
  nonce: string,
  probeDaemonsUnder?: string
): string {
  assertPosixHivewarddHost(host)
  // New candidates always use pinned Node; host Node fallback could mask an incomplete slot.
  const marker = quotePosixShell(
    joinRemotePath(host, directory, HIVEWARDD_NODE_RUNTIME_MARKER_FILENAME)
  )
  const launch = [
    'HIVEWARD_BACKGROUND_LAUNCH=1',
    '"$hivewardd_runtime"',
    '"$hivewardd_entry"',
    HIVEWARDD_PROFILE_PREFLIGHT_FLAG,
    quotePosixShell(nonce),
    ...(probeDaemonsUnder === undefined ? [] : [quotePosixShell(probeDaemonsUnder)])
  ].join(' ')
  return `[ -e ${marker} ] || exit 78; ${hivewarddNodeSlotRuntimeCommand(host, directory)}${selectHivewarddSlotEntryCommand(host, directory)}; ${launch}`
}

/** Qualify the candidate; given the served data root, it also names the daemon generations alive there. */
export async function preflightInstalledHivewardd(options: {
  conn: HivewarddHostTransport
  host: RemoteHostPlatform
  remoteInstallDir: string
  probeDaemonsUnder?: string
  fullVersion: string
  signal?: AbortSignal
}): Promise<HivewarddProfilePreflightResponse> {
  const nonce = randomUUID()
  const command = isWindowsRemoteHost(options.host)
    ? await windowsHivewarddProfilePreflightCommand(options, nonce)
    : hivewarddProfilePreflightCommand(
        options.host,
        options.remoteInstallDir,
        nonce,
        options.probeDaemonsUnder
      )
  const output = await execCommand(options.conn, command, {
    signal: options.signal,
    timeoutMs: HIVEWARDD_PROFILE_PREFLIGHT_TIMEOUT_MS,
    wrapCommand: !isWindowsRemoteHost(options.host)
  })
  return parseHivewarddProfilePreflight(output, nonce, HIVEWARDD_NODE_RUNTIME_IDENTITY, options.fullVersion)
}

// Windows uses plain argv; hivewardd opens no window and needs no background-launch environment.
async function windowsHivewarddProfilePreflightCommand(
  options: {
    conn: HivewarddHostTransport
    host: RemoteHostPlatform
    remoteInstallDir: string
    probeDaemonsUnder?: string
    signal?: AbortSignal
  },
  nonce: string
): Promise<string> {
  const { host, remoteInstallDir } = options
  const slotAnswer = await execCommand(
    options.conn,
    hivewarddWindowsSlotOpCommand(host, remoteInstallDir, 'slot-runtime', [remoteInstallDir]),
    { signal: options.signal, wrapCommand: false }
  )
  const runtime = readHivewarddWindowsEncodedAnswer(slotAnswer, HIVEWARDD_WINDOWS_RUNTIME_MARKER)
  if (!runtime) {
    throw new Error('The Windows host did not name the runtime this hivewardd slot needs.')
  }
  return hivewarddWindowsNodeCommandLine(runtime, [
    readWindowsHivewarddSlotEntry(slotAnswer, host, remoteInstallDir),
    HIVEWARDD_PROFILE_PREFLIGHT_FLAG,
    nonce,
    ...(options.probeDaemonsUnder === undefined ? [] : [options.probeDaemonsUnder])
  ])
}
