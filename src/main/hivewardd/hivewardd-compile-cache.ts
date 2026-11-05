import module from 'node:module'
import { join } from 'node:path'
import { HIVEWARDD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/hivewardd-managed-launch-env'

export const HIVEWARDD_COMPILE_CACHE_DIRNAME = '.hivewardd-compile-cache'

type CompileCacheModule = {
  enableCompileCache?: (directory: string) => unknown
  getCompileCacheDir?: () => string | undefined
}

/** Cache only in managed slots: packaged-app writes break signatures. Fail back to compilation. */
export function enableManagedHivewarddCompileCache(
  slotDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
  api: CompileCacheModule = module
): void {
  if (!env[HIVEWARDD_MANAGED_ACTIVATION_ROOT_ENV] || typeof api.enableCompileCache !== 'function') {
    return
  }
  try {
    api.enableCompileCache(join(slotDirectory, HIVEWARDD_COMPILE_CACHE_DIRNAME))
  } catch {
    // Unwritable slots or older runtimes compile without a cache.
  }
}

/** Disposable children only: user-process descendants must not inherit slot cache paths. */
export function hivewarddCompileCacheEnv(
  slotDirectory: string,
  api: CompileCacheModule = module,
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  // Preserve operator-specified caches on unmanaged hosts.
  const enabled =
    Boolean(env[HIVEWARDD_MANAGED_ACTIVATION_ROOT_ENV]) &&
    typeof api.getCompileCacheDir === 'function' &&
    Boolean(api.getCompileCacheDir())
  return enabled ? { NODE_COMPILE_CACHE: join(slotDirectory, HIVEWARDD_COMPILE_CACHE_DIRNAME) } : {}
}
