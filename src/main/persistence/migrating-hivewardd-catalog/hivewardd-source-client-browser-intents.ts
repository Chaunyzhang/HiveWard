import type { HivewarddMigrationClientHostedBrowserCloseIntent } from '../../../shared/hivewardd-migration/hivewardd-migration-client-state'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  hivewarddMigrationOwnerMatchesScope,
  unqualifyHivewarddMigrationOwnerKey,
  type HivewarddMigrationSourceScope
} from './hivewardd-source-scope'

export function collectCloseIntents(
  state: PersistedState,
  scope: HivewarddMigrationSourceScope,
  destinationEnvironmentId: string | undefined,
  eligibleSession: WorkspaceSessionState | undefined,
  onBlocked: () => void
): HivewarddMigrationClientHostedBrowserCloseIntent[] | undefined {
  const eligiblePages = new Set<string>()
  for (const [ownerKey, pages] of Object.entries(
    eligibleSession?.clientHostedBrowserPagesByWorktree ?? {}
  )) {
    if (!hivewarddMigrationOwnerMatchesScope(ownerKey, scope)) {
      continue
    }
    const worktreeId = unqualifyHivewarddMigrationOwnerKey(ownerKey)
    for (const page of pages) {
      eligiblePages.add(`${worktreeId}\0${page.browserPageId}`)
    }
  }
  const result: HivewarddMigrationClientHostedBrowserCloseIntent[] = []
  const seen = new Set<string>()
  const sessions = [
    state.workspaceSession,
    ...Object.values(state.workspaceSessionsByHostId ?? {}).flatMap((entry) =>
      entry ? [entry] : []
    )
  ].filter((entry): entry is WorkspaceSessionState => Boolean(entry))
  for (const session of sessions) {
    for (const [sourceEnvironmentId, intents] of Object.entries(
      session.clientHostedBrowserCloseIntentsByEnvironment ?? {}
    )) {
      if (sourceEnvironmentId === destinationEnvironmentId) {
        continue
      }
      for (const intent of intents) {
        if (!hivewarddMigrationOwnerMatchesScope(intent.worktreeId, scope)) {
          continue
        }
        const worktreeId = unqualifyHivewarddMigrationOwnerKey(intent.worktreeId)
        const key = `${sourceEnvironmentId}\0${intent.browserPageId}\0${worktreeId}`
        // The client still owes closes for pages that did not migrate.
        if (
          !eligiblePages.has(`${worktreeId}\0${intent.browserPageId}`) ||
          !destinationEnvironmentId
        ) {
          continue
        }
        if (seen.has(key)) {
          onBlocked()
          continue
        }
        seen.add(key)
        result.push({
          sourceEnvironmentId,
          browserPageId: intent.browserPageId,
          worktreeId,
          closedAt: intent.closedAt
        })
      }
    }
  }
  return result.length > 0 ? result : undefined
}
