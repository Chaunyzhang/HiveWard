import { randomUUID } from 'node:crypto'
import { hivewarddNodePtyNativeArtifacts, hivewarddRipgrepArtifact } from '../../../shared/hivewardd-artifacts'
import { hivewarddAgentBrowserNativeName } from '../../../shared/hivewardd-agent-browser-name'
import type { NodeRuntimeTarget } from '../../../shared/node-runtime-pin'
import { ensureRemoteHivewarddNodeRuntime } from './hivewardd-remote-node-runtime'
import { recordedRemoteNodeRuntimeProbeCommand } from './hivewardd-remote-node-runtime-recorded-probe'
import { cachedHivewarddSlotInstalled } from './hivewardd-remote-install-cached-probe'
import {
  execCommand,
  isUnconfirmedSshCommandTermination
} from '../../ssh/remote-exec/remote-exec-command'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import type { HivewarddHostTransport } from '../../ssh/hivewardd-host-transport'
import { joinRemotePath, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { HIVEWARDD_INSTALL_MODEL } from './remote-install-model'
import { acquireInstallLock } from './remote-install-lock'
import { HIVEWARDD_FENCE_OWNER_FILENAME } from '../activation/hivewardd-activation-fence-scope'
import { forgetHeldHivewarddFence, rememberHeldHivewarddFence } from '../../ssh/hivewardd-held-fence-tokens'
import { exitedOwnLockProof } from '../../ssh/hivewardd-exited-own-lock'
import { hivewarddWindowsBaseDir } from './hivewardd-remote-windows-node'
import { uploadRemoteInstallDirectory, writeRemoteInstallFile } from './remote-install-transfers'
import {
  abandonInstall,
  finalizeInstall,
  isRemoteInstallComplete
} from './remote-versioned-install'

export async function installHivewarddBundle(
  options: {
    conn: HivewarddHostTransport
    host: RemoteHostPlatform
    localHivewarddDir: string
    target: NodeRuntimeTarget
    /** Lazily acquire verified runtime bytes only if the host needs them. */
    nodeRuntimeArchive: () => Promise<string>
    /** Offline archive location named when downloads fail. */
    nodeRuntimeOfflineArchivePath?: string
    /** Per-source connect budget for the host's own download fallback. */
    nodeRuntimeHostConnectTimeoutSeconds?: number
    /** WSL opt-in: reuse a matching stat signature previously hashed to this pin. */
    recordedNodeRuntimeProbe?: boolean
    signal?: AbortSignal
  },
  fullVersion: string,
  remoteDir: string
): Promise<void> {
  if (options.recordedNodeRuntimeProbe && (await cachedHivewarddSlotInstalled(options, remoteDir))) {
    return
  }
  // Existing slot bytes are unusable without their referenced runtime.
  await ensureRemoteHivewarddNodeRuntime({
    conn: options.conn,
    host: options.host,
    slotDir: remoteDir,
    target: options.target,
    archivePath: options.nodeRuntimeArchive,
    offlineArchivePath: options.nodeRuntimeOfflineArchivePath,
    hostConnectTimeoutSeconds: options.nodeRuntimeHostConnectTimeoutSeconds,
    signal: options.signal,
    ...(options.recordedNodeRuntimeProbe
      ? { posixProbeCommand: recordedRemoteNodeRuntimeProbeCommand }
      : {})
  })
  if (
    await isRemoteInstallComplete(options.conn, HIVEWARDD_INSTALL_MODEL, remoteDir, options.host, {
      signal: options.signal
    })
  ) {
    return
  }
  // Persist the token so a relaunch can prove ownership of an interrupted upload lock.
  const token = randomUUID()
  rememberHeldHivewarddFence(token)
  try {
    await acquireInstallLock(options.conn, remoteDir, options.host, {
      signal: options.signal,
      owner: { fileName: HIVEWARDD_FENCE_OWNER_FILENAME, token },
      // SFTP uploads and chmod leave no host workload after this client exits.
      exitedOwner: exitedOwnLockProof(options, {
        baseDir: hivewarddWindowsBaseDir(options.host, remoteDir),
        guardsStateMutation: false
      })
    })
  } catch (error) {
    if (!isUnconfirmedSshCommandTermination(error)) {
      forgetHeldHivewarddFence(token)
    }
    throw error
  }
  let preserveInstallLock = false
  try {
    // A sibling may have completed deployment while this client waited for the lock.
    if (
      await isRemoteInstallComplete(options.conn, HIVEWARDD_INSTALL_MODEL, remoteDir, options.host, {
        signal: options.signal
      })
    ) {
      return
    }
    await uploadRemoteInstallDirectory(
      options.conn,
      options.localHivewarddDir,
      remoteDir,
      options.host,
      {
        signal: options.signal
      }
    )
    if (options.host.os !== 'win32') {
      await execCommand(
        options.conn,
        executablePermissionsCommand(options.host, remoteDir, options.target),
        {
          wrapCommand: options.host.commandDialect !== 'powershell',
          signal: options.signal
        }
      )
    }
    await writeRemoteInstallFile(
      options.conn,
      options.host,
      joinRemotePath(options.host, remoteDir, HIVEWARDD_INSTALL_MODEL.versionFilename),
      fullVersion,
      { signal: options.signal }
    )
    await finalizeInstall(options.conn, remoteDir, options.host, {
      signal: options.signal,
      releaseLock: false
    })
  } catch (error) {
    preserveInstallLock = isUnconfirmedSshCommandTermination(error)
    throw error
  } finally {
    if (!preserveInstallLock) {
      // Retain ownership proof if interrupted cleanup cannot confirm lock removal.
      if (await abandonInstall(options.conn, remoteDir, options.host)) {
        forgetHeldHivewarddFence(token)
      }
    }
  }
}

export function executablePermissionsCommand(
  host: RemoteHostPlatform,
  directory: string,
  target: NodeRuntimeTarget
): string {
  const required = [hivewarddRipgrepArtifact(target), ...hivewarddNodePtyNativeArtifacts(target)]
    .filter((artifact) => /\/(?:rg|spawn-helper)$/.test(artifact))
    .map((artifact) => joinRemotePath(host, directory, ...artifact.split('/')))
  const browsers = new Set(
    (['glibc', 'musl'] as const).map((libc) =>
      quotePosixShell(
        joinRemotePath(host, directory, hivewarddAgentBrowserNativeName(host.os, host.arch, libc))
      )
    )
  )
  // Restore executable modes lost by SFTP; absent optional browser binaries remain supported.
  return (
    `chmod 755 ${required.map(quotePosixShell).join(' ')} && ` +
    `for executable in ${[...browsers].join(' ')}; do ` +
    'if [ -f "$executable" ]; then chmod 755 "$executable" || exit $?; fi; done'
  )
}
