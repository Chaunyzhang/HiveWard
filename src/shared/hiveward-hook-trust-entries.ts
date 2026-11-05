import type {
  PersistedTrustedHiveWardHookRepo,
  PersistedTrustedHiveWardHooks
} from './hiveward-yaml-hook-types'

export type HiveWardHookTrustKind = Exclude<keyof PersistedTrustedHiveWardHookRepo, 'all'>

export function canUseRepoWideTrust(
  trust: PersistedTrustedHiveWardHooks,
  repos: readonly { id: string }[],
  repoId: string
): boolean {
  // Why: with the id on two hosts, trusting one row's script could run the other's unseen.
  return Boolean(trust[repoId]?.all) && repos.filter((repo) => repo.id === repoId).length < 2
}

/** Returns `trust` itself when the approval is already recorded. */
export function withHiveWardHookScriptConfirmed(
  trust: PersistedTrustedHiveWardHooks,
  repoId: string,
  kind: HiveWardHookTrustKind,
  contentHash: string,
  approvedAt: number = Date.now()
): PersistedTrustedHiveWardHooks {
  const existing = trust[repoId]
  if (existing?.[kind]?.contentHash === contentHash) {
    return trust
  }
  return { ...trust, [repoId]: { ...existing, [kind]: { contentHash, approvedAt } } }
}

/** Returns `trust` itself when the repo is already always-trusted. */
export function withHiveWardHookRepoAlwaysTrusted(
  trust: PersistedTrustedHiveWardHooks,
  repoId: string,
  approvedAt: number = Date.now()
): PersistedTrustedHiveWardHooks {
  const existing = trust[repoId]
  if (existing?.all) {
    return trust
  }
  return { ...trust, [repoId]: { ...existing, all: { approvedAt } } }
}
