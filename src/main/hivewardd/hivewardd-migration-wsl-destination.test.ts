import { describe, expect, it } from 'vitest'
import type { HivewarddMigrationManifestSource } from '../../shared/hivewardd-migration/hivewardd-migration-manifest'
import {
  assertHivewarddMigrationSourceServedHere,
  HIVEWARDD_MIGRATION_SOURCE_NOT_THIS_HOST
} from './hivewardd-migration-wsl-destination'

const WSL_SOURCE: HivewarddMigrationManifestSource = {
  kind: 'local-wsl',
  distro: 'Ubuntu',
  scopeRepoIds: ['repo-1'],
  scopeFolderWorkspaceIds: [],
  generation: 1
}
const WSL_HOST = { HIVEWARD_WSL_HIVEWARDD_HOST: '1', WSL_DISTRO_NAME: 'ubuntu' }

describe('WSL migration destination', () => {
  it('accepts its own distro, case-insensitively', () => {
    expect(() => assertHivewarddMigrationSourceServedHere(WSL_SOURCE, WSL_HOST, 'linux')).not.toThrow()
  })

  it.each([
    ['another distro', { ...WSL_HOST, WSL_DISTRO_NAME: 'Debian' }, 'linux'],
    ['a plain Linux host', {}, 'linux'],
    ['a desktop', WSL_HOST, 'darwin']
  ] as const)('refuses a WSL source on %s', (_label, env, platform) => {
    expect(() => assertHivewarddMigrationSourceServedHere(WSL_SOURCE, env, platform)).toThrow(
      HIVEWARDD_MIGRATION_SOURCE_NOT_THIS_HOST
    )
  })

  it('refuses a source from another registration of the same distro name', () => {
    const source = { ...WSL_SOURCE, distroGuid: '{AAAA}' }
    expect(() =>
      assertHivewarddMigrationSourceServedHere(
        source,
        { ...WSL_HOST, HIVEWARD_WSL_DISTRO_GUID: '{aaaa}' },
        'linux'
      )
    ).not.toThrow()
    for (const env of [{ ...WSL_HOST, HIVEWARD_WSL_DISTRO_GUID: '{BBBB}' }, WSL_HOST]) {
      expect(() => assertHivewarddMigrationSourceServedHere(source, env, 'linux')).toThrow(
        HIVEWARDD_MIGRATION_SOURCE_NOT_THIS_HOST
      )
    }
  })
})
