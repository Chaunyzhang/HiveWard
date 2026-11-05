// Preferred ports may belong to other runtimes; tunnel to the active slot's published bound port.
import {
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import type { SshTarget } from '../../../shared/ssh-types'
import type { ServeReadiness } from '../../server/serve-readiness'
import { managedHivewarddInstallDir } from './hivewardd-managed-runtime-context'
import { resolveHivewarddRemoteContext } from '../install/hivewardd-remote-context'
import {
  parseHivewarddReadinessWaitOutput,
  readHivewarddReadinessNowCommand
} from '../install/hivewardd-remote-readiness-wait'
import {
  execHivewarddRemote,
  type HivewarddRemoteExecTarget
} from '../install/hivewardd-remote-runtime-control'
import type { HivewarddHostTarget, HivewarddHostTransport } from '../../ssh/hivewardd-host-transport'

export type HivewarddTunnelPortInput = {
  environment: KnownRuntimeEnvironment
  target: SshTarget
  connection: HivewarddHostTransport
}

export function hivewarddBoundPort(readiness: Pick<ServeReadiness, 'boundEndpoint'>): number | null {
  if (!readiness.boundEndpoint) {
    return null
  }
  try {
    const port = Number(new URL(readiness.boundEndpoint).port)
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null
  } catch {
    return null
  }
}

async function readManagedHivewarddSlotReadiness(
  target: HivewarddRemoteExecTarget & { remoteInstallDir: string }
): Promise<ServeReadiness | null> {
  const parsed = parseHivewarddReadinessWaitOutput(
    target.host,
    await execHivewarddRemote(
      target,
      readHivewarddReadinessNowCommand(target.host, target.remoteInstallDir)
    )
  )
  return parsed.state === 'ready' ? parsed.readiness : null
}

export async function readActiveManagedHivewarddReadiness(input: {
  target: HivewarddHostTarget
  connection: HivewarddHostTransport
}): Promise<ServeReadiness | null> {
  const context = await resolveHivewarddRemoteContext(input.target, input.connection)
  const active = context.activationRecord.active
  if (!active) {
    return null
  }
  return readManagedHivewarddSlotReadiness({
    conn: context.connection,
    host: context.host,
    remoteHome: context.remoteHome,
    remoteInstallDir: managedHivewarddInstallDir(context, active)
  })
}

async function readActiveSlotBoundPort(input: HivewarddTunnelPortInput): Promise<number | null> {
  if (!input.environment.hivewarddDeployment) {
    return null
  }
  const readiness = await readActiveManagedHivewarddReadiness(input)
  return readiness ? hivewarddBoundPort(readiness) : null
}

export async function resolveManagedHivewarddTunnelPort(input: HivewarddTunnelPortInput): Promise<number> {
  const access = getRuntimeSshAccess(input.environment)
  if (!access) {
    throw new Error('Managed hivewardd environment is missing its SSH tunnel dependency.')
  }
  try {
    return (await readActiveSlotBoundPort(input)) ?? access.remotePort
  } catch (error) {
    // Post-forward identity validation still detects a wrong server when falling back.
    console.warn(
      '[ssh] Could not read the managed HiveWard server port; trying the preferred one:',
      error
    )
    return access.remotePort
  }
}

/** Missing or unreadable published ports never justify moving an existing tunnel. */
export async function readManagedHivewarddPublishedPort(
  input: HivewarddTunnelPortInput
): Promise<number | null> {
  try {
    return await readActiveSlotBoundPort(input)
  } catch {
    return null
  }
}
