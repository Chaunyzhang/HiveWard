import { HIVEWARDD_LAUNCHER_FILENAME } from '../../../shared/hivewardd-artifacts'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { execHivewarddRemote, type HivewarddRemoteExecTarget } from './hivewardd-remote-runtime-control'
import { hivewarddWindowsSlotOpCommand } from './hivewardd-remote-windows-node'
import { HIVEWARDD_BUILD_HASH_MARKER as BUILD_HASH_MARKER } from '../host-state/hivewardd-windows-host-script'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'

export async function readRemoteHivewarddBuildHash(
  target: HivewarddRemoteExecTarget,
  remoteInstallDir: string
): Promise<string> {
  const output = await execHivewarddRemote(
    target,
    remoteHivewarddBuildHashCommand(target.host, remoteInstallDir)
  )
  const match = output.match(new RegExp(`${BUILD_HASH_MARKER}\\s+([a-fA-F0-9]{16})`, 'u'))
  if (!match?.[1]) {
    throw new Error('Could not verify the installed hivewardd build hash.')
  }
  return match[1].toLowerCase()
}

export function remoteHivewarddBuildHashCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string
): string {
  if (isWindowsRemoteHost(host)) {
    return hivewarddWindowsSlotOpCommand(host, remoteInstallDir, 'build-hash', [
      joinRemotePath(host, remoteInstallDir, HIVEWARDD_LAUNCHER_FILENAME)
    ])
  }
  const path = quotePosixShell(joinRemotePath(host, remoteInstallDir, HIVEWARDD_LAUNCHER_FILENAME))
  // GNU/BusyBox provide sha256sum, macOS shasum; both print the digest first.
  return [
    `[ -f ${path} ] && [ -r ${path} ] || exit 1;`,
    `hiveward_hash=$(if command -v sha256sum >/dev/null 2>&1; then sha256sum ${path} | awk '{print $1}';`,
    `elif command -v shasum >/dev/null 2>&1; then shasum -a 256 ${path} | awk '{print $1}'; fi);`,
    `case "$hiveward_hash" in [0-9a-fA-F][0-9a-fA-F]*) printf '%s %.16s\\n' ${quotePosixShell(BUILD_HASH_MARKER)} "$hiveward_hash";; esac`
  ].join(' ')
}
