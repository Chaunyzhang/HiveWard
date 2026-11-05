import type { HiveWardRuntimeService } from '../../runtime/hiveward-runtime'
import type { Store } from '../../persistence/loading-store/store'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type {
  CodexHomePtySpawnedLifecycleArgs,
  GetSelectedCodexHomePath,
  PrepareClaudeAuth,
  PrepareCodexSessionResume
} from './host-env/types'
import { registerPtyHandlers } from './register-handlers'
import { hydrateLocalPtyRegistryAtBoot } from '../../memory/hydrate-local-pty-registry'

export function registerHeadlessPtyRuntime(
  runtime: HiveWardRuntimeService,
  getSelectedCodexHomePath?: GetSelectedCodexHomePath,
  getSettings?: () => GlobalSettings,
  prepareClaudeAuth?: PrepareClaudeAuth,
  store?: Store,
  prepareCodexSessionResume?: PrepareCodexSessionResume,
  lifecycle?: {
    onCodexHomePtySpawned?: (args: CodexHomePtySpawnedLifecycleArgs) => void
    onPtyExit?: (id: string, exitSequence: number) => void
  }
): Promise<void> {
  registerPtyHandlers(
    undefined,
    runtime,
    getSelectedCodexHomePath,
    getSettings,
    prepareClaudeAuth,
    store,
    { prepareCodexSessionResume, ...lifecycle }
  )
  return store ? hydrateLocalPtyRegistryAtBoot(store) : Promise.resolve()
}
