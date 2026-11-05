import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import {
  HIVEWARDD_MOBILE_WEB_DIR,
  HIVEWARDD_MOBILE_WEB_MANIFEST,
  HIVEWARDD_NODE_RUNTIME_MARKER_FILENAME,
  HIVEWARDD_SERVER_TARGET_FILENAME,
  HIVEWARDD_TEMPLATE_MANIFEST_FILENAME,
  HIVEWARDD_TEMPLATE_TARGETS_DIR,
  HIVEWARDD_VERSION_FILENAME,
  compareCodeUnits,
  isHivewarddMobileWebAssetPath,
  hivewarddArtifactFilenames,
  hivewarddTemplateCommonFilenames,
  hivewarddTemplatePackagedRipgrep,
  hivewarddTemplateTargetFilenames
} from '../../shared/hivewardd-artifacts'
import { pinnedNodeRuntimeAsset, type NodeRuntimeTarget } from '../../shared/node-runtime-pin'
import { findHivewarddCachePath } from '../node-runtime/hivewardd-cache-path'
import type { PinnedRuntimeMaterializeOptions } from '../node-runtime/pinned-runtime-materializer'
import { readHivewarddArtifactVerificationRecord } from './hivewardd-artifact-verification-record'
import {
  isCompleteArtifact,
  rememberVerification,
  sameHashes,
  signSlot,
  slotMatchesRecord,
  verifiedArtifactIdentity,
  type ArtifactSource,
  type ExpectedSha256
} from './hivewardd-artifact-source-verification'
import { HivewarddTemplateManifestSchema, type HivewarddTemplateManifest } from './hivewardd-template-manifest'
import { HivewarddArtifactsUnavailableError, HivewarddHostUnsupportedError } from './hivewardd-host-unavailable'

type MaterializeOptions = PinnedRuntimeMaterializeOptions & {
  templateDir?: string
  cacheRoot?: string
  /** WSL wake only: trust recorded stat signatures instead of rehashing bytes. */
  trustVerificationRecord?: boolean
}

const materializations = new Map<string, Promise<string>>()
// Retain handed-out slots: concurrent deployments may still be reading them.
const materializedVersions = new Set<string>()

export function materializedHivewarddArtifactVersions(): ReadonlySet<string> {
  return materializedVersions
}

/** Reference the runtime separately from the verified slot. */
export async function materializeHivewarddArtifact(
  target: NodeRuntimeTarget,
  options: MaterializeOptions = {}
): Promise<string> {
  options.signal?.throwIfAborted()
  const templateDir = options.templateDir ?? resolveHivewarddTemplateDir()
  const cacheRoot =
    options.cacheRoot ?? join(getAppEnvironment().getPath('userData'), 'hivewardd-artifacts')
  const trustVerificationRecord = options.trustVerificationRecord === true
  // SSH/local callers must not join fills that trust verification records.
  const key = `${templateDir}\0${cacheRoot}\0${target}\0${trustVerificationRecord}`
  const existing = materializations.get(key)
  if (existing) {
    return waitForPromiseWithSignal(existing, options.signal)
  }
  // Cancellation detaches one caller; the bounded cache fill still serves other deployments.
  const pending = assembleHivewarddArtifact({
    templateDir,
    cacheRoot,
    target,
    trustVerificationRecord
  }).finally(() => materializations.delete(key))
  materializations.set(key, pending)
  return waitForPromiseWithSignal(pending, options.signal)
}

export async function assembleHivewarddArtifact(args: {
  templateDir: string
  cacheRoot: string
  target: NodeRuntimeTarget
  manifest?: HivewarddTemplateManifest
  now?: () => number
  /** Disabled for SSH/local serve: hash every launch without reading/writing records. */
  trustVerificationRecord?: boolean
}): Promise<string> {
  const trust = args.trustVerificationRecord === true
  const manifest = args.manifest ?? (await readTemplateManifest(args.templateDir))
  const mobileWebAssets = templateMobileWebAssets(manifest)
  const sources = artifactSources(args.templateDir, args.target, manifest, mobileWebAssets)
  const expected = expectedTemplateSha256(args.target, manifest, mobileWebAssets)
  const targetRoot = join(args.cacheRoot, args.target)
  const nowMs = (args.now ?? Date.now)()
  const record = trust ? await readHivewarddArtifactVerificationRecord(targetRoot) : null
  const identity = await verifiedArtifactIdentity(sources, expected, record, nowMs, trust)
  await verifyTemplateMarkers(args.templateDir, args.target)
  const { fullVersion, sourceHashes } = identity
  const recordedSlot =
    record && record.contentDigest === identity.contentDigest && sameHashes(record, sourceHashes)
      ? record.slot
      : null
  let slotFromRecord = false
  const cached = await findHivewarddCachePath(
    (attempt) => join(targetRoot, `${fullVersion}${attempt ? `.repair-${attempt}` : ''}`),
    async (path) => {
      slotFromRecord = await slotMatchesRecord(path, fullVersion, sources, recordedSlot, nowMs)
      return slotFromRecord || isCompleteArtifact(path, fullVersion, sources, sourceHashes)
    }
  )
  const targetDir = cached.path
  materializedVersions.add(fullVersion)
  if (cached.verified) {
    const now = new Date()
    await utimes(targetDir, now, now).catch(() => undefined)
    if (trust) {
      const slot = slotFromRecord ? recordedSlot : await signSlot(targetDir, sources, nowMs)
      await rememberVerification(targetRoot, record, identity, slot)
    }
    return targetDir
  }
  await mkdir(targetRoot, { recursive: true })
  const stagingDir = join(targetRoot, `.staging-${process.pid}-${randomUUID()}`)
  try {
    for (const source of sources) {
      const destination = join(stagingDir, source.filename)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(source.path, destination)
      if (source.executable && !args.target.startsWith('win32-')) {
        await chmod(destination, 0o755)
      }
    }
    await writeFile(join(stagingDir, HIVEWARDD_VERSION_FILENAME), `${fullVersion}\n`, { mode: 0o600 })
    if (!(await isCompleteArtifact(stagingDir, fullVersion, sources, sourceHashes))) {
      throw new Error('Hivewardd artifact sources changed while copying')
    }
    try {
      await rename(stagingDir, targetDir)
    } catch (error) {
      if (!(await isCompleteArtifact(targetDir, fullVersion, sources, sourceHashes))) {
        throw new Error(`Hivewardd artifact cache entry is unavailable or corrupted: ${targetDir}`, {
          cause: error
        })
      }
    }
    if (trust) {
      // Fresh copies are unsettled, so the next launch must hash again.
      await rememberVerification(targetRoot, record, identity, null)
    }
    return targetDir
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
}

function isExecutableArtifact(filename: string): boolean {
  return /(?:^|\/)(?:rg|spawn-helper)$/.test(filename)
}

function artifactSources(
  templateDir: string,
  target: NodeRuntimeTarget,
  manifest: HivewarddTemplateManifest,
  mobileWebAssets: readonly string[]
): ArtifactSource[] {
  const targetDir = join(templateDir, HIVEWARDD_TEMPLATE_TARGETS_DIR, target)
  const targetManifest = manifest.targets[target]
  if (!targetManifest) {
    throw new HivewarddHostUnsupportedError(`Packaged hivewardd template does not support ${target}`)
  }
  const packagedRipgrep = hivewarddTemplatePackagedRipgrep(
    manifest.schemaVersion,
    target,
    targetManifest.packagedRipgrep
  )
  const targetFiles = new Set(hivewarddTemplateTargetFilenames(target))
  const required = hivewarddArtifactFilenames(target, mobileWebAssets).map((filename) => ({
    filename,
    path: join(
      filename === packagedRipgrep
        ? dirname(templateDir)
        : targetFiles.has(filename)
          ? targetDir
          : templateDir,
      ...filename.split('/')
    ),
    executable: isExecutableArtifact(filename)
  }))
  if (!targetManifest.browserName) {
    return required
  }
  return [
    ...required,
    {
      filename: targetManifest.browserName,
      path: join(
        targetManifest.packagedBrowser ? dirname(templateDir) : targetDir,
        targetManifest.browserName
      ),
      executable: true
    }
  ]
}

function expectedTemplateSha256(
  target: NodeRuntimeTarget,
  manifest: HivewarddTemplateManifest,
  mobileWebAssets: readonly string[]
): Map<string, ExpectedSha256> {
  const targetManifest = manifest.targets[target]
  if (!targetManifest) {
    throw new HivewarddHostUnsupportedError(`Packaged hivewardd template does not support ${target}`)
  }
  const expected = new Map<string, ExpectedSha256>()
  for (const filename of hivewarddTemplateCommonFilenames(mobileWebAssets)) {
    const sha256 = manifest.commonSha256[filename]
    if (!sha256) {
      throw new Error(`Packaged hivewardd template manifest omits ${filename}`)
    }
    expected.set(filename, { sha256, label: `hivewardd template ${filename}` })
  }
  for (const filename of hivewarddTemplateTargetFilenames(target)) {
    const sha256 = targetManifest.files[filename]
    if (!sha256) {
      throw new Error(`Packaged hivewardd template manifest omits ${target} ${filename}`)
    }
    expected.set(filename, { sha256, label: `${target} ${filename}` })
  }
  if (targetManifest.browserName && targetManifest.browserSha256) {
    // Browser names must not override required-file digests.
    if (expected.has(targetManifest.browserName)) {
      throw new Error(`Packaged hivewardd template ${target} browser name collides with a slot file`)
    }
    expected.set(targetManifest.browserName, {
      sha256: targetManifest.browserSha256,
      label: `${target} browser`
    })
  }
  return expected
}

/** Read asset names from the verified template manifest without extra WSL-wake file reads. */
function templateMobileWebAssets(manifest: HivewarddTemplateManifest): string[] {
  const prefix = `${HIVEWARDD_MOBILE_WEB_DIR}/`
  const assets = Object.keys(manifest.commonSha256).filter(
    (filename) => filename.startsWith(prefix) && filename !== HIVEWARDD_MOBILE_WEB_MANIFEST
  )
  // Asset names become slot copy destinations; reject paths that escape.
  const unsafe = assets.find(
    (filename) => !isHivewarddMobileWebAssetPath(filename.slice(prefix.length))
  )
  if (unsafe) {
    throw new Error(`Packaged hivewardd template names an unsafe page asset: ${unsafe}`)
  }
  return assets.sort(compareCodeUnits)
}

async function readTemplateManifest(templateDir: string): Promise<HivewarddTemplateManifest> {
  return HivewarddTemplateManifestSchema.parse(
    JSON.parse(await readFile(join(templateDir, HIVEWARDD_TEMPLATE_MANIFEST_FILENAME), 'utf8'))
  )
}

async function verifyTemplateMarkers(
  templateDir: string,
  target: NodeRuntimeTarget
): Promise<void> {
  const targetDir = join(templateDir, HIVEWARDD_TEMPLATE_TARGETS_DIR, target)
  if ((await readFile(join(targetDir, HIVEWARDD_SERVER_TARGET_FILENAME), 'utf8')).trim() !== target) {
    throw new Error(`Packaged hivewardd template target identity does not match ${target}`)
  }
  // Match this client’s runtime pin: it is the runtime the client will upload.
  const runtimeReference = await readFile(
    join(targetDir, HIVEWARDD_NODE_RUNTIME_MARKER_FILENAME),
    'utf8'
  )
  if (runtimeReference.trim() !== pinnedNodeRuntimeAsset(target).executableSha256) {
    throw new Error(`Packaged hivewardd template ${target} does not reference the pinned Node`)
  }
}

export function getHivewarddTemplateCandidates(): string[] {
  const candidates: string[] = []
  if (process.env.HIVEWARD_HIVEWARDD_TEMPLATE_PATH) {
    candidates.push(process.env.HIVEWARD_HIVEWARDD_TEMPLATE_PATH)
  }
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'hivewardd-template'))
  }
  const appPath = getAppEnvironment().getAppPath()
  candidates.push(
    join(appPath, 'out', 'hivewardd-template'),
    join(appPath, 'resources', 'hivewardd-template')
  )
  return [...new Set(candidates)]
}

export function hasHivewarddTemplate(): boolean {
  return getHivewarddTemplateCandidates().some((candidate) => existsSync(candidate))
}

function resolveHivewarddTemplateDir(): string {
  const found = getHivewarddTemplateCandidates().find((candidate) => existsSync(candidate))
  if (!found) {
    throw new HivewarddArtifactsUnavailableError('The packaged hivewardd deployment template is missing')
  }
  return found
}

export function resetHivewarddArtifactMaterializationsForTests(): void {
  materializations.clear()
}
