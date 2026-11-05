import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HIVEWARDD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/hivewardd-managed-launch-env'
import {
  HIVEWARDD_COMPILE_CACHE_DIRNAME,
  enableManagedHivewarddCompileCache,
  hivewarddCompileCacheEnv
} from './hivewardd-compile-cache'

const managed = {
  [HIVEWARDD_MANAGED_ACTIVATION_ROOT_ENV]: '/home/u/.hiveward-remote/.fence'
}

describe('managed hivewardd compile cache', () => {
  it('never writes into a slot no client manages, such as a packaged app', () => {
    const enableCompileCache = vi.fn()
    enableManagedHivewarddCompileCache('/Applications/HiveWard.app/hivewardd', {}, { enableCompileCache })
    expect(enableCompileCache).not.toHaveBeenCalled()
  })

  it('starts as before on a runtime without the API or with an unwritable slot', () => {
    expect(() => enableManagedHivewarddCompileCache('/slot', managed, {})).not.toThrow()
    const enableCompileCache = vi.fn(() => {
      throw new Error('EACCES')
    })
    expect(() =>
      enableManagedHivewarddCompileCache('/slot', managed, { enableCompileCache })
    ).not.toThrow()
  })

  it('hands the preflight child the slot cache only when this process enabled one', () => {
    const enabled = { getCompileCacheDir: () => '/slot/x/v24' }
    expect(hivewarddCompileCacheEnv('/slot', enabled, managed)).toEqual({
      NODE_COMPILE_CACHE: join('/slot', HIVEWARDD_COMPILE_CACHE_DIRNAME)
    })
    expect(hivewarddCompileCacheEnv('/slot', { getCompileCacheDir: () => undefined }, managed)).toEqual(
      {}
    )
    expect(hivewarddCompileCacheEnv('/slot', {}, managed)).toEqual({})
    expect(hivewarddCompileCacheEnv('/slot', enabled, {})).toEqual({})
  })
})
