import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import type { HivewarddManagedServing } from './hivewardd-managed-serving'
import { verifyManagedTunnelServing } from './hivewardd-managed-tunnel'

/** Return unverifiable on failures rather than throwing. */
export function verifyHivewarddManagedServing(
  userDataPath: string,
  selector: string
): Promise<HivewarddManagedServing> {
  return Promise.resolve()
    .then(() => verifyManagedTunnelServing(resolveEnvironment(userDataPath, selector)))
    .catch((error: unknown) => ({ state: 'unverifiable', detail: String(error) }))
}
