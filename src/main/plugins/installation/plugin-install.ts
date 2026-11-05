import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PLUGIN_MANIFEST_FILENAME,
  isQualifiedPluginKey
} from '../../../shared/plugins/manifest/plugin-manifest'
import {
  isAllowedPluginGitUrl,
  type PluginLockEntry
} from '../../../shared/plugins/installation/plugin-install-lockfile'
import { readPluginLockfile } from './plugin-install-lockfile-store'
import { serializePluginMutation } from './plugin-mutation-queue'
import {
  inspectPluginInstallTree,
  installStagedPluginTree,
  type PluginInstallResult
} from './plugin-install-staging'
import { checkoutPluginGitSource } from './plugin-git-repository'
import { findPluginRollbackCandidate } from './plugin-rollback-candidate'
import { readPluginInstallProvenance } from './plugin-install-provenance'
import { publishPluginInstall } from './plugin-install-publication'
import {
  gitUrlPluginPublisher,
  localPluginPublisher
} from '../../../shared/plugins/installation/plugin-publisher-derivation'
import {
  isSameGitRepository,
  splitQualifiedPluginKey
} from '../../../shared/plugins/catalog/plugin-marketplace'
import { readPluginManifestText } from '../plugin-manifest-file'

export type { PluginInstallResult } from './plugin-install-staging'

export { removeInstalledPlugin, retireBundledPlugin } from './plugin-removal'

export {
  PLUGIN_LOCKFILE_MAX_BYTES,
  pluginLockfilePath,
  readPluginLockfile
} from './plugin-install-lockfile-store'

// Use system Git credentials without install scripts; publish immutable trees atomically and retain one rollback.

export async function installPluginFromLocalPath(input: {
  pluginsDir: string
  sourcePath: string
  hostVersion: string
  blockedPluginReason?: (pluginKey: string) => string | null
}): Promise<PluginInstallResult> {
  return serializePluginMutation(input.pluginsDir, async () => {
    if (!existsSync(join(input.sourcePath, PLUGIN_MANIFEST_FILENAME))) {
      return { ok: false, error: `no ${PLUGIN_MANIFEST_FILENAME} found in ${input.sourcePath}` }
    }
    const reinstall = await installedPublisherFor(
      input.pluginsDir,
      (source) => source.kind === 'local-path' && source.path === input.sourcePath
    )
    return installStagedPluginTree({
      pluginsDir: input.pluginsDir,
      stagingDir: input.sourcePath,
      hostVersion: input.hostVersion,
      source: { kind: 'local-path', path: input.sourcePath },
      resolvedCommit: null,
      identity: {
        publisher: reinstall ?? localPluginPublisher(await declaredPublisher(input.sourcePath))
      },
      blockedPluginReason: input.blockedPluginReason
    })
  })
}

export async function installBundledPlugin(input: {
  pluginsDir: string
  sourcePath: string
  hostVersion: string
  expectedPluginKey: string
  blockedPluginReason?: (pluginKey: string) => string | null
}): Promise<PluginInstallResult> {
  return serializePluginMutation(input.pluginsDir, async () => {
    const locked = (await readPluginLockfile(input.pluginsDir)).plugins[input.expectedPluginKey]
    // Why inside the queue: a catalog install that just finished must not be downgraded.
    if (locked && locked.source.kind !== 'bundled') {
      return { ok: false, error: 'a catalog install of this plugin is kept' }
    }
    return installStagedPluginTree({
      pluginsDir: input.pluginsDir,
      stagingDir: input.sourcePath,
      hostVersion: input.hostVersion,
      source: { kind: 'bundled', bundleId: input.expectedPluginKey },
      resolvedCommit: null,
      identity: { pluginKey: input.expectedPluginKey },
      repairCorruptedVersion: true,
      blockedPluginReason: input.blockedPluginReason
    })
  })
}

export async function installPluginFromGit(input: {
  pluginsDir: string
  url: string
  /** `#ref` suffix: branch, tag, or full commit SHA. Empty = default branch. */
  ref: string
  /** Commit the user was shown before installing; a ref that moved since fails. */
  expectedCommit?: string
  hostVersion: string
  blockedPluginReason?: (pluginKey: string) => string | null
}): Promise<PluginInstallResult> {
  if (!isAllowedPluginGitUrl(input.url)) {
    return { ok: false, error: 'plugin Git URL must use HTTPS or SSH' }
  }
  return serializePluginMutation(input.pluginsDir, async () => {
    // Why reuse: an install from before derived publishers keeps the key its data is stored under.
    const reinstall = await installedPublisherFor(
      input.pluginsDir,
      (source) => source.kind === 'git' && isSameGitRepository(source.url, input.url)
    )
    const stagingDir = await mkdtemp(join(tmpdir(), 'hiveward-plugin-install-'))
    try {
      const ref = input.ref.trim()
      const resolvedCommit = await checkoutPluginGitSource({
        url: input.url,
        ref,
        destination: stagingDir,
        workingDirectory: tmpdir()
      })
      if (input.expectedCommit && resolvedCommit !== input.expectedCommit) {
        return { ok: false, error: 'plugin Git ref moved after it was checked; try again' }
      }
      // Why the declared one last: a URL with no owner segment (`host/repo.git`) names nobody.
      const publisher =
        reinstall ?? gitUrlPluginPublisher(input.url) ?? (await declaredPublisher(stagingDir))
      if (!publisher) {
        return {
          ok: false,
          error: 'cannot name a publisher for this Git URL; use one with an owner (host/owner/repo)'
        }
      }
      return await installStagedPluginTree({
        pluginsDir: input.pluginsDir,
        stagingDir,
        hostVersion: input.hostVersion,
        source: { kind: 'git', url: input.url, ref },
        resolvedCommit,
        identity: { publisher },
        blockedPluginReason: input.blockedPluginReason
      })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      await rm(stagingDir, { recursive: true, force: true })
    }
  })
}

/** Rollback restores prior content identity; enablement still requires consent for those exact bytes. */
export async function rollbackInstalledPlugin(input: {
  pluginsDir: string
  pluginKey: string
  hostVersion: string
  blockedPluginReason?: (pluginKey: string) => string | null
}): Promise<PluginInstallResult> {
  if (!isQualifiedPluginKey(input.pluginKey)) {
    return { ok: false, error: 'invalid qualified plugin key' }
  }
  const blockedReason = input.blockedPluginReason?.(input.pluginKey)
  if (blockedReason) {
    return { ok: false, error: `plugin is blocked by HiveWard's safety list: ${blockedReason}` }
  }
  return serializePluginMutation(input.pluginsDir, async () => {
    const pluginDir = join(input.pluginsDir, input.pluginKey)
    const candidate = await findPluginRollbackCandidate(pluginDir)
    if (!candidate.ok) {
      return candidate
    }
    const { contentHash } = candidate
    const provenance = await readPluginInstallProvenance(pluginDir, contentHash)
    if (
      !provenance ||
      provenance.pluginKey !== input.pluginKey ||
      provenance.contentHash !== contentHash
    ) {
      return { ok: false, error: 'rollback version has no valid install provenance' }
    }
    const inspection = await inspectPluginInstallTree({
      rootDir: join(pluginDir, contentHash),
      hostVersion: input.hostVersion,
      identity: { pluginKey: input.pluginKey }
    })
    if (!inspection.ok || inspection.contentHash !== contentHash) {
      return {
        ok: false,
        error: inspection.ok ? 'rollback version failed integrity verification' : inspection.error
      }
    }
    try {
      await publishPluginInstall({ pluginsDir: input.pluginsDir, pluginDir, entry: provenance })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    return {
      ok: true,
      pluginKey: input.pluginKey,
      version: inspection.manifest.version,
      contentHash,
      consentFingerprint: provenance.consentFingerprint,
      resolvedCommit: provenance.resolvedCommit
    }
  })
}

/** Publisher of an existing install from the same source, so reinstalling keeps its key. */
async function installedPublisherFor(
  pluginsDir: string,
  sameSource: (source: PluginLockEntry['source']) => boolean
): Promise<string | null> {
  const entries = Object.values((await readPluginLockfile(pluginsDir)).plugins)
  const entry = entries.find((candidate) => sameSource(candidate.source))
  return entry ? (splitQualifiedPluginKey(entry.pluginKey)?.publisher ?? null) : null
}

async function declaredPublisher(rootDir: string): Promise<string | undefined> {
  try {
    const raw: unknown = JSON.parse(await readPluginManifestText(rootDir))
    const publisher =
      typeof raw === 'object' && raw !== null && 'publisher' in raw ? raw.publisher : undefined
    return typeof publisher === 'string' ? publisher : undefined
  } catch {
    // Why undefined: staging reports the unreadable manifest with its real error.
    return undefined
  }
}
