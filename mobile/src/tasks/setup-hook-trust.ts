import type { PersistedTrustedHiveWardHooks } from '../../../src/shared/hiveward-yaml-hook-types'
import {
  canUseRepoWideTrust,
  type HiveWardHookTrustKind,
  withHiveWardHookRepoAlwaysTrusted,
  withHiveWardHookScriptConfirmed
} from '../../../src/shared/hiveward-hook-trust-entries'
import type { RpcClient } from '../transport/rpc-client'
import { taskUiStateWrite } from './mobile-task-runtime-operations'

export type SetupHookTrust = {
  contentHash: string
  scriptContent: string
}

export function isHiveWardHookTrusted(
  trust: PersistedTrustedHiveWardHooks,
  repos: readonly { id: string }[],
  repoId: string,
  kind: HiveWardHookTrustKind,
  contentHash: string
): boolean {
  return (
    canUseRepoWideTrust(trust, repos, repoId) || trust[repoId]?.[kind]?.contentHash === contentHash
  )
}

export function isSetupHookTrusted(
  trust: PersistedTrustedHiveWardHooks,
  repos: readonly { id: string }[],
  repoId: string,
  contentHash: string
): boolean {
  return isHiveWardHookTrusted(trust, repos, repoId, 'setup', contentHash)
}

export function wasHiveWardHookPreviouslyApproved(
  trust: PersistedTrustedHiveWardHooks,
  repoId: string,
  kind: HiveWardHookTrustKind
): boolean {
  return Boolean(trust[repoId]?.[kind]?.contentHash)
}

export function wasSetupHookPreviouslyApproved(
  trust: PersistedTrustedHiveWardHooks,
  repoId: string
): boolean {
  return wasHiveWardHookPreviouslyApproved(trust, repoId, 'setup')
}

type HookTrustApproval = {
  client: RpcClient
  trust: PersistedTrustedHiveWardHooks
  repoId: string
  contentHash: string
  alwaysTrust: boolean
}

export async function persistHiveWardHookTrustApproval(
  args: HookTrustApproval & { kind: HiveWardHookTrustKind }
): Promise<PersistedTrustedHiveWardHooks> {
  const next = args.alwaysTrust
    ? withHiveWardHookRepoAlwaysTrusted(args.trust, args.repoId)
    : withHiveWardHookScriptConfirmed(args.trust, args.repoId, args.kind, args.contentHash)
  taskUiStateWrite.interpret(
    await taskUiStateWrite.request(args.client, { trustedHiveWardHooks: next })
  )
  return next
}

export function persistSetupHookTrustApproval(
  args: HookTrustApproval
): Promise<PersistedTrustedHiveWardHooks> {
  return persistHiveWardHookTrustApproval({ ...args, kind: 'setup' })
}

// Hooks may omit setupTrust; validate the pair here while preserving other host fields.
export function normalizeSetupHookTrust(
  setupTrust: { contentHash?: string; scriptContent?: string } | null | undefined
): SetupHookTrust | null {
  const contentHash = setupTrust?.contentHash
  const scriptContent = setupTrust?.scriptContent
  if (!contentHash || !scriptContent) {
    return null
  }
  return { ...setupTrust, contentHash, scriptContent }
}

// New hosts send setupConfig (hiveward.yaml setup plus defaultTabs commands); older ones only the effective setup script.
export function readRepoHooksSetupCommand(reply: {
  hooks?: { scripts?: { setup?: string } } | null
  setupConfig?: { command: string } | null
}): string | null {
  if (reply.setupConfig !== undefined) {
    return reply.setupConfig?.command.trim() || null
  }
  return reply.hooks?.scripts?.setup?.trim() || null
}
