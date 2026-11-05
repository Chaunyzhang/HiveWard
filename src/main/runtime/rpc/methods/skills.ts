import { defineMethod } from '../core'
import type { z } from 'zod'
import { getAppEnvironment } from '../../../../shared/app-environment'
import { SkillDeleteRequestSchema } from '../../../../shared/skill-delete-contract'
import {
  BundledSkillAutoUpdateRequestSchema,
  BundledSkillExecuteRequestSchema,
  BundledSkillPlanRequestSchema
} from '../../../../shared/bundled-skill-plan'
import {
  previewSkillDeleteRequest,
  runSkillDeleteRequest,
  type SkillDeleteRequestDependencies
} from '../../../skills/skill-delete/request-service'
import type { SkillDiscoveryTargetSchema } from '../../../../shared/skills'
import {
  SkillInstallPreviewRequestSchema,
  SkillInstallRequestSchema,
  SkillRemoveRequestSchema
} from '../../../../shared/skill-install-contract'
import {
  SkillBundleInstallProgressSchema,
  SkillBundleInstallRequestSchema
} from '../../../../shared/skill-bundle-install-contract'
import {
  SkillUploadBeginRequestSchema,
  SkillUploadChunkRequestSchema,
  SkillUploadCommitRequestSchema
} from '../../../../shared/skill-upload-session-contract'
import {
  discoverSkillsOnTarget,
  resolveSkillDiscoveryTarget
} from '../../../skills/skill-discovery-target'
import { SKILL_INSTALL_RESULT_V2_CAPABILITY } from '../../../../shared/skill-install-capability'
import type { HiveWardRuntimeService } from '../../hiveward-runtime'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import {
  SkillsCancelInstallParams,
  SkillsDiscoverParams,
  SkillsGetInstallProgressParams
} from '../../../../shared/rpc-contract/skills-params'
import { unavailableWhileWslDistroStopped } from '../../../skills/skill-discovery-stopped-wsl-roots'

// Use the same target resolution for discovery and delete-plan roots, including WSL.
export function resolveDiscoveryTarget(
  params: z.infer<typeof SkillDiscoveryTargetSchema>,
  runtime: Pick<HiveWardRuntimeService, 'resolveProjectRuntimeForWorktree'>,
  options: { refuseStoppedWslDistro?: boolean } = {}
) {
  const target = params.projectRuntime
    ? params
    : {
        ...params,
        projectRuntime: runtime.resolveProjectRuntimeForWorktree(params.worktreeId)
      }
  return resolveSkillDiscoveryTarget(target, options)
}

// A caller naming only the workspace gets its folder from the host, which refuses SSH workspaces like desktop.
async function withWorkspaceCwd(
  params: z.infer<typeof SkillsDiscoverParams>,
  runtime: Pick<HiveWardRuntimeService, 'resolveRuntimeFileTarget'>
): Promise<z.infer<typeof SkillsDiscoverParams>> {
  if (params.cwd?.trim() || !params.worktreeId) {
    return params
  }
  const target = await runtime.resolveRuntimeFileTarget(`id:${params.worktreeId}`)
  if (parseExecutionHostId(target.executionHostId)?.kind === 'ssh') {
    throw new Error('Skill discovery is unavailable for SSH hosts.')
  }
  return { ...params, cwd: target.worktree.path }
}

function skillDeleteDependencies(
  runtime: Pick<HiveWardRuntimeService, 'listRepos' | 'resolveSkillDiscoveryProviderRoots'>
): SkillDeleteRequestDependencies {
  return {
    repos: () => runtime.listRepos(),
    resolveProviderRootOverrides: (target) => runtime.resolveSkillDiscoveryProviderRoots(target),
    userDataPath: getAppEnvironment().getPath('userData')
  }
}

export const SKILL_METHODS = [
  defineMethod({
    name: 'skills.discover',
    permission: 'workspace',
    params: SkillsDiscoverParams,
    handler: async (params, { runtime }) =>
      unavailableWhileWslDistroStopped(async () => {
        // Resolve WSL preferences on the executing host; remote clients provide workspace identity, not trusted runtime absence.
        const resolvedTarget = await resolveDiscoveryTarget(
          await withWorkspaceCwd(params, runtime),
          runtime,
          { refuseStoppedWslDistro: true }
        )
        return discoverSkillsOnTarget(resolvedTarget, runtime.listRepos(), {
          providerRootOverrides: await runtime.resolveSkillDiscoveryProviderRoots(resolvedTarget),
          refresh: params.refresh === true
        })
      }, params.sourceKinds)
  }),
  defineMethod({
    name: 'skills.previewDelete',
    permission: 'workspace',
    params: SkillDeleteRequestSchema,
    handler: async (params, { runtime }) =>
      previewSkillDeleteRequest(
        params,
        await resolveDiscoveryTarget(params.target ?? {}, runtime),
        skillDeleteDependencies(runtime)
      )
  }),
  defineMethod({
    name: 'skills.delete',
    permission: 'skills-admin',
    params: SkillDeleteRequestSchema,
    handler: async (params, { runtime }) =>
      runSkillDeleteRequest(
        params,
        await resolveDiscoveryTarget(params.target ?? {}, runtime),
        skillDeleteDependencies(runtime)
      )
  }),
  // The host plans HiveWard's skills on its own disk; a paired client never sends a WSL target.
  defineMethod({
    name: 'skills.planBundledHiveWard',
    permission: 'workspace',
    params: BundledSkillPlanRequestSchema,
    handler: (params, { runtime }) => runtime.planLocalBundledSkills(params)
  }),
  defineMethod({
    name: 'skills.executeBundledHiveWard',
    permission: 'skills-admin',
    params: BundledSkillExecuteRequestSchema,
    handler: (params, { runtime }) => runtime.executeLocalBundledSkills(params)
  }),
  defineMethod({
    name: 'skills.autoUpdateBundledHiveWard',
    permission: 'skills-admin',
    params: BundledSkillAutoUpdateRequestSchema,
    handler: (params, { runtime }) => runtime.autoUpdateLocalBundledSkills(params)
  }),
  defineMethod({
    name: 'skills.install',
    permission: 'skills-admin',
    params: SkillInstallRequestSchema,
    handler: async (params, { runtime, signal, clientCapabilities }) => {
      const result = await runtime.installSharedSkillRequest(params, signal)
      if (
        result.status === 'cancelled' &&
        !clientCapabilities?.includes(SKILL_INSTALL_RESULT_V2_CAPABILITY)
      ) {
        return {
          ...result,
          status: 'failed' as const,
          errHiveWardtegory: result.failure?.code ?? 'skill-install-cancelled',
          failure: undefined
        }
      }
      return result
    }
  }),
  defineMethod({
    name: 'skills.installBundle',
    permission: 'skills-admin',
    params: SkillBundleInstallRequestSchema,
    handler: (params, { runtime, signal }) =>
      runtime.installSharedSkillBundleRequest(params, signal)
  }),
  defineMethod({
    name: 'skills.cancelInstall',
    permission: 'skills-admin',
    params: SkillsCancelInstallParams,
    handler: (params, { runtime }) => ({
      cancelled: runtime.cancelSharedSkillInstall(params.operationId)
    })
  }),
  defineMethod({
    name: 'skills.getInstallProgress',
    permission: 'workspace',
    params: SkillsGetInstallProgressParams,
    handler: (params, { runtime }) => {
      const progress = runtime.getSharedSkillInstallProgress(params.operationId)
      return progress ? SkillBundleInstallProgressSchema.parse(progress) : null
    }
  }),
  defineMethod({
    name: 'skills.previewInstall',
    permission: 'workspace',
    params: SkillInstallPreviewRequestSchema,
    handler: (params, { runtime }) => runtime.previewSharedSkillInstallRequest(params)
  }),
  defineMethod({
    name: 'skills.removeInstall',
    permission: 'skills-admin',
    params: SkillRemoveRequestSchema,
    handler: (params, { runtime }) => runtime.removeSharedSkillInstallRequest(params)
  }),
  defineMethod({
    name: 'skills.listManagedInstalls',
    permission: 'workspace',
    params: null,
    handler: (_params, { runtime }) => runtime.listManagedSkillInstalls()
  }),
  defineMethod({
    name: 'skills.beginUpload',
    permission: 'skills-admin',
    params: SkillUploadBeginRequestSchema,
    handler: (params, { runtime }) => runtime.beginSkillUpload(params)
  }),
  defineMethod({
    name: 'skills.uploadChunk',
    permission: 'skills-admin',
    params: SkillUploadChunkRequestSchema,
    handler: (params, { runtime }) => runtime.appendSkillUploadChunk(params)
  }),
  defineMethod({
    name: 'skills.commitUpload',
    permission: 'skills-admin',
    params: SkillUploadCommitRequestSchema,
    handler: (params, { runtime }) => runtime.commitSkillUpload(params.uploadId)
  }),
  defineMethod({
    name: 'skills.cancelUpload',
    permission: 'skills-admin',
    params: SkillUploadCommitRequestSchema,
    handler: (params, { runtime }) => runtime.cancelSkillUpload(params.uploadId)
  })
]
