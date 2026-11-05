import { getAppEnvironment } from '../../shared/app-environment'
import type { RuntimeRpcClientActivity } from '../runtime/runtime-rpc/runtime-rpc-shutdown'
import type { HivewarddIdleExitEvidence } from './hivewardd-idle-exit-monitor'
import {
  activationFenceExists,
  createHivewarddIdleProbes,
  installHivewarddManagedIdleExit,
  resolveHivewarddManagedIdleExit,
  type HivewarddManagedIdleExitConfig,
  type HivewarddManagedIdleExitPorts
} from './hivewardd-managed-idle-exit'
import type { HivewarddDaemonRetirement } from './hivewardd-daemon-retirement'
import { recoverDaemonAfterCancelledIdleStop } from './hivewardd-idle-stop-daemon-recovery'
import {
  consumeHivewarddIdleStopRecord,
  discardHivewarddIdleStopRecord,
  writeHivewarddIdleStopRecord
} from './hivewardd-idle-stop-record'
import type { HivewarddShutdownTrigger } from './hivewardd-lifecycle'
import {
  idleStopMayReleaseWslHolder,
  requestHivewarddWslHolderRelease,
  withdrawHivewarddWslHolderRelease
} from './hivewardd-wsl-holder-release'
import type { HivewarddIdleStopRecord } from '../../shared/hivewardd-idle-exit'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'

let requestIdleShutdown: HivewarddShutdownTrigger | null = null

/** Signal handling binds later; the quiet period must outlast the startup gap. */
export function bindHivewarddIdleShutdown(request: HivewarddShutdownTrigger): void {
  requestIdleShutdown = request
}

type HivewarddIdleExitRuntimePorts = {
  rpc: { readClientActivity(): RuntimeRpcClientActivity }
  agentStates: () => readonly { state: string }[]
  hasStagedMigration: () => boolean
  automationsBusy: () => boolean
  emulatorsBusy: () => Promise<boolean>
  /** Stop the monitor before recording signal-driven shutdown. */
  registerCleanup: (cleanup: () => void) => void
}

/** Under the startup lock, consume previous idle-stop evidence before this run can overwrite it. */
export function beginHivewarddIdleExit(userDataPath: string): {
  previousIdleStop: HivewarddIdleStopRecord | null | undefined
  start: (ports: HivewarddIdleExitRuntimePorts) => Promise<void>
} {
  withdrawHivewarddWslHolderRelease(userDataPath)
  const config = resolveHivewarddManagedIdleExit(process.env)
  if (!config) {
    return { previousIdleStop: undefined, start: async () => {} }
  }
  const previousIdleStop = consumeHivewarddIdleStopRecord(userDataPath)
  if (previousIdleStop) {
    console.error(`[hivewardd] the previous run stopped idle at ${previousIdleStop.stoppedAt}`)
  }
  const version = getAppEnvironment().getVersion()
  return {
    previousIdleStop,
    start: (ports) => startHivewarddManagedIdleExit({ ...ports, config, userDataPath, version })
  }
}

async function startHivewarddManagedIdleExit(
  input: HivewarddIdleExitRuntimePorts & {
    config: HivewarddManagedIdleExitConfig
    userDataPath: string
    version: string
  }
): Promise<void> {
  const { getLocalPtyProvider } = await import('../ipc/pty/provider/registry')
  const { getCurrentDaemonPid, getDaemonEndpointFacts, isDaemonTerminalAdmissionClosed } =
    await import('../daemon/daemon-provider-state')
  const { countLiveHivewarddDaemonSessions, retireHivewarddDaemonIfIdle } =
    await import('./hivewardd-daemon-retirement')
  const idleRecord = createIdleStopRecordOwnership(input.userDataPath)
  const hasChatProviders = (): boolean =>
    getStructuredAgentSessionHost()?.hasLoadedProviders() ?? false
  const ports: HivewarddManagedIdleExitPorts = {
    readClientActivity: () => input.rpc.readClientActivity(),
    listTerminals: () => getLocalPtyProvider().listProcesses(),
    countDaemonSessions: countLiveHivewarddDaemonSessions,
    hasDaemon: () => getDaemonEndpointFacts() !== null,
    agentStates: input.agentStates,
    hasChatProviders,
    hasStagedMigration: input.hasStagedMigration,
    automationsBusy: input.automationsBusy,
    emulatorsBusy: input.emulatorsBusy,
    activationFenceExists
  }
  // Client/terminal evidence is already checked; recheck other work exit would destroy.
  const nonTerminalWorkProbes = createHivewarddIdleProbes(input.config, ports).filter(
    (probe) => probe.name !== 'clients' && probe.name !== 'terminals'
  )
  const hasNonTerminalWork = async (): Promise<boolean> => {
    for (const probe of nonTerminalWorkProbes) {
      if (
        (await Promise.resolve()
          .then(probe.read)
          .catch(() => 'unverifiable')) !== 'idle'
      ) {
        return true
      }
    }
    return false
  }
  const dispose = installHivewarddManagedIdleExit({
    config: input.config,
    ports,
    stop: async (evidence) => {
      // Replacement must target only the daemon incarnation that agreed to retire.
      const retiringPid = getCurrentDaemonPid()
      const outcome = await stopForIdle(input, evidence, retireHivewarddDaemonIfIdle)
      // Clients/providers can return while the retirement reply is pending.
      const activity = input.rpc.readClientActivity()
      if (
        hasChatProviders() ||
        activity.openConnections > 0 ||
        activity.requestsInFlight > 0 ||
        activity.lastRequestAt > evidence.quietSince
      ) {
        discardHivewarddIdleStopRecord(input.userDataPath)
        const daemon = await recoverDaemonAfterCancelledIdleStop(outcome, {
          admissionClosed: isDaemonTerminalAdmissionClosed,
          retireAgain: () => retireHivewarddDaemonIfIdle(),
          replaceDaemon: async () => {
            if (retiringPid === null) {
              throw new Error('the retiring daemon never identified itself')
            }
            const { restartDaemon } = await import('../daemon/daemon-provider-restart')
            await restartDaemon({ expectedDaemonPid: retiringPid, endpointMayBeGone: true })
          }
        })
        if (daemon === 'serving' || (await hasNonTerminalWork())) {
          return false
        }
        idleRecord.requestShutdown(requestIdleShutdown)
        return true
      }
      if (idleStopMayReleaseWslHolder(process.env, outcome)) {
        try {
          requestHivewarddWslHolderRelease(input.userDataPath)
        } catch (error) {
          console.error('[hivewardd] could not release the WSL distro holder:', error)
        }
      }
      idleRecord.requestShutdown(requestIdleShutdown)
      return true
    }
  })
  input.registerCleanup(() => {
    dispose()
    idleRecord.onShutdown()
  })
}

/** Discard failed, overdue and externally superseded idle stops, including cleanup before request completion. */
export function createIdleStopRecordOwnership(userDataPath: string): {
  requestShutdown(request: HivewarddShutdownTrigger | null): void
  onShutdown(): void
} {
  let idleOwnsStop = false
  // The holder release rides on the idle stop: a stop that is not idle must not end the distro.
  const discard = (): void => {
    discardHivewarddIdleStopRecord(userDataPath)
    withdrawHivewarddWslHolderRelease(userDataPath)
  }
  return {
    requestShutdown: (request) => {
      // Cleanup may run before the trigger returns, so establish ownership first.
      idleOwnsStop = true
      if (request?.('idle', discard) !== true) {
        idleOwnsStop = false
        discard()
      }
    },
    onShutdown: () => {
      if (!idleOwnsStop) {
        discard()
      }
    }
  }
}

async function stopForIdle(
  input: { userDataPath: string; version: string },
  evidence: HivewarddIdleExitEvidence,
  retireDaemon: () => Promise<HivewarddDaemonRetirement>
): Promise<HivewarddDaemonRetirement> {
  console.error(`[hivewardd] stopping: no client, terminal or job for ${evidence.timeoutMs}ms`)
  try {
    writeHivewarddIdleStopRecord(input.userDataPath, evidence, input.version)
  } catch (error) {
    console.error('[hivewardd] could not record the idle stop:', error)
  }
  // Only the daemon’s atomic empty census can authorize retirement.
  const outcome = await retireDaemon().catch((error: unknown): HivewarddDaemonRetirement => ({
    retirement: 'unverifiable',
    liveSessions: null,
    reason: String(error)
  }))
  console.error(
    `[hivewardd] terminal daemon on idle stop: ${outcome.retirement}${outcome.reason ? ` (${outcome.reason})` : ''}`
  )
  return outcome
}
