import type { HivewarddTerminalCensus } from '../../../shared/hivewardd-terminal-census'
import type { HivewarddRollbackResult } from '../install/hivewardd-remote-rollback'

export function rollbackRecountRefusal(census: HivewarddTerminalCensus): HivewarddRollbackResult | null {
  const live = census.liveSessions
  if (live === 0) {
    return null
  }
  return {
    outcome: 'refused',
    code: live === null ? 'hivewardd_rollback_census_unavailable' : 'hivewardd_rollback_terminals_running',
    reason:
      live === null
        ? 'The server did not answer how many terminals it runs. Retry when it answers.'
        : 'A terminal opened on this server before it could be stopped; close it, then retry.'
  }
}

export const ROLLBACK_STALE_COUNT: HivewarddRollbackResult = {
  outcome: 'refused',
  code: 'hivewardd_rollback_census_unavailable',
  reason: 'The terminal count went stale before the server could be stopped. Retry the rollback.'
}
