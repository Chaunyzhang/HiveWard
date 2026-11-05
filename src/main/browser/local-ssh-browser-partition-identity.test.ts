import { describe, expect, it } from 'vitest'
import { sshExecutionHostStorageIdentity } from './browser-execution-host-storage-identity'
import {
  deriveBrowserRoutePartition,
  deriveBrowserRoutePartitionStorageScope,
  deriveLocalSshBrowserRoutePartitionStorageScope
} from './browser-route-identity'
import { localSshBrowserAuthorityConnectionIdentity } from './local-ssh-browser-partitions'

function derive(hivewardProfileId: string, browserProfileId: string, targetId: string) {
  return deriveBrowserRoutePartition({
    hivewardProfileId,
    browserProfileId,
    authorityConnectionIdentity: localSshBrowserAuthorityConnectionIdentity(hivewardProfileId),
    executionHostIdentity: sshExecutionHostStorageIdentity(targetId)
  })
}

describe('local ssh browser partition identity', () => {
  it('pins the golden partition so no per-boot value can sneak into the name', () => {
    // Changing this cookie-storage identity requires a migration.
    expect(derive('local-default', 'default', 'ssh-target-1').partition).toBe(
      'persist:hiveward-browser-v1-fc2f62bd6b5496289bde5de8ed1d092dbc4deabccc2e0b787c1a9ed6def03e16'
    )
  })

  it('derives one stable partition per (profile, target) and separates each axis', () => {
    const base = derive('local-default', 'default', 'ssh-target-1')
    expect(derive('local-default', 'default', 'ssh-target-1')).toEqual(base)
    expect(derive('local-default', 'default', 'ssh-target-2').partition).not.toBe(base.partition)
    expect(derive('local-default', 'session-a', 'ssh-target-1').partition).not.toBe(base.partition)
    expect(derive('profile-b', 'default', 'ssh-target-1').partition).not.toBe(base.partition)
  })

  it('separates the local-ssh storage scope domain from environment scopes', () => {
    expect(
      deriveLocalSshBrowserRoutePartitionStorageScope({
        hivewardProfileId: 'local-default',
        targetId: 'same-id'
      })
    ).not.toBe(
      deriveBrowserRoutePartitionStorageScope({
        hivewardProfileId: 'local-default',
        environmentId: 'same-id'
      })
    )
  })
})
