import { getManagedDataAccountService } from '../managed-data-accounts/service'
import { resolveOpenCodeDataDirectory } from './opencode-data-directory'

/** History must cover every account's store, not only the one HiveWard's own environment points at. */
export function managedOpenCodeAccountDataDirs(): string[] {
  try {
    return getManagedDataAccountService()
      .transcriptEnvironments('opencode')
      .map((environment) => resolveOpenCodeDataDirectory(environment))
  } catch (error) {
    console.warn('[ai-vault] Could not read OpenCode managed accounts:', error)
    return []
  }
}
