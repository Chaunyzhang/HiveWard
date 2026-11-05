import { hivewardSessionAddressSql } from '../hiveward-session-address-sql'
import type { HiveWardSessionId } from '../../../../../shared/hiveward-session-address'
import type { RunRow } from '../../types'

type RunCoordinatorHiveWardSessionFields = Pick<
  RunRow,
  'coordinator_hiveward_session_id' | 'coordinator_hiveward_session_id_generation' | 'consumer_generation'
>

/** Count a coordinator session id only at its stamped consumer generation; older writers bump generation without clearing it. */
export function currentRunCoordinatorHiveWardSessionId(
  run: RunCoordinatorHiveWardSessionFields
): HiveWardSessionId | null {
  return run.coordinator_hiveward_session_id_generation === run.consumer_generation
    ? run.coordinator_hiveward_session_id
    : null
}

/** The same rule in SQL, for a `runs` row named `row` (a table name, alias, or `NEW`). */
export function currentRunCoordinatorHiveWardSessionIdSql(row: string): string {
  return `(CASE WHEN ${row}.coordinator_hiveward_session_id_generation = ${row}.consumer_generation
    THEN ${row}.coordinator_hiveward_session_id END)`
}

/** The coordinator's `hiveward_session_id:<id>` address in SQL; NULL when it has no current HiveWard session id. */
export function currentRunCoordinatorSessionAddressSql(row: string): string {
  return hivewardSessionAddressSql(currentRunCoordinatorHiveWardSessionIdSql(row))
}
