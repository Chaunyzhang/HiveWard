import {
  HIVEWARD_SESSION_ADDRESS_PREFIX,
  HIVEWARD_SESSION_ID_PREFIX
} from '../../../../shared/hiveward-session-address'

/** Format bare ids as session addresses (NULL stays NULL); never strip addresses and risk matching handles or Runs. */
export function hivewardSessionAddressSql(hivewardSessionIdSql: string): string {
  return `((CASE WHEN substr(${hivewardSessionIdSql}, 1, ${HIVEWARD_SESSION_ID_PREFIX.length}) = '${HIVEWARD_SESSION_ID_PREFIX}' THEN '${HIVEWARD_SESSION_ADDRESS_PREFIX}' ELSE '${HIVEWARD_SESSION_ADDRESS_PREFIX}' END) || ${hivewardSessionIdSql})`
}
