/** Registered destinations must abort/prove empty, then unregister before fence release so later starts cannot reclaim the host. Never-registered destinations held nothing. */
import { removeManagedHivewarddEnvironment } from '../../shared/runtime-environment-managed-hivewardd-store'
import { listEnvironments } from '../../shared/runtime-environment-store'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import { closeHivewarddManagedTunnel } from '../managed-server/lifecycle/hivewardd-managed-tunnel'
import {
  abortHivewarddMigrationCutover,
  type HivewarddMigrationAbortResult,
  type HivewarddMigrationCutoverContext,
  type HivewarddMigrationDestinationCatalog
} from './hivewardd-migration-cutover-coordinator'
import { findHivewarddMigrationSourceCutoverForTarget } from './hivewardd-migration-cutover-journal'
import {
  releaseHivewarddMigrationFence,
  releaseUndeployedMigrationFence
} from './hivewardd-migration-source-fence'

export async function abandonHivewarddConversion(args: {
  userDataPath: string
  store: HivewarddMigrationCutoverContext['store']
  claims: HivewarddMigrationCutoverContext['claims']
  targetId: string
  destinationFor: (environment: KnownRuntimeEnvironment) => HivewarddMigrationDestinationCatalog
}): Promise<HivewarddMigrationAbortResult | 'none'> {
  const cutover = findHivewarddMigrationSourceCutoverForTarget(args.userDataPath, args.targetId)
  // Committed delta chains resolve only through the delta flow.
  if (!cutover || cutover.supersedesMigrationId) {
    return 'none'
  }
  const isRegistered = (id: string): boolean =>
    listEnvironments(args.userDataPath).some((entry) => entry.id === id)
  const environment = listEnvironments(args.userDataPath).find(
    (entry) => entry.id === cutover.destinationEnvironmentId
  )
  if (!environment) {
    await releaseUndeployedMigrationFence({ ...args, isDestinationRegistered: isRegistered })
    return 'none'
  }
  const context = { ...args, destination: args.destinationFor(environment) }
  return abortHivewarddMigrationCutover(context, cutover.migrationId, async (aborted) => {
    await closeHivewarddManagedTunnel(environment.id).catch(() => undefined)
    removeManagedHivewarddEnvironment(args.userDataPath, environment.id)
    await releaseHivewarddMigrationFence(context, aborted)
  })
}
