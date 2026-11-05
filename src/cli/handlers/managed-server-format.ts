import type { HivewarddManagedRuntimeStatus } from '../../shared/hivewardd-managed-runtime'

function count(value: number | null): string {
  return value === null ? 'unverifiable' : String(value)
}

export function formatManagedServerStatus(status: HivewarddManagedRuntimeStatus): string {
  const lines = [
    `Active version: ${status.activeVersion ?? 'none'}${status.activeAppVersion ? ` (HiveWard ${status.activeAppVersion})` : ''}`,
    `Previous version: ${status.previousVersion ?? 'none'}${status.rollbackAvailable ? ' (rollback available)' : ''}`,
    `Live terminals: ${count(status.terminals.liveSessions)}`
  ]
  if (status.recovery) {
    lines.push(
      `Interrupted ${status.recovery.operation} of ${status.recovery.version} (${status.recovery.phase}); run \`hiveward environment recover\`.`
    )
  }
  if (status.migration) {
    lines.push(`Migration into this server: ${status.migration.phase}`)
  }
  if (status.deferredUpdate) {
    lines.push(
      `Deferred update to ${status.deferredUpdate.candidateVersion}: ${status.deferredUpdate.reason}`
    )
  }
  if (status.availableUpdate) {
    lines.push(
      `Update available: ${status.availableUpdate}; run \`hiveward environment update --environment ${status.environmentId}\`.`
    )
  }
  return lines.join('\n')
}
