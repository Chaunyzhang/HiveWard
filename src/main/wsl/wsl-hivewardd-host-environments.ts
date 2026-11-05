/** Map currently connected runtime IDs to WSL distros for desktop account shims; connection manager removes entries on close. */
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'

const distrosByEnvironment = new Map<string, string>()
/** The capabilities the connected hivewardd last reported; dropped on every (re)connect. */
const capabilitiesByEnvironment = new Map<string, readonly string[]>()

export function registerWslHivewarddHostEnvironment(environmentId: string, distro: string): void {
  distrosByEnvironment.set(environmentId, distro)
  // Reconnect may deploy a different build; discard cached capabilities.
  capabilitiesByEnvironment.delete(environmentId)
}

export function unregisterWslHivewarddHostEnvironment(environmentId: string, distro: string): void {
  if (distrosByEnvironment.get(environmentId) === distro) {
    distrosByEnvironment.delete(environmentId)
    capabilitiesByEnvironment.delete(environmentId)
  }
}

export function wslHivewarddHostDistro(environmentId: string): string | null {
  return distrosByEnvironment.get(environmentId) ?? null
}

type WslHivewarddHostEnvironmentRef = { environmentId: string; distro: string }

/** Lists `next` while open; a closed connection (`next` null) unlists `previous`. */
export function trackWslHivewarddHostEnvironment(
  previous: WslHivewarddHostEnvironmentRef,
  next: WslHivewarddHostEnvironmentRef | null
): void {
  if (next) {
    registerWslHivewarddHostEnvironment(next.environmentId, next.distro)
  } else {
    unregisterWslHivewarddHostEnvironment(previous.environmentId, previous.distro)
  }
}

function capabilitiesOf(result: unknown): readonly string[] | null {
  if (typeof result !== 'object' || result === null || !('capabilities' in result)) {
    return null
  }
  const { capabilities } = result
  return Array.isArray(capabilities)
    ? capabilities.filter((entry): entry is string => typeof entry === 'string')
    : null
}

/** Records a WSL hivewardd's capabilities from any `status.get` answer that passes the desktop. */
const AUTOMATION_MUTATIONS = new Set([
  'automation.create',
  'automation.update',
  'automation.delete'
])
const automationMutationListeners = new Set<(environmentId: string) => void>()

/** E9: this desktop changed a WSL host's automations; the wake schedule re-reads them. */
export function onWslHivewarddHostAutomationsChanged(
  listener: (environmentId: string) => void
): () => void {
  automationMutationListeners.add(listener)
  return () => automationMutationListeners.delete(listener)
}

export function observeWslHivewarddHostResponse(
  environmentId: string,
  method: string,
  response: RuntimeRpcResponse<unknown>
): void {
  if (!response.ok || !distrosByEnvironment.has(environmentId)) {
    return
  }
  if (AUTOMATION_MUTATIONS.has(method)) {
    automationMutationListeners.forEach((listener) => listener(environmentId))
    return
  }
  if (method !== 'status.get') {
    return
  }
  const capabilities = capabilitiesOf(response.result)
  if (capabilities) {
    capabilitiesByEnvironment.set(environmentId, capabilities)
  }
}

export type WslHivewarddHostCapabilityVerdict = 'supported' | 'unsupported' | 'unknown'

/** Cache advertised capabilities until reconnect. Probe failure is unknown, never proof of an older host. */
export async function wslHivewarddHostSupports(
  environmentId: string,
  capability: string,
  readStatus: () => Promise<RuntimeRpcResponse<unknown>>
): Promise<WslHivewarddHostCapabilityVerdict> {
  if (!capabilitiesByEnvironment.has(environmentId)) {
    try {
      observeWslHivewarddHostResponse(environmentId, 'status.get', await readStatus())
    } catch {
      return 'unknown'
    }
  }
  const capabilities = capabilitiesByEnvironment.get(environmentId)
  if (!capabilities) {
    return 'unknown'
  }
  return capabilities.includes(capability) ? 'supported' : 'unsupported'
}
