// Restored tunnels bypass SSH connect; perform its update check once per server/session in the background.
import type { SshManagedServerUpdateNote, SshTarget } from '../../../shared/ssh-types'
import {
  checkManagedServerUpdate,
  type ManagedServerUpdateDeps
} from '../../ssh/managed-server-update-check'

export type ManagedHivewarddRestoreUpdateDeps = ManagedServerUpdateDeps & {
  target: (environmentId: string) => SshTarget | null
  publish: (
    target: SshTarget,
    environmentId: string,
    phase: 'updating' | 'settled',
    note?: SshManagedServerUpdateNote
  ) => void
}

const checked = new Set<string>()

export function updateManagedHivewarddOnRestore(
  environmentId: string,
  createDeps: () => ManagedHivewarddRestoreUpdateDeps
): Promise<void> | null {
  if (checked.has(environmentId)) {
    return null
  }
  checked.add(environmentId)
  let deps: ManagedHivewarddRestoreUpdateDeps
  let target: SshTarget | null
  try {
    deps = createDeps()
    target = deps.target(environmentId)
  } catch (error) {
    console.warn('[ssh] Update check on tunnel restore skipped:', error)
    return null
  }
  if (!target) {
    return null
  }
  return checkManagedServerUpdate(target, environmentId, deps, () =>
    deps.publish(target, environmentId, 'updating')
  ).then(
    ({ note }) => deps.publish(target, environmentId, 'settled', note),
    (error: unknown) => {
      console.warn('[ssh] Update check on tunnel restore failed:', error)
    }
  )
}

const redeploying = new Map<string, Promise<boolean>>()

/** Coalesce redeploys after peer stops; unlike restore checks, these must remain retryable all session. */
export function redeployStoppedManagedHivewardd(
  environmentId: string,
  createDeps: () => ManagedHivewarddRestoreUpdateDeps
): Promise<boolean> {
  let attempt = redeploying.get(environmentId)
  if (!attempt) {
    attempt = runRedeploy(environmentId, createDeps).finally(() =>
      redeploying.delete(environmentId)
    )
    redeploying.set(environmentId, attempt)
  }
  return attempt
}

async function runRedeploy(
  environmentId: string,
  createDeps: () => ManagedHivewarddRestoreUpdateDeps
): Promise<boolean> {
  try {
    const deps = createDeps()
    const target = deps.target(environmentId)
    if (!target) {
      return false
    }
    const { note, reason } = await checkManagedServerUpdate(target, environmentId, deps, () =>
      deps.publish(target, environmentId, 'updating')
    )
    deps.publish(target, environmentId, 'settled', note)
    return reason === 'updated'
  } catch (error) {
    console.warn('[ssh] Could not redeploy a stopped managed HiveWard server:', error)
    return false
  }
}

export function resetManagedHivewarddRestoreUpdatesForTests(): void {
  checked.clear()
  redeploying.clear()
}
