/** E1: open a temporary bridge for incumbent census before activation. Unproven state is unverifiable, never zero; WSL has no standing deploy tunnel. */
import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { parsePairingCode, type PairingOffer } from '../../shared/pairing'
import { HIVEWARDD_MANAGED_REMOTE_PORT } from '../../shared/hivewardd-managed-runtime'
import {
  type HivewarddTerminalCensus,
  UNVERIFIABLE_HIVEWARDD_TERMINAL_CENSUS
} from '../../shared/hivewardd-terminal-census'
import type { ServeReadiness } from '../server/serve-readiness'
import { probeActiveHivewarddReadiness } from '../ssh/hivewardd-active-readiness'
import { hivewarddBoundPort } from '../managed-server/lifecycle/hivewardd-managed-bound-port'
import { managedHivewarddInstallDir } from '../managed-server/lifecycle/hivewardd-managed-runtime-context'
import { wakeStoppedManagedHivewardd } from '../managed-server/lifecycle/hivewardd-managed-wake'
import type { HivewarddRemoteContext } from '../managed-server/install/hivewardd-remote-context'
import type { HivewarddSlotOptions } from '../ssh/hivewardd-recovery-slot'
import { readRemoteHivewarddBuildHash } from '../managed-server/install/hivewardd-remote-build-hash'
import {
  requestHivewarddTerminalCensus,
  type HivewarddTerminalCensusRequestOptions
} from '../ssh/hivewardd-terminal-census-client'
import { updateTerminalCounts } from '../ssh/hivewardd-fenced-stop'
import { tunneledHivewarddPairingCode } from '../ssh/hivewardd-tunneled-pairing'
import type { StartedPortForward } from '../ssh/port-forwarding/ssh-port-forward-provider'
import type { HivewarddHostTransport } from '../ssh/hivewardd-host-transport'
import type { WslHivewarddHostTarget } from './wsl-hivewardd-host-target'
import { listenWslHivewarddStdioBridge } from './wsl-hivewardd-stdio-bridge'

export type WslHivewarddIncumbent = {
  census: HivewarddTerminalCensus
  /** The incumbent's proven readiness; null when it could not be started or proven. */
  readiness: ServeReadiness | null
  /** Recount without wake and close terminal admission before activation stops the incumbent; unreadable never means zero. */
  recount: () => Promise<HivewarddTerminalCensus>
  /** Reopens the admission `recount` closed, when the incumbent keeps running. */
  releaseAdmission: () => Promise<void>
}

type IncumbentArgs = {
  context: HivewarddRemoteContext<WslHivewarddHostTarget>
  slot: HivewarddSlotOptions
  /** This desktop's enrolled pairing; null before its first pairing. */
  paired?: PairingOffer | null
}

const UNREADABLE: WslHivewarddIncumbent = {
  census: UNVERIFIABLE_HIVEWARDD_TERMINAL_CENSUS,
  readiness: null,
  recount: async () => UNVERIFIABLE_HIVEWARDD_TERMINAL_CENSUS,
  releaseAdmission: async () => {}
}

export type WslHivewarddIncumbentDependencies = {
  wake: typeof wakeStoppedManagedHivewardd
  probe: typeof probeActiveHivewarddReadiness
  readBuildHash: typeof readRemoteHivewarddBuildHash
  listen: (
    transport: HivewarddHostTransport,
    remotePort: number,
    target: WslHivewarddHostTarget
  ) => Promise<StartedPortForward>
  census: typeof requestHivewarddTerminalCensus
}

const DEFAULT_DEPENDENCIES: WslHivewarddIncumbentDependencies = {
  wake: wakeStoppedManagedHivewardd,
  probe: probeActiveHivewarddReadiness,
  readBuildHash: readRemoteHivewarddBuildHash,
  listen: (transport, remotePort, target) =>
    listenWslHivewarddStdioBridge(transport, {
      environmentId: target.id,
      distro: target.distro,
      remotePort,
      localPort: 0,
      label: `HiveWard server in WSL: ${target.label} (update check)`
    }),
  census: requestHivewarddTerminalCensus
}

/** Wake reboot/idle-stopped incumbent, census its daemon, then close the temporary bridge before returning. */
export async function readWslHivewarddIncumbent(
  args: IncumbentArgs,
  dependencies: WslHivewarddIncumbentDependencies = DEFAULT_DEPENDENCIES
): Promise<WslHivewarddIncumbent> {
  const record = args.context.activationRecord
  const activatedAt = record.activatedAt ? Date.parse(record.activatedAt) : Number.NaN
  if (!record.active || !Number.isFinite(activatedAt) || activatedAt < 0) {
    return UNREADABLE
  }
  let readiness: ServeReadiness
  try {
    const wake = await dependencies.wake(args.slot)
    if (wake.outcome === 'started') {
      readiness = wake.readiness
    } else if (wake.outcome === 'serving') {
      const remoteInstallDir = managedHivewarddInstallDir(args.context, record.active)
      readiness = await dependencies.probe(
        { ...args.slot, remoteInstallDir },
        {
          buildHash: await dependencies.readBuildHash(args.slot, remoteInstallDir),
          fullVersion: record.active
        }
      )
    } else {
      return UNREADABLE
    }
  } catch {
    return UNREADABLE
  }
  const counts = updateTerminalCounts((options) =>
    countIncumbentTerminals(args, readiness, activatedAt, dependencies, options)
  )
  return {
    census: await counts.countFirst(),
    readiness,
    recount: counts.recountCensus,
    releaseAdmission: counts.releaseIncumbentAdmission
  }
}

async function countIncumbentTerminals(
  args: IncumbentArgs,
  readiness: ServeReadiness,
  activatedAt: number,
  dependencies: WslHivewarddIncumbentDependencies,
  options: HivewarddTerminalCensusRequestOptions
): Promise<HivewarddTerminalCensus> {
  let forward: StartedPortForward | null = null
  try {
    forward = await dependencies.listen(
      args.slot.conn,
      hivewarddBoundPort(readiness) ?? HIVEWARDD_MANAGED_REMOTE_PORT,
      args.context.target
    )
    // Use enrolled grants; startup offers would enroll a fresh device on every census.
    const offer = parsePairingCode(
      tunneledHivewarddPairingCode(readiness, forward.entry.localPort, args.paired)
    )
    if (!offer) {
      return UNVERIFIABLE_HIVEWARDD_TERMINAL_CENSUS
    }
    return await dependencies.census(
      pairedRuntimeConnectionFromOffer(offer),
      activatedAt,
      undefined,
      options
    )
  } catch {
    return UNVERIFIABLE_HIVEWARDD_TERMINAL_CENSUS
  } finally {
    await forward?.close().catch(() => {})
  }
}
