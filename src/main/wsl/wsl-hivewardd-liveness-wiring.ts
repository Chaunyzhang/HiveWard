/** C7 supplies visible demand; these production probes serve the WSL liveness supervisor. */
import {
  probeThenWatchWslHivewarddBridges,
  type WslHivewarddBridgeActivity
} from './wsl-hivewardd-bridge-activity'
import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { parsePairingCode } from '../../shared/pairing'
import {
  type HivewarddTerminalCensus,
  UNVERIFIABLE_HIVEWARDD_TERMINAL_CENSUS
} from '../../shared/hivewardd-terminal-census'
import { requestHivewarddTerminalCensus } from '../ssh/hivewardd-terminal-census-client'
import { subscribeSystemPowerLifecycle } from '../system-power-lifecycle'
import {
  deferUntilWslDistroRunning,
  readSettledConfirmedRunningWslDistros
} from '../wsl-background-distro-gate'
import type { WslDistroHolder } from './wsl-distro-holder'
import { readWslGuestIdentity } from './wsl-guest-process-identity'
import type { WslHivewarddConnection, WslHivewarddConnectionManager } from './wsl-hivewardd-connection'
import { defaultWslHivewarddEnvironmentId } from './wsl-hivewardd-deploy'
import { EXIT_SETTLE_MS } from './wsl-hivewardd-liveness-evidence'
import { requireConfirmedRunning } from './wsl-hivewardd-connection-errors'
import { WslHivewarddLivenessSupervisor } from './wsl-hivewardd-liveness-supervisor'
import { createWslHivewarddHostTransport } from './wsl-hivewardd-host-transport'
import { openWslHivewarddWatch } from './wsl-hivewardd-watch'

function transportFor(distro: string, environmentId = defaultWslHivewarddEnvironmentId(distro)) {
  return createWslHivewarddHostTransport({
    target: { kind: 'wsl', id: environmentId, distro, label: distro }
  })
}

/** Every session counts (activation time 0): liveness asks how many survived, not how new. */
function collectWslHivewarddCensus(connection: WslHivewarddConnection): Promise<HivewarddTerminalCensus> {
  const offer = parsePairingCode(connection.pairingOffer)
  return offer
    ? requestHivewarddTerminalCensus(pairedRuntimeConnectionFromOffer(offer), 0)
    : Promise.resolve(UNVERIFIABLE_HIVEWARDD_TERMINAL_CENSUS)
}

export function createWslHivewarddLivenessSupervisor(options: {
  manager: WslHivewarddConnectionManager
  bridgeActivity: WslHivewarddBridgeActivity
  holder: WslDistroHolder
  hasUserVisibleWork: (distro: string) => boolean
}): WslHivewarddLivenessSupervisor {
  return new WslHivewarddLivenessSupervisor({
    manager: options.manager,
    readRunning: ({ distro, exitedAt, probedAfter }) => {
      const settled =
        exitedAt === null || exitedAt === undefined ? undefined : exitedAt + EXIT_SETTLE_MS
      return readSettledConfirmedRunningWslDistros(
        distro,
        probedAfter === undefined ? settled : Math.max(settled ?? -Infinity, probedAfter)
      )
    },
    readIdentity: (distro, hivewarddPid) => readWslGuestIdentity(transportFor(distro), hivewarddPid),
    openWatch: (connection) =>
      probeThenWatchWslHivewarddBridges(
        () =>
          openWslHivewarddWatch(
            transportFor(connection.distro, connection.environmentId),
            connection.remotePort
          ),
        options.bridgeActivity,
        connection.environmentId
      ),
    collectCensus: collectWslHivewarddCensus,
    hasUserVisibleWork: options.hasUserVisibleWork,
    deferUntilRunning: deferUntilWslDistroRunning,
    requireRunning: async (distro) =>
      requireConfirmedRunning(await readSettledConfirmedRunningWslDistros(distro), distro),
    // Liveness is background work: the holder may re-spawn only into a distro that runs (E9).
    ensureHolder: (distro) =>
      options.holder.ensureHeld(distro, {
        requireRunning: async () =>
          requireConfirmedRunning(await readSettledConfirmedRunningWslDistros(distro), distro)
      }),
    subscribePower: subscribeSystemPowerLifecycle
  })
}
