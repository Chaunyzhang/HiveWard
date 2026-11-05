import type { Store } from '../persistence/loading-store/store'
import type { HiveWardRuntimeService } from '../runtime/hiveward-runtime'
import {
  SkillDiscoveryTargetSchema,
  type SkillDiscoveryResult,
  type SkillDiscoveryTarget
} from '../../shared/skills'
import {
  BundledSkillAutoUpdateRequestSchema,
  BundledSkillExecuteRequestSchema,
  BundledSkillPlanRequestSchema,
  type BundledSkillInstallResult,
  type BundledSkillPlan
} from '../../shared/bundled-skill-plan'
import {
  discoverSkillsOnTarget,
  resolveSkillDiscoveryTarget
} from '../skills/skill-discovery-target'
import { unavailableWhileWslDistroStopped } from '../skills/skill-discovery-stopped-wsl-roots'
import { handleMainWindowSkillIpc } from './skill-ipc-main-window'

export function registerSkillsHandlers(store: Store, runtime?: HiveWardRuntimeService): void {
  const discoverResolved = async (
    resolvedTarget: Awaited<ReturnType<typeof resolveSkillDiscoveryTarget>>,
    refresh: boolean,
    readStoppedWslRootsFor?: 'all' | readonly string[]
  ): Promise<SkillDiscoveryResult> =>
    discoverSkillsOnTarget(resolvedTarget, store.getRepos(), {
      providerRootOverrides: await runtime?.resolveSkillDiscoveryProviderRoots(resolvedTarget),
      refresh,
      ...(readStoppedWslRootsFor ? { readStoppedWslRootsFor } : {})
    })
  // Passive UI mounts discovery, so it must not start a stopped WSL distro.
  const discover = async (target?: SkillDiscoveryTarget): Promise<SkillDiscoveryResult> => {
    const parsedTarget = target ? SkillDiscoveryTargetSchema.parse(target) : undefined
    return unavailableWhileWslDistroStopped(
      async () =>
        discoverResolved(
          await resolveSkillDiscoveryTarget(parsedTarget, { refuseStoppedWslDistro: true }),
          parsedTarget?.refresh === true
        ),
      parsedTarget?.sourceKinds
    )
  }

  handleMainWindowSkillIpc(
    'skills:discover',
    async (_event, target?: SkillDiscoveryTarget): Promise<SkillDiscoveryResult> => discover(target)
  )

  if (!runtime) {
    return
  }

  // Local host only; paired hosts plan HiveWard's skills over RPC.
  handleMainWindowSkillIpc(
    'skills:bundledPlan',
    async (_event, value: unknown): Promise<BundledSkillPlan> =>
      runtime.planLocalBundledSkills(BundledSkillPlanRequestSchema.parse(value ?? {}))
  )
  handleMainWindowSkillIpc(
    'skills:bundledExecute',
    async (_event, value: unknown): Promise<BundledSkillInstallResult> =>
      runtime.executeLocalBundledSkills(BundledSkillExecuteRequestSchema.parse(value))
  )
  handleMainWindowSkillIpc(
    'skills:bundledAutoUpdate',
    async (_event, value: unknown): Promise<BundledSkillInstallResult> =>
      runtime.autoUpdateLocalBundledSkills(BundledSkillAutoUpdateRequestSchema.parse(value))
  )
}
