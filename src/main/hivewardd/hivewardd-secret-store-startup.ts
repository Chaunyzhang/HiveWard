import { join } from 'node:path'
import { prepareHivewarddSecretStore } from './hivewardd-host-adapters'

export async function prepareHivewarddSecretStoreAndMigrate(userDataPath: string): Promise<void> {
  const { getSecretStore } = await import('../../shared/secret-store')
  const { reportSecretProtectionGap } = await import('../host/secret-protection-report')
  const { migratePlaintextCredentials, hivewarddCredentialRoot } =
    await import('./hivewardd-plaintext-credential-migration')
  // Keep sealing keys outside disposable HIVEWARD_USER_DATA roots.
  if (await prepareHivewarddSecretStore(hivewarddCredentialRoot(), userDataPath)) {
    migratePlaintextCredentials(getSecretStore())
  }
  reportSecretProtectionGap({ dataFile: join(userDataPath, 'hiveward-data.json') })
}
