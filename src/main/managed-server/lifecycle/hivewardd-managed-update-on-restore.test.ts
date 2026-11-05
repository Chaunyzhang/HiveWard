import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../../shared/ssh-types'
import type { ManagedHivewarddAutoUpdateOutcome } from './hivewardd-managed-auto-update'
import {
  redeployStoppedManagedHivewardd,
  resetManagedHivewarddRestoreUpdatesForTests,
  updateManagedHivewarddOnRestore,
  type ManagedHivewarddRestoreUpdateDeps
} from './hivewardd-managed-update-on-restore'

const target: SshTarget = { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' }

function deps(
  outcome: ManagedHivewarddAutoUpdateOutcome,
  overrides: Partial<ManagedHivewarddRestoreUpdateDeps> = {}
): ManagedHivewarddRestoreUpdateDeps {
  return {
    target: () => target,
    publish: vi.fn(),
    autoUpdate: vi.fn(async (_id, options) => {
      if (outcome.outcome === 'updated' || outcome.outcome === 'failed') {
        options.onUpdating()
      }
      return outcome
    }),
    recordedUpdateFailure: () => null,
    failedThisLaunch: () => true,
    recordUpdateFailure: vi.fn(),
    clearUpdateFailure: vi.fn(),
    ...overrides
  }
}

describe('updating a managed server when the launch restores its tunnel', () => {
  beforeEach(() => resetManagedHivewarddRestoreUpdatesForTests())

  it('checks each server once per session, however often its tunnel is ensured', async () => {
    const d = deps({ outcome: 'skipped', reason: 'current' })
    await updateManagedHivewarddOnRestore('env-1', () => d)
    expect(updateManagedHivewarddOnRestore('env-1', () => d)).toBeNull()
    expect(d.autoUpdate).toHaveBeenCalledTimes(1)
  })

  it('never fails the restore that triggered it', async () => {
    const thrown = deps(
      { outcome: 'skipped', reason: 'current' },
      {
        autoUpdate: async () => {
          throw new Error('ssh dropped')
        }
      }
    )
    await expect(updateManagedHivewarddOnRestore('env-1', () => thrown)).resolves.toBeUndefined()
    expect(
      updateManagedHivewarddOnRestore('env-2', () => {
        throw new Error('no SSH store')
      })
    ).toBeNull()
    const unlinked = deps({ outcome: 'skipped', reason: 'current' }, { target: () => null })
    expect(updateManagedHivewarddOnRestore('env-3', () => unlinked)).toBeNull()
    expect(unlinked.autoUpdate).not.toHaveBeenCalled()
  })
})

describe('redeploying a server another desktop stopped mid-session', () => {
  beforeEach(() => resetManagedHivewarddRestoreUpdatesForTests())

  it('runs even after this session already checked the server, and reports activation', async () => {
    await updateManagedHivewarddOnRestore('env-1', () =>
      deps({ outcome: 'skipped', reason: 'current' })
    )
    const d = deps({ outcome: 'updated', activeVersion: '0.1.0+b' })
    await expect(redeployStoppedManagedHivewardd('env-1', () => d)).resolves.toBe(true)
    expect(d.autoUpdate).toHaveBeenCalledWith('env-1', expect.anything())
    expect(vi.mocked(d.publish).mock.calls.at(-1)).toEqual([target, 'env-1', 'settled', undefined])
  })

  it('shares one attempt between concurrent calls and retries on the next one', async () => {
    const d = deps({ outcome: 'failed', reason: 'upload failed' })
    const [first, second] = await Promise.all([
      redeployStoppedManagedHivewardd('env-1', () => d),
      redeployStoppedManagedHivewardd('env-1', () => d)
    ])
    expect([first, second]).toEqual([false, false])
    expect(d.autoUpdate).toHaveBeenCalledTimes(1)
    await redeployStoppedManagedHivewardd('env-1', () => d)
    expect(d.autoUpdate).toHaveBeenCalledTimes(2)
  })
})
