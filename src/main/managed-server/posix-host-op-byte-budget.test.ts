import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPosixStdoutFence } from '../../shared/posix-stdout-fence'
import type { NodeRuntimeTarget } from '../../shared/node-runtime-pin'
import { initialHivewarddActivationAdmissionCommand } from '../ssh/hivewardd-initial-activation-admission'
import {
  captureHivewarddLaunchSshSessionCommand,
  hivewarddLaunchSshSessionProbeCommand,
  writeHivewarddLaunchSshSessionCommand
} from '../ssh/hivewardd-launch-ssh-session'
import { makeExecStdinWriteFileCommand } from '../ssh/ssh-exec-stdin-file-transfer'
import { wrapRemoteCommandForPosixShell } from '../ssh/ssh-posix-command-wrapper'
import {
  listRemoteInstallBaseDirsCommand,
  moveRemoteTreeCommand,
  probeFileExistsCommand,
  probeRemoteInstallCompleteCommand,
  readRemoteHomeCommand,
  removeRemoteFileCommand,
  removeRemoteTreeCommand,
  restoreRemoteTreeCommand,
  writeRemoteEmptyFileCommand
} from '../ssh/ssh-remote-commands'
import { getRemoteHostPlatform, type RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { makePosixWriteFileCommand } from '../ssh/system-transport/system-ssh-file-binary-transfer'
import {
  posixHivewarddFenceGuard,
  runWithHivewarddFence,
  type HivewarddFence
} from './activation/hivewardd-activation-fence-scope'
import { posixReleaseFenceCommand } from './activation/hivewardd-activation-lock'
import {
  captureHivewarddStateSnapshotCommand,
  clearHivewarddStateSnapshotMembersCommand,
  compareHivewarddStateSnapshotCommand,
  probeHivewarddStateSnapshotCommand,
  restoreHivewarddStateSnapshotCommand,
  serializedStateMutationCommand
} from './host-state/hivewardd-state-snapshot'
import { newestStateMtimeCommand } from './host-state/hivewardd-state-newest-mtime'
import { hivewarddSnapshotSpaceCommand } from './host-state/hivewardd-state-snapshot-space'
import { posixProcessGroupCommand } from './host-state/hivewardd-state-mutation-owner-record'
import { hivewarddMachineClaimCommand } from './host-state/hivewardd-machine-claim-command'
import { hivewarddMachineHomeProbeCommand } from './host-state/hivewardd-machine-home'
import { executablePermissionsCommand } from './install/hivewardd-remote-install'
import {
  hivewarddNodeSlotRuntimeCommand,
  selectHivewarddSlotEntryCommand,
  selectHivewarddSlotRuntimeCommand
} from './install/hivewardd-remote-runtime'
import {
  hivewarddLaunchCommand,
  hivewarddLivenessProbeCommand,
  readHivewarddReadinessCommand
} from './install/hivewardd-remote-launch'
import {
  createExecProbedStageCommand,
  installNodeRuntimeFromHostArchiveCommand,
  probeRemoteNodeRuntimeCommand,
  promoteRemoteNodeRuntimeCommand,
  recheckAndPromoteRemoteNodeRuntimeCommand,
  remoteNodeRuntimePresentCommand
} from './install/hivewardd-remote-node-runtime'
import { remoteSha256Command } from './install/remote-sha256-command'
import { hostDownloadNodeRuntimeCommand } from './install/remote-node-runtime-host-download'
import { remoteHivewarddBuildHashCommand } from './install/hivewardd-remote-build-hash'
import { remoteFreeSpaceProbeCommand } from './install/remote-install-out-of-space'
import { sweepStaleRuntimeStagesCommand } from './install/remote-node-runtime-store-gc'
import { hivewarddProfilePreflightCommand } from './install/hivewardd-remote-preflight'
import {
  recordedNodeRuntimeProbeCommand,
  recordedRemoteNodeRuntimeProbeCommand
} from './install/hivewardd-remote-node-runtime-recorded-probe'
import { runtimeStoreInventoryCommand } from './install/remote-node-runtime-store-inventory'
import { cachedHivewarddSlotProbeCommand } from './install/hivewardd-remote-install-cached-probe'
import { posixReleaseOwnedLockCommand } from './install/remote-node-runtime-store-lock'
import { HIVEWARDD_INSTALL_MODEL } from './install/remote-install-model'
import { stopHivewarddCommand } from './install/hivewardd-remote-process-control'
import {
  acquireInstallLockParentCommand,
  lockAgeSecondsCommand,
  orphanInstallLockCommand,
  probeInstallLockExistsCommand,
  tryCreateInstallLockCommand,
  tryStealInstallLockCommand
} from './install/remote-install-lock-commands'
import { hivewarddLogTailCommand } from './install/hivewardd-remote-log-tail'
import {
  hivewarddReadinessWaitCommand,
  readHivewarddReadinessNowCommand
} from './install/hivewardd-remote-readiness-wait'
import {
  hivewarddBashStdioBridgeCommand,
  hivewarddPosixStdioBridgeCommand
} from './lifecycle/hivewardd-stdio-bridge-script'

// Gateways truncate near 10 KB (#30491); bound uncompressed, fenced commands to 6 KB.
const POSIX_HOST_OP_BYTE_BUDGET = 6 * 1024

const OVER_BUDGET_CEILINGS: Readonly<Record<string, number>> = {
  hivewarddMachineClaimCommand: 6_265,
  tryStealInstallLockCommand: 9_222,
  hivewarddLaunchCommand: 7_431,
  // WSL-only: wsl.exe argv, never SSH-framed; carries the Node bridge as its fallback.
  hivewarddBashStdioBridgeCommand: 6_330,
  // WSL-only (sent only under recordedNodeRuntimeProbe): wsl.exe argv, never SSH-framed.
  cachedHivewarddSlotProbeCommand: 7_209
}

type HostCase = { host: RemoteHostPlatform; target: NodeRuntimeTarget; nodePath: string }

const home = `/net/nfs-home-cluster-03/users/engineering/${'a'.repeat(48)}.longname`
const baseDir = `${home}/.hiveward-remote`
const slotDir = `${baseDir}/hivewardd-1.4.299-rc.12+${'f'.repeat(40)}`
const userDataDir = `${baseDir}/hivewardd-data`
const snapshotDir = `${baseDir}/hivewardd-snapshots/pre-1.4.299-rc.12-1760000000000`
const installLock = `${slotDir}.install-lock`
const token = 'f'.repeat(64)
const fence: HivewarddFence = { lockDir: `${baseDir}/hivewardd-activation.lock`, token }
const owner = { fileName: 'owner', token }

function hostCase(platform: 'linux-x64' | 'darwin-arm64', target: NodeRuntimeTarget): HostCase {
  const nodePath = `${baseDir}/node-runtimes/v22.20.0-${target}/bin/node`
  return { host: getRemoteHostPlatform(platform), target, nodePath }
}

const HOST_CASES: readonly HostCase[] = [
  hostCase('linux-x64', 'linux-x64-glibc'),
  hostCase('darwin-arm64', 'darwin-arm64')
]

function launchSpec(nodePath: string): Parameters<typeof hivewarddLaunchCommand>[1] {
  return {
    remoteInstallDir: slotDir,
    nodePath,
    fullVersion: '1.4.299-rc.12',
    userDataDir,
    bindHost: '127.0.0.1',
    port: 65535,
    activationRoot: `${baseDir}/hivewardd-activation`
  }
}

function promoteArgs({
  nodePath,
  target
}: HostCase): Parameters<typeof promoteRemoteNodeRuntimeCommand>[1] {
  return {
    stageDir: `${nodePath}.stage-${token}`,
    archive: `${baseDir}/node-runtimes/archive.tar.xz`,
    runtimeDir: nodePath,
    target,
    token
  }
}

const BUILDERS: Readonly<Record<string, (c: HostCase) => string>> = {
  serializedStateMutationCommand: () => serializedStateMutationCommand(baseDir, ':', 20, fence),
  captureHivewarddStateSnapshotCommand: ({ host }) =>
    captureHivewarddStateSnapshotCommand(host, userDataDir, snapshotDir, baseDir, {
      snapshotsRoot: `${baseDir}/hivewardd-snapshots`,
      keep: [snapshotDir.slice(snapshotDir.lastIndexOf('/') + 1), 'pre-1.4.298-rc.3-1750000000000']
    }),
  probeHivewarddStateSnapshotCommand: ({ host }) =>
    probeHivewarddStateSnapshotCommand(host, snapshotDir, baseDir),
  restoreHivewarddStateSnapshotCommand: ({ host }) =>
    restoreHivewarddStateSnapshotCommand(host, userDataDir, snapshotDir, baseDir),
  clearHivewarddStateSnapshotMembersCommand: ({ host }) =>
    clearHivewarddStateSnapshotMembersCommand(host, userDataDir, baseDir),
  compareHivewarddStateSnapshotCommand: ({ host }) =>
    compareHivewarddStateSnapshotCommand(host, userDataDir, snapshotDir, baseDir),
  newestStateMtimeCommand: ({ host }) => newestStateMtimeCommand(host, userDataDir, baseDir),
  hivewarddSnapshotSpaceCommand: ({ host }) =>
    hivewarddSnapshotSpaceCommand(host, userDataDir, snapshotDir, baseDir, ['keep-a', 'keep-b']) ?? '',
  posixProcessGroupCommand: () => posixProcessGroupCommand('"$pid"'),
  hivewarddMachineClaimCommand: ({ host }) => hivewarddMachineClaimCommand(host, home, 'k'.repeat(64)),
  hivewarddMachineHomeProbeCommand: ({ host }) => hivewarddMachineHomeProbeCommand(host),
  selectHivewarddSlotEntryCommand: ({ host }) => selectHivewarddSlotEntryCommand(host, slotDir),
  hivewarddNodeSlotRuntimeCommand: ({ host }) => hivewarddNodeSlotRuntimeCommand(host, slotDir),
  selectHivewarddSlotRuntimeCommand: ({ host, nodePath }) =>
    selectHivewarddSlotRuntimeCommand(host, slotDir, nodePath),
  // macOS launch embeds SSH-session capture and attribution records.
  hivewarddLaunchCommand: ({ host, nodePath }) =>
    hivewarddLaunchCommand(host, launchSpec(nodePath), 'nohup', []),
  'hivewarddLaunchCommand (WSL setsid)': ({ host, nodePath }) =>
    hivewarddLaunchCommand(host, launchSpec(nodePath), 'setsid', [
      ['HIVEWARD_EXAMPLE_HOST_ENV', 'x'.repeat(200)]
    ]),
  readHivewarddReadinessCommand: ({ host }) => readHivewarddReadinessCommand(host, slotDir),
  hivewarddLivenessProbeCommand: ({ host }) => hivewarddLivenessProbeCommand(host, slotDir),
  remoteSha256Command: ({ nodePath }) => remoteSha256Command(`'${nodePath}'`),
  remoteFreeSpaceProbeCommand: ({ nodePath }) => remoteFreeSpaceProbeCommand(nodePath),
  hostDownloadNodeRuntimeCommand: ({ host, nodePath, target }) =>
    hostDownloadNodeRuntimeCommand(host, { stageDir: `${nodePath}.stage-${token}`, target }),
  createExecProbedStageCommand: ({ host, nodePath }) =>
    createExecProbedStageCommand(host, `${nodePath}.stage-${token}`),
  probeRemoteNodeRuntimeCommand: ({ host, nodePath, target }) =>
    probeRemoteNodeRuntimeCommand(host, nodePath, target),
  remoteNodeRuntimePresentCommand: ({ host, nodePath }) =>
    remoteNodeRuntimePresentCommand(host, nodePath, true),
  promoteRemoteNodeRuntimeCommand: (c) => promoteRemoteNodeRuntimeCommand(c.host, promoteArgs(c)),
  recheckAndPromoteRemoteNodeRuntimeCommand: (c) =>
    recheckAndPromoteRemoteNodeRuntimeCommand(c.host, promoteArgs(c)),
  installNodeRuntimeFromHostArchiveCommand: ({ host, nodePath, target }) =>
    installNodeRuntimeFromHostArchiveCommand(host, {
      runtimeDir: nodePath,
      archive: `${baseDir}/node-runtimes/archive.tar.xz`,
      target,
      token
    }),
  remoteHivewarddBuildHashCommand: ({ host }) => remoteHivewarddBuildHashCommand(host, slotDir),
  sweepStaleRuntimeStagesCommand: ({ host }) =>
    sweepStaleRuntimeStagesCommand(`${baseDir}/node-runtimes`, host),
  hivewarddProfilePreflightCommand: ({ host }) =>
    hivewarddProfilePreflightCommand(host, slotDir, token, userDataDir),
  recordedNodeRuntimeProbeCommand: ({ host, nodePath }) =>
    recordedNodeRuntimeProbeCommand(host, nodePath, token),
  recordedRemoteNodeRuntimeProbeCommand: ({ host, nodePath, target }) =>
    recordedRemoteNodeRuntimeProbeCommand(host, nodePath, target),
  runtimeStoreInventoryCommand: ({ host }) => runtimeStoreInventoryCommand(host, home),
  stopHivewarddCommand: ({ host, nodePath }) =>
    stopHivewarddCommand(host, slotDir, { waitSeconds: 30, nodePath }),
  acquireInstallLockParentCommand: ({ host }) => acquireInstallLockParentCommand(host, baseDir),
  tryCreateInstallLockCommand: ({ host }) => tryCreateInstallLockCommand(host, installLock, owner),
  probeInstallLockExistsCommand: ({ host }) => probeInstallLockExistsCommand(host, installLock),
  lockAgeSecondsCommand: ({ host }) => lockAgeSecondsCommand(host, installLock),
  orphanInstallLockCommand: ({ host }) => orphanInstallLockCommand(host, installLock),
  tryStealInstallLockCommand: ({ host }) =>
    tryStealInstallLockCommand(host, installLock, 120, owner, {
      ...owner,
      quietSeconds: 60,
      mutationLock: `${baseDir}/hivewardd-state-mutation.lock`
    }),
  hivewarddLogTailCommand: ({ host }) => hivewarddLogTailCommand(host, slotDir),
  hivewarddReadinessWaitCommand: ({ host }) => hivewarddReadinessWaitCommand(host, slotDir, 120),
  readHivewarddReadinessNowCommand: ({ host }) => readHivewarddReadinessNowCommand(host, slotDir),
  hivewarddPosixStdioBridgeCommand: () => hivewarddPosixStdioBridgeCommand(65535),
  hivewarddBashStdioBridgeCommand: () => hivewarddBashStdioBridgeCommand(65535),
  posixReleaseFenceCommand: () =>
    posixReleaseFenceCommand(
      fence,
      `${baseDir}/hivewardd-activation/journal.json`,
      `${baseDir}/hivewardd-activation`
    ),
  posixReleaseOwnedLockCommand: ({ host }) =>
    `${posixReleaseOwnedLockCommand(host, `${baseDir}/node-runtimes/.store-lock`, owner)} || true`,
  executablePermissionsCommand: ({ host, target }) =>
    executablePermissionsCommand(host, slotDir, target),
  readRemoteHomeCommand: ({ host }) => readRemoteHomeCommand(host),
  removeRemoteFileCommand: ({ host }) => removeRemoteFileCommand(host, `${slotDir}/.hivewardd-pid`),
  removeRemoteTreeCommand: ({ host }) => removeRemoteTreeCommand(host, slotDir),
  moveRemoteTreeCommand: ({ host }) =>
    moveRemoteTreeCommand(host, slotDir, `${slotDir}.trash-${token}`),
  restoreRemoteTreeCommand: ({ host }) =>
    restoreRemoteTreeCommand(host, `${slotDir}.trash-${token}`, slotDir),
  writeRemoteEmptyFileCommand: ({ host }) =>
    writeRemoteEmptyFileCommand(host, `${slotDir}/.complete`),
  probeRemoteInstallCompleteCommand: ({ host }) =>
    probeRemoteInstallCompleteCommand(host, slotDir, [
      ...HIVEWARDD_INSTALL_MODEL.requiredArtifacts(host),
      HIVEWARDD_INSTALL_MODEL.installCompleteFilename
    ]),
  cachedHivewarddSlotProbeCommand: ({ host, target }) =>
    cachedHivewarddSlotProbeCommand(host, slotDir, target),
  listRemoteInstallBaseDirsCommand: ({ host }) =>
    listRemoteInstallBaseDirsCommand(host, baseDir, HIVEWARDD_INSTALL_MODEL),
  probeFileExistsCommand: ({ host }) => probeFileExistsCommand(host, `${slotDir}/.complete`),
  captureHivewarddLaunchSshSessionCommand: () => captureHivewarddLaunchSshSessionCommand(),
  writeHivewarddLaunchSshSessionCommand: ({ host }) =>
    writeHivewarddLaunchSshSessionCommand(host, userDataDir),
  hivewarddLaunchSshSessionProbeCommand: ({ host }) =>
    hivewarddLaunchSshSessionProbeCommand(host, slotDir, userDataDir),
  initialHivewarddActivationAdmissionCommand: ({ host, nodePath }) =>
    initialHivewarddActivationAdmissionCommand(host, userDataDir, slotDir, nodePath),
  makeExecStdinWriteFileCommand: () =>
    makeExecStdinWriteFileCommand(`${slotDir}/hivewardd.js`, Number.MAX_SAFE_INTEGER, {
      token,
      executable: true
    }),
  makePosixWriteFileCommand: () =>
    makePosixWriteFileCommand(`${slotDir}/hivewardd.js`, { exclusive: true })
}

const NOT_POSIX_HOST_OPS: Readonly<Record<string, string>> = {
  powerShellCommand: 'builds the Windows PowerShell exec line',
  spawnProxyCommand: 'spawns a local ProxyCommand process',
  buildSshLoginShellCommand: 'wraps a caller-built op in the login shell',
  isSnapshotCaptureCommand: 'a predicate over a command, not a builder',
  execCommand: 'the exec entry point every measured op goes through',
  execHostCommand: 'the exec entry point every measured op goes through',
  spawnSystemSshCommand: 'spawns the local ssh client'
}

// Legacy relay retires 2027-01-15; exclude its host operations.
const SCANNED_DIRS = [
  ...['host-state', 'install', 'lifecycle', 'activation'].map((dir) => join(__dirname, dir)),
  join(__dirname, '..', 'ssh'),
  ...['system-transport', 'connection', 'remote-exec'].map((dir) =>
    join(__dirname, '..', 'ssh', dir)
  )
]

function exportedCommandBuilders(): string[] {
  const names: string[] = []
  for (const root of SCANNED_DIRS) {
    for (const file of readdirSync(root)) {
      if (
        !file.endsWith('.ts') ||
        /\.test(-fixture)?\.ts$/.test(file) ||
        file.endsWith('.spec.ts')
      ) {
        continue
      }
      if (/windows/i.test(file)) {
        continue
      }
      const source = readFileSync(join(root, file), 'utf8')
      for (const match of source.matchAll(/^export (?:async )?function (\w+Command)\(/gm)) {
        names.push(match[1])
      }
    }
  }
  return names.sort()
}

// Measure the largest POSIX command, including guards even for optionally fenced operations.
async function sentBytes(build: (c: HostCase) => string): Promise<number> {
  let max = 0
  for (const c of HOST_CASES) {
    const command = await runWithHivewarddFence(fence, async () => build(c))
    // Match exec stdout framing; real nonces are at most 16 characters.
    const framed = buildPosixStdoutFence(
      `${posixHivewarddFenceGuard(fence)} ${command}`,
      'SSH',
      'z'.repeat(16)
    ).command
    const sent = wrapRemoteCommandForPosixShell(framed, { compress: false })
    max = Math.max(max, Buffer.byteLength(sent, 'utf8'))
  }
  return max
}

describe('POSIX host-op byte budget', () => {
  it('measures every exported POSIX host-op builder', () => {
    const unmeasured = exportedCommandBuilders().filter(
      (name) => !(name in BUILDERS) && !(name in NOT_POSIX_HOST_OPS)
    )
    expect(unmeasured).toEqual([])
  })

  it.each(Object.keys(BUILDERS))('%s stays under the sent byte budget', async (name) => {
    const bytes = await sentBytes(BUILDERS[name])
    const ceiling = OVER_BUDGET_CEILINGS[name]
    if (ceiling === undefined) {
      expect(bytes).toBeLessThanOrEqual(POSIX_HOST_OP_BYTE_BUDGET)
      return
    }
    expect(bytes).toBeGreaterThan(POSIX_HOST_OP_BYTE_BUDGET)
    expect(bytes).toBeLessThanOrEqual(ceiling)
  })
})
