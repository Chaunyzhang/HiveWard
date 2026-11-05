import type { Store } from '../persistence/loading-store/store'
import {
  listHivewarddMigrationSourceCutovers,
  setHivewarddMigrationJournalChangeListener
} from './hivewardd-migration-cutover-journal'

export function installHivewarddMigrationScrollbackRetention(
  userDataPath: string,
  store: Pick<Store, 'syncHivewarddMigrationScrollbackRetention'>
): void {
  const sync = (path: string): void => {
    try {
      // Retain bytes until durable commit/abort; closed tabs must still upload on retry.
      const pending = listHivewarddMigrationSourceCutovers(path).filter(
        (cutover) => cutover.phase === 'source-fenced' || cutover.phase === 'destination-staged'
      )
      store.syncHivewarddMigrationScrollbackRetention(pending.map((cutover) => cutover.manifest))
    } catch (error) {
      // An unreadable journal keeps whatever is held; releasing on a guess could lose bytes.
      console.warn('[hivewardd-migration] Could not sync scrollback retention:', error)
    }
  }
  setHivewarddMigrationJournalChangeListener(sync)
  sync(userDataPath)
}
