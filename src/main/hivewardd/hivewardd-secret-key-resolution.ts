import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import process from 'node:process'
import { withFileTransactionLock } from '../file-transaction-lock'
import { profileStateAccessMachineIdentity } from '../persistence/profile-state/profile-state-access-identity'
import {
  resolveHivewarddLegacyKeyringReader,
  type HivewarddLegacyKeyringReader
} from './hivewardd-legacy-keyring-key'
import {
  decodeMasterKey,
  isTemporaryKeyDir,
  hivewarddSecretStateFileName,
  publishRecordExclusively,
  readStoredRecord,
  replaceRecord,
  restrictExistingRecord,
  type StoredKeyState
} from './hivewardd-secret-key-record'
import {
  describeHivewarddHostKeyGap,
  describeHivewarddDisposableProfile,
  describeHivewarddPlaintextOptOut,
  describeHivewarddSealingUnavailable,
  HIVEWARDD_PLAINTEXT_SECRETS_ENV
} from './hivewardd-secret-protection-gap'
import {
  deriveHivewarddSealingKey,
  HIVEWARDD_MASTER_KEY_BYTES,
  hivewarddSealingKeyCheck
} from './hivewardd-secret-sealing'

export type StoreState =
  | { kind: 'pending' }
  | { kind: 'plaintext'; reason: string }
  | { kind: 'ready'; key: Buffer; gap: string | null }
  | { kind: 'unavailable'; message: string }

export type HivewarddSecretStorePrepareOptions = {
  /** Keep the key beside the credentials so their lifetimes match. */
  keyDir: string
  /** Disposable profiles leave persistent keys untouched. */
  userDataPath?: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  legacyKeyring?: HivewarddLegacyKeyringReader | null
  machineIdentity?: () => string | null
  isTemporaryKeyDir?: (keyDir: string) => boolean
}

type Context = {
  machineId: string | null
  statePath: string
  legacyKeyring: () => HivewarddLegacyKeyringReader | null
  log: (message: string) => void
  unavailable: (reason: string) => StoreState
}

export function hivewarddSecretStatePath(options: HivewarddSecretStorePrepareOptions): string {
  const machineId = (options.machineIdentity ?? profileStateAccessMachineIdentity)()
  return join(options.keyDir, hivewarddSecretStateFileName(machineId))
}

function newFileRecord(machineId: string | null): StoredKeyState {
  const master = randomBytes(HIVEWARDD_MASTER_KEY_BYTES)
  return {
    version: 1,
    backend: 'host-file',
    key: master.toString('base64'),
    hostBound: machineId !== null,
    check: hivewarddSealingKeyCheck(deriveHivewarddSealingKey(master, machineId ?? ''))
  }
}

/** Migrate legacy keyring keys once; inaccessible keys are replaced and old credentials need reconnecting. */
async function migrateKeyringRecord(
  stored: Extract<StoredKeyState, { backend: 'os-keyring' }>,
  context: Context
): Promise<StoreState | 'reload'> {
  const reader = context.legacyKeyring()
  const found = reader ? await reader(stored.account) : { failure: 'no OS keyring is reachable' }
  const master = 'key' in found ? decodeMasterKey(found.key) : null
  const matches =
    master !== null && hivewarddSealingKeyCheck(deriveHivewarddSealingKey(master, '')) === stored.check
  const record: StoredKeyState =
    master && matches
      ? {
          version: 1,
          backend: 'host-file',
          key: master.toString('base64'),
          hostBound: false,
          check: stored.check
        }
      : newFileRecord(context.machineId)
  const replaced = replaceRecord(context.statePath, record, stored)
  if (replaced === 'changed') {
    return 'reload'
  }
  if (replaced !== 'replaced') {
    return context.unavailable(replaced)
  }
  const why = 'failure' in found ? found.failure : 'it is not the key the credentials use'
  context.log(
    matches
      ? '[secrets] Copied the credential key from the OS keyring into the owner-only key file.'
      : `[secrets] Could not read the credential key from the OS keyring (${why}); started a new ` +
          'key file. Reconnect any integration whose saved credential no longer opens.'
  )
  return 'reload'
}

async function loadStoredRecord(
  stored: StoredKeyState,
  context: Context
): Promise<StoreState | 'reload'> {
  if (stored.backend === 'os-keyring') {
    // Serialize concurrent key migrations.
    // Retry beyond the bounded keyring read budget.
    return withFileTransactionLock(
      context.statePath,
      async () => {
        // Another start may have migrated the record while this one waited.
        const current = readStoredRecord(context.statePath)
        return current.kind === 'record' &&
          current.stored.backend === 'os-keyring' &&
          current.stored.check === stored.check
          ? migrateKeyringRecord(current.stored, context)
          : 'reload'
      },
      { retries: 4 }
    ).catch((error: unknown) =>
      context.unavailable(
        `its key record could not be locked against another server (${String(error)})`
      )
    )
  }
  const { unavailable } = context
  if (!(await restrictExistingRecord(context.statePath))) {
    return unavailable(`its key record ${context.statePath} could not be restricted to this user`)
  }
  const master = decodeMasterKey(stored.key)
  const binding = stored.hostBound ? context.machineId : ''
  if (!master || binding === null) {
    return unavailable('this machine no longer reports the machine ID its key is bound to')
  }
  const key = deriveHivewarddSealingKey(master, binding)
  if (hivewarddSealingKeyCheck(key) !== stored.check) {
    return unavailable('its key is bound to a different machine ID')
  }
  return { kind: 'ready', key, gap: describeHivewarddHostKeyGap(stored.hostBound) }
}

export async function resolveState(
  options: HivewarddSecretStorePrepareOptions,
  log: (message: string) => void
): Promise<StoreState> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  if (env[HIVEWARDD_PLAINTEXT_SECRETS_ENV] === 'plaintext') {
    return { kind: 'plaintext', reason: describeHivewarddPlaintextOptOut() }
  }
  // Disposable runs must not alter persistent keys or re-seal credentials that outlive them.
  if (
    options.userDataPath &&
    (options.isTemporaryKeyDir ?? isTemporaryKeyDir)(options.userDataPath)
  ) {
    return { kind: 'plaintext', reason: describeHivewarddDisposableProfile() }
  }
  const machineId = (options.machineIdentity ?? profileStateAccessMachineIdentity)()
  const statePath = join(options.keyDir, hivewarddSecretStateFileName(machineId))
  const context: Context = {
    machineId,
    statePath,
    legacyKeyring: () =>
      options.legacyKeyring === undefined
        ? resolveHivewarddLegacyKeyringReader(platform, env)
        : options.legacyKeyring,
    log,
    unavailable: (reason) => ({
      kind: 'unavailable',
      message: describeHivewarddSealingUnavailable(reason, statePath)
    })
  }
  // Reload the winning record after publication races or migration.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = readStoredRecord(statePath)
    if (existing.kind === 'record') {
      const loaded = await loadStoredRecord(existing.stored, context)
      if (loaded !== 'reload') {
        return loaded
      }
      continue
    }
    if (existing.kind === 'unreadable') {
      return context.unavailable(existing.reason)
    }
    const record = newFileRecord(machineId)
    // A key that never reaches disk would lose every sealed credential on restart.
    const published = publishRecordExclusively(statePath, record)
    if (published === 'published') {
      continue
    }
    if (published !== 'exists') {
      return context.unavailable(published)
    }
  }
  return context.unavailable('another server kept replacing its key record')
}
