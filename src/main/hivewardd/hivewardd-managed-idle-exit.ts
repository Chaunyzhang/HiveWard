// Live terminals block idle exit; ordinary shutdown disconnects without killing their daemon.
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { RELAY_INSTALL_LOCK_NAME } from '../../shared/relay-install-lock-name'
import { hasErrorCode } from '../daemon/daemon-process-inspection'
import type { RuntimeRpcClientActivity } from '../runtime/runtime-rpc/runtime-rpc-shutdown'
import { HIVEWARDD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/hivewardd-managed-launch-env'
import {
  HIVEWARDD_IDLE_EXIT_TIMEOUT_MS,
  readHivewarddE2EIdleTimeoutMs,
  readHivewarddIdleTimeoutMs
} from '../../shared/hivewardd-idle-exit'
import {
  HivewarddIdleExitMonitor,
  type HivewarddIdleExitEvidence,
  type HivewarddIdleProbe,
  type HivewarddIdleVerdict
} from './hivewardd-idle-exit-monitor'

export type HivewarddManagedIdleExitConfig = { timeoutMs: number; activationRoot: string }

/** User-started/paired servers never idle out; only client-managed launches opt in. */
export function resolveHivewarddManagedIdleExit(
  env: NodeJS.ProcessEnv
): HivewarddManagedIdleExitConfig | null {
  const activationRoot = env[HIVEWARDD_MANAGED_ACTIVATION_ROOT_ENV]
  if (!activationRoot) {
    return null
  }
  return {
    timeoutMs:
      readHivewarddE2EIdleTimeoutMs(env) ?? readHivewarddIdleTimeoutMs(env) ?? HIVEWARDD_IDLE_EXIT_TIMEOUT_MS,
    activationRoot
  }
}

export type HivewarddManagedIdleExitPorts = {
  readClientActivity: () => RuntimeRpcClientActivity
  listTerminals: () => Promise<readonly unknown[]>
  /** Null means some daemon generation did not answer. */
  countDaemonSessions: () => Promise<number | null>
  hasDaemon: () => boolean
  agentStates: () => readonly { state: string }[]
  hasChatProviders: () => boolean
  hasStagedMigration: () => boolean
  /** Enabled schedules or unsettled runs would be lost on exit. */
  automationsBusy: () => boolean
  /** Exit would shut down the emulators HiveWard started for a workspace. */
  emulatorsBusy: () => Promise<boolean>
  activationFenceExists: (root: string) => Promise<boolean>
}

export function createHivewarddIdleProbes(
  config: HivewarddManagedIdleExitConfig,
  ports: HivewarddManagedIdleExitPorts
): HivewarddIdleProbe[] {
  const verdict = (busy: boolean): HivewarddIdleVerdict => (busy ? 'busy' : 'idle')
  return [
    {
      name: 'clients',
      read: () => {
        const activity = ports.readClientActivity()
        return verdict(activity.openConnections > 0 || activity.requestsInFlight > 0)
      }
    },
    {
      name: 'terminals',
      read: async () => {
        if ((await ports.listTerminals()).length > 0) {
          return 'busy'
        }
        // Daemons may retain sessions absent from this process’s provider inventory.
        if (!ports.hasDaemon()) {
          return 'idle'
        }
        const live = await ports.countDaemonSessions()
        return live === null ? 'unverifiable' : verdict(live > 0)
      }
    },
    {
      name: 'agents',
      read: () => verdict(ports.agentStates().some((entry) => entry.state === 'working'))
    },
    { name: 'chat-providers', read: () => verdict(ports.hasChatProviders()) },
    { name: 'migration', read: () => verdict(ports.hasStagedMigration()) },
    { name: 'automations', read: () => verdict(ports.automationsBusy()) },
    { name: 'emulators', read: async () => verdict(await ports.emulatorsBusy()) },
    {
      name: 'activation',
      read: async () => verdict(await ports.activationFenceExists(config.activationRoot))
    }
  ]
}

/** A bare activation root may be interrupted acquisition; only its lock proves a held fence. */
export async function activationFenceExists(root: string): Promise<boolean> {
  try {
    await stat(join(root, RELAY_INSTALL_LOCK_NAME))
    return true
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return false
    }
    throw error
  }
}

export function installHivewarddManagedIdleExit(input: {
  config: HivewarddManagedIdleExitConfig
  ports: HivewarddManagedIdleExitPorts
  stop: (evidence: HivewarddIdleExitEvidence) => void | boolean | Promise<void | boolean>
}): () => void {
  const monitor = new HivewarddIdleExitMonitor({
    timeoutMs: input.config.timeoutMs,
    probes: createHivewarddIdleProbes(input.config, input.ports),
    lastClientActivityAt: () => input.ports.readClientActivity().lastRequestAt,
    onIdle: input.stop
  })
  monitor.start()
  return () => monitor.stop()
}
