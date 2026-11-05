import type { GlobalSettings } from '../../shared/global-settings-types'

/** Whether HiveWard may link Codex sessions between account homes and ~/.codex; absent means on. */
export function isCodexHistorySharedAcrossAccounts(
  settings: Pick<GlobalSettings, 'codexShareHistoryAcrossAccounts'>
): boolean {
  return settings.codexShareHistoryAcrossAccounts !== false
}
