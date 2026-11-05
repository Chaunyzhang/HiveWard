/**
 * #34823 end to end in-process: the real WSL hivewardd launch admission against a real move run of
 * the WSL move driver over a real hivewardd profile store (the fault-injection rig). An update or a
 * connect's activation of the host's server attempted after the move has journaled its cutover is
 * held with the "moving onto this server" outcome; once the move settles (moved, failed,
 * cancelled, or killed mid-run and recovered on relaunch) the same update deploys.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { setAppEnvironment } from '../../shared/app-environment'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../shared/wsl-host-internal-gate'
import { HIVEWARDD_UPDATE_WSL_MOVE_RUNNING_CODE } from '../../shared/wsl-host-types'
import type { WslMoveResult } from '../../shared/wsl-move/wsl-move-driver-types'
import type { HivewarddActivationRecord } from '../managed-server/activation/hivewardd-activation-record'
import { resetHivewarddUpdateFailuresForTests } from '../managed-server/lifecycle/hivewardd-managed-update-failure-memory'
import type * as ActiveProbe from './wsl-hivewardd-active-probe'
import type * as ManagedRuntimeContext from '../managed-server/lifecycle/hivewardd-managed-runtime-context'
import type * as RemoteVersionedInstall from '../managed-server/install/remote-versioned-install'
import { testState } from '../persistence/persistence-test-harness'
import {
  createWslMoveKillRig,
  removeWslMoveRigDirs,
  restartWslMoveRig,
  WSL_MOVE_RIG_REQUEST,
  wslMoveRigOutcome,
  type WslMoveRig
} from '../persistence/__fixtures__/wsl-mover/wsl-move-kill-rig'
import { resetWslMoveDesktopRewriteStoresForTests } from '../persistence/moving-wsl-projects/wsl-move-desktop-rewrite-stores'
import { moveProjectsToWslHost } from '../persistence/moving-wsl-projects/wsl-move-driver'
import {
  cancelWslMove,
  isWslMoveRunning,
  isWslMoveUnderwayOnHost
} from '../persistence/moving-wsl-projects/wsl-move-running-moves'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import type { HivewarddHostTransport } from '../ssh/hivewardd-host-transport'
import type { WslDistroHolder } from './wsl-distro-holder'
import type { WslHivewarddHostTarget } from './wsl-hivewardd-host-target'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

// The host side of the server launch: every call into the distro is faked at its module.
const host = vi.hoisted(() => ({
  exec: vi.fn(),
  resolveContext: vi.fn(),
  deploy: vi.fn(),
  probe: vi.fn(),
  adoptRunning: vi.fn(),
  localVersion: vi.fn(),
  readRecord: vi.fn()
}))
vi.mock('../managed-server/activation/hivewardd-activation-transaction-store', () => ({
  readHivewarddActivationTransaction: async () => null
}))
vi.mock('../managed-server/activation/hivewardd-activation-record-store', () => ({
  readHivewarddActivationRecord: host.readRecord
}))
vi.mock('../managed-server/install/remote-versioned-install', async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteVersionedInstall>()),
  readLocalFullVersion: host.localVersion
}))
vi.mock('./wsl-hivewardd-instance-adoption', () => ({
  adoptUnrecordedWslHivewardd: async () => ({ outcome: 'none' })
}))
vi.mock('../ssh/hivewardd-running-version-adoption', () => ({
  adoptRunningHivewarddVersion: host.adoptRunning
}))
vi.mock('../ssh/remote-exec/remote-exec-command', () => ({ execCommand: host.exec }))
vi.mock('../managed-server/install/hivewardd-remote-context', () => ({
  resolveHivewarddRemoteContext: host.resolveContext
}))
vi.mock('../managed-server/activation/hivewardd-activation-recovery', () => ({
  recoverInterruptedHivewarddActivation: async () => ({ outcome: 'none' })
}))
vi.mock('../hivewardd/hivewardd-artifact-materializer', () => ({
  materializeHivewarddArtifact: async () => '/local/hivewardd'
}))
vi.mock('../ssh/hivewardd-remote-deploy', () => ({ deployHivewardd: host.deploy }))
vi.mock('../managed-server/lifecycle/hivewardd-managed-version-gc', () => ({
  provenLiveDaemonVersion: () => null,
  pruneManagedHivewarddVersions: vi.fn()
}))
vi.mock('../managed-server/lifecycle/hivewardd-managed-runtime-context', async (importOriginal) => ({
  ...(await importOriginal<typeof ManagedRuntimeContext>()),
  probeManagedHivewarddReadiness: host.probe
}))

vi.mock('./wsl-hivewardd-active-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof ActiveProbe>()),
  probeWslActiveHivewardd: async (...args: unknown[]) => ({
    readiness: await host.probe(...args),
    pid: 4242
  })
}))

import { deployAndLaunchWslHivewardd } from './wsl-hivewardd-deploy'

const DISTRO = WSL_MOVE_RIG_REQUEST.distro
const RUNNING = '1.5.0+aaaaaaaaaaaa'
const BUNDLED = '1.6.0+bbbbbbbbbbbb'
const READINESS = {
  runtimeId: 'r1',
  boundEndpoint: 'ws://127.0.0.1:6790',
  advertisedEndpoint: null,
  managedWslCliReconciliation: 'settled' as const,
  pairing: { available: false as const, reason: 'disabled_by_operator', guidance: '' }
}
const NO_TERMINALS = { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null }
const RECORD: HivewarddActivationRecord = {
  schemaVersion: 1,
  active: RUNNING,
  activeProduct: 'HiveWard',
  activeVersionFamily: 'hiveward',
  previous: null,
  activatedAt: '2026-10-01T00:00:00.000Z',
  snapshot: null,
  activeAppVersion: '1.5.0'
}

function holder(): WslDistroHolder {
  return {
    ensureHeld: vi.fn(async (distro: string) => ({
      outcome: 'spawned' as const,
      record: { version: 1 as const, distro, pid: 9, creationTimeMs: 1, startedAtMs: 1 }
    })),
    adoptHolders: vi.fn(),
    release: vi.fn(),
    releaseAll: vi.fn(),
    holderState: vi.fn()
  }
}

function transport(target: WslHivewarddHostTarget): HivewarddHostTransport {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every host call is mocked at its module.
  return { getTarget: () => target } as unknown as HivewarddHostTransport
}

/** The host's server launched from Settings (Update) or by a connect (its activation). */
function launchServer(intent: 'update' | 'connect') {
  return deployAndLaunchWslHivewardd(DISTRO, {
    intent,
    holder: holder(),
    createTransport: transport,
    readRegistryId: async () => null,
    readIncumbent: async () => ({
      census: NO_TERMINALS,
      readiness: null,
      recount: async () => NO_TERMINALS,
      releaseAdmission: async () => {}
    })
  })
}

let rig: WslMoveRig
// A failed assertion must not leave the next test's move refused as already running.
let pausedMove: { run: Promise<unknown>; release: () => void } | null = null

beforeEach(() => {
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  // A killed run's catch handlers warn about the calls that now throw.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  resetHivewarddUpdateFailuresForTests()
  rig = createWslMoveKillRig()
  // The launch reads the move journal from the same profile the move writes.
  setAppEnvironment(
    fakeAppEnvironment({
      getVersion: () => '1.6.0',
      getPath: (name) => (name === 'userData' ? rig.userDataPath : testState.dir)
    })
  )
  host.exec.mockImplementation(async (_conn: unknown, command: string) =>
    command.includes('uname -r')
      ? '__HIVEWARD_WSL_KERNEL__ 5.15.167.4-microsoft-standard-WSL2\n__HIVEWARD_WSL_HOME__ /home/u\n\n__HIVEWARD_REMOTE_PLATFORM__ Linux x86_64\n'
      : '4242\n'
  )
  host.resolveContext.mockImplementation(async (target: WslHivewarddHostTarget, connection) => ({
    activationRecord: RECORD,
    serverTarget: 'linux-x64-glibc',
    connection,
    host: getRemoteHostPlatform('linux-x64'),
    remoteHome: '/home/u',
    target,
    userDataDir: '/home/u/.hiveward'
  }))
  host.readRecord.mockResolvedValue(RECORD)
  host.localVersion.mockReturnValue(BUNDLED)
  host.adoptRunning.mockResolvedValue({ version: RUNNING, readiness: READINESS, reprobe: vi.fn() })
  host.deploy.mockResolvedValue({
    outcome: 'installed-and-activated',
    fullVersion: BUNDLED,
    verdict: {}
  })
  host.probe.mockResolvedValue(READINESS)
})

afterEach(async () => {
  pausedMove?.release()
  await pausedMove?.run
  pausedMove = null
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  resetWslMoveDesktopRewriteStoresForTests()
  removeWslMoveRigDirs()
})

/** A move run stopped where it first stages on the host, after it has journaled its cutover. */
async function moveAtStage(): Promise<{
  run: Promise<WslMoveResult | 'killed'>
  release: () => void
}> {
  let reached!: () => void
  const atStage = new Promise<void>((resolve) => {
    reached = resolve
  })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const connect = rig.world.deps.connectHost
  rig.world.deps.connectHost = async (distro) => {
    const moveHost = await connect(distro)
    if (!moveHost) {
      return null
    }
    const { stage } = moveHost.catalog
    return {
      ...moveHost,
      catalog: {
        ...moveHost.catalog,
        stage: async (manifest) => (reached(), await gate, stage(manifest))
      }
    }
  }
  const run = moveProjectsToWslHost(rig.world.deps, WSL_MOVE_RIG_REQUEST).catch(
    () => 'killed' as const
  )
  pausedMove = { run, release }
  await atStage
  return { run, release }
}

async function expectHeld(): Promise<void> {
  expect(isWslMoveUnderwayOnHost(rig.userDataPath, DISTRO)).toBe(true)
  for (const intent of ['update', 'connect'] as const) {
    const launched = await launchServer(intent)
    // The running server keeps serving the move; Settings shows the code as "Not done: a project
    // is moving onto this server…".
    expect(launched).toMatchObject({
      outcome: 'ready',
      fullVersion: RUNNING,
      deferredUpdate: {
        candidateVersion: BUNDLED,
        code: HIVEWARDD_UPDATE_WSL_MOVE_RUNNING_CODE,
        forceable: false
      }
    })
  }
  expect(host.deploy).not.toHaveBeenCalled()
}

async function expectUpdates(): Promise<void> {
  expect(isWslMoveRunning(DISTRO)).toBe(false)
  expect(await launchServer('update')).toMatchObject({
    outcome: 'ready',
    fullVersion: BUNDLED
  })
  expect(host.deploy).toHaveBeenCalledTimes(1)
  expect(host.deploy.mock.calls[0][0]).toMatchObject({ localHivewarddDir: '/local/hivewardd' })
}

describe("the WSL host's server update while a real project move onto it runs (#34823)", () => {
  it('is held while the move runs, and updates once it has moved', async () => {
    const move = await moveAtStage()
    await expectHeld()

    move.release()
    expect(await move.run).toMatchObject({ outcome: 'moved' })
    await expectUpdates()
  })

  it('updates once the move fails because its host went away', async () => {
    const move = await moveAtStage()
    await expectHeld()

    rig.hostPresent = false
    move.release()
    // Put back: nothing moved, the projects are usable here again.
    expect(await move.run).toMatchObject({ outcome: 'reset' })
    rig.hostPresent = true
    await expectUpdates()
  })

  it('updates once the user cancels the move', async () => {
    const move = await moveAtStage()
    await expectHeld()

    expect(cancelWslMove(DISTRO)).toBe(true)
    move.release()
    expect(await move.run).toMatchObject({ outcome: 'refused', code: 'wsl_move_cancelled' })
    await expectUpdates()
  })

  it('updates after the desktop is killed mid-move and the relaunch recovers it', async () => {
    rig.kill.killAt = 'stage:before'
    const move = await moveAtStage()
    await expectHeld()

    move.release()
    await move.run
    expect(rig.kill.dead).toBe(true)
    await restartWslMoveRig(rig, { hostUp: true, hivewarddRestarted: false })
    expect(wslMoveRigOutcome(rig)).not.toBe('stuck')
    await expectUpdates()
  })
})
