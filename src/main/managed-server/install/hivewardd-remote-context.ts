import type { NodeRuntimeTarget } from '../../../shared/node-runtime-pin'
import type { SshTarget } from '../../../shared/ssh-types'
import type { HivewarddActivationRecord } from '../activation/hivewardd-activation-record'
import { readHivewarddActivationRecord } from '../activation/hivewardd-activation-record-store'
import { resolveHivewarddRuntimeTarget } from '../lifecycle/hivewardd-runtime-target'
import { LINUX_LIBC_FIRST_PROBE } from '../../node-runtime/linux-libc-probe'
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { prepareWindowsHivewarddHost } from '../host-state/hivewardd-windows-host-preparation'
import {
  isWslHivewarddHostTarget,
  type HivewarddHostTarget,
  type HivewarddHostTransport
} from '../../ssh/hivewardd-host-transport'
import {
  decideHivewarddMachineHome,
  hivewarddMachineDataRoot,
  hivewarddMachineHomeDir,
  hivewarddMachineHomeProbeCommand,
  hivewarddMachineOwnershipUnresolvedMessage,
  parseHivewarddMachineHomeProbe
} from '../host-state/hivewardd-machine-home'
import {
  hivewarddMachineClaimCommand,
  readHivewarddMachineClaimAnswer
} from '../host-state/hivewardd-machine-claim-command'
import { execHivewarddRemote, type HivewarddRemoteExecTarget } from './hivewardd-remote-runtime-control'
import { readRemoteHomeCommand } from '../../ssh/ssh-remote-commands'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  normalizeRemoteHome,
  validateRemoteHome,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'
import { detectRemoteHostPlatform } from '../../ssh/ssh-remote-platform-detection'
import { HivewarddHostUnsupportedError } from '../../hivewardd/hivewardd-host-unavailable'
import { rememberSshHostPlatform } from '../../ssh/ssh-host-platform-memo'

/** Default SSH generic retains compatibility with lifecycle consumers requiring SSH-only fields. */
export type HivewarddRemoteContext<Target extends HivewarddHostTarget = SshTarget> = {
  activationRecord: HivewarddActivationRecord
  /** Select a compatible runtime when host glibc is below the default pin's floor. */
  serverTarget: NodeRuntimeTarget
  connection: HivewarddHostTransport
  host: RemoteHostPlatform
  /** Login or machine-specific home for shared-home isolation; userDataDir must follow the same owner. */
  remoteHome: string
  target: Target
  userDataDir: string
}

export async function resolveHivewarddRemoteContext<Target extends HivewarddHostTarget = SshTarget>(
  target: Target,
  connection: HivewarddHostTransport,
  signal?: AbortSignal,
  detectedHost?: RemoteHostPlatform,
  /**
   * Facts the caller already read on this host. `loginHome` serves only login-home placement;
   * `firstLibcProbeOutput` answers the libc probe's first command, whose fallbacks still run.
   */
  known: {
    loginHome?: string
    firstLibcProbeOutput?: string
    /** Replaces the plain activation record read; WSL reads its connect snapshot here. */
    readActivationRecord?: (
      target: HivewarddRemoteExecTarget & { remoteHome: string; userDataDir: string }
    ) => Promise<HivewarddActivationRecord>
  } = {}
): Promise<HivewarddRemoteContext<Target>> {
  const host = detectedHost ?? (await detectRemoteHostPlatform(connection, { signal }))
  if (!host) {
    throw new HivewarddHostUnsupportedError(
      isWslHivewarddHostTarget(target)
        ? 'HiveWard’s server doesn’t support this WSL distro’s platform. Use an x64 or arm64 Linux distro.'
        : 'HiveWard’s server doesn’t support this SSH host’s platform.'
    )
  }
  const remote = { conn: connection, host, signal }
  const { hivewarddHome: remoteHome, userDataDir } = await resolveHivewarddMachineHome(
    remote,
    !isWslHivewarddHostTarget(target),
    known.loginHome
  )
  let firstLibcProbeOutput = known.firstLibcProbeOutput
  const serverTarget = await resolveHivewarddRuntimeTarget({
    conn: connection,
    host,
    signal,
    ...(firstLibcProbeOutput === undefined
      ? {}
      : {
          exec: async (command: string) => {
            if (command === LINUX_LIBC_FIRST_PROBE && firstLibcProbeOutput !== undefined) {
              const output = firstLibcProbeOutput
              firstLibcProbeOutput = undefined
              return output
            }
            // The fallbacks run exactly as the default exec would.
            return execCommand(connection, command, { signal })
          }
        })
  })
  if (!isWslHivewarddHostTarget(target)) {
    rememberSshHostPlatform(target.id, host, serverTarget)
  }
  if (isWindowsRemoteHost(host)) {
    // Prepare pinned Node before even reading activation state on Windows.
    await prepareWindowsHivewarddHost({
      conn: connection,
      host,
      remoteHome,
      serverTarget,
      signal
    })
  }
  const activationRecord = await (known.readActivationRecord ?? readHivewarddActivationRecord)({
    ...remote,
    remoteHome,
    userDataDir
  })
  return {
    activationRecord,
    serverTarget,
    connection,
    host,
    remoteHome,
    target,
    userDataDir
  }
}

/** Resolve per-machine state for shared POSIX homes; Windows and WSL retain login-home placement. */
export async function resolveHivewarddMachineHome(
  remote: HivewarddRemoteExecTarget,
  keyByMachine: boolean,
  knownLoginHome?: string
): Promise<{ loginHome: string; hivewarddHome: string; userDataDir: string }> {
  const { host } = remote
  if (!keyByMachine || isWindowsRemoteHost(host)) {
    const loginHome = normalizeRemoteHome(
      knownLoginHome ?? (await execHivewarddRemote(remote, readRemoteHomeCommand(host))),
      host
    )
    if (!validateRemoteHome(loginHome, host)) {
      throw new Error(`Remote home is not a valid path: ${loginHome.slice(0, 100)}`)
    }
    return {
      loginHome,
      hivewarddHome: loginHome,
      userDataDir: joinRemotePath(host, loginHome, '.hiveward')
    }
  }
  const probe = parseHivewarddMachineHomeProbe(
    await execHivewarddRemote(remote, hivewarddMachineHomeProbeCommand(host)),
    host
  )
  const { loginHome } = probe
  let decision = decideHivewarddMachineHome(probe, host)
  if (decision.kind === 'unresolved') {
    throw new Error(
      hivewarddMachineOwnershipUnresolvedMessage(
        decision.machineKey,
        probe.identity?.hostname ?? null,
        decision.cause
      )
    )
  }
  if (decision.kind === 'claim') {
    const won = readHivewarddMachineClaimAnswer(
      await execHivewarddRemote(remote, hivewarddMachineClaimCommand(host, loginHome, decision.machineKey))
    )
    if (won.state !== 'present') {
      throw new Error(won.message)
    }
    decision =
      won.machineKey === decision.machineKey
        ? { kind: 'login-home' }
        : { kind: 'machine-home', machineKey: decision.machineKey }
  }
  if (decision.kind === 'login-home') {
    return {
      loginHome,
      hivewarddHome: loginHome,
      userDataDir: joinRemotePath(host, loginHome, '.hiveward')
    }
  }
  const hivewarddHome = hivewarddMachineHomeDir(host, loginHome, decision.machineKey)
  await execHivewarddRemote(remote, `umask 077; mkdir -p ${quotePosixShell(hivewarddHome)}`)
  return {
    loginHome,
    hivewarddHome,
    userDataDir: hivewarddMachineDataRoot(host, loginHome, decision.machineKey)
  }
}
