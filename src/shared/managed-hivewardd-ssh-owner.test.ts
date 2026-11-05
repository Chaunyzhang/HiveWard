import { describe, expect, it } from 'vitest'
import {
  getLegacyManagedHivewarddOwnerEnvironmentId,
  getManagedHivewarddFenceEnvironmentId,
  isEphemeralRuntimeSshOwner,
  managedHivewarddServerName
} from './managed-hivewardd-ssh-owner'

describe('managed hivewardd SSH fence', () => {
  it('reads the fence from hivewarddFence, never from owner', () => {
    expect(getManagedHivewarddFenceEnvironmentId({ hivewarddFence: { environmentId: 'env-1' } })).toBe(
      'env-1'
    )
    const legacyOnly = {
      hivewarddFence: undefined,
      owner: { type: 'on-demand-runtime' as const, runtimeId: 'managed-hivewardd:old' }
    }
    expect(getManagedHivewarddFenceEnvironmentId({ ...legacyOnly })).toBeNull()
    expect(
      getManagedHivewarddFenceEnvironmentId({ ...legacyOnly, hivewarddFence: { environmentId: 'env-2' } })
    ).toBe('env-2')
    expect(getManagedHivewarddFenceEnvironmentId(undefined)).toBeNull()
  })

  it('recognises the legacy owner fence only so loading can migrate it', () => {
    const legacy = { type: 'on-demand-runtime' as const, runtimeId: 'managed-hivewardd:env-1' }
    expect(getLegacyManagedHivewarddOwnerEnvironmentId(legacy)).toBe('env-1')
    expect(isEphemeralRuntimeSshOwner(legacy)).toBe(false)
  })

  it('keeps ordinary on-demand runtime targets ephemeral', () => {
    const owner = { type: 'on-demand-runtime' as const, runtimeId: 'runtime-1' }
    expect(getLegacyManagedHivewarddOwnerEnvironmentId(owner)).toBeNull()
    expect(isEphemeralRuntimeSshOwner(owner)).toBe(true)
  })

  it("names a recipe VM's server after its runtime, so two VMs of one recipe never collide", () => {
    const owner = { type: 'on-demand-runtime' as const, runtimeId: 'runtime-0123456789abcdef' }
    expect(managedHivewarddServerName({ label: 'Docker root', owner })).toBe('Docker root VM 89abcdef')
    expect(
      managedHivewarddServerName({
        label: 'Docker root',
        owner: { ...owner, runtimeId: 'runtime-fedcba9876543210' }
      })
    ).toBe('Docker root VM 76543210')
    expect(managedHivewarddServerName({ label: 'Builder' })).toBe('Builder')
  })
})
