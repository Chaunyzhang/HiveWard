import {
  MANAGED_HOOK_TIMEOUT_SECONDS,
  readHooksJson,
  type HooksConfig
} from '../agent-hooks/installer-utils'
import {
  computeTrustKey,
  getCodexExplicitHomeHookSourcePath,
  readHookTrustEntries,
  type CodexEventLabel,
  type CodexHookTrustState
} from './config-toml-trust'
import {
  CODEX_EVENTS,
  CODEX_EVENT_LABEL,
  computeHiveWardCodexHookHashes,
  getCodexConfigTomlPath,
  getConfigPath,
  getSystemCodexConfigTomlPath
} from './codex-hook-definition'
import { readEveryKnownCodexHookHashes } from './codex-hook-hash-lookup'
import { getSystemCodexHomePath } from './codex-home-paths'
import { readLedgerHiveWardHashes } from './codex-managed-trust-reconciliation'
import {
  getRealHomeHookKeySourcePaths,
  getRealHomeHooksJsonPath
} from './codex-real-home-hooks-json'
import type { CodexHookHashes } from './codex-hook-trust-derivation'

export type CodexHookHome = {
  homePath: string
  hooksJsonPath: string
  tomlPath: string
  keySourcePaths: readonly [string, ...string[]]
}

export function getManagedCodexHookHome(runtimeHomePath: string): CodexHookHome {
  const hooksJsonPath = getConfigPath(runtimeHomePath)
  return {
    homePath: runtimeHomePath,
    hooksJsonPath,
    tomlPath: getCodexConfigTomlPath(runtimeHomePath),
    keySourcePaths: [getCodexExplicitHomeHookSourcePath(hooksJsonPath)]
  }
}

/** In-place homes keep user hooks and approvals in their original slots. */
export function getInPlaceCodexHookHome(homePath: string): CodexHookHome {
  const hooksJsonPath = getConfigPath(homePath)
  return {
    homePath,
    hooksJsonPath,
    tomlPath: getCodexConfigTomlPath(homePath),
    keySourcePaths: getRealHomeHookKeySourcePaths(hooksJsonPath)
  }
}

export function getRealHomeCodexHookHome(): CodexHookHome {
  return {
    homePath: getSystemCodexHomePath(),
    hooksJsonPath: getRealHomeHooksJsonPath(),
    tomlPath: getSystemCodexConfigTomlPath(),
    keySourcePaths: getRealHomeHookKeySourcePaths()
  }
}

type CodexEventName = (typeof CODEX_EVENTS)[number]
type HiveWardEntrySlot = { groupIndex: number; handlerIndex: number }
type HiveWardEntryApproval = CodexHookTrustState & { key: string; trustedHash: string }

export function findHiveWardEntrySlots(
  hooks: HooksConfig['hooks'],
  command: string
): Map<CodexEventName, HiveWardEntrySlot> {
  return new Map(
    CODEX_EVENTS.flatMap((eventName) => {
      const definitions = Array.isArray(hooks?.[eventName]) ? hooks[eventName] : []
      const slot = definitions.flatMap((definition, groupIndex) =>
        (definition.hooks ?? []).flatMap((hook, handlerIndex) =>
          hook.command === command ? [{ groupIndex, handlerIndex }] : []
        )
      )[0]
      return slot ? [[eventName, slot] as const] : []
    })
  )
}

/** Include approvals under every source-path spelling Codex uses. */
export function approvalsAtHiveWardEntries(
  trustStates: ReadonlyMap<string, CodexHookTrustState>,
  slots: ReadonlyMap<CodexEventName, HiveWardEntrySlot>,
  keySourcePaths: readonly string[],
  command: string
): Map<CodexEventLabel, HiveWardEntryApproval[]> {
  return new Map(
    [...slots].map(([eventName, slot]) => {
      const eventLabel = CODEX_EVENT_LABEL[eventName]
      const approvals = keySourcePaths.flatMap((sourcePath) => {
        const key = computeTrustKey({ sourcePath, eventLabel, command, ...slot })
        const state = trustStates.get(key)
        return state?.trustedHash ? [{ ...state, key, trustedHash: state.trustedHash }] : []
      })
      return [eventLabel, approvals]
    })
  )
}

// Positional keys may hold removed user hooks' approvals; only recognize known HiveWard hashes.
export function readKnownHiveWardHashes(home: CodexHookHome, command: string): CodexHookHashes[] {
  return [
    computeHiveWardCodexHookHashes(command),
    ...readEveryKnownCodexHookHashes(),
    ...readLedgerHiveWardHashes(home.homePath, command, MANAGED_HOOK_TIMEOUT_SECONDS)
  ]
}

export function isKnownHiveWardHash(
  knownHiveWardHashes: readonly CodexHookHashes[],
  eventLabel: CodexEventLabel,
  trustedHash: string | undefined
): boolean {
  return (
    trustedHash !== undefined &&
    knownHiveWardHashes.some((hashes) => hashes[eventLabel] === trustedHash)
  )
}

/** Until Codex answers, prefer existing known approvals over local hashes. */
export function readStopgapHiveWardHashes(home: CodexHookHome, command: string): CodexHookHashes {
  let trustStates: ReadonlyMap<string, CodexHookTrustState>
  try {
    trustStates = readHookTrustEntries(home.tomlPath)
  } catch {
    trustStates = new Map()
  }
  return findStopgapHiveWardHashes({
    trustStates,
    hooks: readHooksJson(home.hooksJsonPath)?.hooks,
    keySourcePaths: home.keySourcePaths,
    command,
    knownHiveWardHashes: readKnownHiveWardHashes(home, command)
  })
}

export function findStopgapHiveWardHashes(found: {
  trustStates: ReadonlyMap<string, CodexHookTrustState>
  hooks: HooksConfig['hooks']
  keySourcePaths: readonly string[]
  command: string
  knownHiveWardHashes: readonly CodexHookHashes[]
}): CodexHookHashes {
  const slots = findHiveWardEntrySlots(found.hooks, found.command)
  const approvals = approvalsAtHiveWardEntries(
    found.trustStates,
    slots,
    found.keySourcePaths,
    found.command
  )
  return {
    ...computeHiveWardCodexHookHashes(found.command),
    ...Object.fromEntries(
      [...approvals].flatMap(([eventLabel, held]) => {
        // Codex hashes content, so a known hash survives position changes.
        const approval = held.find(({ trustedHash }) =>
          isKnownHiveWardHash(found.knownHiveWardHashes, eventLabel, trustedHash)
        )
        return approval ? [[eventLabel, approval.trustedHash]] : []
      })
    )
  }
}
