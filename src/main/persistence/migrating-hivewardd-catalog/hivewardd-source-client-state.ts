import type {
  HivewarddMigrationClientStatePayload,
  HivewarddMigrationUiRoutingState
} from '../../../shared/hivewardd-migration/hivewardd-migration-client-state'
import type {
  HivewarddMigrationCatalogPayload,
  HivewarddMigrationManifestSource
} from '../../../shared/hivewardd-migration/hivewardd-migration-manifest'
import type {
  PersistedMobileClientTabSelection,
  PersistedState
} from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { sessionPartitions } from './hivewardd-source-workspace-session-fragments'
import { collectCloseIntents } from './hivewardd-source-client-browser-intents'
import {
  createHivewarddMigrationExportScope,
  hivewarddMigrationScopeOwnsWholeHost,
  hivewarddMigrationOwnerMatchesScope,
  hivewarddMigrationOwnsRepoId,
  unqualifyHivewarddMigrationOwnerKey
} from './hivewardd-source-scope'
import { paneBelongsToTabs } from '../../../shared/workspace-session-pane-ownership'

export type HivewarddMigrationSourceClientStateInspection = {
  payload: HivewarddMigrationClientStatePayload | undefined
  /** Duplicate closes are folded into the existing workspace-session blocker. */
  blockedCount: number
  /** Presentation state that cannot move stays behind. */
  blockedCounts: { 'saved-port-forward': number }
}

export function collectHivewarddMigrationSourceClientState(
  state: PersistedState,
  source: HivewarddMigrationManifestSource,
  catalog: HivewarddMigrationCatalogPayload,
  destinationEnvironmentId: string | undefined,
  eligibleSession: WorkspaceSessionState | undefined
): HivewarddMigrationSourceClientStateInspection {
  const scope = createHivewarddMigrationExportScope({ source, catalog, repos: state.repos })
  const blockedCounts = { 'saved-port-forward': 0 }
  let blockedCount = 0
  const mobile = collectMobileSelections(state, scope, eligibleSession)
  const uiRouting = collectUiRouting(state, scope, eligibleSession)
  const target = state.sshTargets.find((entry) => entry.id === scope.targetId)
  const savedPortForwards = target?.portForwards ? structuredClone(target.portForwards) : undefined
  if (savedPortForwards) {
    const ports = new Set<number>()
    for (const forward of savedPortForwards) {
      if (ports.has(forward.localPort)) {
        blockedCounts['saved-port-forward'] += 1
      }
      ports.add(forward.localPort)
    }
  }
  const closeIntents = collectCloseIntents(
    state,
    scope,
    destinationEnvironmentId,
    eligibleSession,
    () => {
      blockedCount += 1
    }
  )
  const clientState: HivewarddMigrationClientStatePayload = {
    ...(mobile && Object.keys(mobile).length > 0
      ? { mobileClientTabSelectionsByDeviceId: mobile }
      : {}),
    ...(uiRouting && Object.keys(uiRouting).length > 0 ? { uiRouting } : {}),
    ...(savedPortForwards && savedPortForwards.length > 0 ? { savedPortForwards } : {}),
    ...(closeIntents && closeIntents.length > 0
      ? { clientHostedBrowserCloseIntents: closeIntents }
      : {})
  }
  return {
    payload: Object.keys(clientState).length > 0 ? clientState : undefined,
    blockedCount,
    blockedCounts
  }
}

function collectMobileSelections(
  state: PersistedState,
  scope: ReturnType<typeof createHivewarddMigrationExportScope>,
  session: WorkspaceSessionState | undefined
):
  | NonNullable<HivewarddMigrationClientStatePayload['mobileClientTabSelectionsByDeviceId']>
  | undefined {
  const eligible = session ? collectEligibleSessionIdentity(session, scope) : null
  const result: NonNullable<
    HivewarddMigrationClientStatePayload['mobileClientTabSelectionsByDeviceId']
  > = {}
  const destinationKeys = new Set<string>()
  for (const [deviceId, selections] of Object.entries(
    state.mobileClientTabSelectionsByDeviceId ?? {}
  )) {
    const projected: Record<string, PersistedMobileClientTabSelection> = {}
    for (const [ownerKey, selection] of Object.entries(selections)) {
      if (!hivewarddMigrationOwnerMatchesScope(ownerKey, scope)) {
        continue
      }
      const destinationKey = unqualifyHivewarddMigrationOwnerKey(ownerKey)
      const representable = representableMobileSelection(selection, eligible)
      if (!representable || destinationKeys.has(`${deviceId}\0${destinationKey}`)) {
        continue
      }
      destinationKeys.add(`${deviceId}\0${destinationKey}`)
      projected[destinationKey] = representable
    }
    if (Object.keys(projected).length > 0) {
      result[deviceId] = projected
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function collectUiRouting(
  state: PersistedState,
  scope: ReturnType<typeof createHivewarddMigrationExportScope>,
  session: WorkspaceSessionState | undefined
): HivewarddMigrationUiRoutingState | undefined {
  const ui = state.ui
  const result: HivewarddMigrationUiRoutingState = {}
  if (ui.lastActiveRepoId && hivewarddMigrationOwnsRepoId(scope, ui.lastActiveRepoId)) {
    result.lastActiveRepoId = ui.lastActiveRepoId
  }
  if (ui.lastActiveWorktreeId && hivewarddMigrationOwnerMatchesScope(ui.lastActiveWorktreeId, scope)) {
    result.lastActiveWorktreeId = unqualifyHivewarddMigrationOwnerKey(ui.lastActiveWorktreeId)
  }
  const dotfiles = Object.entries(ui.showDotfilesByWorktree ?? {})
    .filter(([ownerKey]) => hivewarddMigrationOwnerMatchesScope(ownerKey, scope))
    .map(([ownerKey, enabled]) => [unqualifyHivewarddMigrationOwnerKey(ownerKey), enabled] as const)
  if (dotfiles.length > 0) {
    result.showDotfilesByWorktree = Object.fromEntries(dotfiles)
  }
  const dismissed = (ui.setupScriptPromptDismissedRepoIds ?? []).filter((repoId) =>
    hivewarddMigrationOwnsRepoId(scope, repoId)
  )
  if (dismissed.length > 0) {
    result.setupScriptPromptDismissedRepoIds = dismissed
  }
  const manualOrder = (ui.manualRepoOrder ?? [])
    .filter((entry) => entry.hostId === scope.hostId && scope.repoIds.has(entry.repoId))
    .map((entry) => ({ hostId: 'local' as const, repoId: entry.repoId }))
  if (manualOrder.length > 0) {
    result.manualRepoOrder = manualOrder
  }
  // Sidebar filters belong to this desktop's window.
  const eligible = session ? collectEligibleSessionIdentity(session, scope) : null
  const sourceTabIds = collectSourceOwnedTabIds(state, scope)
  const acknowledgements = Object.entries(ui.acknowledgedAgentsByPaneKey ?? {}).filter(
    ([paneKey]) => {
      return (
        paneBelongsToTabs(paneKey, sourceTabIds) &&
        eligible !== null &&
        paneBelongsToTabs(paneKey, eligible.tabIds)
      )
    }
  )
  if (acknowledgements.length > 0) {
    result.acknowledgedAgentsByPaneKey = Object.fromEntries(acknowledgements)
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/** Include source-owned tabs from every partition. */
function collectSourceOwnedTabIds(
  state: PersistedState,
  scope: ReturnType<typeof createHivewarddMigrationExportScope>
): Set<string> {
  const tabIds = new Set<string>()
  for (const [hostId, session] of sessionPartitions(state, 'local')) {
    for (const [ownerKey, tabs] of Object.entries(session.tabsByWorktree ?? {})) {
      if (
        (hivewarddMigrationScopeOwnsWholeHost(scope) && hostId === scope.hostId) ||
        hivewarddMigrationOwnerMatchesScope(ownerKey, scope)
      ) {
        tabs.forEach((tab) => tabIds.add(tab.id))
      }
    }
  }
  return tabIds
}

type EligibleSessionIdentity = { tabIds: ReadonlySet<string>; groupIds: ReadonlySet<string> }

function collectEligibleSessionIdentity(
  session: WorkspaceSessionState,
  scope: ReturnType<typeof createHivewarddMigrationExportScope>
): EligibleSessionIdentity {
  const tabIds = new Set<string>()
  const groupIds = new Set<string>()
  for (const [ownerKey, tabs] of Object.entries(session.tabsByWorktree ?? {})) {
    if (!hivewarddMigrationOwnerMatchesScope(ownerKey, scope)) {
      continue
    }
    tabs.forEach((tab) => tabIds.add(tab.id))
  }
  for (const [ownerKey, tabs] of Object.entries(session.unifiedTabs ?? {})) {
    if (hivewarddMigrationOwnerMatchesScope(ownerKey, scope)) {
      tabs.forEach((tab) => tabIds.add(tab.id))
    }
  }
  for (const [ownerKey, groups] of Object.entries(session.tabGroups ?? {})) {
    if (!hivewarddMigrationOwnerMatchesScope(ownerKey, scope)) {
      continue
    }
    groups.forEach((group) => groupIds.add(group.id))
  }
  return { tabIds, groupIds }
}

/** Mobile terminal selections name panes: tabId::leafId. */
function movedMobileTab(id: string, tabIds: ReadonlySet<string>): boolean {
  const separator = id.indexOf('::')
  return tabIds.has(id) || (separator !== -1 && tabIds.has(id.slice(0, separator)))
}

/** Drop references to tabs/groups that did not move; null when none remain. */
function representableMobileSelection(
  selection: PersistedMobileClientTabSelection,
  eligible: EligibleSessionIdentity | null
): PersistedMobileClientTabSelection | null {
  const tabIds = eligible?.tabIds ?? new Set<string>()
  const groupIds = eligible?.groupIds ?? new Set<string>()
  const recentTabIds = selection.recentTabIds?.filter((tabId) => tabIds.has(tabId)) ?? []
  const next: PersistedMobileClientTabSelection = {
    activeTabId:
      selection.activeTabId !== null && movedMobileTab(selection.activeTabId, tabIds)
        ? selection.activeTabId
        : null,
    activeGroupId:
      selection.activeGroupId !== null && groupIds.has(selection.activeGroupId)
        ? selection.activeGroupId
        : null,
    activeTabIdByGroupId: Object.fromEntries(
      Object.entries(selection.activeTabIdByGroupId).filter(
        ([groupId, tabId]) => groupIds.has(groupId) && tabIds.has(tabId)
      )
    ),
    ...(recentTabIds.length > 0 ? { recentTabIds } : {})
  }
  return next.activeTabId === null &&
    next.activeGroupId === null &&
    Object.keys(next.activeTabIdByGroupId).length === 0
    ? null
    : next
}
