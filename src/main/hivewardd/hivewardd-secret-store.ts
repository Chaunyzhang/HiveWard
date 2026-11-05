// Always report available to prevent plaintext fallback; throw on seal/unseal when the key is unavailable.
import type { SecretStore } from '../../shared/secret-store'
import { sweepStaleRecordStaging } from './hivewardd-secret-key-record'
import {
  hivewarddSecretStatePath,
  resolveState,
  type HivewarddSecretStorePrepareOptions,
  type StoreState
} from './hivewardd-secret-key-resolution'
import { openHivewarddSecret, sealHivewarddSecret } from './hivewardd-secret-sealing'

export type HivewarddSecretStore = SecretStore & {
  prepare(options: HivewarddSecretStorePrepareOptions): Promise<boolean>
}

export function createHivewarddSecretStore(
  log: (message: string) => void = (message) => console.warn(message)
): HivewarddSecretStore {
  let state: StoreState = { kind: 'pending' }
  const readyKey = (): Buffer => {
    if (state.kind === 'ready') {
      return state.key
    }
    throw new Error(
      state.kind === 'unavailable'
        ? state.message
        : 'hivewardd_secret_store_not_prepared — the headless secret store has not loaded its key yet'
    )
  }
  return {
    isEncryptionAvailable: () => state.kind !== 'plaintext',
    encryptString: (plainText) => sealHivewarddSecret(readyKey(), plainText),
    decryptString: (cipher) => openHivewarddSecret(readyKey(), cipher),
    describeProtectionGap: () => {
      switch (state.kind) {
        case 'ready':
          return state.gap
        case 'unavailable':
          return state.message
        case 'plaintext':
          return state.reason
        case 'pending':
          return "HiveWard's headless server has not loaded its credential key yet."
      }
    },
    async prepare(next) {
      sweepStaleRecordStaging(hivewarddSecretStatePath(next))
      state = await resolveState(next, log)
      return state.kind === 'ready'
    }
  }
}
